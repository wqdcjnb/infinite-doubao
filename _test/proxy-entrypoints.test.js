"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function functionSource(name) {
  const result = main.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(result, `Missing actual main function: ${name}`);
  return result[0];
}

function fixture() {
  const steps = []; const ipc = new Map(); const configured = [];
  const instance = { id: "fixture-account", partition: "persist:fixture-account", url: "https://www.doubao.com/chat/?fixture=route", proxy: { mode: "system" } };
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
  const diagnosticResult = { ok: true, mode: "system", ip: "203.0.113.2", countryCode: "US", country: "美国", city: "阿什本", source: "https://ipwho.is/?lang=zh-CN" };
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
  assert.equal(f.diagnostics[0].opts.targetUrl, f.instance.url, "按账号目标URL匹配代理规则");
  assert.equal(result.ip, "203.0.113.2");
  for (const key of ["domestic", "international", "differentExits"]) assert.equal(key in result, false, "入口只返回一个检测结果");
  assert.equal(f.accountSession.cookies.listenerCount("changed"), 1);
});

test("入口透传账号目标和检测国别，不按直连或代理模式改写归属地", async () => {
  const f = fixture(); f.resolveSession();
  for (const mode of ["direct", "system", "custom"]) {
    f.instance.proxy.mode = mode;
    f.instance.url = `https://fixture.invalid/${mode}`;
    const result = await f.invoke("proxy:test", f.instance.id);
    assert.equal(f.diagnostics.at(-1).opts.mode, mode);
    assert.equal(f.diagnostics.at(-1).opts.targetUrl, f.instance.url);
    assert.equal(result.countryCode, "US"); assert.equal(result.country, "美国"); assert.equal(result.city, "阿什本");
    assert.equal(result.ip, "203.0.113.2");
  }
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
  f.diagnosticResult.ok = false; f.diagnosticResult.ip = "";
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
