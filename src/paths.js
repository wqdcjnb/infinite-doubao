"use strict";

/**
 * 目录规约
 *
 * 所有落盘位置集中在这里算，模块里不许再自己拼 userData / resources 路径。
 * 没跑在 Electron 里（单测、CLI 复用）时用 fallback，保证纯 Node 也能 require。
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

let root = "";
let resRoot = "";

function defaultHome() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") return app.getPath("userData");
  } catch {}
  return path.join(os.homedir(), ".infinite-doubao");
}

function defaultResources() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require("electron");
    if (app && app.isPackaged) return process.resourcesPath;
  } catch {}
  return path.join(__dirname, "..");
}

function init(opts) {
  root = path.resolve(String((opts && opts.home) || defaultHome()));
  resRoot = path.resolve(String((opts && opts.resources) || defaultResources()));
  ensure();
  return paths();
}

function home() {
  if (!root) init();
  return root;
}

function resources() {
  if (!resRoot) init();
  return resRoot;
}

function ensure() {
  const names = ["logs", "storyboards", "exports", "assets", "attachments", "tmp", "drafts", "updates", "browser"];
  for (const name of names) {
    try { fs.mkdirSync(dir(name), { recursive: true }); } catch {}
  }
}

/** 具名目录：home / logs / storyboards / exports / assets / tmp / py / tools */
function dir(name) {
  if (!name) return home();
  return path.join(home(), name);
}

/** 随包资源目录（打包后 = resources/） */
function res(...parts) {
  return path.join(resources(), ...parts);
}

/** py 脚本目录：打包后放在 resources/py，开发时在仓库 py/ */
function pyDir() {
  const packed = res("py");
  try { if (fs.existsSync(path.join(packed, "face_mask.py"))) return packed; } catch {}
  return path.join(__dirname, "..", "py");
}

function toolDir() {
  return res("tools");
}

function tool(name, platform = process.platform) {
  const optional = optionalDir();
  if (optional) {
    const file = path.join(optional, "tools", name + (platform === "win32" ? ".exe" : ""));
    if (fs.existsSync(file)) return file;
  }
  const bundled = res("tools", name + (platform === "win32" ? ".exe" : ""));
  return fs.existsSync(bundled) ? bundled : name;
}

function optionalFiles() {
  return process.platform === "win32" ? ["python/python.exe", "tools/ffmpeg.exe"] : ["python/bin/python3", "tools/ffmpeg", "tools/ffprobe"];
}

function optionalDir() {
  // Existing full installations keep their tools without another download.
  if (optionalFiles().every((f) => fs.existsSync(res(f)))) return resources();
  try {
    const m = JSON.parse(fs.readFileSync(res("optional-components.json"), "utf8"));
    if (!/^[a-f0-9]{64}$/.test(m.id) || m.platform !== process.platform || m.arch !== process.arch) return "";
    const root = path.join(dir("components"), m.id);
    if (JSON.parse(fs.readFileSync(path.join(root, "ready.json"), "utf8")).id === m.id && optionalFiles().every((f) => fs.existsSync(path.join(root, f)))) return root;
  } catch {}
  return "";
}

/** 成片目录：设置里可覆盖，默认放到系统下载目录下的专用文件夹 */
function downloadsRoot() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") return app.getPath("downloads");
  } catch {}
  return path.join(os.homedir(), "Downloads");
}

function downloadDir(custom) {
  if (custom && String(custom).trim()) return String(custom).trim();
  return path.join(downloadsRoot(), "豆包工坊", "生成视频");
}

function legacyDownloadDir() {
  return path.join(downloadsRoot(), "无限豆包", "生成视频");
}

function paths() {
  return {
    home: home(),
    logs: dir("logs"),
    storyboards: dir("storyboards"),
    exports: dir("exports"),
    assets: dir("assets"),
    attachments: dir("attachments"),
    tmp: dir("tmp"),
    py: pyDir(),
    tools: toolDir(),
    resources: resources()
  };
}

/** 全量目录表（界面「接口」页与 /api/paths 用） */
function all(customDownloadDir) {
  return {
    ...paths(),
    drafts: dir("drafts"),
    updates: dir("updates"),
    browser: dir("browser"),
    downloads: downloadDir(customDownloadDir)
  };
}

module.exports = { init, ensure, home, dir, res, resources, pyDir, toolDir, tool, optionalDir, optionalFiles, downloadDir, legacyDownloadDir, paths, all };
