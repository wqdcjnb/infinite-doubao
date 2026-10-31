// Native Windows x64 package for the retained cloud-draft client.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build on native Windows x64");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const electron = "43.2.0";
const expected = "eba5f5088af40ecb364fe258809c79a5234c6ece5a75c64722772eba01b02786";
const out = path.join(root, "dist", "windows-x64"), cache = path.join(root, "build", "windows-cache");
const run = (exe, args) => execFileSync(exe, args, { cwd: root, stdio: "inherit" });
async function sha(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
fs.mkdirSync(cache, { recursive: true });
const archive = path.join(cache, `electron-v${electron}-win32-x64.zip`);
if (!fs.existsSync(archive) || await sha(archive) !== expected) {
  const response = await fetch(`https://github.com/electron/electron/releases/download/v${electron}/electron-v${electron}-win32-x64.zip`, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`Electron download HTTP ${response.status}`);
  await pipeline(response.body, fs.createWriteStream(archive + ".part"));
  if (await sha(archive + ".part") !== expected) throw new Error("Electron SHA-256 mismatch");
  fs.renameSync(archive + ".part", archive);
}
// Only this fixed generated build directory may be replaced.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const app = path.join(out, pkg.productName), stage = path.join(out, "stage");
const quote = value => "'" + value.replaceAll("'", "''") + "'";
run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(app)}`]);
fs.renameSync(path.join(app, "electron.exe"), path.join(app, pkg.productName + ".exe"));
const resources = path.join(app, "resources");
fs.rmSync(path.join(resources, "default_app.asar"), { force: true });
fs.mkdirSync(stage);
for (const item of ["package.json", "src", "renderer"]) fs.cpSync(path.join(root, item), path.join(stage, item), { recursive: true });
run(process.execPath, [path.join(root, "tools", "asar.mjs"), "pack", stage, path.join(resources, "app.asar")]);
for (const item of ["webview-preload.js", "fp-inject.js", "page"]) fs.cpSync(path.join(root, "src", item), path.join(resources, item), { recursive: true });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
fs.writeFileSync(path.join(resources, "BUILD-INFO.json"), JSON.stringify({ version: pkg.version, variant: "draft-only", commit, arch: "x64", platform: "win32", electron, electronSha256: expected }, null, 2) + "\n");
run(process.execPath, [path.join(root, "build", "installer.mjs"), "--app", app, "--out", out, "--name", pkg.productName]);
const installer = path.join(out, `DoubaoWorkshop-${pkg.version}-Setup.exe`);
fs.renameSync(path.join(out, `${pkg.productName} v${pkg.version} 安装包.exe`), installer);
fs.writeFileSync(path.join(out, "SHA256SUMS-windows-x64.txt"), `${await sha(installer)}  ${path.basename(installer)}\n`);
fs.rmSync(stage, { recursive: true, force: true });
console.log(JSON.stringify({ version: pkg.version, commit, installer, sha256: await sha(installer) }));
