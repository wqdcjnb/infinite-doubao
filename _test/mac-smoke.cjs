"use strict";
// Install the actual DMG and exercise only the retained client workflow.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
assert.equal(process.platform, "darwin");
const root = path.resolve(__dirname, ".."), pkg = require("../package.json");
const out = path.join(root, "dist", `mac-${process.arch}`);
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doubao-dmg-smoke-")));
const mount = path.join(fixture, "mount"), app = path.join(fixture, pkg.productName + ".app");
let mounted = false;
const report = { version: pkg.version, platform: process.platform, arch: process.arch, checks: [] };
function run(cmd, args, options = {}) { return execFileSync(cmd, args, { encoding: "utf8", timeout: 180000, ...options }); }
try {
  fs.mkdirSync(mount);
  run("hdiutil", ["attach", path.join(out, `DoubaoWorkshop-${pkg.version}-mac-${process.arch}.dmg`), "-readonly", "-nobrowse", "-mountpoint", mount]); mounted = true;
  run("ditto", [path.join(mount, pkg.productName + ".app"), app]);
  run("hdiutil", ["detach", mount]); mounted = false;
  run("codesign", ["--verify", "--deep", "--strict", app]);
  report.checks.push("DMG mounted, application copied and signature verified");
  const executable = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", path.join(app, "Contents/Info.plist")]).trim();
  console.log(run(process.execPath, [path.join(__dirname, "draft-only-smoke.cjs")], { env: { ...process.env, DM_TEST_RUNTIME: path.join(app, "Contents/MacOS", executable), DM_TEST_OUTPUT: out, DM_TEST_CDP_PORT: "9261" } }));
  const smoke = JSON.parse(fs.readFileSync(path.join(out, "smoke-results.json"), "utf8"));
  assert.equal(smoke.ok, true, smoke.error);
  report.checks.push(...smoke.checks);
  fs.copyFileSync(path.join(out, "client-window.png"), path.join(out, "mac-main-window.png"));
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack; process.exitCode = 1;
} finally {
  if (mounted) try { run("hdiutil", ["detach", mount]); } catch {}
  fs.writeFileSync(path.join(out, "mac-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  fs.rmSync(fixture, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
