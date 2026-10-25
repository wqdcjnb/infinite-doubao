"use strict";

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const P = require("../src/paths");
const store = require("../src/store");
const media = require("../src/interceptor");
const library = require("../src/video-library");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-resources-pipeline-"));
let seq = 0;
beforeEach(() => {
  P.init({ home: path.join(root, String(++seq)) });
  store.load();
  store.get().settings.downloadDir = path.join(P.home(), "videos");
  media.list();
});
after(() => {
  media.saveResources();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function entry(url = "https://example.invalid/output.mp4?lr=watermark", instanceId = "one") {
  return media.push({ url, kind: "video", instanceId, instanceName: instanceId });
}
function response() {
  const bytes = Buffer.alloc(32);
  bytes.write("ftyp", 4);
  return { ok: true, headers: new Map([["content-type", "video/mp4"]]), arrayBuffer: async () => bytes };
}

test("自动下载只接受无水印源，失败不回退为带水印文件", async () => {
  const item = entry();
  const requests = [];
  const session = { fetch: async (url) => { requests.push(url); return url.includes("unwatermarked") ? { ok: false, status: 403 } : response(); } };
  await assert.rejects(media.download(session, item, { requireUnwatermarked: true, taskId: "task-one" }), /403/);
  assert.equal(requests.length, 1);
  assert.equal(item.status, "download_failed");
  assert.equal(item.downloaded, "");
  assert.deepEqual(fs.readdirSync(store.get().settings.downloadDir), []);
  assert.equal(media.list({ taskId: "task-one" })[0].id, item.id);
});

test("手动原片失败后的回退保存真实水印状态，重启仍不误标", async () => {
  const item = entry();
  const session = { fetch: async (url) => url.includes("unwatermarked") ? { ok: false, status: 403 } : response() };
  const result = await media.download(session, item);
  assert.equal(result.fallback, true);
  assert.equal(result.unwatermarked, false);
  assert.equal(item.watermark, "kept");
  assert.equal(item.unwatermarked, false);
  const saved = JSON.parse(fs.readFileSync(path.join(P.dir("assets"), "resources.json"), "utf8"));
  assert.equal(saved.items[0].watermark, "kept");
  assert.equal(saved.items[0].unwatermarked, false);
});

test("下载和任务归属持久化，换目录后素材库仍显示原片", async () => {
  const item = entry();
  const result = await media.download({ fetch: async () => response() }, item, { requireUnwatermarked: true, taskId: "task-one", templateName: "产品片" });
  store.get().settings.downloadDir = path.join(P.home(), "new-videos");
  store.save();
  const code = `const P=require('./src/paths');P.init({home:process.argv[1]});require('./src/store').load();require('./src/video-library').list().then(x=>console.log(JSON.stringify(x)));`;
  const child = spawnSync(process.execPath, ["-e", code, P.home()], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const videos = JSON.parse(child.stdout).items;
  assert.equal(videos.length, 1);
  assert.equal(videos[0].path, result.file);
  assert.equal(videos[0].watermark, "none");
  assert.equal(videos[0].taskId, "task-one");
  assert.equal(videos[0].templateName, "产品片");
});

test("同账号同视频两版归一，不同账号和不同查询ID不混淆", () => {
  const a = entry("https://example.invalid/video?id=100&lr=watermark");
  const clean = entry("https://example.invalid/video?id=100&lr=unwatermarked");
  const otherId = entry("https://example.invalid/video?id=200&lr=unwatermarked");
  const otherAccount = entry(a.url, "two");
  assert.equal(a.id, clean.id);
  assert.notEqual(a.id, otherId.id);
  assert.notEqual(a.id, otherAccount.id);
  assert.equal(media.list({ instanceId: "two" }).length, 1);
});

test("同一任务下载重试复用原片，不重复文件或请求", async () => {
  const item = entry();
  let requests = 0;
  const session = { fetch: async () => { requests++; return response(); } };
  const first = await media.download(session, item, { requireUnwatermarked: true, taskId: "task-one" });
  const second = await media.download(session, item, { requireUnwatermarked: true, taskId: "task-one" });
  assert.equal(second.file, first.file);
  assert.equal(second.reused, true);
  assert.equal(requests, 1);
});

test("未知水印源不能冒充原片，HTML响应不能进入素材库", async () => {
  const unknown = entry("https://example.invalid/plain.mp4");
  await assert.rejects(media.download({ fetch: async () => response() }, unknown, { requireUnwatermarked: true }), /无法|尚未取得/);
  const item = entry();
  await assert.rejects(media.download({ fetch: async () => ({ ok: true, headers: new Map([["content-type", "text/html"]]) }) }, item, { requireUnwatermarked: true }), /网页/);
  assert.equal((await library.list()).items.length, 0);
});
