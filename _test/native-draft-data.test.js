"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

function page({ collapsed = false, duplicate = false, missingBody = false, wrongScope = false } = {}) {
  let now = 1000, expanded = false, active = null, sends = 0, reads = 0;
  const items = Array.from({ length: 50 }, (_, i) => {
    const draftNumber = "DB-" + (duplicate && i === 49 ? 0 : i).toString(16).toUpperCase().padStart(24, "0");
    return { id: "local-" + i, draftNumber, prompt: `【草稿编号：${draftNumber}】\n\n完全相同的视频正文`, scope: "account-a" };
  });
  const input = { state: { accountScope: wrongScope ? "account-b" : "account-a", records: items.map((d, i) => ({
    address: { accountScope: d.scope, conversationScope: "local:" + d.id, inputId: "primary" },
    units: { "input.document": { tombstone: missingBody && i === 49, payload: { format: "canonical-v2", plainTextFallback: d.prompt } } }
  })) } };
  const index = items.map(d => ({ accountScope: d.scope, id: d.id, data: { id: d.id, title: "相同且截断的标题", scene: "new-office-task", inputDraftIndex: { accountScope: d.scope, conversationScope: "local:" + d.id, inputId: "primary" } } }));
  // Old account data and deleted records must not participate in matching.
  index.push({ ...index[0], accountScope: "account-b" }, { ...index[0], id: "deleted", deleted: true });
  const editor = { tagName: "TEXTAREA", value: "" }, mode = { innerText: "云电脑" };
  const button = { disabled: false, getAttribute: () => null, click: () => sends++ };
  const rows = items.map((d, i) => ({
    dataset: {}, isConnected: true, querySelector: () => ({ innerText: "【草稿编号：DB" }),
    __reactFiber$test: { memoizedProps: { draft: index[i].data } },
    classList: { contains: () => active === d.id }, click() { active = d.id; editor.value = d.prompt; }
  }));
  const visible = () => collapsed ? [] : rows.slice(0, expanded ? 50 : 5);
  const more = { isConnected: true, click() { expanded = true; this.isConnected = false; } };
  const section = { querySelector: s => s.includes("section-header") ? { click: () => { collapsed = false; } } : expanded ? null : more };
  const document = {
    querySelector: s => s.includes("draft-conversation-section") ? section : s.includes("chat_input_action_mode") ? mode : s.includes("chat_input_send_button") ? button : editor,
    querySelectorAll: s => s.includes("draft-conversation-section") ? visible() : []
  };
  const indexedDB = {
    databases: async () => [{ name: "flow-draft-conversations-v2" }, { name: "samantha-web" }],
    open(name) {
      const request = {};
      queueMicrotask(() => {
        request.result = { close() {}, transaction(storeName, access) {
          assert.equal(access, "readonly"); reads++;
          const tx = { objectStore() { return { getAll: () => read(index), get: key => { assert.equal(key, "input-engine-draft:v3:account:account-a"); return read(input); } }; } };
          function read(value) { const q = {}; queueMicrotask(() => { q.result = value; q.onsuccess(); queueMicrotask(() => tx.oncomplete()); }); return q; }
          assert.equal(storeName, name === "samantha-web" ? "store" : "drafts"); return tx;
        } }; request.onsuccess();
      }); return request;
    }
  };
  class TestDate extends Date { static now() { return now; } }
  const context = vm.createContext({ window: { auto: {} }, document, indexedDB, CFG: { autoKey: "auto" }, Date: TestDate, clearTimeout,
    setTimeout: (fn, delay) => delay > 100 ? setTimeout(fn, delay) : (now += 100, queueMicrotask(fn)) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/native-drafts.js"), "utf8"), context);
  return { api: context.window.auto, items, rows, reads: () => reads, sends: () => sends, visible: () => visible().length,
    bindings: items.map(d => ({ id: "app-" + d.id, draftNumber: d.draftNumber, prompt: d.prompt, title: "旧标题", executionMode: "work" })) };
}

test("50 条重复正文只显示 5 条时读取全部原生 ID 与完整正文，逐条准确打开发送", async () => {
  const p = page(); assert.equal(p.visible(), 5);
  const catalog = await p.api.readNativeDrafts();
  assert.equal(catalog.ok, true); assert.equal(catalog.source, "indexeddb"); assert.equal(catalog.total, 50);
  const restored = await p.api.restoreNativeDrafts(p.bindings);
  assert.equal(restored.ok, true, restored.reason); assert.equal(restored.bindings.length, 50);
  for (const binding of p.bindings) {
    assert.equal((await p.api.openNativeDraft(binding)).ok, true);
    assert.equal((await p.api.sendNativeDraft(binding)).ok, true);
  }
  assert.equal(p.sends(), 50); assert.ok(p.reads() >= 4);
});

test("折叠草稿区仍能展开并按底层身份找到最后一条", async () => {
  const p = page({ collapsed: true }); assert.equal(p.visible(), 0);
  const restored = await p.api.restoreNativeDrafts([p.bindings[49]]);
  assert.equal(restored.ok, true, restored.reason); assert.equal(restored.bindings[0].nativeId, "local-49");
  // React remounts remove injected DOM attributes; the persisted native ID remains valid.
  p.rows.forEach(r => { r.dataset = {}; });
  assert.equal((await p.api.openNativeDraft(p.bindings[49])).ok, true);
});

test("隐藏重复编号、缺少正文或不同账号的数据都不能按相似标题提交", async () => {
  for (const options of [{ duplicate: true }, { missingBody: true }, { wrongScope: true }]) {
    const p = page(options), binding = options.duplicate ? p.bindings[0] : p.bindings[49];
    const result = await p.api.restoreNativeDrafts([binding]);
    assert.equal(result.ok, false); assert.equal(p.sends(), 0);
  }
});

test("已绑定原生 ID 不得悄悄改绑到另一条同编号或同正文草稿", async () => {
  const p = page();
  for (const binding of [{ ...p.bindings[49], nativeId: "removed", accountScope: "account-a" }, { ...p.bindings[49], nativeId: "local-49", accountScope: "account-b" }]) {
    assert.equal((await p.api.restoreNativeDrafts([binding])).ok, false);
  }
  assert.equal(p.sends(), 0);
});

test("原生条目移除后，空列表恢复不能重新写回缓存中的旧绑定", async () => {
  const p = page();
  assert.equal((await p.api.restoreNativeDrafts([p.bindings[0]])).ok, true);
  p.rows.shift();
  const result = await p.api.restoreNativeDrafts([]);
  assert.equal(result.ok, true); assert.equal(result.bindings.length, 0);
});
