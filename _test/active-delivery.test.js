"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
let ActiveDeliveryPages;
try {({ActiveDeliveryPages}=require('../src/active-delivery'));} catch(error) {if(error.code!=='MODULE_NOT_FOUND')throw error;}

function setup(t) {
  assert.equal(typeof ActiveDeliveryPages,'function','real sending-page registry is missing');
  let valid=true,calls=0,cancelled=0;
  const state={captcha:{id:'captcha-a',rect:{x:100,y:100,width:400,height:300},focused:true}};
  const driver={window:{isDestroyed:()=>false},webContents:{isDestroyed:()=>false},call:async method=>{assert.equal(method,'readNativeDeliveryState');calls++;return state;}};
  const target={accountId:'account',operationId:'operation',batchId:'batch',environmentVersion:'env',executorSessionId:'session'};
  const pages=new ActiveDeliveryPages();t.after(()=>pages.closeAll());
  const handle=pages.register({...target,taskId:'task',draftId:'draft',instance:{id:'native-account'},driver,checkLease:()=>{if(!valid)throw Error('lease expired');},cancel:()=>cancelled++});
  return {pages,handle,target,driver,state,calls:()=>calls,cancelled:()=>cancelled,expire:()=>{valid=false;},binding:()=>({taskId:'task',pageId:handle.pageId,captchaId:state.captcha?.id||'page'})};
}

test('accepted original receipt resumes automatically after captcha is gone and the human pointer has lifted',async t=>{
  const s=setup(t);await s.handle.takeover(s.binding());delete s.state.captcha;s.state.captchaDetected=false;s.handle.inputHeld=true;
  let completed=false;const waiting=s.handle.waitForResume({receiptAccepted:true}).then(()=>{completed=true;});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(completed,false);
  s.handle.inputHeld=false;
  const outcome=await Promise.race([waiting.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),350))]);
  if(!outcome){await s.handle.observe({taskId:'task',pageId:s.handle.pageId});await waiting;}
  assert.equal(outcome,true);assert.equal(s.handle.manual,false);
});

test('automatic resume rechecks a pointer that started while captcha inspection was pending',async t=>{
  const s=setup(t);await s.handle.takeover(s.binding());let release,entered=false,first=true,completed=false;
  const gate=new Promise(resolve=>{release=resolve;});
  s.driver.call=async()=>{if(first){first=false;entered=true;await gate;}return {captchaDetected:false};};
  const waiting=s.handle.waitForResume({receiptAccepted:true}).then(()=>{completed=true;});
  while(!entered)await new Promise(resolve=>setImmediate(resolve));s.handle.inputHeld=true;release();
  try{await new Promise(resolve=>setTimeout(resolve,130));assert.equal(completed,false,'a new drag must keep its original page open');}
  finally{s.handle.inputHeld=false;await waiting;}
});

test('a failed captcha read cannot authorize automatic resume after receipt acceptance',async t=>{
  const s=setup(t);await s.handle.takeover(s.binding());let completed=false;
  s.driver.call=async()=>{throw Error('temporary document read error');};
  const waiting=s.handle.waitForResume({receiptAccepted:true}).then(()=>{completed=true;});
  try{await new Promise(resolve=>setTimeout(resolve,130));assert.equal(completed,false);}
  finally{s.driver.call=async()=>({captchaDetected:false});await waiting;}
});

