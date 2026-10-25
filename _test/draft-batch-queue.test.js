"use strict";
const { test, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const P = require("../src/paths"), store = require("../src/store");
const templates = require("../src/task-templates"), drafts = require("../src/task-drafts"), queue = require("../src/orchestrator");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-native-batch-"));
let index = 0, calls, native, hook, liveWorkers, peakWorkers;
beforeEach(() => {
  P.init({ home: path.join(root, String(++index)) }); store.load();
  Object.assign(store.get().settings.orchestrator, { maxParallel: 3, pollInterval: 1500, retryLimit: 0, autoDownload: false });
  store.get().settings.quota.perDay = 20;
  calls = []; native = []; hook = () => null;
  liveWorkers = 0; peakWorkers = 0;
  const resolveDriver = async (inst) => {
    let taskId, draftId, text, currentUrl = 'https://www.doubao.com/chat/';
    const bindings = () => native.map((id, i) => ({ id, index: i, title: id, titles: native.slice() }));
    return {
      isLoggedIn: async () => ({ loggedIn: true }),
      waitForLogin: async () => (await hook("waitForLogin")) || { loggedIn: true },
      navigate: async url => { currentUrl = url; calls.push({ method: "navigate", url, draftId }); },
      url: async () => currentUrl,
      ready: async () => true,
      call: async (method, options) => {
        if (method === "openNativeDraft") draftId = options.id;
        calls.push({ method, options, instanceId: inst.id });
        const override = await hook(method, options, { draftId, taskId }); if (override) return override;
        if (method === "saveNativeDraft") { native.push(options.id); return { ok: true, bindings: bindings() }; }
        if (method === "waitNativeDraftAccepted") { native = native.filter((id) => id !== options.id); currentUrl = `https://www.doubao.com/chat/${options.id}`; return { ok: true, conversationUrl: currentUrl, bindings: bindings() }; }
        if (method === "readProgress") return { state: "running", generationStarted: true };
        return { ok: true, conversationIds: [] };
      },
      close: () => { calls.push({ method: "close", instanceId: inst.id }); },
      setGenerationOptions: async () => ({}), setText: async value => { text = value; return { ok: true }; },
      beginTask: async (input) => { taskId = input.taskId; calls.push({ method: "beginTask", input, draftId }); return { ok: true, baselineUrls: [], baselineMessageIds: ["old-route"] }; },
      send: async () => { calls.push({ method: "normalSend", instanceId: inst.id, draftId, text }); return await hook("send", { text }, { draftId, taskId }) || { ok: true }; },
      readProgress: async () => { calls.push({ method: "result" }); return { state: "done", mediaUrls: [`https://fixture.invalid/${index}/${taskId}.mp4`] }; }
    };
  };
  queue.init({ sessionFor: () => ({ cookies: { get: async () => [{ name: "sessionid" }] } }), resolveDriver, resolveDraftDriver: async inst => {
    const driver = await resolveDriver(inst), close = driver.close;
    peakWorkers = Math.max(peakWorkers, ++liveWorkers);
    let closed = false;
    driver.close = () => { if (!closed) { closed = true; liveWorkers--; close(); } };
    return driver;
  } });
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

test("接收后在已核对的新对话重置基线，直接检测生成确认而不重复加载", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  hook = (method, options, context) => {
    if (method === "peekGenerationConfirmation" && context.draftId) {
      assert.equal(calls.some(c => c.method === "navigate" && c.draftId === context.draftId), false, "verified conversation should not reload");
      const tracking = calls.filter(c => c.method === "beginTask" && c.draftId === context.draftId).at(-1).input;
      assert.equal(tracking.resume, true); assert.equal(tracking.reset, true); assert.deepEqual(tracking.baselineMessageIds, []);
    }
  };
  assert.equal((await queue.submitDrafts(ids)).count, 2);
  assert.equal(sends().length, 2);
  assert.ok(store.get().tasks.every(t => t.baselineMessageIds.length === 0));
});

test("回执后页面离开已接收对话时，恢复正确会话再核对生成确认", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  hook = (method, options) => method === "waitNativeDraftAccepted"
    ? { ok: true, conversationUrl: `https://www.doubao.com/chat/${options.id}` } : null;
  assert.equal((await queue.submitDrafts(ids)).count, 2);
  assert.deepEqual(calls.filter(c => c.method === "navigate" && c.draftId).map(c => c.url).sort(), ids.map(id => `https://www.doubao.com/chat/${id}`).sort());
});

test("同账号的确认提醒乱序到达，独立回复按要求生成且先落盘，不等第一条完成", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  let firstReady = false;
  const confirmed = [];
  hook = (method, options, context) => {
    if (method === "peekGenerationConfirmation") return context.draftId === ids[1] || firstReady
      ? { ok: true, kind: "text", key: context.draftId, text: "按要求生成" } : { ok: false };
    if (method === "readProgress") return { state: "running", generationStarted: false };
    if (method === "send") {
      const saved = JSON.parse(fs.readFileSync(path.join(P.home(), "store.json"), "utf8"));
      const record = saved.taskDrafts.find(d => d.id === context.draftId).submissionRecord;
      assert.equal(record.task.confirmationIntents[context.draftId].state, "pending");
      assert.equal(options.text, "按要求生成"); confirmed.push(context.draftId);
    }
  };
  const submission = queue.submitDrafts(ids);
  // Attach a handler now so a failed assertion cannot leave a rejected promise unobserved.
  submission.catch(() => {});
  await waitFor(() => confirmed.includes(ids[1]) || store.get().tasks.length);
  assert.deepEqual(confirmed, [ids[1]]);
  assert.equal(sends().length, 2); assert.equal(liveWorkers, 1);
  firstReady = true;
  assert.equal((await submission).count, 2);
  assert.deepEqual(confirmed, [ids[1], ids[0]]);
  assert.ok(store.get().tasks.every(t => Object.values(t.confirmationIntents)[0].state === "sent"));
  assert.equal(liveWorkers, 0);
});

