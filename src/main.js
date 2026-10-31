"use strict";

if (process.argv.includes("--studio-executor")) {
  require("./server-executor").start().catch(() => {
    process.stderr.write("studio-executor: startup failed; check private configuration and runtime\n");
    require("electron").app.exit(1);
  });
} else {

/**
 * 主进程
 *
 * 这一版把原来的「一个 main.js 干完所有事」拆成模块后在这里装配：
 *   账号会话 → 任务模板 → 云电脑草稿保存与批量提交 → 原对话任务记录
 *
 * 桌面端仅注册这一条工作流及账号、设置、日志所需的 IPC。
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
if (process.platform === "darwin") {
  // Intel macOS can defer a hidden guest's 100 ms timer past the task's 20 s deadline.
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}
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
const proxyDiagnostics = require("./proxy-diagnostics");
const driverMod = require("./driver");
const chromium = require("./chromium");
const interceptor = require("./interceptor");
const quota = require("./quota");
const accountProbe = require("./account-probe");
const taskTemplates = require("./task-templates");
const taskDrafts = require("./task-drafts");
const orchestrator = require("./orchestrator");
const update = require("./update");
const updater = update.createUpdater();
const api = require("./api");
const { buildProfile } = require("./fingerprint");
const fpCheck = require("./fp-check");

const DEFAULT_URL = store.DEFAULT_URL;

let mainWindow = null;
let registeredStopHotkey = "";
const openingAccounts = new Map();
const draftWindows = new Set();
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
      // Keep the host's scheduler alive while a Mac guest is used from the drafts panel.
      backgroundThrottling: process.platform !== "darwin",
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
  mainWindow.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    for (const page of draftWindows) if (!page.isDestroyed()) page.destroy();
  });
}

/* -------------------------------------------------------------- webview 事件 */

app.on("web-contents-created", (_e, contents) => {
  if (contents.getType() !== "webview") return;
  if (process.platform === "darwin") contents.setBackgroundThrottling(false);
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
  const { ipcMain } = require("electron");
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
    pushToUi("dm:settings", { defaultUrl: next.defaultUrl, enhancer: next.enhancer, downloadDir: next.downloadDir, maskMode: next.maskMode, maskStrength: next.maskStrength, keepOriginal: next.keepOriginal });
    orchestrator.wakeQueue();
    return data.settings;
  });

  ipcMain.handle("account:create", (_e, input = {}) => {
    const inst = instances.create({ ...input, url: input.url || store.get().settings.defaultUrl });
    prepareSession(inst).then(() => orchestrator.wakeQueue(inst.id)).catch(() => {});
    return inst;
  });

  ipcMain.handle("account:update", async (_e, id, patch = {}) => {
    const inst = instances.update(id, patch);
    if (inst) { await prepareSession(inst); orchestrator.wakeQueue(inst.id); }
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
    try {
      const ses = await prepareSession(inst);
      return await proxyDiagnostics.testProxy(ses, { mode: inst.proxy?.mode || "direct", targetUrl: inst.url || store.get().settings.defaultUrl });
    } catch {
      return { ok: false, message: "代理设置应用失败，请检查代理配置后重试" };
    }
  });

  ipcMain.handle("proxy:parse-list", (_e, text) => {
    const list = api.parseProxyList(text);
    store.get().proxies = list.map((p, i) => ({ id: `${i}-${p.url}`, ...p }));
    store.save();
    return store.get().proxies;
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
    orchestrator: orchestrator.state(),
    quota: quota.snapshot(),
    chromium: chromium.status(),
    counts: {
      instances: store.get().instances.length,
      templates: store.get().taskTemplates.length,
      tasks: orchestrator.taskList({ limit: 999999 }).length
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
    const actual = await fpCheck.read({ instance: inst, webContents: findWebContents(inst) });
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
  ipcMain.handle("dm:drafts", wrap(async () => taskDrafts.list()));
  ipcMain.handle("dm:drafts:collect", wrap(async (ids) => taskDrafts.createMany(ids)));
  ipcMain.handle("dm:draft:create", wrap(async (id, mode, options) => {
    const draft = taskDrafts.create(id, mode);
    await orchestrator.saveDrafts([draft.id], options);
    return taskDrafts.list().find((d) => d.id === draft.id);
  }));
  ipcMain.handle("dm:drafts:create-many", wrap(async (ids, mode, options) => {
    const added = taskDrafts.createMany(ids, mode);
    const result = await orchestrator.saveDrafts(added.map((d) => d.id), options);
    return { ...result, ids: added.map((d) => d.id) };
  }));
  ipcMain.handle("dm:drafts:save", wrap(async (ids, options) => orchestrator.saveDrafts(ids, options)));
  ipcMain.handle("dm:draft:remove", wrap(async (id) => { orchestrator.removeDrafts([id]); return { removed: id }; }));
  ipcMain.handle("dm:drafts:remove", wrap(async (ids) => orchestrator.removeDrafts(ids)));
  ipcMain.handle("dm:drafts:submit", wrap(async (ids, options) => orchestrator.submitDrafts(ids, options)));
  ipcMain.handle("dm:task:stop", wrap(async (id) => orchestrator.stopTask(id)));

  ipcMain.handle("dm:tasks", wrap(async (filter) => orchestrator.taskList(filter || {})));
  ipcMain.handle("dm:task:retry", wrap(async (id) => orchestrator.retryTask(id, {})));
  ipcMain.handle("dm:orchestrator:state", wrap(async () => orchestrator.state()));
  ipcMain.handle("dm:orchestrator:stop-all", wrap(async () => orchestrator.stopAll({})));

  ipcMain.handle("dm:quota", wrap(async () => ({ items: quota.snapshot(), limits: quota.limits() })));
  ipcMain.handle("dm:quota:cool", wrap(async (id, minutes) => { const result = quota.cool(id, minutes || 0, "手动"); orchestrator.wakeQueue(id); return result; }));
  ipcMain.handle("dm:quota:reset", wrap(async (id) => { const result = quota.reset(id); orchestrator.wakeQueue(id); return result; }));

  ipcMain.handle("dm:update:status", wrap(async () => updater.status()));
  ipcMain.handle("dm:update:check", wrap(async () => updater.check()));
  ipcMain.handle("dm:update:download", wrap(async () => updater.download()));
  ipcMain.handle("dm:update:install", wrap(async () => {
    if (!app.isPackaged) throw new Error("开发模式不能覆盖安装，请使用已安装的版本");
    if (orchestrator.state().running.length || orchestrator.state().queued) {
      throw new Error("还有草稿或已提交任务正在执行，请完成或停止任务后再安装更新");
    }
    return updater.install(async (installer) => {
      store.save();
      interceptor.saveResources();
      if (process.platform === "darwin") {
        const error = await shell.openPath(installer);
        if (error) throw new Error(error);
        setTimeout(() => app.quit(), 200);
        return;
      }
      const { spawn } = require("node:child_process");
      const child = spawn(installer, ["/UPDATE", `/D=${path.dirname(process.execPath)}`, `/WAITPID=${process.pid}`], { detached: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      setTimeout(() => app.quit(), 200);
    });
  }));

  ipcMain.handle("dm:logs", wrap(async (limit, q) => log.recent(Number(limit) || 200, q || "")));

}

/* ------------------------------------------------------------- 编排器装配 */

orchestrator.init({
  draftsOnly: true,
  resolveDriver: async (inst) => {
    const wc = await ensureAccountWebContents(inst);
    return driverMod.open(inst, { webContents: wc });
  },
  resolveDraftDriver: async (inst, { signal } = {}) => {
    await prepareSession(inst);
    signal?.throwIfAborted();
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口已关闭，无法准备并发草稿");
    const win = new BrowserWindow({
      parent: mainWindow, show: false, width: 1280, height: 900,
      webPreferences: { partition: inst.partition, preload: webviewPreloadPath(), contextIsolation: false,
        nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: false,
        webSecurity: true, spellcheck: false, backgroundThrottling: false }
    });
    draftWindows.add(win);
    let verificationShown = false, checkingVerification = false;
    const verificationTimer = setInterval(async () => {
      if (checkingVerification || win.isDestroyed()) return;
      checkingVerification = true;
      try {
        const required = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('iframe[src*="/verifycenter/captcha"]')).some(frame => frame.getClientRects().length && getComputedStyle(frame).visibility !== 'hidden')`);
        if (required && !verificationShown) {
          verificationShown = true;
          win.setTitle(`${inst.name} · 请完成人机验证`);
          win.show(); win.focus();
          pushToUi("dm:event", { type: "draft", message: `${inst.name} 需要人机验证，请在弹出的豆包窗口完成验证，随后继续核对发送回执。`, instanceId: inst.id });
          log.warn("draft-human-verification", { instanceId: inst.id });
        }
      } catch {} finally { checkingVerification = false; }
    }, 750);
    const close = () => { clearInterval(verificationTimer); if (!win.isDestroyed()) win.destroy(); };
    win.on("closed", () => { clearInterval(verificationTimer); draftWindows.delete(win); signal?.removeEventListener("abort", close); });
    signal?.addEventListener("abort", close, { once: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await win.loadURL(new URL("/chat/", inst.url).href);
      const driver = await driverMod.open(inst, { webContents: win.webContents });
      signal?.throwIfAborted();
      driver.close = close;
      return driver;
    } catch (error) { close(); throw error; }
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
  app.on("second-instance", (_event, argv) => {
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

    Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([
      { label: brand.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
      { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }, { role: "close" }] }
    ]) : null);
    registerIpc();
    startupReady = true;
    createWindow();
    await prepareAllSessions();
    log.info("app-ready", { instances: store.get().instances.length, home: P.home(), version: brand.version });

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
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (startupReady && !appQuitting) showMainWindow();
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
}
