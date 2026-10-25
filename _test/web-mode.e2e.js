"use strict";

// Run against an explicitly isolated app: --user-data-dir=<DM_WEB_TEST_HOME> --web-server --web-port=17925.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const home = path.resolve(process.env.DM_WEB_TEST_HOME || path.join(__dirname, "../build/web-test-userdata"));
const base = process.env.DM_WEB_TEST_URL || "http://127.0.0.1:17925";
let cookie = "", account, fixture;
const pageState = { text: "", clicks: 0, files: [] };
async function req(route, data, method) {
  const response = await fetch(base + route, { method: method || (data === undefined ? "GET" : "POST"),
    headers: { cookie, ...(data === undefined ? {} : { "content-type": "application/json" }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  const result = await response.json(); assert.ok(response.ok, result.error); return result;
}
async function rpc(channel, ...args) { return (await req("/web/rpc", { channel, args })).result; }
async function call(channel, ...args) { const result = await rpc(channel, ...args); assert.equal(result.ok, true, result.error); return result.data; }
async function wait(fn) { for (let n = 0; n < 100; n++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("Timed out"); }
(async () => {
  const login = await fetch(base + "/web/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: fs.readFileSync(path.join(home, "web-access.txt"), "utf8").trim() }) });
  assert.ok(login.ok); cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(path.resolve((await rpc("app:paths")).home), home, "Refuse to run against real user data");
  fixture = http.createServer(async (request, response) => {
    if (request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      Object.assign(pageState, JSON.parse(Buffer.concat(chunks))); response.end("ok"); return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>网页版账号验收</title></head><body style="margin:20px;font:20px sans-serif"><h1>独立账号网页验收</h1><input id="text" style="position:absolute;left:20px;top:100px;width:500px;height:50px;font:20px sans-serif" placeholder="输入中文测试"><button id="button" style="position:absolute;left:20px;top:180px;width:200px;height:50px">点击验收</button><input id="file" type="file" multiple style="position:absolute;left:20px;top:260px"><p id="result" style="position:absolute;top:320px"></p><script>let clicks=0;const text=document.querySelector('#text'),button=document.querySelector('#button'),file=document.querySelector('#file');function report(){const data={text:text.value,clicks,files:Array.from(file.files).map(f=>f.name)};document.querySelector('#result').textContent=JSON.stringify(data);fetch('/state',{method:'POST',body:JSON.stringify(data)})}text.oninput=report;button.onclick=()=>{clicks++;report()};file.onchange=report;</script></body></html>`);
  });
  await new Promise((resolve) => fixture.listen(17926, "127.0.0.1", resolve));
  account = await rpc("account:create", { name: "网页版独立账号验收", url: "http://127.0.0.1:17926/" });
  const prefix = `/web/account/${account.id}`;
  await req(prefix + "/open", {});
  await new Promise((r) => setTimeout(r, 1800));
  const frame = await fetch(base + prefix + "/frame", { headers: { cookie } });
  assert.ok(frame.ok); assert.equal(frame.headers.get("content-type"), "image/jpeg");
  const jpeg = Buffer.from(await frame.arrayBuffer()); assert.ok(jpeg.length > 1000); fs.writeFileSync(path.join(home, "account-test.jpg"), jpeg);
  async function click(x, y) {
    await req(prefix + "/input", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await req(prefix + "/input", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }
  await click(100, 125); await req(prefix + "/text", { text: "中文与 English 123" }); await wait(() => pageState.text === "中文与 English 123");
  await click(100, 205); await wait(() => pageState.clicks === 1);
  console.log("PASS: 独立账号网页画面、鼠标点击和中文输入");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG/0AAAAASUVORK5CYII=", "base64");
  const uploaded = await fetch(base + "/web/upload?name=" + encodeURIComponent("网页参考图片.png"), { method: "POST", headers: { cookie }, body: png });
  const media = await uploaded.json(); assert.ok(uploaded.ok, media.error);
  await click(70, 270); await new Promise((r) => setTimeout(r, 250));
  await req(prefix + "/files", { files: [media.path] }); await wait(() => pageState.files.length === 1);
  const template = await call("dm:template:create", { name: "网页接口验收模板", prompt: "中文测试提示词", duration: 10, model: "seedance_v2.0", ratio: "16:9" });
  await call("dm:template:attach", template.id, [media.path]);
  let templates = await call("dm:templates"); const stored = templates.items.find((x) => x.id === template.id);
  assert.equal(stored.attachments.length, 1); assert.deepEqual(fs.readFileSync(stored.attachments[0].path), png);
  const drafts = await call("dm:drafts:collect", [template.id]); assert.equal(drafts.length, 1);
  await call("dm:template:update", template.id, { prompt: "模板修改后" });
  const draftList = await call("dm:drafts"); assert.ok(JSON.stringify(draftList).includes("中文测试提示词"));
  assert.equal((await fetch(base + "/web/media?path=" + encodeURIComponent(media.path), { headers: { cookie } })).status, 200);
  console.log("PASS: 浏览器上传、账号网页文件选择、模板附件持久化、草稿快照和图片预览");
  for (const channel of ["dm:state", "dm:tasks", "dm:videos", "dm:assets", "dm:resources", "dm:quota", "dm:logs", "dm:mcp:tools", "dm:update:status", "dm:components:status"]) await call(channel);
  console.log("PASS: 全部导航页业务接口、组件和更新状态");
  console.log("PASS: 测试仅使用隔离数据，没有向真实账号提交生成任务");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (account) await rpc("account:remove", account.id).catch(() => {});
  fixture?.close();
});
