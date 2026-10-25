"use strict";

/**
 * 取源拦截（对标：ResourceInterceptor）
 *
 * 三路合一：
 *   1) webRequest 层看 URL（改动最小，抓不到 JSON 里的地址）
 *   2) 对配置/列表类 JSON 响应做深度扫描，把里面藏的媒资地址捞出来（对标产品只做 1 路）
 *   3) 去水印改写：lr=watermark → lr=unwatermarked，同一个视频两版只留无水印那版
 *
 * 下载走分区会话（自带登录态），落盘前验文件头，HTML 错误页/防盗链页直接判失败，
 * 不会出现「下了一堆 200KB 的 mp4 结果全是网页」。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const P = require("./paths");
const log = require("./logger");
const store = require("./store");
const brand = require("./brand");

const MAX_ITEMS = 800;
const MEDIA_RE = /\.(mp4|webm|mov|m4v|m3u8|mp3|m4a|wav|flac)(\?|#|$)/i;
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i;
const JSON_URL_RE = /(skill|pack|item|feed|list|detail|generation|video|image|resource|asset|history|conversation)/i;
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'\\<>()]+/g;

const events = new EventEmitter();
const items = [];
const seen = new Map(); // key -> item
const attached = new Set();
let loadedHome = "";
let saveTimer = null;

function itemKey(url, instanceId) {
  return `${String(instanceId || "")}\n${normalizeKey(url)}`;
}

function saveResources() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!loadedHome) return;
  const file = path.join(loadedHome, "assets", "resources.json");
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2));
  fs.renameSync(tmp, file);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try { saveResources(); } catch (error) { log.warn("resources-save-failed", { message: error.message }); }
  }, 250);
  saveTimer.unref();
}

function trimTransient() {
  let excess = items.filter((item) => !item.taskId && !item.downloaded).length - MAX_ITEMS;
  for (let i = 0; i < items.length && excess > 0;) {
    const item = items[i];
    if (item.taskId || item.downloaded) { i += 1; continue; }
    items.splice(i, 1);
    seen.delete(itemKey(item.url, item.instanceId));
    excess -= 1;
  }
}

function ensureLoaded() {
  const home = P.home();
  if (loadedHome === home) return;
  if (saveTimer) saveResources();
  loadedHome = home;
  items.length = 0;
  seen.clear();
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(path.join(home, "assets", "resources.json"), "utf8")).items || []; }
  catch (error) { if (error.code !== "ENOENT") log.warn("resources-load-failed", { message: error.message }); }
  for (const item of Array.isArray(saved) ? saved : []) {
    if (!item || !item.url || !item.id) continue;
    // A saved fallback can never retain an optimistic no-watermark badge.
    if (item.downloaded) item.unwatermarked = item.watermark === "none";
    items.push(item);
    seen.set(itemKey(item.url, item.instanceId), item);
  }
  trimTransient();
}

function annotate(idOrItem, patch = {}) {
  ensureLoaded();
  const item = typeof idOrItem === "string" ? get(idOrItem) : idOrItem;
  if (!item) return null;
  for (const key of ["taskId", "templateName", "messageId", "status", "error"]) {
    if (patch[key] !== undefined) item[key] = patch[key];
  }
  saveResources();
  events.emit("update", item);
  return item;
}

function kindOf(url, contentType) {
  const u = String(url || "");
  const ct = String(contentType || "");
  if (/m3u8/i.test(u) || /mpegurl/i.test(ct)) return "hls";
  if (MEDIA_RE.test(u) || /^(video|audio)\//i.test(ct)) return /audio|\.(mp3|m4a|wav|flac)/i.test(u + ct) ? "audio" : "video";
  if (IMG_RE.test(u) || /^image\//i.test(ct)) return "image";
  return "other";
}

/**
 * 去水印改写：只换水印参数的取值，其它签名参数一律原样保留（不能重新序列化，会动到签名）。
 *   lr=watermark / lv=watermark   → unwatermarked（豆包、即梦系原片参数）
 *   watermark=1 / wm=true / with_watermark=1 → 0（布尔开关型）
 */
