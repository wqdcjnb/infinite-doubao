"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { WebServer } = require("../src/web-server");

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-web-test-"));
  const server = new WebServer({ home, renderer: path.join(__dirname, "../renderer"), port: 0,
    invoke: async (channel, args, event) => {
      if (channel === "fixture:echo") return args;
      if (channel === "fixture:event") { event.sender.send("mask:progress", { progress: 50 }); return true; }
      if (channel === "fixture:media") return { path: path.join(home, "clip.mp4") };
      throw new Error("不允许的网页通道");
    }, accounts: { handle: (_req, res, _url, api) => api.json(res, 200, { ok: true }) } });
  await server.start();
  t.after(async () => { await server.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  let cookie = "";
  const request = (url, data, headers = {}) => fetch(server.url() + url.replace(/^\//, ""), {
    method: data === undefined ? "GET" : "POST", headers: { ...(cookie ? { cookie } : {}), ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  async function login() {
    const ticket = new URL(server.openUrl()).hash.slice("#ticket=".length);
    const response = await request("web/login", { ticket }); assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0]; return ticket;
  }
  return { home, server, request, login, cookie: () => cookie };
}
test("网页入口可打开，业务接口和账号画面必须登录；一次性链接不能重放", async (t) => {
  const f = await fixture(t);
  assert.match(await (await f.request("/")).text(), /web-bridge.js/);
  assert.equal((await f.request("web/rpc", { channel: "fixture:echo", args: [] })).status, 401);
  assert.equal((await f.request("web/account/test/frame")).status, 401);
  const ticket = await f.login();
  assert.equal((await f.request("web/login", { ticket })).status, 401);
  assert.equal((await f.request("web/session")).status, 200);
  assert.deepEqual(await (await f.request("web/rpc", { channel: "fixture:echo", args: ["中文", 42] })).json(), { result: ["中文", 42] });
  assert.equal((await f.request("web/rpc", { channel: "unknown", args: [] })).status, 500);
});
test("阻断跨站请求和 DNS rebinding，退出后会话失效", async (t) => {
  const f = await fixture(t); await f.login();
  assert.equal((await f.request("web/rpc", { channel: "fixture:echo", args: [] }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.request("web/session", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  const code = await new Promise((resolve, reject) => {
    http.get(f.server.url(), { headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.equal(code, 403);
  assert.equal((await f.request("web/logout", {})).status, 200);
  assert.equal((await f.request("web/session")).status, 401);
});
test("上传素材落在私有数据目录，授权后支持视频 Range 和下载，禁止任意文件读取", async (t) => {
  const f = await fixture(t); await f.login();
  fs.writeFileSync(path.join(f.home, "clip.mp4"), "0123456789");
  fs.writeFileSync(path.join(f.home, "secret.png"), "not granted");
  const hidden = await f.request("web/media?path=" + encodeURIComponent(path.join(f.home, "secret.png")));
  assert.equal(hidden.status, 403);
  await f.request("web/rpc", { channel: "fixture:media", args: [] });
  const media = "web/media?path=" + encodeURIComponent(path.join(f.home, "clip.mp4"));
  let response = await f.request(media, undefined, { range: "bytes=2-5" });
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 2-5/10"); assert.equal(await response.text(), "2345");
  response = await f.request(media, undefined, { range: "bytes=-3" }); assert.equal(await response.text(), "789");
  assert.equal((await f.request(media, undefined, { range: "bytes=50-60" })).status, 416);
  response = await fetch(f.server.url() + "web/upload?name=../../test.png", { method: "POST", headers: { cookie: f.cookie() }, body: "image-bytes" });
  assert.equal(response.status, 200);
  const uploaded = await response.json();
  assert.equal(path.dirname(path.dirname(uploaded.path)), path.join(f.home, "assets", "web-uploads"));
  assert.equal(path.basename(uploaded.path), "test.png");
  assert.equal(fs.readFileSync(uploaded.path, "utf8"), "image-bytes");
  response = await f.request("web/media?path=" + encodeURIComponent(uploaded.path) + "&download=1");
  assert.match(response.headers.get("content-disposition"), /attachment/); assert.equal(await response.text(), "image-bytes");
  response = await fetch(f.server.url() + "web/upload?name=malicious.html", { method: "POST", headers: { cookie: f.cookie() }, body: "<script>" });
  assert.equal(response.status, 415);
  assert.equal(f.server.grantFile(path.join(f.home, "web-access.txt")), null);
});
test("实时事件传递进度，断开连接清理订阅，访问码失败有限流", async (t) => {
  const f = await fixture(t); await f.login();
  const controller = new AbortController();
  const response = await fetch(f.server.url() + "web/events", { headers: { cookie: f.cookie() }, signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  await f.request("web/rpc", { channel: "fixture:event", args: [] });
  const chunk = await reader.read(); assert.match(Buffer.from(chunk.value).toString(), /mask:progress/);
  controller.abort(); await reader.cancel().catch(() => {});
  for (let i = 0; i < 21; i++) await f.request("web/login", { token: "wrong" });
  assert.equal((await f.request("web/login", { token: "wrong" })).status, 429);
});
