"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const quotaText='近7天免费额度已用完，预计11月1日00:28恢复。';
const prompt='【草稿编号：DB-111111111111111111111111】\n本次唯一原始草稿正文';
function fixture({messages,quotaAt=0,includeUser=true,captchaUntil=0,clearAt=Infinity,dispatchOnly=false,attachmentNames=['1.png','2.png','3.png','4.png','5.png'],baselineMessageIds=[],conversationIds=[]}={}) {
  let now=0;
  function message({id,role,body=quotaText,hidden=false,quote=false,excluded=false}) {
    return {innerText:body,textContent:body,tagName:'DIV',isConnected:true,hidden,
      getAttribute:key=>key==='data-message-id'?id:key==='data-message-role'?role:null,getClientRects:()=>[{}],
      closest(selector){if(selector==='[data-message-role], [data-role]')return role?this:null;if(selector==='[data-message-id]')return id?this:null;if(selector.includes('nav, aside'))return excluded?{}:null;if(selector.includes('blockquote'))return quote?{}:null;return null;},
      querySelectorAll:selector=>selector.includes('blockquote')&&quote?[{}]:[]};
  }
  const defaults=[...(includeUser?[{id:'current-user',role:'user',body:prompt}]:[]),{id:'current-quota',role:'assistant'}];
  const messageNodes=(messages||defaults).map(message);
  const current=()=>messageNodes.filter(item=>item.getAttribute('data-message-role')!=='assistant'||now>=quotaAt);
  const card={isConnected:true,getClientRects:()=>[{}],closest:()=>null},frame={...card};
  const root={isConnected:true,getClientRects:()=>[{}],closest:()=>null,querySelectorAll:s=>s.includes('attachment_area')&&now<clearAt?[card]:[]};
  const editor={tagName:'TEXTAREA',value:'',isConnected:true,getClientRects:()=>[{}],closest:s=>s==='#input-engine-container'?root:null};
  const document={querySelector:s=>s==='#input-engine-container'?root:editor,querySelectorAll:s=>s==='[data-message-id]'||s==='p, [data-message-id]'?current():s.includes('iframe')&&now<captchaUntil?[frame]:s.includes('contenteditable')?[editor]:[]};
  class Clock extends Date {static now(){return now;}}
  const api={},location={pathname:'/chat/current-conversation',href:'https://www.doubao.com/chat/current-conversation'};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/page/native-drafts.js'),'utf8'),{window:{auto:api},CFG:{autoKey:'auto'},document,location,Date:Clock,getComputedStyle:()=>({display:'block',visibility:'visible'}),setTimeout(fn,ms){now+=ms;queueMicrotask(fn);}});
  api.readNativeDeliveryState=()=>({captchaDetected:now<captchaUntil});
  const options={prompt,attachmentNames,baselineMessageIds,conversationIds,dispatchOnly};
  return {api,options,elapsed:()=>now,read:()=>api.readNativeQuotaResponse(options),wait:()=>api.waitNativeDraftAccepted(options)};
}

test('real mode returns an explicit current assistant quota before a text receipt or pending five-image consumption',async()=>{
  for(const attachmentNames of [[],['1.png','2.png','3.png','4.png','5.png']]) {
    const f=fixture({attachmentNames}),result=await f.wait();
    assert.equal(result.ok,true);assert.equal(result.quotaLimited,true);assert.equal(result.conversationUrl,'https://www.doubao.com/chat/current-conversation');assert.equal(result.providerMessage,quotaText);assert.equal(f.elapsed(),0);
    assert.equal(Object.hasOwn(result,'userMessageId'),false);assert.equal(Object.hasOwn(result,'attachmentConsumptionProof'),false);assert.equal(Object.hasOwn(result,'attachmentProof'),false);
  }
});

test('a quota arriving at the exact attachment-consumption boundary wins over normal acceptance',async()=>{
  const f=fixture({quotaAt:500,clearAt:0}),result=await f.wait();
  assert.equal(result.quotaLimited,true);assert.equal(f.elapsed(),500);assert.equal(result.userMessageId,undefined);assert.equal(result.attachmentConsumptionProof,undefined);
});

test('a new assistant rejection without a user-message anchor is a quota refusal, never a fabricated text receipt',async()=>{
  const f=fixture({includeUser:false}),result=await f.wait();assert.equal(result.quotaLimited,true);assert.equal(result.userMessageId,undefined);assert.equal(f.elapsed(),0);
});

test('old conversations, baseline assistant messages, user repetitions and quoted assistant text are excluded',()=>{
  const cases=[
    {conversationIds:['current-conversation']},
    {baselineMessageIds:['current-quota']},
    {messages:[{id:'user-repetition',role:'user',body:quotaText}]},
    {messages:[{id:'quoted-assistant',role:'assistant',quote:true}]},
    {messages:[{id:'unidentified',role:''}]},
    {messages:[{id:'',role:'assistant'}]},
    {messages:[{id:'hidden-assistant',role:'assistant',hidden:true}]},
    {messages:[{id:'navigation-copy',role:'assistant',excluded:true}]}
  ];
  for(const options of cases)assert.equal(fixture(options).read(),null,JSON.stringify(options));
});

test('a prior assistant quota before the current numbered user message cannot reject the new draft',async()=>{
  const f=fixture({clearAt:0,messages:[{id:'late-old-quota',role:'assistant'},{id:'current-user',role:'user',body:prompt}]});
  assert.equal(f.read(),null);const result=await f.wait();assert.equal(result.ok,true);assert.equal(result.quotaLimited,undefined);assert.equal(result.userMessageId,'current-user');assert.ok(result.attachmentConsumptionProof);assert.equal(f.elapsed(),500);
});

test('assistant history before the last visible baseline anchor cannot count as a fresh quota response',()=>{
  const f=fixture({includeUser:false,baselineMessageIds:['baseline-anchor'],messages:[{id:'late-history-quota',role:'assistant'},{id:'baseline-anchor',role:'user',body:'older unrelated content'}]});
  assert.equal(f.read(),null);
});

test('a still-visible CAPTCHA defers quota classification until it disappears in both operation modes',async()=>{
  for(const dispatchOnly of [false,true]) {
    const f=fixture({dispatchOnly,captchaUntil:1000}),result=await f.wait();assert.equal(result.quotaLimited,true);assert.equal(f.elapsed(),1000);assert.equal(result.userMessageId,undefined);
  }
});

test('missing baseline evidence or multiple current user anchors is not guessed into a quota refusal',()=>{
  const missing=fixture();delete missing.options.baselineMessageIds;assert.equal(missing.read(),null);
  const ambiguous=fixture({messages:[{id:'user-one',role:'user',body:prompt},{id:'user-two',role:'user',body:prompt},{id:'quota',role:'assistant'}]});assert.equal(ambiguous.read(),null);
});