function preferUnwatermarked(url) {
  let u = String(url || "");
  if (!u) return u;
  if (/([?&](?:lr|lv)=)watermark\b/i.test(u)) u = u.replace(/([?&](?:lr|lv)=)watermark\b/gi, "$1unwatermarked");
  if (/([?&](?:watermark|wm|with_watermark|is_watermark|need_watermark)=)(?:1|true|yes|on)\b/i.test(u)) {
    // 用回调替换：$10 会被当成第 10 个分组
    u = u.replace(/([?&](?:watermark|wm|with_watermark|is_watermark|need_watermark)=)(?:1|true|yes|on)\b/gi, (_m, key) => `${key}0`);
  }
  return u;
}

/** 这个地址是不是已经指向无水印版 */
function isUnwatermarked(url) {
  const s = String(url || "");
  if (/([?&](?:lr|lv)=)unwatermarked\b/i.test(s)) return true;
  if (/([?&](?:watermark|wm|with_watermark|is_watermark|need_watermark)=)(?:0|false|no|off)\b/i.test(s)) return true;
  if (/no[_-]?watermark|without[_-]?watermark/i.test(s)) return true;
  return false;
}

function watermarkState(url) {
  if (isUnwatermarked(url)) return "none";
  if (/[?&](?:lr|lv)=watermark\b|[?&](?:watermark|wm|with_watermark|is_watermark|need_watermark)=(?:1|true|yes|on)\b/i.test(String(url || ""))) return "kept";
  return "unknown";
}

