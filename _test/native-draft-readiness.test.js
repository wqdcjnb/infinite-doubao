"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

async function page(options = {}) {
  let now = 1000, sends = 0, active = false, remountBeforeClick = false, clicks = 0;
  const prompt = "【草稿编号：DB-111111111111111111111111】\n第一段完整提示词\n第二段完整提示词";
  const binding = { id: "local-a", nativeId: "native-a", accountScope: "fixture-account", prompt, executionMode: "work" };
  if (Object.hasOwn(options, "attachmentNames")) binding.attachmentNames = options.attachmentNames;
  const element = (body = "", attrs = {}) => ({ innerText: body, tagName: "DIV", isConnected: true, children: [], attrs,
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
    getClientRects() { return this.hidden ? [] : [{}]; },
    closest(selector) { return selector === "#input-engine-container" ? root : null; }, querySelectorAll: () => [] });
  const mode = element("云电脑"), button = { ...element("发送"), tagName: "BUTTON", disabled: false, click() { sends++; } };
  const oldEditor = { ...element("旧草稿"), hidden: true }, input = { ...element(""), tagName: "TEXTAREA", value: "" };
  let editors = options.hiddenEditor ? [oldEditor, input] : [input], busy = [], cards = [];
  function attachment(name, changes = {}) {
    const card = element("", { "aria-label": name, "data-kind": "image" });
    const state = { fileName: name, fileKey: "file-" + name, status: "Normal", ...changes };
    if (!changes.withoutState) {
      const current = { memoizedProps: { attachmentState: state } };
      card.__reactFiber$fixture = current;
      if (changes.staleReady !== undefined) {
        const oldRoot = {}, currentRoot = {}; oldRoot.stateNode = currentRoot.stateNode = { current: currentRoot };
        const old = { return: oldRoot, alternate: current, memoizedProps: { attachmentState: { fileName: name, fileKey: changes.staleReady ? "stale-key" : "", status: changes.staleReady ? "Normal" : "Uploading" } } };
        current.return = currentRoot; current.alternate = old; currentRoot.child = current; card.__reactFiber$fixture = old;
      }
    }
    return card;
  }
  const root = { querySelectorAll(selector) {
    if (selector.includes("chat_input_action_mode")) return [mode];
    if (selector.includes("chat_input_send_button")) return [button];
    if (selector.includes("aria-busy")) return busy;
    if (selector.includes("attachment_area")) return cards;
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
        if (options.lostFirstSelection && clicks === 1) { active = false; input.value = ""; }
        if (options.remount) { row.isConnected = false; row = makeRow(); }
        options.onOpen?.({ input, mode, button, element, attachment, setCards: value => { cards = value; }, setEditors: value => { editors = value; }, setBusy: value => { busy = value; } });
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
    setTimeout(fn, ms) { now += ms; options.tick?.({ now, input, mode, button, attachment, setCards: value => { cards = value; }, setEditors: value => { editors = value; }, setBusy: value => { busy = value; } }); queueMicrotask(fn); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/native-drafts.js"), "utf8"), context);
  const restored = await api.restoreNativeDrafts([binding], { catalog: { accountScope: binding.accountScope, items: [{ ...binding, title: prompt }] } });
  assert.equal(restored.ok, true, restored.reason);
  return { api, binding, input, mode, button, element, attachment, setCards: value => { cards = value; }, row: () => row, sends: () => sends, elapsed: () => now - 1000,
    setEditors: value => { editors = value; }, setBusy: value => { busy = value; }, deselect: () => { active = false; }, remountBeforeClick: () => { remountBeforeClick = true; } };
}

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

for (const label of ["雲端電腦", "雲電腦", "云端电脑"]) test(`繁简体模式 ${label} 可以打开并核对原草稿，正文仍逐字检查`, async () => {
  const p = await page({ onOpen({ mode }) { mode.innerText = label; } });
  assert.equal((await p.api.openNativeDraft(p.binding)).ok, true);
  p.input.value = p.binding.prompt.replace("第一段", "第壹段");
  assert.equal((await p.api.sendNativeDraft(p.binding)).ok, false);
  assert.equal(p.sends(), 0);
  p.input.value = p.binding.prompt;
  assert.equal((await p.api.sendNativeDraft(p.binding)).ok, true);
  assert.equal(p.sends(), 1);
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

const attachmentNames = ["1.png", "2.png", "3.png", "4.png", "5.png"];

test("第五张附件晚挂载时，必须全齐并稳定600毫秒才允许发送", async () => {
  const p = await page({ attachmentNames,
    onOpen({ attachment, setCards }) { setCards(attachmentNames.slice(0, 4).map(name => attachment(name))); },
    tick({ now, attachment, setCards }) { if (now >= 1800) setCards(attachmentNames.map(name => attachment(name))); }
  });
  const opened = await p.api.openNativeDraft(p.binding);
  assert.equal(opened.ok, true, opened.reason); assert.ok(p.elapsed() >= 1400, "fifth attachment must be stable from 1800 through 2400"); assert.equal(p.sends(), 0);
  assert.equal((await p.api.sendNativeDraft(p.binding)).ok, true); assert.equal(p.sends(), 1);
});

test("第五张的当前React状态未Normal或缺少正确fileKey和fileName时禁止发送", async () => {
  for (const changes of [{ status: "Uploading" }, { status: "Error" }, { fileKey: "" }, { fileName: "wrong.png" }, { withoutState: true }]) {
    const p = await page({ attachmentNames, onOpen({ attachment, setCards }) { setCards(attachmentNames.map((name, index) => attachment(name, index === 4 ? changes : {}))); } });
    const opened = await p.api.openNativeDraft(p.binding); assert.equal(opened.ok, false); assert.match(opened.reason, /附件/);
    const result = await p.api.sendNativeDraft(p.binding); assert.equal(result.ok, false); assert.match(result.reason, /附件/); assert.equal(p.sends(), 0);
  }
});

test("附件名称顺序数量必须逐项一致，同数量错图和额外残留都禁止发送", async () => {
  for (const names of [attachmentNames.slice(0, 4), [...attachmentNames, "6.png"], ["2.png", "1.png", ...attachmentNames.slice(2)], [...attachmentNames.slice(0, 4), "wrong.png"]]) {
    const p = await page({ attachmentNames, onOpen({ attachment, setCards }) { setCards(names.map(name => attachment(name))); } });
    assert.equal((await p.api.openNativeDraft(p.binding)).ok, false);
    const result = await p.api.sendNativeDraft(p.binding); assert.equal(result.ok, false); assert.match(result.reason, /附件/); assert.equal(p.sends(), 0);
  }
});

test("旧React分支的Normal不能绕过当前分支仍上传，当前Normal也不被旧Uploading阻塞", async () => {
  for (const staleReady of [true, false]) {
    const p = await page({ attachmentNames,
      onOpen({ attachment, setCards }) { setCards(attachmentNames.map((name, index) => attachment(name, index === 4 ? { staleReady, status: staleReady ? "Uploading" : "Normal" } : {}))); },
      tick({ now, attachment, setCards }) { if (staleReady && now >= 2000) setCards(attachmentNames.map(name => attachment(name, { staleReady: true }))); }
    });
    const opened = await p.api.openNativeDraft(p.binding); assert.equal(opened.ok, true, opened.reason);
    assert.ok(staleReady ? p.elapsed() >= 1600 : p.elapsed() < 1600);
    assert.equal((await p.api.sendNativeDraft(p.binding)).ok, true); assert.equal(p.sends(), 1);
  }
});

test("已就绪后发送前第五张变名换key或重新上传，均拒绝点击且不能复用旧稳定证明", async () => {
  for (const changes of [{ fileName: "wrong.png" }, { fileKey: "replacement-key" }, { status: "Uploading" }]) {
    const p = await page({ attachmentNames, onOpen({ attachment, setCards }) { setCards(attachmentNames.map(name => attachment(name))); } });
    assert.equal((await p.api.openNativeDraft(p.binding)).ok, true);
    p.setCards(attachmentNames.map((name, index) => p.attachment(name, index === 4 ? changes : {})));
    const result = await p.api.sendNativeDraft(p.binding); assert.equal(result.ok, false); assert.match(result.reason, /附件/); assert.equal(p.sends(), 0);
  }
});

test("附件都Normal但稳定窗口中第五张fileKey改变，稳定计时从变化后重新开始", async () => {
  const p = await page({ attachmentNames,
    onOpen({ attachment, setCards }) { setCards(attachmentNames.map(name => attachment(name))); },
    tick({ now, attachment, setCards }) { if (now >= 1400) setCards(attachmentNames.map((name, index) => attachment(name, index === 4 ? { fileKey: "replacement-key" } : {}))); }
  });
  const opened = await p.api.openNativeDraft(p.binding); assert.equal(opened.ok, true, opened.reason); assert.ok(p.elapsed() >= 1000);
  assert.equal((await p.api.sendNativeDraft(p.binding)).ok, true); assert.equal(p.sends(), 1);
});

test("明确零附件时残留附件阻止发送，清单为空且页面为空时可发送", async () => {
  const residual = await page({ attachmentNames: [], onOpen({ attachment, setCards }) { setCards([attachment("residual.png")]); } });
  assert.equal((await residual.api.openNativeDraft(residual.binding)).ok, false);
  assert.equal((await residual.api.sendNativeDraft(residual.binding)).ok, false); assert.equal(residual.sends(), 0);
  const empty = await page({ attachmentNames: [] }); assert.equal((await empty.api.openNativeDraft(empty.binding)).ok, true);
  assert.equal((await empty.api.sendNativeDraft(empty.binding)).ok, true); assert.equal(empty.sends(), 1);
});

test("明确附件清单必须先完成稳定核对，未提供清单的旧纯文本调用保持兼容", async () => {
  const strict = await page({ attachmentNames, onOpen({ attachment, setCards }) { setCards(attachmentNames.map(name => attachment(name))); } });
  strict.row().click();
  const blocked = await strict.api.sendNativeDraft(strict.binding); assert.equal(blocked.ok, false); assert.match(blocked.reason, /附件.*稳定|稳定.*附件/); assert.equal(strict.sends(), 0);
  assert.equal((await strict.api.openNativeDraft(strict.binding)).ok, true); assert.equal((await strict.api.sendNativeDraft(strict.binding)).ok, true);
  const legacy = await page(); legacy.row().click(); assert.equal((await legacy.api.sendNativeDraft(legacy.binding)).ok, true); assert.equal(legacy.sends(), 1);
});

test("发送前读取按钮状态时第五张被瞬间替换，最终附件重查仍须阻止click", async () => {
  const p = await page({ attachmentNames, onOpen({ attachment, setCards }) { setCards(attachmentNames.map(name => attachment(name))); } });
  assert.equal((await p.api.openNativeDraft(p.binding)).ok, true);
  const getAttribute = p.button.getAttribute.bind(p.button); let replaced = false;
  p.button.getAttribute = name => {
    if (!replaced) { replaced = true; p.setCards(attachmentNames.map((fileName, index) => p.attachment(fileName, index === 4 ? { fileKey: "last-instant-key" } : {}))); }
    return getAttribute(name);
  };
  const result = await p.api.sendNativeDraft(p.binding); assert.equal(result.ok, false); assert.match(result.reason, /附件/); assert.equal(p.sends(), 0);
});

test("五图实际点击回执包含同一稳定附件的名称与fileKey证明", async () => {
  const p=await page({attachmentNames,onOpen({attachment,setCards}){setCards(attachmentNames.map(name=>attachment(name)));}});
  assert.equal((await p.api.openNativeDraft(p.binding)).ok,true);
  const result=await p.api.sendNativeDraft(p.binding);assert.equal(result.ok,true);assert.equal(p.sends(),1);
  assert.ok(result.attachmentProof,'clicked receipt omitted the current five-image proof');
  assert.deepEqual(JSON.parse(JSON.stringify(result.attachmentProof)),{version:1,names:attachmentNames,fileKeys:attachmentNames.map(name=>'file-'+name)});
});