test('human takeover remains on the same full page after captcha disappears until the user resumes automation',async t=>{
  const s=setup(t);await s.handle.takeover(s.binding());
  delete s.state.captcha;s.state.captchaDetected=false;
  assert.equal((await s.handle.snapshot()).stage,'manual_captcha');
  const binding={taskId:'task',pageId:s.handle.pageId,captchaId:'page'};
  await s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mouseReleased',x:700,y:450,button:'left'});
  await s.handle.observe(binding);assert.equal(s.handle.manual,false);assert.equal(s.cancelled(),0);
});
test('human takeover waits for the current atomic preparation step and blocks the next automation step',async t=>{
  const s=setup(t);delete s.state.captcha;s.state.captchaDetected=false;assert.equal(typeof s.handle.runAutomation,'function');let release,entered=false,second=false;
  const first=s.handle.runAutomation(async()=>{entered=true;await new Promise(resolve=>{release=resolve;});});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,true);
  const takeover=s.handle.takeover(s.binding());assert.equal(s.handle.manual,false);assert.equal(s.handle.keepOpen,true);
  release();await first;await takeover;
  const next=s.handle.runAutomation(async()=>{second=true;});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(second,false);
  await s.handle.observe(s.binding());await next;assert.equal(second,true);
});
test('borrows only the exact live owned page and fences stale task/environment/session/op references',t=>{
  const s=setup(t);assert.equal(s.pages.borrow(s.target),s.handle);assert.equal(s.handle.driver,s.driver);
  for(const [key,value] of Object.entries({accountId:'other',operationId:'other',batchId:'other',environmentVersion:'other',executorSessionId:'other',taskId:'other',pageId:'other'}))assert.throws(()=>s.pages.borrow({...s.target,[key]:value}),/mismatch|missing|closed/i);
  s.handle.close();assert.throws(()=>s.pages.borrow(s.target),/missing|closed/i);assert.equal(s.cancelled(),0);
});
test('default observation cannot input; explicit human captcha takeover is confined to the fresh live target',async t=>{
  const s=setup(t),binding=s.binding();
  await assert.rejects(s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mousePressed',x:200,y:200}),/captcha|observe/i);
  await s.handle.takeover(binding);await s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mousePressed',x:200,y:200});
  await s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mouseReleased',x:700,y:200});
  await assert.rejects(s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mouseReleased',x:5000,y:200}),/page|range/i);
  await assert.rejects(s.handle.assertInput({...binding,pageId:'old'},'Input.insertText',{text:'123'}),/mismatch/i);
  assert.equal(s.handle.captchaSeen,true);assert.equal(s.cancelled(),0);
});
test('human inputs retain full page access while stale page identities remain fenced',async t=>{
  const s=setup(t),binding=s.binding();await s.handle.takeover(binding);
  await s.handle.assertInput(binding,'Input.insertText',{text:'人工输入'});s.state.captcha.focused=false;
  await s.handle.assertInput(binding,'Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',modifiers:0});
  await s.handle.assertInput(binding,'Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',modifiers:0});
  delete s.state.captcha;await s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mouseReleased',x:200,y:200});
  await s.handle.assertInput({...binding,captchaId:'page'},'Input.dispatchMouseEvent',{type:'mouseReleased',x:200,y:200});
});

