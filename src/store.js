"use strict";

/**
 * 数据仓：APP_HOME/store.json
 *
 * 一个文件装下全部业务数据（实例、分镜、任务、素材、额度、设置），
 * 敏感字段（Cookie / 代理密码）不进这个文件，走 SECRET 单独加密存，
 * 这里只留 maskUrl 与 hasPassword 标记。
 *
 * 写入用「临时文件 + rename」，避免断电/崩溃时把 store 写成半个 JSON。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const P = require("./paths");
const log = require("./logger");
const SECRET = require("./secure");
const { buildProfile } = require("./fingerprint");

const VERSION = 4;
const DEFAULT_URL = "https://www.doubao.com/chat/";
const DOLA_URL = "https://www.dola.com/";

let store = null;

function newId(prefix) {
  return (prefix ? prefix + "-" : "") + crypto.randomBytes(8).toString("hex");
}

/* 写死项：只跑我们自带的 Chromium 内核，页面增强固定开启（不改签名，只改档位）。
   界面、REST /api/settings、MCP 都能改到 settings 对象，所以这里在落盘和迁移两处
   强制回写，谁都不能把这两项改回去（也就不需要每个入口各写一遍校验）。 */
const LOCKED = {
  kernel: "embedded",
  enhancer: { enabled: true }
};

/* 设置和任务模板共用模型清单：只有 2.5 上限 30 秒，其余上限 15 秒。 */
const MODEL_OPTIONS = [
  { value: "seedance_v2.5", label: "Seedance 2.5", maxDuration: 30 },
  { value: "seedance_v2.0", label: "Seedance 2.0", maxDuration: 15 },
  { value: "seedance_v2.0_fast", label: "Seedance 2.0 Fast", maxDuration: 15 },
  { value: "seedance_v2.0_mini", label: "Seedance 2.0 Mini", maxDuration: 15 }
];
const MODEL_LIMITS = Object.fromEntries(MODEL_OPTIONS.map((m) => [m.value, m.maxDuration]));
const DEFAULT_MODEL = "seedance_v2.5";
const DEFAULT_DURATION = 30;

function maxDurationFor(model) {
  const key = String(model || "");
  return MODEL_LIMITS[key] || 15;
}

/** 按当前模型把时长压回上限内（模型换了、时长没跟上时用） */
function clampEnhancer(enh) {
  const out = { ...(enh || {}) };
  out.enabled = true;
  out.resolution = out.resolution || "auto";
  out.model = String(out.model || DEFAULT_MODEL);
  const cap = maxDurationFor(out.model);
  const want = Number(out.duration) || DEFAULT_DURATION;
  out.duration = Math.min(Math.max(1, Math.round(want)), cap);
  return out;
}

function applyLocked(settings) {
  if (!settings || typeof settings !== "object") return settings;
  settings.kernel = LOCKED.kernel;
  settings.enhancer = clampEnhancer(settings.enhancer);
  const defaults = settingsDefaults();
  const integer = (value, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
    const number = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(number) ? Math.round(number) : fallback));
  };
  settings.orchestrator = { ...defaults.orchestrator, ...(settings.orchestrator || {}) };
  const orch = settings.orchestrator;
  orch.maxParallel = integer(orch.maxParallel, defaults.orchestrator.maxParallel, 1);
  orch.pollInterval = integer(orch.pollInterval, defaults.orchestrator.pollInterval, 1500);
  orch.retryLimit = integer(orch.retryLimit, defaults.orchestrator.retryLimit, 0, 10);
  settings.quota = { ...defaults.quota, ...(settings.quota || {}) };
  settings.quota.perDay = integer(settings.quota.perDay, defaults.quota.perDay, 1);
  settings.server = { ...defaults.server, ...(settings.server || {}) };
  settings.server.port = integer(settings.server.port, defaults.server.port, 1, 65535);
  if (settings.naming === "template") settings.naming = "custom";
  delete settings.externalBrowser;   // 不再让用户挑 Chrome / Edge
  return settings;
}

function settingsDefaults() {
  return {
    defaultUrl: DEFAULT_URL,
    maskMode: "mosaic",
    maskStrength: 18,
    keepOriginal: true,
    kernel: LOCKED.kernel,           // 写死内嵌（自带 Chromium）
    server: { enabled: true, port: 17823, token: "" },
    orchestrator: {
      autoDownload: true,
      autoConfirm: true,
      maxParallel: 10,
      pollInterval: 4000,
      stopHotkey: "F10",
      retryLimit: 3,
      appeal: true
    },
    quota: { perDay: 2, cooldownMin: 0, resetTz: "Asia/Tokyo" },
    naming: "timestamp",             // timestamp | index | prompt | account | custom
    namingTemplate: "{account}_{date}_{index}",
    downloadDir: "",
    enhancer: { enabled: true, duration: DEFAULT_DURATION, model: DEFAULT_MODEL, resolution: "auto" },
    lastStoryboardId: ""
  };
}

