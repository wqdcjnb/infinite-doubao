"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { execFileSync } = require("node:child_process");
const page = require("../src/page");
const { buildProfile } = require("../src/fingerprint");
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const preloadSource = read("src/webview-preload.js");
const automationSource = read("src/page/automation.js");
const fpSource = read("src/fp-inject.js");

function preload(source = preloadSource, failInitial = false) {
  const profile = buildProfile("0123456789abcdef0123456789abcdef");
  const sent = [];
  const context = vm.createContext({ URL, location: { href: "https://fixture.invalid/" } });
  vm.runInContext(`
    var window = globalThis;
    var stats = { copies:0, copiedBytes:0, reads:0 };
    class Navigator {};
    class Screen {};
    class Element { getBoundingClientRect(){return {x:0,y:0,width:640,height:360};} }
    class CanvasRenderingContext2D {
      constructor(canvas) { this.canvas=canvas; }
      drawImage(source) { this.canvas.pixels=new Uint8ClampedArray(source.pixels);stats.copies++;stats.copiedBytes+=source.pixels.length; }
      getImageData(x,y,w,h) { stats.reads++;return {data:this.canvas.pixels.slice(0,w*h*4)}; }
      putImageData(image) { this.canvas.pixels.set(image.data); }
    }
    class HTMLCanvasElement extends Element {
      constructor() { super();this.width=1;this.height=1;this.pixels=new Uint8ClampedArray(4);this.context=new CanvasRenderingContext2D(this); }
      getContext() {return this.context;}
      toDataURL() {return this.pixels.slice(0,36).join(',');}
      toBlob(callback) {callback(this.toDataURL());}
    }
    var navigator=new Navigator();var screen=new Screen();
    var document={title:'Fixture',readyState:'complete',querySelectorAll(){return [];},createElement(tag){if(tag==='canvas') return new HTMLCanvasElement();throw Error(tag);}};
    var sourceCanvas=new HTMLCanvasElement();sourceCanvas.width=1920;sourceCanvas.height=1080;sourceCanvas.pixels=new Uint8ClampedArray(1920*1080*4).fill(96);
  `, context);
  const fpModule = vm.runInContext(`(function(){var module={exports:{}};${fpSource};return module.exports;})()`, context);
  context.require = (name) => {
    if (name === "./page") return page;
    if (name === "./fp-inject.js") return failInitial ? { installFingerprint() { throw new Error("initial installation failed"); } } : fpModule;
    if (name === "electron") return {
      ipcRenderer: { send: (...args) => sent.push(args), sendSync: () => ({ instanceId: "performance-fixture", profile, enhancer: { model: "seedance_v2.0_mini", duration: 5 } }) },
      webFrame: { executeJavaScript: async (script) => vm.runInContext(script, context) }
    };
    throw new Error(name);
  };
  vm.runInContext(source.split("const HOST =")[0], context);
  return { context, profile, sent, run: (code) => vm.runInContext(code, context) };
}

test("real preload installs Canvas fingerprint patch once while automation/model settings remain available", () => {
  const p = preload();
  const first = p.run("sourceCanvas.toDataURL()");
  assert.equal(p.run("stats.copies"), 1, "one export must make one noised copy, not stacked copies");
  assert.equal(p.run("stats.reads"), 1);
  assert.equal(p.run("sourceCanvas.toDataURL()"), first, "fingerprinted output remains deterministic");
  assert.equal(p.run("sourceCanvas.pixels.every(value=>value===96)"), true, "source canvas stays unchanged");
  assert.equal(p.run("navigator.userAgent"), p.profile.userAgent);
  assert.equal(p.run("screen.width"), p.profile.screen.width);
  const key = page.autoKeyFor("performance-fixture");
  assert.equal(p.run(`typeof window[${JSON.stringify(key)}].readProgress`), "function");
  assert.equal(p.run(`window[${JSON.stringify(key + "_enh")}].model`), "seedance_v2.0_mini");
  assert.equal(p.run(`window[${JSON.stringify(key + "_enh")}].duration`), 5);
});

test("a failed synchronous fingerprint installation retains the main-world fallback", () => {
  const p = preload(preloadSource, true);
  p.run("sourceCanvas.toDataURL()");
  assert.equal(p.run("stats.copies"), 1);
  assert.equal(p.run("navigator.userAgent"), p.profile.userAgent);
  assert.ok(p.sent.some(([event]) => event === "dm:fp-error"));
});