function normalizeKey(url) {
  try {
    const u = new URL(url);
    // Preserve resource IDs carried in the query while ignoring variant/signature fields.
    for (const key of [...u.searchParams.keys()]) {
      if (/^(lr|lv|lr_source|watermark|wm|with_watermark|is_watermark|need_watermark|signature|sign|x-signature|x-expires|expires|expire|token|auth_key)$/i.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return String(url || "").split("?")[0];
  }
}

function mediaIdOf(url) {
  const m = /(v[0-9a-z]{8,}|\/[0-9a-f]{16,}\.)/i.exec(String(url || ""));
  return m ? m[1] : "";
}

class Collector {
  constructor(inst) {
    this.instanceId = inst.id;
    this.instanceName = inst.name;
    this.platform = inst.platform;
  }
}

function push(entry) {
  ensureLoaded();
  const rawUrl = String(entry.rawUrl || entry.url || "");
  // 所有进来的地址都在这里统一改写：调用方（API 直传、页面按钮、编排器）不用各自记得改写
  const clean = preferUnwatermarked(entry.url || rawUrl);
  // 空地址不入库：以前会留下一条 url="" 的僵尸卡，点下载还会报「没有可下载的地址」
  if (!clean) return null;
  const key = itemKey(clean, entry.instanceId);
  const prev = seen.get(key);
  if (prev) {
    // Preserve the downloaded file's state, but refresh signed source URLs for retries.
    const changed = clean !== prev.url || rawUrl !== prev.rawUrl;
    if (isUnwatermarked(clean) || !isUnwatermarked(prev.url)) {
      prev.url = clean;
      if (!prev.downloaded) prev.unwatermarked = isUnwatermarked(clean);
      if (isUnwatermarked(clean)) prev.unwatermarkedUrl = clean;
    }
    prev.rawUrl = rawUrl;
    if (!isUnwatermarked(rawUrl)) prev.watermarkedUrl = rawUrl;
    prev.hits += 1;
    prev.seenAt = Date.now();
    if (changed) events.emit("update", prev);
    scheduleSave();
    return prev;
  }
  const item = {
    id: crypto.createHash("sha1").update(key).digest("hex").slice(0, 12),
    url: clean,
    rawUrl,
    // 改写生效时记下两版：下载先走无水印，失败再回退带水印那版，保证永远拿得到文件
    watermarkedUrl: clean !== rawUrl ? rawUrl : "",
    unwatermarkedUrl: clean !== rawUrl ? clean : "",
    kind: entry.kind || kindOf(clean, entry.contentType),
    contentType: entry.contentType || "",
    instanceId: entry.instanceId || "",
    instanceName: entry.instanceName || "",
    from: entry.from || "url",
    unwatermarked: isUnwatermarked(clean),
    size: Number(entry.size) || 0,
    hits: 1,
    createdAt: Date.now(),
    seenAt: Date.now(),
    downloaded: "",
    status: "new"
  };
  items.push(item);
  seen.set(key, item);
  trimTransient();
  events.emit("add", item);
  scheduleSave();
  return item;
}

function harvestText(text, ctx) {
  if (!text || text.length > 8 * 1024 * 1024) return 0;
  const hits = String(text).match(URL_IN_TEXT_RE);
  if (!hits || !hits.length) return 0;
  let n = 0;
  for (const raw of hits) {
    const url = raw.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
    if (!MEDIA_RE.test(url) && !IMG_RE.test(url)) continue;
    push({
      url: preferUnwatermarked(url),
      rawUrl: url,
      kind: kindOf(url),
      instanceId: ctx.instanceId,
      instanceName: ctx.instanceName,
      from: "json"
    });
    n += 1;
  }
  return n;
}

/** 挂到某个分区会话上（每个实例一次） */
function attach(ses, inst) {
  const key = inst.partition;
  if (attached.has(key)) return;
  attached.add(key);

  const ctx = { instanceId: inst.id, instanceName: inst.name };

  try {
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url || "";
      if (/^(devtools|chrome-extension|blob|data):/i.test(url)) return callback({});
      const kind = kindOf(url);
      if (kind !== "other" || /lv=unwatermarked|lr=unwatermarked/i.test(url)) {
        push({
          url: preferUnwatermarked(url),
          rawUrl: url,
          kind: kind === "other" ? "video" : kind,
          instanceId: ctx.instanceId,
          instanceName: ctx.instanceName,
          from: "request"
        });
      }
      callback({});
    });
  } catch (error) {
    log.warn("interceptor-request-hook-failed", { message: String(error && error.message) });
  }

  try {
    ses.webRequest.onCompleted({ urls: ["*://*/*"] }, (details) => {
      const ct = "";
      const kind = kindOf(details.url, ct);
      if (kind === "other") return;
      const target = push({
        url: preferUnwatermarked(details.url),
        rawUrl: details.url,
        kind,
        instanceId: ctx.instanceId,
        instanceName: ctx.instanceName,
        from: "request"
      });
      if (target) events.emit("update", target);
    });
  } catch {}

  void Collector;
  void JSON_URL_RE;
  void mediaIdOf;
  void harvestText;
  void ses;
  return { ok: true };
}

/** 主动扫一段响应体（页面侧嗅探/接口调用都能复用） */
function scanText(text, ctx) {
  return harvestText(text, ctx || {});
}

/** 抓一次 JSON 接口并深度捞地址（编排器/探针可以显式触发） */
async function scanUrl(ses, url, ctx) {
  try {
    const res = await ses.fetch(String(url), { headers: { accept: "application/json,*/*" } });
    const ct = String(res.headers.get("content-type") || "");
    if (!/json|text/i.test(ct)) return 0;
    const text = await res.text();
    return harvestText(text, ctx || {});
  } catch (error) {
    log.warn("interceptor-scan-failed", { url: String(url).slice(0, 120), message: String(error && error.message) });
    return 0;
  }
}

/* ------------------------------------------------------------- 落盘 */

function pad(n) {
  return String(n).padStart(2, "0");
}

function stampName(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeName(s, fallback = "asset") {
  const t = String(s || "").replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 60);
  return t || fallback;
}

/**
 * 命名五种模式（对标产品只给固定几种）：
 *   timestamp 豆包工坊_20260101-120000.mp4
 *   index     豆包工坊_0007.mp4
 *   prompt    提示词前 40 字
 *   account   实例名_时间
 *   custom    模板 {account}{date}{time}{index}{prompt}
 */
