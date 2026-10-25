#!/usr/bin/env node
"use strict";

/**
 * 命令行入口（纯 Node，不需要 Electron）
 *
 * 用法：
 *   node src/cli.js token
 *   node src/cli.js state
 *   node src/cli.js instances
 *   node src/cli.js start <storyboardId>
 *   node src/cli.js status <storyboardId>
 *   node src/cli.js tasks [--status failed]
 *   node src/cli.js resources [--kind video] [--unwatermarked]
 *   node src/cli.js download <resourceId> [--instance <id>]
 *   node src/cli.js check "提示词"
 *   node src/cli.js mcp tools
 *
 * 地址与 token 从 APP_HOME 里读（默认 %APPDATA%/infinite-doubao 或 ~/.infinite-doubao）。
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function home() {
  const env = process.env.DOLAMOD_HOME;
  if (env) return env;
  // 豆包工坊沿用旧数据目录「无限豆包」，改名不改变账号会话和接口 token；
  // 老版本/开发态可能是 infinite-doubao，两个都探一遍，取真正有 token 的那个。
  const appData = process.env.APPDATA || path.join(os.homedir(), ".config");
  const candidates = [
    path.join(appData, "无限豆包"),
    path.join(appData, "infinite-doubao"),
    path.join(os.homedir(), ".infinite-doubao")
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, "api-token.txt"))) return c; } catch {}
  }
  return candidates[0];
}

function token() {
  const file = path.join(home(), "api-token.txt");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function base() {
  return process.env.DOLAMOD_API || "http://127.0.0.1:17823";
}

async function call(method, apiPath, body) {
  const t = token();
  const res = await fetch(base() + apiPath, {
    method,
    headers: {
      authorization: t ? `Bearer ${t}` : "",
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function args() {
  const raw = process.argv.slice(2);
  const out = { _: [] };
  for (let i = 0; i < raw.length; i += 1) {
    const a = raw[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i += 1; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function table(rows, cols) {
  if (!rows.length) return "（空）";
  const widths = cols.map((c) => Math.max(String(c.label).length, ...rows.map((r) => String(r[c.key] == null ? "" : r[c.key]).length)));
  const line = (cells) => cells.map((v, i) => String(v == null ? "" : v).padEnd(widths[i])).join("  ");
  return [line(cols.map((c) => c.label)), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map((r) => line(cols.map((c) => r[c.key])))].join("\n");
}

async function main() {
  const a = args();
  const cmd = a._[0] || "help";

  if (cmd === "help" || cmd === "--help") {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^[\s\S]*?\/\*\*/, "").trim());
    return;
  }
  if (cmd === "token") {
    console.log(token() || `（没找到 token：${path.join(home(), "api-token.txt")}，先启动一次应用）`);
    return;
  }

  if (cmd === "state") {
    const s = await call("GET", "/api/state");
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  if (cmd === "instances") {
    const r = await call("GET", "/api/instances");
    console.log(table(r.items || [], [
      { key: "id", label: "ID" },
      { key: "name", label: "名称" },
      { key: "platform", label: "平台" },
      { key: "kernel", label: "内核" },
      { key: "quota", label: "额度", get: (v) => v }
    ]).replace(/\n/g, "\n"));
    for (const i of r.items || []) console.log(`  ${i.name}: 已用 ${i.quota.video}/${i.quota.perDay}${i.quota.cooling ? "（冷却中）" : ""} ${i.login ? i.login.state : ""}`);
    return;
  }
  if (cmd === "start") {
    const id = a._[1];
    if (!id) throw new Error("用法：cli.js start <storyboardId>");
    console.log(JSON.stringify(await call("POST", `/api/storyboards/${id}/start`, {}), null, 2));
    return;
  }
  if (cmd === "status") {
    const id = a._[1];
    if (!id) throw new Error("用法：cli.js status <storyboardId>");
    const r = await call("GET", `/api/storyboards/${id}`);
    const st = r.stats || {};
    console.log(`${r.storyboard.name}  共 ${st.total || 0} 镜：完成 ${st.succeeded || 0} / 失败 ${st.failed || 0} / 待派 ${st.pending || 0} / 运行 ${st.running || 0}`);
    return;
  }
  if (cmd === "tasks") {
    const q = new URLSearchParams();
    if (a.status) q.set("status", String(a.status));
    if (a.storyboardId) q.set("storyboardId", String(a.storyboardId));
    const r = await call("GET", `/api/tasks?${q.toString()}`);
    console.log(table(r.items || [], [
      { key: "id", label: "任务" },
      { key: "status", label: "状态" },
      { key: "instanceId", label: "实例" },
      { key: "createdAt", label: "创建" },
      { key: "error", label: "错误" }
    ]));
    return;
  }
  if (cmd === "resources") {
    const q = new URLSearchParams();
    if (a.kind) q.set("kind", String(a.kind));
    if (a.unwatermarked) q.set("unwatermarked", "1");
    const r = await call("GET", `/api/resources?${q.toString()}`);
    for (const it of r.items || []) console.log(`${it.id}  ${it.kind.padEnd(6)} ${it.unwatermarked ? "无水印" : "      "}  ${String(it.url).slice(0, 110)}`);
    return;
  }
  if (cmd === "download") {
    const id = a._[1];
    if (!id) throw new Error("用法：cli.js download <resourceId>");
    console.log(JSON.stringify(await call("POST", "/api/resources/download", { id, instanceId: a.instance }), null, 2));
    return;
  }
  if (cmd === "check") {
    const text = a._.slice(1).join(" ");
    console.log(JSON.stringify(await call("POST", "/api/prompt/check", { text }), null, 2));
    return;
  }
  if (cmd === "mcp") {
    if (a._[1] === "tools") {
      const r = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      for (const t of (r.result && r.result.tools) || []) console.log(`${t.name.padEnd(22)} ${t.description}`);
      return;
    }
    console.log(JSON.stringify(await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), null, 2));
    return;
  }

  console.error(`没有这个命令：${cmd}（试试 help）`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  if (error.status === 401) console.error(`token 不对或应用没启动。token 文件：${path.join(home(), "api-token.txt")}`);
  process.exitCode = 1;
});
