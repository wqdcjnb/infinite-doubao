"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const P=require('../src/paths'),store=require('../src/store'),queue=require('../src/orchestrator');
const {NativeAdapter}=require('../src/server-executor');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const identity=(prefix,id)=>prefix+hash(id).slice(0,24);
const snapshotHash=value=>hash(JSON.stringify(value,(key,item)=>['draftId','nativeBinding','downloadUrl'].includes(key)?undefined:item));
const unknown=new Set([13,20,21,22]);

function fixture(t,{importTransportNulls=false,total=100,initialSent=22,referenceCount=5}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-real-unstarted-'));P.init({home:root});store.load();
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^studio-real-unstarted-/);fs.rmSync(root,{recursive:true,force:true});});
  t.mock.method(store,'save',()=>true);
  const account={id:'account',environment:{version:'environment'}},instanceId=identity('studio-account-',account.id);
  store.get().instances.push({id:instanceId,name:'offline',studioEnvironment:{version:'environment'}});
  const bindings={},operations={},tasks=[],calls=[];
  for(let n=1;n<=total;n++) {
    const id='task-'+String(n).padStart(3,'0'),draftId=identity('',account.id+'/'+id),templateId=identity('studio-template-',id);
    const references=Array.from({length:referenceCount},(_,i)=>({id:'image-'+i,filename:'source-'+i+'.png',contentType:'image/png',byteSize:100+i,sha256:hash('image-'+i)}));
    const task={id,userId:'user',userName:'Offline',projectId:'project',modelId:'model',prompt:'Original prompt '+id,parameters:{model:'seedance_v2.5',duration:30,ratio:'16:9'},references,draftId,nativeBinding:{id:draftId,nativeId:'native-'+id,accountScope:'account-scope'}};
    tasks.push(task);bindings[id]={accountId:account.id,draftId,templateId,snapshotHash:snapshotHash(task),nativeBinding:clone(task.nativeBinding)};
    if(importTransportNulls) {
      const {draftId:transportDraft,nativeBinding:transportBinding,...content}=task;
      const imported={...clone(content),draftId:null,nativeBinding:null,localTaskId:null,conversationId:null};
      bindings[id].snapshotHash=hash(JSON.stringify(imported));
      operations['import-'+id]={state:'done',reported:true,operation:{id:'import-'+id,kind:'import',accountId:account.id,taskId:id,payload:{account,task:imported}},result:{outcome:'success',receipt:{draftId,nativeBinding:clone(task.nativeBinding)}}};
    }
    const attachments=references.map((ref,i)=>({id:ref.id,name:ref.filename,mime:ref.contentType,size:ref.byteSize,path:path.join(root,'attachments',draftId,i+'-'+ref.sha256+'.png')}));
    const draft={id:draftId,draftNumber:'DB-'+draftId.toUpperCase(),instanceId,nativeState:'saved',nativeBinding:clone(task.nativeBinding),nativePrompt:'【草稿编号：DB-'+draftId.toUpperCase()+'】\n'+task.prompt,executionMode:'work',studioSendOnly:false,template:{id:templateId,studioTaskId:id,prompt:task.prompt,...task.parameters,attachments}};
    if(n<=initialSent) {
      const local={id:'local-'+id,studioTaskId:id,templateId,instanceId,studioSendOnly:false,submittedAt:'2026-10-27T10:00:00.000Z',sentAt:'2026-10-27T10:00:00.000Z',confirmationIntents:{},status:'submitted',refs:attachments.map(a=>a.path),submissionUncertain:unknown.has(n)};
      if(unknown.has(n))draft.submissionRecord={task:local};
      else {Object.assign(local,{conversationUrl:'https://www.doubao.com/chat/'+id,conversationLocked:true,receiptUserMessageId:'message-'+id});store.get().tasks.push(local);bindings[id].localTaskId=local.id;}
    }
    if(n>initialSent||unknown.has(n))store.get().taskDrafts.push(draft);
  }
  operations.original={state:'done',reported:true,operation:{id:'original',kind:'send',accountId:account.id,batchId:'batch',payload:{account,sendOnly:false,dispatchOnly:false,tasks:clone(tasks)}},result:{outcome:'uncertain',receipt:{tasks:tasks.map((task,i)=>i<initialSent&&!unknown.has(i+1)?{taskId:task.id,status:'submitted',localTaskId:'local-'+task.id,conversationId:'https://www.doubao.com/chat/'+task.id,userMessageId:'message-'+task.id,confirmed:false}:{taskId:task.id,status:'uncertain'})}}};
  const journal={data:{operations,tasks:bindings},get:id=>operations[id],task:id=>bindings[id],bindTask:()=>assert.fail('read-only inspection must not rebind tasks')};
  const adapter=new NativeAdapter({journal,client:{},accounts:{open:()=>assert.fail('offline test cannot open an account')},sessionId:'executor-session'});
  const inspection={id:'inspection',kind:'account',accountId:account.id,batchId:'batch',payload:{account,action:'inspect_unstarted_drafts',originalOperationId:'original'}};
  const continuation={id:'continuation',kind:'account',accountId:account.id,batchId:'batch',payload:{account,action:'continue_unstarted_drafts',originalOperationId:'original',inspectionOperationId:'inspection',readOnlyInspection:true,sendOnly:false,dispatchOnly:false,tasks:clone(tasks.slice(initialSent))}};
  const f={root,account,instanceId,tasks,bindings,operations,journal,adapter,inspection,continuation,calls,
    draft:n=>store.get().taskDrafts.find(d=>d.id===tasks[n-1].draftId),local:n=>store.get().tasks.find(item=>item.studioTaskId===tasks[n-1].id),
    freeze:()=>JSON.stringify({store:store.get(),journal:journal.data}),
    async inspect() {assert.equal(typeof adapter.inspectUnstartedDrafts,'function','read-only real batch inspector is missing');return adapter.execute(inspection,{checkLease:()=>{}});},
    async prove() {const result=await this.inspect();operations.inspection={state:'done',reported:true,operation:clone(inspection),result:clone(result)};return result;},
    accept(snapshot,{proof=true}={}) {
      const draft=this.draft(Number(snapshot.id.slice(-3))),clickedAt='2026-10-27T11:00:00.000Z';
      const local={id:'local-'+snapshot.id,studioTaskId:snapshot.id,templateId:draft.template.id,instanceId,studioSendOnly:false,status:'submitted',submittedAt:clickedAt,sentAt:clickedAt,confirmationIntents:{},submissionUncertain:false,conversationLocked:true,conversationUrl:'https://www.doubao.com/chat/'+snapshot.id,receiptUserMessageId:'message-'+snapshot.id,refs:draft.template.attachments.map(a=>a.path),
        dispatchReceipt:{taskId:snapshot.id,draftId:draft.id,nativeId:snapshot.nativeBinding.nativeId,clickedAt,outcome:'message_accepted',conversationUrl:'https://www.doubao.com/chat/'+snapshot.id}};
      if(proof){local.attachmentSendProof={version:1,names:draft.template.attachments.map(a=>path.basename(a.path)),referenceCount:5,fileKeySha256s:Array.from({length:5},(_,i)=>hash('current-key-'+i)),clickedAt};local.attachmentConsumptionProof={version:1,names:local.attachmentSendProof.names.slice(),userMessageId:local.receiptUserMessageId,checkedAt:clickedAt};}
      store.get().tasks.push(local);store.get().taskDrafts=store.get().taskDrafts.filter(d=>d!==draft);return local;
    },
    pending(snapshot,{quota=false}={}) {
      const draft=this.draft(Number(snapshot.id.slice(-3))),clickedAt='2026-10-27T11:00:00.000Z';
      const dispatchReceipt={taskId:snapshot.id,draftId:draft.id,nativeId:snapshot.nativeBinding.nativeId,clickedAt,outcome:quota?'quota_limited':'pending',...(quota?{conversationUrl:'https://www.doubao.com/chat/'+snapshot.id,providerMessage:'近7天免费额度已用完，可以联系 private@example.invalid https://private.invalid/?token=secret'}:{})};
      draft.submissionRecord={task:{id:'local-'+snapshot.id,studioTaskId:snapshot.id,templateId:draft.template.id,instanceId,studioSendOnly:false,status:'submitted',submittedAt:clickedAt,sentAt:clickedAt,confirmationIntents:{},submissionUncertain:true,refs:draft.template.attachments.map(a=>a.path),dispatchReceipt,
        attachmentSendProof:{version:1,names:draft.template.attachments.map(a=>path.basename(a.path)),referenceCount:5,fileKeySha256s:Array.from({length:5},(_,i)=>hash('current-key-'+i)),clickedAt}}};
      draft.dispatchReceipt=dispatchReceipt;return draft.submissionRecord.task;
    },
    dispatch(run) {t.mock.method(queue,'submitDrafts',async(ids,options)=>{calls.push({ids,options});if(run)return run(ids,options);for(const snapshot of continuation.payload.tasks)this.accept(snapshot);});}
  };
  return f;
}

