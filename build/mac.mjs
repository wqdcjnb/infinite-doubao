// Run natively on macOS (arm64 or x64). No system Python/Homebrew required by the app.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arch = process.arch;
if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch)) throw new Error("Build on a native arm64 or x64 Mac");
const deps = JSON.parse(fs.readFileSync(path.join(root, "build/mac-dependencies.json")));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
const name = pkg.productName;
const out = path.join(root, "dist", `mac-${arch}`);
const cache = path.join(root, "build", "mac-cache");
// Only the fixed architecture build directory is disposable.
if (path.dirname(out) !== path.join(root, "dist") || !/^mac-(arm64|x64)$/.test(path.basename(out))) throw new Error("Unsafe output path");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(cache, { recursive: true });
const run = (exe, args, cwd = root) => execFileSync(exe, args, { stdio: "inherit", cwd });
async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function download(url, digest) {
  const target = path.join(cache, path.basename(new URL(url).pathname));
  if (fs.existsSync(target) && await sha256(target) === digest) return target;
  console.log(`Downloading ${path.basename(target)}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${url}`);
  await pipeline(res.body, fs.createWriteStream(target + ".part"));
  if (await sha256(target + ".part") !== digest) throw new Error(`Checksum mismatch: ${url}`);
  fs.renameSync(target + ".part", target);
  return target;
}

