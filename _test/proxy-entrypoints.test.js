"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const apiSource = fs.readFileSync(path.join(__dirname, "../src/api.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function functionSource(name) {
  const result = main.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(result, `Missing actual main function: ${name}`);
  return result[0];
}

function fixture() {
  const steps = []; const ipc = new Map(); const configured = [];
  const instance = { id: "fixture-account", partition: "persist:fixture-account", proxy: { mode: "system" } };
  const accountSession = { cookies: new EventEmitter(), fetch() { throw new Error("No network in entrypoint tests"); } };
  let resolveSession, rejectSession;
  const sessionReady = new Promise((resolve, reject) => { resolveSession = resolve; rejectSession = reject; });
  const data = { settings: { server: { enabled: true, port: 17823 } } };
  const instances = {
    get: (id) => id === instance.id ? instance : null,
    update(id, patch) {
      if (id !== instance.id) return null;
      steps.push("save"); Object.assign(instance, patch); return instance;
    }
  };
  const orchestrator = { wakeQueue: (id) => { assert.equal(id, instance.id); steps.push("wake"); } };
  const diagnosticResult = { ok: true, mode: "system", domestic: { ok: true, ip: "192.0.2.1" }, international: { ok: true, ip: "203.0.113.2" }, differentExits: true };
  const diagnostics = [];
  const proxyDiagnostics = { async testProxy(ses, opts) { steps.push("diagnose"); diagnostics.push({ ses, opts }); return diagnosticResult; } };
  const store = { get: () => data, save: () => true, proxyUrlOf: () => "fixture-proxy-url" };
  const context = vm.createContext({
    require(name) {
      assert.equal(name, "electron");
      return { ipcMain: { handle: (channel, handler) => ipc.set(channel, handler), on() {} } };
    },
    instances, orchestrator, proxyDiagnostics, store, webHandlers: new Map(), watchedLoginSessions: new WeakSet(),
    sessionMod: { applySession(input) { steps.push("apply"); configured.push(input); return sessionReady; } },
    interceptor: { attach(ses, inst) { assert.equal(ses, accountSession); assert.equal(inst, instance); steps.push("attach"); } },
    accountProbe: { LOGIN_COOKIES: ["sessionid"] }, setTimeout, clearTimeout
  });
  // Execute the real registration function and real prepareSession, including its await.
  vm.runInContext(functionSource("prepareSession") + "\n" + functionSource("registerIpc"), context);
  context.registerIpc();
  return {
    context, instance, instances, orchestrator, store, steps, ipc, configured, diagnostics, diagnosticResult,
    accountSession, resolveSession: () => resolveSession(accountSession), rejectSession,
    invoke: (name, ...args) => ipc.get(name)({ sender: { session: { wrongRendererSession: true } } }, ...args)
  };
}

test("代理检测等账号会话配置完成，使用该账号session而非UI发送者session", async () => {
  const f = fixture(); let returned = false;
  const pending = f.invoke("proxy:test", f.instance.id).then((result) => { returned = true; return result; });
  await flush();
  assert.deepEqual(f.steps, ["apply"]); assert.equal(returned, false); assert.equal(f.diagnostics.length, 0);
  assert.equal(f.configured[0].partition, f.instance.partition); assert.equal(f.configured[0].proxyUrl, "fixture-proxy-url");
  f.resolveSession(); const result = await pending;
  assert.equal(result, f.diagnosticResult); assert.deepEqual(f.steps, ["apply", "attach", "diagnose"]);
  assert.equal(f.diagnostics[0].ses, f.accountSession); assert.equal(f.diagnostics[0].opts.mode, "system");
  assert.equal(f.accountSession.cookies.listenerCount("changed"), 1);
});

test("代理配置失败时检测不执行且不返回假成功或原始认证错误", async () => {
  const f = fixture(); const pending = f.invoke("proxy:test", f.instance.id);
  f.rejectSession(new Error("fixture-user:fixture-secret@proxy.invalid"));
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.message, /设置应用失败/);
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  assert.deepEqual(f.steps, ["apply"]); assert.equal(f.diagnostics.length, 0);
});

test("不存在的账号不会配置会话，检测结果失败也不会被入口改成成功", async () => {
  const f = fixture();
  const missing = await f.invoke("proxy:test", "missing");
  assert.equal(missing.ok, false); assert.deepEqual(f.steps, []);
  f.diagnosticResult.ok = false; f.diagnosticResult.domestic.ok = false; f.diagnosticResult.international.ok = false;
  f.resolveSession(); const result = await f.invoke("proxy:test", f.instance.id);
  assert.equal(result, f.diagnosticResult); assert.equal(result.ok, false);
});