test('real original inspection is strictly read-only and identifies the exact 78-item never-started suffix',async t=>{
  const f=fixture(t),before=f.freeze(),result=await f.inspect();
  assert.equal(result.outcome,'success');assert.equal(result.receipt.status,'unstarted_draft_inspection');assert.equal(result.receipt.readOnly,true);
  assert.equal(result.receipt.originalOperationId,'original');assert.equal(result.receipt.environmentVersion,'environment');assert.equal(result.receipt.executorSessionId,'executor-session');assert.ok(Number.isFinite(result.receipt.inspectedAt));assert.equal(result.receipt.generationIntentCount,0);
  assert.equal(result.receipt.entries.length,100);assert.equal(result.receipt.entries.filter(e=>e.status==='submitted').length,18);assert.equal(result.receipt.entries.filter(e=>e.status==='uncertain').length,4);
  assert.deepEqual(result.receipt.entries.filter(e=>e.status==='not_started').map(e=>e.taskId),f.tasks.slice(22).map(task=>task.id));
  for(const n of unknown)assert.equal(result.receipt.entries[n-1].status,'uncertain');
  for(const entry of result.receipt.entries.filter(e=>e.status==='submitted')){assert.ok(entry.localTaskId&&entry.conversationId&&entry.userMessageId);assert.equal(f.local(Number(entry.taskId.slice(-3))).attachmentSendProof,undefined);}
  assert.equal(f.freeze(),before);assert.equal(f.calls.length,0);
});

