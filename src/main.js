"use strict";

/**
 * 主进程
 *
 * 这一版把原来的「一个 main.js 干完所有事」拆成模块后在这里装配：
 *   基础（paths/logger/store） → 会话（session/interceptor） → 业务（instances/quota/...）
 *   → 服务（http/api/mcp/sse） → 界面（IPC + 窗口）
 *
 * 旧的 IPC 通道全部保留（界面在用），新增的通道统一走 `dm:` 前缀，
 * 三条入口（界面 / REST / MCP）最终调的是同一批模块函数。
 */

/* 启动期自检：require 阶段崩掉时 Electron 的 GUI 版 exe 不显示任何输出，
   这里直接把栈写进 tmp 里的 boot.log，出问题第一件事就是看它。 */
const nodeOs = require("node:os");
const nodePath = require("node:path");
const nodeFs = require("node:fs");
const BOOT_LOG = nodePath.join(nodeOs.tmpdir(), "infinite-doubao-boot.log");
let startupReady = false;
let startupFailed = false;
let appQuitting = false;
function bootLog(stage, error) {
  try {
    nodeFs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} [${stage}] ${error && (error.stack || error.message || error)}\n`, "utf8");
  } catch {}
}
function reportStartupFailure(error) {
  if (startupFailed || appQuitting) return;
  startupFailed = true;
  const message = String(error && (error.stack || error.message) || error);
  bootLog("startup-failed", message);
  try {
    const runtime = require("electron");
    try { runtime.dialog.showErrorBox("豆包工坊启动失败", `应用未能正常打开，请重新安装或查看启动日志。\n\n${message}\n\n日志：${BOOT_LOG}`); }
    finally { runtime.app.exit(1); }
  } catch { process.exit(1); }
}
bootLog("launch", "starting");
process.on("uncaughtException", (error) => { bootLog("uncaught", error); if (!startupReady) reportStartupFailure(error); });
process.on("unhandledRejection", (error) => { bootLog("unhandled-rejection", error); if (!startupReady) reportStartupFailure(error); });

const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, globalShortcut } = require("electron");
app.on("before-quit", () => { appQuitting = true; });
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const P = require("./paths");
const log = require("./logger");
const store = require("./store");
const brand = require("./brand");
// 品牌改名不搬迁用户数据，继续使用原账号会话、模板和附件；显式测试目录优先。
if (!app.commandLine.hasSwitch("user-data-dir")) {
  const dataHome = path.join(app.getPath("appData"), "无限豆包");
  app.setPath("userData", dataHome);
  app.setPath("sessionData", dataHome);
}
const instances = require("./instances");
const sessionMod = require("./session");
const driverMod = require("./driver");
const chromium = require("./chromium");
const interceptor = require("./interceptor");
const quota = require("./quota");
const accountProbe = require("./account-probe");
const storyboard = require("./storyboard");
const taskTemplates = require("./task-templates");
const taskDrafts = require("./task-drafts");
const assets = require("./assets");
const videoLibrary = require("./video-library");
const orchestrator = require("./orchestrator");
const jianying = require("./jianying");
const jianyingImport = require("./jianying-import");
const zizi = require("./zizi");
const update = require("./update");
const updater = update.createUpdater();
const httpMod = require("./http");
const api = require("./api");
const mcp = require("./mcp");
const sse = require("./sse");
const { buildProfile } = require("./fingerprint");
const fpCheck = require("./fp-check");
const { runFaceMask, probeFaceMask } = require("./facemask");

const DEFAULT_URL = store.DEFAULT_URL;

let mainWindow = null;
let server = null;
let registeredStopHotkey = "";
let activeMaskJobs = 0;
const openingAccounts = new Map();
const watchedLoginSessions = new WeakSet();

/* ------------------------------------------------------------------ 基础 */

/* webview 的 preload 必须落在真实磁盘上：asar 内的路径 guest 进程读不到，
   而且路径含中文，file:// 必须做一次 URL 编码，否则 Electron 直接静默失败。 */
function webviewPreloadPath() {
  if (app.isPackaged) {
    const packed = path.join(process.resourcesPath, "webview-preload.js");
    if (fs.existsSync(packed)) return packed;
  }
  return path.join(__dirname, "webview-preload.js");
}

function fileUrlFor(p) {
  const normalized = String(p).replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : "/" + normalized;
  return "file://" + encodeURI(prefixed).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

/** 递归合并对象（设置 patch 用），数组按整体替换 */
function mergeDeep(base, patch) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 找到某个实例对应的内嵌 webview 的 webContents */
function findWebContents(inst) {
  if (!inst) return null;
  let target = null;
  try { target = session.fromPartition(inst.partition); } catch { return null; }
  for (const wc of require("electron").webContents.getAllWebContents()) {
    try {
      if (wc.isDestroyed() || wc.getType() !== "webview") continue;
      if (wc.session === target) return wc;
    } catch {}
  }
  return null;
}

async function ensureAccountWebContents(inst) {
  const existing = findWebContents(inst);
  if (existing) return existing;
  if (openingAccounts.has(inst.id)) return openingAccounts.get(inst.id);
  const opening = (async () => {
    await prepareSession(inst);
    const deadline = Date.now() + 20000;
    let lastRequest = 0;
    while (Date.now() < deadline) {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口已关闭，账号无法打开");
      if (!store.find(inst.id)) throw new Error("账号已删除");
      const contents = findWebContents(inst);
      if (contents) return contents;
      if (Date.now() - lastRequest >= 1000) {
        pushToUi("dm:account:open", { instanceId: inst.id });
        lastRequest = Date.now();
      }
      await driverMod.sleep(100);
    }
    throw new Error("账号网页打开超时，请在账号列表检查网络或登录状态");
  })();
  openingAccounts.set(inst.id, opening);
  try { return await opening; }
  finally { openingAccounts.delete(inst.id); }
}

function applyStopHotkey(value) {
  const hotkey = String(value || "F10").trim();
  if (hotkey === registeredStopHotkey) return;
  let registered = false;
  try {
    registered = globalShortcut.register(hotkey, () => {
      const result = orchestrator.stopAll({});
      pushToUi("dm:hotkey", { key: hotkey, ...result });
      log.warn("hotkey-stop-all", result);
    });
  } catch {}
  if (!registered) throw new Error(`停止热键 ${hotkey} 无法注册，可能已被其他程序占用`);
  if (registeredStopHotkey) globalShortcut.unregister(registeredStopHotkey);
  registeredStopHotkey = hotkey;
}

/* ------------------------------------------------------------------ 窗口 */

function pushToUi(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  } catch {}
}

function showMainWindow() {
  if (!startupReady || !app.isReady() || startupFailed || appQuitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    show: true,
    backgroundColor: "#05080d",
    title: brand.name,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false
    }
  });

  const win = mainWindow;
  const failWindowLoad = (error) => {
    if (appQuitting || win.isDestroyed() || mainWindow !== win) return;
    reportStartupFailure(error);
  };
  win.webContents.once("did-finish-load", () => {
    if (mainWindow === win && !win.isDestroyed()) showMainWindow();
  });
  win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame !== false && code !== -3) failWindowLoad(new Error(`主界面加载失败（${code}）：${description}`));
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    failWindowLoad(new Error(`主界面进程已退出：${details.reason || "unknown"}（${details.exitCode ?? ""}）`));
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html")).catch(failWindowLoad);
  mainWindow.webContents.on("console-message", (_e, level, message, line, source) => {
    log.info("renderer-console", { level, message: String(message).slice(0, 800), source, line });
  });
  mainWindow.webContents.on("preload-error", (_e, p, error) => {
    log.error("preload-error", { path: p, message: String(error && error.message) });
  });
  mainWindow.once("ready-to-show", showMainWindow);
  // Do not rely on a first paint event: a launch/installer may request a hidden
  // startup window, and ready-to-show is not guaranteed after a load failure.
  showMainWindow();

  // webview 的 webPreferences 在这里强制改写，而不是靠 <webview webpreferences="..."> 属性。
  // 属性串在 Electron 43 的 guest 上不生效（实测 contextIsolation 仍是 true，preload 被关在
  // 隔离世界里，改 navigator 页面根本看不见），will-attach-webview 是唯一可靠的拦截点。
  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    webPreferences.contextIsolation = false;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.sandbox = false;
    webPreferences.spellcheck = false;
    webPreferences.webSecurity = true;
    webPreferences.backgroundThrottling = false;
    const inst = instances.list().find((i) => i.partition === params.partition);
    log.info("webview-attach", { partition: String(params.partition || ""), matched: inst ? inst.id : "", preloadSet: !!inst });
    // preload 用绝对路径，不用 file:// URL：Electron 43 对 webview 的 preload
    // 只接受磁盘绝对路径，传 URL 会静默不加载（实测无任何 preload-error）。
    if (inst) webPreferences.preload = webviewPreloadPath();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => { if (mainWindow === win) mainWindow = null; });
}

/* -------------------------------------------------------------- webview 事件 */

app.on("web-contents-created", (_e, contents) => {
  if (contents.getType() !== "webview") return;
  contents.on("console-message", (_ev, level, message, line, source) => {
    if (level >= 2) log.warn("webview-console", { level, message: String(message).slice(0, 300), source: String(source).slice(0, 120), line });
  });
  contents.on("preload-error", (_ev, preloadPath, error) => {
    log.error("webview-preload-error", { preloadPath, message: String((error && error.message) || error) });
  });
  contents.on("did-fail-load", (_ev, code, desc, url) => {
    if (code !== -3) log.warn("webview-load-failed", { code, desc, url: String(url).slice(0, 160) });
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) contents.loadURL(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!/^https?:/i.test(url) && !/^about:/.test(url)) event.preventDefault();
  });
  contents.on("did-finish-load", () => {
    const inst = sessionMod.accountBySession(contents.session);
    if (inst) orchestrator.wakeQueue(inst.id);
  });
  contents.on("did-navigate-in-page", () => {
    const inst = sessionMod.accountBySession(contents.session);
    if (inst) orchestrator.wakeQueue(inst.id);
  });
});

/* ------------------------------------------------------------ 会话装配 */

async function prepareSession(inst) {
  const ses = await sessionMod.applySession({ ...inst, proxyUrl: store.proxyUrlOf(inst) });
  interceptor.attach(ses, inst);
  if (!watchedLoginSessions.has(ses)) {
    watchedLoginSessions.add(ses);
    let timer;
    ses.cookies.on("changed", (_event, cookie) => {
      if (!cookie || !accountProbe.LOGIN_COOKIES.includes(cookie.name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; orchestrator.wakeQueue(inst.id); }, 300);
      timer.unref?.();
    });
  }
  return ses;
}

async function prepareAllSessions() {
  for (const inst of instances.list()) {
    prepareSession(inst).catch((error) => log.warn("session-prepare-failed", { id: inst.id, message: String(error && error.message) }));
  }
}

/* ------------------------------------------------------------------ IPC */

function registerIpc() {
  /* ---------------- 兼容旧界面 ---------------- */

  ipcMain.handle("store:load", () => {
    const data = store.get();
    // 旧界面读的是 accounts，这里映射到 instances，避免两套数据结构
    return { store: { ...data, accounts: data.instances }, home: P.home() };
  });

  ipcMain.handle("store:save-settings", async (_e, patch) => {
    const data = store.get();
    // 深合并：界面按分组下发 patch（如 { orchestrator: { retryLimit: 5 } }），
    // 浅合并会把同组其它字段整体顶掉，等于每改一项就重置一组设置。
    const previous = data.settings;
    const next = mergeDeep(previous || {}, patch || {});
    if (patch?.orchestrator && Object.hasOwn(patch.orchestrator, "stopHotkey")) applyStopHotkey(next.orchestrator.stopHotkey);
    data.settings = next;
    if (!store.save()) {
      data.settings = previous;
      if (patch?.orchestrator && Object.hasOwn(patch.orchestrator, "stopHotkey")) applyStopHotkey(previous.orchestrator.stopHotkey);
      throw new Error("设置保存失败，请检查配置目录是否可写");
    }
    if (patch && patch.server) await applyServerSettings(patch.server);
    pushToUi("dm:settings", { defaultUrl: next.defaultUrl, enhancer: next.enhancer, downloadDir: next.downloadDir, maskMode: next.maskMode, maskStrength: next.maskStrength, keepOriginal: next.keepOriginal });
    orchestrator.wakeQueue();
    return data.settings;
  });

  ipcMain.handle("account:create", (_e, input = {}) => {
    const inst = instances.create({ ...input, url: input.url || store.get().settings.defaultUrl });
    prepareSession(inst).then(() => orchestrator.wakeQueue(inst.id)).catch(() => {});
    return inst;
  });

  ipcMain.handle("account:update", (_e, id, patch = {}) => {
    const inst = instances.update(id, patch);
    if (inst) prepareSession(inst).then(() => orchestrator.wakeQueue(inst.id)).catch(() => {});
    return inst;
  });

  ipcMain.handle("account:remove", async (_e, id) => {
    const inst = instances.remove(id);
    if (!inst) return { ok: false };
    try { await session.fromPartition(inst.partition).clearStorageData(); } catch {}
    return { ok: true };
  });

  ipcMain.handle("account:regenerate-fp", (_e, id) => {
    const fp = instances.regenerateFingerprint(id);
    const inst = instances.get(id);
    if (inst) prepareSession(inst).catch(() => {});
    return fp;
  });

  ipcMain.handle("account:set-fp-field", (_e, id, patch) => {
    const fp = instances.setFingerprintField(id, patch);
    const inst = instances.get(id);
    if (inst) prepareSession(inst).catch(() => {});
    return fp;
  });

  // webview preload 同步取指纹（在页面脚本前拿到）
  ipcMain.on("dm:fp-profile", (event, _payload) => {
    const inst = sessionMod.accountBySession(event.sender.session);
    event.returnValue = {
      accountId: inst ? inst.id : "",
      instanceId: inst ? inst.id : "",
      accountName: inst ? inst.name : "",
      profile: inst ? inst.fingerprint : null,
      mask: store.get().settings,
      enhancer: store.get().settings.enhancer
    };
  });

  ipcMain.on("dm:preload-alive", (event, payload) => {
    const inst = sessionMod.accountBySession(event.sender.session);
    log.info("webview-preload-alive", { account: inst ? inst.id : "", href: String((payload && payload.href) || "").slice(0, 120) });
  });

  ipcMain.on("dm:fp-error", (event, message) => {
    const inst = sessionMod.accountBySession(event.sender.session);
    log.warn("fp-runtime-error", { account: inst ? inst.id : "", message: String(message || "").slice(0, 300) });
  });
  ipcMain.on("dm:page-script-error", (event, message) => {
    const inst = sessionMod.accountBySession(event.sender.session);
    log.warn("page-script-error", { account: inst ? inst.id : "", message: String(message || "").slice(0, 300) });
  });

  ipcMain.handle("proxy:test", async (_e, id) => {
    const inst = instances.get(id);
    if (!inst) return { ok: false, message: "实例不存在" };
    const ses = await prepareSession(inst);
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await ses.fetch("http://ip-api.com/json/?fields=status,message,country,regionName,city,isp,timezone,query&lang=zh-CN", {
        signal: controller.signal,
        headers: { accept: "application/json" }
      });
      clearTimeout(timer);
      const latency = Date.now() - started;
      const text = await res.text();
      let j = {};
      try { j = JSON.parse(text); } catch {}
      if (!res.ok || j.status === "fail") return { ok: false, message: j.message || `HTTP ${res.status}`, latency, raw: text.slice(0, 200) };
      return { ok: true, ip: j.query || "", country: j.country || "", region: j.regionName || "", city: j.city || "", isp: j.isp || "", timezone: j.timezone || "", latency };
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error), latency: Date.now() - started };
    }
  });

  ipcMain.handle("proxy:parse-list", (_e, text) => {
    const list = api.parseProxyList(text);
    store.get().proxies = list.map((p, i) => ({ id: `${i}-${p.url}`, ...p }));
    store.save();
    return store.get().proxies;
  });

  // 无水印下载（旧通道：由 webview preload 发起，event.sender 就是该实例的分区会话）
  ipcMain.on("dm:no-watermark-download", async (event, payload = {}) => {
    const requestId = String(payload.requestId || "");
    const reply = (label, done, ok, extra) => {
      try { event.sender.send("dm:no-watermark-progress", { requestId, label, done, ok, ...(extra || {}) }); } catch {}
    };
    const ses = event.sender && event.sender.session;
    if (!ses) return reply("下载失败：没有可用会话", true, false);
    const inst = sessionMod.accountBySession(ses);
    const urls = [];
    const direct = String(payload.url || "");
    if (direct) urls.push(direct);
    for (const c of Array.isArray(payload.candidates) ? payload.candidates : []) {
      if (c && !urls.includes(String(c))) urls.push(String(c));
    }
    if (!urls.length) return reply("没找到可下载的地址", true, false);

    reply("下载中…", false, false);
    let lastError = "";
    for (const url of urls.slice(0, 12)) {
      try {
        const item = interceptor.push({ url, rawUrl: url, kind: interceptor.kindOf(url), instanceId: inst ? inst.id : "", instanceName: inst ? inst.name : "", from: "page" });
        if (!item) continue;
        // eslint-disable-next-line no-await-in-loop
        const r = await interceptor.download(ses, item, {
          dir: store.get().settings.downloadDir || undefined,
          prompt: payload.filename || "",
          naming: store.get().settings.naming,
          namingTemplate: store.get().settings.namingTemplate,
          requireUnwatermarked: true,
          instance: inst
        });
        if (r && r.ok) return reply(`已保存 ${path.basename(r.file)}${r.unwatermarked ? "（无水印）" : ""}`, true, true, r);
        lastError = (r && r.message) || "下载失败";
      } catch (error) {
        lastError = String((error && error.message) || error);
      }
    }
    reply(`下载失败：${lastError}`, true, false);
  });

  ipcMain.handle("shell:show-item", (_e, file) => { try { shell.showItemInFolder(String(file)); return true; } catch { return false; } });
  ipcMain.handle("shell:open-path", (_e, p) => { try { shell.openPath(String(p)); return true; } catch { return false; } });
  ipcMain.handle("shell:open-external", (_e, url) => {
    try {
      if (!/^https?:\/\//i.test(String(url))) return false;
      shell.openExternal(String(url));
      return true;
    } catch { return false; }
  });
  ipcMain.handle("app:home", () => P.home());
  ipcMain.handle("app:paths", () => {
    const preload = webviewPreloadPath();
    return {
      webviewPreload: preload,
      webviewPreloadUrl: fileUrlFor(preload),
      home: P.home(),
      downloads: P.downloadDir(store.get().settings.downloadDir),
      paths: P.all(store.get().settings.downloadDir)
    };
  });
  ipcMain.handle("app:open-home", async () => {
    const dir = P.downloadDir(store.get().settings.downloadDir);
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
    return dir;
  });

  // ---- 素材遮脸 ----
  ipcMain.handle("mask:probe", () => probeFaceMask());
  ipcMain.handle("mask:pick", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "选择要处理的素材",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片/视频", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "mp4", "mov", "m4v", "webm", "avi", "mkv"] }]
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle("mask:run", async (event, input) => {
    const files = Array.isArray(input && input.files) ? input.files : [];
    if (!files.length) return { ok: false, message: "没有选中文件" };
    activeMaskJobs++;
    try { return await runFaceMask({
      files,
      mode: input.mode || "mosaic",
      strength: Number(input.strength) || 18,
      padRatio: Number(input.pad) || 0.18,
      keepOriginal: input.keepOriginal !== false,
      outDir: input.outDir || "",
      onProgress: (p) => { try { event.sender.send("mask:progress", p); } catch {} }
    }); } finally { activeMaskJobs--; }
  });

  /* ---------------- 新界面：统一以模块为准 ---------------- */

  const wrap = (fn) => async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };

  ipcMain.handle("dm:renderer:ready", wrap(async () => { orchestrator.wakeQueue(); return true; }));

  ipcMain.handle("dm:state", wrap(async () => ({
    brand: { name: brand.name, version: brand.version, englishName: brand.englishName, features: brand.get().features },
    paths: P.all(store.get().settings.downloadDir),
    settings: store.get().settings,
    models: store.MODEL_OPTIONS,
    server: server ? server.info() : null,
    orchestrator: orchestrator.state(),
    quota: quota.snapshot(),
    chromium: chromium.status(),
    counts: {
      instances: store.get().instances.length,
      storyboards: store.get().storyboards.length,
      templates: store.get().taskTemplates.length,
      tasks: store.get().tasks.length,
      resources: interceptor.list({ limit: 999 }).length
    }
  })));

  ipcMain.handle("dm:instances", wrap(async () => instances.list().map((i) => ({ ...i, quota: quota.get(i.id) }))));
  ipcMain.handle("dm:instance:create", wrap(async (input) => {
    const inst = instances.create(input || {});
    await prepareSession(inst);
    orchestrator.wakeQueue(inst.id);
    return inst;
  }));
  ipcMain.handle("dm:instance:update", wrap(async (id, patch) => {
    const inst = instances.update(id, patch || {});
    if (inst) { await prepareSession(inst); orchestrator.wakeQueue(inst.id); }
    return inst;
  }));
  ipcMain.handle("dm:instance:remove", wrap(async (id) => instances.remove(id)));
  ipcMain.handle("dm:instance:probe", wrap(async (id) => {
    const inst = store.find(id);
    if (!inst) throw new Error("实例不存在");
    const r = await accountProbe.probe(inst, { session: session.fromPartition(inst.partition) });
    const cur = store.find(id);
    if (cur) { cur.login = { state: r.state, checkedAt: new Date().toISOString() }; store.save(); }
    if (r.state !== "expired") orchestrator.wakeQueue(id);
    return r;
  }));
  ipcMain.handle("dm:instance:probe-all", wrap(async () => accountProbe.probeAll()));
  ipcMain.handle("dm:instance:fp-check", wrap(async (id) => {
    const inst = store.find(id);
    if (!inst) throw new Error("实例不存在");
    const actual = await fpCheck.read({ instance: inst });
    return fpCheck.compare(inst.fingerprint || {}, actual || {});
  }));
  ipcMain.handle("dm:instance:open-external", wrap(async (id) => {
    const inst = store.find(id);
    if (!inst) throw new Error("实例不存在");
    const wc = findWebContents(inst);
    if (!wc) throw new Error("该实例还没有在主窗口打开，先在左侧点开它");
    const drv = await driverMod.open(inst, { webContents: wc });
    return { url: await drv.url() };
  }));
  ipcMain.handle("dm:instance:kernel-stop", wrap(async () => ({ stopped: false })));
  ipcMain.handle("dm:instance:inject-cookie", wrap(async (id, text) => {
    const inst = store.find(id);
    if (!inst) throw new Error("实例不存在");
    const list = instances.parseCookies(text);
    if (!list.length) throw new Error("没解析出 cookie");
    const n = await sessionMod.injectCookie({ ...inst, proxyUrl: store.proxyUrlOf(inst) }, list);
    store.setCookie(id, list.map((c) => `${c.name}=${c.value}`).join("; "));
    store.save();
    orchestrator.wakeQueue(id);
    return { injected: n, total: list.length };
  }));
  ipcMain.handle("dm:instance:read-cookie", wrap(async (id) => {
    const inst = store.find(id);
    if (!inst) throw new Error("实例不存在");
    return sessionMod.readCookies(inst);
  }));

  ipcMain.handle("dm:templates", wrap(async () => ({ items: taskTemplates.list(), options: taskTemplates.options() })));
  ipcMain.handle("dm:template:create", wrap(async (input) => taskTemplates.create(input || {})));
  ipcMain.handle("dm:template:update", wrap(async (id, patch) => taskTemplates.update(id, patch || {})));
  ipcMain.handle("dm:template:remove", wrap(async (id) => taskTemplates.remove(id)));
  ipcMain.handle("dm:template:attach", wrap(async (id, files) => taskTemplates.importAttachments(id, files)));
  ipcMain.handle("dm:template:detach", wrap(async (id, fileId) => taskTemplates.removeAttachment(id, fileId)));
  ipcMain.handle("dm:template:submit", wrap(async (id) => orchestrator.submitTemplate(taskTemplates.snapshot(id))));
  ipcMain.handle("dm:drafts", wrap(async () => taskDrafts.list()));
  ipcMain.handle("dm:draft:create", wrap(async (id, mode) => taskDrafts.create(id, mode)));
  ipcMain.handle("dm:draft:remove", wrap(async (id) => taskDrafts.remove(id)));
  ipcMain.handle("dm:drafts:submit", wrap(async (ids) => orchestrator.submitDrafts(ids)));
  ipcMain.handle("dm:task:stop", wrap(async (id) => orchestrator.stopTask(id)));

  ipcMain.handle("dm:storyboards", wrap(async () => storyboard.list()));
  ipcMain.handle("dm:storyboard:get", wrap(async (id) => {
    const sb = storyboard.get(id);
    if (!sb) throw new Error("分镜不存在");
    return { storyboard: sb, stats: storyboard.stats(sb), tasks: orchestrator.taskList({ storyboardId: id, limit: 200 }) };
  }));
  ipcMain.handle("dm:storyboard:create", wrap(async (input) => storyboard.create(input || {})));
  ipcMain.handle("dm:storyboard:import", wrap(async (name, text) => storyboard.importMarkdown(name, text)));
  ipcMain.handle("dm:storyboard:update", wrap(async (id, patch) => storyboard.update(id, patch || {})));
  ipcMain.handle("dm:storyboard:remove", wrap(async (id) => storyboard.remove(id)));
  ipcMain.handle("dm:storyboard:export", wrap(async (id) => storyboard.exportMarkdown(id)));
  ipcMain.handle("dm:storyboard:check", wrap(async (id) => {
    const sb = storyboard.get(id);
    if (!sb) throw new Error("分镜不存在");
    return zizi.checkShots(sb.shots);
  }));
  ipcMain.handle("dm:storyboard:start", wrap(async (id, opts) => orchestrator.start(id, opts || {})));
  ipcMain.handle("dm:storyboard:stop", wrap(async (id) => orchestrator.stop(id)));
  ipcMain.handle("dm:storyboard:pause", wrap(async (id) => orchestrator.pause(id)));
  ipcMain.handle("dm:storyboard:resume", wrap(async (id, opts) => orchestrator.resume(id, opts || {})));
  ipcMain.handle("dm:storyboard:reset", wrap(async (id) => storyboard.resetShots(id)));
  ipcMain.handle("dm:shot:update", wrap(async (sbId, shotId, patch) => storyboard.updateShot(sbId, shotId, patch || {})));
  ipcMain.handle("dm:shot:remove", wrap(async (sbId, shotId) => storyboard.removeShot(sbId, shotId)));

  ipcMain.handle("dm:tasks", wrap(async (filter) => orchestrator.taskList(filter || {})));
  ipcMain.handle("dm:task:retry", wrap(async (id) => orchestrator.retryTask(id, {})));
  ipcMain.handle("dm:task:redispatch", wrap(async (id, instanceId) => orchestrator.redispatch(id, instanceId)));
  ipcMain.handle("dm:orchestrator:state", wrap(async () => orchestrator.state()));
  ipcMain.handle("dm:orchestrator:stop-all", wrap(async () => orchestrator.stopAll({})));

  ipcMain.handle("dm:quota", wrap(async () => ({ items: quota.snapshot(), limits: quota.limits() })));
  ipcMain.handle("dm:quota:cool", wrap(async (id, minutes) => { const result = quota.cool(id, minutes || 0, "手动"); orchestrator.wakeQueue(id); return result; }));
  ipcMain.handle("dm:quota:reset", wrap(async (id) => { const result = quota.reset(id); orchestrator.wakeQueue(id); return result; }));

  ipcMain.handle("dm:videos", wrap(async () => videoLibrary.list()));
  ipcMain.handle("dm:assets", wrap(async (kind) => assets.list(kind)));
  ipcMain.handle("dm:asset:add", wrap(async (kind, item) => assets.add(kind, item || {})));
  ipcMain.handle("dm:asset:update", wrap(async (kind, id, patch) => assets.update(kind, id, patch || {})));
  ipcMain.handle("dm:asset:remove", wrap(async (kind, id) => assets.remove(kind, id)));
  ipcMain.handle("dm:asset:grid", wrap(async (files, opts) => assets.grid(files || [], opts && opts.out, opts || {})));

  ipcMain.handle("dm:resources", wrap(async (filter) => interceptor.list(filter || {})));
  ipcMain.handle("dm:resource:download", wrap(async (id, opts) => {
    const item = interceptor.get(id);
    if (!item) throw new Error("资源不存在");
    const inst = store.find((opts && opts.instanceId) || item.instanceId) || store.get().instances[0];
    if (!inst) throw new Error("没有可用于下载的实例");
    const r = await interceptor.download(session.fromPartition(inst.partition), item, {
      ...(opts || {}),
      dir: store.get().settings.downloadDir || undefined,
      naming: store.get().settings.naming,
      namingTemplate: store.get().settings.namingTemplate,
      instance: inst
    });
    // 下载失败也是 {ok:false} 返回值，必须转成异常，界面才不会弹"已保存"
    if (r && r.ok === false) throw new Error(r.message || "下载失败");
    return r;
  }));
  ipcMain.handle("dm:resources:clear", wrap(async (filter) => ({ removed: interceptor.clear(filter || {}) })));

  ipcMain.handle("dm:jianying:edit", wrap(async (opts) => jianyingImport.importTask(opts || {})));
  ipcMain.handle("dm:jianying:draft", wrap(async (opts) => {
    const r = await jianying.createDraft(opts || {});
    // createDraft 的失败（比如这个分镜一帧成片都还没有）必须抛出去，
    // 否则界面会把 {ok:false} 当成成功对象，弹出"草稿已生成"的假提示。
    if (r && r.ok === false) throw new Error(r.message || "生成剪映草稿失败");
    return r;
  }));
  ipcMain.handle("dm:jianying:drafts", wrap(async (dir) => jianying.listDrafts(dir)));

  ipcMain.handle("dm:prompt:check", wrap(async (text) => zizi.check(text || "")));
  ipcMain.handle("dm:prompt:appeal", wrap(async (opts) => zizi.appealScript(opts || {})));

  ipcMain.handle("dm:update:status", wrap(async () => updater.status()));
  ipcMain.handle("dm:update:check", wrap(async () => updater.check()));
  ipcMain.handle("dm:update:download", wrap(async () => updater.download()));
  ipcMain.handle("dm:update:install", wrap(async () => {
    if (!app.isPackaged) throw new Error("开发模式不能覆盖安装，请使用已安装的版本");
    if (activeMaskJobs || orchestrator.state().running.length || store.get().tasks.some((task) => ["queued", "running"].includes(task.status))) {
      throw new Error("还有生成或遮脸任务正在执行，请完成或停止任务后再安装更新");
    }
    return updater.install(async (installer) => {
      store.save();
      interceptor.saveResources();
      const { spawn } = require("node:child_process");
      const child = spawn(installer, ["/UPDATE", `/D=${path.dirname(process.execPath)}`, `/WAITPID=${process.pid}`], { detached: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      setTimeout(() => app.quit(), 200);
    });
  }));

  ipcMain.handle("dm:logs", wrap(async (limit, q) => log.recent(Number(limit) || 200, q || "")));
  ipcMain.handle("dm:server", wrap(async () => (server ? server.info() : null)));
  ipcMain.handle("dm:server:start", wrap(async () => { await startServer(); return server ? server.info() : null; }));
  ipcMain.handle("dm:server:stop", wrap(async () => { await stopServer(); return null; }));
  ipcMain.handle("dm:server:rotate", wrap(async () => (server ? server.rotateToken() : null)));
  ipcMain.handle("dm:mcp:tools", wrap(async () => mcp.tools()));
}

/* ------------------------------------------------------------------ 服务 */

async function startServer() {
  if (server) return server;
  const s = store.get().settings.server || {};
  const next = new httpMod.HttpServer({ port: Number(s.port) || 17823, host: "127.0.0.1", token: s.token || undefined });
  api.init({
    findWebContents,
    notify: (channel, payload) => pushToUi(channel, payload)
  });
  api.setup(next);
  mcp.setup(next);
  sse.setup(next);
  await next.start();
  server = next;
  store.get().settings.server = { ...s, enabled: true, port: server.port };
  store.save();
  log.info("server-started", server.info());
  return server;
}

async function stopServer(opts = {}) {
  if (!server) return;
  sse.close();
  await server.stop();
  server = null;
  if (opts.persist !== false) {
    store.get().settings.server = { ...(store.get().settings.server || {}), enabled: false };
    store.save();
  }
}

async function applyServerSettings(cfg) {
  if (!cfg) return;
  if (store.get().settings.server.enabled === false) { await stopServer(); return; }
  if (!server) { await startServer(); return; }
  if (cfg.port && Number(cfg.port) !== server.port) {
    await stopServer({ persist: false });
    await startServer();
  }
  if (Object.hasOwn(cfg, "token")) server.setToken(cfg.token);
}

/* ------------------------------------------------------------- 编排器装配 */

orchestrator.init({
  resolveDriver: async (inst) => {
    const wc = await ensureAccountWebContents(inst);
    return driverMod.open(inst, { webContents: wc });
  },
  findWebContents
});

orchestrator.events.on("event", (e) => pushToUi("dm:event", e));
updater.events.on("change", (state) => pushToUi("dm:update", state));
log.onLog((line) => pushToUi("dm:log", line));
interceptor.events.on("add", (item) => pushToUi("dm:resource", item));
interceptor.events.on("update", (item) => pushToUi("dm:resource", item));

/* ------------------------------------------------------------------ 启动 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    try { showMainWindow(); } catch (error) { reportStartupFailure(error); }
  });

  app.whenReady().then(async () => {
    P.init({ home: app.getPath("userData"), resources: app.isPackaged ? process.resourcesPath : path.join(__dirname, "..") });
    log.init({ dir: P.dir("logs") });
    store.load();
    await taskTemplates.migrateLegacy();
    orchestrator.recoverTemplateTasks();
    // 旧版 accounts 迁移到 instances 已在 store.migrate 里做，这里补一次保存
    store.save();

    Menu.setApplicationMenu(null);
    registerIpc();
    startupReady = true;
    createWindow();
    await prepareAllSessions();
    log.info("app-ready", { instances: store.get().instances.length, home: P.home(), version: brand.version });

    const s = store.get().settings.server || {};
    if (s.enabled !== false) {
      startServer().catch((error) => log.error("server-start-failed", { message: String(error && error.message) }));
    }

    const hotkey = (store.get().settings.orchestrator || {}).stopHotkey || "F10";
    try {
      applyStopHotkey(hotkey);
    } catch (error) {
      log.warn("hotkey-failed", { key: hotkey, message: String(error && error.message) });
    }
  }).catch(reportStartupFailure);

  app.on("will-quit", () => {
    try { globalShortcut.unregisterAll(); } catch {}
    try { interceptor.saveResources(); } catch {}
    stopServer({ persist: false }).catch(() => {});
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

process.on("uncaughtException", (error) => log.error("uncaught", { message: String(error && error.stack) }));
process.on("unhandledRejection", (error) => log.error("unhandled-rejection", { message: String(error && error.stack) }));

/* 代理认证：Electron 的 login 事件对会话级代理鉴权 */
app.on("login", (event, webContents, details, authInfo, callback) => {
  if (!authInfo || !authInfo.isProxy) return;
  const hit = sessionMod.authFor(`${authInfo.host}:${authInfo.port}`);
  if (hit) {
    event.preventDefault();
    callback(hit.username || "", hit.password || "");
  }
});