test('expired leases block reads and inputs, old close cannot remove the next page, cancel reaches owner only once',async t=>{
  const s=setup(t);s.expire();const before=s.calls();assert.throws(()=>s.pages.borrow(s.target),/expired/);await assert.rejects(s.handle.snapshot(),/expired/);assert.equal(s.calls(),before);
  s.handle.close();const next=s.pages.register({...s.target,taskId:'next',draftId:'next',instance:{},driver:s.driver,checkLease:()=>{},cancel:()=>{}});
  s.handle.close();assert.equal(s.pages.borrow(s.target),next);next.cancel(Error('manual interrupted'));next.cancel(Error('again'));assert.throws(()=>s.pages.borrow(s.target),/missing|closed/i);
});
test('failed registration leaves no borrowed reference',t=>{
  const s=setup(t);s.handle.close();
  const context={...s.target,taskId:'task',draftId:'draft',instance:{},driver:s.driver,cancel:()=>{}};
  assert.throws(()=>s.pages.register({...context,checkLease:()=>{throw Error('lease expired');}}),/expired/);
  const next=s.pages.register({...context,checkLease:()=>{}});assert.equal(s.pages.borrow(s.target),next);
});
test('replacement captcha retains page takeover and the same gesture binding',async t=>{
  const s=setup(t),binding=s.binding();await s.handle.takeover(binding);s.state.captcha.id='captcha-b';await s.handle.snapshot();
  const before=s.calls();await s.handle.assertInput(binding,'Input.insertText',{text:'123'});assert.equal(s.calls(),before,'input must not await CAPTCHA DOM inspection');
  await s.handle.assertInput({...binding,captchaId:'captcha-b'},'Input.insertText',{text:'123'});
});
function detector({mask=false,frameAbsent=false}={}) {
  const frame={hidden:false,isConnected:true,src:'https://rmc.bytedance.com/verifycenter/captcha/v2?private=one',getAttribute(name){return name==='src'?this.src:null;},getBoundingClientRect:()=>({x:100,y:80,left:100,top:80,right:600,bottom:480,width:500,height:400}),getClientRects:()=>[1],closest:()=>null};
  const container={isConnected:true,getClientRects:()=>[1],closest:()=>null,display:mask?'block':'none'};
  let covered=false;const document={activeElement:frame,documentElement:{clientWidth:1000,clientHeight:800},querySelectorAll:s=>s.includes('verifycenter/captcha')?frameAbsent?[]:[frame]:s.includes('captcha_container')?[container]:[],elementFromPoint:()=>covered?{}:frame};
  const context=vm.createContext({window:{auto:{},crypto:require('node:crypto').webcrypto,innerWidth:1000,innerHeight:800},document,CFG:{autoKey:'auto'},getComputedStyle:n=>({display:n.display||'block',visibility:n.visibility||'visible',opacity:'1'})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/page/native-drafts.js'),'utf8'),context);
  assert.equal(typeof context.window.auto.readNativeDeliveryState,'function','live captcha detector is missing');
  return {api:context.window.auto,frame,container,document,cover:()=>{covered=true;}};
}
for(const frameAbsent of [false,true])test('visible verification mask blocks even before a usable iframe exists: '+frameAbsent,()=>{
  const s=detector({mask:true,frameAbsent});s.frame.visibility='hidden';
  const state=s.api.readNativeDeliveryState();assert.equal(state.captchaDetected,true);assert.equal(state.captcha,undefined);
});
test('hidden historical mask and hidden preload frame do not block automatic work',()=>{
  const s=detector();s.frame.visibility='hidden';assert.equal(s.api.readNativeDeliveryState().captchaDetected,false);
});
test('mask-only pause holds its account while another account can run, and clears automatically on the same page',async t=>{
  const s=detector({mask:true});s.frame.visibility='hidden';const pages=new ActiveDeliveryPages();t.after(()=>pages.closeAll());
  const make=(accountId,read)=>pages.register({accountId,operationId:'op-'+accountId,batchId:'batch',environmentVersion:'env',executorSessionId:'session',taskId:'task-'+accountId,draftId:'draft-'+accountId,instance:{},driver:{window:{isDestroyed:()=>false},webContents:{isDestroyed:()=>false},call:read},checkLease:()=>{},cancel:()=>{}});
  const current=make('current',async()=>s.api.readNativeDeliveryState()),other=make('other',async()=>({captchaDetected:false}));
  let entered=false,otherRan=false;const action=current.runAutomation(async()=>{entered=true;});
  try{await other.runAutomation(async()=>{otherRan=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(otherRan,true);assert.equal(entered,false);assert.equal(current.captchaSeen,true);}
  finally{s.container.display='none';await action;}
  assert.equal(entered,true);assert.equal(current.keepOpen,false);
});
test('read-only detection reports only visible unobscured captcha, stable opaque identity and iframe focus',()=>{
  const s=detector(),a=s.api.readNativeDeliveryState();assert.ok(a.captcha?.id);assert.equal(a.captcha.focused,true);assert.deepEqual(JSON.parse(JSON.stringify(a.captcha.rect)),{x:100,y:80,width:500,height:400});
  assert.equal(s.api.readNativeDeliveryState().captcha.id,a.captcha.id);assert.ok(!JSON.stringify(a).includes('private=one'));
  s.frame.src='https://rmc.bytedance.com/verifycenter/captcha/v2?private=two';assert.notEqual(s.api.readNativeDeliveryState().captcha.id,a.captcha.id);
  s.document.activeElement={};assert.equal(s.api.readNativeDeliveryState().captcha.focused,false);s.cover();assert.equal(s.api.readNativeDeliveryState().captcha,undefined);assert.equal(s.api.readNativeDeliveryState().captchaDetected,true);
});
test('hidden captcha cannot enable handoff',()=>{const s=detector();s.frame.hidden=true;assert.equal(s.api.readNativeDeliveryState().captcha,undefined);});
test('fresh document runtimes cannot reuse a captcha identity from an earlier navigation',()=>{
  const first=detector().api.readNativeDeliveryState(),next=detector().api.readNativeDeliveryState();
  assert.notEqual(first.captcha.id,next.captcha.id);
});
test('a captcha with no exposed rectangle still latches detection and allows explicit whole-page human takeover',async t=>{
  const s=setup(t);s.state.captchaDetected=true;delete s.state.captcha;
  assert.equal((await s.handle.snapshot()).stage,'captcha_required');assert.equal(s.handle.captchaSeen,true);
  await s.handle.takeover({taskId:'task',pageId:s.handle.pageId,captchaId:'page'});assert.equal(s.handle.manual,true);
});
test('explicit human page takeover can operate overlays and areas outside the captcha iframe',async t=>{
  assert.equal(typeof ActiveDeliveryPages,'function');const s=detector();
  s.document.elementFromPoint=(x,y)=>Math.abs(x-200)<10&&Math.abs(y-200)<10?{tagName:'BUTTON'}:s.frame;
  const pages=new ActiveDeliveryPages();t.after(()=>pages.closeAll());
  const page=pages.register({accountId:'a',operationId:'o',batchId:'b',environmentVersion:'e',executorSessionId:'s',taskId:'t',draftId:'d',instance:{},driver:{window:{isDestroyed:()=>false},webContents:{isDestroyed:()=>false},call:async(method,...args)=>s.api[method](...args)},checkLease:()=>{},cancel:()=>{}});
  const state=await page.snapshot();assert.ok(state.captcha,'five samples cannot establish the actual pointer target');
  const binding={taskId:'t',pageId:page.pageId,captchaId:state.captcha?.id||'page'};
  for(const type of ['mousePressed','mouseMoved','mouseReleased','mouseWheel']) {
    await page.takeover(binding);
    await page.assertInput(binding,'Input.dispatchMouseEvent',{type,x:200,y:200,button:'left'});
  }
});

test('verification clearance automatically resumes preparation before any message receipt exists',async t=>{
  const s=setup(t);await s.handle.takeover(s.binding());const binding={taskId:'task',pageId:s.handle.pageId};
  delete s.state.captcha;s.state.captchaDetected=false;
  let entered=false;const next=s.handle.runAutomation(async()=>{entered=true;});
  const resumed=await Promise.race([next.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),350))]);
  if(!resumed){await s.handle.observe(binding);await next;}
  assert.equal(resumed,true,'verified original preparation must continue without waiting for a nonexistent receipt');
  assert.equal(entered,true);
});
for(const reason of ['captcha','unknown','input'])test(`explicit resume cannot bypass ${reason} verification state`,async t=>{
  const s=setup(t);await s.handle.takeover(s.binding());
  if(reason!=='captcha'){delete s.state.captcha;s.state.captchaDetected=false;}
  if(reason==='unknown')s.driver.call=async()=>{throw Error('document temporarily unavailable');};
  if(reason==='input')s.handle.inputInFlight=1;
  await assert.rejects(s.handle.observe({taskId:'task',pageId:s.handle.pageId}),/验证|输入|captcha/i);
  assert.equal(s.handle.manual,true);
});
test('captcha detection alone gates the next automated action until verification clears',async t=>{
  const s=setup(t);await s.handle.snapshot();let entered=false;
  const next=s.handle.runAutomation(async()=>{entered=true;});
  await new Promise(resolve=>setTimeout(resolve,20));const before=entered;
  delete s.state.captcha;s.state.captchaDetected=false;await next;
  assert.equal(before,false,'a visible captcha must stop new automatic actions without a takeover click');
  assert.equal(entered,true);
});
