"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const P=require('../src/paths'),store=require('../src/store'),queue=require('../src/orchestrator');
const {NativeAdapter}=require('../src/server-executor'),{Journal}=require('../src/studio-bridge');
function fixture(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'studio-receipt-track-'));P.init({home});store.load();queue.pause('');
 const f={home,calls:[],texts:[],sends:0,closed:0,resumes:0,valid:true,candidate:true,progress:{state:'unknown'},catalog:new Map(),currentUrl:'https://www.doubao.com/'};
 f.check=()=>{if(!f.valid)throw Error('lease expired');};
 const driver={window:{isDestroyed:()=>false},webContents:{isDestroyed:()=>false,getURL:()=>f.currentUrl},isLoggedIn:async()=>({loggedIn:true}),waitForLogin:async()=>({loggedIn:true}),setGenerationOptions:async()=>({}),beginTask:async()=>({ok:true,baselineUrls:[],baselineMessageIds:[]}),navigate:async url=>{f.currentUrl=url;},url:async()=>f.currentUrl,
  setText:async(text,check)=>{check?.();f.texts.push(text);if(text==='按要求生成'&&f.expireOnFill)f.valid=false;if(f.holdFill)await new Promise(r=>f.releaseFill=r);return {ok:true};},
  send:async(options,check)=>{check?.();f.lastSendOptions=options;f.sends++;const saved=JSON.parse(fs.readFileSync(path.join(home,'store.json')));assert.equal(saved.tasks[0].confirmationIntents.confirm.state,'pending');if(f.loseClick)throw Error('lost click response');if(f.captchaOnSend)f.captcha=true;if(!f.holdGeneration)f.progress={state:'running',generationStarted:true};return {ok:true};},
  readProgress:async()=>f.progress,
  call:async(method,args,options)=>{f.calls.push({method,args,options});
   if(method==='readNativeDeliveryState')return {captchaDetected:Boolean(f.captcha)};
   if(method==='readNativeDrafts')return {ok:true,source:'indexeddb',accountScope:'scope-a',items:[...f.catalog.values()]};
   if(method==='restoreNativeDrafts'){if(options?.catalog)assert.equal(options.catalog.accountScope,'scope-a');return {ok:true,bindings:args};}
   if(method==='saveNativeDraft'){const b={id:args.id,nativeId:'native-'+args.id,accountScope:'scope-a',prompt:args.prompt,executionMode:'work'};f.catalog.set(args.id,b);return {ok:true,bindings:[b]};}
   if(method==='openNativeDraft')return {ok:true,conversationIds:[]};
   if(method==='waitNativeDraftAccepted')return {ok:true,conversationUrl:'https://www.doubao.com/chat/'+args.id,userMessageId:'message-'+args.id};
   if(method==='peekGenerationConfirmation')return f.candidate?{ok:true,kind:f.candidateKind||'text',key:f.candidateKey||'confirm',text:f.candidateText||'按要求生成'}:{ok:false};
   if(method==='confirmGeneration'){f.buttonConfirmations=(f.buttonConfirmations||0)+1;f.progress={state:'running',generationStarted:true};return {ok:true};}
   if(method==='readProgress')return f.progress;
   return {ok:true};}};
 queue.init({resolveDriver:async()=>driver,resolveDraftDriver:async(_inst,{signal}={})=>{
  let closed=false;const close=()=>{if(!closed){closed=true;f.closed++;}};signal?.addEventListener('abort',close,{once:true});
  return {...driver,close,preserve:()=>signal?.removeEventListener('abort',close),resumeAutoClose:nextSignal=>{if(nextSignal){signal?.removeEventListener('abort',close);signal=nextSignal;}if(signal?.aborted)return false;signal?.addEventListener('abort',close,{once:true});return true;}};
 }});
 const resume=queue.resume;queue.resume=()=>{f.resumes++;};
 f.driver=driver;f.journal=new Journal(path.join(home,'studio-journal.json'));f.adapter=new NativeAdapter({journal:f.journal,client:{},accounts:{},sessionId:'session',environment:{configure(inst){inst.studioEnvironment={version:'env'};}},maxDraftPages:2});
 f.op=(kind,id,payload={})=>({id,kind,accountId:'a',...(['send','track'].includes(kind)?{batchId:'batch'}:{}),leaseUntil:Date.now()+60000,leaseToken:'lease',payload:{account:{id:'a',name:'test',environment:{version:'env'}},...(f.validationRunId?{validationRunId:f.validationRunId}:{}),...payload}});
 f.snapshot=id=>({id,prompt:'Reply received only; do not generate '+id,parameters:{model:'seedance_v2.5',duration:30,ratio:'16:9'},references:[],...(f.validationRunId?{validationRunId:f.validationRunId}:{})});
 f.prepare=async(sendOnly=false,validationRunId)=>{if(validationRunId)return f.prepare50(validationRunId);f.validationRunId=validationRunId;const task=f.snapshot('001');await f.adapter.execute(f.op('import','import',{task,sendOnly}),{checkLease:f.check});const r=await f.adapter.execute(f.op('send','send',{tasks:[task],sendOnly}),{checkLease:f.check});assert.equal(r.outcome,'success');f.local=queue.getTask(r.receipt.tasks[0].localTaskId);return r;};
 f.prepare50=async(validationRunId='validation-run-one')=>{f.validationRunId=validationRunId;const tasks=Array.from({length:50},(_,i)=>f.snapshot(String(i+1).padStart(3,'0')));
  for(const task of tasks)await f.adapter.execute({...f.op('import','import-'+task.id,{task,sendOnly:false}),batchId:'batch'},{checkLease:f.check});
  const bound=tasks.map(task=>({...task,draftId:f.journal.task(task.id).draftId,nativeBinding:f.journal.task(task.id).nativeBinding}));
  const result=await f.adapter.execute(f.op('send','send',{tasks:bound,sendOnly:false,batchSize:50}),{checkLease:f.check});assert.equal(result.outcome,'success');assert.equal(result.receipt.tasks.length,50);f.local=queue.getTask(result.receipt.tasks[0].localTaskId);return result;
 };
 f.trackTask=()=>({...f.snapshot('001'),draftId:f.journal.task('001')?.draftId,nativeBinding:f.journal.task('001')?.nativeBinding,localTaskId:f.local?.id,conversationId:f.local?.conversationUrl});
 f.track=(payload={})=>f.adapter.execute({...f.op('track','track',{task:f.trackTask(),...payload}),taskId:'001'},{checkLease:f.check});
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
for(const kind of ['text','button'])test('generation confirmation '+kind+' uses only the fixed native reply and never clicks a confirmation button',async()=>{
 const f=fixture();try{await f.prepare();const before=f.texts.length;f.candidateKind=kind;f.candidateText=kind==='text'?'按方案生成':'确认生成';
  const result=await f.track();assert.equal(result.receipt.confirmed,true);assert.deepEqual(f.texts.slice(before),['按要求生成']);assert.deepEqual(f.lastSendOptions,{nativeOnly:true});assert.equal(f.buttonConfirmations||0,0);assert.equal(f.local.confirmationIntents.confirm.kind,'text');
 }finally{f.cleanup();}
});