test("确认发送回执丢失时保留 pending，恢复取回不重复草稿或确认", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  hook = (method, options, context) => {
    if (method === "peekGenerationConfirmation") return { ok: true, kind: "text", key: context.draftId || "resumed", text: "按要求生成" };
    if (method === "send") throw new Error("确认发送后的 IPC 丢失");
  };
  await assert.rejects(queue.submitDrafts(ids), /已接收.*确认/);
  assert.equal(sends().length, 2);
  assert.equal(calls.filter(c => c.method === "normalSend").length, 2);
  assert.ok(store.get().tasks.every(t => Object.values(t.confirmationIntents)[0].state === "pending"));
  store.load(); queue.recoverTemplateTasks(); queue.wakeQueue();
  await waitFor(() => store.get().tasks.every(t => t.status === "succeeded"));
  assert.equal(calls.filter(c => c.method === "normalSend").length, 2);
});

test("等待确认提醒时停止立即关闭独立页面，迟到提醒不再发送", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  let release, peeks = 0;
  const delayed = new Promise(resolve => { release = resolve; });
  hook = async method => {
    if (method === "peekGenerationConfirmation") { peeks++; await delayed; return { ok: true, kind: "text", key: "late", text: "按要求生成" }; }
    if (method === "readProgress") return { state: "unknown" };
  };
  const submission = queue.submitDrafts(ids); submission.catch(() => {});
  await waitFor(() => peeks === 2 || store.get().tasks.length);
  assert.equal(peeks, 2);
  queue.stopAll(); await assert.rejects(submission, /已停止/);
  assert.equal(liveWorkers, 0); release(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.filter(c => c.method === "normalSend").length, 0);
  assert.equal(store.get().tasks.length, 2);
});

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

test("网页草稿已删除后明确重新存入，14 条保留原编号和快照且不发送", async () => {
  const inst = account("first");
  const ids = drafts.createMany(Array.from({ length: 15 }, (_, i) => template(String(i)).id)).map(d => d.id);
  await queue.saveDrafts(ids);
  const before = structuredClone(drafts.list()), selected = ids.slice(0, 14);
  native = [ids[14]]; calls.length = 0;
  hook = (method, bindings) => method === "restoreNativeDrafts" && bindings.some(b => !native.includes(b.id))
    ? { ok: false, reason: "未找到所选豆包草稿" } : null;
  await assert.rejects(queue.saveDrafts(selected), /未找到/);
  assert.equal(calls.filter(c => c.method === "saveNativeDraft").length, 0);
  assert.equal((await queue.saveDrafts(selected, { instanceId: inst.id, recreateDeleted: true })).count, 14);
  assert.equal(native.length, 15); assert.equal(new Set(native).size, 15);
  store.load();
  for (const [i, draft] of drafts.list().entries()) {
    assert.equal(draft.draftNumber, before[i].draftNumber);
    assert.deepEqual(draft.template, before[i].template);
    assert.equal(draft.nativeState, "saved");
    assert.equal(draft.instanceId, inst.id);
  }
  assert.equal(sends().length, 0); assert.equal(store.get().tasks.length, 0);
  calls.length = 0; await queue.saveDrafts(selected);
  assert.equal(calls.filter(c => c.method === "saveNativeDraft").length, 0);
});

