"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const P=require('../src/paths'),store=require('../src/store'),templates=require('../src/task-templates'),drafts=require('../src/task-drafts'),queue=require('../src/orchestrator');

async function fixture(t,receipt) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'doubao-captcha-send-'));P.init({home});store.load();queue.pause('');
  const catalog=new Map(),events=[],sent=[];
  function driver(signal) {
    let current='',closed=false;
    const close=()=>{if(closed)return;closed=true;events.push({type:'close',id:current});signal?.removeEventListener('abort',close);};
    signal?.addEventListener('abort',close,{once:true});
    const d={window:{isDestroyed:()=>closed},webContents:{isDestroyed:()=>closed},close,preserve:()=>signal?.removeEventListener('abort',close),isLoggedIn:async()=>({loggedIn:true}),waitForLogin:async()=>({loggedIn:true}),setText:async()=>({ok:true}),setGenerationOptions:async()=>({}),beginTask:async()=>({ok:true,baselineUrls:[],baselineMessageIds:[]}),
      call:async(method,value={})=>{
        if(method==='readNativeDrafts')return {ok:true,source:'indexeddb',accountScope:'scope',items:[...catalog.values()]};
        if(method==='saveNativeDraft') {const b={id:value.id,nativeId:'native-'+value.id,accountScope:'scope',prompt:value.prompt,executionMode:'work',index:catalog.size,titles:[...catalog.keys(),value.id]};catalog.set(value.id,b);return {ok:true,bindings:[b]};}
        if(method==='restoreNativeDrafts')return {ok:true,bindings:value};
        if(method==='openNativeDraft') {current=value.id;return {ok:true,conversationIds:[]};}
        if(method==='sendNativeDraft') {sent.push(value.id);events.push({type:'send',id:value.id});return {ok:true,clickedAt:new Date().toISOString()};}
        if(method==='waitNativeDraftAccepted') {events.push({type:'receipt',id:value.id});if(receipt)return receipt(value,d);return {ok:true,conversationUrl:'https://www.doubao.com/chat/'+value.id,userMessageId:'message-'+value.id};}
        return {ok:true};
      }};return d;
  }
  queue.init({resolveDriver:async()=>driver(),resolveDraftDriver:async(_inst,{signal}={})=>driver(signal)});
  const account=store.add({name:'isolated CAPTCHA fixture'});
  const ids=drafts.createMany([1,2,3].map(n=>templates.create({name:'test '+n,prompt:'Do not generate '+n,model:'seedance_v2.5',duration:30,ratio:'16:9'}).id)).map(d=>d.id);
  for(const [index,id] of ids.entries()){const d=drafts.list().find(d=>d.id===id);drafts.updateMany({[id]:{studioSendOnly:true,template:{...d.template,studioTaskId:'server-'+index}}});}
  await queue.saveDrafts(ids,{instanceId:account.id});events.length=0;
  t.after(()=>{queue.stopAll();assert.equal(path.dirname(home),os.tmpdir());assert.match(path.basename(home),/^doubao-captcha-send-/);fs.rmSync(home,{recursive:true,force:true});});
  return {ids,events,sent,options:{instanceId:account.id,sendOnly:true,startQueue:false,checkLease:()=>{}}};
}

test('dispatch-only acceptance records explicit quota responses and continues without confirming generation',async t=>{
  const f=await fixture(t,async value=>({ok:true,quotaLimited:true,conversationUrl:'https://www.doubao.com/chat/'+value.id,providerMessage:'近7天免费额度已用完'}));
  await queue.submitDrafts(f.ids,{...f.options,dispatchOnly:true});
  assert.deepEqual(f.sent,f.ids);assert.equal(store.get().tasks.length,0);
  for(const draft of drafts.list()){assert.equal(draft.dispatchReceipt.outcome,'quota_limited');assert.ok(draft.dispatchReceipt.clickedAt);assert.equal(draft.submissionRecord.task.submissionUncertain,true);}
});

test('quota-tolerant dispatch cannot enable generation mode',async t=>{
  const f=await fixture(t);await assert.rejects(queue.submitDrafts(f.ids,{...f.options,sendOnly:false,dispatchOnly:true}),/不得启动生成/);assert.deepEqual(f.sent,[]);
});
test('sender exposes and releases its exact page before advancing, while acceptance still requires the original message',async t=>{
  const f=await fixture(t);const registered=[],released=[];
  await queue.submitDrafts(f.ids,{...f.options,onDeliveryPage:({draft,driver})=>{registered.push({id:draft.id,driver});return {captchaSeen:false,setStage:()=>{},close:()=>{released.push(draft.id);f.events.push({type:'release',id:draft.id});}};}});
  assert.deepEqual(registered.map(p=>p.id),f.ids);assert.equal(new Set(registered.map(p=>p.driver)).size,3);assert.deepEqual(released,f.ids);
  for(const id of f.ids)assert.ok(f.events.findIndex(e=>e.type==='release'&&e.id===id)<f.events.findIndex(e=>e.type==='close'&&e.id===id));
  assert.deepEqual(f.sent,f.ids);assert.ok(store.get().tasks.every(task=>task.receiptUserMessageId&&!task.generationObservedAt));
});

