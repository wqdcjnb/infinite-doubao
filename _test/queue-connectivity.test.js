"use strict";
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const P = require("../src/paths");
const store = require("../src/store");
const templates = require("../src/task-templates");
const orchestrator = require("../src/orchestrator");
const interceptor = require("../src/interceptor");
const quota = require("../src/quota");
const storyboard = require("../src/storyboard");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-queue-"));
let index = 0;
let sends;
let confirms;
let attempts;
let driver;
let session;
beforeEach(() => {
  orchestrator.stopAll();
  P.init({ home: path.join(root, String(++index)) }); store.load();
  Object.assign(store.get().settings.orchestrator, { maxParallel: 1, pollInterval: 1500, retryLimit: 0, autoDownload: true, autoConfirm: true, taskTimeoutMs: 100 });
  store.get().settings.downloadDir = path.join(P.home(), "downloads");
  store.get().settings.quota.perDay = 20;
  sends = []; confirms = 0; attempts = [];
  const bytes = Buffer.alloc(128); bytes.write("ftyp", 4);
  session = { cookies: { get: async () => [{ name: "sessionid" }] }, fetch: async () => ({ ok: true, status: 200, headers: new Map([["content-type", "video/mp4"]]), arrayBuffer: async () => bytes }) };
  driver = {
    beginTask: async () => ({ ok: true, baselineUrls: [], baselineMessageIds: [] }),
    isLoggedIn: async () => ({ loggedIn: true, by: "fixture" }),
    setGenerationOptions: async () => ({}), setText: async () => ({ ok: true }),
    send: async () => { sends.push("sent"); return { ok: true }; },
    confirmGeneration: async () => { confirms++; return { ok: true }; },
    readProgress: async () => ({ state: "done", percent: 100, mediaUrls: [`https://fixture.invalid/${index}.mp4?lr=watermark`] })
  };
  orchestrator.init({ findWebContents: () => null, sessionFor: () => session, resolveDriver: async (inst) => { attempts.push(inst.id); return driver; } });
});
after(() => {
  orchestrator.stopAll();
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected test directory");
  fs.rmSync(root, { recursive: true, force: true });
});
function account(id = "one") { return store.add({ id: `${index}-${id}`, name: id }); }
function submit() { return orchestrator.submitTemplate(templates.snapshot(templates.create({ prompt: "local fixture", duration: 5, model: "seedance_v2.0" }).id)).taskId; }
async function settled(id, includeQueued = false) {
  for (let n = 0; n < 220; n++) {
    const task = orchestrator.getTask(id);
    if (!orchestrator.state().running.length && (includeQueued || task.status !== "queued")) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Task not settled: ${JSON.stringify(orchestrator.getTask(id))}`);
}
test("提交先入队，新增账号唤醒；未打开账号也自动解析驱动并完成无水印交付", async () => {
  const id = submit();
  assert.equal(orchestrator.getTask(id).status, "queued");
  assert.match(orchestrator.getTask(id).waitReason, /尚无账号/);
  const inst = account(); orchestrator.wakeQueue(inst.id);
  const task = await settled(id);
  assert.equal(task.status, "succeeded");
  assert.equal(task.stage, "completed");
  assert.equal(task.result.unwatermarked, true);
  assert.equal(task.result.files.length, 1);
  assert.equal(fs.existsSync(task.result.files[0]), true);
  assert.equal(interceptor.list({ taskId: id }).length, 1);
  assert.deepEqual(attempts, [inst.id]);
  assert.equal(confirms, 0, "旧驱动不能再通过按钮确认生成");
});
test("空视频结果不能报成功，且手动重试只查询不重复生成", async () => {
  account(); driver.readProgress = async () => ({ state: "done", mediaUrls: [] });
  const id = submit();
  let task = await settled(id);
  assert.equal(task.status, "failed"); assert.match(task.error, /没有返回本次/);
  assert.equal(sends.length, 1);
  driver.readProgress = async () => ({ state: "done", mediaUrls: [`https://fixture.invalid/recovered-${index}.mp4?lr=watermark`] });
  await orchestrator.retryTask(id); task = await settled(id);
  assert.equal(task.status, "succeeded"); assert.equal(sends.length, 1);
});
test("没有视频进度时显示等待平台结果，真实进度恢复后再生成且不重发", async () => {
  account(); store.get().settings.orchestrator.taskTimeoutMs = 10000;
  let polls = 0; let id; const stages = [];
  driver.readProgress = async () => {
    stages.push({ stage: orchestrator.getTask(id).stage, reason: orchestrator.getTask(id).waitReason });
    polls++;
    if (polls === 1) return { state: "unknown", snippet: "大约1–3分钟，生成好后主动发送", mediaUrls: [] };
    if (polls === 2) return { state: "running", percent: 40, mediaUrls: [] };
    return { state: "done", mediaUrls: [`https://fixture.invalid/waiting-${index}.mp4?lr=watermark`] };
  };
  id = submit(); const task = await settled(id);
  assert.equal(stages[1].stage, "waiting_result"); assert.equal(stages[1].reason, "已提交，等待豆包返回本次视频结果");
  assert.equal(stages[2].stage, "generating"); assert.equal(stages[2].reason, "");
  assert.equal(task.status, "succeeded"); assert.equal(sends.length, 1);
});
test("下载失败保留结果，重试只下载且额度不重复计算", async () => {
  const inst = account(); session.fetch = async () => ({ ok: false, status: 403 });
  const id = submit(); let task = await settled(id);
  assert.equal(task.status, "failed"); assert.equal(task.result.resourceIds.length, 1);
  assert.equal(task.result.files.length, 0); assert.equal(quota.get(inst.id).video, 1);
  // Simulate a crash after the ledger was saved but before the task flag.
  task.quotaConsumed = false; store.save();
  const bytes = Buffer.alloc(128); bytes.write("ftyp", 4);
  session.fetch = async () => ({ ok: true, headers: new Map(), arrayBuffer: async () => bytes });
  await orchestrator.retryTask(id); task = await settled(id);
  assert.equal(task.status, "succeeded"); assert.equal(sends.length, 1); assert.equal(attempts.length, 1); assert.equal(quota.get(inst.id).video, 1);
});
test("页面额度拒绝后自动换可用账号；同一任务记录不复制", async () => {
  const first = account("first"); const second = account("second");
  orchestrator.init({ resolveDriver: async (inst) => { attempts.push(inst.id); return { ...driver, readProgress: inst.id === first.id ? async () => ({ state: "failed", snippet: "今日免费数量用完" }) : driver.readProgress }; } });
  const id = submit(); const task = await settled(id);
  assert.equal(task.status, "succeeded"); assert.deepEqual(attempts, [first.id, second.id]); assert.equal(store.get().tasks.length, 1); assert.equal(quota.canUse(first.id).ok, false);
});
test("已过期账号不发送，跳到已登录账号；没有可用号则保持排队", async () => {
  const first = account("expired"); const second = account("logged");
  orchestrator.init({ resolveDriver: async (inst) => { attempts.push(inst.id); return { ...driver, isLoggedIn: async () => ({ loggedIn: inst.id !== first.id, by: "login-button" }) }; } });
  const id = submit(); const task = await settled(id);
  assert.equal(task.status, "succeeded"); assert.deepEqual(attempts, [first.id, second.id]); assert.equal(sends.length, 1);
});
test("失败重试次数真实限制准备失败，关闭自动确认不点击确认", async () => {
  account(); store.get().settings.orchestrator.retryLimit = 1;
  orchestrator.init({ resolveDriver: async () => { attempts.push("attempt"); throw new Error("prepare fixture failed"); } });
  const id = submit(); const task = await settled(id);
  assert.equal(task.status, "failed"); assert.equal(attempts.length, 2); assert.equal(task.retryCount, 1); assert.equal(sends.length, 0);
  store.get().settings.orchestrator.autoConfirm = false;
  orchestrator.init({ resolveDriver: async () => driver });
  const second = await settled(submit()); assert.equal(second.status, "succeeded"); assert.equal(confirms, 0);
});
test("历史视频再次出现不作为新结果", async () => {
  const inst = account(); const url = `https://fixture.invalid/history-${index}.mp4?lr=watermark`;
  interceptor.push({ url, kind: "video", instanceId: inst.id });
  driver.beginTask = async () => ({ ok: true, baselineUrls: [url] });
  driver.readProgress = async () => ({ state: "done", mediaUrls: [url] });
  const task = await settled(submit()); assert.equal(task.status, "failed"); assert.match(task.error, /没有返回本次/); assert.equal(task.result, null);
});
test("恢复排队保留已提交标记，继续取回不会重新发送", async () => {
  account(); driver.readProgress = async () => ({ state: "done", mediaUrls: [] });
  const id = submit(); const task = await settled(id);
  task.status = "running"; store.save(); orchestrator.recoverTemplateTasks();
  assert.equal(task.status, "queued"); assert.ok(task.submittedAt);
  driver.readProgress = async () => ({ state: "done", mediaUrls: [`https://fixture.invalid/restart-${index}.mp4?lr=watermark`] });
  orchestrator.wakeQueue(); const done = await settled(id); assert.equal(done.status, "succeeded"); assert.equal(sends.length, 1);
});
test("旧分镜派发带入默认模型时长，附件与提示词完成后才建立结果基线", async () => {
  account(); const calls = [];
  driver.call = async (_method, options) => { calls.push(["prepare", options]); return { ok: true }; };
  driver.pasteFiles = async () => { calls.push(["upload"]); return { ok: true }; };
  driver.setText = async () => { calls.push(["text"]); return { ok: true }; };
  driver.beginTask = async () => { calls.push(["baseline"]); return { ok: true, baselineUrls: [] }; };
  const sb = storyboard.create({ name: "legacy", shots: [{ videoPrompt: "legacy", refs: ["fixture.png"] }] });
  orchestrator.start(sb.id); const task = await settled(store.get().tasks[0].id);
  assert.equal(task.status, "succeeded"); assert.ok(task.model); assert.ok(task.duration > 0);
  assert.equal(calls.findIndex(([call]) => call === "baseline") > calls.findIndex(([call]) => call === "text"), true);
  assert.equal(calls.findIndex(([call]) => call === "baseline") > calls.findIndex(([call]) => call === "upload"), true);
});
test("模型不可用跳过账号，不耗重试次数；全部不可用留在队列", async () => {
  const first = account("restricted"); const second = account("supported");
  orchestrator.init({ resolveDriver: async (inst) => { attempts.push(inst.id); return { ...driver, call: async () => inst.id === first.id ? { ok: false, code: "model_unavailable", reason: "账号未开通模型" } : { ok: true } }; } });
  const task = await settled(submit()); assert.equal(task.status, "succeeded"); assert.deepEqual(attempts, [first.id, second.id]); assert.equal(task.retryCount, 0); assert.equal(sends.length, 1);
});
test("旧页面返回明确的模型或时长权限错误仍会自动换号", async () => {
  const first = account("no-model"); const second = account("no-duration"); const third = account("supported");
  const reasons = { [first.id]: "当前账号未开通 Seedance 2.5", [second.id]: "当前账号不能使用所选视频时长" };
  orchestrator.init({ resolveDriver: async (inst) => { attempts.push(inst.id); return { ...driver, call: async () => reasons[inst.id] ? { ok: false, reason: reasons[inst.id] } : { ok: true } }; } });
  const task = await settled(submit());
  assert.equal(task.status, "succeeded"); assert.deepEqual(attempts, [first.id, second.id, third.id]); assert.equal(task.retryCount, 0); assert.equal(sends.length, 1);
});

