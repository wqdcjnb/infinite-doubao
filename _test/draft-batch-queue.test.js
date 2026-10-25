"use strict";
const { test, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const P = require("../src/paths"), store = require("../src/store");
const templates = require("../src/task-templates"), drafts = require("../src/task-drafts"), queue = require("../src/orchestrator");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-native-batch-"));
let index = 0, calls, native, hook;
beforeEach(() => {
  P.init({ home: path.join(root, String(++index)) }); store.load();
  Object.assign(store.get().settings.orchestrator, { maxParallel: 3, pollInterval: 1500, retryLimit: 0, autoDownload: false });
  store.get().settings.quota.perDay = 20;
  calls = []; native = []; hook = () => null;
  const resolveDriver = async (inst) => {
    let taskId;
    const bindings = () => native.map((id, i) => ({ id, index: i, title: id, titles: native.slice() }));
    return {
      isLoggedIn: async () => ({ loggedIn: true }),
      waitForLogin: async () => (await hook("waitForLogin")) || { loggedIn: true },
      call: async (method, options) => {
        calls.push({ method, options, instanceId: inst.id });
        const override = await hook(method, options); if (override) return override;
        if (method === "saveNativeDraft") { native.push(options.id); return { ok: true, bindings: bindings() }; }
        if (method === "waitNativeDraftAccepted") { native = native.filter((id) => id !== options.id); return { ok: true, conversationUrl: `https://www.doubao.com/chat/${options.id}`, bindings: bindings() }; }
        return { ok: true, conversationIds: [] };
      },
      close: () => { calls.push({ method: "close", instanceId: inst.id }); },
      setGenerationOptions: async () => ({}), setText: async () => ({ ok: true }),
      beginTask: async (input) => { taskId = input.taskId; return { ok: true, baselineUrls: [] }; },
      send: async () => { calls.push({ method: "normalSend", instanceId: inst.id }); return { ok: true }; },
      readProgress: async () => { calls.push({ method: "result" }); return { state: "done", mediaUrls: [`https://fixture.invalid/${index}/${taskId}.mp4`] }; }
    };
  };
  queue.init({ sessionFor: () => ({ cookies: { get: async () => [{ name: "sessionid" }] } }), resolveDriver, resolveDraftDriver: resolveDriver });
});
afterEach(async () => { queue.stopAll(); await waitFor(() => !queue.state().running.length); });
after(() => fs.rmSync(root, { recursive: true, force: true }));
function account(name) { return store.add({ id: `${index}-${name}`, name }); }
function template(name) { return templates.create({ name, prompt: `视频 ${name}`, model: "seedance_v2.0_mini", duration: 5 }); }
function batch() { return drafts.createMany([template("A").id, template("B").id]).map((d) => d.id); }
async function waitFor(check) {
  for (let n = 0; n < 150; n++) { if (check()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("Native draft fixture timed out");
}
const sends = () => calls.filter((c) => c.method === "sendNativeDraft");

test("新草稿和旧版本地草稿保存编号，普通提交不带草稿编号", async () => {
  account("first"); const ids = batch();
  drafts.updateMany({ [ids[0]]: { draftNumber: undefined } });
  const originals = drafts.list().map(d => d.template.prompt);
  await queue.saveDrafts(ids);
  const saved = drafts.list().map(d => ({ ...d }));
  for (const d of saved) {
    assert.match(d.draftNumber, /^DB-[0-9A-F]{24}$/);
    assert.ok(d.nativePrompt.startsWith(`【草稿编号：${d.draftNumber}】`));
    assert.match(d.nativePrompt, /请勿将编号或此说明作为画面、字幕或旁白/);
  }
  assert.deepEqual(drafts.list().map(d => d.template.prompt), originals);
  await queue.saveDrafts(ids); assert.equal(calls.filter(c => c.method === "saveNativeDraft").length, 2);
  await queue.submitDrafts(ids);
  assert.deepEqual(store.get().tasks.map(t => t.draftNumber), saved.map(d => d.draftNumber));
  account("second"); const normal = queue.submitTemplate(templates.snapshot(template("normal").id)).taskId;
  assert.equal(queue.getTask(normal).prompt.includes("草稿编号"), false);
});

test("已存网页的旧草稿保留原提示词和旧恢复方式", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  drafts.updateMany(Object.fromEntries(ids.map(id => [id, { draftNumber: undefined, nativePrompt: "旧提示词 " + id }])));
  calls.length = 0;
  await queue.saveDrafts(ids); assert.equal(calls.filter(c => c.method === "saveNativeDraft").length, 0);
  await queue.submitDrafts(ids);
  assert.ok(sends().every(c => c.options.prompt.startsWith("旧提示词 ")));
  assert.ok(calls.filter(c => c.method === "restoreNativeDrafts").flatMap(c => c.options).every(b => !b.draftNumber));
});
test("整批页面先就绪，所有发送先触发，慢回执不阻塞其他发送", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  hook = async (method, options) => {
    if (method === "sendNativeDraft") assert.equal(calls.filter((c) => c.method === "openNativeDraft").length, 2);
    if (method === "waitNativeDraftAccepted" && options.id === ids[0]) await delayed;
  };
  const submission = queue.submitDrafts(ids);
  await waitFor(() => sends().length === 2);
  assert.equal(store.get().tasks.length, 0);
  assert.ok(drafts.list().every((d) => d.submissionRecord));
  release(); assert.equal((await submission).count, 2);
  assert.equal(calls.filter((c) => c.method === "close").length, 2);
  assert.equal(new Set(store.get().tasks.map((t) => t.submittedAt)).size, 1);
});
test("任一页面准备失败整批不发送，关闭所有已创建页面", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  hook = (method, options) => method === "openNativeDraft" && options.id === ids[1] ? { ok: false, reason: "附件未就绪" } : null;
  await assert.rejects(queue.submitDrafts(ids), /整批尚未触发发送/);
  assert.equal(sends().length, 0); assert.equal(calls.filter((c) => c.method === "close").length, 2);
  assert.ok(drafts.list().every((d) => !d.submissionRecord));
});