function emptyStore() {
  return {
    version: VERSION,
    brandNameMigrated: true,
    instances: [],
    proxies: [],
    storyboards: [],
    taskTemplates: [],
    taskDrafts: [],
    tasks: [],
    assets: { persons: [], scenes: [], props: [], voices: [] },
    quota: {},
    settings: settingsDefaults(),
    order: [],
    createdAt: new Date().toISOString()
  };
}

/* --------------------------------------------------------------- 规范化 */

function normalizeInstance(raw) {
  const a = raw && typeof raw === "object" ? { ...raw } : {};
  const id = String(a.id || newId("inst"));
  const out = {
    id,
    name: String(a.name || "未命名实例"),
    group: String(a.group || ""),
    remark: String(a.remark || ""),
    platform: String(a.platform || "doubao"),
    url: String(a.url || DEFAULT_URL),
    kernel: LOCKED.kernel,           // 写死内嵌，旧数据里的 external 一并归一
    partition: `persist:acct-${id}`,
    status: "idle",
    tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
    proxy: normalizeProxyMeta(a.proxy),
    fingerprint: a.fingerprint && typeof a.fingerprint === "object" && a.fingerprint.seed
      ? a.fingerprint
      : buildProfile(crypto.randomBytes(16).toString("hex")),
    cookie: { masked: String((a.cookie && a.cookie.masked) || ""), has: !!(a.cookie && a.cookie.has), updatedAt: (a.cookie && a.cookie.updatedAt) || "" },
    login: { state: String((a.login && a.login.state) || "unknown"), checkedAt: (a.login && a.login.checkedAt) || "" },
    stat: { success: Number((a.stat && a.stat.success) || 0), failed: Number((a.stat && a.stat.failed) || 0) },
    createdAt: String(a.createdAt || new Date().toISOString())
  };
  return out;
}

/** 代理元信息：url 里的密码先抽走，落盘只留掩码 */
function normalizeProxyMeta(proxy) {
  const p = proxy && typeof proxy === "object" ? proxy : { mode: "direct" };
  const mode = ["direct", "system", "custom"].includes(p.mode) ? p.mode : "direct";
  const rawUrl = String(p.url || "");
  const parsed = splitProxyPassword(rawUrl);
  return {
    mode,
    url: parsed.maskUrl,
    hasPassword: parsed.hasPassword,
    label: String(p.label || "")
  };
}

function splitProxyPassword(raw) {
  const s = String(raw || "").trim();
  if (!s) return { maskUrl: "", hasPassword: false, password: "" };
  try {
    const withScheme = /^[a-z0-9]+:\/\//i.test(s) ? s : `http://${s}`;
    const u = new URL(withScheme);
    const password = decodeURIComponent(u.password || "");
    if (!password) return { maskUrl: withScheme, hasPassword: false, password: "" };
    const masked = withScheme.replace(`:${encodeURIComponent(password)}@`, ":***@")
      .replace(`:${password}@`, ":***@");
    return { maskUrl: masked, hasPassword: true, password };
  } catch {
    return { maskUrl: s, hasPassword: false, password: "" };
  }
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const x of list || []) {
    const k = String(x && x.id);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/* ---------------------------------------------------------------- 读写 */

function migrate(raw) {
  const base = emptyStore();
  const out = { ...base, ...(raw && typeof raw === "object" ? raw : {}) };
  out.settings = { ...base.settings, ...(raw && raw.settings ? raw.settings : {}) };
  out.settings.orchestrator = { ...base.settings.orchestrator, ...((raw && raw.settings && raw.settings.orchestrator) || {}) };
  out.settings.quota = { ...base.settings.quota, ...((raw && raw.settings && raw.settings.quota) || {}) };
  out.settings.server = { ...base.settings.server, ...((raw && raw.settings && raw.settings.server) || {}) };
  out.settings.enhancer = { ...base.settings.enhancer, ...((raw && raw.settings && raw.settings.enhancer) || {}) };
  // 改名升级继续使用已有的默认成片目录，不移动文件或改变已保存的任务路径。
  if (raw && raw.brandNameMigrated !== true && !out.settings.downloadDir && fs.existsSync(P.legacyDownloadDir())) {
    out.settings.downloadDir = P.legacyDownloadDir();
  }
  out.brandNameMigrated = true;
  applyLocked(out.settings);

  const legacyAccounts = Array.isArray(raw && raw.accounts) ? raw.accounts : [];
  const instancesRaw = Array.isArray(out.instances) && out.instances.length ? out.instances : legacyAccounts;
  out.instances = unique(instancesRaw.map(normalizeInstance));

  out.proxies = Array.isArray(out.proxies) ? out.proxies : [];
  out.storyboards = Array.isArray(out.storyboards) ? out.storyboards : [];
  out.taskTemplates = Array.isArray(out.taskTemplates) ? out.taskTemplates : [];
  out.taskDrafts = Array.isArray(out.taskDrafts) ? out.taskDrafts : [];
  out.tasks = Array.isArray(out.tasks) ? out.tasks : [];
  out.assets = out.assets && typeof out.assets === "object" ? out.assets : base.assets;
  for (const k of ["persons", "scenes", "props", "voices"]) {
    if (!Array.isArray(out.assets[k])) out.assets[k] = [];
  }
  out.quota = out.quota && typeof out.quota === "object" ? out.quota : {};
  out.version = VERSION;
  delete out.accounts;
  return out;
}

function file() {
  return path.join(P.home(), "store.json");
}

function load() {
  P.ensure();
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    store = migrate(raw);
  } catch {
    store = emptyStore();
  }
  // 实例 id 补齐顺序表
  const ids = new Set(store.instances.map((i) => i.id));
  store.order = (Array.isArray(store.order) ? store.order : []).filter((id) => ids.has(id));
  for (const i of store.instances) if (!store.order.includes(i.id)) store.order.push(i.id);
  return store;
}

