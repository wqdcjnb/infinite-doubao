"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const P=require('../src/paths'),store=require('../src/store'),queue=require('../src/orchestrator');
const {NativeAdapter}=require('../src/server-executor'),{Journal}=require('../src/studio-bridge');
test('ordinary-account quota rejection cannot stall serial draft delivery or its message receipts',async()=>{
 const runtime=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'studio-send-receipt-'));P.init({home:runtime});store.load();queue.pause('');
 const calls=[],texts=[],catalog=new Map();let confirmations=0,twoAccepted,threeAccepted;const gotTwo=new Promise(r=>twoAccepted=r),gotThree=new Promise(r=>threeAccepted=r);
 const driver={window:{isDestroyed:()=>false},webContents:{isDestroyed:()=>false},isLoggedIn:async()=>({loggedIn:true}),waitForLogin:async()=>({loggedIn:true}),pasteFiles:async()=>({ok:true}),setText:async text=>{texts.push(text);return {ok:true};},send:async()=>{confirmations++;return {ok:true};},setGenerationOptions:async()=>({}),beginTask:async()=>({ok:true,baselineUrls:[],baselineMessageIds:[]}),close:()=>{},
 call:async(method,opts={},options)=>{calls.push({method,id:opts.id});
  if(method==='readNativeDrafts')return {ok:true,source:'indexeddb',accountScope:'original-account-scope',items:[...catalog.values()]};
  if(method==='restoreNativeDrafts'){if(options?.catalog){assert.equal(options.catalog.accountScope,'original-account-scope');assert.ok(opts.every(b=>options.catalog.items.some(i=>i.id===b.id&&i.nativeId===b.nativeId&&i.prompt===b.prompt)));}return {ok:true,bindings:opts};}
  if(method==='saveNativeDraft'){const binding={id:opts.id,nativeId:'native-'+opts.id,accountScope:'original-account-scope',prompt:opts.prompt,executionMode:'work'};catalog.set(opts.id,binding);return {ok:true,bindings:[binding]};}
  if(method==='openNativeDraft')return {ok:true,conversationIds:[]};
  if(method==='waitNativeDraftAccepted'){const n=calls.filter(c=>c.method===method).length;if(n===2)twoAccepted();if(n===3)threeAccepted();return {ok:true,conversationUrl:'https://www.doubao.com/chat/'+opts.id,userMessageId:'user-'+opts.id};}
  if(method==='peekGenerationConfirmation')return {ok:false};
  if(method==='readProgress')return {state:'failed',snippet:'普通账号额度不足',generationStarted:false};
  return {ok:true};}};
 queue.init({resolveDriver:async()=>driver,resolveDraftDriver:async()=>driver});
 const j=new Journal(path.join(runtime,'audit-journal.json')),adapter=new NativeAdapter({journal:j,client:{},accounts:{},environment:{configure(inst){inst.studioEnvironment={version:'env'};}},maxDraftPages:2});
 const tasks=[1,2,3].map(n=>({id:'audit-task-'+n,prompt:'Do not generate a video. Acknowledge test '+n,parameters:{model:'seedance_v2.5',duration:30,ratio:'16:9'},references:[]}));
 const op=(kind,id,payload)=>({id,kind,accountId:'audit-account',...(kind==='send'?{batchId:'batch'}:{}),leaseToken:'audit-lease',leaseUntil:Date.now()+60000,payload:{account:{id:'audit-account',name:'Audit',environment:{version:'env'}},...payload}});
 let sending;
 try{
  for(const t of tasks)await adapter.execute(op('import','import-'+t.id,{task:t}));
  const textCountBeforeSend=texts.length;
  sending=adapter.execute(op('send','send-audit',{tasks,sendOnly:true}));sending.catch(()=>{});
  await Promise.race([gotTwo,new Promise((_,reject)=>setTimeout(()=>reject(new Error('first two receipts did not arrive')),1000))]);
  const allAccepted=await Promise.race([gotThree.then(()=>true),new Promise(r=>setTimeout(()=>r(false),500))]);
  console.log(JSON.stringify({sendClicks:calls.filter(c=>c.method==='sendNativeDraft').length,accepted:calls.filter(c=>c.method==='waitNativeDraftAccepted').length,generationConfirmations:calls.filter(c=>c.method==='send').length,allAccepted}));
  assert.equal(allAccepted,true,'Third draft must not wait for a video generation signal after the first two were accepted');
  const result=await Promise.race([sending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('receipt result did not finish')),2000))]);
  assert.equal(result.outcome,'success');assert.equal(result.receipt.tasks.length,3);assert.ok(result.receipt.tasks.every(t=>t.status==='submitted'&&t.userMessageId));
  assert.equal(confirmations,0);assert.equal(texts.length,textCountBeforeSend);
  console.log(JSON.stringify({durableAcceptedTasks:result.receipt.tasks.length,receiptStatuses:result.receipt.tasks.map(t=>t.status)}));
 }finally{queue.stopAll();if(sending)await sending.catch(()=>{});fs.rmSync(runtime,{recursive:true,force:true});}
});
for(const sendOnly of [true,false])test('Adapter binds visibility to the signed send operation and retains compact captcha interruption diagnostics (sendOnly='+sendOnly+')',async()=>{
 const runtime=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'studio-send-page-'));P.init({home:runtime});store.load();queue.pause('');
 const j=new Journal(path.join(runtime,'journal.json')),adapter=new NativeAdapter({journal:j,client:{},accounts:{},sessionId:'session',environment:{configure(inst){inst.studioEnvironment={version:'env'};}}});
 const task={id:'task',prompt:'Only a receipt',parameters:{model:'seedance_v2.5',duration:30,ratio:'16:9'},references:[]};
 const draft={id:'draft',draftNumber:'DB-FIXTURE',nativeState:'saved',template:{id:'template',studioTaskId:'task',prompt:task.prompt},executionMode:'work'};
 store.get().taskDrafts.push(draft);j.bindTask('task',{accountId:'account',draftId:'draft',templateId:'template'});
 const previous=queue.submitDrafts;
 try {
  queue.submitDrafts=async(ids,options)=>{
   assert.equal(typeof options.onDeliveryPage,'function','Adapter must expose its own send page');assert.deepEqual(ids,['draft']);
   const driver={window:{isDestroyed:()=>false},webContents:{isDestroyed:()=>false},call:async()=>({captchaDetected:true})};
   const handle=options.onDeliveryPage({draft,driver,cancel:()=>{}});
   const target={accountId:'account',operationId:'send',batchId:'batch',environmentVersion:'env',executorSessionId:'session'};
   assert.equal(adapter.deliveryPages.borrow(target).driver,driver);assert.equal((await handle.snapshot()).taskId,'task');handle.close();
   options.onDeliveryPause({reason:'captcha_wait_ended',taskId:'task',draftId:'draft',notStartedDraftIds:[]});throw Error('captcha paused');
  };
  const result=await adapter.execute({id:'send',kind:'send',accountId:'account',batchId:'batch',leaseToken:'lease',leaseUntil:Date.now()+60000,payload:{account:{id:'account',name:'account',environment:{version:'env'}},tasks:[task],sendOnly}});
  assert.equal(result.outcome,'uncertain');assert.ok(result.receipt.deliveryPause,'structured captcha interruption is missing');assert.equal(result.receipt.deliveryPause.reason,'captcha_wait_ended');assert.equal(adapter.deliveryPages.pages.size,0);
 } finally {queue.submitDrafts=previous;queue.stopAll();assert.equal(path.dirname(runtime),require('node:os').tmpdir());assert.match(path.basename(runtime),/^studio-send-page-/);fs.rmSync(runtime,{recursive:true,force:true});}
});