test('a new 50-task original retains complete snapshot and proof checks before its 28-item continuation',async t=>{
  const f=fixture(t,{total:50}),before=f.freeze(),result=await f.prove();
  assert.equal(result.receipt.entries.length,50);assert.equal(result.receipt.entries.filter(entry=>entry.status==='not_started').length,28);assert.equal(f.freeze().includes('task-051'),false);
  f.dispatch();const sent=await f.adapter.execute(f.continuation,{checkLease:()=>{}});assert.equal(sent.outcome,'success');assert.equal(sent.receipt.tasks.length,28);
  assert.equal(JSON.stringify(f.operations.original),JSON.stringify(JSON.parse(before).journal.operations.original));
});

test('a 50-task no-reference inspection preserves nine sent anchors and proves exactly 41 never-started originals',async t=>{
  const f=fixture(t,{total:50,initialSent:9,referenceCount:0,importTransportNulls:true}),before=f.freeze(),result=await f.inspect();
  assert.equal(result.outcome,'success');assert.equal(result.receipt.generationIntentCount,0);
  assert.deepEqual(result.receipt.entries.filter(row=>row.status==='submitted').map(row=>row.taskId),f.tasks.slice(0,9).map(task=>task.id));
  assert.deepEqual(result.receipt.entries.filter(row=>row.status==='not_started').map(row=>row.taskId),f.tasks.slice(9).map(task=>task.id));
  assert.equal(f.freeze(),before);assert.equal(f.calls.length,0);
});

test('a no-reference continuation sends only the 41 proved drafts and recovery never dispatches the nine old messages again',async t=>{
  const f=fixture(t,{total:50,initialSent:9,referenceCount:0});await f.prove();
  const sentBefore=JSON.stringify(store.get().tasks),originalBefore=JSON.stringify(f.operations.original);
  f.dispatch((ids,options)=>{
    assert.deepEqual(ids,f.tasks.slice(9).map(task=>task.draftId));assert.equal(options.startQueue,false);assert.equal(options.sendOnly,true);assert.equal(options.dispatchOnly,false);
    for(const snapshot of f.continuation.payload.tasks)f.accept(snapshot,{proof:false});
  });
  const result=await f.adapter.execute(f.continuation,{checkLease:()=>{}});
  assert.equal(result.outcome,'success');assert.equal(result.receipt.tasks.length,41);assert.equal(result.receipt.processedComplete,true);
  assert.ok(result.receipt.tasks.every(row=>row.status==='submitted'&&row.userMessageId&&row.confirmed===false));
  assert.equal(JSON.stringify(store.get().tasks.slice(0,9)),sentBefore);assert.equal(JSON.stringify(f.operations.original),originalBefore);
  const after=f.freeze();assert.deepEqual(await f.adapter.recover(f.continuation,{checkLease:()=>{}}),result);
  assert.equal(f.calls.length,1);assert.equal(f.freeze(),after);
});

test('an uncertain no-reference tenth message is excluded from the proved 40-item suffix',async t=>{
  const f=fixture(t,{total:50,initialSent:9,referenceCount:0});f.pending(f.tasks[9]);
  f.continuation.payload.tasks=clone(f.tasks.slice(10));const result=await f.prove();
  assert.equal(result.receipt.entries[9].status,'uncertain');assert.equal(result.receipt.entries.filter(row=>row.status==='not_started').length,40);
  f.dispatch(()=>{for(const snapshot of f.continuation.payload.tasks)f.accept(snapshot,{proof:false});});
  assert.equal((await f.adapter.execute(f.continuation,{checkLease:()=>{}})).outcome,'success');
  assert.deepEqual(f.calls[0].ids,f.tasks.slice(10).map(task=>task.draftId));
});

