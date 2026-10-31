"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../renderer/views.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const tasks = Array.from({ length: 20 }, (_, i) => ({ id: "task-" + i, status: i % 2 ? "failed" : "succeeded", createdAt: "2026-10-25T00:00:00Z", templateName: "任务 " + i, model: "fixture", duration: 5 }));
const media = (i) => ({ path: `C:\\fixture\\成片${i}.mp4`, url: `file:///C:/fixture/${i}.mp4`, name: `成片${i}.mp4`, size: 2048, modifiedAt: "2026-10-25T00:00:00Z", watermark: "none" });
const logLine = (i) => ({ t: new Date(1761350400000 + i).toISOString(), event: "fixture-" + i, level: "info", value: i });

function fixture({ code = source, call: customCall } = {}) {
  const counts = { calls: {}, taskRenders: 0, logRows: 0, videos: 0, movedCards: 0, maxActive: {} };
  const selectors = new Map(); const handlers = {}; const documentEvents = {}; const timers = new Map(); const active = {};
  let nextTimer = 0;
  class Element {
    constructor(tag = "div") {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.listeners = {}; this.style = {}; this.dataset = {}; this.value = ""; this.checked = true;
      this.scrollTop = 0; this.clientHeight = 200; this._text = "";
      this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (tag === "video") { counts.videos++; this.currentTime = 2; this.paused = false; }
    }
    set className(value) { this._class = value; if (value.startsWith("log-line ")) counts.logRows++; }
    get className() { return this._class || ""; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
    get scrollHeight() { return this.children.length * 20; }
    get firstElementChild() { return this.children[0]; }
    get lastElementChild() { return this.children.at(-1); }
    appendChild(child) { return this.insertBefore(child, null); }
    append(...children) { children.forEach((child) => this.appendChild(child)); }
    insertBefore(child, before) {
      if (child === before) return child;
      if (child.parentElement === this && child.tagName === "ARTICLE") counts.movedCards++;
      child.remove(); const at = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(at, 0, child); child.parentElement = this; return child;
    }
    replaceChildren(...children) {
      if (this.id === "taskTable") counts.taskRenders++;
      for (const child of this.children.slice()) child.remove(); this._text = ""; this.append(...children);
    }
    remove() { if (this.parentElement) { const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; } }
    replaceWith(child) { const parent = this.parentElement; if (parent) { parent.insertBefore(child, this); this.remove(); } }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    dispatch(name) { for (const fn of this.listeners[name] || []) fn({ target: this }); }
    pause() { this.paused = true; }
  }
  const get = (selector) => {
    if (!selectors.has(selector)) { const element = new Element(); element.id = selector.slice(1); selectors.set(selector, element); }
    return selectors.get(selector);
  };
  const document = {
    hidden: false, readyState: "loading", createElement: (tag) => new Element(tag), createElementNS: (_ns, tag) => new Element(tag),
    querySelector: get, querySelectorAll: () => [],
    addEventListener(name, fn) { (documentEvents[name] ||= []).push(fn); }
  };
  const state = { brand: { version: "fixture" }, settings: {}, models: [], counts: {}, server: { port: 17823 }, orchestrator: { running: [], parallel: 1 } };
  const DM = {
    onEvent: (fn) => { handlers.event = fn; }, onLog: (fn) => { handlers.log = fn; }, onResource: (fn) => { handlers.resource = fn; }, onHotkey() {},
    async call(channel, ...args) {
      counts.calls[channel] = (counts.calls[channel] || 0) + 1; active[channel] = (active[channel] || 0) + 1;
      counts.maxActive[channel] = Math.max(counts.maxActive[channel] || 0, active[channel]);
      try {
        if (customCall) { const value = await customCall(channel, ...args); if (value !== undefined) return { ok: true, data: value }; }
        const data = channel === "dm:state" ? state : channel === "dm:server" ? state.server : channel === "dm:tasks" ? tasks.filter((task) => !args[0]?.status || task.status === args[0].status) : channel === "dm:videos" ? { directory: "C:/fixture", items: [media(1)] } : [];
        return { ok: true, data: copy(data) };
      } finally { active[channel]--; }
    }
  };
  const window = { DM, DMUpdates: {} };
  const context = vm.createContext({ window, document, navigator: {}, console, setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout: (id) => timers.delete(id), setInterval() {} });
  const end = code.lastIndexOf('if (document.readyState === "loading")');
  assert.ok(end > 0);
  vm.runInContext(code.slice(0, end) + "window.testViews = {V, bindEvents, refreshTasks, refreshBadges, refreshLogs, renderLogs, setView};\n})();", context);
  const api = window.testViews; api.bindEvents();
  return {
    api, handlers, counts, document, get,
    visibility() { for (const fn of documentEvents.visibilitychange || []) fn(); },
    async settle() {
      for (let i = 0; i < 4; i++) { await flush(); for (const [id, timer] of [...timers]) if (timer.ms <= 100) { timers.delete(id); timer.fn(); } }
      await flush();
    }
  };
}

test("100条任务事件与100条任务日志合并为一次状态和任务请求", async (t) => {
  const f = fixture(); f.api.V.view = "tasks";
  for (let i = 0; i < 100; i++) { f.handlers.event({ type: "task", task: tasks[0] }); f.handlers.event({ type: "log", message: "routine" }); }
  await f.settle();
  assert.deepEqual(f.counts.calls, { "dm:state": 1, "dm:tasks": 1 }); assert.equal(f.counts.taskRenders, 1);
  assert.equal(f.counts.calls["dm:server"], undefined, "精简客户端不请求旧接口服务");
  t.diagnostic("200-event burst: state/server/tasks IPC 600 -> 2; full task table rebuilds 200 -> 1");
});

test("缓慢IPC不重入，途中变化合并补读且旧筛选结果不覆盖新筛选", async () => {
  const pending = [];
  const f = fixture({ call: (channel, filter) => channel === "dm:tasks" ? new Promise((resolve) => pending.push({ filter: copy(filter), resolve })) : undefined });
  f.api.V.view = "tasks"; f.api.V.taskFilter = "running";
  const first = f.api.refreshTasks(); await flush();
  f.api.V.taskFilter = "succeeded";
  const repeats = Array.from({ length: 30 }, () => f.api.refreshTasks());
  assert.equal(pending.length, 1);
  pending[0].resolve([{ id: "stale", status: "running" }]); await flush();
  assert.equal(f.counts.taskRenders, 0); assert.equal(pending.length, 2); assert.equal(pending[1].filter.status, "succeeded");
  pending[1].resolve([{ id: "latest", status: "succeeded" }]); await Promise.all([first, ...repeats]);
  assert.equal(f.api.V.tasks[0].id, "latest"); assert.equal(f.counts.taskRenders, 1); assert.equal(f.counts.maxActive["dm:tasks"], 1);
});

test("刷新发生前切页不读隐藏列表，窗口重新可见后恢复最新状态", async () => {
  const f = fixture(); f.api.V.view = "tasks"; f.handlers.event({ type: "task" }); f.api.V.view = "accounts";
  await f.settle(); assert.equal(f.counts.calls["dm:tasks"], undefined);
  f.document.hidden = true; f.api.V.view = "tasks"; f.handlers.event({ type: "task" }); await f.settle();
  assert.equal(f.counts.calls["dm:tasks"], undefined); assert.equal(f.counts.calls["dm:state"], 1);
  f.document.hidden = false; f.visibility(); await f.settle();
  assert.equal(f.counts.calls["dm:tasks"], 1); assert.equal(f.counts.calls["dm:state"], 2);
});

test("日志突发增量追加，最多400个DOM行和800条缓冲，筛选暂停清空均可用", async (t) => {
  const f = fixture(); f.api.V.view = "logs"; f.api.V.logLines = Array.from({ length: 400 }, (_, i) => logLine(i));
  f.api.renderLogs(); const body = f.get("#logBody"); body.scrollTop = body.scrollHeight;
  const retained = body.children[100];
  for (let i = 400; i < 500; i++) f.handlers.log(logLine(i)); await f.settle();
  assert.equal(body.children.length, 400); assert.equal(body.children[0], retained); assert.equal(f.counts.logRows, 500);
  assert.equal(body.scrollTop, body.scrollHeight);
  f.get("#logLive").checked = false;
  for (let i = 500; i < 1400; i++) f.handlers.log(logLine(i)); await f.settle();
  assert.equal(body.children.length, 400); assert.equal(f.api.V.logLines.length, 800); assert.equal(f.counts.logRows, 500);
  f.get("#logFilter").value = "fixture-1399"; f.get("#logFilter").dispatch("input"); await f.settle();
  assert.equal(body.children.length, 1); assert.match(body.textContent, /fixture-1399/);
  f.get("#logFilter").value = ""; f.get("#logLive").checked = true; f.get("#logLive").dispatch("change");
  assert.equal(body.children.length, 400);
  f.get("#logClear").dispatch("click"); assert.equal(body.children.length, 0); assert.equal(f.api.V.logLines.length, 0);
  t.diagnostic("400 existing logs + 100 new logs: row creations 40400 -> 500 (100 incremental), visible limit remains 400");
});

test("后台日志仅入缓冲，失败后后续刷新仍可用", async () => {
  let reads = 0;
  const f = fixture({ call: (channel) => { if (channel === "dm:tasks" && reads++ === 0) throw new Error("fixture IPC failure"); } });
  f.api.V.view = "accounts";
  for (let i = 0; i < 500; i++) { f.handlers.log(logLine(i)); }
  await f.settle(); assert.equal(f.counts.logRows, 0); assert.equal(f.counts.calls["dm:videos"], undefined);
  f.api.V.view = "tasks"; await f.api.refreshTasks(); await f.api.refreshTasks();
  assert.equal(f.api.V.tasks.length, 20); assert.equal(f.counts.maxActive["dm:tasks"], 1);
});

if (process.env.DM_PERF_COMPARE === "1") test("记录同一fixture下修改前后的真实操作计数", async (t) => {
  const { execFileSync } = require("node:child_process");
  const baseline = execFileSync("git", ["show", `${process.env.DM_PERF_BASELINE || "v1.3.2"}:renderer/views.js`], { cwd: path.join(__dirname, ".."), encoding: "utf8", windowsHide: true });
  const measure = async (code) => {
    const f = fixture({ code }); f.api.V.view = "tasks";
    for (let i = 0; i < 100; i++) { f.handlers.event({ type: "task", task: tasks[0] }); f.handlers.event({ type: "log" }); }
    await f.settle();
    f.api.V.view = "logs"; f.api.V.logLines = Array.from({ length: 400 }, (_, i) => logLine(i)); f.api.renderLogs();
    for (let i = 400; i < 500; i++) f.handlers.log(logLine(i)); await f.settle();
    return { ipc: Object.values(f.counts.calls).reduce((a, b) => a + b, 0), taskRenders: f.counts.taskRenders, logRows: f.counts.logRows };
  };
  const before = await measure(baseline); const after = await measure(source);
  assert.ok(after.ipc < before.ipc); assert.ok(after.logRows < before.logRows);
  t.diagnostic(JSON.stringify({ before, after }));
});
