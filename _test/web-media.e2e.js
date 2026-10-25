"use strict";
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), assert = require("node:assert/strict");
const exec = require("node:util").promisify(require("node:child_process").execFile);
const home = path.resolve(__dirname, "../build/web-test-userdata");
const build = path.resolve(__dirname, "../build/web-release");
const base = "http://127.0.0.1:17925";
let cookie = "", server;
async function rpc(channel, ...args) {
  const response = await fetch(base + "/web/rpc", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ channel, args }) });
  const result = await response.json(); assert.ok(response.ok, result.error); return result.result;
}
async function call(channel, ...args) { const result = await rpc(channel, ...args); assert.equal(result.ok, true, result.error); return result.data; }
(async () => {
  const response = await fetch(base + "/web/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: fs.readFileSync(path.join(home, "web-access.txt"), "utf8").trim() }) });
  cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal(path.resolve((await rpc("app:paths")).home), home, "Must use isolated data");
  const P = require("../src/paths"); P.init({ home, resources: path.join(build, "豆包工坊", "resources") });
  const { catalog, createManager } = require("../src/components"), manifest = catalog();
  server = http.createServer((_req, res) => { res.writeHead(200, { "content-length": manifest.file.size }); fs.createReadStream(path.join(build, manifest.file.name)).pipe(res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const installed = await createManager({ urls: [`http://127.0.0.1:${server.address().port}/tools`] }).install();
  assert.equal(installed.phase, "installed", JSON.stringify(installed));
  const probe = await rpc("mask:probe"); assert.ok(probe.opencv && probe.model && probe.script && probe.ffmpegOk);
  const video = path.join(home, "网页视频验收.mp4"), png = path.join(home, "网页图片验收.png");
  await exec(probe.ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=10", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video], { windowsHide: true });
  await exec(probe.ffmpeg, ["-y", "-i", video, "-frames:v", "1", png], { windowsHide: true });
  const uploaded = [];
  for (const file of [png, video]) {
    const r = await fetch(base + "/web/upload?name=" + encodeURIComponent(path.basename(file)), { method: "POST", headers: { cookie }, body: fs.readFileSync(file) });
    assert.ok(r.ok); uploaded.push((await r.json()).path);
  }
  const result = await rpc("mask:run", { files: uploaded, mode: "mosaic", keepOriginal: true, outDir: path.join(home, "web-masked") });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.results.length, 2);
  for (const item of result.results) {
    assert.ok(fs.statSync(item.out).size > 0);
    const r = await fetch(base + "/web/media?path=" + encodeURIComponent(item.out), { headers: { cookie } });
    assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), fs.readFileSync(item.out));
  }
  const grid = await call("dm:asset:grid", [uploaded[0], uploaded[0], uploaded[0], uploaded[0]], { out: path.join(home, "web-grid.png"), cols: 2 });
  assert.equal(grid.ok, true, JSON.stringify(grid));
  const draft = await call("dm:jianying:draft", { name: "网页版剪映草稿验收", dir: path.join(home, "drafts"), files: [{ file: uploaded[1], durationMs: 2000 }] });
  assert.ok(fs.existsSync(path.join(draft.dir, "draft_content.json")));
  await rpc("store:save-settings", { downloadDir: path.join(home, "web-videos") });
  fs.mkdirSync(path.join(home, "web-videos"), { recursive: true }); fs.copyFileSync(video, path.join(home, "web-videos", "网页视频验收.mp4"));
  const library = await call("dm:videos"); assert.equal(library.items.length, 1);
  const seek = await fetch(base + "/web/media?path=" + encodeURIComponent(library.items[0].path), { headers: { cookie, range: "bytes=0-99" } });
  assert.equal(seek.status, 206); assert.equal((await seek.arrayBuffer()).byteLength, 100);
  console.log("PASS: 组件安装、真实图片和视频处理、预览文件、图片合成、剪映草稿导出、视频素材库及拖动播放的 Range 请求");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => server?.close());