function get() {
  if (!store) load();
  return store;
}

function save() {
  P.ensure();
  const data = get();
  applyLocked(data.settings);
  const target = file();
  const tmp = target + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, target);
    return true;
  } catch (error) {
    log.error("store-save-failed", { message: String(error && error.message) });
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

function find(id) {
  return get().instances.find((a) => a.id === String(id || "")) || null;
}

function add(instance) {
  const data = get();
  const inst = normalizeInstance(instance);
  data.instances.push(inst);
  data.order.push(inst.id);
  return inst;
}

function patch(id, patchObj) {
  const inst = find(id);
  if (!inst) return null;
  const next = { ...inst, ...(patchObj || {}), id: inst.id, partition: inst.partition };
  if (patchObj && patchObj.fingerprint) next.fingerprint = { ...inst.fingerprint, ...patchObj.fingerprint };
  if (patchObj && patchObj.proxy) next.proxy = { ...inst.proxy, ...patchObj.proxy };
  Object.assign(inst, normalizeInstance(next));
  return inst;
}

function remove(id) {
  const data = get();
  const idx = data.instances.findIndex((a) => a.id === String(id));
  if (idx < 0) return null;
  const [inst] = data.instances.splice(idx, 1);
  data.order = data.order.filter((x) => x !== inst.id);
  data.tasks = data.tasks.filter((t) => t.instanceId !== inst.id);
  delete data.quota[inst.id];
  SECRET.removeSecret("proxy", inst.id);
  SECRET.removeSecret("cookie", inst.id);
  return inst;
}

/* --------------------------------------------------------- 敏感字段封装 */

function setProxySecret(id, password) {
  SECRET.setSecret("proxy", id, password || "");
}

/** 还原完整代理 URL（含密码） */
function proxyUrlOf(inst) {
  const meta = inst && inst.proxy ? inst.proxy : { mode: "direct", url: "" };
  const pwd = meta.hasPassword ? SECRET.getSecret("proxy", inst.id) : "";
  if (!pwd) return meta.url || "";
  return String(meta.url || "").replace(":***@", `:${encodeURIComponent(pwd)}@`);
}

function setCookie(id, cookie) {
  SECRET.setSecret("cookie", id, cookie || "");
  const inst = find(id);
  if (!inst) return;
  const text = String(cookie || "");
  inst.cookie = text
    ? { masked: maskCookie(text), has: true, updatedAt: new Date().toISOString() }
    : { masked: "", has: false, updatedAt: new Date().toISOString() };
}

function getCookie(id) {
  return SECRET.getSecret("cookie", id);
}

function maskCookie(text) {
  const pairs = String(text || "").split(";").map((s) => s.trim()).filter(Boolean);
  const names = pairs.map((p) => p.split("=")[0]).filter(Boolean);
  return names.length ? `${names.length} 个字段（${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}）` : "";
}

module.exports = {
  VERSION,
  DEFAULT_URL,
  DOLA_URL,
  LOCKED,
  MODEL_OPTIONS,
  MODEL_LIMITS,
  maxDurationFor,
  clampEnhancer,
  newId,
  emptyStore,
  settingsDefaults,
  normalizeInstance,
  normalizeProxyMeta,
  splitProxyPassword,
  load,
  get,
  save,
  find,
  add,
  patch,
  remove,
  setProxySecret,
  proxyUrlOf,
  setCookie,
  getCookie,
  maskCookie
};
