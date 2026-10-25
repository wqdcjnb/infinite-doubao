"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

function page(items, delayed) {
  let now = 1000, active = null, sends = 0, current = items;
  const editor = { tagName: "TEXTAREA", value: "" }, mode = { innerText: "云电脑" };
  const button = { disabled: false, getAttribute: () => null, click: () => { sends++; } };
  const rows = items.map(item => ({
    item, dataset: {}, isConnected: true,
    querySelector: () => ({ innerText: item.title }),
    classList: { contains: () => active?.item === item },
    click() { active = this; editor.value = item.prompt; mode.innerText = item.mode || "云电脑"; }
  }));
  const document = {
    querySelector: selector => selector.includes("chat_input_action_mode") ? mode : selector.includes("chat_input_send_button") ? button : editor,
    querySelectorAll: selector => selector.includes("draft-conversation-section") ? rows.filter(row => current.includes(row.item)) : []
  };
  const context = vm.createContext({ window: { auto: {} }, document, CFG: { autoKey: "auto" }, Date: { now: () => now },
    setTimeout: fn => { now += 100; if (delayed && now >= 1600) current = items; fn(); } });
  if (delayed) current = items.slice(0, 1);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/native-drafts.js"), "utf8"), context);
  return { api: context.window.auto, rows, sends: () => sends };
}
const binding = (id, title, prompt) => ({ id, title, prompt, executionMode: "work", index: 0, titles: [title] });
const numberA = "DB-111111111111111111111111", numberB = "DB-222222222222222222222222";
const numbered = (number, body = "相同视频提示词") => `【草稿编号：${number}】\n\n${body}`;

test("编号确定身份，标题后缀和列表顺序改变不影响相同提示词的不同草稿", async () => {
  const p = page([{ title: numbered(numberB, "不同显示标题"), prompt: numbered(numberB) }, { title: numbered(numberA, "新的显示标题"), prompt: numbered(numberA) }]);
  const result = await p.api.restoreNativeDrafts([{ ...binding("a", "旧标题", numbered(numberA)), draftNumber: numberA }]);
  assert.equal(result.ok, true); assert.equal(p.rows[1].dataset.dmDraftId, "a");
  assert.equal((await p.api.openNativeDraft({ id: "a", prompt: numbered(numberA), executionMode: "work" })).ok, true);
  assert.equal(p.sends(), 0);
});
test("侧栏截断编号时打开草稿核对完整编号，相同正文仍可区分", async () => {
  const p = page([{ title: "【草稿编号：DB", prompt: numbered(numberB) }, { title: "【草稿编号：DB", prompt: numbered(numberA) }]);
  assert.equal((await p.api.restoreNativeDrafts([{ ...binding("a", "旧标题", numbered(numberA)), draftNumber: numberA }])).ok, true);
  assert.equal(p.rows[1].dataset.dmDraftId, "a"); assert.equal(p.sends(), 0);
});
test("复制编号导致重复或修改编号时停止，不能回退按标题猜测", async () => {
  for (const shortened of [false, true]) for (const alreadyMapped of [false, true]) {
    const p = page(["正文 A", "正文 B"].map(body => ({ title: shortened ? "【草稿编号：DB" : numbered(numberA, body), prompt: numbered(numberA, body) })));
    if (alreadyMapped) p.rows[0].dataset.dmDraftId = "a";
    const result = await p.api.restoreNativeDrafts([{ ...binding("a", "旧标题", numbered(numberA, "正文 A")), draftNumber: numberA }]);
    assert.equal(result.ok, false); assert.match(result.reason, /重复草稿编号/); assert.equal(p.sends(), 0);
  }
  const p = page([{ title: numbered(numberB), prompt: numbered(numberB) }]);
  assert.equal((await p.api.restoreNativeDrafts([{ ...binding("a", numbered(numberB), numbered(numberA)), draftNumber: numberA }])).ok, false);
  assert.equal(p.sends(), 0);
});

test("新增无关草稿或列表重排后按所选草稿恢复，不依赖旧位置", async () => {
  const p = page([{ title: "新草稿", prompt: "其他内容" }, { title: "原草稿", prompt: "完整任务" }]);
  const result = await p.api.restoreNativeDrafts([binding("a", "原草稿", "完整任务")]);
  assert.equal(result.ok, true); assert.equal(p.rows[1].dataset.dmDraftId, "a");
  assert.equal((await p.api.openNativeDraft({ id: "a", prompt: "完整任务", executionMode: "work" })).ok, true);
  assert.equal(p.sends(), 0);
});
test("同名草稿重排后逐条核对完整提示词，不能只信标题和旧索引", async () => {
  const p = page([{ title: "相同前缀", prompt: "完整任务 B" }, { title: "相同前缀", prompt: "完整任务 A" }]);
  const result = await p.api.restoreNativeDrafts([binding("a", "相同前缀", "完整任务 A"), binding("b", "相同前缀", "完整任务 B")]);
  assert.equal(result.ok, true); assert.equal(p.rows[1].dataset.dmDraftId, "a"); assert.equal(p.rows[0].dataset.dmDraftId, "b");
  assert.equal(p.sends(), 0);
});
test("等所选草稿加载完成，已有无关条目不能提前结束等待", async () => {
  const p = page([{ title: "无关", prompt: "其他" }, { title: "稍后加载", prompt: "完整任务" }], true);
  assert.equal((await p.api.restoreNativeDrafts([binding("a", "稍后加载", "完整任务")])).ok, true);
  assert.equal(p.rows[1].dataset.dmDraftId, "a");
});
test("完全相同提示词无法区分附件时保留草稿，拒绝猜测", async () => {
  const p = page([{ title: "同名", prompt: "相同任务" }, { title: "同名", prompt: "相同任务" }]);
  const result = await p.api.restoreNativeDrafts([binding("a", "同名", "相同任务")]);
  assert.equal(result.ok, false); assert.match(result.reason, /无法区分附件归属/);
  assert.ok(p.rows.every(row => !row.dataset.dmDraftId)); assert.equal(p.sends(), 0);
});
test("草稿被移除或内容被改写时不能触发发送", async () => {
  const missing = page([{ title: "别的草稿", prompt: "其他" }]);
  assert.equal((await missing.api.restoreNativeDrafts([binding("a", "已移除", "原内容")])).ok, false);
  const changed = page([{ title: "同名", prompt: "修改后的内容" }]);
  assert.equal((await changed.api.restoreNativeDrafts([binding("a", "同名", "原内容")])).ok, true);
  assert.equal((await changed.api.openNativeDraft({ id: "a", prompt: "原内容", executionMode: "work" })).ok, false);
  assert.equal((await changed.api.sendNativeDraft({ id: "a", prompt: "原内容" })).ok, false);
  assert.equal(changed.sends(), 0);
});
