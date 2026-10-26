"use strict";
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
let bridgeModule = {};
try { bridgeModule = require('../src/studio-bridge'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const { Journal, StudioClient, StudioBridge, downloadReferences } = bridgeModule;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bridge-'));
after(() => fs.rmSync(root, {recursive:true, force:true}));
let n=0;
function journal() { return new Journal(path.join(root, String(++n), 'journal.json')); }
function operation(kind='send', id='op1') { return {id, kind, accountId:'account1',leaseToken:'lease-private',leaseUntil:new Date(Date.now()+60000).toISOString(),payload:{account:{id:'account1', name:'测试账号'}, tasks:[{id:'task1'}]}}; }
function transport() { const reports=[]; return { reports, heartbeat: async()=>({}), report:async(op,result)=>{reports.push({op,result});}, claim:async()=>({operation:null}) }; }

test('operation intent survives reload before send; duplicate receipt never sends twice', async()=>{
  assert.equal(typeof StudioBridge, 'function', 'missing bridge');
  const j=journal(), api=transport(); let sends=0;
  const adapter={ execute:async(op)=>{assert.equal(new Journal(j.file).get(op.id).state,'started'); sends++; return {outcome:'success',receipt:{tasks:[{taskId:'task1',status:'submitted',localTaskId:'local1',conversationId:'https://www.doubao.com/chat/1'}]}}; } };
  const a=new StudioBridge({journal:j,api,adapter}); await a.processOperation(operation());
  const b=new StudioBridge({journal:new Journal(j.file),api,adapter}); await b.processOperation(operation());
  assert.equal(sends,1); assert.equal(api.reports.length,2); assert.deepEqual(api.reports[0].result,api.reports[1].result);
});
test('interrupted unknown send is uncertain and is never automatically resent', async()=>{
  assert.equal(typeof StudioBridge,'function','missing bridge');
  const j=journal(), op=operation(); j.begin(op); let sends=0;
  const api=transport(), b=new StudioBridge({journal:new Journal(j.file),api,adapter:{execute:async()=>{sends++;},recover:async()=>null}});
  await b.processOperation(op);
  assert.equal(sends,0); assert.equal(api.reports[0].result.outcome,'uncertain');
});
test('changed duplicate operation is blocked before side effects',async()=>{
  assert.equal(typeof StudioBridge,'function','missing bridge');
  const j=journal(), op=operation(); j.begin(op); let called=false;
  const b=new StudioBridge({journal:j,api:transport(),adapter:{execute:async()=>{called=true;}}});
  await assert.rejects(b.processOperation({...op,accountId:'other'}),/identity/); assert.equal(called,false);
});
test('lost report retries persisted receipt without repeating side effect',async()=>{
  assert.equal(typeof StudioBridge,'function','missing bridge');
  const j=journal(), api=transport(); let calls=0, reports=0;
  api.report=async()=>{if(++reports===1)throw new Error('offline');};
  const b=new StudioBridge({journal:j,api,adapter:{execute:async()=>{calls++;return {outcome:'success',receipt:{draftId:'d',nativeBinding:{id:'d'}}};}}});
  await assert.rejects(b.processOperation(operation('import')),/offline/);
  await b.flushReports(); assert.equal(calls,1); assert.equal(reports,2); assert.equal(j.get('op1').reported,true);
});
test('heartbeat includes in-flight lease while slow browser operation runs',async()=>{
  assert.equal(typeof StudioBridge,'function','missing bridge');
  const j=journal(), api=transport(); let release, leases;
  api.heartbeat=async(input)=>{leases=input;return {executorId:'executor1',serverTime:Date.now(),leases:[]};};
  const b=new StudioBridge({journal:j,api,adapter:{execute:()=>new Promise(resolve=>{release=resolve;})}});
  const pending=b.processOperation(operation()); await b.heartbeat();
  assert.deepEqual(leases,[{operationId:'op1',leaseToken:'lease-private'}]);
  release({outcome:'uncertain',receipt:{error:'unknown'}}); await pending;
});
test('client uses exact v1 JSON protocol and MP4 lease upload headers',async()=>{
  assert.equal(typeof StudioClient,'function','missing client');
  const calls=[], client=new StudioClient({siteUrl:'https://studio.example',executorId:'executor1',token:'private-token',fetch:async(url,opts)=>{calls.push({url:String(url),opts});return new Response('{}',{status:200});}});
  await client.heartbeat([{operationId:'op1',leaseToken:'lease-private'}]);
  assert.deepEqual(JSON.parse(calls[0].opts.body),{action:'heartbeat',executorId:'executor1',version:'doubao-workbench/1',sessionId:client.sessionId,leases:[{operationId:'op1',leaseToken:'lease-private'}]});
  assert.match(client.sessionId,/^[a-f0-9-]{36}$/);
  const file=path.join(root,'result.mp4'), data=Buffer.from('0000ftypisom0123456789'); fs.writeFileSync(file,data);
  await client.upload('task1',operation('track'),file);
  assert.equal(calls[1].url,'https://studio.example/api/studio/doubao/executor/result?taskId=task1');
  assert.equal(calls[1].opts.headers['x-doubao-executor-id'],'executor1');
  assert.equal(calls[1].opts.headers['x-doubao-lease-token'],'lease-private');
  assert.equal(calls[1].opts.headers['x-doubao-sha256'],crypto.createHash('sha256').update(data).digest('hex'));
  assert.equal(calls[1].opts.headers.authorization,'Bearer private-token');
  const bad=path.join(root,'bad.mp4');fs.writeFileSync(bad,'not a movie');
  await assert.rejects(client.upload('task1',operation('track'),bad),/MP4/);
  assert.equal(calls.length,2);
});
test('reference downloads enforce same site, size, image MIME, hash and stable order',async()=>{
  assert.equal(typeof downloadReferences,'function','missing references');
  const data=Buffer.from([137,80,78,71,13,10,26,10,0]), hash=crypto.createHash('sha256').update(data).digest('hex');
  const ref={id:'image1',filename:'../danger.png',contentType:'image/png',byteSize:data.length,sha256:hash,downloadUrl:'https://studio.example/image/1'};
  const client=new StudioClient({siteUrl:'https://studio.example',executorId:'e',token:'private-token',fetch:async()=>new Response(data,{headers:{'content-type':'image/png'}})});
  const files=await downloadReferences([ref],path.join(root,'refs'),client);
  assert.equal(fs.readFileSync(files[0].path).equals(data),true); assert.equal(path.dirname(files[0].path),path.join(root,'refs'));
  await assert.rejects(downloadReferences([{...ref,sha256:'0'.repeat(64)}],path.join(root,'refs2'),client),/hash/);
  await assert.rejects(downloadReferences([{...ref,byteSize:1}],path.join(root,'refs3'),client),/size/);
  await assert.rejects(downloadReferences([{...ref,downloadUrl:'https://outside.example/x'}],path.join(root,'refs4'),client),/origin/);
  await assert.rejects(downloadReferences([{...ref,contentType:'text/html'}],path.join(root,'refs5'),client),/image/);
});

let executorModule={};
try {executorModule=require('../src/server-executor');} catch(e) {if(e.code!=='MODULE_NOT_FOUND')throw e;}
const P=require('../src/paths'), store=require('../src/store'), queue=require('../src/orchestrator');
function setupNative() {
  P.init({home:path.join(root,`native-${++n}`)});store.load();queue.pause('');
  const calls=[];
  const driver={isLoggedIn:async()=>({loggedIn:true}),waitForLogin:async()=>({loggedIn:true}),pasteFiles:async()=>({ok:true}),setText:async()=>({ok:true}),setGenerationOptions:async()=>({}),beginTask:async()=>({ok:true,baselineUrls:[],baselineMessageIds:[]}),close:()=>{},
    call:async(method,opts)=>{calls.push({method,opts}); if(method==='restoreNativeDrafts')return {ok:true,bindings:[]};if(method==='saveNativeDraft')return {ok:true,bindings:[{id:opts.id,nativeId:'real-native-1'}]};if(method==='openNativeDraft')return {ok:true,conversationIds:[]};if(method==='waitNativeDraftAccepted')return {ok:true,conversationUrl:'https://www.doubao.com/chat/real1',userMessageId:'receipt-user-1'};if(method==='peekGenerationConfirmation')return {ok:true};if(method==='readProgress')return {state:'running',generationStarted:true};return {ok:true};}};
  queue.init({resolveDriver:async()=>driver,resolveDraftDriver:async()=>driver});
  return {calls,driver};
}
function nativeOperation(kind='import') {return {...operation(kind),payload:{account:{id:'account1',name:'测试账号'},task:{id:'task1',prompt:'原始内容',parameters:{model:'seedance_v2.0_mini',duration:5,ratio:'9:16'},references:[]}}};}

for (const alreadyIncluded of [false, true]) test(`native import puts the built-in Seedance skill on the first line once (${alreadyIncluded})`,async()=>{
  const {calls}=setupNative(), j=journal(), api=transport();
  const adapter=new executorModule.NativeAdapter({journal:j,client:api,accounts:{}}), op=nativeOperation();
  const skill='[Seedance 2.5](skill://seedance-25?type=2&id=353376777986)', body='清晨湖面\n@图1 保持参考图顺序';
  op.payload.task.prompt=alreadyIncluded?`${skill}\r\n${body}\r\n${skill}`:body;
  op.payload.task.parameters={model:'seedance_v2.5',duration:30,ratio:'16:9'};
  const imported=await adapter.execute(op);
  const saved=calls.find(c=>c.method==='saveNativeDraft').opts.prompt;
  assert.equal(saved.split('\n')[0],skill);
  assert.equal(saved.split(skill).length-1,1);
  assert.ok(saved.includes(body)); assert.match(saved,/【草稿编号：DB-[0-9A-F]{24}】/);
  const draft=require('../src/task-drafts').list()[0];
  assert.equal(draft.nativePrompt,saved); assert.equal(draft.template.prompt,op.payload.task.prompt);
  const recovered=await adapter.recover(op);
  assert.deepEqual(recovered.receipt,imported.receipt);
  assert.equal(calls.filter(c=>c.method==='saveNativeDraft').length,1);
  assert.equal(calls.filter(c=>c.method==='sendNativeDraft').length,0);
  queue.stopAll();
});
test('native adapter creates persistent real draft binding then submits same draft into original queue',async()=>{
  assert.equal(typeof executorModule.NativeAdapter,'function','missing native adapter');
  const {calls}=setupNative(), j=journal(), api=transport();
  const adapter=new executorModule.NativeAdapter({journal:j,client:api,accounts:{}});
  const imported=await adapter.execute(nativeOperation());
  assert.equal(imported.receipt.nativeBinding.nativeId,'real-native-1');
  assert.equal(calls.filter(c=>c.method==='saveNativeDraft').length,1);
  const sent=await adapter.execute({...nativeOperation('send'),id:'send1',payload:{account:{id:'account1',name:'测试账号'},tasks:[nativeOperation().payload.task]}});
  assert.equal(sent.receipt.tasks[0].status,'submitted');assert.equal(sent.receipt.tasks[0].taskId,'task1');assert.equal(sent.receipt.tasks[0].confirmed,false);
  const local=queue.getTask(sent.receipt.tasks[0].localTaskId);assert.equal(local.studioTaskId,'task1');assert.equal(local.conversationUrl,'https://www.doubao.com/chat/real1');
  const recovered=await adapter.recover({...nativeOperation('send'),payload:{account:{id:'account1',name:'测试账号'},tasks:[nativeOperation().payload.task]}});
  assert.equal(recovered.receipt.tasks[0].localTaskId,local.id);assert.equal(calls.filter(c=>c.method==='sendNativeDraft').length,1);
  queue.stopAll();
});
test('track upload failure retries same completed local MP4 without generating another task',async()=>{
  assert.equal(typeof executorModule.NativeAdapter,'function','missing native adapter');
  setupNative();const j=journal(), file=path.join(root,'native-result.mp4');fs.writeFileSync(file,'0000ftypisom0123456789');
  const task={id:'local1',studioTaskId:'task1',instanceId:'studio-account-'+crypto.createHash('sha256').update('account1').digest('hex').slice(0,24),status:'succeeded',conversationUrl:'https://www.doubao.com/chat/real1',submittedAt:'time',result:{files:[file],unwatermarked:true}};
  store.get().tasks.push(task);store.save();j.bindTask('task1',{accountId:'account1',localTaskId:'local1'});
  let uploads=0;const client={upload:async()=>{if(++uploads===1)throw new Error('lost upload');return {ok:true};}};
  const adapter=new executorModule.NativeAdapter({journal:j,client,accounts:{}}), op={...nativeOperation('track'),taskId:'task1'};
  await assert.rejects(adapter.execute(op),/lost upload/);
  const result=await adapter.recover(op);assert.equal(result.receipt.status,'completed');assert.equal(store.get().tasks.length,1);assert.equal(uploads,2);queue.stopAll();
});
test('account login normalized click is bounded, screenshot size safe and password input absent from journal',async()=>{
  assert.equal(typeof executorModule.NativeAdapter,'function','missing native adapter');
  setupNative();const j=journal(), commands=[];
  const wc={debugger:{sendCommand:async(method,value)=>commands.push({method,value})},capturePage:async()=>({toJPEG:()=>Buffer.from('jpeg')}),getURL:()=> 'https://www.doubao.com/chat/'};
  const adapter=new executorModule.NativeAdapter({journal:j,client:{token:'private-token'},accounts:{open:async()=>({webContents:wc,getContentSize:()=>[1000,800]})},driverFactory:async()=>({isLoggedIn:async()=>({loggedIn:false})})});
  const op={...operation('account'),payload:{account:{id:'account1',name:'测试'},action:'input',inputEncrypted:encryptedInput({kind:'click',x:0.25,y:0.5})}};
  const result=await adapter.execute(op);assert.equal(result.receipt.loginState,'logged_out');assert.equal(result.receipt.contentType,'image/jpeg');
  assert.deepEqual(commands.map(c=>[c.method,c.value.x,c.value.y]),[['Input.dispatchMouseEvent',250,400],['Input.dispatchMouseEvent',250,400]]);
  const secret={...op,id:'secret-op',payload:{...op.payload,input:{kind:'text',text:'test-password-never-log'}}};j.begin(secret);
  assert.equal(fs.readFileSync(j.file,'utf8').includes('test-password-never-log'),false);
  await assert.rejects(adapter.execute({...op,payload:{...op.payload,action:'navigate',url:'https://outside.example/'}}),/Doubao/);queue.stopAll();
});


test('explicit server mode enters isolated executor without loading desktop services',()=>{
  const vm=require('node:vm'), source=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
  const loaded=[]; let started=false;
  vm.runInNewContext(source,{process:{argv:['electron','.','--studio-executor'],stderr:{write:()=>{}}},require:(name)=>{loaded.push(name);if(name==='./server-executor')return {start:async()=>{started=true;}};throw new Error(`desktop module loaded: ${name}`);}});
  assert.equal(started,true);assert.deepEqual(loaded,['./server-executor']);
});

test('temporary MP4 upload error keeps operation recoverable and retries original output',async()=>{
  const j=journal(),api=transport();let executions=0,recoveries=0;
  const adapter={execute:async()=>{executions++;const e=new Error('upload unavailable');e.retryable=true;throw e;},recover:async()=>{recoveries++;return {outcome:'success',receipt:{status:'completed'}};}};
  const b=new StudioBridge({journal:j,api,adapter});
  await assert.rejects(b.processOperation(operation('track')),/upload unavailable/);
  assert.equal(j.get('op1').state,'started');assert.equal(api.reports.length,0);
  await b.flushReports();assert.equal(executions,1);assert.equal(recoveries,1);assert.equal(api.reports[0].result.receipt.status,'completed');
});

test('server and accepted desktop native drafts retain their original submission on quota rejection',async()=>{
  for(const serverOwned of [true,false]) {
    const {driver}=setupNative(), j=journal(),adapter=new executorModule.NativeAdapter({journal:j,client:{},accounts:{}});
    await adapter.execute(nativeOperation());
    const sent=await adapter.execute({...nativeOperation('send'),payload:{account:{id:'account1',name:'测试'},tasks:[nativeOperation().payload.task]}});
    const task=queue.getTask(sent.receipt.tasks[0].localTaskId);
    if(!serverOwned)delete task.studioTaskId;
    const submitted=task.submittedAt;
    let seen;const progressRead=new Promise(resolve=>{seen=resolve;});
    driver.readProgress=async()=>{seen();return {state:'failed',snippet:'今日额度已达上限'};};
    queue.resume(task.storyboardId);await progressRead;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(task.status,'failed');assert.equal(task.errorCode,'quota');assert.equal(task.submittedAt,submitted);
    queue.stopAll();
  }
});
test('native 100-task batch sends drafts serially even with legacy page concurrency configured',async()=>{
  const {driver}=setupNative(),j=journal(),adapter=new executorModule.NativeAdapter({journal:j,client:{},accounts:{},maxDraftPages:2});
  const tasks=[];for(let i=0;i<100;i++) {const op=nativeOperation();op.id='import'+i;op.payload.task.id='task'+i;await adapter.execute(op);tasks.push(op.payload.task);}
  let live=0,max=0,sends=0;
  queue.init({resolveDraftDriver:async()=>{
    live++;max=Math.max(max,live);const own={...driver,close:()=>{live--;},call:async(method,opts)=>{
      if(method==='sendNativeDraft')sends++;
      if(method==='waitNativeDraftAccepted'){await new Promise(resolve=>setTimeout(resolve,20));return {ok:true,conversationUrl:'https://www.doubao.com/chat/'+opts.id,userMessageId:'receipt-user-'+opts.id};}
      return driver.call(method,opts);
    }};return own;
  }});
  const result=await adapter.execute({...operation('send'),id:'limited',payload:{account:{id:'account1',name:'测试'},tasks}});
  assert.equal(sends,100);assert.equal(result.receipt.tasks.every(t=>t.status==='submitted'),true);assert.equal(max,1);assert.equal(live,0);queue.stopAll();
});

test('a new import operation for an already sent task cannot recreate a native draft after local draft removal',async()=>{
  const {calls}=setupNative(),j=journal(),adapter=new executorModule.NativeAdapter({journal:j,client:{},accounts:{}});
  await adapter.execute(nativeOperation());await adapter.execute({...nativeOperation('send'),payload:{account:{id:'account1',name:'测试'},tasks:[nativeOperation().payload.task]}});
  assert.equal(store.get().taskDrafts.length,0);
  await adapter.execute({...nativeOperation(),id:'new-import-id'});
  assert.equal(calls.filter(c=>c.method==='saveNativeDraft').length,1);queue.stopAll();
});

function encryptedInput(input,token='private-token') {
  const key=crypto.createHash('sha256').update('doubao-admin-input-v1:'+token).digest(),iv=Buffer.alloc(12,7),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(input),'utf8'),cipher.final()]);return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}
