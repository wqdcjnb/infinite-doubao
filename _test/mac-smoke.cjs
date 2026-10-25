// Run against the actual DMG on a clean macOS runner, using only a disposable profile.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { CDP } = require("./cdp");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const out = path.join(root, "dist", `mac-${process.arch}`);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "豆包工坊 安装测试-"));
const home = path.join(fixture, "用户数据"), mount = path.join(fixture, "镜像");
const app = path.join(fixture, "Applications", pkg.productName + ".app");
const res = path.join(app, "Contents", "Resources");
const report = { version: pkg.version, platform: process.platform, arch: process.arch, checks: [] };
process.env.DM_TEST_CDP_PORT = "9261";
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 120000 });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function attach() {
  for (let n = 0; n < 80; n++) {
    try { const c = await CDP.attach(); if (await c.eval("!!window.DM")) return c; c.close(); } catch {}
    await pause(500);
  }
  throw new Error("Packaged main window did not open");
}
let c, mounted = false;
(async () => {
  assert.equal(process.platform, "darwin");
  fs.mkdirSync(mount);
  run("hdiutil", ["attach", path.join(out, `DoubaoWorkshop-${pkg.version}-mac-${process.arch}.dmg`), "-readonly", "-nobrowse", "-mountpoint", mount]); mounted = true;
  run("ditto", [path.join(mount, pkg.productName + ".app"), app]);
  run("hdiutil", ["detach", mount]); mounted = false;
  run("codesign", ["--verify", "--deep", "--strict", app]);
  report.checks.push("DMG mounted, copied app, signature verified");
  const P = require("../src/paths"), store = require("../src/store");
  P.init({ home }); store.load(); store.get().settings.server.enabled = false; store.save();
  const marker = path.join(home, "attachments", "保留素材.txt");
  fs.writeFileSync(marker, "keep user data");
  run("/usr/bin/open", ["-n", "-a", app, "--args", `--user-data-dir=${home}`, "--remote-debugging-port=9261"]);
  c = await attach();
  assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
  assert.equal(await c.eval("(await DM.call('dm:state')).ok"), true);
  const status = await c.eval("DM.call('dm:update:status')");
  assert.equal(status.data.platform, "darwin");
  assert.ok(status.data.source.endsWith(`latest-darwin-${process.arch}.json`));
  assert.equal(await c.eval("!!document.querySelector('[data-view=\"drafts\"]')"), true);
  report.checks.push("Installed main window, preload IPC, draft navigation, platform update endpoint");
  const probe = await c.eval("DM.probeMask()");
  assert.ok(probe.model && probe.script && probe.ffmpegOk && probe.opencv, JSON.stringify(probe));
  assert.ok(probe.python.startsWith(res)); assert.ok(probe.ffmpeg.startsWith(res));
  const input = path.join(fixture, "中文测试视频.mp4"), maskOut = path.join(fixture, "处理结果");
  run(path.join(res, "tools", "ffmpeg"), ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=10", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", input]);
  const masked = await c.eval(`DM.runMask(${JSON.stringify({ files: [input], outDir: maskOut, keepOriginal: true })})`);
  assert.equal(masked.ok, true, JSON.stringify(masked));
  assert.equal(masked.results.length, 1); assert.ok(fs.statSync(masked.results[0].out).size > 1000);
  const duration = run(path.join(res, "tools", "ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", masked.results[0].out]);
  assert.ok(Number(duration.trim()) > 0);
  report.checks.push("Bundled Python/OpenCV/YuNet and FFmpeg/ffprobe processed a video with a Chinese path");
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, "mac-main-window.png"), Buffer.from(shot.data, "base64"));
  await c.eval("setTimeout(()=>window.close(),100)"); c.close(); c = null; await pause(1000);
  run("/usr/bin/open", ["-a", app]); c = await attach();
  assert.equal(await c.eval("(await DM.call('dm:state')).ok"), true);
  assert.equal(fs.readFileSync(marker, "utf8"), "keep user data");
  report.checks.push("Closing and reopening from LaunchServices restores the main window and preserves user data");
  report.ok = true;
})().catch((error) => { report.ok = false; report.error = error.stack; process.exitCode = 1; }).finally(() => {
  c?.close();
  try { run("/usr/bin/osascript", ["-e", `tell application ${JSON.stringify(app)} to quit`]); } catch {}
  if (mounted) try { run("hdiutil", ["detach", mount]); } catch {}
  fs.writeFileSync(path.join(out, "mac-smoke.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