const electron = await download(`https://github.com/electron/electron/releases/download/v${deps.electron}/electron-v${deps.electron}-darwin-${arch}.zip`, deps[arch].electron);
const runtime = path.join(out, "runtime");
run("ditto", ["-x", "-k", electron, runtime]);
const dmgRoot = path.join(out, "image");
const app = path.join(dmgRoot, `${name}.app`);
run("ditto", [path.join(runtime, "Electron.app"), app]);
const contents = path.join(app, "Contents"), res = path.join(contents, "Resources");
for (const license of ["LICENSE", "LICENSES.chromium.html"]) {
  if (fs.existsSync(path.join(runtime, license))) fs.copyFileSync(path.join(runtime, license), path.join(res, license));
}
fs.rmSync(path.join(res, "default_app.asar"), { force: true });
fs.renameSync(path.join(contents, "MacOS", "Electron"), path.join(contents, "MacOS", name));
const plist = path.join(contents, "Info.plist");
const set = (key, type, value, file = plist) => {
  try { execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, file], { stdio: "pipe" }); }
  catch { run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} ${type} ${value}`, file]); }
};
for (const key of ["CFBundleName", "CFBundleDisplayName", "CFBundleExecutable"]) set(key, "string", name);
set("CFBundleIdentifier", "string", "com.doubao.workshop");
set("CFBundleShortVersionString", "string", pkg.version);
set("CFBundleVersion", "string", pkg.version);
set("LSMinimumSystemVersion", "string", "13.0");
set("NSHighResolutionCapable", "bool", "true");
set("NSCameraUsageDescription", "string", "允许在账号网页中使用摄像头");
set("NSMicrophoneUsageDescription", "string", "允许在账号网页中使用麦克风");
for (const helper of fs.readdirSync(path.join(contents, "Frameworks")).filter((f) => f.endsWith(".app"))) {
  const file = path.join(contents, "Frameworks", helper, "Contents", "Info.plist");
  const old = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", file], { encoding: "utf8" }).trim();
  set("CFBundleIdentifier", "string", old.replace("com.github.Electron", "com.doubao.workshop"), file);
}

const stage = path.join(out, "stage");
fs.mkdirSync(stage);
for (const item of ["package.json", "src", "renderer"]) fs.cpSync(path.join(root, item), path.join(stage, item), { recursive: true });
run(process.execPath, [path.join(root, "tools/asar.mjs"), "pack", stage, path.join(res, "app.asar")]);
for (const item of ["webview-preload.js", "fp-inject.js", "page"]) fs.cpSync(path.join(root, "src", item), path.join(res, item), { recursive: true });
fs.cpSync(path.join(root, "py"), path.join(res, "py"), { recursive: true, filter: (p) => !p.includes("__pycache__") });

const pyArch = arch === "arm64" ? "aarch64" : "x86_64";
const pythonTar = await download(`https://github.com/astral-sh/python-build-standalone/releases/download/${deps.pythonRelease}/cpython-${deps.python}+${deps.pythonRelease}-${pyArch}-apple-darwin-install_only_stripped.tar.gz`, deps[arch].python);
run("tar", ["-xzf", pythonTar, "-C", res]);
const python = path.join(res, "python", "bin", "python3");
// Pin wheel files as well as versions: pip on a newer build host otherwise picks a macOS 14-only NumPy.
const wheels = [];
for (const wheel of deps[arch].wheels) wheels.push(await download(wheel.url, wheel.sha256));
run(python, ["-I", "-m", "pip", "install", "--no-index", "--no-deps", "--no-cache-dir", ...wheels]);
run(python, ["-B", "-I", "-c", "import cv2,numpy;print('Bundled:',cv2.__version__,numpy.__version__)"]);
const tools = path.join(res, "tools");
fs.mkdirSync(tools);
// Build portable GPL tools from pinned source; no nonfree codecs or Homebrew dylibs in the app.
const ffmpegTar = await download(`https://ffmpeg.org/releases/ffmpeg-${deps.ffmpegVersion}.tar.xz`, deps.ffmpegSource);
const x264Tar = await download(`https://github.com/mirror/x264/archive/${deps.x264Revision}.tar.gz`, deps.x264Source);
const native = path.join(out, "native"), prefix = path.join(native, "installed");
fs.mkdirSync(native);
run("tar", ["-xf", ffmpegTar, "-C", native]);
run("tar", ["-xf", x264Tar, "-C", native]);
const x264 = path.join(native, `x264-${deps.x264Revision}`), ffmpeg = path.join(native, `ffmpeg-${deps.ffmpegVersion}`);
process.env.MACOSX_DEPLOYMENT_TARGET = "13.0";
process.env.PKG_CONFIG_PATH = path.join(prefix, "lib", "pkgconfig");
run("./configure", [`--prefix=${prefix}`, "--enable-static", "--enable-pic", "--disable-cli", "--disable-opencl", "--extra-cflags=-mmacosx-version-min=13.0"], x264);
run("make", ["-j4"], x264); run("make", ["install"], x264);
run("./configure", [`--prefix=${prefix}`, "--enable-gpl", "--enable-libx264", "--enable-zlib", "--disable-shared", "--enable-static", "--disable-autodetect", "--disable-doc", "--disable-debug", "--disable-ffplay", "--pkg-config-flags=--static", `--extra-cflags=-I${prefix}/include -mmacosx-version-min=13.0`, `--extra-ldflags=-L${prefix}/lib -mmacosx-version-min=13.0`], ffmpeg);
run("make", ["-j4"], ffmpeg);
for (const tool of ["ffmpeg", "ffprobe"]) {
  const dest = path.join(tools, tool);
  fs.copyFileSync(path.join(ffmpeg, tool), dest);
  fs.chmodSync(dest, 0o755);
  run(dest, ["-version"]);
  const links = execFileSync("otool", ["-L", dest], { encoding: "utf8" });
  if (/\/opt\/homebrew\/|\/usr\/local\/|\/Users\//.test(links.split("\n").slice(1).join("\n"))) throw new Error(`Nonportable ${tool} library dependency: ${links}`);
}
const sources = path.join(tools, "sources"); fs.mkdirSync(sources);
fs.copyFileSync(ffmpegTar, path.join(sources, path.basename(ffmpegTar)));
fs.copyFileSync(x264Tar, path.join(sources, `x264-${deps.x264Revision}.tar.gz`));
fs.copyFileSync(path.join(root, "build/mac.mjs"), path.join(sources, "mac.mjs"));
fs.copyFileSync(path.join(root, "build/mac-dependencies.json"), path.join(sources, "mac-dependencies.json"));
fs.copyFileSync(path.join(x264, "COPYING"), path.join(tools, "x264-COPYING.txt"));
for (const file of fs.readdirSync(ffmpeg).filter((f) => /^(COPYING|LICENSE)/.test(f))) fs.copyFileSync(path.join(ffmpeg, file), path.join(tools, "FFmpeg-" + file));
fs.writeFileSync(path.join(res, "THIRD-PARTY.txt"), `Electron ${deps.electron}: https://github.com/electron/electron\nCPython ${deps.python}: https://github.com/astral-sh/python-build-standalone/releases/tag/${deps.pythonRelease}\nOpenCV ${deps.opencv}: https://github.com/opencv/opencv-python\nNumPy ${deps.numpy}: https://github.com/numpy/numpy\nFFmpeg ${deps.ffmpegVersion} with x264: GPL, source archives and build configuration included in tools/sources.\nhttps://ffmpeg.org/ https://www.videolan.org/developers/x264.html\nSee bundled license files and Python dist-info directories.\n`);
// A local ad-hoc signature makes the arm64 bundle executable; it is not Developer ID notarization.
// Production signing can be supplied by a developer's login keychain, with no secrets in this repository.
const identity = process.env.DOLAMOD_MAC_SIGN_IDENTITY;
if (identity) {
  run("npx", ["--yes", "--package=@electron/osx-sign@2.7.1", "electron-osx-sign", app, `--identity=${identity}`, "--hardened-runtime"]);
} else {
  run("codesign", ["--force", "--deep", "--sign", "-", app]);
}
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
fs.symlinkSync("/Applications", path.join(dmgRoot, "Applications"));
fs.writeFileSync(path.join(dmgRoot, "安装说明.txt"), `将“${name}.app”拖入“Applications”后打开。更新前退出旧版，替换应用不会删除账号和素材。\n需要 macOS 13 或更新版本。${arch === "arm64" ? "适用于 Apple 芯片。" : "适用于 Intel Mac。"}\n${identity ? "" : "此构建采用临时签名，未经过 Apple 公证。请遵循 macOS 的正常安全提示；本项目不关闭或绕过系统安全检查。\n"}`);
const dmg = path.join(out, `DoubaoWorkshop-${pkg.version}-mac-${arch}.dmg`);
run("hdiutil", ["create", "-volname", name, "-srcfolder", dmgRoot, "-format", "UDZO", "-ov", dmg]);
if (identity && process.env.DOLAMOD_MAC_NOTARY_PROFILE) {
  run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", process.env.DOLAMOD_MAC_NOTARY_PROFILE, "--wait"]);
  run("xcrun", ["stapler", "staple", dmg]);
}
fs.writeFileSync(path.join(out, `SHA256SUMS-mac-${arch}.txt`), `${await sha256(dmg)}  ${path.basename(dmg)}\n`);
console.log(`Built ${dmg}`);