test('encrypted administrator login input decrypts only with correct token and never persists plaintext',async()=>{
  assert.equal(typeof executorModule.decryptInput,'function','missing login decryptor');
  const input={kind:'text',text:'secret-login-pass'},encrypted=encryptedInput(input);
  assert.deepEqual(executorModule.decryptInput(encrypted,'private-token'),input);
  assert.throws(()=>executorModule.decryptInput(encrypted,'wrong-token'),/encrypted login/);
  const j=journal(),op={...operation('account'),payload:{account:{id:'account1',name:'测试'},action:'input',inputEncrypted:encrypted}};j.begin(op);
  const persisted=fs.readFileSync(j.file,'utf8');assert.equal(persisted.includes('secret-login-pass'),false);assert.equal(persisted.includes(encrypted.data),true);
});


test('immutable task snapshot change cannot reuse another prompt native binding',async()=>{
  setupNative();const j=journal(),adapter=new executorModule.NativeAdapter({journal:j,client:{},accounts:{}});
  await adapter.execute(nativeOperation());const changed=nativeOperation();changed.id='changed';changed.payload.task.prompt='different prompt';
  await assert.rejects(adapter.execute(changed),/snapshot/);queue.stopAll();
});
test('executor rejects an ordinary desktop store before altering saved settings',()=>{
  assert.equal(typeof executorModule.assertDedicatedState,'function','missing dedicated-state check');
  setupNative();store.add({id:'desktop-private',name:'私人账号'});store.save();
  const before=JSON.stringify(store.get());assert.throws(()=>executorModule.assertDedicatedState(),/dedicated/);assert.equal(JSON.stringify(store.get()),before);queue.stopAll();
});


