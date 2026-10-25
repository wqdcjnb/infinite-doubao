"use strict";

const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), assert = require("node:assert/strict");
const exec = require("node:util").promisify(require("node:child_process").execFile);
const { CDP } = require("./cdp");
const home = process.env.DM_TEST_HOME, build = process.env.DM_TEST_BUILD;
if (!home || !build || !process.env.DM_TEST_CDP_PORT) throw new Error("Use a dedicated test home, build directory and CDP port");
const manifest = JSON.parse(fs.readFileSync(path.join(build, `components-${process.platform}-${process.arch}.json`)));
let requests = 0, server, c;
const timer = setTimeout(() => { console.error("Component E2E timed out"); process.exit(1); }, 150000);
(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== "/" + manifest.file.name) { res.writeHead(404); res.end(); return; }
    requests++; res.writeHead(200, { "Content-Length": manifest.file.size });
    fs.createReadStream(path.join(build, manifest.file.name)).pipe(res);
  });
  await new Promise(resolve => server.listen(18978, "127.0.0.1", resolve));
  c = await CDP.attach();
  assert.equal(path.resolve((await c.eval("DM.paths()")).home), path.resolve(home));
  const state = () => c.eval("DM.call('dm:components:status').then(r=>r.data)");
  const restart = process.argv.includes("--verify-restart");
  assert.equal((await state()).phase, restart ? "installed" : "idle");
  if (!restart) {
    assert.equal((await c.eval("DM.probeMask()")).opencv, "");
    assert.equal(requests, 0);
    await c.eval("document.querySelector('.vtab[data-view=settings]').click()");
    for (let n = 0; n < 100; n++) {
      if (await c.eval("!!document.querySelector('#view-settings .component-install:not(:disabled)')")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await c.eval("document.querySelector('#view-settings .component-install').click()");
    for (let n = 0; n < 600; n++) {
      const s = await state();
      if (s.phase === "error") throw new Error(s.reason);
      if (s.phase === "installed") break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal((await state()).phase, "installed"); assert.equal(requests, 1);
  }
  const ready = await state();
  const probe = await c.eval("DM.probeMask()");
  assert.ok(probe.opencv && probe.ffmpegOk && probe.model && probe.script, JSON.stringify(probe));
  assert.ok(probe.python.startsWith(ready.directory)); assert.ok(probe.ffmpeg.startsWith(ready.directory));
  if (!restart) {
    const video = path.join(home, "中文素材.mp4"), png = path.join(home, "图片素材.png"), output = path.join(home, "处理输出");
    await exec(probe.ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=10", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", video], { windowsHide: true });
    const masked = await c.eval(`DM.runMask(${JSON.stringify({ files: [video], outDir: output, keepOriginal: true })})`);
    assert.equal(masked.ok, true, JSON.stringify(masked)); assert.ok(fs.statSync(masked.results[0].out).size > 1000);
    await exec(probe.ffmpeg, ["-y", "-i", video, "-frames:v", "1", png], { windowsHide: true });
    const grid = await c.eval(`DM.call('dm:asset:grid',${JSON.stringify([png, png, png, png])},${JSON.stringify({ out: path.join(home, "四宫格.png"), cols: 2 })})`);
    assert.ok(grid.ok && grid.data.ok, JSON.stringify(grid));
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(home, "optional-components.png"), Buffer.from(shot.data, "base64"));
  } else assert.equal(requests, 0);
  console.log("PASS: " + (restart ? "重启后组件复用，无重复下载" : "精简版不自动下载，界面选择安装，校验解压，中文视频遮脸与图片合成"));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearTimeout(timer); c?.close(); server?.close(); });