test("等待草稿页登录就绪再准备发送，未知页面与明确未登录分别提示且不丢记录", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  for (const by of ["unknown", "login-button"]) {
    hook = method => method === "waitForLogin" ? { loggedIn: false, by } : null;
    await assert.rejects(queue.submitDrafts(ids), by === "unknown" ? /尚未加载完成/ : /仍显示登录入口/);
    assert.equal(sends().length, 0);
    assert.equal(drafts.list().length, 2);
    assert.ok(drafts.list().every(d => !d.submissionRecord));
  }
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  hook = async method => { if (method === "waitForLogin") await ready; };
  const pending = queue.submitDrafts(ids);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sends().length, 0);
  release(); assert.equal((await pending).count, 2);
});
test("旧版本地草稿转为云电脑，已绑定的旧版对话草稿禁止保存和发送", async () => {
  const chosen = account("chosen"), ids = batch();
  drafts.updateMany(Object.fromEntries(ids.map((id) => [id, { executionMode: "video" }])));
  await queue.saveDrafts(ids, { instanceId: chosen.id });
  assert.ok(calls.filter((c) => c.method === "prepareNativeDraft").every((c) => c.options.executionMode === "work"));
  store.load(); assert.ok(drafts.list().every((d) => d.executionMode === "work"));
  drafts.updateMany({ [ids[0]]: { executionMode: "video" } });
  const before = calls.length;
  await assert.rejects(queue.saveDrafts(ids), /旧版对话草稿/);
  await assert.rejects(queue.submitDrafts(ids), /仅支持通过云电脑/);
  assert.equal(calls.length, before); assert.equal(sends().length, 0);
});
test("指定账号保存和发送整批，已存原生草稿不得静默改用另一号", async () => {
  const first = account("first"), chosen = account("chosen"), ids = batch();
  await queue.saveDrafts(ids, { instanceId: chosen.id });
  assert.ok(drafts.list().every((d) => d.instanceId === chosen.id));
  await assert.rejects(queue.submitDrafts(ids, { instanceId: first.id }), /请使用该账号发送/);
  assert.equal(sends().length, 0);
  await queue.submitDrafts(ids, { instanceId: chosen.id });
  assert.ok(sends().every((s) => s.instanceId === chosen.id));
});
test("多模板存入原生草稿，全部发送再取回结果，普通任务仍使用其他号", async () => {
  const first = account("first"), second = account("second"), ids = batch();
  await queue.saveDrafts(ids); assert.deepEqual(native, ids);
  assert.equal(sends().length, 0); assert.equal(store.get().tasks.length, 0);
  assert.equal((await queue.submitDrafts(ids)).count, 2); assert.equal(sends().length, 2);
  assert.equal(calls.some((c) => c.method === "result"), false, "all drafts accepted before generation polling");
  assert.ok(sends().every((c) => c.instanceId === first.id));
  const normal = queue.submitTemplate(templates.snapshot(template("normal").id)).taskId;
  await waitFor(() => store.get().tasks.every((t) => t.status === "succeeded"));
  assert.equal(queue.getTask(normal).instanceId, second.id);
  assert.equal(calls.filter((c) => c.method === "normalSend").length, 1);
  assert.equal(new Set(store.get().tasks.filter((t) => t.id !== normal).map((t) => t.draftBatchId)).size, 1);
  assert.equal(drafts.list().length, 0); await assert.rejects(queue.submitDrafts(ids), /已提交/);
});
test("只发送勾选草稿，重载保持同一账号", async () => {
  const first = account("first"); account("second"); const ids = batch();
  await queue.saveDrafts(ids); store.load(); await queue.submitDrafts([ids[1], ids[1]]);
  assert.deepEqual(native, [ids[0]]); assert.equal(sends()[0].instanceId, first.id);
  assert.deepEqual(drafts.list().map((d) => d.id), [ids[0]]);
});