test('send progress distinguishes received conversation from actual confirmation without adopting or resending it',async()=>{
  setupNative();const j=journal(),adapter=new executorModule.NativeAdapter({journal:j,client:{},accounts:{}});await adapter.execute(nativeOperation());
  assert.equal(typeof adapter.progress,'function','missing send progress');
  const binding=j.task('task1'),draft=store.get().taskDrafts.find(d=>d.id===binding.draftId);
  draft.submissionRecord={task:{id:'accepted-local',studioTaskId:'task1',conversationUrl:'https://www.doubao.com/chat/original',submissionUncertain:false,confirmationIntents:{}}};store.save();
  const op={...nativeOperation('send'),payload:{account:{id:'account1',name:'测试'},tasks:[nativeOperation().payload.task]}};
  assert.deepEqual(adapter.progress(op).receipt.tasks,[{taskId:'task1',localTaskId:'accepted-local',conversationId:'https://www.doubao.com/chat/original',status:'submitted',confirmed:false}]);
  draft.submissionRecord.task.confirmationIntents={k:{state:'pending'}};assert.equal(adapter.progress(op).receipt.tasks[0].confirmed,false);
  draft.submissionRecord.task.confirmationIntents.k.state='sent';assert.equal(adapter.progress(op).receipt.tasks[0].confirmed,true);
  assert.equal(store.get().tasks.length,0);queue.stopAll();
});
test('heartbeat progress completes before final receipt even if slow progress response overlaps final browser result',async()=>{
  const j=journal(),api=transport(),controller=new AbortController();let begin,finish,releaseProgress,enteredProgress;
  const started=new Promise(resolve=>begin=resolve),progressEntered=new Promise(resolve=>enteredProgress=resolve),progressGate=new Promise(resolve=>releaseProgress=resolve);
  let claimed=false;api.claim=async()=>({operation:claimed?null:(claimed=true,operation())});
  api.report=async(op,result)=>{if(result.outcome==='progress'){enteredProgress();await progressGate;}api.reports.push(result);};
  const adapter={execute:async()=>{begin();return new Promise(resolve=>finish=resolve);},progress:()=>({outcome:'progress',receipt:{tasks:[{taskId:'task1',status:'submitted',confirmed:false}]}})};
  const b=new StudioBridge({journal:j,api,adapter,pollMs:60000}),running=b.run(controller.signal);await started;
  try {
    const beat=b.heartbeat();
    await Promise.race([progressEntered,new Promise((_,reject)=>setTimeout(()=>reject(new Error('missing progress heartbeat')),300))]);
    finish({outcome:'success',receipt:{tasks:[{taskId:'task1',status:'submitted',confirmed:true}]}});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(api.reports.length,0);releaseProgress();await beat;controller.abort();await running;
    assert.deepEqual(api.reports.map(r=>r.outcome),['progress','success']);
  } finally {releaseProgress();finish({outcome:'uncertain',receipt:{}});controller.abort();await running;}
});


