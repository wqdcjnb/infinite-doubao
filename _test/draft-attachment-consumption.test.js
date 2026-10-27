"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");

async function acceptance({clearAt=2000,mounted=true,hiddenCard=false,remountRoot=false,rootGap=false,receiptGap=false,attachmentNames=Array.from({length:5},(_,i)=>"reference-"+i+".png")}={}) {
  let now=0,reads=0;
  const card={isConnected:true,hidden:hiddenCard,getAttribute:()=>null,getClientRects:()=>[{}],closest:()=>null};
  const editor={tagName:"TEXTAREA",value:"",closest:selector=>selector==="#input-engine-container"?getRoot():null};
  const root={isConnected:true,getClientRects:()=>[{}],closest:()=>null,querySelectorAll:s=>s.includes("attachment_area")&&now<clearAt?[card]:[]};
  const roots=[root,{...root},{...root}];
  const getRoot=()=>!mounted||rootGap&&now===250?null:remountRoot?roots[Math.min(2,Math.floor(now/250))]:root;
  const api={},document={querySelector:s=>s==="#input-engine-container"?getRoot():editor,
    querySelectorAll:s=>s.includes("attachment_area")?root.querySelectorAll(s):[]};
  class Clock extends Date {static now(){return now;}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../src/page/native-drafts.js"),"utf8"),{
    window:{auto:api},CFG:{autoKey:"auto"},document,Date:Clock,getComputedStyle:()=>({display:"block",visibility:"visible"}),
    setTimeout(fn,ms){now+=ms;queueMicrotask(fn);}
  });
  api.readNativeDraftReceipt=()=>{reads++;return receiptGap&&now===250?{ok:false}:{ok:true,conversationUrl:"https://www.doubao.com/chat/original",userMessageId:"original-user"};};
  const result=await api.waitNativeDraftAccepted({attachmentNames});return {result,now,reads};
}

test("文字回执先到但附件仍在输入框时等待附件消耗，不提前放行关页",async()=>{
  const {result,now,reads}=await acceptance();assert.equal(result.ok,true);assert.ok(now>=2000);assert.ok(reads>1);
  assert.equal(result.attachmentConsumptionProof.version,1);assert.equal(result.attachmentConsumptionProof.names.length,5);
  assert.equal(result.attachmentConsumptionProof.userMessageId,"original-user");
});
test("附件一直残留时保留待核验标记，不把文字回执算完整提交",async()=>{
  const {result,now}=await acceptance({clearAt:Infinity});assert.equal(result.ok,false);assert.equal(result.attachmentsPending,true);assert.match(result.reason,/附件/);assert.equal(now,120000);
});
test("输入区未挂载不能用空查询结果冒充附件清空",async()=>{
  const {result}=await acceptance({mounted:false,clearAt:0});assert.equal(result.ok,false);assert.equal(result.attachmentsPending,true);
});
test("无附件草稿沿用原消息回执，不引入额外等待",async()=>{
  const {result,now}=await acceptance({attachmentNames:[]});assert.equal(result.ok,true);assert.equal(now,0);
});
test("当前输入根仍有隐藏附件时不能视为清空",async()=>{
  const {result}=await acceptance({clearAt:Infinity,hiddenCard:true});assert.equal(result.ok,false);assert.equal(result.attachmentsPending,true);
});
for(const variant of ["remountRoot","rootGap","receiptGap"])test("附件清空稳定窗口在"+variant+"后重新计时",async()=>{
  const {result,now}=await acceptance({clearAt:0,[variant]:true});assert.equal(result.ok,true);assert.ok(now>=1000);
});