test('a persisted sent confirmation resumes original result tracking after restart without another confirmation',async()=>{
 const f=fixture();try{await f.prepare();queue.patchTask(f.local.id,{confirmationIntents:{confirm:{state:'sent',sentAt:new Date().toISOString()}},status:'submitted'},true);store.load();f.local=queue.getTask(f.local.id);
  f.progress={state:'running',generationStarted:true};const result=await f.track();assert.equal(result.receipt.confirmed,true);assert.equal(f.sends,0);assert.equal(f.resumes,1);assert.equal(f.local.status,'queued');assert.ok(f.local.generationObservedAt);
 }finally{f.cleanup();}
});

test('human verification beyond fifteen minutes preserves the original confirmation and resumes when clear',async t=>{
 const f=fixture();let pending;try{await f.prepare();const op=f.op;f.op=(...args)=>({...op(...args),leaseUntil:Date.now()+3600000});f.captcha=true;t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});let finished=false;
  pending=f.track().finally(()=>{finished=true;});pending.catch(()=>{});for(let n=0;n<100;n++)await Promise.resolve();assert.equal(finished,false);
  t.mock.timers.tick(16*60*1000);for(let n=0;n<100;n++)await Promise.resolve();assert.equal(finished,false,'human waiting consumed the automatic deadline');assert.equal(f.sends,0);
  f.captcha=false;f.progress={state:'running',generationStarted:true};t.mock.timers.tick(100);for(let n=0;n<100;n++)await Promise.resolve();t.mock.timers.reset();await pending;assert.equal(f.resumes,1);assert.equal(f.sends,0);
 }finally{t.mock.timers.reset();f.valid=false;if(pending)await pending.catch(()=>{});f.cleanup();}
});
test('a factory draft never makes a second generation attempt when a lost text response is replaced by a new button',async()=>{
 const f=fixture();try{await f.prepare();f.loseClick=true;await assert.rejects(f.track(),/lost click/);assert.equal(f.sends,1);assert.equal(f.local.confirmationIntents.confirm.state,'pending');
  store.load();f.local=queue.getTask(f.local.id);f.loseClick=false;f.candidateKind='button';f.candidateKey='replacement';await f.track();assert.equal(f.sends,1);assert.equal(f.buttonConfirmations||0,0);assert.deepEqual(Object.keys(f.local.confirmationIntents),['confirm']);
 }finally{f.cleanup();}
});
test('a captcha after the only generation confirmation keeps its real page until manual completion and then resumes without another click',async()=>{
 const f=fixture();let pending;try{await f.prepare();f.captchaOnSend=true;f.holdGeneration=true;let done=false;const before=f.closed;pending=f.track().finally(()=>{done=true;});
  for(let n=0;n<100&&!f.sends;n++)await new Promise(r=>setTimeout(r,5));await new Promise(r=>setTimeout(r,20));assert.equal(f.sends,1);assert.equal(done,false,'confirmation captcha page closed before user takeover');
  const page=f.adapter.deliveryPages.pages.get('a');assert.ok(page);assert.equal((await page.snapshot()).captchaDetected,true);await page.takeover({taskId:'001',pageId:page.pageId});page.inputHeld=true;
  f.captcha=false;f.progress={state:'running',generationStarted:true};await new Promise(r=>setTimeout(r,40));assert.equal(done,false);assert.equal(f.closed,before);page.inputHeld=false;
  const result=await pending;assert.equal(result.receipt.confirmed,true);assert.equal(f.sends,1);assert.equal(f.closed,before+1);assert.equal(f.resumes,1);
 }finally{f.captcha=false;f.progress={state:'running',generationStarted:true};const page=f.adapter.deliveryPages.pages.get('a');if(page){page.inputHeld=false;page.manual=false;page.pauseRequested=false;}if(pending)await pending.catch(()=>{});f.cleanup();}
});
test('ordinary account quota failure without a confirmation button is recognized without another input',async()=>{
 const f=fixture();try{await f.prepare();f.candidate=false;
  const message=(id,text,role)=>({id,innerText:text,getAttribute:key=>key==='data-message-id'?id:key==='data-message-role'?role:null,querySelectorAll:()=>[]});
  const nodes=[message(f.local.receiptUserMessageId,f.local.prompt,'user'),message('quota-reply','当前账号额度不足','assistant')];
  const document={body:{innerText:nodes.map(n=>n.innerText).join('\n')},querySelectorAll:selector=>selector==='[data-message-id]'?nodes:[]};
  const context=vm.createContext({window:{},document,CFG:{autoKey:'auto'},URL,location:{href:f.local.conversationUrl}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/page/automation.js'),'utf8'),context);
  context.window.auto.beginTask({taskId:f.local.id,prompt:f.local.prompt,resume:true,baselineMessageIds:[f.local.receiptUserMessageId]});
  f.progress=context.window.auto.readProgress();assert.match(f.progress.snippet,/当前账号额度不足/);console.log(JSON.stringify({quotaPageParserState:f.progress.state}));
  const count=f.texts.length;const r=await f.track();assert.equal(r.outcome,'failure');assert.equal(f.sends,0);assert.equal(f.texts.length,count);assert.equal(f.resumes,0);
 }finally{f.cleanup();}
});
for(const by of ['unknown','login-button'])test('track waits for transient '+by+' login markers without parking a received task',async()=>{
 const f=fixture();try{await f.prepare();f.candidate=false;let reads=0;f.driver.isLoggedIn=async()=>++reads===1?{loggedIn:false,by}:{loggedIn:true,by:'avatar'};f.driver.waitForLogin=require('../src/driver').Driver.prototype.waitForLogin;
  const count=f.texts.length,r=await f.track();assert.equal(r.outcome,'progress');assert.equal(reads,2);assert.equal(f.sends,0);assert.equal(f.texts.length,count);
 }finally{f.cleanup();}
});
test('lease expiry during login loading closes the owned track page without input',async()=>{
 const f=fixture();try{await f.prepare();f.driver.isLoggedIn=async()=>{f.valid=false;return {loggedIn:false,by:'unknown'};};f.driver.waitForLogin=require('../src/driver').Driver.prototype.waitForLogin;const closed=f.closed;
  await assert.rejects(f.track(),/lease expired/);assert.equal(f.closed,closed+1);assert.equal(f.sends,0);
 }finally{f.cleanup();}
});
test('a login wait timeout remains read-only progress, and a non-rejection mention of quota is not a failure',async()=>{
 const f=fixture();try{await f.prepare();const texts=f.texts.length;f.candidate=false;f.driver.waitForLogin=async()=>({loggedIn:false,by:'login-button'});let r=await f.track();assert.equal(r.outcome,'progress');assert.equal(f.local.status,'submitted');
  f.driver.waitForLogin=async()=>({loggedIn:true});f.progress={state:'unknown',snippet:'额度充足，已收到测试消息'};r=await f.track();assert.equal(r.outcome,'progress');assert.equal(f.local.status,'submitted');assert.equal(f.sends,0);assert.equal(f.texts.length,texts);assert.equal(f.resumes,0);
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
test('scoped validation stops after the first confirmation without reading generation or resuming',async()=>{
 const f=fixture();try{await f.prepare(false,'validation-run-one');f.holdGeneration=true;
  f.driver.readProgress=async()=>{assert.equal(f.sends,0,'generation state must not be read after confirmation');return f.progress;};
  const r=await f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});
  assert.equal(r.outcome,'success');assert.equal(r.receipt.status,'confirmation_sent');assert.equal(r.receipt.validationRunId,'validation-run-one');assert.equal(f.sends,1);assert.equal(f.resumes,0);assert.equal(f.local.status,'submitted');
 }finally{f.cleanup();}
});
test('scoped validation isolates a persisted pending confirmation without another browser action',async()=>{
 const f=fixture();try{await f.prepare(false,'validation-run-one');queue.patchTask(f.local.id,{confirmationIntents:{confirm:{state:'pending'}}},true);
  f.driver.readProgress=async()=>assert.fail('unknown confirmation must remain isolated');
  const r=await f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});
  assert.equal(r.outcome,'uncertain');assert.equal(r.receipt.validationEndpoint,'confirmation_unknown');assert.equal(f.sends,0);assert.equal(f.resumes,0);
 }finally{f.cleanup();}
});
test('scoped validation isolates a recorded confirmation when its original safety page is missing',async()=>{
 const f=fixture();try{await f.prepare(false,'validation-run-one');queue.patchTask(f.local.id,{confirmationIntents:{confirm:{state:'sent',sentAt:new Date().toISOString()}}},true);
  f.driver.readProgress=async()=>assert.fail('validation endpoint must not read video status');
  const r=await f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});
  assert.equal(r.outcome,'uncertain');assert.equal(r.receipt.validationEndpoint,'confirmation_verification_unknown');assert.equal(f.sends,0);assert.equal(f.resumes,0);
 }finally{f.cleanup();}
});
test('a validation stop flag without a run identity cannot change ordinary tracking',async()=>{
 const f=fixture();try{await f.prepare();await assert.rejects(f.track({validationStopAfterConfirmation:true}),/validation.*scope/i);assert.equal(f.sends,0);
 }finally{f.cleanup();}
});
test('scoped validation isolates an already generating original without queuing result work',async()=>{
 const f=fixture();try{await f.prepare(false,'validation-run-one');f.progress={state:'running',generationStarted:true};
  const r=await f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});
  assert.equal(r.outcome,'uncertain');assert.equal(r.receipt.validationEndpoint,'generation_observed');assert.equal(f.local.status,'submitted');assert.equal(f.sends,0);assert.equal(f.resumes,0);
 }finally{f.cleanup();}
});
for(const afterClick of [false,true])test('scoped validation waits for human verification '+(afterClick?'after':'before')+' confirmation and never runs a solver',async()=>{
 const f=fixture();let pending;try{await f.prepare(false,'validation-run-one');let solverCalls=0,done=false;
  f.adapter.captchaConfig={enabled:true,apiKey:'synthetic-key'};f.adapter.captchaSolver=async()=>{solverCalls++;throw Error('manual verification only');};
  f.captcha=!afterClick;f.captchaOnSend=afterClick;
  pending=f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});pending.then(()=>{done=true;},()=>{});
  for(let i=0;i<100&&!(afterClick?f.sends===1:f.adapter.deliveryPages.pages.size);i++)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,30));assert.equal(done,false,'whole account must wait for human verification');assert.equal(solverCalls,0);
  assert.equal(f.sends,afterClick?1:0);f.captcha=false;
  const result=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('manual validation resume timeout')),1000))]);
  assert.equal(result.receipt.status,'confirmation_sent');assert.equal(f.sends,1);assert.equal(f.resumes,0);
 }finally{f.captcha=false;await pending?.catch(()=>{});f.cleanup();}
});
for(const fault of ['ordinary','changed_run','changed_snapshot','stripped_mode'])test('validation run is bound to the original import before browser actions: '+fault,async()=>{
 const f=fixture();try{await f.prepare(false,fault==='ordinary'?undefined:'validation-run-one');
  const payload={validationRunId:'validation-run-one',validationStopAfterConfirmation:true};
  if(fault==='changed_run')payload.validationRunId='different-run';
  if(fault==='changed_snapshot')payload.task={...f.trackTask(),prompt:'changed original'};
  if(fault==='stripped_mode'){payload.validationRunId=undefined;payload.validationStopAfterConfirmation=false;payload.task={...f.trackTask()};delete payload.task.validationRunId;}
  f.driver.readProgress=async()=>assert.fail('invalid validation must not open the original page');
  await assert.rejects(f.track(payload),/validation.*scope/i);assert.equal(f.sends,0);assert.equal(f.resumes,0);
 }finally{f.cleanup();}
});
test('a sent confirmation interrupted by captcha must recheck the same page before completing',async()=>{
 const f=fixture();let pending,reentry;try{await f.prepare(false,'validation-run-one');f.captchaOnSend=true;
  f.driver.readProgress=async()=>{assert.equal(f.sends,0,'captcha recovery cannot inspect video state');return {state:'unknown'};};
  let finished=false;pending=f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});pending.then(()=>{finished=true;},()=>{});
  await new Promise(r=>setTimeout(r,35));assert.equal(finished,false);f.valid=false;await assert.rejects(pending,/lease expired/);
  assert.notEqual(f.local.studioValidationEndpoint?.state,'first_confirmation');f.valid=true;
  reentry=f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});reentry.then(()=>{finished=true;},()=>{});
  await new Promise(r=>setTimeout(r,35));assert.equal(finished,false);f.captcha=false;
  const result=await reentry;assert.equal(result.receipt.status,'confirmation_sent');assert.equal(f.sends,1);assert.equal(f.local.studioValidationEndpoint.state,'first_confirmation');
 }finally{f.valid=true;f.captcha=false;await pending?.catch(()=>{});await reentry?.catch(()=>{});f.cleanup();}
});
for(const sent of [true,false])test('validation recovery checks the retained challenge page instead of a fresh clear page: sent='+sent,async()=>{
 const f=fixture();let pending;try{await f.prepare(false,'validation-run-one');if(sent)queue.patchTask(f.local.id,{confirmationIntents:{confirm:{state:'sent'}}},true);
  let originalCaptcha=true,opened=0,navigated=0;f.currentUrl=f.local.conversationUrl;
  const original={...f.driver,navigate:async()=>{navigated++;},resumeAutoClose:()=>true,call:async(method,...args)=>method==='readNativeDeliveryState'?{captchaDetected:originalCaptcha}:f.driver.call(method,...args)};
  const retained=f.adapter.registerDelivery({...f.op('track','old-track'),taskId:'001'},'001',f.journal.task('001').draftId,store.find(f.local.instanceId),original,()=>{},{});retained.keepOpen=true;retained.close();
  queue.init({resolveDraftDriver:async()=>{opened++;return {...f.driver,call:async(method,...args)=>method==='readNativeDeliveryState'?{captchaDetected:false}:f.driver.call(method,...args)};}});
  let done=false;pending=f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});pending.then(()=>{done=true;},()=>{});
  await new Promise(r=>setTimeout(r,35));assert.equal(done,false,'a clear fresh page cannot end the original challenge');assert.equal(opened,0);assert.equal(navigated,0);
  originalCaptcha=false;const result=await pending;assert.equal(result.receipt.status,'confirmation_sent');assert.equal(f.sends,sent?0:1);assert.equal(opened,0);assert.equal(navigated,0);
  assert.equal(f.adapter.deliveryPages.retained.has('a'),false,'a consumed retained page cannot block the next task');
  if(!sent){
    const task=f.adapter.local('002','a'),binding=f.journal.task('002');f.progress={state:'unknown'};f.driver.send=async()=>{f.sends++;return {ok:true};};
    const op={...f.op('track','track-next',{validationRunId:'validation-run-one',validationStopAfterConfirmation:true,task:{...f.snapshot('002'),draftId:binding.draftId,nativeBinding:binding.nativeBinding,localTaskId:task.id,conversationId:task.conversationUrl}}),taskId:'002'};
    const next=await f.adapter.execute(op,{checkLease:f.check});assert.equal(next.receipt.status,'confirmation_sent');assert.equal(f.sends,2);
  }
 }finally{f.valid=false;await pending?.catch(()=>{});f.cleanup();}
});
test('validation preserves a pre-confirmation challenge across a lost original page',async()=>{
 const f=fixture();let pending;try{await f.prepare(false,'validation-run-one');f.captcha=true;
  pending=f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});pending.catch(()=>{});
  await new Promise(r=>setTimeout(r,35));assert.equal(f.local.studioValidationRecoveryRequired,true);f.valid=false;await assert.rejects(pending,/lease expired/);
  f.valid=true;f.captcha=false;f.adapter.deliveryPages.retained.clear();let navigated=false;f.driver.navigate=async()=>{navigated=true;};
  const result=await f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});assert.equal(result.outcome,'uncertain');assert.equal(f.sends,0);assert.equal(navigated,false);
 }finally{f.valid=false;f.captcha=false;await pending?.catch(()=>{});f.cleanup();}
});
test('a stopped validation cannot block ordinary result work from its original account',async()=>{
 const f=fixture();try{await f.prepare(false,'validation-run-one');await f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});
  for(const other of store.get().tasks)if(other.id!==f.local.id)queue.patchTask(other.id,{status:'failed',errorCode:'quota'},true);
  const original=store.get().storyboards.find(s=>s.id===f.local.storyboardId),shot={...original.shots[0],id:'ordinary-shot',taskId:'ordinary-task',status:'queued'};
  const ordinary={...f.local,id:'ordinary-task',studioTaskId:'ordinary-factory-task',storyboardId:'ordinary-storyboard',shotId:shot.id,status:'queued',conversationUrl:'https://www.doubao.com/chat/ordinary',studioValidationEndpoint:undefined};
  store.get().storyboards.push({...original,id:ordinary.storyboardId,shots:[shot]});store.get().tasks.push(ordinary);store.save();
  const observed=[];f.driver.beginTask=async args=>{observed.push(args.taskId);return {ok:true,baselineUrls:[],baselineMessageIds:[]};};
  const result=await queue.dispatchOne(ordinary.storyboardId);assert.equal(result.ok,true,'stopped validation must not keep the ordinary result queue waiting');
  for(let i=0;i<50&&!observed.length;i++)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(observed,['ordinary-task']);queue.stopAll();
  for(let i=0;i<240&&queue.state().running.length;i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(queue.state().running.length,0,'ordinary result worker must release its account before the next fixture');
 }finally{f.cleanup();}
});
test('a full50 real-send receipt can reach its first scoped track without prewritten local journal anchors',async()=>{
 const f=fixture();try{const result=await f.prepare50();assert.equal(new Set(result.receipt.tasks.map(t=>t.userMessageId)).size,50);
  const r=await f.track({validationRunId:'validation-run-one',validationStopAfterConfirmation:true});
  assert.equal(r.receipt.status,'confirmation_sent');assert.equal(r.receipt.userMessageId,result.receipt.tasks[0].userMessageId);assert.equal(f.sends,1);
 }finally{f.cleanup();}
});
test('a validation send cannot strip its immutable run identity or enable the ordinary solver path',async()=>{
 const f=fixture();try{f.validationRunId='validation-run-one';const tasks=Array.from({length:50},(_,i)=>f.snapshot(String(i+1).padStart(3,'0')));
  for(const task of tasks)await f.adapter.execute({...f.op('import','import-'+task.id,{task,sendOnly:false}),batchId:'batch'},{checkLease:f.check});
  const bound=tasks.map(task=>({...task,draftId:f.journal.task(task.id).draftId,nativeBinding:f.journal.task(task.id).nativeBinding}));
  let pageOpened=false;f.adapter.driverFactory=async()=>{pageOpened=true;throw Error('must not open provider page');};f.adapter.captchaConfig={enabled:true,apiKey:'synthetic-key'};
  await assert.rejects(f.adapter.execute(f.op('send','send',{tasks:bound,sendOnly:false,batchSize:50,validationRunId:undefined}),{checkLease:f.check}),/validation.*scope/i);
  assert.equal(pageOpened,false);assert.equal(f.sends,0);
 }finally{f.cleanup();}
});
test('validation import pauses on a mask before filling and resumes on the original page',async()=>{
 const f=fixture();let pending;try{f.validationRunId='validation-run-one';f.captcha=true;let done=false;
  pending=f.adapter.execute({...f.op('import','import-masked',{task:f.snapshot('001')}),batchId:'batch'},{checkLease:f.check});pending.then(()=>{done=true;},()=>{});
  await new Promise(r=>setTimeout(r,40));assert.equal(done,false);assert.equal(f.texts.length,0);assert.equal(f.calls.filter(c=>c.method==='saveNativeDraft').length,0);
  assert.ok(f.adapter.deliveryPages.pages.get('a'),'the masked original import page must remain available to human control');
  f.captcha=false;const result=await pending;assert.equal(result.outcome,'success');assert.equal(f.calls.filter(c=>c.method==='saveNativeDraft').length,1);
 }finally{f.captcha=false;f.valid=false;await pending?.catch(()=>{});f.cleanup();}
});