test('no-reference recovery rejects changed snapshots, extra attachments, stale proofs and legacy 100-task no-reference batches',async t=>{
  for(const change of [f=>{f.operations.original.operation.payload.tasks[49].prompt+=' changed';},f=>{f.draft(50).template.attachments.push({id:'unexpected'});},f=>{f.draft(50).nativeBinding.nativeId='other';}]) {
    const f=fixture(t,{total:50,initialSent:9,referenceCount:0});change(f);const before=f.freeze();
    await assert.rejects(f.inspect(),/snapshot|draft|binding/);assert.equal(f.freeze(),before);assert.equal(f.calls.length,0);
  }
  const stale=fixture(t,{total:50,initialSent:9,referenceCount:0});await stale.prove();stale.operations.inspection.result.receipt.inspectedAt-=61000;stale.dispatch();
  await assert.rejects(stale.adapter.execute(stale.continuation,{checkLease:()=>{}}),/expired/);assert.equal(stale.calls.length,0);
  const legacy=fixture(t,{total:100,initialSent:9,referenceCount:0});await assert.rejects(legacy.inspect(),/snapshot/);assert.equal(legacy.calls.length,0);
});

test('current wire imports with four null transport fields retain full immutable snapshot verification',async t=>{
  const f=fixture(t,{importTransportNulls:true}),imported=f.operations['import-task-100'].operation.payload.task;
  for(const key of ['draftId','nativeBinding','localTaskId','conversationId']){assert.equal(Object.hasOwn(imported,key),true);assert.equal(imported[key],null);}
  assert.equal(f.bindings['task-100'].snapshotHash,hash(JSON.stringify(imported)));
  const before=f.freeze(),result=await f.inspect();assert.equal(result.outcome,'success');assert.equal(result.receipt.entries.filter(entry=>entry.status==='not_started').length,78);assert.equal(f.freeze(),before);
  for(const change of [snapshot=>{snapshot.prompt+=' changed';},snapshot=>{snapshot.parameters.duration=15;},snapshot=>{snapshot.references.reverse();},snapshot=>{snapshot.references[4].sha256='f'.repeat(64);}]) {
    const current=fixture(t,{importTransportNulls:true});change(current.operations.original.operation.payload.tasks[99]);const frozen=current.freeze();
    await assert.rejects(current.inspect(),/snapshot/);assert.equal(current.freeze(),frozen);assert.equal(current.calls.length,0);
  }
});

test('inspection rejects changed provenance, incomplete snapshots, any generation intent, or a non-suffix gap',async t=>{
  const changes=[
    f=>{f.operations.original.reported=false;},f=>{f.operations.original.state='started';},f=>{f.operations.original.result.outcome='success';},f=>{f.operations.original.operation.payload.sendOnly=true;},f=>{f.operations.original.operation.payload.dispatchOnly=true;},
    f=>{f.operations.original.operation.accountId='other';},f=>{f.inspection.payload.account.environment.version='changed';},f=>{f.operations.original.operation.payload.tasks.pop();},
    f=>{f.operations.original.operation.payload.tasks[99].prompt='changed';},f=>{const id=f.tasks[0].nativeBinding.nativeId;f.operations.original.operation.payload.tasks[99].nativeBinding.nativeId=id;f.bindings[f.tasks[99].id].nativeBinding.nativeId=id;f.draft(100).nativeBinding.nativeId=id;},f=>{f.draft(100).template.attachments.reverse();},f=>{f.draft(100).template.attachments[4].path=path.join(f.root,'wrong.png');},
    f=>{f.local(1).confirmationIntents={confirm:{state:'pending'}};},f=>{f.draft(13).submissionRecord.task.confirmationIntents={confirm:{state:'sent'}};},f=>{f.local(1).generationObservedAt='time';},
    f=>{const local=f.local(19);store.get().tasks=store.get().tasks.filter(task=>task!==local);delete f.bindings[local.studioTaskId].localTaskId;delete f.operations.original.result.receipt.tasks[18].localTaskId;delete f.operations.original.result.receipt.tasks[18].conversationId;delete f.operations.original.result.receipt.tasks[18].userMessageId;f.operations.original.result.receipt.tasks[18].status='uncertain';const from=f.draft(23);store.get().taskDrafts.push({...clone(from),id:f.tasks[18].draftId,instanceId:f.instanceId,nativeBinding:clone(f.tasks[18].nativeBinding),draftNumber:'DB-'+f.tasks[18].draftId.toUpperCase(),template:{...clone(from.template),id:f.bindings[f.tasks[18].id].templateId,studioTaskId:f.tasks[18].id,prompt:f.tasks[18].prompt,attachments:f.tasks[18].references.map((ref,i)=>({id:ref.id,name:ref.filename,mime:ref.contentType,size:ref.byteSize,path:path.join(f.root,i+'-'+ref.sha256+'.png')}))}});}
  ];
  for(const change of changes){const f=fixture(t);change(f);const before=f.freeze();await assert.rejects(f.inspect(),/original|environment|snapshot|binding|attachment|generation|intent|suffix|draft/i);assert.equal(f.freeze(),before);assert.equal(f.calls.length,0);}
});

test('a missing user-message anchor stays uncertain and cannot be mistaken for an unstarted draft',async t=>{
  const f=fixture(t);delete f.local(19).receiptUserMessageId;
  const result=await f.inspect();assert.equal(result.receipt.entries[18].status,'uncertain');assert.equal(result.receipt.entries.filter(e=>e.status==='not_started').length,78);
});

