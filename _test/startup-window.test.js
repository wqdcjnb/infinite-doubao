"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
function functionSource(name) {
  const match = main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `missing function ${name}`); return match[0];
}
function fixture({ loadError = null } = {}) {
  const created = []; const diagnostics = []; const exits = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = options.show; this.destroyed = false; this.minimized = false; this.calls = [];
      this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {};
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.calls.push("restore"); this.minimized = false; }
    show() { this.calls.push("show"); this.visible = true; }
    focus() { this.calls.push("focus"); }
    loadFile(file) { this.loadedFile = file; return loadError ? Promise.reject(loadError) : Promise.resolve(); }
  }
  const app = new EventEmitter(); app.isReady = () => true; app.exit = (code) => exits.push(code); app.whenReady = () => Promise.resolve();
  const dialog = { showErrorBox: (title, message) => diagnostics.push({ title, message }) };
  const context = vm.createContext({
    app, dialog, BrowserWindow: FakeWindow, startupReady: true, startupFailed: false, appQuitting: false, mainWindow: null, draftWindows: new Set(),
    path, __dirname: "C:/fixture/src", brand: { name: "无限豆包" }, BOOT_LOG: "C:/fixture/boot.log", bootLog() {},
    require: (name) => { assert.equal(name, "electron"); return { app, dialog }; },
    process: { exit: (code) => exits.push(code) }, log: { info() {}, error() {}, init() {} },
    shell: { openExternal() {} }, instances: { list: () => [] }, webviewPreloadPath: () => "C:/fixture/preload.js"
  });
  for (const name of ["reportStartupFailure", "showMainWindow", "createWindow"]) vm.runInContext(functionSource(name), context);
  vm.runInContext(main.match(/^app\.on\("before-quit"[^\n]+/m)[0], context);
  const secondInstance = main.slice(main.indexOf('  app.on("second-instance"'), main.indexOf('  app.whenReady().then'));
  vm.runInContext(secondInstance, context);
  return { context, app, created, diagnostics, exits };
}
test("没有ready-to-show事件也显式显示主窗口，首屏加载后再兜底显示", () => {
  const f = fixture(); f.context.createWindow();
  assert.equal(f.created.length, 1);
  const win = f.created[0]; assert.equal(win.options.show, true); assert.equal(win.visible, true);
  assert.ok(win.calls.includes("show")); assert.ok(win.calls.includes("focus"));
  win.visible = false; win.webContents.emit("did-finish-load"); assert.equal(win.visible, true);
});
test("二次启动会显露隐藏或最小化窗口，而不是只focus", () => {
  const f = fixture(); f.context.createWindow(); const win = f.created[0];
  win.visible = false; win.minimized = true; win.calls = [];
  f.app.emit("second-instance");
  assert.deepEqual(win.calls, ["restore", "show", "focus"]); assert.equal(win.visible, true); assert.equal(f.created.length, 1);
});
test("二次启动发现主窗口缺失或已销毁时重新创建", () => {
  const f = fixture(); f.app.emit("second-instance"); assert.equal(f.created.length, 1);
  f.created[0].destroyed = true; f.app.emit("second-instance"); assert.equal(f.created.length, 2); assert.equal(f.created[1].visible, true);
});
test("主页面加载失败显示诊断并退出，不遗留占锁的隐藏进程", async () => {
  const f = fixture({ loadError: new Error("fixture index.html missing") }); f.context.createWindow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.diagnostics.length, 1); assert.match(f.diagnostics[0].message, /index.html missing/); assert.match(f.diagnostics[0].message, /boot.log/);
  assert.deepEqual(f.exits, [1]);
  f.created[0].webContents.emit("did-fail-load", {}, -6, "file missing", "", true);
  assert.equal(f.diagnostics.length, 1); assert.deepEqual(f.exits, [1]);
});
test("创建窗口前的迁移异常进入可见诊断和退出路径", async () => {
  const f = fixture(); f.context.startupReady = false;
  f.context.P = { init() {}, dir: () => "fixture" }; f.app.getPath = () => "fixture";
  f.context.store = { load() {} }; f.context.taskTemplates = { migrateLegacy: async () => { throw new Error("fixture migration write denied"); } };
  const start = main.indexOf('  app.whenReady().then'); const end = main.indexOf('  app.on("will-quit"', start);
  vm.runInContext(main.slice(start, end), f.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.created.length, 0); assert.equal(f.diagnostics.length, 1); assert.match(f.diagnostics[0].message, /migration write denied/); assert.deepEqual(f.exits, [1]);
});
test("加载过程中正常关闭窗口后的加载拒绝不会误报启动失败", async () => {
  const f = fixture({ loadError: new Error("ERR_ABORTED") }); f.context.createWindow();
  const win = f.created[0]; win.destroyed = true; win.emit("closed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.diagnostics.length, 0); assert.deepEqual(f.exits, []);
});
test("正常退出期间渲染器结束不会弹错或被二次启动重新显露", () => {
  const f = fixture(); f.context.createWindow(); const win = f.created[0]; win.calls = [];
  f.app.emit("before-quit");
  win.webContents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
  f.app.emit("second-instance");
  assert.equal(f.diagnostics.length, 0); assert.deepEqual(f.exits, []); assert.deepEqual(win.calls, []);
});
test("关闭主窗口同步销毁所有临时草稿页面，不遗留隐藏进程", () => {
  const f = fixture(); f.context.createWindow();
  let closed = 0;
  for (let i = 0; i < 2; i++) f.context.draftWindows.add({ isDestroyed: () => false, destroy: () => { closed++; } });
  f.created[0].emit("closed");
  assert.equal(closed, 2); assert.equal(f.context.mainWindow, null);
});
