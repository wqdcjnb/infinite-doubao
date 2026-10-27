const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const P=require('../src/paths'),store=require('../src/store'),{NativeAdapter}=require('../src/server-executor');
test('continuation and recovery exclude the unknown draft and never replay a clicked suffix',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-only-'));P.init({home:root});store.load();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const account={id:'a',environment:{version:'env'}},base={prompt:'original draft',parameters:{model:'seedance_v2.5',duration:30,ratio:'9:16'},references:[]};
 const tasks=[58,59,60].map(n=>({...base,id:'t'+n,draftId:'d'+n,nativeBinding:{nativeId:'n'+n}}));
 const original={reported:true,state:'done',operation:{kind:'send',accountId:'a',batchId:'b',payload:{account,sendOnly:true,tasks}},result:{outcome:'uncertain',receipt:{deliveryPause:{taskId:'t58',draftId:'d58',notStartedDraftIds:['d59','d60']}}}};
 const binding=Object.fromEntries(tasks.map(t=>[t.id,{accountId:'a',draftId:t.draftId,nativeBinding:t.nativeBinding}]));
 const adapter=new NativeAdapter({journal:{get:()=>original,task:id=>binding[id]},client:{},accounts:{}});let calls=0;
 for(const task of tasks)store.get().taskDrafts.push({id:task.draftId,nativeState:'saved',nativeBinding:task.nativeBinding,executionMode:'work',template:{studioTaskId:task.id,prompt:task.prompt,...task.parameters,attachments:[]},...(task.id==='t58'?{submissionRecord:{task:{submissionUncertain:true}}}:{})});
 adapter.send=async op=>{calls++;assert.deepEqual(op.payload.tasks.map(t=>t.id),['t59','t60']);for(const task of op.payload.tasks){const d=store.get().taskDrafts.find(d=>d.id===task.draftId);d.submissionRecord={task:{submissionUncertain:true}};d.dispatchReceipt={taskId:task.id,draftId:task.draftId,nativeId:task.nativeBinding.nativeId,clickedAt:new Date().toISOString(),outcome:'quota_limited',conversationUrl:'https://www.doubao.com/chat/'+task.id};}};
 const op={kind:'account',accountId:'a',batchId:'b',payload:{account,sendOnly:true,dispatchOnly:true,originalOperationId:'original',tasks:tasks.slice(1)}};
 const before=JSON.stringify(store.get().taskDrafts[0]);const result=await adapter.continueUnstartedDrafts(op);assert.equal(result.outcome,'success');assert.equal(result.receipt.dispatches.length,2);assert.equal(JSON.stringify(store.get().taskDrafts[0]),before);
 assert.equal((await adapter.continueUnstartedDrafts(op,true)).outcome,'success');assert.equal(calls,1);await assert.rejects(adapter.continueUnstartedDrafts(op),/already dispatched/);assert.equal(calls,1);
 const pending=store.get().taskDrafts.find(d=>d.id==='d60');pending.dispatchReceipt={...pending.dispatchReceipt,outcome:'pending'};delete pending.dispatchReceipt.conversationUrl;
 const recovered=await adapter.continueUnstartedDrafts(op,true);assert.equal(recovered.outcome,'success');assert.equal(recovered.receipt.dispatches[1].outcome,'attempted_unconfirmed');assert.equal(calls,1);
 await assert.rejects(adapter.continueUnstartedDrafts({...op,payload:{...op.payload,tasks}}),/suffix/);
});
