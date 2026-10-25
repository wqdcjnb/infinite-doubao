"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const store = require("./store");

const pending = new Map();
const recentlySent = new Map();

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

async function findExecutable() {
  if (process.platform === "darwin") {
    const home = require("node:os").homedir();
    for (const base of ["/Applications", path.join(home, "Applications")]) {
      for (const name of ["JianyingPro.app", "剪映专业版.app", "CapCut.app"]) {
        const bundle = path.join(base, name);
        if (isFile(path.join(bundle, "Contents", "Info.plist"))) return bundle;
      }
    }
    throw new Error("未找到剪映专业版，请将剪映或 CapCut 安装到“应用程序”后重试。");
  }
  const local = process.env.LOCALAPPDATA;
  const standard = local && path.join(local, "JianyingPro", "Apps", "JianyingPro.exe");
  if (standard && isFile(standard)) return standard;

  // Read the installed file association; never execute the registry command itself.
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@('Registry::HKEY_CURRENT_USER\\Software\\Classes\\JianyingPro.JYPack\\shell\\open\\command',
  'Registry::HKEY_LOCAL_MACHINE\\Software\\Classes\\JianyingPro.JYPack\\shell\\open\\command') | ForEach-Object {
  $key = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue
  if ($key) { $key.GetValue('') }
}`;
  const commands = await new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 32768, shell: false },
      (error, stdout) => resolve(error ? "" : stdout));
  });
  for (const command of String(commands).split(/\r?\n/)) {
    const match = command.trim().match(/^"([^"\r\n]+JianyingPro\.exe)"(?:\s|$)/i);
    if (match && isFile(match[1])) return match[1];
  }
  throw new Error("未找到剪映专业版，请先安装并启动一次剪映，再点击“在剪映中编辑”。");
}

function taskFile(opts) {
  const task = (store.get().tasks || []).find((item) => item.id === opts.taskId);
  if (!task) throw new Error("任务不存在，请刷新任务队列。");
  if (task.status !== "succeeded") throw new Error("请等待视频生成完成后再导入剪映。");
  const files = [...new Set(((task.result && task.result.files) || []).filter((file) => typeof file === "string" && file))];
  if (!files.length) throw new Error("该任务没有可导入的本地视频。");
  if (opts.file && !files.includes(opts.file)) throw new Error("所选文件不属于该任务。");
  if (!opts.file && files.length > 1) throw new Error("该任务有多个视频，请选择要在剪映中编辑的视频。");
  const file = opts.file || files[0];
  if (!path.isAbsolute(file) || /["\x00-\x1f]/.test(file)) throw new Error("视频路径无效，请重新下载视频。");
  if (!isFile(file)) throw new Error("视频文件已移动或删除，请先从素材库重新下载。");
  return file;
}

function launch(executable, file) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(`无法打开剪映：${error.message}`));
      else resolve({ ok: true, file });
    }
    // This is Jianying's installed “Edit with Jianying” single-file entry point.
    // The native app inserts into an open project, or creates a project from its home screen.
    const mac = process.platform === "darwin";
    const child = spawn(mac ? "/usr/bin/open" : executable, mac ? ["-a", executable, file] : [`-open-file=${file}`], {
      shell: false, detached: true, stdio: "ignore", windowsHide: false
    });
    child.once("error", finish);
    child.once("spawn", () => {
      timer = setTimeout(() => finish(), 1200);
      child.unref();
    });
    child.once("exit", (code, signal) => {
      if (code !== 0 && (code != null || signal)) finish(new Error(`启动进程退出（${signal || code}）`));
    });
  });
}

async function importTask(opts = {}) {
  const file = taskFile(opts);
  const key = process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  for (const [item, sent] of recentlySent) if (Date.now() - sent.at >= 5000) recentlySent.delete(item);
  if (recentlySent.has(key)) return recentlySent.get(key).result;
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    const executable = await findExecutable();
    const result = await launch(executable, file);
    recentlySent.set(key, { at: Date.now(), result });
    return result;
  })();
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}

module.exports = { findExecutable, importTask };
