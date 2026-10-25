"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { testProxy } = require("../src/proxy-diagnostics");
const CN = "https://myip.ipip.net/", BACKUP = "https://ip.3322.net/", GLOBAL = "https://ipwho.is/?lang=zh-CN";
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const ipip = (ip = "192.0.2.1", where = "中国 广东 东莞 chinamobile.com") => response(`当前 IP：${ip} 来自于：${where}\n`);
const globalIp = (ip = "203.0.113.2", extra = {}) => response(JSON.stringify({ ip, success: true, country_code: "US", country: "United States", region: "Virginia", city: "Ashburn", connection: { isp: "Example ISP" }, ...extra }));
function session(routes) {
  const calls = [];
  const value = { calls, async fetch(url, options) {
    assert.equal(this, value, "使用传入Electron会话的方法，不能换成全局fetch");
    calls.push({ url, options });
    assert.equal(options.cache, "no-store"); assert.ok(options.signal instanceof AbortSignal);
    const route = routes[url];
    if (typeof route === "function") return route(options);
    if (route instanceof Error) throw route;
    if (!route) throw new Error("Unexpected fixture URL: " + url);
    return route;
  } };
  return value;
}

test("同一会话并行检测两侧，地址不同仅标记出口不同且字段来自响应", async () => {
  let domesticReady, internationalReady;
  const ses = session({ [CN]: () => new Promise((resolve) => { domesticReady = resolve; }), [GLOBAL]: () => new Promise((resolve) => { internationalReady = resolve; }) });
  const pending = testProxy(ses, { mode: "system", timeoutMs: 1000 });
  assert.equal(ses.calls.length, 2); assert.notEqual(ses.calls[0].options.signal, ses.calls[1].options.signal);
  domesticReady(ipip()); internationalReady(globalIp());
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.mode, "system"); assert.equal(result.differentExits, true);
  assert.equal(result.domestic.countryCode, "CN"); assert.equal(result.domestic.city, "东莞"); assert.equal(result.domestic.isp, "chinamobile.com");
  assert.equal(result.international.countryCode, "US"); assert.equal(result.international.city, "Ashburn");
  assert.equal(result.domestic.source, CN); assert.equal(result.international.source, GLOBAL);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt))); assert.ok(result.domestic.latency >= 0);
  assert.equal("proxy" in result, false); assert.equal("isProxy" in result, false);
});

test("相同出口不标不同，代理模式描述不能把响应国家改成国内", async () => {
  const ses = session({ [CN]: ipip("203.0.113.2", "美国 弗吉尼亚 阿什本 Example ISP"), [GLOBAL]: globalIp() });
  const result = await testProxy(ses, { mode: "direct" });
  assert.equal(result.differentExits, false); assert.equal(result.domestic.countryCode, "US");
  assert.equal(result.domestic.country, "美国"); assert.equal(result.domestic.city, "阿什本");
  assert.equal(result.mode, "direct"); assert.equal(ses.calls.length, 2);
});

test("国内备用源只提供IP时，成功但位置未知，不能猜中国或借用国际定位", async () => {
  const ses = session({ [CN]: response("unavailable", 503), [BACKUP]: response("203.0.113.2\n"), [GLOBAL]: globalIp() });
  const result = await testProxy(ses, { mode: "proxy" });
  assert.equal(result.ok, true); assert.equal(result.domestic.ok, true); assert.equal(result.domestic.ip, "203.0.113.2");
  assert.equal(result.domestic.source, BACKUP); assert.equal(result.domestic.location, "位置未知");
  for (const key of ["countryCode", "country", "region", "city", "isp"]) assert.equal(result.domestic[key], "");
  assert.match(result.domestic.message, /备用源.*位置未知/); assert.equal(result.differentExits, false);
  assert.equal(new Set(ses.calls.map((call) => call.options.signal)).size, 3);
});