test('real continuation uses the proved 78 saved drafts and only defers generation while requiring new image proof',async t=>{
  const f=fixture(t);await f.prove();const originalBefore=JSON.stringify(f.operations.original),oldBefore=JSON.stringify(store.get().tasks),unknownBefore=JSON.stringify([...unknown].map(n=>f.draft(n)));
  f.dispatch((ids,options)=>{
    assert.deepEqual(ids,f.tasks.slice(22).map(task=>task.draftId));assert.equal(options.startQueue,false);assert.equal(options.sendOnly,true);assert.equal(options.dispatchOnly,false);assert.equal(options.continueOnFailure,true);
    for(const snapshot of f.continuation.payload.tasks)f.accept(snapshot);
    f.operations.inspection.result.receipt.inspectedAt-=61000;
  });
  const result=await f.adapter.execute(f.continuation,{checkLease:()=>{}});
  assert.equal(result.outcome,'success');assert.equal(result.receipt.status,'draft_dispatch_complete');assert.equal(result.receipt.dispatchOnly,false);assert.equal(result.receipt.originalOperationId,'original');
  assert.equal(result.receipt.tasks.length,78);assert.equal(result.receipt.dispatches.length,78);assert.ok(result.receipt.tasks.every(item=>item.status==='submitted'&&item.localTaskId&&item.conversationId&&item.userMessageId&&item.confirmed===false));
  assert.equal(f.calls.length,1);assert.equal(JSON.stringify(f.operations.original),originalBefore);assert.equal(JSON.stringify(store.get().tasks.slice(0,18)),oldBefore);assert.equal(JSON.stringify([...unknown].map(n=>f.draft(n))),unknownBefore);
  const after=f.freeze();assert.equal((await f.adapter.recover(f.continuation,{checkLease:()=>{}})).outcome,'success');assert.equal(f.calls.length,1);assert.equal(f.freeze(),after);
});

test('proof freshness, current executor identity, full proof entries and exact suffix are checked before the first queue call',async t=>{
  const changes=[
    f=>{delete f.continuation.payload.inspectionOperationId;},f=>{f.continuation.payload.readOnlyInspection=false;},f=>{f.continuation.payload.dispatchOnly=true;},
    f=>{f.operations.inspection.reported=false;},f=>{f.operations.inspection.state='started';},f=>{f.operations.inspection.result.outcome='uncertain';},
    f=>{f.operations.inspection.operation.accountId='other';},f=>{f.operations.inspection.operation.payload.action='other';},f=>{f.operations.inspection.result.receipt.readOnly=false;},
    f=>{f.operations.inspection.result.receipt.executorSessionId='old-session';},f=>{f.operations.inspection.result.receipt.inspectedAt=Date.now()-60001;},f=>{f.operations.inspection.result.receipt.generationIntentCount=1;},
    f=>{f.operations.inspection.result.receipt.entries.pop();},f=>{f.continuation.payload.tasks=f.tasks.slice(23);},f=>{f.continuation.payload.tasks=[f.tasks[21],...f.tasks.slice(22)];},f=>{f.continuation.payload.tasks.reverse();}
  ];
  for(const change of changes){const f=fixture(t);await f.prove();change(f);f.dispatch();const before=f.freeze();await assert.rejects(f.adapter.execute(f.continuation,{checkLease:()=>{}}),/inspection|proof|suffix|original|real/i);assert.equal(f.calls.length,0);assert.equal(f.freeze(),before);}
});

test('the entire suffix is rechecked before dispatch, including its last draft and any newly recorded submission intent',async t=>{
  for(const change of [f=>{f.draft(100).template.prompt='changed';},f=>{f.draft(100).template.attachments[4].id='wrong';},f=>{f.draft(100).submissionRecord={task:{id:'new-intent',studioTaskId:f.tasks[99].id,templateId:f.bindings[f.tasks[99].id].templateId,instanceId:f.instanceId,submissionUncertain:true}};}]) {
    const f=fixture(t);await f.prove();change(f);f.dispatch();const before=f.freeze();await assert.rejects(f.adapter.execute(f.continuation,{checkLease:()=>{}}),/draft|inspection|proof|suffix|attachment/i);assert.equal(f.calls.length,0);assert.equal(f.freeze(),before);
  }
});

