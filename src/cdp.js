"use strict";

/**
 * 极简 CDP 客户端（DevTools Protocol over WebSocket）
 *
 * 为什么自己写：外挂内核（真实 Chrome/Edge）是报告里最关键的一块能力，
 * 而 Electron 自带的 webContents.debugger 只能挂在自己的 webContents 上，
 * 挂不了外部浏览器进程。Node 22 起有全局 WebSocket，不需要 ws 依赖。
 *
 * 支持 flatten 模式的多会话：发消息带 sessionId，事件里也带 sessionId。
 */

const log = require("./logger");

const DEFAULT_TIMEOUT = 20000;

class CDP {
  constructor(wsUrl, opts) {
    this.wsUrl = wsUrl;
    this.name = String((opts && opts.name) || "cdp");
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.timeout = Number((opts && opts.timeout) || DEFAULT_TIMEOUT);
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (error) {
        reject(error);
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error("CDP 连接超时"));
      }, this.timeout);

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener("message", (ev) => {
        let msg = null;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer: t } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(t);
          if (msg.error) rej(new Error(`${msg.error.message || "CDP error"} (${msg.error.code || "?"})`));
          else res(msg.result);
          return;
        }
        if (msg.method) this.emit(msg.method, msg.params || {}, msg.sessionId || "");
      });
      ws.addEventListener("close", () => {
        this.closed = true;
        clearTimeout(timer);
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("CDP 连接已关闭"));
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(new Error("CDP 连接被拒绝（端口未开放或已关闭）"));
        }
      });
      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("CDP 连接出错"));
      });
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method).delete(fn);
  }

  emit(method, params, sessionId) {
    const set = this.handlers.get(method);
    if (!set) return;
    for (const fn of set) {
      try { fn(params, sessionId); } catch (error) {
        log.warn("cdp-handler-error", { method, message: String(error && error.message) });
      }
    }
  }

  send(method, params = {}, sessionId = "", timeout = this.timeout) {
    if (!this.ws || this.closed) return Promise.reject(new Error("CDP 未连接"));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.closed = true;
    try { this.ws && this.ws.close(); } catch {}
  }
}

/** 拿浏览器的 ws 调试地址（http://127.0.0.1:port/json/version） */
async function fetchVersion(port, timeout = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTargets(port, timeout = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** 轮询等浏览器把调试端口开起来 */
async function waitForPort(port, totalMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < totalMs) {
    const v = await fetchVersion(port);
    if (v && v.webSocketDebuggerUrl) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

module.exports = { CDP, fetchVersion, fetchTargets, waitForPort };
