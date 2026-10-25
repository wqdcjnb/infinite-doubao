"use strict";

/**
 * 日志：按天分文件，保留 7 天，同时在内存里留一圈给界面看。
 *
 * 对标产品的日志是给人看的纯文本，出问题只能靠肉眼扫。这里结构化落盘（一行一条 JSON），
 * 界面/CLI 都能 filter，定位问题不用再翻终端。
 */

const fs = require("node:fs");
const path = require("node:path");
const P = require("./paths");

const KEEP_DAYS = 7;
const MEMORY_LIMIT = 400;

let memory = [];
let listeners = new Set();
let ready = false;

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fileFor(day) {
  return path.join(P.dir("logs"), `${day}.jsonl`);
}

function prune() {
  try {
    const files = fs.readdirSync(P.dir("logs")).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    while (files.length > KEEP_DAYS) {
      const victim = files.shift();
      try { fs.rmSync(path.join(P.dir("logs"), victim), { force: true }); } catch {}
    }
  } catch {}
}

function init() {
  if (ready) return;
  ready = true;
  P.ensure();
  prune();
}

function write(level, event, payload) {
  init();
  const now = new Date();
  const entry = {
    t: now.toISOString(),
    level,
    event: String(event || ""),
    ...(payload && typeof payload === "object" ? payload : payload === undefined ? {} : { value: payload })
  };
  memory.push(entry);
  if (memory.length > MEMORY_LIMIT) memory = memory.slice(-MEMORY_LIMIT);
  try {
    fs.appendFileSync(fileFor(stamp(now)), JSON.stringify(entry) + "\n", "utf8");
  } catch {}
  for (const fn of listeners) {
    try { fn(entry); } catch {}
  }
  return entry;
}

const info = (event, payload) => write("info", event, payload);
const warn = (event, payload) => write("warn", event, payload);
const error = (event, payload) => write("error", event, payload);

function recent(limit = 200, q = "") {
  const n = Math.max(1, Math.min(MEMORY_LIMIT, Number(limit) || 200));
  const needle = String(q || "").toLowerCase();
  const list = needle
    ? memory.filter((e) => JSON.stringify(e).toLowerCase().includes(needle))
    : memory;
  return list.slice(-n);
}

/** 读某一天的落盘日志（界面「日志」页用） */
function readDay(day, limit = 500) {
  const file = fileFor(day || stamp(new Date()));
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(2000, Number(limit) || 500))).map((l) => {
      try { return JSON.parse(l); } catch { return { t: "", level: "info", event: l }; }
    });
  } catch {
    return [];
  }
}

function days() {
  try {
    return fs.readdirSync(P.dir("logs"))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function onEntry(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { init, info, warn, error, recent, readDay, days, onEntry, onLog: onEntry };