test("重新存入先校验整批附件，失败保留旧关联且不操作网页", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  drafts.updateMany({ [ids[1]]: { template: { ...drafts.list()[1].template, attachments: [{ name: "missing.png", path: path.join(root, "missing.png") }] } } });
  const before = structuredClone(drafts.list()); calls.length = 0;
  await assert.rejects(queue.saveDrafts(ids, { recreateDeleted: true }), /附件/);
  assert.deepEqual(drafts.list(), before); assert.equal(calls.length, 0);
});

test("重新存入不解除保存中、已发送或接收未知的保护，也不能换号", async () => {
  const inst = account("first"), other = account("other"), ids = batch(); await queue.saveDrafts(ids);
  const before = structuredClone(drafts.list()); calls.length = 0;
  await assert.rejects(queue.saveDrafts(ids, { instanceId: other.id, recreateDeleted: true }), /请使用该账号/);
  for (const patch of [{ nativeState: "saving" }, { nativeState: "sent", submissionRecord: { task: { submissionUncertain: false } } }, { submissionRecord: { task: { submissionUncertain: true } } }]) {
    drafts.updateMany({ [ids[0]]: { ...before[0], submissionRecord: null, ...patch } });
    await assert.rejects(queue.saveDrafts(ids, { instanceId: inst.id, recreateDeleted: true }), /上次操作未确认/);
  }
  assert.equal(calls.length, 0);
});

