"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const sessionSource = fs.readFileSync(path.join(__dirname, "../src/session.js"), "utf8");

function fixture() {
  const sessions = new Map();
  const records = [];
  const hooks = {};
  const getSession = (partition) => {
    if (!sessions.has(partition)) sessions.set(partition, {
      setUserAgent() {}, setPermissionRequestHandler() {}, setSpellCheckerEnabled() {},
      webRequest: { onBeforeSendHeaders() {} },
      async setProxy(config) {
        records.push({ op: "set", partition, config: JSON.parse(JSON.stringify(config)) });
        await hooks.set?.(partition, config);
      },
      async closeAllConnections() { records.push({ op: "close", partition }); await hooks.close?.(partition); },
      async clearAuthCache() { records.push({ op: "auth", partition }); await hooks.auth?.(partition); }
    });
    return sessions.get(partition);
  };
  const context = vm.createContext({
    module: { exports: {} }, URL,
    require(name) {
      if (name === "electron") return { session: { fromPartition: getSession }, app: { userAgentFallback: "fixture" } };
      if (name === "./store") return { proxyUrlOf: (inst) => inst.proxy.url, get: () => ({ instances: [] }) };
      if (name === "./logger") return { warn() {} };
      throw new Error(`Unexpected module: ${name}`);
    }
  });
  vm.runInContext(sessionSource, context);
  return { ...context.module.exports, hooks, records, getSession };
}
const instance = (mode, url = "", partition = "fixture-A") => ({ partition, proxy: { mode, url } });
const drain = () => new Promise((resolve) => setImmediate(resolve));

test("首次装配和同配置重复准备不会关闭连接，并发重复只配置一次", async () => {
  const f = fixture();
  let release;
  f.hooks.set = () => new Promise((resolve) => { release = resolve; });
  const first = f.applySession(instance("direct"));
  const same = f.applySession(instance("direct"));
  await drain();
  assert.equal(f.records.length, 1);
  release();
  await Promise.all([first, same]);
  await f.applySession(instance("direct", "http://unused.invalid:8888"));
  assert.deepEqual(f.records.map((r) => r.op), ["set"]);
});

test("真正切换配置先setProxy后关闭连接，未改变的检测不再关闭", async () => {
  const f = fixture();
  await f.applySession(instance("direct"));
  await f.applySession(instance("system"));
  await f.applySession(instance("system"));
  assert.deepEqual(f.records.map((r) => r.op), ["set", "set", "close"]);
  await f.applySession(instance("custom", "http://proxy.invalid:8080"));
  assert.deepEqual(f.records.at(-2).config, { mode: "fixed_servers", proxyRules: "http://proxy.invalid:8080", proxyBypassRules: "<local>" });
  await f.applySession(instance("custom", "http://proxy.invalid:8080/"));
  assert.equal(f.records.filter((r) => r.op === "close").length, 2);
});

test("同端点仅认证变化仍切换并清HTTP认证缓存，普通准备保留认证连接", async () => {
  const f = fixture();
  await f.applySession(instance("custom", "http://user:fixture-old@proxy.invalid:8080"));
  await f.applySession(instance("custom", "http://user:fixture-new@proxy.invalid:8080"));
  await f.applySession(instance("custom", "http://user:fixture-new@proxy.invalid:8080"));
  assert.deepEqual(f.records.map((r) => r.op), ["set", "set", "auth", "close"]);
  assert.equal(f.authFor("proxy.invalid:8080").password, "fixture-new", "保留既有认证接口兼容");
});

test("并发变化按调用快照串行执行，后续修改实例对象不会篡改已排队配置", async () => {
  const f = fixture();
  let release, active = 0, maximum = 0;
  f.hooks.set = async (_partition, config) => {
    maximum = Math.max(maximum, ++active);
    if (config.mode === "direct") await new Promise((resolve) => { release = resolve; });
    active--;
  };
  const mutable = instance("direct");
  const first = f.applySession(mutable);
  mutable.proxy = { mode: "custom", url: "http://proxy.invalid:8080" };
  const second = f.applySession(mutable);
  mutable.proxy = { mode: "system" };
  const third = f.applySession(mutable);
  await drain();
  assert.equal(f.records.length, 1);
  release();
  await Promise.all([first, second, third]);
  assert.equal(maximum, 1);
  assert.deepEqual(f.records.filter((r) => r.op === "set").map((r) => r.config.mode), ["direct", "fixed_servers", "system"]);
  assert.equal(f.records.filter((r) => r.op === "close").length, 2);
});

