const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const P=require('../src/paths'),store=require('../src/store'),{NativeAdapter}=require('../src/server-executor');
test('a partial continuation can explicitly dispatch its never-clicked item while all prior intents stay untouched',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-unissued-'));P.init({home:root});store.load();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const account={id:'a',environment:{version:'env'}},tasks=[58,59,60].map(n=>({id:'t'+n,draftId:'d'+n,nativeBinding:{nativeId:'n'+n},prompt:'original '+n,parameters:{model:'seedance_v2.5',duration:30,ratio:'9:16'},references:[]}));
 const original={reported:true,state:'done',operation:{kind:'send',accountId:'a',batchId:'b',payload:{account,sendOnly:true,tasks}},result:{outcome:'uncertain',receipt:{deliveryPause:{taskId:'t58',draftId:'d58',notStartedDraftIds:['d59','d60']}}}};
 const prior={reported:true,state:'done',operation:{kind:'account',accountId:'a',batchId:'b',payload:{action:'continue_unstarted_drafts',originalOperationId:'original',account,sendOnly:true,dispatchOnly:true,tasks:tasks.slice(1)}},result:{outcome:'uncertain',receipt:{dispatchOnly:true,originalOperationId:'original',dispatches:[{taskId:'t59',draftId:'d59',nativeId:'n59',clickedAt:new Date().toISOString(),outcome:'attempted_unconfirmed'}]}}};
 const bindings=Object.fromEntries(tasks.map(x=>[x.id,{accountId:'a',draftId:x.draftId,nativeBinding:x.nativeBinding}]));
 for(const x of tasks)store.get().taskDrafts.push({id:x.draftId,nativeState:'saved',nativeBinding:x.nativeBinding,executionMode:'work',template:{studioTaskId:x.id,prompt:x.prompt,...x.parameters,attachments:[]},...(x.id!=='t60'?{submissionRecord:{task:{submissionUncertain:true}}}:{})});
 const adapter=new NativeAdapter({journal:{get:id=>({original,prior})[id],task:id=>bindings[id]},client:{},accounts:{}});let calls=0;
 adapter.send=async op=>{calls++;assert.deepEqual(op.payload.tasks.map(x=>x.id),['t60']);const d=store.get().taskDrafts.find(x=>x.id==='d60');d.submissionRecord={task:{submissionUncertain:true}};d.dispatchReceipt={taskId:'t60',draftId:'d60',nativeId:'n60',clickedAt:new Date().toISOString(),outcome:'pending'};};
 const op={kind:'account',accountId:'a',batchId:'b',payload:{action:'continue_unstarted_drafts',originalOperationId:'original',previousOperationId:'prior',account,sendOnly:true,dispatchOnly:true,tasks:tasks.slice(2)}};
 const rows=prior.result.receipt.dispatches;prior.result.receipt.dispatches=[];
 await assert.rejects(adapter.continueUnstartedDrafts({...op,payload:{...op.payload,tasks:tasks.slice(1)}}),/already dispatched/);assert.equal(calls,0);prior.result.receipt.dispatches=rows;
 for(const change of [{reported:false},{state:'executing'},{operation:{...prior.operation,accountId:'other'}},{operation:{...prior.operation,batchId:'other'}},{operation:{...prior.operation,payload:{...prior.operation.payload,originalOperationId:'other'}}}]){
  const saved={...prior};Object.assign(prior,change);await assert.rejects(adapter.continueUnstartedDrafts(op),/previous/);assert.equal(calls,0);Object.assign(prior,saved);
 }
 await assert.rejects(adapter.continueUnstartedDrafts({...op,payload:{...op.payload,previousOperationId:'missing'}}),/previous/);assert.equal(calls,0);
 const before=JSON.stringify(store.get().taskDrafts.slice(0,2));assert.equal((await adapter.continueUnstartedDrafts(op)).outcome,'success');assert.equal(calls,1);assert.equal(JSON.stringify(store.get().taskDrafts.slice(0,2)),before);
 assert.equal((await adapter.continueUnstartedDrafts(op,true)).outcome,'success');assert.equal(calls,1);
 await assert.rejects(adapter.continueUnstartedDrafts({...op,payload:{...op.payload,tasks:tasks.slice(1)}}),/suffix/);assert.equal(calls,1);
});