test('a quota response or new three-anchor receipt without valid attachment proof never completes real continuation',async t=>{
  for(const change of [task=>{delete task.attachmentSendProof;},task=>{task.attachmentSendProof.names.reverse();},task=>{task.attachmentSendProof.fileKeySha256s.pop();},task=>{task.refs.reverse();},task=>{task.dispatchReceipt.outcome='quota_limited';},task=>{delete task.receiptUserMessageId;}]) {
    const f=fixture(t);await f.prove();f.dispatch(()=>{for(const snapshot of f.continuation.payload.tasks)f.accept(snapshot);change(f.local(100));});
    const result=await f.adapter.execute(f.continuation,{checkLease:()=>{}});assert.equal(result.outcome,'uncertain');assert.equal(result.receipt.status,'draft_dispatch_partial');assert.equal(result.receipt.dispatchOnly,false);assert.equal(result.receipt.tasks[77].status,'uncertain');assert.equal(f.calls.length,1);
    const frozen=f.freeze(),recovered=await f.adapter.recover(f.continuation,{checkLease:()=>{}});assert.equal(recovered.outcome,'uncertain');assert.equal(f.calls.length,1);assert.equal(f.freeze(),frozen);
  }
});

test('recovery before any new dispatch is read-only and expired lease prevents a fresh continuation',async t=>{
  const f=fixture(t);await f.prove();f.dispatch();const before=f.freeze();
  assert.equal((await f.adapter.recover(f.continuation,{checkLease:()=>{}})).outcome,'uncertain');assert.equal(f.calls.length,0);assert.equal(f.freeze(),before);
  await assert.rejects(f.adapter.execute(f.continuation,{checkLease:()=>{throw Error('fixture lease expired');}}),/expired/);assert.equal(f.calls.length,0);assert.equal(f.freeze(),before);
});

test('a middle draft failing before its first click produces a durable read-only partial receipt without opening a replay path',async t=>{
  const f=fixture(t);await f.prove();const beforeDraft=JSON.stringify(f.draft(50)),unknownBefore=JSON.stringify([...unknown].map(n=>f.draft(n)));
  f.dispatch(()=>{for(const snapshot of f.continuation.payload.tasks)if(snapshot.id!==f.tasks[49].id)f.accept(snapshot);});
  const result=await f.adapter.execute(f.continuation,{checkLease:()=>{}});
  assert.equal(result.outcome,'uncertain');assert.equal(result.receipt.status,'draft_dispatch_partial');assert.equal(result.receipt.dispatchOnly,false);
  assert.equal(result.receipt.tasks.length,78);assert.equal(result.receipt.tasks.filter(task=>task.status==='submitted').length,77);assert.equal(result.receipt.tasks.find(task=>task.taskId===f.tasks[49].id).status,'not_attempted');
  assert.equal(result.receipt.dispatches.length,77);assert.equal(result.receipt.dispatches.some(row=>row.taskId===f.tasks[49].id),false);assert.equal(f.calls.length,1);
  assert.equal(JSON.stringify(f.draft(50)),beforeDraft);assert.equal(JSON.stringify([...unknown].map(n=>f.draft(n))),unknownBefore);
  const before=f.freeze(),recovered=await f.adapter.recover(f.continuation,{checkLease:()=>{}});
  assert.deepEqual(recovered,result);assert.equal(f.calls.length,1);assert.equal(f.freeze(),before);
  await assert.rejects(f.inspect(),/suffix/);
  await assert.rejects(f.adapter.execute(f.continuation,{checkLease:()=>{}}),/suffix/);assert.equal(f.calls.length,1);assert.equal(f.freeze(),before);
});

test('real continuation distinguishes accepted, unknown, quota-skipped and never-attempted drafts without promoting quota',async t=>{
  const f=fixture(t);await f.prove();const oldUnknown=JSON.stringify([...unknown].map(n=>f.draft(n)));
  f.dispatch(()=>{for(const snapshot of f.continuation.payload.tasks){const n=Number(snapshot.id.slice(-3));if(n===23)f.pending(snapshot,{quota:true});else if(n===24)f.pending(snapshot);else if(n!==25)f.accept(snapshot);}});
  const result=await f.adapter.execute(f.continuation,{checkLease:()=>{}});
  assert.equal(result.outcome,'uncertain');assert.equal(result.receipt.status,'draft_dispatch_partial');assert.equal(result.receipt.processedComplete,false);
  assert.deepEqual(result.receipt.summary,{expected:78,attempted:77,submitted:75,unknown:1,quotaSkipped:1,notAttempted:1});
  const row=result.receipt.tasks[0],snapshot=f.tasks[22];
  assert.deepEqual(row,{taskId:snapshot.id,status:'quota_limited',draftId:snapshot.draftId,nativeId:snapshot.nativeBinding.nativeId,conversationId:'https://www.doubao.com/chat/'+snapshot.id,providerMessage:'近7天免费额度已用完',confirmed:false});
  assert.equal(result.receipt.tasks[1].status,'uncertain');assert.equal(result.receipt.tasks[2].status,'not_attempted');
  assert.equal(result.receipt.dispatches[0].providerMessage,'近7天免费额度已用完');assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(JSON.stringify(result).includes('secret'),false);
  assert.equal(JSON.stringify([...unknown].map(n=>f.draft(n))),oldUnknown);
  const before=f.freeze();assert.deepEqual(await f.adapter.recover(f.continuation,{checkLease:()=>{}}),result);assert.equal(f.calls.length,1);assert.equal(f.freeze(),before);
});

