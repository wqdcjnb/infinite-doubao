"use strict";

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../src/paths");
const store = require("../src/store");
const interceptor = require("../src/interceptor");
const quota = require("../src/quota");
const { HttpServer, tokenFile } = require("../src/http");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-settings-connectivity-"));
let sequence = 0;
beforeEach(() => { P.init({ home: path.join(root, String(++sequence)) }); store.load(); });
after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

const views = fs.readFileSync(path.join(__dirname, "../renderer/views.js"), "utf8");
function rendererFunction(name) {
  const source = views.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(source, `renderer function ${name}`);
  return source[0];
}

test("接口设置只提交用户修改字段，端口和启停不再被运行状态覆盖", async () => {
  const submitted = [];
  const messages = [];
  const context = vm.createContext({
    V: { server: { port: 17823, running: true } },
    DM: { saveSettings: async (patch) => { submitted.push(JSON.parse(JSON.stringify(patch))); return patch; } },
    guard: async (fn) => fn(), refreshBadges: async () => {}, refreshSettings: async () => {}, say: (message) => messages.push(message)
  });
  vm.runInContext(rendererFunction("patchServer"), context);
  await context.patchServer("port", 19000);
  await context.patchServer("enabled", false);
  context.V.server = null;
  await context.patchServer("enabled", true);
  assert.deepEqual(submitted, [{ server: { port: 19000 } }, { server: { enabled: false } }, { server: { enabled: true } }]);
  assert.equal(messages.length, 3);
  context.DM.saveSettings = async () => { throw new Error("端口占用"); };
  await assert.rejects(context.patchServer("port", 19001), /端口占用/);
  assert.equal(messages.length, 3, "保存失败不出现成功提示");
});

test("旧自定义模板命名设置迁移后真正用于下载命名", () => {
  store.get().settings.naming = "template";
  store.get().settings.namingTemplate = "{account}_{index}_{prompt}";
  assert.equal(store.save(), true);
  store.load();
  assert.equal(store.get().settings.naming, "custom");
  assert.equal(interceptor.buildFileName({ url: "https://example.invalid/result.mp4", kind: "video", instanceName: "测试账号" }, { index: 7, prompt: "山景" }), "测试账号_0007_山景.mp4");
});

test("设置保存和迁移规范数值，零次重试保留且额度不会意外回退为四条", () => {
  const settings = store.get().settings;
  Object.assign(settings.orchestrator, { maxParallel: -1, pollInterval: 500, retryLimit: 0 });
  settings.quota.perDay = 0;
  settings.server.port = 999999;
  assert.equal(store.save(), true);
  store.load();
  const saved = store.get().settings;
  assert.equal(saved.orchestrator.maxParallel, 1);
  assert.equal(saved.orchestrator.pollInterval, 1500);
  assert.equal(saved.orchestrator.retryLimit, 0);
  assert.equal(saved.server.port, 65535);
  assert.equal(quota.limits().perDay, 1);
  Object.assign(saved.orchestrator, { maxParallel: 2.6, pollInterval: NaN, retryLimit: -2 });
  store.save();
  assert.equal(saved.orchestrator.maxParallel, 3);
  assert.equal(saved.orchestrator.pollInterval, 4000);
  assert.equal(saved.orchestrator.retryLimit, 0);
  saved.orchestrator.retryLimit = 99;
  store.save();
  assert.equal(saved.orchestrator.retryLimit, 10, "设置上限与执行器一致，不能显示99次但实际只重试10次");
});

test("token修改立即用于认证且本地文件同步，轮换重启后不会复活旧自定义值", () => {
  const custom = "test-only-custom-token-not-a-secret";
  const changed = "test-only-changed-token-not-a-secret";
  store.get().settings.server.token = custom;
  store.save();
  const server = new HttpServer({ token: custom });
  const accepted = (value) => server.auth({ headers: { authorization: `Bearer ${value}` } }, new URL("http://127.0.0.1/api/state"));
  assert.equal(fs.readFileSync(tokenFile(), "utf8"), custom);
  server.setToken(changed);
  assert.equal(accepted(custom), false);
  assert.equal(accepted(changed), true);
  assert.equal(fs.readFileSync(tokenFile(), "utf8"), changed);
  server.rotateToken();
  assert.equal(accepted(changed), false);
  store.load();
  assert.equal(store.get().settings.server.token, "");
  const restarted = new HttpServer({ token: store.get().settings.server.token });
  assert.equal(restarted.token, server.token);
  assert.notEqual(restarted.token, custom);
});