test("重新存入重置状态写盘失败不改旧关联，不开始保存", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  const before = structuredClone(drafts.list()), save = store.save; calls.length = 0;
  store.save = () => false;
  try { await assert.rejects(queue.saveDrafts(ids, { recreateDeleted: true }), /草稿状态保存失败/); }
  finally { store.save = save; }
  assert.deepEqual(drafts.list(), before);
  assert.equal(calls.filter(c => c.method === "prepareNativeDraft" || c.method === "saveNativeDraft").length, 0);
});
test("逐条触发后继续下一条，第一条回执不返回也不能阻塞第二条", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  hook = async (method, options) => {
    if (method === "waitNativeDraftAccepted" && options.id === ids[0]) await delayed;
  };
  const submission = queue.submitDrafts(ids);
  await waitFor(() => sends().length === 2);
  assert.equal(store.get().tasks.length, 0);
  assert.ok(drafts.list().every((d) => d.submissionRecord));
  release(); assert.equal((await submission).count, 2);
  assert.equal(calls.filter((c) => c.method === "close").length, 2);
  assert.equal(new Set(store.get().tasks.map((t) => t.draftBatchId)).size, 1);
});
test("一条准备失败不影响已投递任务，按条保存失败原因", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  hook = (method, options) => method === "openNativeDraft" && options.id === ids[1] ? { ok: false, reason: "附件未就绪" } : null;
  await assert.rejects(queue.submitDrafts(ids), /已确认发送 1\/2/);
  assert.equal(sends().length, 1); assert.equal(calls.filter((c) => c.method === "close").length, 2);
  assert.match(drafts.list()[0].nativeError, /尚未发送.*附件未就绪/);
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

test("18 条草稿最后一页登录较慢时，前 17 条已经连续投递", async () => {
  account("first");
  const ids = drafts.createMany(Array.from({ length: 18 }, (_, i) => template(String(i)).id)).map(d => d.id);
  await queue.saveDrafts(ids);
  let loginChecks = 0, release;
  const delayed = new Promise(resolve => { release = resolve; });
  hook = async method => { if (method === "waitForLogin" && ++loginChecks === 18) await delayed; };
  const pending = queue.submitDrafts(ids);
  await waitFor(() => loginChecks === 18);
  assert.equal(sends().length, 17);
  assert.equal(calls.some(c => c.method === "result"), false);
  assert.ok(!drafts.list()[17].submissionRecord);
  release(); assert.equal((await pending).count, 18);
  assert.equal(new Set(sends().map(c => c.options.id)).size, 18);
  assert.equal(sends().length, 18);
  assert.equal(liveWorkers, 0);
});

test("50 条所有回执都延迟，仍先触发全部 50 次发送，绝不按组等待", async () => {
  account("first");
  const ids = drafts.createMany(Array.from({ length: 50 }, (_, i) => template(String(i)).id)).map(d => d.id);
  await queue.saveDrafts(ids);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  hook = async method => { if (method === "waitNativeDraftAccepted") await delayed; };
  const pending = queue.submitDrafts(ids);
  await waitFor(() => sends().length === 50);
  assert.equal(store.get().tasks.length, 0);
  release(); assert.equal((await pending).count, 50);
  assert.equal(new Set(sends().map(c => c.options.id)).size, 50);
  assert.equal(calls.some(c => c.method === "result"), false);
  assert.equal(liveWorkers, 0);
  assert.equal(new Set(store.get().tasks.map(t => t.draftBatchId)).size, 1);
});

test("滚动提前准备：前两页加载卡住、所有回执挂起，其余 48 条仍连续投递", async () => {
  account("first");
  const ids = drafts.createMany(Array.from({ length: 50 }, (_, i) => template(String(i)).id)).map(d => d.id);
  await queue.saveDrafts(ids);
  let releasePages, releaseReceipts, checking = 0, peakChecking = 0, checks = 0;
  const pages = new Promise(resolve => { releasePages = resolve; });
  const receipts = new Promise(resolve => { releaseReceipts = resolve; });
  hook = async method => {
    if (method === "waitForLogin") {
      peakChecking = Math.max(peakChecking, ++checking);
      if (++checks <= 2) await pages;
      checking--;
    }
    if (method === "waitNativeDraftAccepted") await receipts;
  };
  const pending = queue.submitDrafts(ids); pending.catch(() => {});
  try {
    await waitFor(() => sends().length === 48);
    assert.equal(checks, 50);
    assert.equal(peakChecking, 3, "limit simultaneous page preparation without grouping sends");
    assert.equal(store.get().tasks.length, 0, "no receipt released yet");
    releasePages(); await waitFor(() => sends().length === 50);
    assert.equal(new Set(sends().map(c => c.options.id)).size, 50);
    releaseReceipts(); assert.equal((await pending).count, 50);
    assert.equal(liveWorkers, 0);
  } finally { releasePages(); releaseReceipts(); }
});

test("中间一条准备失败，后续仍连续投递，失败草稿保留", async () => {
  account("first");
  const ids = drafts.createMany(Array.from({ length: 10 }, (_, i) => template(String(i)).id)).map(d => d.id);
  await queue.saveDrafts(ids);
  hook = (method, options) => method === "openNativeDraft" && options.id === ids[5] ? { ok: false, reason: "页面加载失败" } : null;
  await assert.rejects(queue.submitDrafts(ids), /已确认发送 9\/10.*页面加载失败/);
  assert.equal(store.get().tasks.length, 9);
  assert.deepEqual(drafts.list().map(d => d.id), [ids[5]]);
  assert.ok(drafts.list().every(d => !d.submissionRecord));
  assert.equal(liveWorkers, 0);
});

test("页面调用一直不返回时，停止立即解除等待并清理页面", async () => {
  account("first"); const ids = batch(); await queue.saveDrafts(ids);
  hook = method => method === "openNativeDraft" ? new Promise(() => {}) : null;
  const pending = queue.submitDrafts(ids);
  await waitFor(() => calls.some(c => c.method === "openNativeDraft"));
  queue.stopAll(); await assert.rejects(pending, /已停止/);
  assert.equal(sends().length, 0); assert.equal(liveWorkers, 0);
  assert.equal(queue.state().running.length, 0);
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
  assert.deepEqual(restored.map(bs => bs.length), [1, 1]);
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
    if (method === "sendNativeDraft" && options.id === ids[0]) { queue.stopAll(); }
  };
  const pending = queue.submitDrafts(ids);
  await assert.rejects(queue.submitDrafts([ids[1]]), /正在执行任务/);
  await assert.rejects(pending, /已停止/); assert.equal(sends().length, 1);
  assert.equal(queue.state().paused, true); assert.equal(drafts.list().find(d => d.id === ids[1]).submissionRecord, undefined);
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
