"use strict";

const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const P=require('./paths'),store=require('./store'),drafts=require('./task-drafts'),templates=require('./task-templates'),queue=require('./orchestrator');
const {Journal,StudioClient,StudioBridge,downloadReferences}=require('./studio-bridge');
const {StudioControl}=require('./studio-control');
const {ActiveDeliveryPages}=require('./active-delivery');
function stableId(prefix,id) {return prefix+crypto.createHash('sha256').update(id).digest('hex').slice(0,24);}
function durableSave() {if(!store.save())throw new Error('executor local state could not be persisted');}
function requireTask(op) {const task=op.payload.task;if(!task?.id || !task.prompt || !task.parameters)throw new Error('invalid task snapshot');return task;}
function assertDedicatedState() {
  const data=store.get();
  if(data.instances.some(i=>!/^studio-account-[a-f0-9]{24}$/.test(i.id)) || data.tasks.some(t=>!t.studioTaskId) || data.taskDrafts.some(d=>!d.template?.studioTaskId) || data.taskTemplates.length || data.proxies.length)throw new Error('executor requires a dedicated clean state directory');
}
function confirmed(task) {return !!(task.generationObservedAt || task.generatedAt || task.status==='succeeded' || Object.values(task.confirmationIntents||{}).some(intent=>intent.state==='sent'));}
function immutableSnapshot(value) {return JSON.stringify(value,(key,item)=>key==='downloadUrl'?undefined:item);}
function matchesImportSnapshotHash(snapshot,expected) {
  const {draftId,nativeBinding,...task}=snapshot;
  if(Object.hasOwn(task,'localTaskId')||Object.hasOwn(task,'conversationId'))return false;
  // Import has two known wire forms: content only, or all four transport
  // fields explicitly null. Both still hash every original content field.
  return [task,{...task,draftId:null,nativeBinding:null,localTaskId:null,conversationId:null}].some(value=>crypto.createHash('sha256').update(immutableSnapshot(value)).digest('hex')===expected);
}
function sameNativeBinding(binding,snapshot) {return binding?.id===snapshot.draftId&&binding.nativeId===snapshot.nativeBinding?.nativeId&&binding.accountScope===snapshot.nativeBinding?.accountScope;}
function originalMessage(task) {
  return Boolean(task?.id&&task.submissionUncertain===false&&task.conversationLocked===true&&task.submittedAt&&task.sentAt&&/^https:\/\/www\.doubao\.com\/chat\/[^/?#]+$/.test(task.conversationUrl||'')&&typeof task.receiptUserMessageId==='string'&&task.receiptUserMessageId.trim());
}
function noGenerationIntent(task) {
  if(task&&(Object.keys(task.confirmationIntents||{}).length||task.generationObservedAt||task.generatedAt||['running','succeeded'].includes(task.status)||task.result?.files?.length))throw Error('original task has a generation or confirmation intent');
}
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
  constructor({journal,client,accounts,environment,sessionId=crypto.randomUUID(),driverFactory,maxDraftPages=4,captchaConfig,captchaSolver}) {
    this.journal=journal;this.client=client;this.accounts=accounts;this.driverFactory=driverFactory||((inst,wc)=>require('./driver').open(inst,{webContents:wc}));
    this.environment=environment;this.sessionId=sessionId;
    this.maxDraftPages=Math.max(1,Math.min(8,maxDraftPages));
    this.deliveryPages=new ActiveDeliveryPages();
    this.importPages=new Map();
    this.captchaConfig=captchaConfig;this.captchaSolver=captchaSolver;
  }
  registerDelivery(op,taskId,draftId,inst,driver,cancel,context) {
    return this.deliveryPages.register({accountId:op.accountId,operationId:op.id,batchId:op.batchId,taskId,draftId,environmentVersion:inst.studioEnvironment?.version,executorSessionId:this.sessionId,instance:inst,driver,checkLease:this.leaseGuard(op,context),cancel,
      ...(this.captchaConfig?.enabled&&this.captchaConfig.apiKey?{solveCaptcha:page=>this.solveCaptchaPage(page)}:{})});
  }
  async solveCaptchaPage(page) {
    if(page.manual||page.pauseRequested)return {solved:false,manualRequired:true,reason:'human_control'};
    const abort=new AbortController();page.solverAbort=abort;
    try {
      const solve=this.captchaSolver||require('./studio-captcha-solver').solveStudioCaptcha;
      const result=await page.runAutomation(()=>solve({driver:page.driver,signal:abort.signal,key:this.captchaConfig.apiKey,model:this.captchaConfig.model,check:()=>{page.check();if(page.manual||page.pauseRequested||page.inputHeld||page.inputInFlight)throw Error('human control requested');}}));
      if(result.diagnostics?.releaseFailed){page.inputHeld=true;page.keepOpen=true;this.onSolverReleasePending?.(page,result.diagnostics.releasePoint);}
      if(result.solved)await page.observe({taskId:page.taskId,pageId:page.pageId},{automatic:true});
      require('./logger').info('studio-captcha-auto-result',{accountId:page.accountId,operationId:page.operationId,taskId:page.taskId,solved:result.solved,reason:result.reason,attempts:result.diagnostics?.attempts||0});
      return result;
    } finally {page.solverAbort=null;}
  }
  observationWindow(accountId) {
    const page=this.importPages.get(accountId);
    if(page&&!page.window.isDestroyed?.()){try {page.check();return page;}catch {return;}}
    const retained=this.deliveryPages.retained.get(accountId);
    if(!retained||retained.driver.window.isDestroyed?.()||retained.executorSessionId!==this.sessionId||retained.environmentVersion!==retained.instance.studioEnvironment?.version)return;
    return {instance:retained.instance,window:retained.driver.window,interactive:true,check:()=>{if(retained.driver.window.isDestroyed?.())throw Error('retained human page closed');}};
  }
  account(op) {
    if(op.payload?.account?.id!==op.accountId)throw new Error('account identity mismatch');
    const id=stableId('studio-account-',op.accountId);
    let inst=store.find(id);
    if(!inst) {inst=store.add({id,name:String(op.payload.account.name||op.accountId),url:store.DEFAULT_URL});durableSave();}
    if(this.environment) {
      const previous=inst.studioEnvironment?.version;
      this.environment.configure(inst,op.payload.account.environment);
      if(previous && previous!==inst.studioEnvironment.version)this.accounts.close(inst.id);
      durableSave();
    }
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
      draft={id,draftNumber:drafts.numberFor(id),template,executionMode:'work',createdAt:new Date().toISOString(),...(op.payload.sendOnly===true?{studioSendOnly:true}:{})};
      store.get().taskDrafts.push(draft);durableSave();
    }
    const check=this.leaseGuard(op,context);
    await queue.saveDrafts([draft.id],{instanceId:inst.id,checkLease:check,expectedAccountScope:op.payload.action==='resume_unwritten_import'?op.payload.accountScope:undefined,onImportPage:({driver})=>{
      if(!driver.window)return;
      const page={instance:inst,window:driver.window,check};this.importPages.set(op.accountId,page);
      return ()=>{if(this.importPages.get(op.accountId)===page)this.importPages.delete(op.accountId);};
    }});
    draft=drafts.list().find(d=>d.id===draft.id);
    if(draft?.nativeState!=='saved' || !draft.nativeBinding)throw new Error('native draft binding missing');
    this.journal.bindTask(snapshot.id,{nativeBinding:draft.nativeBinding});
    return {outcome:'success',receipt:{draftId:draft.id,nativeBinding:draft.nativeBinding}};
  }
  sendReceipt(op,tasks) {
    if(op.payload.batchSize===50&&op.payload.sendOnly===false)return this.normalSendReceipt(op,tasks);
    const items=tasks.map(snapshot=>{
      try {
        const task=this.local(snapshot.id,op.accountId);
        if(task)return {taskId:snapshot.id,status:'submitted',localTaskId:task.id,conversationId:task.conversationUrl,...(task.receiptUserMessageId?{userMessageId:task.receiptUserMessageId}:{}),confirmed:confirmed(task)};
      } catch {}
      return {taskId:snapshot.id,status:'uncertain',error:'inspect original native draft and conversation'};
    });
    const dispatches=op.payload.sendOnly===true?this.dispatchEvidence(op,tasks):[];
    return {outcome:items.every(t=>t.status==='submitted')?'success':'uncertain',receipt:{tasks:items,...(op.payload.sendOnly===true?{dispatchOnly:true,dispatches}:{})}};
  }
  processedEvidence(op) {
    return (op.payload.tasks||[]).flatMap(snapshot=>{const binding=this.journal.task(snapshot.id),value=binding?.lastSendProcessed;return binding?.accountId===op.accountId&&binding.draftId===snapshot.draftId&&value?.operationId===op.id&&value.draftId===snapshot.draftId&&typeof value.issued==='boolean'&&typeof value.received==='boolean'&&(!value.received||value.issued)&&Number.isFinite(Date.parse(value.at))?[{taskId:snapshot.id,...value}]:[];});
  }
  normalSendReceipt(op,tasks) {
    if(tasks.length!==50)throw Error('new batch requires the complete 50-task snapshot');
    const records=new Map(),entries=[],data=store.get(),extensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif'};
    for(const snapshot of tasks) {
      const binding=this.journal.task(snapshot.id),draft=data.taskDrafts.find(d=>d.id===snapshot.draftId),locals=data.tasks.filter(t=>t.studioTaskId===snapshot.id||t.templateId===binding?.templateId);
      if(binding?.accountId!==op.accountId||binding.draftId!==snapshot.draftId||!matchesImportSnapshotHash(snapshot,binding.snapshotHash)||!sameNativeBinding(binding.nativeBinding,snapshot)||locals.length>1)throw Error('new batch original snapshot or binding changed');
      const task=locals[0]||draft?.submissionRecord?.task,raw=task?.dispatchReceipt||draft?.dispatchReceipt;
      if(task&&(task.studioTaskId!==snapshot.id||task.templateId!==binding.templateId||task.instanceId!==stableId('studio-account-',op.accountId)||task.studioSendOnly))throw Error('new batch original task changed');
      noGenerationIntent(task);
      const names=snapshot.references.map((ref,index)=>{if(!extensions[ref.contentType]||!/^[a-f0-9]{64}$/i.test(ref.sha256||''))throw Error('new batch reference identity missing');return index+'-'+ref.sha256.toLowerCase()+extensions[ref.contentType];});
      records.set(snapshot.id,{snapshot,binding,draft,task,raw,names});entries.push({taskId:snapshot.id,status:!task&&!raw&&draft?.nativeState==='saved'&&!draft.submissionRecord?'not_started':'uncertain'});
    }
    return this.realContinuationReceipt(op,{records,entries},true);
  }
  dispatchEvidence(op,tasks=op.payload.tasks||[]) {
    const rows=[];
    for(const snapshot of tasks){
      const binding=this.journal.task(snapshot.id);if(binding?.accountId!==op.accountId)continue;
      const draft=drafts.list().find(d=>d.id===binding.draftId);let local;
      try{local=this.local(snapshot.id,op.accountId);}catch{}
      const raw=local?.dispatchReceipt||draft?.dispatchReceipt;
      if(raw&&['quota_limited','message_accepted','pending'].includes(raw.outcome))rows.push({...raw,...(raw.outcome==='pending'?{outcome:'attempted_unconfirmed'}:{})});
      else if(local?.receiptUserMessageId&&local.sentAt)rows.push({taskId:snapshot.id,draftId:binding.draftId,nativeId:binding.nativeBinding?.nativeId,clickedAt:local.sentAt,outcome:'message_accepted',conversationUrl:local.conversationUrl});
    }
    return rows;
  }
  continuationReceipt(op) {
    if(op.payload.sendOnly===false)return this.realContinuationReceipt(op);
    const dispatches=this.dispatchEvidence(op),complete=dispatches.length===op.payload.tasks.length;
    return {outcome:complete?'success':'uncertain',receipt:{status:complete?'draft_dispatch_complete':'draft_dispatch_partial',dispatchOnly:true,originalOperationId:op.payload.originalOperationId,dispatches}};
  }
  async continueUnstartedDrafts(op,recover=false,context={}) {
    if(op.payload.sendOnly===false)return this.continueRealUnstartedDrafts(op,recover,context);
    const original=this.journal.get(op.payload.originalOperationId),tasks=op.payload.tasks,pause=original?.result?.receipt?.deliveryPause;
    if(op.payload.sendOnly!==true||op.payload.dispatchOnly!==true||!original?.reported||original.state!=='done'||original.operation.kind!=='send'||original.operation.accountId!==op.accountId||original.operation.batchId!==op.batchId||original.operation.payload.sendOnly!==true||original.result.outcome!=='uncertain'||!Array.isArray(tasks)||!tasks.length)throw Error('original unstarted dispatch evidence missing');
    const index=original.operation.payload.tasks.findIndex(t=>t.id===pause?.taskId&&t.draftId===pause?.draftId),suffix=original.operation.payload.tasks.slice(index+1);
    if(index<0||JSON.stringify(suffix.map(t=>t.draftId))!==JSON.stringify(pause.notStartedDraftIds))throw Error('unstarted dispatch suffix changed');
    let expected=suffix;
    if(op.payload.previousOperationId){
      const previous=this.journal.get(op.payload.previousOperationId),prior=previous?.operation,rows=previous?.result?.receipt?.dispatches;
      if(!previous?.reported||previous.state!=='done'||prior.kind!=='account'||prior.payload.action!=='continue_unstarted_drafts'||prior.payload.originalOperationId!==op.payload.originalOperationId||prior.accountId!==op.accountId||prior.batchId!==op.batchId||prior.payload.sendOnly!==true||prior.payload.dispatchOnly!==true||previous.result.outcome!=='uncertain'||previous.result.receipt.dispatchOnly!==true||!Array.isArray(rows)||!Array.isArray(prior.payload.tasks)||!prior.payload.tasks.every(t=>suffix.some(s=>JSON.stringify(s)===JSON.stringify(t))))throw Error('previous dispatch evidence missing or changed');
      const attempted=new Set(rows.map(row=>row.taskId));expected=prior.payload.tasks.filter(t=>!attempted.has(t.id));
    }
    if(JSON.stringify(expected)!==JSON.stringify(tasks))throw Error('unstarted dispatch suffix changed');
    if(recover)return this.continuationReceipt(op);
    if(original.operation.payload.account.environment?.version!==op.payload.account.environment?.version)throw Error('original account environment changed');
    for(const task of tasks){const binding=this.journal.task(task.id),draft=drafts.list().find(d=>d.id===task.draftId),template=draft?.template;if(task.references?.length||binding?.accountId!==op.accountId||binding.draftId!==task.draftId||!draft||draft.nativeState!=='saved'||draft.submissionRecord||draft.nativeBinding?.nativeId!==task.nativeBinding?.nativeId||draft.executionMode!=='work'||template?.studioTaskId!==task.id||template.prompt!==task.prompt||['model','duration','ratio'].some(key=>template[key]!==task.parameters?.[key])||template.attachments?.length)throw Error('draft already dispatched or changed');}
    await this.send(op,false,context);return this.continuationReceipt(op);
  }
  originalUnstartedState(op,requireStrictSuffix=true) {
    const original=this.journal.get(op.payload.originalOperationId),source=original?.operation,account=op.payload.account,data=store.get();
    const version=source?.payload?.account?.environment?.version,instanceId=stableId('studio-account-',op.accountId),instance=data.instances.find(item=>item.id===instanceId);
    if(!original?.reported||original.state!=='done'||source.kind!=='send'||source.accountId!==op.accountId||source.payload.account?.id!==op.accountId||source.payload.sendOnly!==false||source.payload.dispatchOnly===true||original.result?.outcome!=='uncertain'||!source.batchId||(op.batchId&&op.batchId!==source.batchId))throw Error('original real send provenance missing');
    if(account?.id!==op.accountId||typeof version!=='string'||!version||account.environment?.version!==version||instance?.studioEnvironment?.version!==version)throw Error('original account environment changed');
    const tasks=source.payload.tasks,receipt=original.result.receipt;
    if(!Array.isArray(tasks)||![50,100].includes(tasks.length)||new Set(tasks.map(task=>task.id)).size!==tasks.length||new Set(tasks.map(task=>task.draftId)).size!==tasks.length||new Set(tasks.map(task=>task.nativeBinding?.nativeId)).size!==tasks.length||!Array.isArray(receipt?.tasks)||receipt.tasks.length!==tasks.length||receipt.tasks.some((entry,index)=>entry.taskId!==tasks[index].id))throw Error('original complete 50/100-task snapshot or unique native binding missing');
    const entries=[],records=new Map(),extensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif'};
    for(const snapshot of tasks) {
      const binding=this.journal.task(snapshot.id),expectedDraftId=stableId('',`${op.accountId}/${snapshot.id}`),templateId=stableId('studio-template-',snapshot.id);
      if(!snapshot.id||!snapshot.prompt||!snapshot.parameters||snapshot.draftId!==expectedDraftId||binding?.accountId!==op.accountId||binding.draftId!==expectedDraftId||binding.templateId!==templateId||!matchesImportSnapshotHash(snapshot,binding.snapshotHash)||!sameNativeBinding(snapshot.nativeBinding,snapshot)||!sameNativeBinding(binding.nativeBinding,snapshot)||!snapshot.nativeBinding.nativeId||!snapshot.nativeBinding.accountScope||!Array.isArray(snapshot.references)||snapshot.references.length!==5)throw Error('original task snapshot or native binding changed');
      const names=snapshot.references.map((ref,index)=>{
        if(!ref.id||!extensions[ref.contentType]||!Number.isSafeInteger(ref.byteSize)||ref.byteSize<1||!/^[a-f0-9]{64}$/i.test(ref.sha256||''))throw Error('original attachment identity missing');
        return index+'-'+ref.sha256.toLowerCase()+extensions[ref.contentType];
      });
      const matchedDrafts=data.taskDrafts.filter(draft=>draft.id===snapshot.draftId),locals=data.tasks.filter(task=>task.studioTaskId===snapshot.id||task.templateId===templateId||(binding.localTaskId&&task.id===binding.localTaskId));
      if(matchedDrafts.length>1||locals.length>1)throw Error('original draft or local task identity is ambiguous');
      const draft=matchedDrafts[0],candidates=[...locals,...(draft?.submissionRecord?.task?[draft.submissionRecord.task]:[])];
      for(const task of candidates) {
        noGenerationIntent(task);
        if(!task.id||task.studioTaskId!==snapshot.id||task.templateId!==templateId||task.instanceId!==instanceId||task.studioSendOnly===true||(binding.localTaskId&&binding.localTaskId!==task.id))throw Error('original local task binding changed');
      }
      if(candidates.length===2&&candidates[0].id!==candidates[1].id)throw Error('original submitted task identity changed');
      const oldReceipt=receipt.tasks.find(entry=>entry.taskId===snapshot.id);
      if(oldReceipt?.confirmed===true)throw Error('original receipt has a generation intent');
      const task=candidates[0],raw=task?.dispatchReceipt||draft?.dispatchReceipt;
      const entry={taskId:snapshot.id,draftId:snapshot.draftId,status:'uncertain'};
      if(task?.id)entry.localTaskId=task.id;
      if(/^https:\/\/www\.doubao\.com\/chat\/[^/?#]+$/.test(task?.conversationUrl||''))entry.conversationId=task.conversationUrl;
      if(typeof task?.receiptUserMessageId==='string'&&task.receiptUserMessageId.trim())entry.userMessageId=task.receiptUserMessageId;
      if(candidates.length&&candidates.every(candidate=>originalMessage(candidate)&&candidate.id===task.id&&candidate.conversationUrl===task.conversationUrl&&candidate.receiptUserMessageId===task.receiptUserMessageId)) {
        if(oldReceipt.status==='submitted'&&['localTaskId','conversationId','userMessageId'].some(key=>oldReceipt[key]&&oldReceipt[key]!==entry[key]))throw Error('original submitted message anchors changed');
        entry.status='submitted';
      } else if(!draft?.submissionRecord&&!raw&&!candidates.length&&!binding.localTaskId&&!oldReceipt.localTaskId&&!oldReceipt.conversationId&&!oldReceipt.userMessageId&&!(receipt.dispatches||[]).some(row=>row.taskId===snapshot.id)) {
        const template=draft?.template;
        if(!draft||draft.nativeState!=='saved'||draft.instanceId!==instanceId||draft.executionMode!=='work'||draft.studioSendOnly===true||draft.draftNumber!==drafts.numberFor(snapshot.draftId)||!draft.nativePrompt||!draft.nativePrompt.includes(draft.draftNumber)||!sameNativeBinding(draft.nativeBinding,snapshot)||template?.id!==templateId||template.studioTaskId!==snapshot.id||template.prompt!==snapshot.prompt||Object.keys(snapshot.parameters).some(key=>JSON.stringify(template[key])!==JSON.stringify(snapshot.parameters[key]))||!Array.isArray(template.attachments)||template.attachments.length!==5)throw Error('original saved draft or template changed');
        for(let index=0;index<5;index++) {
          const file=template.attachments[index],ref=snapshot.references[index];
          if(file.id!==ref.id||file.name!==String(ref.filename||ref.id)||file.mime!==ref.contentType||file.size!==ref.byteSize||typeof file.path!=='string'||path.basename(file.path)!==names[index])throw Error('original draft attachment order or identity changed');
        }
        entry.status='not_started';
      }
      entries.push(entry);records.set(snapshot.id,{snapshot,binding,draft,task,raw,names});
    }
    const first=entries.findIndex(entry=>entry.status==='not_started');
    if(requireStrictSuffix&&first>=0&&entries.slice(first).some(entry=>entry.status!=='not_started'))throw Error('original not-started drafts are not a strict suffix');
    return {original,version,entries,records,tasks};
  }
  async inspectUnstartedDrafts(op,context={}) {
    const check=this.leaseGuard(op,context);check();const state=this.originalUnstartedState(op);check();
    return {outcome:'success',receipt:{status:'unstarted_draft_inspection',readOnly:true,originalOperationId:op.payload.originalOperationId,environmentVersion:state.version,executorSessionId:this.sessionId,inspectedAt:Date.now(),generationIntentCount:0,entries:state.entries}};
  }
  realContinuationProof(op,recover=false) {
    const validationCount=op.payload.validationCount;
    if(validationCount!==undefined&&(validationCount!==30||!op.payload.previousOperationId))throw Error('validation count must be 30 for an explicit previous continuation');
    if(op.payload.sendOnly!==false||op.payload.dispatchOnly!==false||op.payload.readOnlyInspection!==true||!op.payload.inspectionOperationId||!Array.isArray(op.payload.tasks)||!op.payload.tasks.length)throw Error('real continuation inspection proof required');
    const state=this.originalUnstartedState(op,!recover),proof=this.journal.get(op.payload.inspectionOperationId),operation=proof?.operation,receipt=proof?.result?.receipt;
    if(!proof?.reported||proof.state!=='done'||proof.result?.outcome!=='success'||operation?.kind!=='account'||operation.accountId!==op.accountId||operation.payload?.action!=='inspect_unstarted_drafts'||operation.payload.originalOperationId!==op.payload.originalOperationId||operation.payload.account?.id!==op.accountId||operation.payload.account.environment?.version!==state.version||(operation.batchId&&operation.batchId!==state.original.operation.batchId)||receipt?.status!=='unstarted_draft_inspection'||receipt.readOnly!==true||receipt.originalOperationId!==op.payload.originalOperationId||receipt.environmentVersion!==state.version||receipt.generationIntentCount!==0||typeof receipt.executorSessionId!=='string'||!receipt.executorSessionId||!Number.isFinite(receipt.inspectedAt)||!Array.isArray(receipt.entries)||receipt.entries.length!==state.tasks.length||receipt.entries.some((entry,index)=>entry.taskId!==state.tasks[index].id||entry.draftId!==state.tasks[index].draftId||!['submitted','uncertain','not_started'].includes(entry.status)))throw Error('original read-only inspection proof changed');
    const index=receipt.entries.findIndex(entry=>entry.status==='not_started'),expected=index<0?[]:state.tasks.slice(index);
    if(index<0||receipt.entries.slice(index).some(entry=>entry.status!=='not_started'))throw Error('real continuation must match the inspected strict suffix');
    if(!op.payload.previousOperationId&&Object.values(this.journal.data?.operations||{}).some(entry=>entry.operation?.id!==op.id&&entry.operation?.kind==='account'&&entry.operation.accountId===op.accountId&&entry.operation.payload?.action==='continue_unstarted_drafts'&&entry.operation.payload.originalOperationId===op.payload.originalOperationId&&entry.operation.payload.sendOnly===false))throw Error('previous real continuation must be explicitly selected');
    if(op.payload.previousOperationId) {
      const previous=this.journal.get(op.payload.previousOperationId),prior=previous?.operation,rows=previous?.result?.receipt?.dispatches;
      if(!previous?.reported||previous.state!=='done'||previous.result?.outcome!=='uncertain'||prior?.id===op.id||prior?.kind!=='account'||prior.accountId!==op.accountId||prior.batchId!==state.original.operation.batchId||prior.payload?.action!=='continue_unstarted_drafts'||prior.payload.originalOperationId!==op.payload.originalOperationId||prior.payload.account?.environment?.version!==state.version||prior.payload.sendOnly!==false||prior.payload.dispatchOnly!==false||prior.payload.readOnlyInspection!==true||previous.result.receipt?.dispatchOnly!==false||previous.result.receipt.originalOperationId!==op.payload.originalOperationId||!Array.isArray(prior.payload.tasks)||!prior.payload.tasks.length||new Set(prior.payload.tasks.map(task=>task.id)).size!==prior.payload.tasks.length||prior.payload.tasks.some(task=>!state.tasks.some(original=>immutableSnapshot(original)===immutableSnapshot(task)))||!Array.isArray(rows)||new Set(rows.map(row=>row?.taskId)).size!==rows.length)throw Error('previous real continuation is not closed or changed');
      for(const row of rows) {
        const task=prior.payload.tasks.find(task=>task.id===row?.taskId);
        if(!task||row.draftId!==task.draftId||row.nativeId!==task.nativeBinding?.nativeId||!Number.isFinite(Date.parse(row.clickedAt))||!['message_accepted','attempted_unconfirmed','quota_limited'].includes(row.outcome))throw Error('previous real continuation evidence changed');
      }
      const attempted=new Set(rows.map(row=>row.taskId));
      if(immutableSnapshot(prior.payload.tasks.filter(task=>!attempted.has(task.id)))!==immutableSnapshot(expected))throw Error('previous real continuation unstarted suffix changed');
    }
    if(validationCount===30&&expected.length<30||immutableSnapshot(validationCount===30?expected.slice(0,30):expected)!==immutableSnapshot(op.payload.tasks))throw Error('real continuation must match the inspected validation suffix');
    if(!recover&&(receipt.executorSessionId!==this.sessionId||Date.now()<receipt.inspectedAt||Date.now()-receipt.inspectedAt>60000||JSON.stringify(receipt.entries)!==JSON.stringify(state.entries)))throw Error('real continuation inspection proof expired or changed');
    return state;
  }
  realContinuationReceipt(op,state=this.originalUnstartedState(op,false),normal=false) {
    const tasks=[],dispatches=[],processed=this.processedEvidence(op);
    for(const snapshot of op.payload.tasks||[]) {
      const record=state.records.get(snapshot.id),task=record?.task,raw=record?.raw,proof=task?.attachmentSendProof;
      const dispatch=raw&&raw.taskId===snapshot.id&&raw.draftId===snapshot.draftId&&raw.nativeId===snapshot.nativeBinding?.nativeId&&raw.clickedAt&&['pending','message_accepted','quota_limited'].includes(raw.outcome)?{taskId:raw.taskId,draftId:raw.draftId,nativeId:raw.nativeId,clickedAt:raw.clickedAt,outcome:raw.outcome==='pending'?'attempted_unconfirmed':raw.outcome,...(/^https:\/\/www\.doubao\.com\/chat\/[^/?#]+$/.test(raw.conversationUrl||'')?{conversationUrl:raw.conversationUrl}:{}),...(raw.outcome==='quota_limited'&&typeof raw.providerMessage==='string'&&raw.providerMessage.trim()?{providerMessage:'近7天免费额度已用完'}:{})}:null;
      if(dispatch)dispatches.push(dispatch);
      const imageProof=record.names.length===0&&Array.isArray(task?.refs)&&task.refs.length===0||proof?.version===1&&proof.referenceCount===record.names.length&&JSON.stringify(proof.names)===JSON.stringify(record.names)&&Array.isArray(task.refs)&&task.refs.length===record.names.length&&JSON.stringify(task.refs.map(file=>path.basename(file)))===JSON.stringify(record.names)&&Array.isArray(proof.fileKeySha256s)&&proof.fileKeySha256s.length===record.names.length&&proof.fileKeySha256s.every(value=>/^[a-f0-9]{64}$/i.test(value||'')&&value!==crypto.createHash('sha256').update('').digest('hex'))&&proof.clickedAt===task.sentAt&&proof.clickedAt===raw?.clickedAt;
      const consumed=task?.attachmentConsumptionProof,consumptionValid=!normal||record.names.length===0||consumed?.version===1&&JSON.stringify(consumed.names)===JSON.stringify(record.names)&&consumed.userMessageId===task.receiptUserMessageId&&Number.isFinite(Date.parse(consumed.checkedAt))&&Date.parse(consumed.checkedAt)>=Date.parse(task.sentAt);
      const accepted=originalMessage(task)&&imageProof&&consumptionValid&&dispatch?.outcome==='message_accepted'&&dispatch.conversationUrl===task.conversationUrl;
      const quota=imageProof&&task?.submissionUncertain===true&&!task.receiptUserMessageId&&dispatch?.outcome==='quota_limited'&&dispatch.conversationUrl&&dispatch.providerMessage;
      if(dispatch?.outcome==='quota_limited'&&!quota){dispatch.outcome='attempted_unconfirmed';delete dispatch.providerMessage;}
      if(quota)tasks.push({taskId:snapshot.id,status:'quota_limited',draftId:snapshot.draftId,nativeId:snapshot.nativeBinding.nativeId,conversationId:dispatch.conversationUrl,providerMessage:dispatch.providerMessage,confirmed:false});
      else tasks.push({taskId:snapshot.id,status:accepted?'submitted':state.entries.find(entry=>entry.taskId===snapshot.id)?.status==='not_started'?(processed.some(row=>row.taskId===snapshot.id&&!row.issued&&!row.received)?'skipped_before_click':'not_attempted'):'uncertain',...(task?.id?{localTaskId:task.id}:{}),...(task?.conversationUrl?{conversationId:task.conversationUrl}:{}),...(task?.receiptUserMessageId?{userMessageId:task.receiptUserMessageId}:{}),...(normal&&accepted&&record.names.length?{attachmentProof:{...proof,userMessageId:task.receiptUserMessageId,checkedAt:consumed.checkedAt}}:{}),confirmed:false});
    }
    const complete=tasks.length===op.payload.tasks.length&&tasks.every(task=>task.status==='submitted');
    const summary={expected:op.payload.tasks.length,attempted:dispatches.length,submitted:tasks.filter(task=>task.status==='submitted').length,unknown:tasks.filter(task=>task.status==='uncertain').length,quotaSkipped:tasks.filter(task=>task.status==='quota_limited').length,notAttempted:tasks.filter(task=>task.status==='not_attempted').length};
    const skipped=tasks.filter(task=>task.status==='skipped_before_click').length;if(skipped)summary.skippedBeforeClick=skipped;
    return {outcome:complete?'success':'uncertain',receipt:{status:complete?'draft_dispatch_complete':'draft_dispatch_partial',dispatchOnly:false,originalOperationId:normal?op.id:op.payload.originalOperationId,processedComplete:tasks.length===op.payload.tasks.length&&(normal?processed.length===op.payload.tasks.length:op.payload.tasks.every(task=>processed.some(row=>row.taskId===task.id)||dispatches.some(row=>row.taskId===task.id))),...(normal||processed.length?{processed}:{}),summary,tasks,dispatches}};
  }
  async continueRealUnstartedDrafts(op,recover=false,context={}) {
    const check=this.leaseGuard(op,context);check();this.realContinuationProof(op,recover);check();
    if(recover)return this.realContinuationReceipt(op);
    await this.send(op,false,context);check();return this.realContinuationReceipt(op);
  }
  async send(op,recover=false,context={}) {
    const inst=this.account(op),tasks=op.payload.tasks;
    if(!Array.isArray(tasks) || !tasks.length || tasks.length>100)throw new Error('invalid send batch');
    const ids=tasks.map(task=>{
      const binding=this.journal.task(task.id);
      if(!binding || binding.accountId!==op.accountId)throw new Error('task account binding mismatch');
      const local=this.local(task.id,op.accountId),draft=drafts.list().find(d=>d.id===binding.draftId),sendOnly=op.payload.sendOnly===true;
      if(local && Boolean(local.studioSendOnly)!==sendOnly || draft?.submissionRecord && Boolean(draft.studioSendOnly)!==sendOnly)throw new Error('submitted batch mode is immutable');
      if(draft && !draft.submissionRecord)drafts.updateMany({[draft.id]:{studioSendOnly:sendOnly}});
      return binding.draftId;
    });
    if(recover)return this.sendReceipt(op,tasks);
    let deliveryPause;
    const visibility={
      onDeliveryPage:({draft,driver,cancel})=>{
        const task=tasks.find(t=>t.id===draft.template.studioTaskId),binding=task&&this.journal.task(task.id);
        if(!task||binding?.accountId!==op.accountId||binding.draftId!==draft.id)throw Error('delivery page task identity mismatch');
        return this.registerDelivery(op,task.id,draft.id,inst,driver,cancel,context);
      },
      onDeliveryPause:info=>{deliveryPause=info;},
      onDraftProcessed:({draft,issued,received})=>{this.leaseGuard(op,context)();const snapshot=tasks.find(task=>task.id===draft.template?.studioTaskId),binding=snapshot&&this.journal.task(snapshot.id);if(snapshot&&!snapshot.draftId&&op.payload.batchSize!==50)return;if(!snapshot||snapshot.draftId!==draft.id||binding?.accountId!==op.accountId||binding.draftId!==draft.id||typeof issued!=='boolean'||typeof received!=='boolean'||received&&!issued)throw Error('processed draft identity changed');this.journal.bindTask(snapshot.id,{lastSendProcessed:{operationId:op.id,draftId:draft.id,issued,received,at:new Date().toISOString()}});}
    };
    try {await queue.submitDrafts(ids,{instanceId:inst.id,maxPages:this.maxDraftPages,startQueue:false,sendOnly:true,dispatchOnly:op.payload.sendOnly===true,continueOnFailure:true,checkLease:this.leaseGuard(op,context),...visibility});} catch { /* Each durable native receipt decides its own status. */ }
    const result=this.sendReceipt(op,tasks);
    if(deliveryPause)result.receipt.deliveryPause=deliveryPause;
    return result;
  }
  progress(op) {
    if(op.kind==='account'&&op.payload.action==='continue_unstarted_drafts')return {outcome:'progress',receipt:this.continuationReceipt(op).receipt};
    if(op.kind!=='send')return null;
    if(op.payload.batchSize===50&&op.payload.sendOnly===false)return {outcome:'progress',receipt:this.sendReceipt(op,op.payload.tasks).receipt};
    const tasks=[];
    for(const snapshot of op.payload.tasks||[]) {
      const binding=this.journal.task(snapshot.id);
      if(!binding || binding.accountId!==op.accountId)continue;
      const draft=drafts.list().find(d=>d.id===binding.draftId);
      const task=(binding.localTaskId && queue.getTask(binding.localTaskId)) || store.get().tasks.find(t=>t.templateId===binding.templateId) || draft?.submissionRecord?.task;
      if(task?.conversationUrl && !task.submissionUncertain)tasks.push({taskId:snapshot.id,localTaskId:task.id,conversationId:task.conversationUrl,...(task.receiptUserMessageId?{userMessageId:task.receiptUserMessageId}:{}),status:'submitted',confirmed:confirmed(task)});
    }
    return tasks.length?{outcome:'progress',receipt:{tasks}}:null;
  }
  async track(op,context={}) {
    const inst=this.account(op);
    const taskId=op.taskId||op.payload.task?.id,task=this.local(taskId,op.accountId);
    if(!task)return {outcome:'uncertain',receipt:{taskId,status:'running',error:'original local task missing'}};
    const receipt={taskId,localTaskId:task.id,conversationId:task.conversationUrl,...(task.receiptUserMessageId?{userMessageId:task.receiptUserMessageId}:{}),confirmed:confirmed(task)};
    if(task.studioSendOnly || op.payload.sendOnly===true)return {outcome:'progress',receipt:{...receipt,confirmed:false,status:'running'}};
    if((!confirmed(task)||task.status==='submitted') && ['submitted','queued'].includes(task.status) && task.receiptUserMessageId) {
      await queue.confirmSubmittedTaskOnce(task.id,{checkLease:this.leaseGuard(op,context),onDeliveryPage:({driver,cancel})=>this.registerDelivery(op,taskId,this.journal.task(taskId)?.draftId,inst,driver,cancel,context)});
      receipt.confirmed=confirmed(task);
      if(task.status!=='failed' && !receipt.confirmed)return {outcome:'progress',receipt:{...receipt,status:'running'}};
    }
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
  async inspectPendingDrafts(accountId,inst,driver) {
    const pending=drafts.list().filter(d=>d.instanceId===inst.id && ['saving','saved'].includes(d.nativeState) && !d.submissionRecord && d.template?.studioTaskId);
    if(!pending.length)return;
    const entries=[];
    for(const draft of pending.slice(0,100)) {
      const taskId=draft.template.studioTaskId,binding=this.journal.task(taskId);
      const entry={taskId,draftId:draft.id,draftNumber:draft.draftNumber,status:'unverified'};
      entries.push(entry);
      if(binding?.accountId!==accountId || binding.draftId!==draft.id || !/^[a-f0-9]{64}$/.test(binding.snapshotHash||'') || !draft.nativePrompt)continue;
      entry.snapshotHash=binding.snapshotHash;
      entry.nativePromptSha256=crypto.createHash('sha256').update(draft.nativePrompt.replace(/\s+/g,' ').trim()).digest('hex');
      try {
        const proof=await driver.call('verifyNativeDraftSaved',{id:draft.id,prompt:draft.nativePrompt,executionMode:draft.executionMode,...(draft.nativeBinding?{nativeId:draft.nativeBinding.nativeId,accountScope:draft.nativeBinding.accountScope}:{})});
        const native=proof?.bindings?.[0];
        if(proof?.ok===true && proof.readOnly===true && proof.bindings.length===1 && native.id===draft.id && typeof native.nativeId==='string' && native.nativeId && typeof native.accountScope==='string' && native.accountScope) {
          entry.status='matched';entry.nativeBinding={id:native.id,nativeId:native.nativeId,accountScope:native.accountScope};
        }
      } catch { /* Inspection failure preserves the original uncertain state. */ }
    }
    return {version:1,readOnly:true,accountId,executorSessionId:this.sessionId,inspectedAt:Date.now(),entries};
  }
  async resumeUnwrittenImport(op,context={}) {
    const snapshot=requireTask(op),original=this.journal.get(op.payload.originalOperationId),binding=this.journal.task(snapshot.id);
    const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value,(key,item)=>key==='downloadUrl'?undefined:item)).digest('hex');
    const check=this.leaseGuard(op,context);check();
    const draft=drafts.list().find(d=>d.id===binding?.draftId);
    if(op.payload.sendOnly!==true||snapshot.references?.length||!original?.reported||original.operation.kind!=='import'||original.operation.accountId!==op.accountId||original.result?.outcome!=='uncertain'||hash(original.operation.payload.task)!==hash(snapshot)||binding?.accountId!==op.accountId||binding.snapshotHash!==hash(snapshot)||!draft||!draft.draftNumber||draft.nativeState||draft.nativePrompt||draft.nativeBinding||draft.submissionRecord)throw Error('original import is not proved unwritten');
    const template=draft.template,id=stableId('',`${op.accountId}/${snapshot.id}`),templateId=stableId('studio-template-',snapshot.id);
    if(draft.id!==id||draft.draftNumber!==drafts.numberFor(id)||draft.executionMode!=='work'||draft.studioSendOnly!==true||template?.id!==templateId||binding.templateId!==templateId||template.studioTaskId!==snapshot.id||template.prompt!==snapshot.prompt||template.model!==snapshot.parameters.model||template.duration!==snapshot.parameters.duration||template.ratio!==snapshot.parameters.ratio||!Array.isArray(template.attachments)||template.attachments.length)throw Error('original import template changed');
    const inst=this.account(op),win=await this.accounts.open(inst.id),driver=await this.driverFactory(inst,win.webContents);
    if((await driver.isLoggedIn())?.loggedIn!==true)throw Error('original account login required');
    const missing=await driver.call('verifyNativeDraftMissing',{prompt:`【草稿编号：${draft.draftNumber}】`,accountScope:op.payload.accountScope});check();
    if(missing?.ok!==true||missing.readOnly!==true||missing.absent!==true||!op.payload.accountScope||missing.accountScope!==op.payload.accountScope)throw Error('complete original input records cannot prove the task body absent');
    const unwrittenProof={readOnly:true,taskContentWritten:false,catalogComplete:true,accountScope:missing.accountScope};
    check();const imported=await this.import(op,false,context);check();
    if(imported?.outcome!=='success')throw Error('resumed import requires original receipt inspection');
    return {outcome:'success',receipt:{...imported.receipt,status:'draft_import_resumed',originalOperationId:op.payload.originalOperationId,taskId:snapshot.id,snapshotHash:hash(snapshot),environmentVersion:inst.studioEnvironment?.version,executorSessionId:this.sessionId,verifiedAt:Date.now(),unwrittenProof}};
  }
  async reconcileImport(op,context={}) {
    const intent=op.payload.reconciliation,snapshot=intent?.task;
    const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value,(key,item)=>key==='downloadUrl'?undefined:item)).digest('hex');
    const check=this.leaseGuard(op,context);check();
    const original=this.journal.get(intent?.originalOperationId),binding=this.journal.task(snapshot?.id);
    if(!snapshot?.id || !intent.proofOperationId || !Array.isArray(snapshot.references) || snapshot.references.length || original?.operation.kind!=='import' || original.operation.accountId!==op.accountId || original.operation.taskId!==snapshot.id || original.state!=='done' || !original.reported || original.result?.outcome!=='uncertain' || hash(snapshot)!==intent.snapshotHash || hash(original.operation.payload.task)!==intent.snapshotHash || binding?.snapshotHash!==intent.snapshotHash || binding.accountId!==op.accountId || binding.draftId!==intent.draftId)throw new Error('original import snapshot mismatch');
    const draft=drafts.list().find(d=>d.id===intent.draftId),native=intent.nativeBinding;
    if(!draft || !['saving','saved'].includes(draft.nativeState) || draft.submissionRecord || draft.instanceId!==stableId('studio-account-',op.accountId) || draft.draftNumber!==intent.draftNumber || draft.draftNumber!==drafts.numberFor(draft.id) || draft.template?.studioTaskId!==snapshot.id || draft.template.prompt!==snapshot.prompt || !Array.isArray(draft.template.attachments) || draft.template.attachments.length || ['model','duration','ratio'].some(key=>draft.template[key]!==snapshot.parameters?.[key]) || draft.executionMode!=='work' || !draft.nativePrompt || crypto.createHash('sha256').update(draft.nativePrompt.replace(/\s+/g,' ').trim()).digest('hex')!==intent.nativePromptSha256 || native?.id!==draft.id || !native.nativeId || !native.accountScope || [draft.nativeBinding,binding.nativeBinding].some(b=>b && (b.id!==native.id || b.nativeId!==native.nativeId || b.accountScope!==native.accountScope)))throw new Error('original native draft binding mismatch');
    const inst=this.account(op),win=await this.accounts.open(inst.id),driver=await this.driverFactory(inst,win.webContents);
    if((await driver.isLoggedIn())?.loggedIn!==true)throw new Error('original account login proof missing');
    const proof=await driver.call('verifyNativeDraftSaved',{id:draft.id,prompt:draft.nativePrompt,executionMode:draft.executionMode,nativeId:native.nativeId,accountScope:native.accountScope});
    const verified=proof?.bindings?.[0];
    if(proof?.ok!==true || proof.readOnly!==true || proof.bindings.length!==1 || verified?.id!==native.id || verified.nativeId!==native.nativeId || verified.accountScope!==native.accountScope)throw new Error('original native draft proof mismatch');
    check();drafts.updateMany({[draft.id]:{nativeState:'saved',nativeBinding:verified,nativeError:''}});
    check();this.journal.bindTask(snapshot.id,{nativeBinding:verified});
    return {outcome:'success',receipt:{status:'draft_reconciled',browserReadOnly:true,originalOperationId:intent.originalOperationId,proofOperationId:intent.proofOperationId,taskId:snapshot.id,draftId:draft.id,snapshotHash:intent.snapshotHash,nativePromptSha256:intent.nativePromptSha256,nativeBinding:{id:native.id,nativeId:native.nativeId,accountScope:native.accountScope},environmentVersion:inst.studioEnvironment?.version,executorSessionId:this.sessionId,verifiedAt:Date.now()}};
  }
  async login(op,context={}) {
    const action=op.payload.action||'frame';
    const input=action==='input'?decryptInput(op.payload.inputEncrypted,this.client.token):{};
    const checkAction=this.leaseGuard(op,context);
    const inst=this.account(op);let win;
    try {win=await this.accounts.open(inst.id);} catch(error) {
      if(['open','navigate','frame'].includes(action))return {outcome:'failure',receipt:{error:'账号页面加载失败，请检查出口配置后手动重试'}};
      if(action!=='probe')throw error;
      return {outcome:'success',receipt:{environmentVersion:inst.studioEnvironment?.version,executorSessionId:this.sessionId,
        environmentCheck:{proxy:{ok:false,ip:'',location:'',latency:0,message:'account proxy or target navigation failed'},fingerprint:{ok:false,message:'target page unavailable'}}}};
    }
    const wc=win.webContents;
    if(action==='probe') {
      if(!this.environment)throw new Error('account environment unavailable');
      const environmentCheck=await this.environment.check(inst,wc);
      return {outcome:'success',receipt:{environmentVersion:inst.studioEnvironment.version,executorSessionId:this.sessionId,environmentCheck}};
    }
    if(action==='navigate') {
      const url=new URL(op.payload.url||store.DEFAULT_URL);
      if(url.href!==store.DEFAULT_URL)throw new Error('Doubao login navigation only');
      checkAction();try {await wc.loadURL(url.href);} catch {return {outcome:'failure',receipt:{error:'豆包登录页面加载失败，请检查出口配置后手动重试'}};}
    } else if(action==='input') {
      if(input.kind==='click') {
        if(!Number.isFinite(input.x)||!Number.isFinite(input.y)||input.x<0||input.x>1||input.y<0||input.y>1)throw new Error('invalid click coordinates');
        const [width,height]=win.getContentSize(),value={x:Math.min(width-1,Math.round(input.x*width)),y:Math.min(height-1,Math.round(input.y*height)),button:'left',clickCount:1};
        checkAction();await wc.debugger.sendCommand('Input.dispatchMouseEvent',{...value,type:'mousePressed'});
        checkAction();await wc.debugger.sendCommand('Input.dispatchMouseEvent',{...value,type:'mouseReleased'});
      } else if(input.kind==='scroll') {
        if(![input.deltaX,input.deltaY].every(n=>Number.isSafeInteger(n)&&Math.abs(n)<=4000))throw new Error('invalid scroll delta');
        const [width,height]=win.getContentSize();checkAction();
        await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:Math.floor(width/2),y:Math.floor(height/2),deltaX:input.deltaX,deltaY:input.deltaY});
      } else if(input.kind==='text') {
        if(typeof input.text!=='string'||input.text.length>10000)throw new Error('invalid login text');
        checkAction();await wc.debugger.sendCommand('Input.insertText',{text:input.text});
      } else if(input.kind==='key' && ['Enter','Tab','Backspace','Escape'].includes(input.key)) {
        const keyCode={Enter:13,Tab:9,Backspace:8,Escape:27}[input.key];
        for(const type of ['keyDown','keyUp']) {checkAction();await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:input.key,code:input.key,windowsVirtualKeyCode:keyCode,...(type==='keyDown'&&input.key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});}
      } else throw new Error('unsupported login input');
    } else if(!['open','frame','screenshot'].includes(action))throw new Error('unsupported login action');
    let image;
    try {image=await wc.capturePage(undefined,{stayHidden:true});} catch(error) {
      if(action==='input')throw error;
      return {outcome:'failure',receipt:{error:'账号画面读取失败，请手动刷新'}};
    }
    const jpeg=image.toJPEG(70);
    if(jpeg.length>1024*1024)throw new Error('login screenshot too large');
    const driver=await this.driverFactory(inst,wc),login=await driver.isLoggedIn().catch(()=>({}));
    const draftInspection=action==='frame'?await this.inspectPendingDrafts(op.accountId,inst,driver):undefined;
    const [width,height]=win.getContentSize();
    return {outcome:'success',receipt:{imageBase64:jpeg.toString('base64'),contentType:'image/jpeg',width,height,capturedAt:new Date().toISOString(),loginState:login?.loggedIn===true?'logged_in':login?.loggedIn===false?'logged_out':'unknown',...(draftInspection?{draftInspection}:{})}};
  }
  leaseGuard(op,context) {
    return context.checkLease||(()=>{const until=typeof op.leaseUntil==='number'?op.leaseUntil:Date.parse(op.leaseUntil);if(!Number.isFinite(until)||Date.now()>=until)throw new Error('studio operation lease expired');});
  }
  execute(op,context={}) {
    if(op.kind==='import')return this.import(op,false,context);
    if(op.kind==='send')return this.send(op,false,context);
    if(op.kind==='track')return this.track(op,context);
    if(op.kind==='account')return op.payload.action==='inspect_unstarted_drafts'?this.inspectUnstartedDrafts(op,context):op.payload.action==='continue_unstarted_drafts'?this.continueUnstartedDrafts(op,false,context):op.payload.action==='reconcile_import'?this.reconcileImport(op,context):op.payload.action==='resume_unwritten_import'?this.resumeUnwrittenImport(op,context):this.login(op,context);
    throw new Error('unsupported operation');
  }
  async recover(op,context={}) {
    if(op.kind==='account'&&op.payload.action==='inspect_unstarted_drafts')return this.inspectUnstartedDrafts(op,context);
    if(op.kind==='account'&&op.payload.action==='continue_unstarted_drafts')return this.continueUnstartedDrafts(op,true,context);
    if(op.kind==='import')return this.import(op,true,context);
    if(op.kind==='send')return this.send(op,true,context);
    if(op.kind==='track')return this.track(op,context);
    if(op.payload.action==='reconcile_import')return this.reconcileImport(op,context);
    // Input commands may have succeeded. Never replay keystrokes after interruption.
    if(op.payload.action==='input') {
      let receipt;
      try {({receipt}=await this.login({...op,payload:{...op.payload,action:'frame'}},context));} catch {}
      return {outcome:'uncertain',receipt:{...receipt,error:'原输入结果未知，请人工核验；不会自动重发'}};
    }
    return this.login(op,context);
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
    if(inst.fingerprint || win.webContents.isDestroyed())return;
    win.webContents.executeJavaScript(source).catch(()=>{win.loadError='页面自动化加载失败';});
  });
  return win;
}
async function start() {
  const {app,BrowserWindow,session,net}=require('electron');
  const file=studioConfigFile(app);
  if(!file)throw new Error('private --studio-config file required');
  const cfg=readConfig(file);fs.mkdirSync(cfg.stateDir,{recursive:true,mode:0o700});app.setPath('userData',cfg.stateDir);app.setPath('sessionData',cfg.stateDir);
  if(!app.requestSingleInstanceLock()) {app.exit(1);return;}
  await app.whenReady();P.init({home:cfg.stateDir});store.load();
  assertDedicatedState();
  // Dedicated mode starts no desktop HTTP/MCP services or shared proxy handlers.
  store.get().settings.orchestrator={...store.get().settings.orchestrator,retryLimit:0,autoDownload:true,autoConfirm:true,maxParallel:Math.max(1,Math.min(8,cfg.trackingPages||2))};
  store.get().settings.downloadDir=P.dir('exports');durableSave();
  const interceptor=require('./interceptor'),driver=require('./driver'),{WebAccounts}=require('./web-accounts');
  const {StudioEnvironment}=require('./studio-environment');
  const environment=new StudioEnvironment({app,session,net,token:cfg.token,enhancer:store.get().settings.enhancer});
  const prepareSession=async(inst)=>{const ses=await environment.prepareStudioSession(inst);interceptor.attach(ses,inst);return ses;};
  const windowFor=(inst,height)=>createStudioWindow(inst,{BrowserWindow,enhancer:store.get().settings.enhancer,height});
  const accounts=new WebAccounts({prepareSession,awaitNavigation:true,createWindow:inst=>windowFor(inst,800),prepareWindow:(win,inst)=>environment.prepareStudioWindow(win,inst),wake:()=>{},publish:()=>{},log:{warn:()=>{}}});
  const pages=new Set();
  queue.init({resolveDriver:async(inst)=>driver.open(inst,{webContents:(await accounts.open(inst.id)).webContents}),
    resolveDraftDriver:async(inst,{signal}={})=>{
      await prepareSession(inst);signal?.throwIfAborted();
      const win=windowFor(inst,900);
      pages.add(win);const close=()=>{if(!win.isDestroyed())win.destroy();};
      win.on('closed',()=>{pages.delete(win);signal?.removeEventListener('abort',close);});signal?.addEventListener('abort',close,{once:true});
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      try {await win.loadURL('about:blank');await environment.prepareStudioWindow(win,inst);await win.loadURL(store.DEFAULT_URL);const instanceDriver=await driver.open(inst,{webContents:win.webContents});instanceDriver.window=win;instanceDriver.close=close;instanceDriver.preserve=()=>signal?.removeEventListener('abort',close);instanceDriver.resumeAutoClose=()=>{if(signal?.aborted)return false;signal?.addEventListener('abort',close,{once:true});return true;};return instanceDriver;} catch(error){close();throw error;}
    },findWebContents:inst=>accounts.find(inst)});
  queue.recoverTemplateTasks();queue.pause('');
  const journal=new Journal(path.join(cfg.stateDir,'studio-journal.json')),client=new StudioClient(cfg);
  let captchaConfig;
  if(cfg.captchaConfigFile){try{const raw=fs.readFileSync(cfg.captchaConfigFile,'utf8');if(raw.length>8192)throw Error();captchaConfig=JSON.parse(raw);if(captchaConfig.baseUrl!=='https://ark.cn-beijing.volces.com/api/v3'||typeof captchaConfig.apiKey!=='string'||!captchaConfig.apiKey)throw Error();}catch{throw Error('local captcha configuration invalid');}}
  const adapter=new NativeAdapter({journal,client,accounts,environment,sessionId:client.sessionId,maxDraftPages:cfg.maxDraftPages||4,captchaConfig});
  const bridge=new StudioBridge({journal,api:client,adapter,operationConcurrency:cfg.operationConcurrency||2,onError:code=>process.stderr.write(`studio-executor: ${code}\n`)});
  const control=new StudioControl({client,adapter,decryptInput,onError:code=>process.stderr.write(`studio-executor: ${code}\n`)});
  adapter.onSolverReleasePending=(page,point)=>control.rememberMouseRelease(page.driver.window,page,point);
  const controller=new AbortController();
  app.on('window-all-closed',()=>{});
  app.on('before-quit',()=>{controller.abort();queue.pause('');accounts.stop();for(const win of pages)if(!win.isDestroyed())win.destroy();});
  for(const event of ['SIGTERM','SIGINT'])process.once(event,()=>app.quit());
  bridge.run(controller.signal).catch(()=>{process.stderr.write('studio-executor: stopped\n');app.exit(1);});
  control.run(controller.signal).catch(()=>{process.stderr.write('studio-executor: control stopped\n');});
  return {bridge,adapter,control};
}
module.exports={NativeAdapter,decryptInput,assertDedicatedState,readConfig,studioConfigFile,createStudioWindow,start};
