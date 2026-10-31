"use strict";
// Install the delivered EXE on a disposable Windows CI machine, then use an isolated app profile.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
assert.equal(process.platform, "win32");
const root = path.resolve(__dirname, ".."), pkg = require("../package.json");
const out = path.join(root, "dist", "windows-x64"), installer = path.join(out, `DoubaoWorkshop-${pkg.version}-Setup.exe`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-install-smoke-")), install = path.join(temporary, "installed");
const report = { version: pkg.version, checks: [], locales: [], commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() };
const run = (exe, args, options = {}) => execFileSync(exe, args, { cwd: root, timeout: 180000, encoding: "utf8", ...options });
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
try {
  const programs = run("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Programs')"]).trim();
  const desktop = run("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('DesktopDirectory')"]).trim();
  const oldLinks = [path.join(programs, pkg.productName, pkg.productName + " 网页版.lnk"), path.join(desktop, pkg.productName + " 网页版.lnk")];
  for (const file of oldLinks) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "obsolete test shortcut"); }
  const sentinel = path.join(process.env.APPDATA, "无限豆包", "installer-smoke-sentinel.txt");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true }); fs.writeFileSync(sentinel, "preserve existing data");
  run(installer, ["/S", "/NORUN", "/NODESKTOP", `/D=${install}`]);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve existing data");
  for (const file of oldLinks) assert.equal(fs.existsSync(file), false, "upgrade must remove the retired web shortcut");
  const compare = (directory, relative = "") => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(relative, item.name), source = path.join(directory, item.name);
      if (item.isDirectory()) compare(source, name);
      else assert.equal(sha(path.join(install, name)), sha(source), `installed payload differs: ${name}`);
    }
  };
  compare(path.join(out, pkg.productName));
  const metadata = JSON.parse(fs.readFileSync(path.join(install, "resources", "BUILD-INFO.json"), "utf8"));
  assert.equal(metadata.version, pkg.version); assert.equal(metadata.commit, report.commit);
  report.checks.push("Delivered EXE installs correctly, preserves existing user data, removes web shortcuts and matches all packaged files");
  const regression = run("powershell.exe", ["-NoProfile", "-File", path.join(__dirname, "installer-locks.test.ps1"), "-DeliveredInstaller", installer]);
  fs.writeFileSync(path.join(out, "installer-regression.log"), regression);
  report.checks.push("Native C# installer lock, integrity and upgrade regressions passed");
  for (const language of ["zh-CN", "zh-HK"]) {
    let output;
    try {
      output = run(process.execPath, [path.join(__dirname, "draft-only-smoke.cjs")], { env: { ...process.env, DM_TEST_RUNTIME: path.join(install, pkg.productName + ".exe"), DM_TEST_OUTPUT: out, DM_TEST_FIXTURE_LANGUAGE: language, DM_TEST_FIXTURE_BOOT_DELAY: "500", DM_TEST_CDP_PORT: "9261" } });
    } catch (error) {
      fs.writeFileSync(path.join(out, `smoke-${language}.log`), String(error.stdout || "") + String(error.stderr || ""));
      throw error;
    }
    fs.writeFileSync(path.join(out, `smoke-${language}.log`), output);
    const smoke = JSON.parse(fs.readFileSync(path.join(out, "smoke-results.json"), "utf8")); assert.equal(smoke.ok, true, smoke.error);
    fs.copyFileSync(path.join(out, "smoke-results.json"), path.join(out, `smoke-${language}.json`));
    fs.copyFileSync(path.join(out, "client-window.png"), path.join(out, `client-${language}.png`));
    report.locales.push({ language, checks: smoke.checks });
  }
  report.installerSha256 = sha(installer); report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack; process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, "windows-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  console.log(JSON.stringify(report, null, 2));
}
