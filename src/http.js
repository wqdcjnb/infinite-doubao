"use strict";

/**
 * 本地接口服务（对标：17823 端口那个 REST + MCP 服务）
 *
 * 对标产品的问题：端口对本机全开、无鉴权，任何本机程序（甚至局域网内做了端口转发的进程）
 * 都能直接把它的接口当自己的用，读账号、派任务、导素材。
 *
 * 这里的原则：
 *   1) 只监听 127.0.0.1，不监听 0.0.0.0；
 *   2) 必须带 Bearer token（首次启动生成，写进 APP_HOME/api-token.txt，界面可见可轮换）；
 *   3) 默认不发 CORS 头，浏览器里的任意网页调不动；
 *   4) 简单限流 + 请求体大小上限，防止本机脚本把它当免费算力打满。
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const P = require("./paths");
const log = require("./logger");
const store = require("./store");

const MAX_BODY = 8 * 1024 * 1024;

function tokenFile() {
  return path.join(P.home(), "api-token.txt");
}

function ensureToken(force) {
  const file = tokenFile();
  if (!force) {
    try {
      const t = fs.readFileSync(file, "utf8").trim();
      if (t.length >= 16) return t;
    } catch {}
  }
  const token = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, "utf8");
  return token;
}

class HttpServer {
  constructor(opts = {}) {
    this.port = Number(opts.port) || 17823;
    this.host = String(opts.host || "127.0.0.1");
    this.token = "";
    this.routes = [];
    this.server = null;
    this.hits = new Map();
    this.cors = opts.cors === true;
    this.startedAt = 0;
    this.setToken(opts.token || "");
  }

  route(method, pattern, handler) {
    const keys = [];
    const re = new RegExp("^" + String(pattern).replace(/:[A-Za-z0-9_]+/g, (m) => {
      keys.push(m.slice(1));
      return "([^/]+)";
    }).replace(/\*/g, ".*") + "$");
    this.routes.push({ method: String(method).toUpperCase(), re, keys, handler });
    return this;
  }

  get(p, h) { return this.route("GET", p, h); }
  post(p, h) { return this.route("POST", p, h); }
  patch(p, h) { return this.route("PATCH", p, h); }
  del(p, h) { return this.route("DELETE", p, h); }

  allow(ip) {
    const now = Date.now();
    const box = this.hits.get(ip) || { at: 0, n: 0 };
    if (now - box.at > 10000) { box.at = now; box.n = 0; }
    box.n += 1;
    this.hits.set(ip, box);
    return box.n <= 600;
  }

  auth(req, url) {
    const header = String(req.headers.authorization || "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const q = url.searchParams.get("token") || "";
    return bearer === this.token || q === this.token;
  }

  async readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error("请求体过大");
      chunks.push(chunk);
    }
    if (!size) return null;
    const text = Buffer.concat(chunks).toString("utf8");
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  makeCtx(req, res, url, body) {
    const ctx = {
      req,
      res,
      url,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      params: {},
      state: {},
      json(status, data) {
        const payload = JSON.stringify(data === undefined ? null : data);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
      },
      ok(data) { this.json(200, data === undefined ? { ok: true } : data); },
      fail(status, message, extra) { this.json(status, { ok: false, error: String(message || "error"), ...(extra || {}) }); }
    };
    return ctx;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const ip = req.socket.remoteAddress || "local";
    if (!this.allow(ip)) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "请求过于频繁" }));
      return;
    }
    if (this.cors) {
      res.setHeader("access-control-allow-origin", `http://${this.host}:${this.port}`);
      res.setHeader("access-control-allow-headers", "authorization,content-type");
      res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const openPaths = new Set(["/api/health"]);
    if (!openPaths.has(url.pathname) && !this.auth(req, url)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ ok: false, error: "需要 Bearer token（见 APP_HOME/api-token.txt）" }));
      return;
    }

    let body = null;
    try { body = await this.readBody(req); } catch (error) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(error && error.message) }));
      return;
    }

    const ctx = this.makeCtx(req, res, url, body);
    if (url.pathname === "/api/health") {
      ctx.ok({ ok: true, app: "infinite-doubao", uptime: process.uptime(), startedAt: this.startedAt, version: require("./brand").version });
      return;
    }

    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      try {
        await r.handler(ctx);
        if (!res.writableEnded) ctx.json(200, { ok: true });
      } catch (error) {
        const msg = String((error && error.message) || error);
        log.warn("api-error", { path: url.pathname, message: msg });
        if (!res.writableEnded) ctx.fail(500, msg);
      }
      return;
    }
    ctx.fail(404, `没有这个接口：${req.method} ${url.pathname}`);
  }

  start() {
    if (this.server) return Promise.resolve(this.info());
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => { this.handle(req, res); });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.startedAt = Date.now();
        log.info("http-listen", { host: this.host, port: this.port });
        resolve(this.info());
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => { this.server = null; resolve(); });
    });
  }

  info() {
    return {
      running: !!this.server,
      host: this.host,
      port: this.port,
      url: `http://${this.host}:${this.port}`,
      tokenFile: tokenFile(),
      token: this.token,
      tokenHint: this.token.slice(0, 4) + "…" + this.token.slice(-4),
      startedAt: this.startedAt
    };
  }

  setToken(value) {
    const token = String(value || "").trim() || ensureToken(false);
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), token, "utf8");
    this.token = token;
    return this.info();
  }

  rotateToken() {
    const settings = store.get().settings;
    const previous = settings.server.token;
    settings.server.token = "";
    if (!store.save()) {
      settings.server.token = previous;
      throw new Error("无法保存 token 轮换设置");
    }
    this.token = ensureToken(true);
    return this.info();
  }
}

module.exports = { HttpServer, ensureToken, tokenFile, MAX_BODY };