test("未选草稿失效不阻塞所选任务，独立页面只恢复自己的草稿", async () => {
  account("first"); const ids = [...batch(), drafts.create(template("C").id).id]; await queue.saveDrafts(ids);
  calls.length = 0;
  hook = (method, options) => method === "restoreNativeDrafts" && options.some(b => b.id === ids[2]) ? { ok: false, reason: "未选草稿已被移除" } : null;
  assert.equal((await queue.submitDrafts(ids.slice(0, 2))).count, 2);
  const restored = calls.filter(c => c.method === "restoreNativeDrafts").map(c => c.options);
  assert.deepEqual(restored.map(bs => bs.length), [2, 1, 1]);
  assert.ok(restored.flat().every(b => b.prompt && b.executionMode === "work"));
});
test("中途接收超时保留记录，已接收任务仍取回，未确认点击不重发", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  hook = (method, options) => method === "waitNativeDraftAccepted" && options.id === ids[1] ? { ok: false, reason: "接收超时" } : null;
  await assert.rejects(queue.submitDrafts(ids), /已确认发送 1\/2/);
  assert.equal(store.get().tasks.length, 1); assert.equal(drafts.list()[0].submissionRecord.task.submissionUncertain, true);
  store.load(); await assert.rejects(queue.submitDrafts([ids[1]]), /不会自动重发/); assert.equal(sends().length, 2);
});
test("点击前写盘失败不发送，入队失败从持久化接收记录恢复", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids); const save = store.save;
  store.save = () => false;
  try { await assert.rejects(queue.submitDrafts(ids), /状态保存失败/); } finally { store.save = save; }
  assert.equal(sends().length, 0);
  store.save = () => store.get().tasks.length ? false : save();
  try { await assert.rejects(queue.submitDrafts(ids), /任务保存失败/); } finally { store.save = save; }
  assert.equal(sends().length, 2); assert.equal(store.get().tasks.length, 0);
  store.load(); assert.equal((await queue.submitDrafts(ids)).count, 2); assert.equal(sends().length, 2);
});
test("保存中断不重复存入", async () => {
  account("first"); const ids = batch();
  hook = (method) => method === "saveNativeDraft" ? { ok: false, reason: "未确认保存" } : null;
  await assert.rejects(queue.saveDrafts(ids), /未确认保存/); await assert.rejects(queue.saveDrafts(ids), /上次操作未确认/);
  assert.equal(calls.filter((c) => c.method === "saveNativeDraft").length, 1); assert.equal(store.get().tasks.length, 0);
});
test("批量操作互斥，停止阻止下一次点击", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  hook = async (method, options) => {
    if (method === "openNativeDraft" && options.id === ids[1]) { await assert.rejects(queue.submitDrafts([ids[1]]), /正在执行任务/); queue.stopAll(); }
  };
  await assert.rejects(queue.submitDrafts(ids), /已停止/); assert.equal(sends().length, 0);
  assert.equal(queue.state().paused, true); assert.equal(drafts.list()[0].submissionRecord, undefined);
});
test("并发回执更新未勾选草稿的位置，单条拒绝不影响其他已发任务", async () => {
  account("first"); const ids = [...batch(), drafts.create(template("C").id).id]; await queue.saveDrafts(ids);
  hook = (method, options) => method === "sendNativeDraft" && options.id === ids[1] ? { ok: false, reason: "按钮状态变化，未发送" } : null;
  await assert.rejects(queue.submitDrafts(ids.slice(0, 2)), /已确认发送 1\/2/);
  assert.equal(drafts.list().find((d) => d.id === ids[1]).submissionRecord, null);
  const remaining = drafts.list().find((d) => d.id === ids[2]).nativeBinding;
  assert.equal(remaining.index, 1); assert.deepEqual(remaining.titles, ids.slice(1));
  assert.equal(store.get().tasks.length, 1);
});
