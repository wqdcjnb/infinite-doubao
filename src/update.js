"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const P = require("./paths");

const DEFAULT_MANIFEST = "http://10.1.11.88:17824/latest.json";
const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, "update-public-key.pem"), "utf8");
const VERSION = /^\d+\.\d+\.\d+$/;

function verifyManifest(manifest, publicKey = PUBLIC_KEY) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return { ok: false, reason: "版本信息为空" };
  const { sig, ...rest } = manifest;
  try {
    if (!sig || !crypto.verify(null, Buffer.from(JSON.stringify(rest)), publicKey, Buffer.from(sig, "base64"))) {
      return { ok: false, reason: "版本信息签名不匹配，已拒绝更新" };
    }
  } catch { return { ok: false, reason: "版本信息签名无效，已拒绝更新" }; }
  return { ok: true, manifest: rest };
}

function cmpVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function manifestName(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "latest.json";
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) return `latest-darwin-${arch}.json`;
  throw new Error("当前系统暂不支持应用内更新");
}

function sourceUrl(platform = process.platform, arch = process.arch) {
  const saved = String((require("./store").get().settings || {}).updateUrl || "").trim();
  const url = new URL(process.env.DOLAMOD_UPDATE_URL || (saved && !saved.includes("example.invalid") ? saved : DEFAULT_MANIFEST));
  // 兼容既有 Windows 更新地址；自定义平台清单保持原样。
  if (url.pathname.endsWith("/latest.json")) url.pathname = url.pathname.slice(0, -11) + manifestName(platform, arch);
  return url.href;
}

function httpUrl(value, base) {
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("更新地址必须为 HTTP 或 HTTPS 地址");
  return url.href;
}

function errorMessage(error) {
  if (["TimeoutError", "AbortError"].includes(error?.name)) return "更新服务器响应超时，请检查网络连接后重试";
  if (error?.message === "fetch failed") return "无法连接更新服务器，请检查网络或稍后重试";
  return String(error?.message || error);
}

async function check(opts = {}) {
  const current = opts.currentVersion || require("../package.json").version;
  const platform = opts.platform || process.platform, arch = opts.arch || process.arch;
  const source = opts.url || sourceUrl(platform, arch);
  try {
    manifestName(platform, arch);
    const res = await fetch(httpUrl(source), { signal: AbortSignal.timeout(opts.timeoutMs || 15000), headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`读取版本信息失败（HTTP ${res.status}）`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > 256 * 1024) throw new Error("版本信息过大，已拒绝更新");
      chunks.push(chunk);
    }
    const verified = verifyManifest(JSON.parse(Buffer.concat(chunks).toString("utf8")), opts.publicKey);
    if (!verified.ok) throw new Error(verified.reason);
    const m = verified.manifest;
    if (!VERSION.test(m.version) || m.platform !== platform || m.arch !== arch) throw new Error(`版本信息不适用于 ${platform} ${arch}`);
    const file = m.file || {};
    if (!/^[a-f0-9]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("安装包缺少有效的大小或校验信息");
    const fileUrl = httpUrl(file.url, source);
    const extension = platform === "darwin" ? ".dmg" : ".exe";
    if (!new URL(fileUrl).pathname.toLowerCase().endsWith(extension)) throw new Error("更新文件格式不适用于当前系统");
    return { ok: true, current, source, platform, arch, latest: m.version, hasUpdate: cmpVersion(m.version, current) > 0,
      notes: String(m.notes || ""), publishedAt: String(m.publishedAt || ""), file: { url: fileUrl, sha256: file.sha256.toLowerCase(), size: file.size } };
  } catch (error) { return { ok: false, current, source, reason: errorMessage(error) }; }
}

async function verifyFile(file, expected) {
  if (fs.statSync(file).size !== expected.size) throw new Error("安装包大小不符，请重新下载");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== expected.sha256) throw new Error("安装包校验失败，请重新下载");
}

// 下载和安装只使用主进程检查过的清单；渲染进程不能指定 URL、哈希或执行路径。
function createUpdater(opts = {}) {
  const events = new EventEmitter();
  const platform = opts.platform || process.platform, arch = opts.arch || process.arch;
  let state = { phase: "idle", current: opts.currentVersion || require("../package.json").version };
  let checked = null;
  let downloaded = null;
  let busy = false;
  const status = () => ({ ...state, platform, source: state.source || opts.url || sourceUrl(platform, arch) });
  const set = (patch) => { state = { ...state, ...patch }; events.emit("change", status()); return status(); };
  const fail = (error) => set({ phase: "error", reason: errorMessage(error) });

  return {
    events, status,
    async check() {
      if (busy) return status();
      busy = true;
      checked = null; downloaded = null;
      state = { phase: "checking", current: state.current, source: opts.url || sourceUrl(platform, arch) };
      set({});
      try {
        const info = await check({ ...opts, url: state.source });
        if (!info.ok) return fail(new Error(info.reason));
        checked = info;
        return set({ phase: info.hasUpdate ? "available" : "current", latest: info.latest, notes: info.notes, publishedAt: info.publishedAt, total: info.file.size, received: 0 });
      } finally { busy = false; }
    },
    async download() {
      if (busy) return status();
      if (!checked?.hasUpdate) return fail(new Error("请先检查是否有新版本"));
      busy = true; downloaded = null;
      const dir = opts.downloadDir || P.dir("updates");
      const filename = platform === "darwin" ? `DoubaoWorkshop-${checked.latest}-mac-${arch}.dmg` : `DoubaoWorkshop-${checked.latest}-Setup.exe`;
      const target = path.join(dir, filename);
      const part = target + ".part";
      set({ phase: "downloading", received: 0, total: checked.file.size, reason: "" });
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(target)) {
          try { await verifyFile(target, checked.file); downloaded = target; return set({ phase: "ready", received: checked.file.size }); }
          catch { fs.unlinkSync(target); }
        }
        const res = await fetch(checked.file.url, { signal: AbortSignal.timeout(opts.downloadTimeoutMs || 30 * 60 * 1000) });
        if (!res.ok || !res.body) throw new Error(`下载安装包失败（HTTP ${res.status}）`);
        let received = 0;
        let lastProgress = 0;
        const meter = new Transform({ transform(chunk, _encoding, cb) {
          received += chunk.length;
          if (received > checked.file.size) return cb(new Error("安装包体积超出版本信息，已拒绝更新"));
          if (Date.now() - lastProgress > 150 || received === checked.file.size) {
            lastProgress = Date.now(); set({ received });
          }
          cb(null, chunk);
        } });
        await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part));
        await verifyFile(part, checked.file);
        fs.renameSync(part, target);
        downloaded = target;
        return set({ phase: "ready", received: checked.file.size });
      } catch (error) { return fail(error); }
      finally { fs.rmSync(part, { force: true }); busy = false; }
    },
    async install(launch) {
      if (busy) return status();
      if (!downloaded || !checked?.hasUpdate || state.phase !== "ready") throw new Error("请先下载并校验安装包");
      busy = true;
      set({ phase: "installing", reason: "" });
      try {
        await verifyFile(downloaded, checked.file);
        await launch(downloaded);
        return status();
      } catch (error) { downloaded = null; return fail(error); }
      finally { busy = false; }
    }
  };
}

module.exports = { DEFAULT_MANIFEST, manifestName, sourceUrl, check, createUpdater, verifyManifest, cmpVersion, verifyFile };
