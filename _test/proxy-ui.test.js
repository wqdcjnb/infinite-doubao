"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const side = (ip, countryCode, country, city) => ({ ok: true, ip, countryCode, country, city, source: "fixture detector", latency: 12 });
const report = () => ({ ok: true, checkedAt: "2026-10-26T01:00:00Z", mode: "direct", domestic: side("192.0.2.1", "CN", "中国", "上海"), international: side("192.0.2.1", "CN", "中国", "上海"), differentExits: false });

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
    renderList = () => {};
    toast = (message, error) => notices.push({message,error});
    state.accounts = [{id:'a',name:'A',proxy:{mode:'direct',url:''}}, {id:'b',name:'B',proxy:{mode:'direct',url:''}}];
    state.activeId='a'; state.panel='proxy';
    globalThis.ui={state,proxyLocation,proxySummary,hasProxyIp,proxyConfigKey,cachedProxyResult,renderStatus,renderPanel,renderProxyResult};
  `.replace("notices.push", "globalThis.notices.push"), context);
  context.notices = toasts;
  const ui = context.ui;
  function walk(node, predicate) { return [node, ...node.children.flatMap((child) => walk(child, () => true))].filter(predicate); }
  function body() { return get("#drawerBody"); }
  function button(label) { return walk(body(), (node) => node.tagName === "button" && node.textContent === label)[0]; }
  function controls(tag) { return walk(body(), (node) => node.tagName === tag); }
  function seed(value = report(), id = "a") { const account = ui.state.accounts.find((item) => item.id === id); ui.state.proxyCache[id] = { key: ui.proxyConfigKey(account.proxy), result: value }; }
  ui.renderPanel();
  return { ui, API, calls, toasts, body, button, controls, seed, get };
}

test("归属按CN判断；国内检测站返回国外或未知IP时不冒称国内", () => {
  const f = fixture();
  assert.equal(f.ui.proxyLocation(side("192.0.2.1", "CN", "中国", "上海")), "国内");
  assert.equal(f.ui.proxyLocation(side("192.0.2.2", "JP", "日本", "东京")), "日本 东京");
  assert.equal(f.ui.proxyLocation({ source: "国内检测站", ip: "192.0.2.3", ok: true }), "位置未知");
  assert.equal(f.ui.hasProxyIp({ ok: true, ip: " " }), false);
  assert.deepEqual(Array.from(f.ui.proxySummary({ domestic: { ok: true }, international: side("192.0.2.2", "JP", "日本", "东京") })), ["国外检测站：日本 东京 · 192.0.2.2"]);
});

test("两站出口不同分别展示位置/IP/来源和时间，不宣称豆包或本机实际出口", () => {
  const f = fixture(); const result = report();
  result.international = side("192.0.2.2", "US", "美国", "洛杉矶"); result.differentExits = true;
  f.seed(result); f.ui.renderPanel(); f.ui.renderStatus();
  const text = f.body().textContent;
  for (const expected of ["国内检测站", "国外检测站", "国内 · 192.0.2.1", "美国 洛杉矶 · 192.0.2.2", "来源：fixture detector", "检测时间：", "出口不同，可能存在分流；不代表豆包实际出口"]) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes("上海"));
  assert.match(f.get("#sbIp").textContent, /国内检测站.*国外检测站/);
  assert.match(f.get("#sbIp").title, /不代表豆包实际出口/);
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
  const bReport = report(); bReport.domestic.ip = bReport.international.ip = "192.0.2.20";
  pending.get("b")(bReport); await b;
  const text = f.body().textContent;
  pending.get("a")(report()); await a;
  assert.equal(f.ui.state.proxyCache.a, undefined);
  assert.equal(f.body().textContent, text);
  assert.equal(f.ui.cachedProxyResult(f.ui.state.accounts[1]).domestic.ip, "192.0.2.20");
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
  const empty = fixture({ testProxy: async () => ({ ok: true, domestic: { ok: true, ip: "" }, international: { ok: true, ip: "" } }) });
  await empty.button("测 IP").dispatch("click"); empty.ui.renderStatus();
  assert.equal(empty.get("#sbIp").textContent, "IP 检测失败");
  assert.match(empty.body().textContent, /未获取有效 IP/);
});

test("双侧缺失时保留应用失败原因，正常结果也说明检测站的范围", async () => {
  const f = fixture({ testProxy: async () => ({ ok: false, message: "代理设置应用失败，请检查地址" }) });
  await f.button("测 IP").dispatch("click");
  assert.match(f.body().textContent, /代理设置应用失败，请检查地址/);
  assert.match(f.body().textContent, /检测结果仅代表到各检测站的出口，不代表豆包实际出口/);
  f.seed(); f.ui.renderPanel();
  assert.match(f.body().textContent, /不代表豆包实际出口/);
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
