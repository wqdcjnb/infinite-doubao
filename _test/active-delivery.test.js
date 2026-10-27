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
  return {pages,handle,target,driver,state,calls:()=>calls,cancelled:()=>cancelled,expire:()=>{valid=false;},binding:()=>({taskId:'task',pageId:handle.pageId,captchaId:state.captcha.id})};
}
test('borrows only the exact live owned page and fences stale task/environment/session/op references',t=>{
  const s=setup(t);assert.equal(s.pages.borrow(s.target),s.handle);assert.equal(s.handle.driver,s.driver);
  for(const [key,value] of Object.entries({accountId:'other',operationId:'other',batchId:'other',environmentVersion:'other',executorSessionId:'other',taskId:'other',pageId:'other'}))assert.throws(()=>s.pages.borrow({...s.target,[key]:value}),/mismatch|missing|closed/i);
  s.handle.close();assert.throws(()=>s.pages.borrow(s.target),/missing|closed/i);assert.equal(s.cancelled(),0);
});
test('default observation cannot input; explicit human captcha takeover is confined to the fresh live target',async t=>{
  const s=setup(t),binding=s.binding();
  await assert.rejects(s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mousePressed',x:200,y:200}),/captcha|observe/i);
  await s.handle.takeover(binding);await s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mousePressed',x:200,y:200});
  await assert.rejects(s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mouseReleased',x:700,y:200}),/captcha|range/i);
  await assert.rejects(s.handle.assertInput({...binding,pageId:'old'},'Input.insertText',{text:'123'}),/mismatch/i);
  assert.equal(s.handle.captchaSeen,true);assert.equal(s.cancelled(),0);
});
test('each input re-reads captcha/focus and never permits navigation shortcuts or events after disappearance',async t=>{
  const s=setup(t),binding=s.binding();await s.handle.takeover(binding);
  await s.handle.assertInput(binding,'Input.insertText',{text:'人工输入'});s.state.captcha.focused=false;
  await assert.rejects(s.handle.assertInput(binding,'Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',modifiers:0}),/focus|captcha/i);
  s.state.captcha.focused=true;await assert.rejects(s.handle.assertInput(binding,'Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',modifiers:0}),/key|captcha/i);
  await assert.rejects(s.handle.assertInput(binding,'Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',modifiers:2}),/key|captcha/i);
  delete s.state.captcha;await assert.rejects(s.handle.assertInput(binding,'Input.dispatchMouseEvent',{type:'mouseReleased',x:200,y:200}),/captcha/i);
  assert.ok(s.calls()>=6);
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
test('replacement captcha requires a new explicit human takeover',async t=>{
  const s=setup(t),binding=s.binding();await s.handle.takeover(binding);s.state.captcha.id='captcha-b';await s.handle.snapshot();
  await assert.rejects(s.handle.assertInput({...binding,captchaId:'captcha-b'},'Input.insertText',{text:'123'}),/observe|takeover|captcha/i);
});
function detector() {
  const frame={hidden:false,isConnected:true,src:'https://rmc.bytedance.com/verifycenter/captcha/v2?private=one',getAttribute(name){return name==='src'?this.src:null;},getBoundingClientRect:()=>({x:100,y:80,left:100,top:80,right:600,bottom:480,width:500,height:400}),getClientRects:()=>[1],closest:()=>null};
  let covered=false;const document={activeElement:frame,documentElement:{clientWidth:1000,clientHeight:800},querySelectorAll:s=>s.includes('verifycenter/captcha')?[frame]:[],elementFromPoint:()=>covered?{}:frame};
  const context=vm.createContext({window:{auto:{},crypto:require('node:crypto').webcrypto,innerWidth:1000,innerHeight:800},document,CFG:{autoKey:'auto'},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/page/native-drafts.js'),'utf8'),context);
  assert.equal(typeof context.window.auto.readNativeDeliveryState,'function','live captcha detector is missing');
  return {api:context.window.auto,frame,document,cover:()=>{covered=true;}};
}
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
test('a detected but unsafe captcha still latches the timeout stop boundary without enabling input',async t=>{
  const s=setup(t);s.state.captchaDetected=true;delete s.state.captcha;
  assert.equal((await s.handle.snapshot()).stage,'captcha_required');assert.equal(s.handle.captchaSeen,true);
  await assert.rejects(s.handle.takeover({taskId:'task',pageId:s.handle.pageId,captchaId:'unavailable'}),/captcha/i);
});
test('every actual pointer location must hit the captcha iframe, not an overlay between the sampled points',async t=>{
  assert.equal(typeof ActiveDeliveryPages,'function');const s=detector();
  s.document.elementFromPoint=(x,y)=>Math.abs(x-200)<10&&Math.abs(y-200)<10?{tagName:'BUTTON'}:s.frame;
  const pages=new ActiveDeliveryPages();t.after(()=>pages.closeAll());
  const page=pages.register({accountId:'a',operationId:'o',batchId:'b',environmentVersion:'e',executorSessionId:'s',taskId:'t',draftId:'d',instance:{},driver:{window:{isDestroyed:()=>false},webContents:{isDestroyed:()=>false},call:async(method,...args)=>s.api[method](...args)},checkLease:()=>{},cancel:()=>{}});
  const state=await page.snapshot();assert.ok(state.captcha,'five samples cannot establish the actual pointer target');
  const binding={taskId:'t',pageId:page.pageId,captchaId:state.captcha.id};
  for(const type of ['mousePressed','mouseMoved','mouseReleased','mouseWheel']) {
    await page.takeover(binding);
    await assert.rejects(page.assertInput(binding,'Input.dispatchMouseEvent',{type,x:200,y:200,button:'left'}),/captcha|target|range|covered/i);
  }
});
