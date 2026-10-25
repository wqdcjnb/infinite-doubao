"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const P = require("./paths");
const store = require("./store");
const interceptor = require("./interceptor");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv", ".avi"]);
const keyOf = (file) => process.platform === "win32" ? file.toLowerCase() : file;

async function list() {
  const data = store.get();
  const tasksById = new Map(data.tasks.map((task) => [task.id, task]));
  const directory = path.resolve(P.downloadDir(data.settings.downloadDir));
  const candidates = new Map();
  const resources = new Map(interceptor.list().filter((r) => r.downloaded).map((r) => [keyOf(path.resolve(r.downloaded)), r]));
  function add(file, task) {
    const resolved = path.resolve(file);
    if (!VIDEO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return;
    const key = keyOf(resolved);
    if (!candidates.has(key)) candidates.set(key, { file: resolved, task });
  }
  // 任务结果保留曾经使用过的保存目录；同一个文件只显示一次。
  for (const task of data.tasks.slice().reverse()) {
    for (const file of task.result?.files || []) add(file, task);
  }
  // Persisted downloads remain visible after changing the save directory or restarting.
  for (const resource of resources.values()) add(resource.downloaded, tasksById.get(resource.taskId));
  async function scan(folder) {
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) add(file);
    }
  }
  await scan(directory);
  const items = [];
  for (const { file, task } of candidates.values()) {
    let stat;
    try { stat = await fs.stat(file); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isFile() || !stat.size) continue;
    const resource = resources.get(keyOf(file));
    items.push({
      path: file, url: pathToFileURL(file).href, name: path.basename(file),
      size: stat.size, modifiedAt: stat.mtime.toISOString(),
      templateName: task?.templateName || resource?.templateName || "", model: task?.model || "", duration: task?.duration || 0,
      taskId: task?.id || resource?.taskId || "", resourceId: resource?.id || "",
      watermark: resource?.watermark || (task?.result?.unwatermarked === true ? "none" : "unknown")
    });
  }
  items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
  return { directory, items };
}

module.exports = { list };