test("未找到视频入口不排除账号、不发送提示词，打开入口后可用同一账号重试", async () => {
  const inst = account();
  driver.call = async () => ({ ok: false, reason: "未找到豆包的视频生成入口，请确认账号已登录且支持视频生成" });
  const id = submit(); let task = await settled(id);
  assert.equal(task.status, "failed"); assert.equal(sends.length, 0);
  assert.equal(task.accountExclusions?.[inst.id], undefined);
  driver.call = async () => ({ ok: true });
  await orchestrator.retryTask(id); task = await settled(id);
  assert.equal(task.status, "succeeded"); assert.equal(sends.length, 1);
  assert.deepEqual(attempts, [inst.id, inst.id]);
});

test("页面准备失败的错误码优先于权限关键词，加载完成后自动重试同一账号", async () => {
  const inst = account(); store.get().settings.orchestrator.retryLimit = 1;
  let count = 0;
  driver.call = async () => ++count === 1 ? { ok: false, code: "prepare_failed", reason: "当前账号没有可选择的 Seedance 2.0" } : { ok: true };
  const task = await settled(submit());
  assert.equal(task.status, "succeeded"); assert.equal(task.retryCount, 1);
  assert.equal(task.accountExclusions?.[inst.id], undefined);
  assert.equal(sends.length, 1); assert.deepEqual(attempts, [inst.id, inst.id]);
});
test("取回重试恢复原会话，不在后来打开的其他聊天里读结果", async () => {
  account(); let currentUrl = "https://fixture.invalid/chat/100";
  let navigated = "";
  driver.url = async () => currentUrl;
  driver.navigate = async (url) => { navigated = url; currentUrl = url; };
  driver.ready = async () => true;
  driver.readProgress = async () => ({ state: "done", mediaUrls: [] });
  const id = submit(); let task = await settled(id); assert.equal(task.status, "failed"); assert.equal(task.conversationUrl, currentUrl);
  currentUrl = "https://fixture.invalid/chat/999";
  driver.readProgress = async () => ({ state: "done", mediaUrls: [`https://fixture.invalid/conversation-${index}.mp4?lr=watermark`] });
  await orchestrator.retryTask(id); task = await settled(id);
  assert.equal(task.status, "succeeded"); assert.equal(navigated, "https://fixture.invalid/chat/100"); assert.equal(sends.length, 1);
});
test("页面只跟踪新消息和视频，旧完成文案与付费确认不会触发", () => {
  let nodes = [];
  const oldVideo = { currentSrc: "https://fixture.invalid/old.mp4", querySelector() { return null; } };
  const old = { id: "old", innerText: "生成完成", getAttribute: (key) => key === "data-message-id" ? "old" : null, querySelectorAll: (sel) => sel === "video" ? [oldVideo] : [] };
  nodes = [old];
  let clicks = 0;
  const button = { isConnected: true, disabled: false, innerText: "确认生成", getBoundingClientRect: () => ({width:100,height:30}), getAttribute: () => null, click: () => clicks++ };
  const fresh = { id: "new", innerText: "购买会员后生成", getAttribute: (key) => key === "data-message-id" ? "new" : null, querySelectorAll: (sel) => sel === "video" ? [{ currentSrc: "https://fixture.invalid/new.mp4", querySelector() { return null; } }] : [button] };
  const document = { body: { innerText: "生成完成" }, querySelectorAll: (sel) => sel === "[data-message-id]" ? nodes : sel === "video" ? [oldVideo] : [] };
  const context = vm.createContext({ window: {}, document, CFG: { autoKey: "auto" }, URL, location: {href:"https://fixture.invalid"}, getComputedStyle: () => ({display:"block", visibility:"visible",opacity:1}) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/automation.js"), "utf8"), context);
  const api = context.window.auto; api.beginTask({ taskId: "task" });
  assert.equal(api.readProgress().state, "unknown");
  nodes.push(fresh); api.confirmGeneration(); assert.equal(clicks, 0);
  fresh.innerText = "确认生成"; api.confirmGeneration(); api.confirmGeneration(); assert.equal(clicks, 1);
  assert.equal(api.readProgress().state, "done"); assert.deepEqual(Array.from(api.readProgress().mediaUrls), ["https://fixture.invalid/new.mp4"]);
});
