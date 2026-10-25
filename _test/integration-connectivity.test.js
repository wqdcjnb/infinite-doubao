"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const main = read("src/main.js");
const page = require("../src/page");
const { Driver, open } = require("../src/driver");
const functionSource = (name, nextMarker) => main.slice(main.indexOf(name), main.indexOf(nextMarker, main.indexOf(name)));

test("main bootstrap and actual preload register the real account automation and selected model", async () => {
  let profileHandler;
  const settings = { enhancer: { enabled: true, model: "seedance_v2.0", duration: 10 } };
  const profileContext = vm.createContext({ ipcMain: { on: (_name, cb) => { profileHandler = cb; } }, sessionMod: { accountBySession: () => ({ id: "integration-account", name: "Integration", fingerprint: null }) }, store: { get: () => ({ settings }) } });
  vm.runInContext(main.match(/ipcMain\.on\("dm:fp-profile",[\s\S]*?\r?\n  \}\);/)[0], profileContext);
  const event = { sender: { session: {} } };
  profileHandler(event);
  let injected;
  const preload = vm.createContext({ require: (name) => name === "electron" ? { ipcRenderer: { send() {}, sendSync: () => event.returnValue }, webFrame: { executeJavaScript: async (script) => { injected = script; } } } : name === "./page" ? page : { installFingerprint() {} }, location: { href: "http://127.0.0.1/test" } });
  vm.runInContext(read("src/webview-preload.js").split("const HOST =")[0], preload);
  const context = vm.createContext({ window: {}, document: { title: "Ready account", readyState: "complete" } });
  vm.runInContext(injected, context);
  const driver = new Driver({ instance: { id: "integration-account" }, webContents: { executeJavaScript: async (script) => vm.runInContext(script, context) } });
  assert.equal(await driver.ready(50), true);
  assert.equal(await driver.title(), "Ready account");
  const enhanced = context.window[driver.key + "_enh"];
  assert.equal(enhanced.model, "seedance_v2.0");
  assert.equal(enhanced.duration, 10);
  await driver.setGenerationOptions({ model: "seedance_v2.5", duration: 15 });
  assert.equal(enhanced.model, "seedance_v2.5");
  assert.equal(enhanced.duration, 15);
});

test("driver rejects missing automation instead of returning an unusable driver", async () => {
  await assert.rejects(open({ id: "missing" }, { timeoutMs: 1, webContents: { executeJavaScript: async () => false } }), /自动化未就绪/);
  const closed = new Driver({ instance: { id: "closed" }, webContents: { isDestroyed: () => true } });
  await assert.rejects(closed.title().then(() => closed.setText("never")), /网页已关闭/);
});

test("opening a queued account requests its background tab once and reuses its webContents", async () => {
  const inst = { id: "new-account" };
  const wc = {};
  let found = null;
  const requests = [];
  let prepared = 0;
  const context = vm.createContext({ openingAccounts: new Map(), Date, mainWindow: { isDestroyed: () => false }, store: { find: () => inst }, findWebContents: () => found, prepareSession: async () => { prepared++; }, pushToUi: (name, payload) => { requests.push({name, payload}); found = wc; }, driverMod: { sleep: async () => {} } });
  vm.runInContext(functionSource("async function ensureAccountWebContents", "function applyStopHotkey"), context);
  const first = context.ensureAccountWebContents(inst);
  const second = context.ensureAccountWebContents(inst);
  assert.equal(await first, wc);
  assert.equal(await second, wc);
  assert.equal(await context.ensureAccountWebContents(inst), wc);
  assert.equal(prepared, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, "dm:account:open");
  assert.equal(requests[0].payload.instanceId, inst.id);
});

test("server settings can start a stopped server, stop it, rebind its port, and replace its token", async () => {
  const settings = { server: { enabled: true } };
  const calls = [];
  const context = vm.createContext({ server: null, store: { get: () => ({ settings }) }, startServer: async () => { calls.push("start"); context.server = { port: settings.server.port || 17823, setToken: (value) => calls.push(["token", value]) }; }, stopServer: async () => { calls.push("stop"); context.server = null; } });
  vm.runInContext(functionSource("async function applyServerSettings", "/* ------------------------------------------------------------- 编排器装配 */"), context);
  await context.applyServerSettings({ enabled: true });
  assert.deepEqual(calls, ["start"]);
  await context.applyServerSettings({ token: "test-only-token" });
  assert.deepEqual(calls[1], ["token", "test-only-token"]);
  settings.server.port = 19005;
  await context.applyServerSettings({ port: 19005 });
  assert.equal(context.server.port, 19005);
  assert.deepEqual(calls.slice(-2), ["stop", "start"]);
  settings.server.enabled = false;
  await context.applyServerSettings({ enabled: false });
  assert.equal(context.server, null);
});

test("changing stop hotkey retains the previous binding when registration fails", () => {
  const registered = new Set(["F10"]);
  const context = vm.createContext({ registeredStopHotkey: "F10", globalShortcut: { register: (key) => { if (key === "bad") return false; registered.add(key); return true; }, unregister: (key) => registered.delete(key) }, orchestrator: {}, pushToUi() {}, log: {} });
  vm.runInContext(functionSource("function applyStopHotkey", "/* ------------------------------------------------------------------ 窗口 */"), context);
  assert.throws(() => context.applyStopHotkey("bad"), /无法注册/);
  assert.equal(registered.has("F10"), true);
  context.applyStopHotkey("F9");
  assert.deepEqual([...registered], ["F9"]);
});

test("application shutdown preserves the next-launch API setting, explicit stop disables it", async () => {
  const settings = { server: { enabled: true } };
  let saves = 0;
  const context = vm.createContext({ server: { stop: async () => {} }, sse: { close() {} }, store: { get: () => ({ settings }), save: () => { saves++; } } });
  vm.runInContext(functionSource("async function stopServer", "async function applyServerSettings"), context);
  await context.stopServer({ persist: false });
  assert.equal(settings.server.enabled, true);
  assert.equal(saves, 0);
  context.server = { stop: async () => {} };
  await context.stopServer();
  assert.equal(settings.server.enabled, false);
  assert.equal(saves, 1);
});

test("SPA login cookie updates wake a waiting account once and ignore unrelated cookies", async () => {
  const cookies = new EventEmitter();
  const session = { cookies };
  const wakes = [];
  const context = vm.createContext({ watchedLoginSessions: new WeakSet(), sessionMod: { applySession: async () => session }, interceptor: { attach() {} }, store: { proxyUrlOf: () => "" }, accountProbe: { LOGIN_COOKIES: ["sessionid"] }, orchestrator: { wakeQueue: (id) => wakes.push(id) }, setTimeout, clearTimeout });
  vm.runInContext(functionSource("async function prepareSession", "async function prepareAllSessions"), context);
  await context.prepareSession({ id: "spa-account" });
  await context.prepareSession({ id: "spa-account" });
  assert.equal(cookies.listenerCount("changed"), 1);
  cookies.emit("changed", {}, { name: "tracking-only" });
  cookies.emit("changed", {}, { name: "sessionid" });
  cookies.emit("changed", {}, { name: "sessionid" });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(wakes, ["spa-account"]);
});