test('wire track progress releases lease fairly and a fresh lease rechecks original task through completion after a lost response',async()=>{
  setupNative();const j=journal(),file=path.join(root,'round-robin.mp4');fs.writeFileSync(file,'0000ftypisom0123456789');
  const instanceId='studio-account-'+crypto.createHash('sha256').update('account1').digest('hex').slice(0,24);
  for(const id of ['task1','task2']) {store.get().tasks.push({id:'local-'+id,studioTaskId:id,instanceId,status:id==='task2'?'succeeded':'running',submittedAt:'original-time',conversationUrl:'https://www.doubao.com/chat/'+id,result:{files:[file],unwatermarked:true}});j.bindTask(id,{accountId:'account1',localTaskId:'local-'+id});}store.save();
  const rows=['task1','task2'].map(id=>({...operation('track','track-'+id),taskId:id,payload:{account:{id:'account1',name:'测试'},task:{id}},state:'queued',leaseToken:null,leaseUntil:null}));
  let lease=0,now=0,lost=false;const receipts=new Map(),uploads=[],claims=[];
  const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
  const fetch=async(rawUrl,opts)=>{
    const url=new URL(rawUrl);assert.equal(opts.headers.authorization,'Bearer private-token');
    if(url.pathname.endsWith('/result')) {
      const row=rows.find(r=>r.id===opts.headers['x-doubao-operation-id']);assert.equal(row.state,'leased');assert.equal(row.leaseToken,opts.headers['x-doubao-lease-token']);assert.equal(url.searchParams.get('taskId'),row.taskId);uploads.push(row.taskId);return response({ok:true});
    }
    const body=JSON.parse(opts.body);assert.equal(body.version,'doubao-workbench/1');assert.equal(body.executorId,'executor1');
    if(body.action==='heartbeat') {now+=15000;for(const item of rows){if(item.state==='leased' && item.leaseUntil<now)item.state='review';}for(const active of body.leases){const row=rows.find(r=>r.id===active.operationId);if(row?.state==='leased'&&row.leaseToken===active.leaseToken)row.leaseUntil=now+120000;}return response({executorId:'executor1',serverTime:now,leases:rows.filter(r=>r.state==='leased').map(r=>({operationId:r.id,leaseUntil:r.leaseUntil}))});}
    if(body.action==='claim') {const row=rows.find(r=>r.state==='queued');if(!row)return response({operation:null});row.state='leased';row.leaseToken='lease-'+(++lease);row.leaseUntil=now+120000;claims.push(row.taskId);return response({serverTime:now,operation:{id:row.id,kind:row.kind,accountId:row.accountId,taskId:row.taskId,payload:row.payload,leaseToken:row.leaseToken,leaseUntil:new Date(row.leaseUntil).toISOString()}});}
    const row=rows.find(r=>r.id===body.operationId),key=row.id+'/'+body.leaseToken;
    if(receipts.has(key)){assert.deepEqual(body,receipts.get(key));return response({ok:true,duplicate:true});}
    assert.equal(row.state,'leased');assert.equal(row.leaseToken,body.leaseToken);receipts.set(key,body);
    if(body.outcome==='progress') {row.state='queued';row.leaseToken=null;row.leaseUntil=null;rows.splice(rows.indexOf(row),1);rows.push(row);if(!lost){lost=true;throw new Error('progress response lost');}}
    else {row.state='done';assert.equal(body.receipt.status,'completed');}
    return response({ok:true});
  };
  const client=new StudioClient({siteUrl:'https://studio.example',executorId:'executor1',token:'private-token',fetch});
  const adapter=new executorModule.NativeAdapter({journal:j,client,accounts:{}}),bridge=new StudioBridge({journal:j,api:client,adapter});
  await bridge.heartbeat();const first=(await client.claim()).operation;await assert.rejects(bridge.processOperation(first),/progress response lost/);
  await bridge.flushReports();assert.equal(j.get(first.id).reported,true);
  await bridge.heartbeat();await bridge.processOperation((await client.claim()).operation);
  assert.deepEqual(uploads,['task2']);
  queue.getTask('local-task1').status='succeeded';store.save();
  const resumedJournal=new Journal(j.file),resumed=new StudioBridge({journal:resumedJournal,api:client,adapter:new executorModule.NativeAdapter({journal:resumedJournal,client,accounts:{}})});now+=150000;
  await resumed.heartbeat();await resumed.processOperation((await client.claim()).operation);
  assert.deepEqual(uploads,['task2','task1']);assert.deepEqual(claims,['task1','task2','task1']);assert.equal(rows.every(r=>r.state==='done'),true);assert.equal(store.get().tasks.length,2);queue.stopAll();
});

