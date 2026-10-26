"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
function fixture({ delay = 0, accepted = true, changeText = false, remount = false, guidance = false } = {}) {
  let now = 1000, dispatched = 0, wrongInput = 0, focused = 0;
  let editor = { tagName: "TEXTAREA", value: "完整草稿正文", closest: selector => selector === "#input-engine-container" ? root : null, focus() { focused++; if (guidance) editor = { ...editor, classList: { contains: name => name === "ProseMirror" } }; } };
  const input = { multiple: true, disabled: false, getAttribute: () => "image/*", dispatchEvent(e) { if (e.type === "change") { dispatched++; if (changeText) editor.value = "其他草稿"; if (remount) editor = { ...editor }; } } };
  const stale = { ...input, dispatchEvent() { wrongInput++; } };
  const root = { querySelectorAll: () => guidance && !focused ? [] : [input] };
  const cards = () => dispatched && accepted && now >= 1000 + delay ? ["a.png", "b.png"].map(name => ({ getAttribute: () => name, __reactFiber$test: { memoizedProps: { attachmentState: { fileName: name, fileKey: "key", status: "Normal" } } } })) : [];
  const api = {}, document = { querySelector: s => s.includes("chat_input_action_mode") ? { innerText: "云电脑" } : editor,
    querySelectorAll: s => s.includes("attachment_area") ? cards() : s.includes("input") ? [stale, input] : [] };
  class Clock extends Date { static now() { return now; } }
  class DataTransfer { constructor() { this.files = []; this.items = { add: f => this.files.push(f) }; } }
  const ctx = vm.createContext({ window: { auto: api }, CFG: { autoKey: "auto" }, document, Date: Clock, DataTransfer, File: class { constructor(_bytes, name, options) { Object.assign(this, { name, type: options.type }); } },
    Event: class { constructor(type) { this.type = type; } }, atob: value => Buffer.from(value, "base64").toString("binary"), Uint8Array,
    clearTimeout, setTimeout: fn => { now += 100; queueMicrotask(fn); } });
  vm.runInContext(fs.readFileSync(require.resolve("../src/page/native-drafts.js"), "utf8"), ctx);
  return { api, options: { prompt: "完整草稿正文", executionMode: "work", attachmentNames: ["a.png", "b.png"] },
    files: ["a.png", "b.png"].map(name => ({ name, dataUrl: "data:image/png;base64,AQ==" })), state: () => ({ elapsed: now - 1000, dispatched, wrongInput, focused }) };
}
test("草稿上传只交给当前输入区，等完整附件清单出现才返回", async () => {
  const f = fixture({ delay: 1700 });
  const result = await f.api.pasteNativeDraftFiles(f.files, f.options);
  assert.equal(result.ok, true, result.reason);
  assert.ok(f.state().elapsed >= 1700); assert.equal(f.state().dispatched, 1); assert.equal(f.state().wrongInput, 0);
});
test("网页未接收附件时返回当前数量，不把已派发文件事件当成功", async () => {
  const f = fixture({ accepted: false });
  const result = await f.api.pasteNativeDraftFiles(f.files, f.options);
  assert.equal(result.ok, false); assert.match(result.reason, /0.*2/); assert.equal(f.state().dispatched, 1);
});
test("上传期间正文变化即失败，禁止归入另一条草稿", async () => {
  const f = fixture({ changeText: true });
  const result = await f.api.pasteNativeDraftFiles(f.files, f.options);
  assert.equal(result.ok, false); assert.match(result.reason, /正文.*变化/);
});
test("图片触发输入框重挂载时按完整正文确认同一草稿，不因DOM节点替换误报", async () => {
  const f = fixture({ remount: true, delay: 900 });
  const result = await f.api.pasteNativeDraftFiles(f.files, f.options);
  assert.equal(result.ok, true, result.reason); assert.equal(f.state().dispatched, 1);
});
test("新建草稿的引导输入框先激活为可接收附件的编辑器，再交付图片", async () => {
  const f = fixture({ guidance: true });
  const result = await f.api.pasteNativeDraftFiles(f.files, f.options);
  assert.equal(result.ok, true, result.reason); assert.equal(f.state().focused, 1); assert.equal(f.state().dispatched, 1);
});
