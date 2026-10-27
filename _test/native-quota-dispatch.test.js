const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function page({old=false,captcha=false,prompt='original numbered draft'}={}){
 const message='近7天免费额度已用完，预计11月1日00:28恢复。';
 const node={innerText:message,tagName:'P',isConnected:true,getClientRects:()=>[{}],getAttribute:name=>name==='data-message-id'?'new-assistant':name==='data-message-role'?'assistant':null,closest(selector){return selector==='[data-message-id]'||selector==='[data-message-role], [data-role]'?this:null;},querySelectorAll:()=>[]};
 const frame={...node};
 const document={querySelectorAll:q=>q==='p, [data-message-id]'||q==='[data-message-id]'?[node]:q.includes('iframe')&&captcha?[frame]:[]};
 const api={},context=vm.createContext({window:{auto:api},CFG:{autoKey:'auto'},document,location:{pathname:'/chat/new',href:'https://www.doubao.com/chat/new'},getComputedStyle:()=>({display:'block',visibility:'visible'})});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/page/native-drafts.js'),'utf8'),context);
 api.readNativeDeliveryState=()=>({captchaDetected:captcha});
 return api.readNativeQuotaResponse({conversationIds:old?['new']:[],baselineMessageIds:[],prompt});
}
test('an explicit quota response is separate from a user-message receipt',()=>{const r=page();assert.equal(r.quotaLimited,true);assert.equal(r.userMessageId,undefined);assert.equal(r.conversationUrl,'https://www.doubao.com/chat/new');});
test('an old conversation, a still-visible challenge and quoted prompt cannot count as a current quota response',()=>{assert.equal(page({old:true}),null);assert.equal(page({captcha:true}),null);assert.equal(page({prompt:'近7天免费额度已用完，预计11月1日00:28恢复。'}),null);});
