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
  const bundled = res("tools", name + (platform === "win32" ? ".exe" : ""));
  return fs.existsSync(bundled) ? bundled : name;
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

module.exports = { init, ensure, home, dir, res, resources, pyDir, toolDir, tool, downloadDir, legacyDownloadDir, paths, all };
