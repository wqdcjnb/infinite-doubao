"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const address = (ip, countryCode, country, city) => ({ ok: true, ip, countryCode, country, city, source: "fixture detector", latency: 12 });
const report = () => ({ ...address("192.0.2.1", "CN", "中国", "上海"), checkedAt: "2026-10-26T01:00:00Z", mode: "direct" });

function fixture(overrides = {}) {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.style = {}; this.value = ""; this._text = ""; this.disabled = false; this.classList = { add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return this.root || !!this.parent?.isConnected; }
    set textContent(value) { this._text = String(value); for (const child of this.children) child.parent = null; this.children = []; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
    appendChild(child) { child.parent = this; this.children.push(child); if (this.tagName === "select" && (child.selected || this.children.length === 1)) this.value = child.value; return child; }
    replaceChildren(...children) { this.textContent = ""; children.forEach((child) => this.appendChild(child)); }
    addEventListener(event, fn) { (this.listeners[event] ||= []).push(fn); }
    async dispatch(event) { for (const fn of this.listeners[event] || []) await fn({ target: this }); }
  }
  const nodes = new Map();
  const get = (selector) => { if (!nodes.has(selector)) { const node = new Element("div"); node.root = true; nodes.set(selector, node); } return nodes.get(selector); };
  const calls = []; const toasts = [];
  const API = {
    updateAccount: async (id, patch) => { calls.push(["save", id, patch]); return { id, proxy: patch.proxy }; },
    testProxy: async (id) => { calls.push(["test", id]); return report(); },
    parseProxyList: async () => [{ protocol: "http", host: "127.0.0.1", port: 8080 }],
    ...overrides
  };
  const context = vm.createContext({ window: { DM: API }, document: { createElement: (tag) => new Element(tag), querySelector: get }, console, URL, setTimeout });
  vm.runInContext(source.slice(0, source.indexOf("\nboot().catch")) + `
    const renderSidebar = renderList;
    renderList = () => {};
    toast = (message, error) => notices.push({message,error});
    state.accounts = [{id:'a',name:'A',proxy:{mode:'direct',url:''}}, {id:'b',name:'B',proxy:{mode:'direct',url:''}}];
    state.activeId='a'; state.panel='proxy';
    globalThis.ui={state,proxyLocation,proxySummary,hasProxyIp,proxyConfigKey,cachedProxyResult,renderStatus,renderPanel,renderProxyResult,renderSidebar,navigate};
  `.replace("notices.push", "globalThis.notices.push"), context);
  context.notices = toasts;
  const ui = context.ui;
  function walk(node, predicate) { return [node, ...node.children.flatMap((child) => walk(child, () => true))].filter(predicate); }
  function body() { return get("#drawerBody"); }
  function button(label) { return walk(body(), (node) => node.tagName === "button" && node.textContent === label)[0]; }
  function controls(tag) { return walk(body(), (node) => node.tagName === tag); }
  function seed(value = report(), id = "a") { const account = ui.state.accounts.find((item) => item.id === id); ui.state.proxyCache[id] = { key: ui.proxyConfigKey(account.proxy, account.url), result: value }; }
  ui.renderPanel();
  return { ui, API, calls, toasts, body, button, controls, seed, get };
}

test("归属按CN判断，不从检测来源或直连模式猜测位置", () => {
  const f = fixture();
  assert.equal(f.ui.proxyLocation(address("192.0.2.1", "CN", "中国", "上海")), "国内");
  assert.equal(f.ui.proxyLocation(address("192.0.2.2", "JP", "日本", "东京")), "日本 东京");
  assert.equal(f.ui.proxyLocation({ source: "国内检测站", ip: "192.0.2.3", ok: true }), "位置未知");
  assert.equal(f.ui.hasProxyIp({ ok: true, ip: " " }), false);
  assert.equal(f.ui.proxySummary({ ...address("192.0.2.2", "JP", "日本", "东京"), mode: "direct" }), "日本 东京 · 192.0.2.2");
});

test("只显示一个检测到的IP，来源和时间置于默认折叠的检测详情", () => {
  const f = fixture(); const result = report();
  f.seed(result); f.ui.renderPanel(); f.ui.renderStatus();
  const text = f.body().textContent;
  for (const expected of ["检测到的 IP", "国内 · 192.0.2.1", "检测详情", "来源：fixture detector", "检测时间：", "按账号代理规则检测；路由器或透明分流可能使具体网站出口不同"]) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes("上海"));
  assert.equal(f.controls("div").filter((node) => node.className === "proxy-probe-address").length, 1);
  assert.equal(f.controls("details").length, 1);
  assert.notEqual(f.controls("details")[0].open, true);
  assert.equal(f.get("#sbIp").textContent, "IP 国内 · 192.0.2.1");
  f.ui.renderSidebar();
  assert.equal((f.get("#accountList").textContent.match(/192\.0\.2\.1/g) || []).length, 1);
  assert.doesNotMatch(text, /国内检测站|国外检测站|两处检测站/);
  assert.ok(!text.includes("本机 IP"));
});

