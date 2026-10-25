"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

function page({ collapsed = false, duplicate = false, missingBody = false, wrongScope = false, noSidebar = false, sidebarDelayMs = 0, empty = false, currentScope = "account-a" } = {}) {
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
  const pendingSidebar = () => noSidebar || now - 1000 < sidebarDelayMs;
  const visible = () => pendingSidebar() || collapsed ? [] : rows.slice(0, expanded ? 50 : 5);
  const more = { isConnected: true, click() { expanded = true; this.isConnected = false; } };
  const section = { querySelector: s => s.includes("section-header") ? { click: () => { collapsed = false; } } : expanded ? null : more };
  const document = {
    querySelector: s => pendingSidebar() ? null : s.includes("draft-conversation-section") ? section : s.includes("chat_input_action_mode") ? mode : s.includes("chat_input_send_button") ? button : editor,
    querySelectorAll: s => s.includes("draft-conversation-section") ? visible() : []
  };
  const indexedDB = {
    databases: async () => [{ name: "flow-draft-conversations-v2" }, { name: "samantha-web" }],
    open(name) {
      const request = {};
      queueMicrotask(() => {
        request.result = { close() {}, transaction(storeName, access) {
          assert.equal(access, "readonly"); reads++;
          const tx = { objectStore() { return { getAll: () => read(empty ? [] : index), get: key => { assert.equal(key, "input-engine-draft:v3:account:account-a"); return read(input); } }; } };
          function read(value) { const q = {}; queueMicrotask(() => { q.result = value; q.onsuccess(); queueMicrotask(() => tx.oncomplete()); }); return q; }
          assert.equal(storeName, name === "samantha-web" ? "store" : "drafts"); return tx;
        } }; request.onsuccess();
      }); return request;
    }
  };
  class TestDate extends Date { static now() { return now; } }
  const context = vm.createContext({ window: { auto: {} }, document, indexedDB, localStorage: { getItem: key => key === "flow_tea_user_id" ? currentScope : null }, CFG: { autoKey: "auto" }, Date: TestDate, clearTimeout,
    setTimeout: (fn, delay) => delay > 100 ? setTimeout(fn, delay) : (now += 100, queueMicrotask(fn)) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/native-drafts.js"), "utf8"), context);
  return { api: context.window.auto, items, rows, index, elapsed: () => now - 1000, reads: () => reads, sends: () => sends, visible: () => visible().length,
    bindings: items.map(d => ({ id: "app-" + d.id, draftNumber: d.draftNumber, prompt: d.prompt, title: "旧标题", executionMode: "work" })) };
}

test("新投递页面先读到完整数据、侧栏延迟挂载时等待原生 ID，不能让整批提前失败", async () => {
  const p = page({ sidebarDelayMs: 1800 });
  const binding = p.bindings[49];
  assert.equal((await p.api.restoreNativeDrafts([binding])).ok, true);
  assert.equal(p.visible(), 0); assert.equal(p.elapsed(), 0);
  const result = await p.api.openNativeDraft(binding);
  assert.equal(result.ok, true, result.reason); assert.ok(p.elapsed() >= 1800);
  assert.equal((await p.api.sendNativeDraft(binding)).ok, true); assert.equal(p.sends(), 1);
});

test("投递页面复用本批完整数据，不重复打开数据库；仍核对当前账号和完整正文", async () => {
  const original = page(), catalog = await original.api.readNativeDrafts();
  const sender = page({ empty: true });
  assert.equal((await sender.api.restoreNativeDrafts([original.bindings[0]], { catalog })).ok, true);
  assert.equal(sender.reads(), 0);
  assert.equal((await sender.api.openNativeDraft(original.bindings[0])).ok, true);
  const wrong = page({ currentScope: "account-b" });
  assert.equal((await wrong.api.restoreNativeDrafts([original.bindings[0]], { catalog })).ok, false);
  assert.equal((await sender.api.restoreNativeDrafts([{ ...original.bindings[0], prompt: "changed" }], { catalog })).ok, false);
});

test("其他投递页改变侧栏使原行重新挂载时，按原生 ID 继续核对，不能误报未就绪", async () => {
  const p = page(), binding = p.bindings[0], old = p.rows[0];
  await p.api.restoreNativeDrafts([binding]);
  const click = old.click;
  old.click = () => { click(); old.isConnected = false; p.rows[0] = { ...old, isConnected: true }; };
  assert.equal((await p.api.openNativeDraft(binding)).ok, true);
  assert.equal((await p.api.sendNativeDraft(binding)).ok, true); assert.equal(p.sends(), 1);
});

test("核对后侧栏始终不出现时明确超时，不点击发送或按标题猜测", async () => {
  const p = page({ noSidebar: true }); const binding = p.bindings[0];
  assert.equal((await p.api.restoreNativeDrafts([binding])).ok, true);
  const result = await p.api.openNativeDraft(binding);
  assert.equal(result.ok, false); assert.match(result.reason, /尚未显示对应条目/);
  assert.equal(p.sends(), 0); assert.equal(p.elapsed(), 20000);
});

test("侧栏与输入框均未挂载时，直接核对 50 条完整草稿并返回全部绑定", async () => {
  const p = page({ noSidebar: true });
  assert.equal((await p.api.readNativeDrafts()).total, 50);
  const result = await p.api.restoreNativeDrafts(p.bindings);
  assert.equal(result.ok, true, result.reason); assert.equal(result.bindings.length, 50);
  assert.equal(p.elapsed(), 0); assert.equal(p.sends(), 0);
});

test("空的原生索引立即报告缺失，保留正文不当作已保存；恢复返回精确缺失 ID", async () => {
  const p = page({ noSidebar: true, empty: true });
  const result = await p.api.restoreNativeDrafts(p.bindings);
  assert.equal(result.ok, false); assert.match(result.reason, /找不到.*50.*重新存入/);
  assert.equal(p.elapsed(), 0);
  const recovery = await p.api.restoreNativeDrafts(p.bindings, { allowMissing: true });
  assert.equal(recovery.ok, true); assert.equal(recovery.missingIds.length, 50); assert.equal(recovery.bindings.length, 0);
  assert.equal(p.sends(), 0);
});

test("只恢复确实缺失的条目，已有编号改绑或账号变化不能当作缺失重建", async () => {
  const p = page({ noSidebar: true }); p.index.splice(1, 1);
  const result = await p.api.restoreNativeDrafts(p.bindings, { allowMissing: true });
  assert.equal(result.ok, true, result.reason); assert.equal(result.bindings.length, 49);
  assert.deepEqual(Array.from(result.missingIds), [p.bindings[1].id]);
  assert.equal((await p.api.restoreNativeDrafts([{ ...p.bindings[0], nativeId: "old-id", accountScope: "account-a" }], { allowMissing: true })).ok, false);
  for (const currentScope of ["account-b", ""]) {
    const changed = page({ noSidebar: true, empty: true, currentScope });
    assert.equal((await changed.api.restoreNativeDrafts([{ ...changed.bindings[0], accountScope: "account-a" }], { allowMissing: true })).ok, false);
  }
});

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