function buildFileName(item, opts = {}) {
  const settings = store.get().settings || {};
  const mode = String(opts.naming || settings.naming || "timestamp");
  const ext = (() => {
    const m = MEDIA_RE.exec(item.url || "");
    return m ? "." + m[1].toLowerCase() : item.kind === "image" ? ".png" : ".mp4";
  })();
  const d = new Date();
  const account = safeName(item.instanceName || "instance");
  const prompt = safeName(opts.prompt || "", "prompt");
  const index = String(opts.index || 0).padStart(4, "0");
  let base = "";
  if (mode === "index") base = `${account}_${index}`;
  else if (mode === "prompt") base = prompt.slice(0, 40);
  else if (mode === "account") base = `${account}_${stampName(d)}`;
  else if (mode === "custom") {
    base = String(settings.namingTemplate || "{account}_{date}_{index}")
      .replace(/\{account\}/g, account)
      .replace(/\{date\}/g, stampName(d).slice(0, 8))
      .replace(/\{time\}/g, stampName(d).slice(9))
      .replace(/\{index\}/g, index)
      .replace(/\{prompt\}/g, prompt.slice(0, 40));
  } else base = `${brand.name}_${stampName(d)}`;
  return `${safeName(base, "asset")}${ext}`;
}

function looksLikeMedia(buf, kind) {
  if (!buf || buf.length < 12) return false;
  const head = buf.slice(0, 12).toString("latin1");
  if (head.indexOf("ftyp") >= 0) return true; // mp4/mov/m4a
  if (head.charCodeAt(0) === 0x1a && head.charCodeAt(1) === 0x45) return true; // webm/mkv
  if (head.startsWith("ID3") || head.charCodeAt(0) === 0xff) return kind === "audio";
  if (head.startsWith("\x89PNG") || head.startsWith("\xff\xd8\xff")) return kind === "image";
  if (head.startsWith("RIFF")) return true;
  return false;
}

function validDownloadedFile(item) {
  if (!item.downloaded) return false;
  let fd;
  try {
    const stat = fs.statSync(item.downloaded);
    if (!stat.isFile() || stat.size < 12 || (item.size && stat.size !== Number(item.size))) return false;
    fd = fs.openSync(item.downloaded, "r");
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, head.length, 0) !== head.length) return false;
    return looksLikeMedia(head, item.kind);
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * 落盘。默认走无水印：先请求改写后的地址，失败再回退原始地址——
 * 自动任务可要求无水印并拒绝回退；手动下载返回最终响应地址的 watermark 三态，
 * 无法确认的 CDN 地址标为 unknown，不把猜测当作已去水印。
 */
