"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function page({clearAt=180000,attachmentNames=[],userPresent=true,conversation='verified',replacement=false}={}) {
  let now=0,reads=0;
  const prompt='【草稿编号：DB-111111111111111111111111】\n原任务提示词';
  const visible=()=>now<clearAt||replacement&&now>=clearAt+250&&now<clearAt+1250;
  const container={isConnected:true,getClientRects:()=>[{}],closest:()=>null};
  const frame={...container,getBoundingClientRect:()=>({left:100,top:100,right:400,bottom:250,width:300,height:150}),getAttribute:()=> 'https://rmc.bytedance.com/verifycenter/captcha/v2'};
  const user={innerText:prompt,textContent:prompt,getAttribute:key=>key==='data-message-id'?'original-user':null,closest:()=>({getAttribute:key=>key==='data-message-role'?'user':null})};
  const assistant={innerText:'Hello～有什么我可以帮你的吗？',getAttribute:key=>key==='data-message-id'?'new-assistant':null,closest:()=>({getAttribute:key=>key==='data-message-role'?'assistant':null})};
  const root={...container,querySelectorAll:()=>[]};
  const editor={...container,tagName:'TEXTAREA',value:'',closest:s=>s==='#input-engine-container'?root:null};
  const document={activeElement:null,documentElement:{clientWidth:1000,clientHeight:800},
    querySelector:s=>s==='#input-engine-container'?root:editor,
    querySelectorAll:s=>s.includes('verifycenter/captcha')?[frame]:s.includes('captcha_container')?[container]:s==='[data-message-id]'?(reads++,userPresent?[user,assistant]:[assistant]):[],
    elementFromPoint:()=>frame};
  const api={};class Clock extends Date{static now(){return now;}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/page/native-drafts.js'),'utf8'),{
    window:{auto:api,innerWidth:1000,innerHeight:800,crypto:require('node:crypto').webcrypto},CFG:{autoKey:'auto'},document,
    location:{pathname:'/chat/'+conversation,href:'https://www.doubao.com/chat/'+conversation},Date:Clock,
    getComputedStyle:n=>({display:n===container&&!visible()?'none':'block',visibility:n===frame&&(now<clearAt-2000||!visible())?'hidden':'visible',opacity:'1'}),
    setTimeout(fn,ms){now+=ms;queueMicrotask(fn);}
  });
  return {api,options:{id:'original-draft',prompt,conversationIds:[],baselineMessageIds:[],attachmentNames},now:()=>now,reads:()=>reads};
}

test('original text receipt cannot be accepted while a mask-only verification is still pending',()=>{
  const p=page();assert.equal(p.api.readNativeDraftReceipt(p.options).ok,false);
});
test('text-only original receipt waits past the old timeout for human clearance and then verifies without a resend',async()=>{
  const p=page();const result=await p.api.waitNativeDraftAccepted(p.options);
  assert.equal(result.ok,true,result.reason);assert.equal(result.userMessageId,'original-user');assert.ok(p.now()>=180000);
});
test('five-reference acceptance waits through delayed verification and a replacement mask before proving consumption',async()=>{
  const p=page({attachmentNames:['a.png','b.png','c.png','d.png','e.png'],replacement:true});
  const result=await p.api.waitNativeDraftAccepted(p.options);assert.equal(result.ok,true,result.reason);
  assert.equal(result.attachmentConsumptionProof.userMessageId,'original-user');assert.deepEqual(Array.from(result.attachmentConsumptionProof.names),['a.png','b.png','c.png','d.png','e.png']);
  assert.ok(p.now()>=181750,'second mask must reset the stable empty-composer window');
});
test('assistant reply without the original user identity remains unknown after verification rather than claiming delivery',async()=>{
  const p=page({userPresent:false});const result=await p.api.waitNativeDraftAccepted(p.options);
  assert.equal(result.ok,false);assert.match(result.reason,/未确认|接收|核对/);assert.ok(p.now()>=300000,'verification wait is excluded from the original-receipt budget');assert.ok(p.reads()>0);
});
test('local optimistic conversation cannot establish an original message receipt after verification',async()=>{
  const p=page({clearAt:0,conversation:'local_12345'});assert.equal(p.api.readNativeDraftReceipt(p.options).ok,false);
});
