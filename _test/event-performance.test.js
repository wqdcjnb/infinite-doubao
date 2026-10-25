"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function load(name, stubs, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src", name + ".js"), "utf8"), {
    module, exports: module.exports,
    require: (key) => key.startsWith("node:") ? require(key) : stubs[key] || {},
    ...globals
  }, { filename: name + ".js" });
  return module.exports;
}

function queueFixture() {
  const task = { id: "fixture", stage: "waiting_confirmation", waitReason: "等待确认生成参数", progress: 0 };
  let saves = 0;
  let saveOk = true;
  const events = [];
  const queue = load("orchestrator", { "./store": {
    get: () => ({ tasks: [task] }), save: () => { saves++; return saveOk; }
  } });
  queue.events.on("event", (event) => events.push(event));
  return { queue, task, events, saves: () => saves, failSave: () => { saveOk = false; } };
}

test("50次完全相同的等待状态轮询不再写盘或发送任务事件", (t) => {
  const f = queueFixture();
  for (let i = 0; i < 50; i++) {
    assert.equal(f.queue.patchTask(f.task.id, { stage: f.task.stage, waitReason: f.task.waitReason }), f.task);
  }
  assert.equal(f.saves(), 0);
  assert.equal(f.events.length, 0);
  t.diagnostic("50 identical patches: 0 saves, 0 events (before: 50 saves, 50 events)");
});

test("真正的状态变化仍保存并通知，随后相同进度不重复通知", () => {
  const f = queueFixture();
  f.queue.patchTask(f.task.id, { stage: "generating", progress: 42, waitReason: "" });
  for (let i = 0; i < 50; i++) f.queue.patchTask(f.task.id, { progress: 42 });
  assert.equal(f.saves(), 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].task, f.task);
  assert.equal(f.task.stage, "generating");
  assert.equal(f.task.progress, 42);
});

test("durable相同值补丁仍强制落盘，失败仍抛错且不发事件", () => {
  const f = queueFixture();
  f.queue.patchTask(f.task.id, { stage: f.task.stage }, true);
  assert.equal(f.saves(), 1);
  assert.equal(f.events.length, 1);
  f.failSave();
  assert.throws(() => f.queue.patchTask(f.task.id, { stage: f.task.stage }, true), /任务状态保存失败/);
  assert.equal(f.saves(), 2);
  assert.equal(f.events.length, 1);
});

test("durable变更落盘失败仍回滚，不能留下未持久化的发送意图", () => {
  const f = queueFixture();
  f.task.submittedAt = "";
  f.failSave();
  assert.throws(() => f.queue.patchTask(f.task.id, { submittedAt: "2026-10-25T00:00:00Z" }, true), /任务状态保存失败/);
  assert.equal(f.task.submittedAt, "");
  assert.equal(f.events.length, 0);
});

function streamFixture() {
  const tasks = new EventEmitter();
  const resources = new EventEmitter();
  const logs = new Set();
  const timers = new Set();
  const routes = new Map();
  const server = { get: (route, handler) => routes.set(route, handler) };
  const stream = load("sse", {
    "./orchestrator": { events: tasks, state: () => ({ running: [] }) },
    "./interceptor": { events: resources },
    "./logger": { onLog: (fn) => { logs.add(fn); return () => logs.delete(fn); } }
  }, {
    setInterval: () => { const timer = { unref() {} }; timers.add(timer); return timer; },
    clearInterval: (timer) => timers.delete(timer)
  });
  function connect() {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.frames = [];
    res.ended = false;
    res.writeHead = () => {};
    res.write = (frame) => { res.frames.push(frame); return true; };
    res.end = () => { res.ended = true; res.emit("close"); };
    routes.get("/events")({ req, res });
    return res;
  }
  return { stream, server, tasks, resources, logs, timers, connect };
}

test("25次API重启后没有残留订阅，重复setup也只注册一套", (t) => {
  const f = streamFixture();
  for (let i = 0; i < 25; i++) {
    f.stream.setup(f.server);
    f.stream.setup(f.server);
    assert.equal(f.tasks.listenerCount("event"), 1);
    assert.equal(f.resources.listenerCount("add"), 1);
    assert.equal(f.resources.listenerCount("update"), 1);
    assert.equal(f.logs.size, 1);
    assert.equal(f.timers.size, 1);
    f.stream.close();
    f.stream.close();
    assert.equal(f.tasks.listenerCount("event"), 0);
    assert.equal(f.resources.listenerCount("add"), 0);
    assert.equal(f.resources.listenerCount("update"), 0);
    assert.equal(f.logs.size, 0);
    assert.equal(f.timers.size, 0);
  }
  t.diagnostic("25 setup/close cycles: 0 remaining task/resource/log listeners (before: 25 each)");
});

test("无SSE客户端时不序列化；连接后每种事件只发送一次，关闭结束连接", () => {
  const f = streamFixture();
  f.stream.setup(f.server);
  let serialized = 0;
  const data = { toJSON: () => { serialized++; return { id: "fixture" }; } };
  f.tasks.emit("event", data);
  f.resources.emit("update", data);
  for (const log of f.logs) log(data);
  f.stream.broadcast("direct", data);
  assert.equal(serialized, 0);
  const res = f.connect();
  res.frames.length = 0;
  f.tasks.emit("event", data);
  f.resources.emit("update", data);
  for (const log of f.logs) log(data);
  assert.equal(serialized, 3);
  assert.equal(res.frames.length, 3);
  assert.deepEqual(res.frames.map((frame) => frame.match(/^event: (\w+)/)[1]), ["task", "resource", "log"]);
  f.stream.close();
  assert.equal(res.ended, true);
  assert.equal(f.stream.count(), 0);
  f.stream.broadcast("direct", data);
  assert.equal(serialized, 3);
});
