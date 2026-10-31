"use strict";
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../src/paths");
const store = require("../src/store");
const templates = require("../src/task-templates");
const queue = require("../src/orchestrator");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-draft-only-"));
let sequence = 0;
beforeEach(() => {
  queue.stopAll();
  P.init({ home: path.join(home, String(++sequence)) });
  store.load();
  queue.init({ draftsOnly: true });
});
after(() => { queue.stopAll(); fs.rmSync(home, { recursive: true, force: true }); });

test("客户端拒绝模板直接生成，模板和草稿数据保持不变", () => {
  const template = templates.create({ name: "保留模板", prompt: "山间小屋" });
  const before = JSON.stringify(store.get());
  assert.throws(() => queue.submitTemplate(templates.snapshot(template.id)), /草稿箱/);
  assert.equal(JSON.stringify(store.get()), before);
});

test("旧直接生成任务在重启、唤醒和人工重试后均不能打开网页或重发", async () => {
  queue.init({ draftsOnly: false });
  const template = templates.create({ prompt: "旧任务" });
  const { taskId } = queue.submitTemplate(templates.snapshot(template.id));
  queue.stopAll();
  const task = queue.getTask(taskId);
  task.status = "queued";
  let opened = 0;
  queue.init({ draftsOnly: true, resolveDriver: async () => { opened++; throw Error("不得打开旧生成网页"); } });
  store.add({ id: "legacy-account", name: "旧账号" });
  queue.recoverTemplateTasks();
  queue.wakeQueue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, 0);
  assert.equal((await queue.retryTask(taskId)).ok, false);
  assert.equal((await queue.redispatch(taskId, "legacy-account")).ok, false);
  assert.equal((await queue.dispatchOne(task.storyboardId)).ok, false);
  assert.equal(queue.start(task.storyboardId).ok, false);
  assert.equal(queue.resume(task.storyboardId).ok, false);
  assert.equal(opened, 0);
  assert.ok(queue.getTask(taskId), "保留历史记录，不删除用户数据");
  assert.equal(queue.taskList().length, 0, "客户端记录页只展示云电脑草稿任务");
});

test("客户端只注册草稿工作流和账号辅助通道，旧生成、网页版及素材工具不可调用", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const source = main.match(/^function registerIpc\([^]*?^}/m)[0];
  const handlers = new Map();
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), on() {} };
  vm.runInNewContext(source + "\nregisterIpc();", {
    require: () => ({ ipcMain }), ipcMain, webHandlers: new Map()
  });
  for (const name of ["account:create", "account:update", "dm:templates", "dm:template:attach", "dm:drafts:collect", "dm:drafts:save", "dm:drafts:submit", "dm:tasks", "dm:task:retry"]) assert.ok(handlers.has(name), name);
  for (const name of ["dm:template:submit", "dm:storyboard:start", "dm:task:redispatch", "dm:web:open", "dm:web:status", "dm:server:start", "dm:mcp:tools", "mask:run", "dm:asset:grid", "dm:jianying:edit", "dm:components:install"]) assert.equal(handlers.has(name), false, name);
});