test("检测不能重复进入，配置变更会使旧检测回包失效", async () => {
  let resolve; let tests = 0;
  const f = fixture({ testProxy: () => { tests++; return new Promise((done) => { resolve = done; }); } });
  f.seed(); const button = f.button("测 IP");
  const pending = button.dispatch("click"); await tick();
  assert.equal(f.ui.state.proxyCache.a, undefined);
  assert.equal(button.disabled, true);
  await button.dispatch("click"); assert.equal(tests, 1);
  const input = f.controls("input")[0]; input.value = "http://127.0.0.1:8080"; await input.dispatch("input");
  resolve(report()); await pending;
  assert.equal(f.ui.state.proxyCache.a, undefined);
  assert.equal(button.disabled, false);
});

test("切换账号后旧回包不覆盖新账号的检测结果或面板", async () => {
  const pending = new Map();
  const f = fixture({ testProxy: (id) => new Promise((resolve) => pending.set(id, resolve)) });
  const a = f.button("测 IP").dispatch("click"); await tick();
  f.ui.state.activeId = "b"; f.ui.renderPanel();
  const b = f.button("测 IP").dispatch("click"); await tick();
  const bReport = report(); bReport.ip = "192.0.2.20";
  pending.get("b")(bReport); await b;
  const text = f.body().textContent;
  pending.get("a")(report()); await a;
  assert.equal(f.ui.state.proxyCache.a, undefined);
  assert.equal(f.body().textContent, text);
  assert.equal(f.ui.cachedProxyResult(f.ui.state.accounts[1]).ip, "192.0.2.20");
});

test("检测期间重开抽屉保持忙碌，完成后更新新面板并恢复按钮", async () => {
  let resolve;
  const f = fixture({ testProxy: () => new Promise((done) => { resolve = done; }) });
  const pending = f.button("测 IP").dispatch("click"); await tick();
  f.ui.renderPanel();
  assert.equal(f.button("检测中…").disabled, true);
  resolve(report()); await pending;
  assert.equal(f.button("测 IP").disabled, false);
  assert.match(f.body().textContent, /国内 · 192\.0\.2\.1/);
});

test("保存/检测失败finally恢复按钮，空成功不显示可用IP", async () => {
  const f = fixture({ updateAccount: async () => { throw new Error("fixture failure"); } });
  f.seed(); await f.button("保存").dispatch("click");
  assert.equal(f.button("保存").disabled, false); assert.equal(f.button("测 IP").disabled, false);
  assert.equal(f.ui.state.proxyCache.a, undefined);
  assert.match(f.toasts[0].message, /保存失败/);
  const empty = fixture({ testProxy: async () => ({ ok: true, ip: "" }) });
  await empty.button("测 IP").dispatch("click"); empty.ui.renderStatus();
  assert.equal(empty.get("#sbIp").textContent, "IP 检测失败");
  assert.match(empty.body().textContent, /未获取有效 IP/);
});

test("缺失IP时保留应用失败原因，详情说明账号规则检测的范围", async () => {
  const f = fixture({ testProxy: async () => ({ ok: false, message: "代理设置应用失败，请检查地址" }) });
  await f.button("测 IP").dispatch("click");
  assert.match(f.body().textContent, /代理设置应用失败，请检查地址/);
  assert.match(f.body().textContent, /按账号代理规则检测；路由器或透明分流可能使具体网站出口不同/);
  assert.equal(f.controls("div").filter((node) => node.className === "proxy-probe-address").length, 0);
  f.seed(); f.ui.renderPanel();
  assert.match(f.body().textContent, /按账号代理规则检测/);
});

test("模式、URL编辑和套用代理都清旧缓存，已保存只提示即时保存结果", async () => {
  const f = fixture(); f.seed();
  const mode = f.controls("select")[0]; mode.value = "system"; await mode.dispatch("change");
  assert.equal(f.ui.state.proxyCache.a, undefined);
  f.seed(); const input = f.controls("input")[0]; input.value = "http://127.0.0.1:8080"; await input.dispatch("input");
  assert.equal(f.ui.state.proxyCache.a, undefined);
  f.seed(); await f.button("给当前环境用第一条").dispatch("click");
  assert.equal(f.ui.state.proxyCache.a, undefined);
  assert.equal(f.ui.state.accounts[0].proxy.mode, "custom");
  await f.button("保存").dispatch("click");
  assert.equal(f.toasts.at(-1).message, "代理已保存");
});

test("账号目标URL改变后旧缓存失效，地址栏导航立即清除旧IP", () => {
  const f = fixture(); const account = f.ui.state.accounts[0];
  account.url = "https://www.doubao.com/chat/old"; f.seed();
  account.url = "https://www.doubao.com/chat/new";
  assert.equal(f.ui.cachedProxyResult(account), null);
  f.ui.renderStatus(); assert.equal(f.get("#sbIp").textContent, "IP 未检测");
  f.seed();
  f.ui.state.tabs = [{ id: "a", view: { loadURL: async () => {} } }];
  f.ui.navigate("https://www.doubao.com/chat/next");
  assert.equal(f.ui.state.proxyCache.a, undefined);
  assert.doesNotMatch(f.body().textContent, /192\.0\.2\.1/);
});

test("检测中改变目标URL时，旧目标的返回结果不会成为新目标缓存", async () => {
  let resolve;
  const f = fixture({ testProxy: () => new Promise((done) => { resolve = done; }) });
  const pending = f.button("测 IP").dispatch("click"); await tick();
  f.ui.state.accounts[0].url = "https://www.dola.com/";
  resolve(report()); await pending;
  assert.equal(f.ui.state.proxyCache.a, undefined);
  assert.equal(f.button("测 IP").disabled, false);
});
