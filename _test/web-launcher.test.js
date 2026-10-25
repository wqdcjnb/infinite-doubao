"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { openBrowser } = require("../src/web-launcher");
const url = "http://127.0.0.1:17825/#ticket=test-only-ticket";
test("Windows 网页入口直接启动已注册浏览器，不经过失效的系统链接关联", async () => {
  const calls = [];
  await openBrowser(url, { platform: "win32", app: { getApplicationInfoForProtocol: async () => ({ path: "C:\\Chrome\\chrome.exe" }) }, shell: { openExternal: () => assert.fail("Should use registered browser") },
    exists: () => true, launch: (exe, args) => { calls.push({ exe, args }); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit("spawn")); return child; } });
  assert.deepEqual(calls, [{ exe: "C:\\Chrome\\chrome.exe", args: [url] }]);
});
test("其他系统使用默认浏览器，无法解析 Windows 关联时使用已安装浏览器", async () => {
  let opened = "";
  await openBrowser(url, { platform: "darwin", app: {}, shell: { openExternal: async (value) => { opened = value; } } });
  assert.equal(opened, url);
  let fallback = "";
  await openBrowser(url, { platform: "win32", env: {}, app: { getApplicationInfoForProtocol: async () => { throw new Error("missing association"); } }, shell: {}, exists: () => true,
    launch: (exe) => { fallback = exe; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit("spawn")); return child; } });
  assert.match(fallback, /chrome\.exe$/);
});
test("网页版启动器拒绝外部地址或命令参数，浏览器启动失败会明确报错", async () => {
  await assert.rejects(openBrowser("https://example.com/", { app: {}, shell: {} }), /无效/);
  await assert.rejects(openBrowser(url, { platform: "win32", app: { getApplicationInfoForProtocol: async () => ({path:"C:\\Chrome\\chrome.exe"}) }, shell: {}, exists: () => true,
    launch: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("launch denied"))); return child; } }), /launch denied/);
});
