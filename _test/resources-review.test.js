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
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-resources-review-"));
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
function resource(name) { return media.push({ url: `https://example.invalid/${name}.mp4?lr=unwatermarked`, kind: "video", instanceId: "one" }); }
function response(fill) {
  const bytes = Buffer.alloc(32, fill);
  bytes.write("ftyp", 4);
  return { ok: true, headers: new Map([["content-type", "video/mp4"]]), arrayBuffer: async () => bytes };
}

test("并发同名下载不能覆盖另一任务已生成的文件", async () => {
  const releases = [];
  const session = { fetch: () => new Promise((resolve) => releases.push(resolve)) };
  const first = media.download(session, resource("one"), { taskId: "one", fileName: "同名.mp4" });
  const second = media.download(session, resource("two"), { taskId: "two", fileName: "同名.mp4" });
  releases[0](response(1));
  const a = await first;
  releases[1](response(2));
  const b = await second;
  assert.notEqual(a.file, b.file);
  assert.equal(fs.readFileSync(a.file)[20], 1);
  assert.equal(fs.readFileSync(b.file)[20], 2);
});

test("并发同名下载失败不能删除另一任务已保存的文件", async () => {
  const releases = [];
  const session = { fetch: () => new Promise((resolve) => releases.push(resolve)) };
  const first = media.download(session, resource("one"), { taskId: "one", fileName: "同名.mp4" });
  const second = media.download(session, resource("two"), { taskId: "two", fileName: "同名.mp4" });
  releases[0](response(1));
  const a = await first;
  releases[1]({ ok: true, headers: new Map([["content-type", "text/html"]]) });
  await assert.rejects(second, /网页/);
  assert.equal(fs.existsSync(a.file), true);
  assert.equal(fs.readFileSync(a.file)[20], 1);
});

test("再次捕获相同资源的新签名后下载使用新地址", async () => {
  const old = media.push({ url: "https://example.invalid/result.mp4?lr=watermark&signature=old", kind: "video", instanceId: "one" });
  const fresh = media.push({ url: "https://example.invalid/result.mp4?lr=watermark&signature=fresh", kind: "video", instanceId: "one" });
  assert.equal(fresh.id, old.id);
  const result = await media.download({ fetch: async (url) => url.includes("signature=fresh") ? response(1) : { ok: false, status: 403 } }, fresh, { requireUnwatermarked: true });
  assert.equal(result.ok, true);
  assert.match(result.url, /signature=fresh/);
});

test("同任务已有文件被截断后重新下载，不复用损坏文件", async () => {
  const item = resource("one");
  let requests = 0;
  const session = { fetch: async () => { requests++; return response(1); } };
  const first = await media.download(session, item, { taskId: "one", requireUnwatermarked: true });
  fs.writeFileSync(first.file, "");
  const second = await media.download(session, item, { taskId: "one", requireUnwatermarked: true });
  assert.equal(requests, 2);
  assert.equal(fs.statSync(second.file).size, 32);
});

test("同任务已有文件被同大小网页替换后不复用", async () => {
  const item = resource("one");
  let requests = 0;
  const session = { fetch: async () => { requests++; return response(1); } };
  const first = await media.download(session, item, { taskId: "one", requireUnwatermarked: true });
  fs.writeFileSync(first.file, Buffer.alloc(32, 32).fill("<html>not a video</html>"));
  const second = await media.download(session, item, { taskId: "one", requireUnwatermarked: true });
  assert.equal(requests, 2);
  assert.equal(fs.readFileSync(second.file).subarray(4, 8).toString(), "ftyp");
});

test("捕获超过800个临时候选不丢手动下载和任务归属，换目录重启仍可见", async () => {
  const manual = resource("manual");
  const downloaded = await media.download({ fetch: async () => response(1) }, manual, { requireUnwatermarked: true });
  const pending = resource("pending");
  media.annotate(pending, { taskId: "pending-task" });
  for (let n = 0; n < 805; n += 1) {
    media.push({ url: `https://example.invalid/image-${n}.jpg`, kind: "image", instanceId: "one" });
  }
  assert.equal(media.list({ kind: "image" }).length, 800);
  assert.equal(media.get(manual.id).downloaded, downloaded.file);
  assert.equal(media.list({ taskId: "pending-task" }).length, 1);
  store.get().settings.downloadDir = path.join(P.home(), "new-videos");
  store.save();
  media.saveResources();
  const code = "const P=require('./src/paths');P.init({home:process.argv[1]});require('./src/store').load();const m=require('./src/interceptor');require('./src/video-library').list().then(v=>console.log(JSON.stringify({videos:v.items,pending:m.list({taskId:'pending-task'}).length,images:m.list({kind:'image'}).length})));";
  const child = spawnSync(process.execPath, ["-e", code, P.home()], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const reloaded = JSON.parse(child.stdout);
  assert.equal(reloaded.videos[0].path, downloaded.file);
  assert.equal(reloaded.videos[0].watermark, "none");
  assert.equal(reloaded.pending, 1);
  assert.equal(reloaded.images, 800);
});

test("严格无水印下载拒绝最终重定向到带水印或状态不明的地址", async () => {
  const marked = resource("redirect-marked");
  await assert.rejects(media.download({ fetch: async () => ({ ...response(1), url: "https://cdn.example.invalid/output.mp4?lr=watermark" }) }, marked, { requireUnwatermarked: true }), /重定向到了带水印源/);
  const unknown = resource("redirect-unknown");
  await assert.rejects(media.download({ fetch: async () => ({ ...response(1), url: "https://cdn.example.invalid/output.mp4?signature=signed" }) }, unknown, { requireUnwatermarked: true }), /原片地址重定向后无法确认水印状态/);
  assert.equal(marked.downloaded, "");
  assert.equal(unknown.downloaded, "");
  assert.deepEqual(fs.readdirSync(store.get().settings.downloadDir), []);
});

test("手动下载按最终响应地址区分带水印和未知，复用保留真实状态", async () => {
  const marked = resource("redirect-marked");
  const markedResult = await media.download({ fetch: async () => ({ ...response(1), url: "https://cdn.example.invalid/output.mp4?lr=watermark" }) }, marked);
  assert.equal(markedResult.watermark, "kept");
  assert.equal(markedResult.unwatermarked, false);
  const unknown = resource("redirect-unknown");
  const finalUrl = "https://cdn.example.invalid/output.mp4?signature=signed";
  const unknownResult = await media.download({ fetch: async () => ({ ...response(1), url: finalUrl }) }, unknown, { taskId: "unknown-task" });
  assert.equal(unknownResult.watermark, "unknown");
  assert.equal(unknownResult.unwatermarked, false);
  assert.equal(unknown.downloadUrl, finalUrl);
  assert.equal(unknown.watermark, "unknown");
  const reused = await media.download({ fetch: async () => { throw new Error("must reuse"); } }, unknown, { taskId: "unknown-task" });
  assert.equal(reused.reused, true);
  assert.equal(reused.watermark, "unknown");
  assert.equal(reused.fallback, false);
});
