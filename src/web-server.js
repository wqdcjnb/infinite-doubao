"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4" };
const MEDIA = new Set(Object.keys(TYPES).filter((ext) => ![".html", ".js", ".css"].includes(ext)));
const COOKIE = "doubao_web";
const SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD = 512 * 1024 * 1024;

function equal(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function json(res, status, data) {
  res.writeHead(status, { "content-type": TYPES[".html"].replace("text/html", "application/json") });
  res.end(JSON.stringify(data));
}
async function body(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

class WebServer {
  constructor(opts) {
    this.opts = opts;
    this.port = opts.port ?? 17825;
    this.sessions = new Map();
    this.tickets = new Map();
    this.clients = new Set();
    this.files = new Map();
    this.fileIds = new Map();
    this.attempts = new Map();
    const tokenFile = path.join(opts.home, "web-access.txt");
    try { this.token = fs.readFileSync(tokenFile, "utf8").trim(); } catch {}
    if (!this.token || this.token.length < 24) {
      this.token = crypto.randomBytes(32).toString("base64url");
      fs.mkdirSync(opts.home, { recursive: true });
      fs.writeFileSync(tokenFile, this.token, { mode: 0o600 });
    }
  }
  url() { return `http://127.0.0.1:${this.port}/`; }
  openUrl() {
    const now = Date.now();
    for (const [key, expires] of this.tickets) if (expires <= now) this.tickets.delete(key);
    const ticket = crypto.randomBytes(32).toString("base64url");
    this.tickets.set(ticket, now + 60000);
    return this.url() + "#ticket=" + ticket;
  }
  session(req) {
    const id = String(req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
    const expires = this.sessions.get(id);
    if (!expires || expires <= Date.now()) { this.sessions.delete(id); return null; }
    this.sessions.set(id, Date.now() + SESSION_MS);
    return id;
  }
  publish(channel, payload) {
    const text = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const client of this.clients) {
      if (!this.sessions.has(client.session) || this.sessions.get(client.session) < Date.now() || client.res.writableLength > 1024 * 1024) {
        client.res.end(); this.clients.delete(client);
      } else client.res.write(text);
    }
  }
  grantFile(file) {
    if (typeof file !== "string" || !path.isAbsolute(file) || !MEDIA.has(path.extname(file).toLowerCase())) return null;
    try {
      const real = fs.realpathSync(file);
      if (!fs.statSync(real).isFile()) return null;
      let id = this.fileIds.get(real);
      if (!id) { id = crypto.randomBytes(24).toString("base64url"); this.fileIds.set(real, id); this.files.set(id, real); }
      return `/web/file/${id}`;
    } catch { return null; }
  }
  grantResult(value) {
    if (typeof value === "string") { this.grantFile(value); return; }
    if (Array.isArray(value)) { for (const item of value) this.grantResult(item); return; }
    if (value && typeof value === "object") for (const item of Object.values(value)) this.grantResult(item);
  }
  fileUrl(file) {
    try { const id = this.fileIds.get(fs.realpathSync(file)); return id ? `/web/file/${id}` : null; }
    catch { return null; }
  }
  async serveFile(req, res, file, download) {
    const stat = await fs.promises.stat(file);
    let start = 0, end = stat.size - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { "content-range": `bytes */${stat.size}` }); return res.end(); }
      if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
        res.writeHead(416, { "content-range": `bytes */${stat.size}` }); return res.end();
      }
    }
    const headers = { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "accept-ranges": "bytes", "content-length": Math.max(0, end - start + 1) };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
    if (download) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === "HEAD" || !stat.size) return res.end();
    await pipeline(fs.createReadStream(file, { start, end }), res);
  }
  async handle(req, res) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    const host = req.headers.host;
    if (![ `127.0.0.1:${this.port}`, `localhost:${this.port}` ].includes(host)) return json(res, 403, { error: "仅允许本机地址" });
    const origin = `http://${host}`;
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "来源不匹配" });
    if (req.headers["sec-fetch-site"] === "cross-site") return json(res, 403, { error: "不允许跨站请求" });
    const url = new URL(req.url, origin);
    if (req.method === "GET" && (url.pathname === "/" || /^\/[a-z][a-z0-9-]*\.(js|css)$/.test(url.pathname))) {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.join(this.opts.renderer, name);
      if (!fs.existsSync(file)) return json(res, 404, { error: "页面不存在" });
      res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader("content-type", TYPES[path.extname(file)]);
      return res.end(await fs.promises.readFile(file));
    }
    if (req.method === "POST" && url.pathname === "/web/login") {
      if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "需要 JSON 请求" });
      const ip = req.socket.remoteAddress, now = Date.now();
      let attempt = this.attempts.get(ip);
      if (!attempt || now - attempt.at > 60000) { attempt = { at: now, count: 0 }; this.attempts.set(ip, attempt); }
      if (++attempt.count > 20) return json(res, 429, { error: "尝试过于频繁，请稍后重试" });
      const input = await body(req, 4096);
      const ticket = input.ticket && this.tickets.get(input.ticket);
      const valid = ticket && ticket > now;
      if (input.ticket) this.tickets.delete(input.ticket);
      if (!valid && !equal(input.token, this.token)) return json(res, 401, { error: "访问码无效，请从桌面端重新打开网页版" });
      for (const [key, expires] of this.sessions) if (expires < now) this.sessions.delete(key);
      const id = crypto.randomBytes(32).toString("base64url");
      this.sessions.set(id, now + SESSION_MS);
      res.setHeader("set-cookie", `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
      return json(res, 200, { ok: true });
    }
    const sessionId = this.session(req);
    if (!sessionId) return json(res, 401, { error: "请从桌面端打开网页版，或输入本机访问码" });
    if (req.method === "GET" && url.pathname === "/web/session") return json(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/web/logout") {
      this.sessions.delete(sessionId);
      for (const client of this.clients) if (client.session === sessionId) { client.res.end(); this.clients.delete(client); }
      res.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/web/events") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      res.write(": connected\n\n");
      const client = { res, session: sessionId }; this.clients.add(client);
      const timer = setInterval(() => {
        if ((this.sessions.get(sessionId) || 0) < Date.now()) res.end();
        else res.write(": keepalive\n\n");
      }, 15000);
      res.on("close", () => { clearInterval(timer); this.clients.delete(client); });
      return;
    }
    if (req.method === "POST" && url.pathname === "/web/upload") {
      const name = path.basename(url.searchParams.get("name") || "");
      if (!MEDIA.has(path.extname(name).toLowerCase())) return json(res, 415, { error: "请选择图片、视频或音频素材" });
      if (Number(req.headers["content-length"]) > MAX_UPLOAD) return json(res, 413, { error: "单个素材不能超过 512 MB" });
      const folder = path.join(this.opts.home, "assets", "web-uploads", crypto.randomUUID());
      await fs.promises.mkdir(folder, { recursive: true });
      const safeName = path.basename(name, path.extname(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100).replace(/[. ]+$/, "") || "素材";
      const file = path.join(folder, safeName + path.extname(name).toLowerCase());
      let size = 0;
      try {
        const limit = new Transform({ transform(chunk, _encoding, cb) { size += chunk.length; cb(size > MAX_UPLOAD ? new Error("单个素材不能超过 512 MB") : null, chunk); } });
        await pipeline(req, limit, fs.createWriteStream(file, { flags: "wx" }));
        this.grantFile(file);
        return json(res, 200, { path: file, name, size });
      } catch (error) { await fs.promises.rm(file, { force: true }); throw error; }
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/web/file/")) {
      const file = this.files.get(url.pathname.slice("/web/file/".length));
      if (!file) return json(res, 404, { error: "素材不存在或尚未授权" });
      return this.serveFile(req, res, file, url.searchParams.has("download"));
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/web/media") {
      const fileUrl = this.fileUrl(url.searchParams.get("path") || "");
      if (!fileUrl) return json(res, 403, { error: "请先在任务或素材列表中选择此文件" });
      return this.serveFile(req, res, this.files.get(fileUrl.slice("/web/file/".length)), url.searchParams.has("download"));
    }
    if (req.method === "POST" && url.pathname === "/web/file-url") {
      const { file } = await body(req, 16384);
      const result = this.fileUrl(file);
      return json(res, result ? 200 : 403, result ? { url: result } : { error: "请先在素材或任务列表中选择此文件" });
    }
    if (req.method === "POST" && url.pathname === "/web/rpc") {
      if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "需要 JSON 请求" });
      const { channel, args } = await body(req);
      if (typeof channel !== "string" || !Array.isArray(args) || args.length > 16) return json(res, 400, { error: "无效请求" });
      const result = await this.opts.invoke(channel, args, { sender: { send: (name, payload) => this.publish(name, payload) } });
      this.grantResult(result);
      return json(res, 200, { result });
    }
    if (url.pathname.startsWith("/web/account/")) {
      return this.opts.accounts.handle(req, res, url, { json, body, grantFile: (file) => this.grantFile(file), hasFile: (file) => !!this.fileUrl(file) });
    }
    return json(res, 404, { error: "接口不存在" });
  }
  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.destroy();
    }));
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.port, "127.0.0.1", resolve); });
    this.port = this.server.address().port;
    return this.url();
  }
  async stop() {
    for (const client of this.clients) client.res.end();
    this.clients.clear(); this.sessions.clear(); this.tickets.clear();
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server ? this.server.close(resolve) : resolve());
  }
}

module.exports = { WebServer, MEDIA, MAX_UPLOAD };
