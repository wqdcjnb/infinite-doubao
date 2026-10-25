"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
async function save({ stale = false, upload = 0, bodyAfterSwitch = 0 } = {}) {
  let now = 1000, switched = 0, filledAt = 0, current = { tagName: "TEXTAREA", value: "" };
  const prompt = "【草稿编号：DB-111111111111111111111111】 视频", scope = "account-a";
  const metadata = { id: "native", title: prompt, scene: "new-office-task", inputDraftIndex: { accountScope: scope, conversationScope: "local:native", inputId: "primary" } };
  const row = { dataset: {}, querySelector: () => ({ innerText: prompt }), __reactFiber$test: { memoizedProps: { draft: metadata } } };
  const section = { querySelector: () => null }, mode = { innerText: "云电脑" };
  const button = { get disabled() { return now < filledAt + upload; }, getAttribute: () => null };
  const newChat = { innerText: "新对话", click() { switched = now; current.value = ""; } };
  const document = { querySelector: s => s.includes("draft-conversation-section") ? section : s.includes("chat_input_action_mode") ? mode : s.includes("chat_input_send_button") ? button : current,
    querySelectorAll: s => s.includes("draft-conversation-section") ? switched ? [row] : [] : [newChat] };
  function input() {
    const ready = bodyAfterSwitch ? switched && now >= switched + bodyAfterSwitch : now >= filledAt + 200;
    return { state: { accountScope: scope, records: ready ? [{ address: metadata.inputDraftIndex, updatedAt: stale ? 1 : now,
      units: { "input.document": { updatedAt: stale ? 1 : now, payload: { format: "plain-text", text: prompt } } } }] : [] } };
  }
  const indexedDB = { databases: async () => [{ name: "flow-draft-conversations-v2" }, { name: "samantha-web" }], open(name) {
    const q = {}; queueMicrotask(() => { q.result = { close() {}, transaction() {
      const tx = { objectStore: () => ({ get: () => read(input()), getAll: () => read(switched ? [{ accountScope: scope, id: metadata.id, data: metadata }] : []) }) };
      function read(value) { const r = {}; queueMicrotask(() => { r.result = value; r.onsuccess(); queueMicrotask(() => tx.oncomplete()); }); return r; } return tx;
    } }; q.onsuccess(); }); return q;
  } };
  class Clock extends Date { static now() { return now; } }
  const api = { prepareWorkTask: async () => { current = { tagName: "TEXTAREA", value: "", classList: { contains: () => true } }; return { ok: true }; } };
  const context = vm.createContext({ window: { auto: api }, CFG: { autoKey: "auto" }, document, indexedDB, localStorage: { getItem: () => scope }, Date: Clock, clearTimeout,
    setTimeout: (fn, delay) => delay > 100 ? setTimeout(fn, delay) : (now += 100, queueMicrotask(fn)) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/native-drafts.js"), "utf8"), context);
  assert.equal((await api.prepareNativeDraft({ executionMode: "work" })).ok, true);
  const prepareMs = now - 1000; current.value = prompt; filledAt = now;
  const result = await api.saveNativeDraft({ id: "local", prompt, executionMode: "work" });
  assert.equal(result.ok, true, result.reason); assert.equal(result.bindings[0].nativeId, "native");
  return { prepareMs, switchMs: switched - filledAt, savedMs: now - filledAt };
}
test("云电脑编辑器已替换时快速准备；完整正文已落盘可提前确认", async () => {
  const result = await save(); assert.equal(result.prepareMs, 100); assert.equal(result.switchMs, 200);
});
test("旧正文不能触发快速确认，素材上传未完成不能离开输入框", async () => {
  assert.ok((await save({ stale: true })).switchMs >= 600);
  assert.ok((await save({ upload: 900 })).switchMs >= 900);
});
test("侧栏新条目出现后仍核对完整正文落盘，不能提前显示保存成功", async () => {
  const result = await save({ bodyAfterSwitch: 400 }); assert.ok(result.savedMs >= result.switchMs + 400);
});
