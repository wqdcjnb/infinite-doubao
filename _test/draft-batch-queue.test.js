"use strict";

const { test, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const P = require("../src/paths");
const store = require("../src/store");
const templates = require("../src/task-templates");
const drafts = require("../src/task-drafts");
const queue = require("../src/orchestrator");
const quota = require("../src/quota");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-batch-queue-"));
let index = 0;
let sends;
let opens;
let loggedIn;

beforeEach(() => {
  P.init({ home: path.join(root, String(++index)) }); store.load();
  Object.assign(store.get().settings.orchestrator, { maxParallel: 3, pollInterval: 1500, retryLimit: 0, autoDownload: false });
  store.get().settings.quota.perDay = 20;
  sends = []; opens = []; loggedIn = () => true;
  queue.init({ sessionFor: () => ({ cookies: { get: async () => [{ name: "sessionid" }] } }), resolveDriver: async (inst) => {
    opens.push(inst.id);
    let taskId;
    return {
      isLoggedIn: async () => ({ loggedIn: loggedIn(inst), by: "fixture" }),
      call: async () => ({ ok: true }),
      setGenerationOptions: async () => ({}), setText: async () => ({ ok: true }),
      beginTask: async (input) => { taskId = input.taskId; return { ok: true, baselineUrls: [] }; },
      send: async () => { sends.push({ taskId, instanceId: inst.id }); return { ok: true }; },
      readProgress: async () => ({ state: "done", mediaUrls: [`https://fixture.invalid/${index}/${taskId}.mp4`] })
    };
  } });
});
afterEach(() => queue.stopAll());
after(() => fs.rmSync(root, { recursive: true, force: true }));
function account(name) { const inst = store.add({ id: `${index}-${name}`, name }); store.save(); return inst; }
function template(name) { return templates.create({ name, prompt: `视频 ${name}`, model: "seedance_v2.0_mini", duration: 5 }); }
function submitBatch() {
  return queue.submitDrafts([drafts.create(template("A").id).id, drafts.create(template("B").id).id]).items.map((t) => t.taskId);
}
async function waitFor(check) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Batch queue fixture timed out");
}
const idle = () => !queue.state().running.length;

test("不同模板草稿整批绑定一个号，正常任务仍能并行分配另一个号", async () => {
  const first = account("first"), second = account("second");
  const ids = submitBatch();
  const normal = queue.submitTemplate(templates.snapshot(template("normal").id)).taskId;
  await waitFor(() => [...ids, normal].every((id) => queue.getTask(id).status === "succeeded") && idle());
  assert.equal(new Set(ids.map((id) => queue.getTask(id).draftBatchId)).size, 1);
  assert.deepEqual(ids.map((id) => queue.getTask(id).instanceId), [first.id, first.id]);
  assert.deepEqual(ids.map((id) => queue.getTask(id).templateName), ["A", "B"]);
  assert.equal(queue.getTask(normal).instanceId, second.id);
  assert.equal(queue.getTask(normal).draftBatchId, undefined);
  assert.equal(sends.length, 3);
  assert.deepEqual(sends.filter((s) => ids.includes(s.taskId)).map((s) => s.taskId), ids);
});

test("没有账号时保留批次，首次派发跳过不可用号；不同批次可各用一个号", async () => {
  const ids = submitBatch();
  assert.ok(ids.every((id) => !queue.getTask(id).preferredInstanceId));
  const exhausted = account("exhausted"), first = account("first"), second = account("second");
  quota.setUsed(exhausted.id, "video", 20);
  queue.wakeQueue();
  const otherIds = submitBatch();
  await waitFor(() => [...ids, ...otherIds].every((id) => queue.getTask(id).status === "succeeded") && idle());
  assert.ok(ids.every((id) => queue.getTask(id).instanceId === first.id));
  assert.ok(otherIds.every((id) => queue.getTask(id).instanceId === second.id));
  assert.notEqual(queue.getTask(ids[0]).draftBatchId, queue.getTask(otherIds[0]).draftBatchId);
  assert.ok(!opens.includes(exhausted.id));
});

test("批次账号额度用尽后等待同一号，重载及重试保留绑定，不能单独改派", async () => {
  store.get().settings.quota.perDay = 1;
  const first = account("first"), second = account("second");
  const ids = submitBatch();
  await waitFor(() => queue.getTask(ids[0]).status === "succeeded" && idle());
  assert.equal(queue.getTask(ids[1]).status, "queued");
  assert.match(queue.getTask(ids[1]).waitReason, /等待批次账号 first/);
  assert.equal((await queue.redispatch(ids[1], second.id)).ok, false);
  store.load();
  queue.recoverTemplateTasks(); queue.wakeQueue();
  assert.equal(queue.getTask(ids[1]).preferredInstanceId, first.id);
  assert.equal(sends.length, 1);
  quota.setUsed(first.id, "video", 0);
  await queue.retryTask(ids[1], { preferredInstances: [second.id] });
  await waitFor(() => queue.getTask(ids[1]).status === "succeeded" && idle());
  assert.deepEqual(sends.map((s) => s.instanceId), [first.id, first.id]);
});

test("批次账号失效不拆批，其他正常任务仍跳到可登录账号", async () => {
  const first = account("expired"), second = account("logged");
  loggedIn = (inst) => inst.id !== first.id;
  const ids = submitBatch();
  await waitFor(() => opens.length === 1 && idle());
  assert.ok(ids.every((id) => queue.getTask(id).status === "queued"));
  assert.equal(sends.length, 0);
  const normal = queue.submitTemplate(templates.snapshot(template("normal").id)).taskId;
  await waitFor(() => queue.getTask(normal).status === "succeeded" && idle());
  assert.equal(queue.getTask(normal).instanceId, second.id);
  loggedIn = () => true;
  queue.wakeQueue(first.id);
  await waitFor(() => ids.every((id) => queue.getTask(id).status === "succeeded") && idle());
  assert.ok(sends.filter((s) => ids.includes(s.taskId)).every((s) => s.instanceId === first.id));
});

test("账号绑定写盘失败时整批回滚且不发送，恢复后统一绑定", async () => {
  const ids = submitBatch();
  const inst = account("first");
  const save = store.save;
  store.save = () => false;
  try { await assert.rejects(queue.dispatchOne(queue.getTask(ids[0]).storyboardId), /批次账号保存失败/); }
  finally { store.save = save; }
  assert.ok(ids.every((id) => !queue.getTask(id).preferredInstanceId));
  assert.equal(opens.length, 0);
  store.load(); queue.wakeQueue();
  await waitFor(() => ids.every((id) => queue.getTask(id).status === "succeeded") && idle());
  assert.ok(sends.every((s) => s.instanceId === inst.id));
});

test("未派发批次的手动派发也绑定整批，账号删除后不转移剩余任务", async () => {
  const ids = submitBatch();
  account("first"); const chosen = account("chosen");
  store.get().settings.quota.perDay = 1;
  await queue.redispatch(ids[0], chosen.id);
  await waitFor(() => queue.getTask(ids[0]).status === "succeeded" && idle());
  assert.ok(ids.every((id) => queue.getTask(id).preferredInstanceId === chosen.id));
  store.get().instances = store.get().instances.filter((i) => i.id !== chosen.id); store.save();
  queue.wakeQueue();
  assert.equal(queue.getTask(ids[1]).status, "queued");
  assert.match(queue.getTask(ids[1]).waitReason, /批次账号已删除/);
  assert.equal(sends.length, 1);
});