test("国内两源失败仍保留国际结果，不把国外地址冒充国内站检测", async () => {
  const ses = session({ [CN]: new Error("offline"), [BACKUP]: response("not an IP"), [GLOBAL]: globalIp() });
  const result = await testProxy(ses, { mode: "system" });
  assert.equal(result.ok, true); assert.equal(result.domestic.ok, false); assert.equal(result.domestic.ip, "");
  assert.equal(result.international.ok, true); assert.equal(result.international.ip, "203.0.113.2"); assert.equal(result.differentExits, false);
});

test("国际失败或JSON错误不会抹掉国内结果，缺IP不能报成功", async () => {
  for (const failed of [response("<html>network login</html>"), globalIp("999.1.1.1"), globalIp("203.0.113.2", { success: false }), response("{}"), response("denied", 403)]) {
    const result = await testProxy(session({ [CN]: ipip(), [GLOBAL]: failed }), { mode: "direct" });
    assert.equal(result.ok, true); assert.equal(result.domestic.ok, true); assert.equal(result.international.ok, false);
    assert.equal(result.international.ip, ""); assert.ok(result.international.message); assert.equal(result.differentExits, false);
  }
});

test("双侧失败明确失败且不泄露网络错误中的代理凭据", async () => {
  const secret = "private-user:fixture-secret";
  const fail = new Error(`Cannot fetch using http://${secret}@proxy.invalid:8080`);
  const result = await testProxy(session({ [CN]: fail, [BACKUP]: fail, [GLOBAL]: fail }), { mode: "proxy" });
  assert.equal(result.ok, false); assert.match(result.message, /均失败/);
  assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(result.differentExits, false);
});

test("IPv6不同表示归一为同一地址，IPv6不同地址仍能识别", async () => {
  const first = await testProxy(session({ [CN]: ipip("2001:0DB8:0000:0000:0000:0000:0000:0001"), [GLOBAL]: globalIp("2001:db8::1") }));
  assert.equal(first.ok, true); assert.equal(first.domestic.ip, "2001:db8::1"); assert.equal(first.differentExits, false);
  const second = await testProxy(session({ [CN]: ipip("2001:db8::1"), [GLOBAL]: globalIp("2001:db8::2") }));
  assert.equal(second.differentExits, true);
});

test("每侧独立超时，悬挂的fetch不会拖住已成功的另一侧", async () => {
  const ses = session({ [CN]: ipip(), [GLOBAL]: () => new Promise(() => {}) });
  const result = await testProxy(ses, { mode: "system", timeoutMs: 15 });
  assert.equal(result.domestic.ok, true); assert.equal(result.international.ok, false);
  assert.match(result.international.message, /超时/);
  assert.equal(ses.calls.find((call) => call.url === GLOBAL).options.signal.aborted, true);
  assert.equal(ses.calls.find((call) => call.url === CN).options.signal.aborted, false);
});

test("超时覆盖读取响应体，国内超时备用请求也独立受限", async () => {
  const hangingBody = { ok: true, text: () => new Promise(() => {}) };
  const ses = session({ [CN]: hangingBody, [BACKUP]: () => new Promise(() => {}), [GLOBAL]: hangingBody });
  const result = await testProxy(ses, { timeoutMs: 10 });
  assert.equal(result.ok, false); assert.equal(ses.calls.length, 3);
  assert.ok(ses.calls.every((call) => call.options.signal.aborted)); assert.match(result.domestic.message, /超时/);
});

test("成功、HTTP失败和解析失败均在finally清理每个请求定时器", async () => {
  const timers = new Set(); let cleared = 0;
  const context = vm.createContext({
    module: { exports: {} }, require, URL, AbortController,
    setTimeout(fn) { const timer = { fn }; timers.add(timer); return timer; },
    clearTimeout(timer) { assert.equal(timers.delete(timer), true); cleared++; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/proxy-diagnostics.js"), "utf8"), context);
  const ses = session({ [CN]: response("bad body"), [BACKUP]: response("192.0.2.20"), [GLOBAL]: response("unavailable", 500) });
  const result = await context.module.exports.testProxy(ses, { mode: "system" });
  assert.equal(result.domestic.ok, true); assert.equal(result.international.ok, false);
  assert.equal(cleared, 3); assert.equal(timers.size, 0);
});