test("任务队列显示执行阶段、进度、等待原因及未下载提示", () => {
  const context = vm.createContext({});
  vm.runInContext(rendererFunction("taskStatusText") + "\n" + rendererFunction("taskResultText"), context);
  assert.equal(context.taskStatusText({ status: "queued", stage: "waiting_account" }), "等待可用账号");
  assert.equal(context.taskStatusText({ status: "running", stage: "waiting_confirmation" }), "等待参数确认");
  assert.equal(context.taskStatusText({ status: "queued", stage: "retrying" }), "等待重试");
  assert.equal(context.taskStatusText({ status: "running", stage: "generating", progress: 42 }), "生成中 42%");
  assert.equal(context.taskStatusText({ status: "running", stage: "downloading" }), "下载并检查成片");
  assert.equal(context.taskStatusText({ status: "failed", stage: "generating", progress: 42 }), "失败");
  assert.equal(context.taskResultText({ waitReason: "请先登录账号" }), "请先登录账号");
  assert.match(context.taskResultText({ result: { downloadSkipped: true } }), /尚未保存到素材库/);
  assert.match(context.taskResultText({ result: { files: ["C:\\audit\\video.mp4"], unwatermarked: false } }), /尚未确认为无水印.*video.mp4/);
});

test("提高并发上限唤醒第二账号，关闭自动下载仅保存结果地址", async () => {
  const templates = require("../src/task-templates");
  const orchestrator = require("../src/orchestrator");
  Object.assign(store.get().settings.orchestrator, { maxParallel: 1, autoDownload: false, autoConfirm: false, retryLimit: 0, pollInterval: 1500 });
  store.add({ id: "parallel-one", name: "账号一" });
  store.add({ id: "parallel-two", name: "账号二" });
  const pending = [];
  let downloads = 0;
  let sends = 0;
  const driverFor = (instance) => ({
    isLoggedIn: async () => ({ loggedIn: true }), call: async () => ({ ok: true }),
    beginTask: async () => ({ ok: true, baselineUrls: [], baselineMessageIds: [] }),
    setGenerationOptions: async () => ({}), setText: async () => ({ ok: true }),
    url: async () => `https://fixture.invalid/chat/${instance.id}`,
    send: async () => { sends++; return { ok: true }; },
    readProgress: async () => ({ state: "done", mediaUrls: [`https://fixture.invalid/${instance.id}.mp4?lr=unwatermarked`] })
  });
  orchestrator.init({
    resolveDriver: (instance) => new Promise((resolve) => pending.push(() => resolve(driverFor(instance)))),
    sessionFor: () => ({ cookies: { get: async () => [{ name: "sessionid" }] }, fetch: async () => { downloads++; throw new Error("自动下载关闭时不应请求视频"); } })
  });
  const template = templates.create({ prompt: "设置运行时验证", model: "seedance_v2.0", duration: 5 });
  try {
    const first = orchestrator.submitTemplate(templates.snapshot(template.id));
    const second = orchestrator.submitTemplate(templates.snapshot(template.id));
    assert.equal(orchestrator.state().running.length, 1);
    assert.equal(orchestrator.getTask(second.taskId).status, "queued");
    store.get().settings.orchestrator.maxParallel = 2;
    store.save();
    orchestrator.wakeQueue();
    assert.equal(orchestrator.state().running.length, 2);
    assert.equal(new Set(orchestrator.state().running.map((task) => task.instanceId)).size, 2);
    pending.forEach((release) => release());
    for (let count = 0; count < 100 && orchestrator.state().running.length; count++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(orchestrator.state().running.length, 0);
    assert.equal(sends, 2);
    assert.equal(downloads, 0);
    for (const submitted of [first, second]) {
      const task = orchestrator.getTask(submitted.taskId);
      assert.equal(task.status, "succeeded");
      assert.equal(task.result.downloadSkipped, true);
      assert.equal(task.result.urls.length, 1);
      assert.deepEqual(task.result.files, []);
    }
  } finally { pending.forEach((release) => release()); orchestrator.stopAll(); }
});