test('only the 48-item strict suffix after a closed partial continuation can resume and all quota is processed but never successful',async t=>{
  const f=fixture(t);await f.prove();
  for(const snapshot of f.tasks.slice(22,52)){if(['task-023','task-052'].includes(snapshot.id))f.pending(snapshot);else f.accept(snapshot);}
  const prior=clone(f.continuation);prior.id='previous';f.operations.previous={state:'done',reported:true,operation:prior,result:f.adapter.realContinuationReceipt(prior)};
  const inspection={...clone(f.inspection),id:'inspection-48'},result=await f.adapter.execute(inspection,{checkLease:()=>{}});
  assert.equal(result.receipt.entries.filter(e=>e.status==='submitted').length,46);assert.equal(result.receipt.entries.filter(e=>e.status==='uncertain').length,6);assert.equal(result.receipt.entries.filter(e=>e.status==='not_started').length,48);
  f.operations['inspection-48']={state:'done',reported:true,operation:inspection,result};
  const next={...clone(f.continuation),id:'next',payload:{...clone(f.continuation.payload),previousOperationId:'previous',inspectionOperationId:'inspection-48',tasks:clone(f.tasks.slice(52))}};
  f.dispatch(()=>{for(const snapshot of next.payload.tasks)f.pending(snapshot,{quota:true});});
  const withoutPrevious=clone(next);delete withoutPrevious.payload.previousOperationId;
  await assert.rejects(f.adapter.execute(withoutPrevious,{checkLease:()=>{}}),/previous/);assert.equal(f.calls.length,0);
  for(const patch of [{reported:false},{state:'executing'},{operation:{...prior,accountId:'foreign'}},{result:{...f.operations.previous.result,outcome:'success'}}]) {
    const saved=f.operations.previous;f.operations.previous={...saved,...patch};await assert.rejects(f.adapter.execute(next,{checkLease:()=>{}}),/previous/);assert.equal(f.calls.length,0);f.operations.previous=saved;
  }
  await assert.rejects(f.adapter.execute({...next,payload:{...next.payload,previousOperationId:'missing'}},{checkLease:()=>{}}),/previous/);assert.equal(f.calls.length,0);
  await assert.rejects(f.adapter.execute({...next,payload:{...next.payload,tasks:[f.tasks[22],...next.payload.tasks]}},{checkLease:()=>{}}),/suffix/);assert.equal(f.calls.length,0);
  const before=JSON.stringify(f.operations.previous),oldUnknown=JSON.stringify([13,20,21,22,23,52].map(n=>f.draft(n))),completed=await f.adapter.execute(next,{checkLease:()=>{}});
  assert.equal(completed.outcome,'uncertain');assert.equal(completed.receipt.processedComplete,true);assert.equal(completed.receipt.summary.submitted,0);assert.equal(completed.receipt.summary.quotaSkipped,48);assert.equal(completed.receipt.summary.notAttempted,0);
  assert.ok(completed.receipt.tasks.every(task=>task.status==='quota_limited'&&task.confirmed===false&&!task.userMessageId));assert.deepEqual(f.calls[0].ids,f.tasks.slice(52).map(task=>task.draftId));
  assert.equal(JSON.stringify([13,20,21,22,23,52].map(n=>f.draft(n))),oldUnknown);assert.equal(JSON.stringify(f.operations.previous),before);
  const frozen=f.freeze();assert.deepEqual(await f.adapter.recover(next,{checkLease:()=>{}}),completed);assert.equal(f.calls.length,1);assert.equal(f.freeze(),frozen);
});

test('quota skips still require full original image proof, original chat URL and an explicit provider response',async t=>{
  for(const invalidate of [task=>{delete task.attachmentSendProof;},task=>{task.attachmentSendProof.names.reverse();},task=>{task.dispatchReceipt.conversationUrl='https://foreign.invalid/chat/task-100?token=secret';},task=>{delete task.dispatchReceipt.providerMessage;}]) {
    const f=fixture(t);await f.prove();f.dispatch(()=>{for(const snapshot of f.continuation.payload.tasks){if(snapshot.id==='task-100')invalidate(f.pending(snapshot,{quota:true}));else f.accept(snapshot);}});
    const result=await f.adapter.execute(f.continuation,{checkLease:()=>{}}),last=result.receipt.tasks.at(-1);
    assert.equal(result.outcome,'uncertain');assert.equal(last.status,'uncertain');assert.equal(result.receipt.summary.quotaSkipped,0);assert.equal(result.receipt.dispatches.at(-1).outcome,'attempted_unconfirmed');assert.equal(JSON.stringify(result).includes('secret'),false);
  }
});