test('expired lease after first native send prevents next send and confirmation while retaining accepted original conversation',async()=>{
  const {driver}=setupNative(),j=journal(),adapter=new executorModule.NativeAdapter({journal:j,client:{},accounts:{},maxDraftPages:1});
  const tasks=[];for(let i=0;i<2;i++){const op=nativeOperation();op.payload.task.id='lease-task'+i;await adapter.execute(op);tasks.push(op.payload.task);}
  let now=1000,sends=0,confirmations=0;const call=driver.call;
  driver.call=async(method,opts)=>{if(method==='sendNativeDraft'){sends++;now=1600;}if(method==='peekGenerationConfirmation')return {ok:true,kind:'text',key:'confirmed',text:'按要求生成'};return call(method,opts);};
  driver.setText=async(text)=>{if(text==='按要求生成')confirmations++;return {ok:true};};
  const api=transport();api.heartbeat=async()=>{throw new Error('heartbeat unavailable');};
  const bridge=new StudioBridge({journal:j,api,adapter,now:()=>now});await assert.rejects(bridge.heartbeat(),/unavailable/);
  const sendOp={...operation('send','lease-batch'),leaseUntil:new Date(1500).toISOString(),payload:{account:{id:'account1',name:'测试'},tasks}};bridge.observeLease(sendOp,1000);const result=await bridge.processOperation(sendOp);
  assert.equal(sends,1);assert.equal(confirmations,0);assert.equal(result.receipt.tasks[0].conversationId,'https://www.doubao.com/chat/real1');assert.equal(result.receipt.tasks[0].confirmed,false);assert.equal(store.get().tasks.length,1);queue.stopAll();
});
test('heartbeat renewal uses server time and request start, and failed heartbeat cannot extend lease',async()=>{
  const j=journal(),op={...operation('send'),leaseUntil:new Date(1500).toISOString()};let now=1000;
  const api=transport();api.heartbeat=async()=>{now=1100;return {serverTime:900000,leases:[{operationId:'op1',leaseUntil:900200}]};};
  const bridge=new StudioBridge({journal:j,api,adapter:{},now:()=>now});
  assert.equal(typeof bridge.checkLease,'function','missing lease check');j.begin(op);bridge.observeLease(op,900000,1000,900500);
  await bridge.heartbeat();now=1199;assert.doesNotThrow(()=>bridge.checkLease('op1'));now=1200;assert.throws(()=>bridge.checkLease('op1'),/lease/);
  api.heartbeat=async()=>{throw new Error('offline');};await assert.rejects(bridge.heartbeat(),/offline/);assert.throws(()=>bridge.checkLease('op1'),/lease/);
});
test('409 report quarantines only its retained journal entry and temporary report failures do not starve later entries',async()=>{
  const j=journal(),api=transport();
  for(const id of ['expired','offline','later']){j.begin(operation('track',id));j.finish(id,{outcome:'success',receipt:{status:'completed'}});}
  api.report=async(op)=>{if(op.id!=='later'){const e=new Error('report unavailable');e.status=op.id==='expired'?409:503;throw e;}api.reports.push(op.id);};
  const bridge=new StudioBridge({journal:j,api,adapter:{}});await bridge.flushReports();
  assert.deepEqual(api.reports,['later']);assert.equal(j.get('expired').quarantined,true);assert.equal(j.get('expired').result.receipt.status,'completed');assert.equal(j.get('offline').reported,false);assert.deepEqual(j.pending().map(e=>e.operation.id),['offline']);
});
test('oversized MP4 is retained for review without an upload or indefinite retry',async()=>{
  setupNative();const j=journal(),file=path.join(root,'oversized.mp4');fs.writeFileSync(file,'0000ftypisom');fs.truncateSync(file,128*1024*1024+1);
  const instanceId='studio-account-'+crypto.createHash('sha256').update('account1').digest('hex').slice(0,24);
  store.get().tasks.push({id:'large-local',studioTaskId:'task1',instanceId,status:'succeeded',submittedAt:'original',conversationUrl:'https://www.doubao.com/chat/large',result:{files:[file],unwatermarked:true}});store.save();j.bindTask('task1',{accountId:'account1',localTaskId:'large-local'});
  let uploads=0;const client=new StudioClient({siteUrl:'https://studio.example',executorId:'e',token:'test-token',fetch:async()=>{uploads++;return new Response('{}');}}),adapter=new executorModule.NativeAdapter({journal:j,client,accounts:{}});
  const result=await adapter.execute({...nativeOperation('track'),taskId:'task1'});assert.equal(result.outcome,'uncertain');assert.equal(uploads,0);assert.equal(fs.existsSync(file),true);assert.equal(store.get().tasks.length,1);queue.stopAll();
});

