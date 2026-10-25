"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { testProxy } = require("../src/proxy-diagnostics");
const TARGET = "https://www.doubao.com/chat/";
const IPIP = "https://myip.ipip.net/", BACKUP = "https://ip.3322.net/", IPWHO = "https://ipwho.is/?lang=zh-CN";
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const ipip = (ip = "192.0.2.1", where = "中国 广东 东莞 chinamobile.com") => response(`当前 IP：${ip} 来自于：${where}\n`);
const ipwho = (ip = "203.0.113.2", extra = {}) => response(JSON.stringify({ ip, success: true, country_code: "US", country: "美国", region: "弗吉尼亚", city: "阿什本", connection: { isp: "Example ISP" }, ...extra }));
function session(responses, routing = () => "DIRECT") {
  const calls = [], resolutions = [], resolvedCounts = new Map();
  const value = {
    calls, resolutions,
    async resolveProxy(url) {
      assert.equal(this, value); resolutions.push(url);
      resolvedCounts.set(url, (resolvedCounts.get(url) || 0) + 1);
      return routing(url, resolvedCounts.get(url));
    },
    async fetch(url, options) {
      assert.equal(this, value, "必须使用该账号的Electron Session");
      calls.push({ url, options });
      assert.equal(options.cache, "no-store"); assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
      const route = responses[url];
      if (typeof route === "function") return route(options);
      if (route instanceof Error) throw route;
      if (!route) throw new Error("Unexpected fixture URL: " + url);
      return route;
    }
  };
  return value;
}

test("直连结果在国外仍显示国外，只返回一个IP且首源成功后停止", async () => {
  const ses = session({ [IPIP]: ipip("203.0.113.2", "美国 弗吉尼亚 阿什本 Example ISP") });
  const result = await testProxy(ses, { mode: "direct" });
  assert.equal(result.ok, true); assert.equal(result.ip, "203.0.113.2"); assert.equal(result.countryCode, "US");
  assert.equal(result.country, "美国"); assert.equal(result.city, "阿什本"); assert.equal(result.mode, "direct");
  assert.equal(result.source, IPIP); assert.equal(ses.calls.length, 1);
  assert.deepEqual(ses.resolutions, [TARGET, IPIP, TARGET, IPIP]);
  assert.equal("domestic" in result, false); assert.equal("international" in result, false); assert.equal("differentExits" in result, false);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt))); assert.ok(result.latency >= 0);
});

test("自定义代理返回国内仍为国内，模式不参与地理判定", async () => {
  const ses = session({ [IPIP]: ipip() }, () => "PROXY proxy.invalid:8080");
  const result = await testProxy(ses, { mode: "custom" });
  assert.equal(result.ok, true); assert.equal(result.countryCode, "CN"); assert.equal(result.country, "中国");
  assert.equal(result.city, "东莞"); assert.equal(result.isp, "chinamobile.com"); assert.equal(result.mode, "custom");
  assert.equal(JSON.stringify(result).includes("proxy.invalid"), false);
});

test("PAC不同路由跳过不匹配源，仅请求与目标相同线路的第三源", async () => {
  const target = "https://www.doubao.com/chat/fixture";
  const ses = session({ [IPWHO]: ipwho() }, (url) => url === target || url === IPWHO ? "SOCKS5 proxy.invalid:1080" : "DIRECT");
  const result = await testProxy(ses, { mode: "system", targetUrl: target });
  assert.equal(result.ok, true); assert.equal(result.source, IPWHO); assert.equal(result.countryCode, "US");
  assert.deepEqual(ses.calls.map((call) => call.url), [IPWHO]);
  assert.deepEqual(ses.resolutions, [target, IPIP, BACKUP, IPWHO, target, IPWHO]);
});

test("规则空白和主机大小写可规范化，但整条有序回退链必须一致", async () => {
  const ses = session({ [IPIP]: ipip() }, (url) => url === TARGET ? " proxy PROXY.invalid:08080 ; direct " : "PROXY proxy.invalid:8080; DIRECT");
  assert.equal((await testProxy(ses)).ok, true);
  const different = session({}, (url) => url === TARGET ? "PROXY proxy.invalid:8080; DIRECT" : "PROXY proxy.invalid:8080");
  const result = await testProxy(different);
  assert.equal(result.ok, false); assert.match(result.message, /没有.*匹配/); assert.equal(different.calls.length, 0);
});

test("目标或检测源线路在返回前变化时，丢弃IP而非报告过期结果", async () => {
  for (const changed of [TARGET, IPIP]) {
    const ses = session({ [IPIP]: ipip() }, (url, count) => url === changed && count > 1 ? "PROXY changed.invalid:8080" : "DIRECT");
    const result = await testProxy(ses);
    assert.equal(result.ok, false); assert.equal(result.ip, ""); assert.match(result.message, /线路.*变化/);
    assert.deepEqual(ses.calls.map((call) => call.url), [IPIP]);
  }
});