test('validationCount 30 verifies the full 48 remainder before dispatching only its first 30 and leaves all other originals untouched',async t=>{
  const f=fixture(t);await f.prove();
  for(const snapshot of f.tasks.slice(22,52)){if(['task-023','task-052'].includes(snapshot.id))f.pending(snapshot);else f.accept(snapshot);}
  const prior=clone(f.continuation);prior.id='previous';f.operations.previous={state:'done',reported:true,operation:prior,result:f.adapter.realContinuationReceipt(prior)};
  const inspection={...clone(f.inspection),id:'inspection-48'},proof=await f.adapter.execute(inspection,{checkLease:()=>{}});f.operations['inspection-48']={state:'done',reported:true,operation:inspection,result:proof};
  assert.equal(proof.receipt.entries.length,100);assert.equal(proof.receipt.entries.filter(entry=>entry.status==='not_started').length,48);
  const next={...clone(f.continuation),id:'validation-30',payload:{...clone(f.continuation.payload),previousOperationId:'previous',inspectionOperationId:'inspection-48',validationCount:30,tasks:clone(f.tasks.slice(52,82))}};
  f.dispatch(()=>{for(const snapshot of next.payload.tasks)f.pending(snapshot,{quota:true});});
  for(const validationCount of [29,31,'30',0,null])await assert.rejects(f.adapter.execute({...next,payload:{...next.payload,validationCount}},{checkLease:()=>{}}),/validation/);
  await assert.rejects(f.adapter.execute({...next,payload:{...next.payload,tasks:clone(f.tasks.slice(52))}},{checkLease:()=>{}}),/suffix|validation/);
  const last=f.draft(100),prompt=last.template.prompt;last.template.prompt+=' changed';await assert.rejects(f.adapter.execute(next,{checkLease:()=>{}}),/draft|snapshot/);last.template.prompt=prompt;
  const removed=f.operations.previous.result.receipt.dispatches.pop();await assert.rejects(f.adapter.execute(next,{checkLease:()=>{}}),/previous/);f.operations.previous.result.receipt.dispatches.push(removed);
  assert.equal(f.calls.length,0);
  const untouched=JSON.stringify([13,20,21,22,23,52,...Array.from({length:18},(_,i)=>i+83)].map(n=>f.draft(n))),original=JSON.stringify(f.operations.original),result=await f.adapter.execute(next,{checkLease:()=>{}});
  assert.deepEqual(f.calls[0].ids,f.tasks.slice(52,82).map(task=>task.draftId));assert.equal(result.receipt.tasks.length,30);assert.equal(result.receipt.summary.expected,30);assert.equal(result.receipt.summary.quotaSkipped,30);assert.equal(result.receipt.processedComplete,true);assert.equal(result.outcome,'uncertain');
  assert.equal(JSON.stringify([13,20,21,22,23,52,...Array.from({length:18},(_,i)=>i+83)].map(n=>f.draft(n))),untouched);assert.equal(JSON.stringify(f.operations.original),original);
  const before=f.freeze();assert.deepEqual(await f.adapter.recover(next,{checkLease:()=>{}}),result);assert.equal(f.calls.length,1);assert.equal(f.freeze(),before);
});

test('new 50-task sends require every processed callback and image consumption proof before exposing accepted tasks beside skipped failures',async t=>{
  const f=fixture(t,{total:50,initialSent:0}),op={...clone(f.operations.original.operation),id:'normal-50',payload:{...clone(f.operations.original.operation.payload),batchSize:50}};
  const initial=f.adapter.progress(op);assert.deepEqual(initial.receipt.processed,[]);assert.equal(initial.receipt.processedComplete,false);
  f.journal.bindTask=(id,patch)=>Object.assign(f.bindings[id],patch);
  f.dispatch(async(ids,options)=>{for(let index=0;index<op.payload.tasks.length;index++){const snapshot=op.payload.tasks[index],draft=clone(f.draft(index+1));if(index<47)f.accept(snapshot);else if(index===47)f.pending(snapshot);else if(index===48)f.pending(snapshot,{quota:true});await options.onDraftProcessed?.({draft,index,issued:index<49,received:index<47});}});
  const result=await f.adapter.execute(op,{checkLease:()=>{}});
  assert.equal(result.outcome,'uncertain');assert.equal(result.receipt.processedComplete,true);assert.equal(result.receipt.processed.length,50);assert.equal(result.receipt.tasks.filter(item=>item.status==='submitted').length,47);assert.equal(result.receipt.tasks[47].status,'uncertain');assert.equal(result.receipt.tasks[48].status,'quota_limited');assert.equal(result.receipt.tasks[49].status,'skipped_before_click');
  assert.equal(result.receipt.tasks[0].attachmentProof.referenceCount,5);assert.equal(f.draft(50).submissionRecord,undefined);
  delete f.bindings['task-050'].lastSendProcessed;assert.equal(f.adapter.sendReceipt(op,op.payload.tasks).receipt.processedComplete,false);
  delete f.local(1).attachmentConsumptionProof;assert.equal(f.adapter.sendReceipt(op,op.payload.tasks).receipt.tasks[0].status,'uncertain');
});
