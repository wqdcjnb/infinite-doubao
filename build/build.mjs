"use strict";

/**
 * 打包脚本：把 src/renderer 打成 app.asar，塞进本地 Electron 运行时，产出可直接双击的 exe。
 *
 * 为什么不走 electron-builder：本机 electron 下载缓存是空的，离线环境下 builder 会卡在
 * 拉 electron 包那一步；而 D 盘已有完整的 Electron 43 运行时（就是老版那个目录），
 * 直接复制 + 换 app.asar + 改 exe 名字，效果完全一样，还快。
 *
 * asar 用自己写的 tools/asar.mjs 打（纯 Node，零依赖），npx @electron/asar 只在它失败时兜底，
 * 这样离线机器也能出包。
 *
 * 用法：node build/build.mjs [--runtime <目录>] [--out <目录>] [--name <exe名>]
 */

import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const RUNTIME = argOf("--runtime", "D:\\BaiduNetdiskDownload\\dolavip3.0-于-运行文件");
const OUT = argOf("--out", path.join(ROOT, "dist"));
const EXE_NAME = argOf("--name", "豆包工坊");

const APP_DIR = path.join(OUT, EXE_NAME);
const RES = path.join(APP_DIR, "resources");
const ASAR = path.join(RES, "app.asar");

function log(msg) { process.stdout.write(`[build] ${msg}\n`); }

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (error) {
      last = error;
      log(`清理失败（${error.code || error.message}），第 ${i + 1}/5 次重试`);
      try { execSync(`taskkill /F /IM "${EXE_NAME}.exe" /T`, { stdio: "ignore" }); } catch {}
      try { execSync("timeout /t 2 /nobreak > nul", { stdio: "ignore", shell: "cmd.exe" }); } catch {}
    }
  }
  throw last;
}

function copyFile(a, b) {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.copyFileSync(a, b);
}

function bundlePython() {
  const python = process.env.DOLAMOD_PYTHON || "python";
  const runtime = JSON.parse(execFileSync(python, ["-I", "-c", "import sys,cv2,numpy,json; from pathlib import Path; print(json.dumps({'base':sys.base_prefix,'site':str(Path(numpy.__file__).parent.parent),'version':str(sys.version_info.major)+str(sys.version_info.minor)}))"], { encoding: "utf8", windowsHide: true }));
  const target = path.join(RES, "python");
  const filter = (file) => !["__pycache__", "test", "tests"].includes(path.basename(file)) && !/\.py[co]$/i.test(file);
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(runtime.base)) {
    if (/^(pythonw?\.exe|.+\.dll|LICENSE\.txt)$/i.test(name)) copyFile(path.join(runtime.base, name), path.join(target, name));
  }
  fs.cpSync(path.join(runtime.base, "DLLs"), path.join(target, "DLLs"), { recursive: true, filter });
  fs.cpSync(path.join(runtime.base, "Lib"), path.join(target, "Lib"), { recursive: true, filter: (file) => path.basename(file) !== "site-packages" && filter(file) });
  const siteTarget = path.join(target, "Lib", "site-packages");
  for (const name of fs.readdirSync(runtime.site)) {
    if (["cv2", "numpy", "numpy.libs"].includes(name) || /^(numpy|opencv_python(?:_headless)?)-.+\.dist-info$/i.test(name)) {
      fs.cpSync(path.join(runtime.site, name), path.join(siteTarget, name), { recursive: true, filter });
    }
  }
  // 隔离运行环境，避免读取部门电脑上的 Python 注册表、环境变量或用户包。
  fs.writeFileSync(path.join(target, `python${runtime.version}._pth`), ".\nLib\nDLLs\nLib\\site-packages\n");
  const versions = execFileSync(path.join(target, "python.exe"), ["-B", "-I", "-c", "import cv2,numpy;print('OpenCV '+cv2.__version__+', NumPy '+numpy.__version__)"], { encoding: "utf8", windowsHide: true }).trim();
  log("内置遮脸运行环境：" + versions);
}

