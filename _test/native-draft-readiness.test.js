"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

async function page(options = {}) {
  let now = 1000, sends = 0, active = false, remountBeforeClick = false, clicks = 0;
  const body = "【草稿编号：DB-111111111111111111111111】\n第一段完整提示词\n第二段完整提示词";
  const prompt = (options.skillMention ? "[Seedance 2.5](skill://seedance-25?type=2&id=353376777986)\n" : "") + body;
  const binding = { id: "local-a", nativeId: "native-a", accountScope: "fixture-account", prompt, executionMode: "work" };
  const element = (body = "", attrs = {}) => ({ innerText: body, tagName: "DIV", isConnected: true, children: [], attrs,
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
    getClientRects() { return this.hidden ? [] : [{}]; },
    closest(selector) { return selector === "#input-engine-container" ? root : null; }, querySelectorAll: () => [] });
  const mode = element("云电脑"), button = { ...element("发送"), tagName: "BUTTON", disabled: false, click() { sends++; } };
  const oldEditor = { ...element("旧草稿"), hidden: true }, input = { ...element(""), tagName: "TEXTAREA", value: "" };
  let editors = options.hiddenEditor ? [oldEditor, input] : [input], busy = [];
  const root = { querySelectorAll(selector) {
    if (selector.includes("chat_input_action_mode")) return [mode];
    if (selector.includes("chat_input_send_button")) return [button];
    if (selector.includes("aria-busy")) return busy;
    return [];
  } };
  const meta = { id: "native-a", inputDraftIndex: { accountScope: "fixture-account" } };
  function makeRow() {
    return { ...element(prompt), dataset: {}, __reactFiber$fixture: { memoizedProps: { draft: meta } },
      querySelector: () => element(prompt),
      classList: { contains: () => active && !options.semanticSelection },
      getAttribute(name) { return name === "aria-selected" && options.semanticSelection ? String(active) : null; },
      click() {
        // React delegates the row handler through its connected root.
        if (!this.isConnected) return;
        clicks++;
        active = true; input.value = prompt;
        if (options.skillMention) {
          input.value = "Seedance 2.5\n" + body; input.editor = { getText: () => input.value };
          input.pmViewDesc = { node: { toJSON: () => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { mentionType: "skill", label: "Seedance 2.5", skillId: "seedance-25", skill_type: 2, external_skill_id: options.skillMention === "wrong" ? "other" : "353376777986" } }, { type: "text", text: "\n" + body }] }] }) } };
        }
        if (options.lostFirstSelection && clicks === 1) { active = false; input.value = ""; }
        if (options.remount) { row.isConnected = false; row = makeRow(); }
        options.onOpen?.({ input, mode, button, element, setEditors: value => { editors = value; }, setBusy: value => { busy = value; } });
      }
    };
  }
  let row = makeRow();
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("draft-conversation-section")) {
        const found = row;
        if (remountBeforeClick) {
          remountBeforeClick = false;
          queueMicrotask(() => { found.isConnected = false; row = makeRow(); });
        }
        return [found];
      }
      if (selector.includes("contenteditable")) return editors;
      if (selector.startsWith('a[id^="conversation_')) return [];
      return root.querySelectorAll(selector);
    },
    querySelector(selector) {
      if (selector.includes("draft-conversation-section")) return { querySelector: () => null };
      return this.querySelectorAll(selector)[0] || null;
    }
  };
  class Clock extends Date { static now() { return now; } }
  const api = {};
  const context = vm.createContext({ window: { auto: api }, CFG: { autoKey: "auto" }, document, localStorage: { getItem: () => binding.accountScope }, Date: Clock,
    getComputedStyle: node => ({ display: node.hidden ? "none" : "block", visibility: "visible" }),
    setTimeout(fn, ms) { now += ms; options.tick?.({ now, input, mode, button, setEditors: value => { editors = value; }, setBusy: value => { busy = value; } }); queueMicrotask(fn); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/native-drafts.js"), "utf8"), context);
  const restored = await api.restoreNativeDrafts([binding], { catalog: { accountScope: binding.accountScope, items: [{ ...binding, title: prompt }] } });
  assert.equal(restored.ok, true, restored.reason);
  return { api, binding, input, mode, button, element, row: () => row, sends: () => sends, elapsed: () => now - 1000,
    setEditors: value => { editors = value; }, setBusy: value => { busy = value; }, deselect: () => { active = false; }, remountBeforeClick: () => { remountBeforeClick = true; } };
}

test("Skill首行恢复为富文本卡片时核对真实Skill身份，正确卡片可投递、同名错ID拒绝", async () => {
  const correct = await page({ skillMention: "correct" });
  const result = await correct.api.openNativeDraft(correct.binding);
  assert.equal(result.ok, true, result.reason);
  assert.equal((await correct.api.sendNativeDraft(correct.binding)).ok, true); assert.equal(correct.sends(), 1);
  const wrong = await page({ skillMention: "wrong" });
  assert.equal((await wrong.api.openNativeDraft(wrong.binding)).ok, false); assert.equal(wrong.sends(), 0);
});

test("找到条目后微任务触发React重挂载，不能在await后点击已经脱离DOM的旧行", async () => {
  const p = await page(); p.remountBeforeClick();
  const opened = await p.api.openNativeDraft(p.binding);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal((await p.api.sendNativeDraft(p.binding)).ok, true); assert.equal(p.sends(), 1);
});

test("原生ID重挂载且选中状态改为ARIA时仍能打开正确草稿", async () => {
  const p = await page({ remount: true, semanticSelection: true });
  assert.equal((await p.api.openNativeDraft(p.binding)).ok, true);
  assert.equal((await p.api.sendNativeDraft(p.binding)).ok, true); assert.equal(p.sends(), 1);
});

test("侧栏同步覆盖首次选中后重新按原生ID选择，不在空输入框持续等待", async () => {
  const p = await page({ lostFirstSelection: true, semanticSelection: true });
  const opened = await p.api.openNativeDraft(p.binding);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(p.sends(), 0);
  assert.equal((await p.api.sendNativeDraft(p.binding)).ok, true);
  assert.equal(p.sends(), 1);
});

test("隐藏旧编辑器不能遮挡当前可见编辑器，全文仍逐字核对", async () => {
  const p = await page({ hiddenEditor: true });
  const opened = await p.api.openNativeDraft(p.binding);
  assert.equal(opened.ok, true, opened.reason);
  p.input.value = p.binding.prompt.slice(0, -2);
  const result = await p.api.sendNativeDraft(p.binding);
  assert.equal(result.ok, false); assert.match(result.reason, /完整提示词不一致.*预期.*当前/); assert.equal(p.sends(), 0);
});

test("多个可见编辑器即使其中一个全文相符也必须拒绝，不能挑一个猜测", async () => {
  const p = await page({ onOpen({ input, element, setEditors }) { setEditors([input, element("其他任务")]); } });
  const result = await p.api.openNativeDraft(p.binding);
  assert.equal(result.ok, false); assert.match(result.reason, /多个可见输入框/); assert.equal(p.sends(), 0);
});

test("云电脑标签附有独立状态文案时核对精确可见标签，不误判整个按钮文本", async () => {
  const p = await page({ onOpen({ mode, element }) { mode.innerText = "云电脑 当前模式"; mode.querySelectorAll = () => [element("云电脑"), element("当前模式")]; } });
  assert.equal((await p.api.openNativeDraft(p.binding)).ok, true);
  assert.equal((await p.api.sendNativeDraft(p.binding)).ok, true); assert.equal(p.sends(), 1);
});

test("隐藏的云电脑菜单选项不能冒充当前模式，发送前再次检查模式", async () => {
  const p = await page(); assert.equal((await p.api.openNativeDraft(p.binding)).ok, true);
  p.mode.innerText = "对话"; p.mode.querySelectorAll = () => [{ ...p.element("云电脑"), hidden: true }];
  const result = await p.api.sendNativeDraft(p.binding);
  assert.equal(result.ok, false); assert.match(result.reason, /工作模式未就绪.*对话/); assert.equal(p.sends(), 0);
});

test("发送按钮提前启用仍等待附件进度完成，并在发送前重新检查", async () => {
  const p = await page({ onOpen({ element, setBusy }) { setBusy([element("", { role: "progressbar", "aria-valuenow": "40", "aria-valuemax": "100" })]); },
    tick({ now, setBusy }) { if (now >= 1800) setBusy([]); } });
  assert.equal((await p.api.openNativeDraft(p.binding)).ok, true); assert.ok(p.elapsed() >= 1400);
  p.setBusy([p.element("", { "aria-busy": "true" })]);
  const result = await p.api.sendNativeDraft(p.binding);
  assert.equal(result.ok, false); assert.match(result.reason, /素材仍在上传/); assert.equal(p.sends(), 0);
});

test("富文本多段以编辑器实际文档核对，DOM旧文本不能掩盖文档未同步", async () => {
  const p = await page({ onOpen({ input }) { input.tagName = "DIV"; input.innerText = "显示层装饰文字"; input.editor = { getText: () => input.value }; } });
  assert.equal((await p.api.openNativeDraft(p.binding)).ok, true);
  p.input.innerText = p.binding.prompt; p.input.editor.getText = () => "尚未同步的正文";
  const result = await p.api.sendNativeDraft(p.binding);
  assert.equal(result.ok, false); assert.match(result.reason, /完整提示词不一致/); assert.equal(p.sends(), 0);
});

test("准备后选中项变更或发送按钮禁用时给出具体失败项，绝不点击", async () => {
  const p = await page({ semanticSelection: true }); assert.equal((await p.api.openNativeDraft(p.binding)).ok, true);
  p.deselect(); p.button.disabled = true;
  const result = await p.api.sendNativeDraft(p.binding);
  assert.equal(result.ok, false); assert.match(result.reason, /草稿尚未选中/); assert.match(result.reason, /发送按钮仍不可用/); assert.equal(p.sends(), 0);
});