test('fresh read-only track leases recover quarantined progress and failure while preserving old evidence',async()=>{
  for(const outcome of ['progress','failure']) {
    const j=journal(),old={...operation('track','quarantined-'+outcome),leaseToken:'expired-lease'};
    j.begin(old);const prior={outcome,receipt:{taskId:'task1',status:outcome==='progress'?'running':'failed'}};j.finish(old.id,prior);
    const api=transport();api.report=async()=>{const error=new Error('old lease rejected');error.status=409;throw error;};
    const first=new StudioBridge({journal:j,api,adapter:{}});await first.flushReports();assert.equal(j.get(old.id).quarantined,true);
    let reads=0;api.report=async(op,result)=>{assert.equal(op.leaseToken,'fresh-lease');api.reports.push(result);};
    const reopened=new Journal(j.file),fresh=new StudioBridge({journal:reopened,api,adapter:{recover:async()=>{reads++;return {outcome:'failure',receipt:{taskId:'task1',status:'failed'}};}}});
    await fresh.processOperation({...old,leaseToken:'fresh-lease'});
    assert.equal(reads,1);assert.equal(api.reports.length,1);assert.equal(reopened.get(old.id).reported,true);assert.equal(reopened.get(old.id).quarantined,undefined);
    assert.deepEqual(reopened.get(old.id).priorLeases[0].result,prior);
  }
});