test("不同账号会话互不阻塞且不会关闭另一个账号的连接", async () => {
  const f = fixture();
  let release;
  f.hooks.set = (partition) => partition === "fixture-A" ? new Promise((resolve) => { release = resolve; }) : undefined;
  const a = f.applySession(instance("direct"));
  await f.applySession(instance("direct", "", "fixture-B"));
  await f.applySession(instance("system", "", "fixture-B"));
  assert.deepEqual(f.records.filter((r) => r.op === "close").map((r) => r.partition), ["fixture-B"]);
  release(); await a;
});

test("setProxy失败传播给调用者，后续排队调用仍能重试成功", async () => {
  const f = fixture();
  let attempts = 0;
  f.hooks.set = () => { if (++attempts === 1) throw new Error("fixture setProxy failure"); };
  await assert.rejects(f.applySession(instance("direct")), /fixture setProxy failure/);
  await f.applySession(instance("direct"));
  assert.equal(attempts, 2);
  assert.equal(f.records.filter((r) => r.op === "close").length, 0);
});

test("关闭旧连接失败不能记录成功，下次恢复旧配置仍必须真正应用", async () => {
  const f = fixture();
  await f.applySession(instance("direct"));
  f.hooks.close = () => { throw new Error("fixture close failure"); };
  await assert.rejects(f.applySession(instance("system")), /fixture close failure/);
  f.hooks.close = undefined;
  await f.applySession(instance("direct"));
  assert.deepEqual(f.records.filter((r) => r.op === "set").map((r) => r.config.mode), ["direct", "system", "direct"]);
  assert.equal(f.records.filter((r) => r.op === "close").length, 2);
});

test("非法自定义代理必须失败，HTTP与HTTPS默认端口不会误回直连", async () => {
  const f = fixture();
  await assert.rejects(f.applySession(instance("custom", "http://proxy.invalid:not-a-port")), /代理地址格式/);
  assert.equal(f.records.length, 0);
  assert.equal(f.parseProxyUrl("http://proxy.invalid:80").port, "80");
  assert.equal(f.parseProxyUrl("https://proxy.invalid:443").port, "443");
  assert.equal(f.parseProxyUrl("socks5://proxy.invalid"), null);
});

const P = require("../src/paths");
const store = require("../src/store");
const instances = require("../src/instances");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-session-proxy-"));
P.init({ home: root }); store.load();
after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

test("保存或检测现有掩码代理时保留真正的加密密码", () => {
  const inst = instances.create({ name: "proxy-secret-fixture", proxy: { mode: "custom", url: "http://user:fixture-password@proxy.invalid:8080" } });
  assert.equal(inst.proxy.url, "http://user:***@proxy.invalid:8080");
  instances.update(inst.id, { proxy: { ...inst.proxy } });
  assert.equal(store.proxyUrlOf(inst), "http://user:fixture-password@proxy.invalid:8080");
  instances.update(inst.id, { name: "renamed-fixture" });
  instances.update(inst.id, { proxy: { mode: "system" } });
  instances.update(inst.id, { proxy: { mode: "custom", url: inst.proxy.url } });
  assert.equal(store.proxyUrlOf(inst), "http://user:fixture-password@proxy.invalid:8080");
});

test("显式填写新密码或移除密码仍按用户输入更新", () => {
  const inst = instances.create({ name: "proxy-change-fixture", proxy: { mode: "custom", url: "http://user:fixture-old@proxy.invalid:8080" } });
  instances.update(inst.id, { proxy: { mode: "custom", url: "http://user:fixture-new@proxy.invalid:8080" } });
  assert.equal(store.proxyUrlOf(inst), "http://user:fixture-new@proxy.invalid:8080");
  instances.update(inst.id, { proxy: { mode: "custom", url: "http://proxy.invalid:8080" } });
  assert.equal(inst.proxy.hasPassword, false);
  assert.equal(store.proxyUrlOf(inst), "http://proxy.invalid:8080");
});