test("目标线路空、无效或解析异常时不发检测请求，不泄露原始认证信息", async () => {
  const secret = "fixture-user:fixture-secret";
  for (const route of [() => "", () => " ; ", () => "not a proxy rule", () => `PROXY ${secret}@proxy.invalid:8080`, () => { throw new Error(secret); }]) {
    const ses = session({}, route); const result = await testProxy(ses, { mode: "custom" });
    assert.equal(result.ok, false); assert.equal(result.ip, ""); assert.equal(ses.calls.length, 0);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("源线路解析异常立即明确失败，不暗中换线路或继续其它站", async () => {
  const ses = session({ [BACKUP]: response("192.0.2.3") }, (url) => { if (url === IPIP) throw new Error("PAC unavailable"); return "DIRECT"; });
  const result = await testProxy(ses); assert.equal(result.ok, false); assert.match(result.message, /无法确认.*线路/);
  assert.deepEqual(ses.resolutions, [TARGET, IPIP]); assert.equal(ses.calls.length, 0);
});

test("同线路主源失败才顺序用备用，纯IP成功必须显示位置未知且停止", async () => {
  const ses = session({ [IPIP]: response("unavailable", 503), [BACKUP]: response("203.0.113.2\n"), [IPWHO]: ipwho() });
  const result = await testProxy(ses, { mode: "direct" });
  assert.equal(result.ok, true); assert.equal(result.ip, "203.0.113.2"); assert.equal(result.source, BACKUP);
  assert.equal(result.location, "位置未知");
  for (const key of ["countryCode", "country", "region", "city", "isp"]) assert.equal(result[key], "");
  assert.match(result.message, /位置未知/); assert.deepEqual(ses.calls.map((call) => call.url), [IPIP, BACKUP]);
  assert.notEqual(ses.calls[0].options.signal, ses.calls[1].options.signal);
});

test("源失败后不能借不匹配线路上的备用IP冒充成功", async () => {
  const ses = session({ [IPIP]: response("bad body"), [BACKUP]: response("192.0.2.3"), [IPWHO]: ipwho() }, (url) => [TARGET, IPIP].includes(url) ? "DIRECT" : "PROXY other.invalid:8080");
  const result = await testProxy(ses); assert.equal(result.ok, false); assert.equal(result.ip, "");
  assert.deepEqual(ses.calls.map((call) => call.url), [IPIP]); assert.match(result.message, /均失败/);
});

test("前两源失败才查第三源，坏JSON/错误IP/失败响应不能报成功", async () => {
  const ses = session({ [IPIP]: response("bad text"), [BACKUP]: response("bad IP"), [IPWHO]: ipwho("2001:0DB8:0:0:0:0:0:1") });
  const result = await testProxy(ses); assert.equal(result.ok, true); assert.equal(result.ip, "2001:db8::1");
  assert.deepEqual(ses.calls.map((call) => call.url), [IPIP, BACKUP, IPWHO]);
  for (const invalid of [response("<html>login</html>"), ipwho("999.1.1.1"), ipwho("192.0.2.1", { success: false }), response("{}")]) {
    const failed = await testProxy(session({ [IPIP]: response("bad"), [BACKUP]: response("bad"), [IPWHO]: invalid }));
    assert.equal(failed.ok, false); assert.equal(failed.ip, ""); assert.match(failed.message, /均失败/);
  }
});

test("目标仅允许HTTP(S)，非法协议在解析或请求前拒绝", async () => {
  for (const targetUrl of ["file:///C:/fixture", "javascript:void(0)", "ftp://fixture.invalid/", "not a URL"]) {
    const ses = session({}); const result = await testProxy(ses, { targetUrl });
    assert.equal(result.ok, false); assert.match(result.message, /目标网址无效/); assert.equal(ses.resolutions.length, 0); assert.equal(ses.calls.length, 0);
  }
});

test("路由解析超时受控，fetch尚未发生且不存在默认直连降级", async () => {
  const ses = session({}, () => new Promise(() => {}));
  const result = await testProxy(ses, { timeoutMs: 10 });
  assert.equal(result.ok, false); assert.match(result.message, /解析超时/); assert.equal(ses.calls.length, 0);
});

test("fetch及读响应体分别超时并abort，备用仍逐个解析而不并发", async () => {
  const never = () => new Promise(() => {});
  const ses = session({ [IPIP]: never, [BACKUP]: { ok: true, text: never }, [IPWHO]: ipwho() });
  const result = await testProxy(ses, { timeoutMs: 10 });
  assert.equal(result.ok, true); assert.equal(result.source, IPWHO);
  assert.equal(ses.calls[0].options.signal.aborted, true); assert.equal(ses.calls[1].options.signal.aborted, true); assert.equal(ses.calls[2].options.signal.aborted, false);
  assert.deepEqual(ses.calls.map((call) => call.url), [IPIP, BACKUP, IPWHO]);
});

test("所有resolve及fetch的定时器成功或失败后均清理", async () => {
  const timers = new Set(); let cleared = 0;
  const context = vm.createContext({
    module: { exports: {} }, require, URL, AbortController,
    setTimeout(fn) { const timer = { fn }; timers.add(timer); return timer; },
    clearTimeout(timer) { assert.equal(timers.delete(timer), true); cleared++; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/proxy-diagnostics.js"), "utf8"), context);
  const ses = session({ [IPIP]: response("bad body"), [BACKUP]: response("192.0.2.20") });
  const result = await context.module.exports.testProxy(ses, { mode: "system" });
  assert.equal(result.ok, true); assert.equal(cleared, ses.resolutions.length + ses.calls.length); assert.equal(timers.size, 0);
});

test("总deadline为30秒，超时后不得继续解析其它检测站或返回已过期IP", async () => {
  let now = 0;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ module: { exports: {} }, require, URL, AbortController, Date: Clock, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/proxy-diagnostics.js"), "utf8"), context);
  const ses = session({ [IPIP]: () => { now = 30001; return ipip(); } });
  const result = await context.module.exports.testProxy(ses, { timeoutMs: 60000 });
  assert.equal(result.ok, false); assert.equal(result.ip, ""); assert.match(result.message, /超时/);
  assert.deepEqual(ses.resolutions, [TARGET, IPIP]); assert.equal(ses.calls.length, 1);
});