test('HTTP non-loopback site requires explicit opt-in and a literal IP assigned to this machine',()=>{
  const config={executorId:'e',token:'private-token',fetch:async()=>new Response('{}'),networkInterfaces:()=>({eth0:[{address:'172.1.254.100',family:'IPv4',internal:false}]})};
  assert.doesNotThrow(()=>new StudioClient({...config,siteUrl:'http://172.1.254.100',allowLocalHttp:true}));
  assert.throws(()=>new StudioClient({...config,siteUrl:'http://172.1.254.100'}),/HTTPS/);
  for(const siteUrl of ['http://172.1.254.101','http://192.168.1.100','http://server.local','http://user:password@172.1.254.100'])assert.throws(()=>new StudioClient({...config,siteUrl,allowLocalHttp:true}));
  assert.doesNotThrow(()=>new StudioClient({...config,siteUrl:'https://studio.example'}));
});

test('interrupted read-only probe recovers as probe, while unknown input recovers as frame without replay',async()=>{
  const adapter=new executorModule.NativeAdapter({journal:journal(),client:{},accounts:{}}),actions=[];
  adapter.login=async op=>{actions.push(op.payload.action);return {};};
  await adapter.recover({...operation('account'),payload:{account:{id:'account1'},action:'probe'}});
  await adapter.recover({...operation('account'),payload:{account:{id:'account1'},action:'input'}});
  assert.deepEqual(actions,['probe','frame']);
});
test('account scrolling is bounded and screenshots include capture time',async()=>{
  setupNative();const commands=[],wc={debugger:{sendCommand:async(method,value)=>commands.push({method,value})},capturePage:async()=>({toJPEG:()=>Buffer.from('jpeg')})};
  const adapter=new executorModule.NativeAdapter({journal:journal(),client:{token:'private-token'},accounts:{open:async()=>({webContents:wc,getContentSize:()=>[1280,900]})},driverFactory:async()=>({isLoggedIn:async()=>({})})});
  const op={...operation('account'),payload:{account:{id:'account1'},action:'input',inputEncrypted:encryptedInput({kind:'scroll',deltaX:0,deltaY:120})}};
  const result=await adapter.execute(op);assert.equal(Number.isFinite(Date.parse(result.receipt.capturedAt)),true);
  assert.deepEqual(commands,[{method:'Input.dispatchMouseEvent',value:{type:'mouseWheel',x:640,y:450,deltaX:0,deltaY:120}}]);
  for(const delta of [4001,1.2,Infinity])await assert.rejects(adapter.execute({...op,payload:{...op.payload,inputEncrypted:encryptedInput({kind:'scroll',deltaX:0,deltaY:delta})}}),/scroll/);
  assert.equal(commands.length,1);queue.stopAll();
});
test('probe returns version and executor generation even when browser proxy navigation fails',async()=>{
  setupNative();const adapter=new executorModule.NativeAdapter({journal:journal(),sessionId:'session-fixture',client:{token:'private-token'},environment:{configure(inst){inst.studioEnvironment={version:'version-fixture'};}},accounts:{open:async()=>{throw Error('synthetic secret');}}});
  const result=await adapter.execute({...operation('account'),payload:{account:{id:'account1'},action:'probe'}});
  assert.equal(result.receipt.environmentVersion,'version-fixture');assert.equal(result.receipt.executorSessionId,'session-fixture');
  assert.equal(result.receipt.environmentCheck.proxy.ok,false);assert.equal(JSON.stringify(result).includes('synthetic secret'),false);queue.stopAll();
});

