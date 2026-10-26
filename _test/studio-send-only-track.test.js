"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const P=require('../src/paths'),store=require('../src/store'),queue=require('../src/orchestrator');
const {NativeAdapter}=require('../src/server-executor'),{Journal}=require('../src/studio-bridge');
function fixture(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'studio-receipt-track-'));P.init({home});store.load();queue.pause('');
 const f={home,calls:[],texts:[],sends:0,closed:0,resumes:0,valid:true,candidate:true,progress:{state:'unknown'},catalog:new Map()};
 f.check=()=>{if(!f.valid)throw Error('lease expired');};
 const driver={isLoggedIn:async()=>({loggedIn:true}),waitForLogin:async()=>({loggedIn:true}),setGenerationOptions:async()=>({}),beginTask:async()=>({ok:true,baselineUrls:[],baselineMessageIds:[]}),navigate:async()=>{},url:async()=> 'https://www.doubao.com/chat/current',
  setText:async(text,check)=>{check?.();f.texts.push(text);if(text==='按要求生成'&&f.expireOnFill)f.valid=false;if(f.holdFill)await new Promise(r=>f.releaseFill=r);return {ok:true};},
  send:async(_options,check)=>{check?.();f.sends++;const saved=JSON.parse(fs.readFileSync(path.join(home,'store.json')));assert.equal(saved.tasks[0].confirmationIntents.confirm.state,'pending');if(f.loseClick)throw Error('lost click response');return {ok:true};},
  readProgress:async()=>f.progress,
  call:async(method,args,options)=>{f.calls.push({method,args,options});
   if(method==='readNativeDrafts')return {ok:true,source:'indexeddb',accountScope:'scope-a',items:[...f.catalog.values()]};
   if(method==='restoreNativeDrafts'){if(options?.catalog)assert.equal(options.catalog.accountScope,'scope-a');return {ok:true,bindings:args};}
   if(method==='saveNativeDraft'){const b={id:args.id,nativeId:'native-'+args.id,accountScope:'scope-a',prompt:args.prompt,executionMode:'work'};f.catalog.set(args.id,b);return {ok:true,bindings:[b]};}
   if(method==='openNativeDraft')return {ok:true,conversationIds:[]};
   if(method==='waitNativeDraftAccepted')return {ok:true,conversationUrl:'https://www.doubao.com/chat/'+args.id,userMessageId:'message-'+args.id};
   if(method==='peekGenerationConfirmation')return f.candidate?{ok:true,kind:'text',key:'confirm',text:'按要求生成'}:{ok:false};
   if(method==='readProgress')return f.progress;
   return {ok:true};}};
 queue.init({resolveDriver:async()=>driver,resolveDraftDriver:async(_inst,{signal}={})=>{let closed=false;const close=()=>{if(!closed){closed=true;f.closed++;}};signal?.addEventListener('abort',close,{once:true});return {...driver,close};}});
 const resume=queue.resume;queue.resume=()=>{f.resumes++;};
 f.journal=new Journal(path.join(home,'studio-journal.json'));f.adapter=new NativeAdapter({journal:f.journal,client:{},accounts:{},maxDraftPages:2});
 f.op=(kind,id,payload={})=>({id,kind,accountId:'a',leaseUntil:Date.now()+60000,leaseToken:'lease',payload:{account:{id:'a',name:'test'},...payload}});
 f.snapshot=id=>({id,prompt:'Reply received only; do not generate '+id,parameters:{model:'seedance_v2.5',duration:30,ratio:'16:9'},references:[]});
 f.prepare=async(sendOnly=false)=>{const task=f.snapshot('001');await f.adapter.execute(f.op('import','import',{task,sendOnly}),{checkLease:f.check});const r=await f.adapter.execute(f.op('send','send',{tasks:[task],sendOnly}),{checkLease:f.check});assert.equal(r.outcome,'success');f.local=queue.getTask(r.receipt.tasks[0].localTaskId);return r;};
 f.track=()=>f.adapter.execute({...f.op('track','track',{task:f.snapshot('001')}),taskId:'001'},{checkLease:f.check});
 f.cleanup=()=>{queue.resume=resume;queue.stopAll();fs.rmSync(home,{recursive:true,force:true});};return f;
}
test('test batch persists sendOnly outside the immutable template and retains the actual message anchor across restart',async()=>{
 const f=fixture();try{const r=await f.prepare(true);assert.equal(r.receipt.tasks[0].userMessageId,f.local.receiptUserMessageId);assert.equal(f.local.studioSendOnly,true);assert.equal(f.local.status,'submitted');assert.equal(f.sends,0);assert.equal(f.texts.length,1);assert.doesNotMatch(f.local.prompt,/生成要求/);
  const frozen=JSON.stringify(f.local);store.load();f.adapter=new NativeAdapter({journal:new Journal(f.journal.file),client:{},accounts:{}});
  const p=await f.track();assert.equal(p.outcome,'progress');assert.equal(f.sends,0);assert.equal(f.resumes,0);assert.equal(JSON.stringify(queue.getTask(f.local.id)),frozen);
 }finally{f.cleanup();}
});
test('normal accepted draft confirms only under the current track lease and closes its dedicated page before returning',async()=>{
 const f=fixture();try{await f.prepare();const before=f.texts.length,closed=f.closed;const r=await f.track();assert.equal(r.receipt.confirmed,true);assert.equal(f.sends,1);assert.equal(f.texts.length,before+1);assert.equal(f.closed,closed+1);assert.equal(f.resumes,1);assert.equal(store.get().storyboards.find(s=>s.id===f.local.storyboardId).shots[0].status,'queued');f.valid=false;await new Promise(r=>setTimeout(r,30));assert.equal(f.sends,1);
 }finally{f.cleanup();}
});
test('ordinary account quota failure without a confirmation button is recognized without another input',async()=>{
 const f=fixture();try{await f.prepare();f.candidate=false;f.progress={state:'failed',snippet:'当前账号额度不足'};const count=f.texts.length;const r=await f.track();assert.equal(r.outcome,'failure');assert.equal(f.sends,0);assert.equal(f.texts.length,count);assert.equal(f.resumes,0);
 }finally{f.cleanup();}
});
for(const at of ['before_track','after_fill'])test('expired lease '+at+' prevents a generation click',async()=>{
 const f=fixture();try{await f.prepare();if(at==='before_track')f.valid=false;else f.expireOnFill=true;await assert.rejects(f.track(),/lease/);assert.equal(f.sends,0);assert.equal(f.resumes,0);
 }finally{f.cleanup();}
});
test('lost confirmation response leaves its pending intent and a fresh track never sends it twice',async()=>{
 const f=fixture();try{await f.prepare();f.loseClick=true;await assert.rejects(f.track(),/lost click/);assert.equal(f.sends,1);f.loseClick=false;await f.track();assert.equal(f.sends,1);assert.equal(f.local.confirmationIntents.confirm.state,'pending');assert.equal(f.resumes,0);
 }finally{f.cleanup();}
});
test('returned unconfirmed progress leaves no page or background generation input after lease revocation',async()=>{
 const f=fixture();try{await f.prepare();f.candidate=false;const closed=f.closed;await f.track();assert.equal(f.closed,closed+1);f.valid=false;f.candidate=true;queue.wakeQueue();await new Promise(r=>setTimeout(r,30));assert.equal(f.sends,0);assert.equal(f.resumes,0);
 }finally{f.cleanup();}
});
test('lease expiry aborts the owned import page and late text completion cannot save or send',async()=>{
 const f=fixture();try{f.holdFill=true;const pending=f.adapter.execute(f.op('import','import',{task:f.snapshot('001')}),{checkLease:f.check});pending.catch(()=>{});while(!f.releaseFill)await new Promise(r=>setTimeout(r,2));f.valid=false;await assert.rejects(Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('lease cancellation timeout')),1500))]),/lease expired/);f.releaseFill();await new Promise(r=>setTimeout(r,30));assert.equal(f.calls.filter(c=>c.method==='saveNativeDraft').length,0);assert.equal(f.calls.filter(c=>c.method==='sendNativeDraft').length,0);assert.ok(f.closed>0);
 }finally{f.cleanup();}
});
