"use strict";

const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const P=require('./paths'),store=require('./store'),drafts=require('./task-drafts'),templates=require('./task-templates'),queue=require('./orchestrator');
const {Journal,StudioClient,StudioBridge,downloadReferences}=require('./studio-bridge');
function stableId(prefix,id) {return prefix+crypto.createHash('sha256').update(id).digest('hex').slice(0,24);}
function durableSave() {if(!store.save())throw new Error('executor local state could not be persisted');}
function requireTask(op) {const task=op.payload.task;if(!task?.id || !task.prompt || !task.parameters)throw new Error('invalid task snapshot');return task;}
function assertDedicatedState() {
  const data=store.get();
  if(data.instances.some(i=>!/^studio-account-[a-f0-9]{24}$/.test(i.id)) || data.tasks.some(t=>!t.studioTaskId) || data.taskDrafts.some(d=>!d.template?.studioTaskId) || data.taskTemplates.length || data.proxies.length)throw new Error('executor requires a dedicated clean state directory');
}
function confirmed(task) {return !!(task.generationObservedAt || task.generatedAt || task.status==='succeeded' || Object.values(task.confirmationIntents||{}).some(intent=>intent.state==='sent'));}
function decryptInput(encrypted,token) {
  try {
    if(!encrypted || !token || typeof encrypted.data!=='string' || encrypted.data.length>20000)throw new Error();
    const iv=Buffer.from(encrypted.iv,'base64'),tag=Buffer.from(encrypted.tag,'base64');
    if(iv.length!==12 || tag.length!==16)throw new Error();
    const key=crypto.createHash('sha256').update('doubao-admin-input-v1:'+token).digest();
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data,'base64')),decipher.final()]).toString('utf8'));
  } catch {throw new Error('invalid encrypted login command');}
}
class NativeAdapter {
  constructor({journal,client,accounts,driverFactory,maxDraftPages=4}) {
    this.journal=journal;this.client=client;this.accounts=accounts;this.driverFactory=driverFactory||((inst,wc)=>require('./driver').open(inst,{webContents:wc}));
    this.maxDraftPages=Math.max(1,Math.min(8,maxDraftPages));
  }
  account(op) {
    if(op.payload?.account?.id!==op.accountId)throw new Error('account identity mismatch');
    const id=stableId('studio-account-',op.accountId);
    let inst=store.find(id);
    if(!inst) {inst=store.add({id,name:String(op.payload.account.name||op.accountId),url:store.DEFAULT_URL});durableSave();}
    return inst;
  }
  local(taskId,accountId) {
    const binding=this.journal.task(taskId);
    if(!binding || binding.accountId!==accountId)throw new Error('task account binding mismatch');
    let task=binding.localTaskId?queue.getTask(binding.localTaskId):null;
    if(!task && binding.templateId)task=store.get().tasks.find(t=>t.templateId===binding.templateId);
    if(!task && binding.draftId) {
      const draft=drafts.list().find(d=>d.id===binding.draftId), record=draft?.submissionRecord;
      // A received original conversation can be adopted without any browser click.
      if(record?.task?.conversationUrl && !record.task.submissionUncertain) {
        const data=store.get(),previous={tasks:data.tasks,storyboards:data.storyboards,taskDrafts:data.taskDrafts};
        record.task.studioTaskId=taskId;
        data.tasks=[...data.tasks,record.task];data.storyboards=[...data.storyboards,record.sb];data.taskDrafts=data.taskDrafts.filter(d=>d.id!==binding.draftId);
        try {durableSave();} catch(e) {Object.assign(data,previous);throw e;}
        task=record.task;
      }
    }
    if(task) {
      if(task.instanceId!==stableId('studio-account-',accountId) || task.studioTaskId!==taskId)throw new Error('local task identity mismatch');
      if(!task.submittedAt || !task.conversationUrl || task.submissionUncertain)throw new Error('original conversation uncertain');
      this.journal.bindTask(taskId,{localTaskId:task.id,conversationId:task.conversationUrl});
    }
    return task;
  }
  async import(op,recover=false,context={}) {
    const snapshot=requireTask(op),inst=this.account(op),id=stableId('',`${op.accountId}/${snapshot.id}`),templateId=stableId('studio-template-',snapshot.id);
    const binding=this.journal.task(snapshot.id);
    if(binding && binding.accountId!==op.accountId)throw new Error('task account binding mismatch');
    const snapshotHash=crypto.createHash('sha256').update(JSON.stringify(snapshot,(key,value)=>key==='downloadUrl'?undefined:value)).digest('hex');
    if(binding && binding.snapshotHash!==snapshotHash)throw new Error('immutable task snapshot mismatch');
    let draft=drafts.list().find(d=>d.id===(binding?.draftId||id));
    if(binding?.nativeBinding)return {outcome:'success',receipt:{draftId:binding.draftId,nativeBinding:binding.nativeBinding}};
    if(draft?.nativeState==='saved' && draft.nativeBinding) {
      this.journal.bindTask(snapshot.id,{nativeBinding:draft.nativeBinding});
      return {outcome:'success',receipt:{draftId:draft.id,nativeBinding:draft.nativeBinding}};
    }
    if(recover || draft?.nativeState==='saving' || draft?.submissionRecord)return null;
    if(!draft) {
      if(binding)return null;
      const attachments=await downloadReferences(snapshot.references||[],path.join(P.dir('attachments'),id),this.client);
      const template={id:templateId,studioTaskId:snapshot.id,name:`${snapshot.userName||'工作台'} · ${snapshot.id}`,prompt:snapshot.prompt,...snapshot.parameters,attachments};
      templates.validateSnapshot(template);
      this.journal.bindTask(snapshot.id,{accountId:op.accountId,draftId:id,templateId,snapshotHash});
      draft={id,draftNumber:drafts.numberFor(id),template,executionMode:'work',createdAt:new Date().toISOString()};
      store.get().taskDrafts.push(draft);durableSave();
    }
    await queue.saveDrafts([draft.id],{instanceId:inst.id,checkLease:this.leaseGuard(op,context)});
    draft=drafts.list().find(d=>d.id===draft.id);
    if(draft?.nativeState!=='saved' || !draft.nativeBinding)throw new Error('native draft binding missing');
    this.journal.bindTask(snapshot.id,{nativeBinding:draft.nativeBinding});
    return {outcome:'success',receipt:{draftId:draft.id,nativeBinding:draft.nativeBinding}};
  }
  sendReceipt(op,tasks) {
    const items=tasks.map(snapshot=>{
      try {
        const task=this.local(snapshot.id,op.accountId);
        if(task)return {taskId:snapshot.id,status:'submitted',localTaskId:task.id,conversationId:task.conversationUrl,confirmed:confirmed(task)};
      } catch {}
      return {taskId:snapshot.id,status:'uncertain',error:'inspect original native draft and conversation'};
    });
    return {outcome:items.every(t=>t.status==='submitted')?'success':'uncertain',receipt:{tasks:items}};
  }
  async send(op,recover=false,context={}) {
    const inst=this.account(op),tasks=op.payload.tasks;
    if(!Array.isArray(tasks) || !tasks.length || tasks.length>100)throw new Error('invalid send batch');
    if(recover)return this.sendReceipt(op,tasks);
    const ids=tasks.map(task=>{
      const binding=this.journal.task(task.id);
      if(!binding || binding.accountId!==op.accountId)throw new Error('task account binding mismatch');
      return binding.draftId;
    });
    try {await queue.submitDrafts(ids,{instanceId:inst.id,maxPages:this.maxDraftPages,startQueue:false,checkLease:this.leaseGuard(op,context)});} catch { /* Each durable native receipt decides its own status. */ }
    return this.sendReceipt(op,tasks);
  }
  progress(op) {
    if(op.kind!=='send')return null;
    const tasks=[];
    for(const snapshot of op.payload.tasks||[]) {
      const binding=this.journal.task(snapshot.id);
      if(!binding || binding.accountId!==op.accountId)continue;
      const draft=drafts.list().find(d=>d.id===binding.draftId);
      const task=(binding.localTaskId && queue.getTask(binding.localTaskId)) || store.get().tasks.find(t=>t.templateId===binding.templateId) || draft?.submissionRecord?.task;
      if(task?.conversationUrl && !task.submissionUncertain)tasks.push({taskId:snapshot.id,localTaskId:task.id,conversationId:task.conversationUrl,status:'submitted',confirmed:confirmed(task)});
    }
    return tasks.length?{outcome:'progress',receipt:{tasks}}:null;
  }
  async track(op) {
    const taskId=op.taskId||op.payload.task?.id,task=this.local(taskId,op.accountId);
    if(!task)return {outcome:'uncertain',receipt:{taskId,status:'running',error:'original local task missing'}};
    const receipt={taskId,localTaskId:task.id,conversationId:task.conversationUrl,confirmed:confirmed(task)};
    if(task.status==='succeeded') {
      const files=task.result?.files||[];
      if(files.length!==1 || task.result?.unwatermarked!==true)return {outcome:'uncertain',receipt:{...receipt,status:'running',error:'inspect original output files'}};
      try {await this.client.upload(taskId,op,files[0]);} catch(error) {
        if(error.permanent)return {outcome:'uncertain',receipt:{...receipt,status:'running',error:'original MP4 requires manual review (size or format); file retained'}};
        if(error.status!==409)error.retryable=true;
        throw error;
      }
      return {outcome:'success',receipt:{...receipt,status:'completed'}};
    }
    if(task.status==='failed') {
      if(['generation_failed','quota'].includes(task.errorCode))return {outcome:'failure',receipt:{...receipt,status:'failed',error:'Doubao explicitly rejected original generation'}};
      // Reopen only the same accepted dialogue to retry download or read status.
      if(!['timeout','unknown','login_required'].includes(task.errorCode))return {outcome:'uncertain',receipt:{...receipt,status:'running',error:'inspect original conversation'}};
      await queue.retryTask(task.id);
    } else if(task.status==='queued')queue.resume(task.storyboardId);
    return {outcome:'progress',receipt:{...receipt,status:'running'}};
  }
  async login(op,context={}) {
    const action=op.payload.action||'frame';
    const input=action==='input'?decryptInput(op.payload.inputEncrypted,this.client.token):{};
    const checkAction=this.leaseGuard(op,context);
    const inst=this.account(op),win=await this.accounts.open(inst.id),wc=win.webContents;
    if(action==='navigate') {
      const url=new URL(op.payload.url||store.DEFAULT_URL);
      if(url.href!==store.DEFAULT_URL)throw new Error('Doubao login navigation only');
      checkAction();await wc.loadURL(url.href);
    } else if(action==='input') {
      if(input.kind==='click') {
        if(!Number.isFinite(input.x)||!Number.isFinite(input.y)||input.x<0||input.x>1||input.y<0||input.y>1)throw new Error('invalid click coordinates');
        const [width,height]=win.getContentSize(),value={x:Math.min(width-1,Math.round(input.x*width)),y:Math.min(height-1,Math.round(input.y*height)),button:'left',clickCount:1};
        checkAction();await wc.debugger.sendCommand('Input.dispatchMouseEvent',{...value,type:'mousePressed'});
        checkAction();await wc.debugger.sendCommand('Input.dispatchMouseEvent',{...value,type:'mouseReleased'});
      } else if(input.kind==='text') {
        if(typeof input.text!=='string'||input.text.length>10000)throw new Error('invalid login text');
        checkAction();await wc.debugger.sendCommand('Input.insertText',{text:input.text});
      } else if(input.kind==='key' && ['Enter','Tab','Backspace','Escape'].includes(input.key)) {
        const keyCode={Enter:13,Tab:9,Backspace:8,Escape:27}[input.key];
        for(const type of ['keyDown','keyUp']) {checkAction();await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:input.key,code:input.key,windowsVirtualKeyCode:keyCode,...(type==='keyDown'&&input.key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});}
      } else throw new Error('unsupported login input');
    } else if(!['open','frame','screenshot'].includes(action))throw new Error('unsupported login action');
    const image=await wc.capturePage(undefined,{stayHidden:true}),jpeg=image.toJPEG(70);
    if(jpeg.length>1024*1024)throw new Error('login screenshot too large');
    const driver=await this.driverFactory(inst,wc),login=await driver.isLoggedIn().catch(()=>({}));
    const [width,height]=win.getContentSize();
    return {outcome:'success',receipt:{imageBase64:jpeg.toString('base64'),contentType:'image/jpeg',width,height,loginState:login?.loggedIn===true?'logged_in':login?.loggedIn===false?'logged_out':'unknown'}};
  }
  leaseGuard(op,context) {
    return context.checkLease||(()=>{const until=typeof op.leaseUntil==='number'?op.leaseUntil:Date.parse(op.leaseUntil);if(!Number.isFinite(until)||Date.now()>=until)throw new Error('studio operation lease expired');});
  }
  execute(op,context={}) {
    if(op.kind==='import')return this.import(op,false,context);
    if(op.kind==='send')return this.send(op,false,context);
    if(op.kind==='track')return this.track(op);
    if(op.kind==='account')return this.login(op,context);
    throw new Error('unsupported operation');
  }
  recover(op,context={}) {
    if(op.kind==='import')return this.import(op,true,context);
    if(op.kind==='send')return this.send(op,true,context);
    if(op.kind==='track')return this.track(op);
    // Input commands may have succeeded. Never replay keystrokes after interruption.
    return this.login({...op,payload:{...op.payload,action:'frame'}},context);
  }
}
function readConfig(file) {
  const cfg=JSON.parse(fs.readFileSync(file,'utf8')),base=path.dirname(path.resolve(file));
  for(const key of ['stateDir','tokenFile'])if(!cfg[key]||!path.isAbsolute(cfg[key]))throw new Error(`${key} must be an absolute path`);
  if(process.platform!=='win32' && (fs.statSync(cfg.tokenFile).mode&0o077))throw new Error('token file must be private (0600)');
  if(!cfg.executorId || !cfg.siteUrl)throw new Error('executorId and siteUrl required');
  const token=fs.readFileSync(cfg.tokenFile,'utf8').trim();
  return {...cfg,stateDir:path.resolve(base,cfg.stateDir),token};
}
function studioConfigFile(app,argv=process.argv,environment=process.env) {
  const native=app.commandLine.getSwitchValue('studio-config');
  if(native)return native;
  // Electron can omit application switches from commandLine while retaining argv.
  const index=argv.findIndex(value=>value==='--studio-config'||value.startsWith('--studio-config='));
  if(index>=0) {
    const value=argv[index]==='--studio-config'?argv[index+1]:argv[index].slice('--studio-config='.length);
    if(!value||value.startsWith('--'))throw new Error('private --studio-config file required');
    return value;
  }
  return environment.DOUBAO_STUDIO_CONFIG;
}
function createStudioWindow(inst,{BrowserWindow=require('electron').BrowserWindow,enhancer={},height=900}={}) {
  const win=new BrowserWindow({show:false,width:1280,height,useContentSize:true,
    webPreferences:{partition:inst.partition,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,
      sandbox:true,webSecurity:true,backgroundThrottling:false,spellcheck:false}});
  const source=require('./page').buildPageScript({cfg:{profile:null,instanceId:inst.id,kernel:'embedded',enhancer}});
  // Main-process injection needs no Node-enabled preload and survives navigation.
  win.webContents.on('dom-ready',()=>{
    if(win.webContents.isDestroyed())return;
    win.webContents.executeJavaScript(source).catch(()=>{win.loadError='页面自动化加载失败';});
  });
  return win;
}
async function start() {
  const {app,BrowserWindow,session}=require('electron');
  const file=studioConfigFile(app);
  if(!file)throw new Error('private --studio-config file required');
  const cfg=readConfig(file);fs.mkdirSync(cfg.stateDir,{recursive:true,mode:0o700});app.setPath('userData',cfg.stateDir);app.setPath('sessionData',cfg.stateDir);
  if(!app.requestSingleInstanceLock()) {app.exit(1);return;}
  await app.whenReady();P.init({home:cfg.stateDir});store.load();
  assertDedicatedState();
  // This entry never registers desktop HTTP/MCP/web services, proxies or fingerprint masks.
  store.get().settings.orchestrator={...store.get().settings.orchestrator,retryLimit:0,autoDownload:true,autoConfirm:true,maxParallel:Math.max(1,Math.min(8,cfg.trackingPages||2))};
  store.get().settings.downloadDir=P.dir('exports');durableSave();
  const interceptor=require('./interceptor'),driver=require('./driver'),{WebAccounts}=require('./web-accounts');
  const prepareSession=async(inst)=>{const ses=session.fromPartition(inst.partition);interceptor.attach(ses,inst);return ses;};
  const windowFor=(inst,height)=>createStudioWindow(inst,{BrowserWindow,enhancer:store.get().settings.enhancer,height});
  const accounts=new WebAccounts({prepareSession,createWindow:inst=>windowFor(inst,800),wake:()=>{},publish:()=>{},log:{warn:()=>{}}});
  const pages=new Set();
  queue.init({resolveDriver:async(inst)=>driver.open(inst,{webContents:(await accounts.open(inst.id)).webContents}),
    resolveDraftDriver:async(inst,{signal}={})=>{
      await prepareSession(inst);signal?.throwIfAborted();
      const win=windowFor(inst,900);
      pages.add(win);const close=()=>{if(!win.isDestroyed())win.destroy();};
      win.on('closed',()=>{pages.delete(win);signal?.removeEventListener('abort',close);});signal?.addEventListener('abort',close,{once:true});
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      try {await win.loadURL(store.DEFAULT_URL);const instanceDriver=await driver.open(inst,{webContents:win.webContents});instanceDriver.close=close;return instanceDriver;} catch(error){close();throw error;}
    },findWebContents:inst=>accounts.find(inst)});
  queue.recoverTemplateTasks();queue.pause('');
  const journal=new Journal(path.join(cfg.stateDir,'studio-journal.json')),client=new StudioClient(cfg);
  const adapter=new NativeAdapter({journal,client,accounts,maxDraftPages:cfg.maxDraftPages||4});
  const bridge=new StudioBridge({journal,api:client,adapter,operationConcurrency:cfg.operationConcurrency||2,onError:code=>process.stderr.write(`studio-executor: ${code}\n`)});
  const controller=new AbortController();
  app.on('window-all-closed',()=>{});
  app.on('before-quit',()=>{controller.abort();queue.pause('');accounts.stop();for(const win of pages)if(!win.isDestroyed())win.destroy();});
  for(const event of ['SIGTERM','SIGINT'])process.once(event,()=>app.quit());
  bridge.run(controller.signal).catch(()=>{process.stderr.write('studio-executor: stopped\n');app.exit(1);});
  return {bridge,adapter};
}
module.exports={NativeAdapter,decryptInput,assertDedicatedState,readConfig,studioConfigFile,createStudioWindow,start};