async function download(ses, item, opts = {}) {
  ensureLoaded();
  const sameTask = opts.taskId && item.taskId === opts.taskId;
  if (opts.taskId) annotate(item, { taskId: opts.taskId, templateName: opts.templateName || "" });
  if (sameTask && validDownloadedFile(item) && (!opts.requireUnwatermarked || item.watermark === "none")) {
    return { ok: true, file: item.downloaded, size: item.size, url: item.downloadUrl || item.url, unwatermarked: item.watermark === "none", watermark: item.watermark || "unknown", fallback: !!item.downloadFallback, reused: true };
  }
  const dir = P.downloadDir(opts.dir || opts.downloadDir || store.get().settings.downloadDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = opts.fileName || buildFileName(item, opts);
  let target = path.join(dir, name);

  const original = String(item.url || "");
  const clean = preferUnwatermarked(opts.sourceUrl || original);
  const chain = [];
  const addUrl = (u) => {
    const s = String(u || "");
    if (s && (!opts.requireUnwatermarked || isUnwatermarked(s)) && chain.indexOf(s) < 0) chain.push(s);
  };
  if (opts.preferUnwatermarked === false) {
    // 明确要带水印版：item.url 可能早已被改写成无水印地址，得从原始地址起
    addUrl(item.watermarkedUrl);
    addUrl(item.rawUrl);
    addUrl(original);
  } else {
    addUrl(clean);
    addUrl(original);
    addUrl(item.rawUrl);
    addUrl(item.watermarkedUrl);
  }
  if (!chain.length) {
    item.status = "download_failed";
    item.error = opts.requireUnwatermarked ? "尚未取得可确认的无水印原片地址，保留生成结果供重新下载" : "没有可下载的地址";
    saveResources();
    events.emit("update", item);
    throw new Error(item.error);
  }

  // Reserve the filename before the first network await. Only this download may clean it up.
  for (let n = 0; ; n += 1) {
    const ext = path.extname(name);
    target = path.join(dir, n ? `${path.basename(name, ext)}_${n}${ext}` : name);
    try { fs.closeSync(fs.openSync(target, "wx")); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  let written = false;
  try {
    let lastError = null;
    let index = 0;
    for (const url of chain) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await ses.fetch(url, { headers: { accept: "*/*" } });
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
        const finalUrl = String(res.url || url);
        const watermark = watermarkState(finalUrl);
        if (opts.requireUnwatermarked && watermark !== "none") {
          throw new Error(watermark === "kept" ? "原片地址重定向到了带水印源，未保存成片" : "原片地址重定向后无法确认水印状态");
        }
        const ct = String(res.headers.get("content-type") || "");
        if (/text\/html/i.test(ct)) throw new Error("拿到的是网页而不是媒资（可能已失效或需要登录）");
        // eslint-disable-next-line no-await-in-loop
        const buf = Buffer.from(await res.arrayBuffer());
        if (!looksLikeMedia(buf, item.kind)) throw new Error("文件头不是有效媒资，已丢弃");

        fs.writeFileSync(target, buf);
        written = true;
        const done = watermark === "none";
        item.downloaded = target;
        item.status = "downloaded";
        item.error = "";
        item.size = buf.length;
        item.watermark = watermark;
        item.downloadUrl = finalUrl;
        item.downloadFallback = index > 0;
        item.unwatermarked = done;
        if (done) { item.url = url; item.unwatermarkedUrl = url; }
        saveResources();
        events.emit("update", item);
        log.info("asset-downloaded", { file: target, size: buf.length, kind: item.kind, unwatermarked: done, watermark, fallback: index > 0 });
        return {
          ok: true,
          file: target,
          size: buf.length,
          contentType: ct,
          url: finalUrl,
          unwatermarked: done,
          watermark,
          fallback: index > 0
        };
      } catch (error) {
        // A persistence/notification failure must not delete a successfully downloaded video.
        if (written) throw error;
        lastError = error;
        index += 1;
      }
    }
    item.status = "download_failed";
    item.error = String(lastError && lastError.message || "下载失败");
    saveResources();
    events.emit("update", item);
    throw lastError || new Error("下载失败");
  } finally {
    if (!written) { try { fs.unlinkSync(target); } catch {} }
  }
}

function list(filter = {}) {
  ensureLoaded();
  let out = items.slice().reverse();
  if (filter.instanceId) out = out.filter((i) => i.instanceId === filter.instanceId);
  if (filter.kind) out = out.filter((i) => i.kind === filter.kind);
  if (filter.taskId) out = out.filter((i) => i.taskId === filter.taskId);
  if (filter.unwatermarked) out = out.filter((i) => i.unwatermarked);
  if (filter.limit) out = out.slice(0, Number(filter.limit));
  return out;
}

function clear(filter = {}) {
  ensureLoaded();
  if (!filter || Object.keys(filter).length === 0) {
    const count = items.length;
    items.length = 0;
    seen.clear();
    saveResources();
    return count;
  }
  let removed = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    const hit = (!filter.instanceId || it.instanceId === filter.instanceId) && (!filter.kind || it.kind === filter.kind);
    if (hit) {
      seen.delete(itemKey(it.url, it.instanceId));
      items.splice(i, 1);
      removed += 1;
    }
  }
  saveResources();
  return removed;
}

function get(id) {
  ensureLoaded();
  return items.find((i) => i.id === String(id)) || null;
}

module.exports = { attach, push, scanText, scanUrl, download, list, clear, get, annotate, saveResources, mediaKey: normalizeKey, buildFileName, preferUnwatermarked, isUnwatermarked, events, looksLikeMedia, kindOf };
