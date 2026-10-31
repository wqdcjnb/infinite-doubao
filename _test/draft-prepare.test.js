"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

for (const [entryLabel, modeLabel] of [["新工作任务", "云电脑"], ["新工作任務 Ctrl J", "雲端電腦"], ["新工作任務", "雲電腦"]]) test(`旧会话没有输入框时先打开工作任务，支持 ${entryLabel} / ${modeLabel}`, async () => {
  let mounted = false, now = 0, clicks = 0;
  const location = { pathname: "/chat/old-conversation", href: "https://www.doubao.com/chat/old-conversation" };
  const node = text => ({ innerText: text, isConnected: true, getBoundingClientRect: () => ({ width: 600, height: 100 }), getAttribute: () => null, dispatchEvent() {} });
  const input = { ...node(""), tagName: "TEXTAREA", value: "" }, mode = node(modeLabel);
  const entry = { ...node(entryLabel), click() { clicks++; mounted = true; location.pathname = "/chat/"; location.href = "https://www.doubao.com/chat/"; } };
  const root = { querySelectorAll(selector) {
    if (!mounted) return [];
    if (selector.includes("chat_input_action_mode")) return [mode];
    if (selector.includes("textarea")) return [input];
    return [];
  } };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("draft-conversation-section")) return [];
      if (selector === "#input-engine-container") return mounted ? [root] : [];
      if (selector.includes("role=\"button\"")) return [entry];
      return [];
    },
    querySelector(selector) {
      if (selector.includes("draft-conversation-section")) return null;
      if (selector.includes("chat_input_action_mode")) return mounted ? mode : null;
      return mounted ? input : null;
    }
  };
  Object.assign(root, node(""));
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ window: { auto: {} }, CFG: { autoKey: "auto" }, document, location,
    Date: Clock, getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    MouseEvent: class {}, PointerEvent: class {}, setTimeout(fn, ms) { now += ms; queueMicrotask(fn); } });
  for (const name of ["generation-options.js", "native-drafts.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page", name), "utf8"), context);
  const result = await context.window.auto.prepareNativeDraft({ executionMode: "work" });
  assert.equal(result.ok, true, result.reason); assert.equal(clicks, 1); assert.equal(mounted, true);
  assert.ok(now < 2000, "must not wait for the old missing composer");
});

test("云电脑标签先出现、富文本编辑器后挂载时，不能把过渡输入框当作准备完成", async () => {
  let now = 1000, switching = false;
  const old = { tagName: "TEXTAREA", value: "" }, placeholder = { tagName: "TEXTAREA", value: "", classList: { contains: () => false } };
  const rich = { tagName: "DIV", innerText: "", classList: { contains: () => true } };
  const current = () => !switching ? old : now < 1400 ? placeholder : rich;
  const api = { prepareWorkTask: async () => { switching = true; return { ok: true }; } };
  const document = { querySelector: s => s.includes("draft-conversation-section") ? null : s.includes("chat_input_action_mode") ? { innerText: "云电脑" } : current(), querySelectorAll: () => [] };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ window: { auto: api }, CFG: { autoKey: "auto" }, document, Date: Clock, setTimeout(fn, ms) { now += ms; queueMicrotask(fn); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/native-drafts.js"), "utf8"), context);
  const result = await api.prepareNativeDraft({ executionMode: "work" });
  assert.equal(result.ok, true, result.reason); assert.equal(current(), rich); assert.equal(now, 1500);
});

test("工作模式在打开选择器期间已切为云电脑时，不再等待不存在的菜单选项", async () => {
  let now=0,started=false,selected=false;
  const node=text=>({innerText:text,isConnected:true,getBoundingClientRect:()=>({width:600,height:100}),getAttribute:()=>null,dispatchEvent(){}});
  const input={...node(''),value:''},mode=node('对话');
  mode.click=()=>{selected=true;mode.innerText='云电脑';};
  const entry={...node('新工作任务'),click(){started=true;mode.innerText='本机电脑';}};
  const root={...node(''),querySelectorAll(selector){if(selector.includes('chat_input_action_mode'))return [mode];if(selector.includes('textarea'))return [input];return [];}};
  const document={querySelectorAll(selector){if(selector==='#input-engine-container')return [root];if(selector.includes('menuitem'))return [];if(selector.includes('role="button"'))return [entry];return [];}};
  class Clock extends Date{static now(){return now;}}
  const context=vm.createContext({window:{auto:{}},CFG:{autoKey:'auto'},document,location:{pathname:'/chat/',href:'https://www.doubao.com/chat/'},Date:Clock,getComputedStyle:()=>({display:'block',visibility:'visible'}),MouseEvent:class{},PointerEvent:class{},setTimeout(fn,ms){now+=ms;queueMicrotask(fn);}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/page/generation-options.js'),'utf8'),context);
  const result=await context.window.auto.prepareWorkTask();
  assert.equal(result.ok,true,result.reason);assert.equal(started,true);assert.equal(selected,true);assert.ok(now<20000);
});

test("繁体云端电脑入口出现订阅提示时停止，不能点击付费选项", async () => {
  let now = 0, paidClicks = 0;
  const node = text => ({ innerText: text, isConnected: true, getBoundingClientRect: () => ({ width: 600, height: 100 }), getAttribute: () => null, dispatchEvent() {} });
  const input = { ...node(""), value: "" }, mode = { ...node("對話"), click() {} };
  const entry = { ...node("新工作任務"), click() { mode.innerText = "本機電腦"; } };
  const paid = { ...node("雲端電腦 訂閱"), click() { paidClicks++; mode.innerText = "雲端電腦"; } };
  const root = { ...node(""), querySelectorAll(selector) { return selector.includes("chat_input_action_mode") ? [mode] : selector.includes("textarea") ? [input] : []; } };
  const document = { querySelectorAll(selector) {
    if (selector === "#input-engine-container") return [root];
    if (selector.includes("menuitem")) return [paid];
    return selector.includes('role="button"') ? [entry] : [];
  } };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ window: { auto: {} }, CFG: { autoKey: "auto" }, document, location: { pathname: "/chat/", href: "https://www.doubao.com/chat/" }, Date: Clock,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }), MouseEvent: class {}, PointerEvent: class {}, setTimeout(fn, ms) { now += ms; queueMicrotask(fn); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/generation-options.js"), "utf8"), context);
  const result = await context.window.auto.prepareWorkTask();
  assert.equal(result.ok, false); assert.match(result.reason, /不可用/); assert.equal(paidClicks, 0);
});