for (const channel of ["account:update", "dm:instance:update"]) {
  test(`${channel} 保存新配置后等待会话应用，再唤醒队列及返回`, async () => {
    const f = fixture(); let returned = false;
    const patch = { proxy: { mode: "direct" } };
    const pending = f.invoke(channel, f.instance.id, patch).then((value) => { returned = true; return value; });
    await flush();
    assert.deepEqual(f.steps, ["save", "apply"]); assert.equal(returned, false);
    assert.equal(f.configured[0].proxy.mode, "direct");
    f.resolveSession(); const result = await pending;
    assert.deepEqual(f.steps, ["save", "apply", "attach", "wake"]);
    assert.equal(channel.startsWith("dm:") ? result.data : result, f.instance);
    if (channel.startsWith("dm:")) assert.equal(result.ok, true);
  });

  test(`${channel} 会话配置拒绝时不唤醒队列，也不报告保存成功`, async () => {
    const f = fixture(); const pending = f.invoke(channel, f.instance.id, { proxy: { mode: "fixed_servers" } });
    if (channel.startsWith("dm:")) {
      f.rejectSession(new Error("fixture apply failed")); const result = await pending;
      assert.equal(result.ok, false); assert.match(result.error, /fixture apply failed/);
    } else {
      const rejected = assert.rejects(pending, /fixture apply failed/);
      f.rejectSession(new Error("fixture apply failed")); await rejected;
    }
    assert.deepEqual(f.steps, ["save", "apply"]);
  });
}

async function restFixture() {
  const f = fixture(); const routes = new Map();
  const apiContext = vm.createContext({ module: { exports: {} }, require(name) {
    if (name === "./instances") return f.instances;
    if (name === "./orchestrator") return f.orchestrator;
    if (name === "./store") return f.store;
    if (name.startsWith("node:")) return require(name);
    return {};
  } });
  vm.runInContext(apiSource, apiContext, { filename: "src/api.js" });
  class HttpServer {
    constructor() { this.port = 17823; }
    get(route, handler) { routes.set("GET " + route, handler); }
    post(route, handler) { routes.set("POST " + route, handler); }
    patch(route, handler) { routes.set("PATCH " + route, handler); }
    del(route, handler) { routes.set("DELETE " + route, handler); }
    async start() {}
    info() { return { port: this.port }; }
  }
  Object.assign(f.context, {
    server: null, httpMod: { HttpServer }, api: apiContext.module.exports, findWebContents() {}, pushToUi() {},
    mcp: { init() {}, setup() {} }, sse: { setup() {} }, log: { info() {} }
  });
  // startServer must inject its actual prepareSession into api.init; no test-only injection.
  vm.runInContext(functionSource("startServer"), f.context);
  await f.context.startServer();
  const responses = [];
  const invoke = (id = f.instance.id) => routes.get("PATCH /api/instances/:id")({
    params: { id }, body: { proxy: { mode: "direct" } },
    ok(value) { f.steps.push("respond"); const response = { ok: true, value }; responses.push(response); return response; },
    fail(status, message) { const response = { ok: false, status, message }; responses.push(response); return response; }
  });
  return { ...f, responses, invoke };
}

test("REST PATCH通过真实startServer注入prepareSession，完成配置后才唤醒和响应", async () => {
  const f = await restFixture(); const pending = f.invoke();
  await flush(); assert.deepEqual(f.steps, ["save", "apply"]); assert.equal(f.responses.length, 0);
  assert.equal(f.configured[0].proxy.mode, "direct");
  f.resolveSession(); const response = await pending;
  assert.deepEqual(f.steps, ["save", "apply", "attach", "wake", "respond"]);
  assert.equal(response.ok, true); assert.equal(response.value, f.instance);
});

test("REST PATCH配置失败向HTTP层传播异常，不发成功响应也不唤醒", async () => {
  const f = await restFixture(); const pending = f.invoke();
  const rejected = assert.rejects(pending, /fixture apply failed/);
  f.rejectSession(new Error("fixture apply failed")); await rejected;
  assert.deepEqual(f.steps, ["save", "apply"]); assert.equal(f.responses.length, 0);
});

test("REST PATCH不存在账号返回404，不配置其他账号会话", async () => {
  const f = await restFixture(); const result = await f.invoke("missing");
  assert.equal(result.ok, false); assert.equal(result.status, 404); assert.deepEqual(f.steps, []);
});