function progressFixture(source = automationSource, count = 4, fallback = false) {
  let nodes = [];
  const counts = { messages: 0, texts: 0 };
  const document = { body: { innerText: "历史内容" }, querySelectorAll(selector) {
    if (selector === "[data-message-id]") { counts.messages++;return fallback ? [] : nodes; }
    if (selector.includes('data-testid="message-container"')) return [];
    if (selector === "video") return nodes.flatMap((node) => node.querySelectorAll("video"));
    return [];
  } };
  const context = vm.createContext({ window: {}, document, CFG: { autoKey: "auto" }, URL, location: { href: "https://fixture.invalid/chat/1" } });
  vm.runInContext(source, context);
  function message(id, text, role = "assistant", urls = []) {
    const owner = { getAttribute: (key) => key === "data-message-role" ? role : null };
    return { id, text, get innerText() { counts.texts++;return this.text; }, getAttribute: (key) => key === "data-message-id" ? id : null, closest: () => owner,
      querySelectorAll: (selector) => selector === "video" ? urls.map((url) => ({ currentSrc: url, closest: () => null })) : [] };
  }
  nodes = Array.from({ length: count }, (_, i) => message("old-" + i, "历史消息 " + i));
  context.window.auto.beginTask({ taskId: "current", prompt: "生成测试视频" });
  counts.messages = 0;counts.texts = 0;
  return { api: context.window.auto, document, counts, message, add(node) { nodes.push(node); }, replace(value) { nodes = value; } };
}

test("each progress poll queries the message list once and reads current response text once", () => {
  const p = progressFixture();
  p.add(p.message("current", "生成中 42%"));
  assert.equal(p.api.readProgress().percent, 42);
  assert.equal(p.counts.messages, 1);
  assert.equal(p.counts.texts, 2, "one prompt exclusion and one progress text read");
});

test("progress polling never caches across calls: updated text, new media and missing anchors are observed", () => {
  const p = progressFixture();
  const current = p.message("current", "生成中 42%");p.add(current);
  assert.equal(p.api.readProgress().state, "running");
  current.text = "生成失败，请稍后重试";
  assert.equal(p.api.readProgress().state, "failed");
  current.text = "已为你准备视频";
  p.add(p.message("video", "", "assistant", ["https://fixture.invalid/new.mp4"]));
  assert.deepEqual(Array.from(p.api.readProgress().mediaUrls), ["https://fixture.invalid/new.mp4"]);
  p.replace([p.message("unanchored", "生成完成", "assistant", ["https://fixture.invalid/old.mp4"])]);
  assert.deepEqual(Array.from(p.api.readProgress().mediaUrls), []);
});

test("text confirmations remain current-assistant only and the fallback still compares body text", () => {
  const p = progressFixture();
  const text = "视频生成参数确认，模型：Seedance 2.0 Mini 时长：5秒，确认后开始生成视频。";
  p.add(p.message("user", text, "user"));
  assert.equal(p.api.readProgress().state, "unknown");
  p.add(p.message("assistant", text));
  p.counts.messages = 0;
  assert.equal(p.api.readProgress().state, "waiting_confirmation");
  assert.equal(p.counts.messages, 1);
  const fallback = progressFixture(automationSource, 0, true);
  fallback.document.body.innerText = "历史内容 正在生成 31%";
  assert.equal(fallback.api.readProgress().percent, 31);
});

if (process.argv.includes("--benchmark")) {
  const baselineRef = process.env.DM_PERF_BASELINE || "v1.3.2";
  const baseline = (file) => execFileSync("git", ["show", baselineRef + ":" + file], { cwd: root, encoding: "utf8" });
  const measure = (make, run, rounds) => {
    const times = [];
    for (let round = 0; round < 5; round++) {
      const fixture = make();
      for (let i = 0; i < 5; i++) run(fixture);
      const start = performance.now();
      for (let i = 0; i < rounds; i++) run(fixture);
      times.push(performance.now() - start);
    }
    return Number(times.sort((a, b) => a - b)[2].toFixed(2));
  };
  const oldPreload = baseline("src/webview-preload.js");
  const oldAutomation = baseline("src/page/automation.js");
  const report = { environment: "Node VM, actual injection sources, synthetic Canvas/DOM; not a browser FPS measurement", canvas: {}, progress: {} };
  for (const [label, source] of [["before", oldPreload], ["after", preloadSource]]) {
    const p = preload(source);p.run("sourceCanvas.toDataURL()");
    report.canvas[label] = { copiesPerExport: p.run("stats.copies"), bytesCopiedPerExport: p.run("stats.copiedBytes"), medianMsFor40Exports: measure(() => preload(source), (f) => f.run("sourceCanvas.toDataURL()"), 40) };
  }
  for (const [label, source] of [["before", oldAutomation], ["after", automationSource]]) {
    const make = () => { const p = progressFixture(source, 400);p.add(p.message("current", "生成中 42%"));return p; };
    const p = make();p.api.readProgress();
    report.progress[label] = { historyMessages: 400, messageQueriesPerPoll: p.counts.messages, responseTextReadsPerPoll: p.counts.texts, medianMsFor200Polls: measure(make, (f) => f.api.readProgress(), 200) };
  }
  console.log("PAGE_PERFORMANCE " + JSON.stringify(report));
}