for(const action of ['open','navigate','frame'])test('failed account '+action+' is a definite page failure, never an unknown generation',async()=>{
 setupNative();const adapter=new executorModule.NativeAdapter({journal:journal(),client:{token:'private-token'},accounts:{open:async()=>{throw Error('https://private:secret@proxy.test:1234 timeout');}}});
 const result=await adapter.execute({...operation('account'),payload:{account:{id:'account1'},action}});
 assert.equal(result.outcome,'failure');assert.equal(JSON.stringify(result).includes('secret'),false);queue.stopAll();
});
test('navigation and screenshot errors fail safely while failed input keeps its unknown protection',async()=>{
 setupNative();const wc={loadURL:async()=>{throw Error('private navigation timeout');},capturePage:async()=>{throw Error('private capture failure');}};
 const adapter=new executorModule.NativeAdapter({journal:journal(),client:{token:'private-token'},accounts:{open:async()=>({webContents:wc,getContentSize:()=>[1280,900]})}});
 for(const action of ['navigate','frame']){const result=await adapter.execute({...operation('account'),payload:{account:{id:'account1'},action}});assert.equal(result.outcome,'failure');assert.equal(JSON.stringify(result).includes('private'),false);}
 const inputAdapter=new executorModule.NativeAdapter({journal:journal(),client:{token:'private-token'},accounts:{open:async()=>{throw Error('input outcome unknown');}}});
 await assert.rejects(inputAdapter.execute({...operation('account'),payload:{account:{id:'account1'},action:'input',inputEncrypted:encryptedInput({kind:'key',key:'Enter'})}}),/input outcome unknown/);queue.stopAll();
});

for(const inspection of ['open failure','capture failure','frame success'])test('started input stays uncertain after recovery '+inspection+' without replay',async()=>{
 setupNative();const j=journal(),api=transport();let inputs=0;
 const wc={debugger:{sendCommand:async()=>{inputs++;}},capturePage:async()=>{if(inspection==='capture failure')throw Error('private capture');return {toJPEG:()=>Buffer.from('jpeg')};}};
 const adapter=new executorModule.NativeAdapter({journal:j,client:{token:'private-token'},accounts:{open:async()=>{if(inspection==='open failure')throw Error('private open');return {webContents:wc,getContentSize:()=>[1280,900]};}},driverFactory:async()=>({isLoggedIn:async()=>({loggedIn:true})})});
 const op={...operation('account'),payload:{account:{id:'account1'},action:'input',inputEncrypted:encryptedInput({kind:'key',key:'Enter'})}};j.begin(op);
 const reopened=new Journal(j.file),bridge=new StudioBridge({journal:reopened,api,adapter});await bridge.processOperation(op);
 assert.equal(inputs,0);assert.equal(api.reports.length,1);assert.equal(api.reports[0].op.payload.action,'input');assert.equal(api.reports[0].result.outcome,'uncertain');assert.equal(reopened.get(op.id).result.outcome,'uncertain');assert.equal(JSON.stringify(api.reports[0].result).includes('private'),false);queue.stopAll();
});