function packAsar(stage, target) {
  try {
    const script = path.join(ROOT, "tools", "asar.mjs");
    execSync(`"${process.execPath}" "${script}" pack "${stage}" "${target}"`, { stdio: "inherit", cwd: ROOT });
    return true;
  } catch (error) {
    log(`内置 asar 失败：${error && error.message}，改用 @electron/asar`);
  }
  try {
    execSync(`npx --yes @electron/asar pack "${stage}" "${target}"`, {
      stdio: "inherit",
      cwd: OUT,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh"
    });
    return true;
  } catch (error) {
    log(`asar 打包失败：${error && error.message}`);
    return false;
  }
}

function main() {
  if (!fs.existsSync(RUNTIME)) throw new Error("找不到 Electron 运行时目录：" + RUNTIME);

  log("清理旧产物");
  rmrf(APP_DIR);
  fs.mkdirSync(APP_DIR, { recursive: true });

  log("复制 Electron 运行时");
  let exeSource = "";
  for (const name of fs.readdirSync(RUNTIME)) {
    const src = path.join(RUNTIME, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      if (name === "resources") continue;
      fs.cpSync(src, path.join(APP_DIR, name), { recursive: true });
      continue;
    }
    if (/^app\.asar/i.test(name)) continue;
    if (/\.bak[-.]/i.test(name)) continue;
    if (/\.exe$/i.test(name)) { exeSource = name; continue; }
    fs.copyFileSync(src, path.join(APP_DIR, name));
  }
  if (!exeSource) throw new Error("运行时目录里没有 exe");

  fs.mkdirSync(RES, { recursive: true });
  log("打包 app.asar");
  const stage = path.join(OUT, ".stage");
  rmrf(stage);
  fs.mkdirSync(stage, { recursive: true });
  for (const item of ["package.json", "src", "renderer", "tools"]) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(stage, item);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else copyFile(src, dst);
  }
  // py 脚本要能被外部 python 读到，不能塞进 asar，单独放到 resources/py
  fs.cpSync(path.join(ROOT, "py"), path.join(RES, "py"), { recursive: true });
  bundlePython();
  // webview 的 preload 同理：guest 进程读不到 asar 内的文件，必须放真实磁盘。
  // 它 require 的 ./page 与 ./fp-inject.js 也必须在真实磁盘上，否则 require 直接失败。
  copyFile(path.join(ROOT, "src", "webview-preload.js"), path.join(RES, "webview-preload.js"));
  copyFile(path.join(ROOT, "src", "fp-inject.js"), path.join(RES, "fp-inject.js"));
  fs.cpSync(path.join(ROOT, "src", "page"), path.join(RES, "page"), { recursive: true });

  // ffmpeg（视频遮脸 / 九宫格合成用）
  const toolsDir = path.join(RES, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  const ffmpegCands = [
    path.join(ROOT, "tools", "ffmpeg.exe"),
    path.join(RUNTIME, "..", "看海无限画布-客户版-启动器修复-最终版", "ffmpeg.exe"),
    "D:\\看海无限画布-客户版-启动器修复-最终版\\ffmpeg.exe",
    path.join(ROOT, "_rev", "ffmpeg-static", "ffmpeg.exe"),
    "D:\\_rev\\dolavip\\app\\node_modules\\ffmpeg-static\\ffmpeg.exe"
  ];
  for (const c of ffmpegCands) {
    if (c && fs.existsSync(c)) {
      log("内置 ffmpeg: " + c);
      copyFile(c, path.join(toolsDir, "ffmpeg.exe"));
      const ffprobe = path.join(path.dirname(c), "ffprobe.exe");
      if (fs.existsSync(ffprobe)) copyFile(ffprobe, path.join(toolsDir, "ffprobe.exe"));
      break;
    }
  }

  if (!packAsar(stage, ASAR)) process.exit(1);
  rmrf(stage);

  log("改名 exe");
  const targetExe = path.join(APP_DIR, `${EXE_NAME}.exe`);
  fs.copyFileSync(path.join(RUNTIME, exeSource), targetExe);

  const size = fs.statSync(ASAR).size;
  log(`完成：${targetExe}`);
  log(`app.asar ${(size / 1024 / 1024).toFixed(2)} MB`);
}

main();