test('manual takeover holds the received page and prevents the next send until explicit resume',async t=>{
  const f=await fixture(t);let release,entered=false;const hold=new Promise(resolve=>{release=resolve;});
  const sending=queue.submitDrafts(f.ids,{...f.options,onDeliveryPage:({draft})=>({captchaSeen:false,setStage:()=>{},close:()=>{},waitForResume:async()=>{if(draft.id===f.ids[0]){entered=true;await hold;}}})});
  try{for(let i=0;i<100&&!entered;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,true);assert.deepEqual(f.sent,[f.ids[0]]);assert.ok(!f.events.some(e=>e.type==='close'));}
  finally{release();await sending;}assert.deepEqual(f.sent,f.ids);
});

test('human takeover before preparation does not spend the automatic preparation timeout',async t=>{
  const f=await fixture(t);let release,entered=false;
  const hold=new Promise(resolve=>{release=resolve;}),active=new Set(),set=global.setTimeout,clear=global.clearTimeout;
  global.setTimeout=(run,ms,...args)=>{const timer=set(run,ms,...args);if(ms===120000)active.add(timer);return timer;};
  global.clearTimeout=timer=>{active.delete(timer);return clear(timer);};
  const sending=queue.submitDrafts(f.ids,{...f.options,onDeliveryPage:({draft})=>({setStage:()=>{},close:()=>{},runAutomation:async run=>{if(draft.id===f.ids[0]&&!entered){entered=true;await hold;}return run();}})});
  try{for(let i=0;i<100&&!entered;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,true);assert.equal(active.size,0,'manual wait must sit outside the 120 second automatic timer');assert.equal(f.sent.length,0);}
  finally{release();await sending;global.setTimeout=set;global.clearTimeout=clear;}
});

test('an interrupted human page is retained while the unknown intent and unstarted drafts remain preserved',async t=>{
  const f=await fixture(t,async()=>{throw Error('human input interrupted');});
  await assert.rejects(queue.submitDrafts(f.ids,{...f.options,onDeliveryPage:()=>({captchaSeen:true,keepOpen:true,setStage:()=>{},close:()=>{}})}));
  assert.deepEqual(f.sent,[f.ids[0]]);assert.equal(f.events.filter(e=>e.type==='close').length,0);assert.ok(drafts.list()[0].submissionRecord.task.submissionUncertain);
});
test('captcha receipt timeout preserves its send intent and halts every later draft without sending or refunding it',async t=>{
  const f=await fixture(t,async()=>{throw Error('captcha receipt timeout');}),pauses=[];
  await assert.rejects(queue.submitDrafts(f.ids,{...f.options,onDeliveryPage:()=>({captchaSeen:true,setStage:()=>{},close:()=>{}}),onDeliveryPause:info=>pauses.push(info)}),/未确认|接收|captcha|回执/);
  assert.deepEqual(f.sent,[f.ids[0]],'captcha timeout must not become another draft send');
  const remaining=drafts.list();assert.equal(remaining.length,3);assert.ok(remaining[0].submissionRecord?.task.submissionUncertain);assert.ok(remaining.slice(1).every(d=>!d.submissionRecord));
  assert.equal(pauses.length,1);assert.deepEqual(pauses[0].notStartedDraftIds,f.ids.slice(1));assert.equal(store.get().tasks.length,0);
});
test('unsafe human disconnect cancels only the owned page and halts the rest without a second send',async t=>{
  const f=await fixture(t,()=>new Promise(()=>{}));let callback=false;
  const sending=queue.submitDrafts(f.ids,{...f.options,onDeliveryPage:({cancel})=>{callback=true;setTimeout(()=>{const error=Error('human pointer disconnected');error.code='CAPTCHA_HANDOFF_INTERRUPTED';cancel(error);},0);return {captchaSeen:true,setStage:()=>{},close:()=>{}};}});
  const result=await Promise.race([sending.then(()=>null,error=>error),new Promise(resolve=>setTimeout(()=>resolve('timeout'),500))]);
  if(result==='timeout')queue.stopAll();await sending.catch(()=>{});
  assert.equal(callback,true,'owned page cancellation callback is missing');assert.notEqual(result,'timeout');assert.deepEqual(f.sent,[f.ids[0]]);assert.ok(drafts.list().slice(1).every(d=>!d.submissionRecord));
});
test('accepted first receipt stays byte-equivalent when second is captcha-unknown and third is never started',async t=>{
  let count=0,accepted;
  const f=await fixture(t,async value=>{
    if(++count===1)return {ok:true,conversationUrl:'https://www.doubao.com/chat/original-first',userMessageId:'original-first-message'};
    accepted=JSON.parse(JSON.stringify(store.get().tasks[0]));throw Error('captcha receipt timeout');
  }),pauses=[];
  await assert.rejects(queue.submitDrafts(f.ids,{...f.options,onDeliveryPage:()=>({captchaSeen:true,setStage:()=>{},close:()=>{}}),onDeliveryPause:info=>pauses.push(info)}));
  assert.deepEqual(f.sent,f.ids.slice(0,2));assert.deepEqual(store.get().tasks,[accepted]);assert.equal(accepted.receiptUserMessageId,'original-first-message');
  const saved=drafts.list();assert.deepEqual(saved.map(d=>d.id),f.ids.slice(1));assert.ok(saved[0].submissionRecord.task.submissionUncertain);assert.equal(saved[1].submissionRecord,undefined);
  assert.deepEqual(pauses[0].notStartedDraftIds,[f.ids[2]]);
});
