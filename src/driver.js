"use strict";

/**
 * 统一驱动层
 *
 * 内核写死为内嵌（应用自带的 Chromium，主窗口里的 <webview>），所以这里只剩一条路径：
 * 调用方给一个 webContents，业务层（编排器、分镜派发、登录、探活、接口）只管调方法，
 * 不再需要关心底下换的是哪个浏览器。
 */

const fs = require("node:fs");
const path = require("node:path");
const { autoKeyFor } = require("./page");
const { MIME } = require("./task-templates");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Driver {
  constructor(opts) {
    this.instance = opts.instance;
    this.key = autoKeyFor(this.instance && this.instance.id);
    this.webContents = opts.webContents || null;
    this.kernel = "embedded";
  }

  async ready(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ok = await this.evaluate(`!!(window[${JSON.stringify(this.key)}]) && document.readyState !== "loading"`);
        if (ok) return true;
      } catch {}
      await sleep(300);
    }
    return false;
  }

  async evaluate(script) {
    if (!this.webContents || this.webContents.isDestroyed?.()) throw new Error("账号网页已关闭，无法继续任务");
    return this.webContents.executeJavaScript(String(script), true);
  }

  /** 调用页面侧自动化 API */
  async call(method, ...args) {
    const argText = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(", ");
    const expr = `(function(){var a=window[${JSON.stringify(this.key)}];if(!a)return {ok:false,reason:"automation-not-ready"};return a.${method}(${argText});})()`;
    return this.evaluate(expr);
  }

  async url() {
    return this.webContents ? this.webContents.getURL() : "";
  }

  async title() {
    try { return await this.call("title"); } catch { return ""; }
  }

  async navigate(url) {
    if (this.webContents) return this.webContents.loadURL(String(url));
    return null;
  }

  async setText(text, check = () => {}) {
    const deadline = Date.now() + 10000;
    let result;
    do {
      check();
      result = await this.call("setText", text);
      if (result?.ok || !/没找到输入框/.test(result?.reason || "")) return result;
      await sleep(250);
    } while (Date.now() < deadline);
    return result;
  }
  async setGenerationOptions(options) {
    const result = await this.evaluate(`(() => { const enhancer = window[${JSON.stringify(this.key + "_enh")}]; if (!enhancer || !enhancer.setOptions) throw new Error("页面参数未就绪，请刷新账号页面"); return enhancer.setOptions(${JSON.stringify(options)}); })()`);
    return result;
  }
  async send(options, check = () => {}) {
    const deadline = Date.now() + 5000;
    for (;;) {
      check();
      const result = options ? await this.call("send", options) : await this.call("send");
      if (!options?.nativeOnly || result?.ok || !/发送按钮/.test(result?.reason || "") || Date.now() >= deadline) return result;
      // React mounts the custom confirmation send button after the input event.
      // Retry only explicit pre-click failures, never a lost click response.
      await sleep(100);
    }
  }
  async beginTask(taskId) { return this.call("beginTask", taskId); }
  async confirmGeneration() { return this.call("confirmGeneration"); }
  async readProgress() { return this.call("readProgress"); }
  async waitIdle(ms) { return this.call("waitIdle", ms); }
  async clickText(labels) { return this.call("clickText", labels); }
  async appeal(script) { return this.call("appeal", script); }
  async isLoggedIn() { return this.call("isLoggedIn"); }
  async waitForLogin({ timeoutMs = 30000, check = () => {} } = {}) {
    const deadline = Date.now() + timeoutMs;
    let result = { loggedIn: false, by: "unknown" };
    do {
      check();
      try { result = await this.isLoggedIn(); }
      catch (error) {
        if (this.webContents?.isDestroyed?.()) throw error;
        result = { loggedIn: false, by: "page-loading" };
      }
      if (result?.loggedIn === true) return result;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result;
      await sleep(Math.min(300, remaining));
    } while (true);
  }
  async loginStage() { return this.call("loginStage"); }
  async fillLogin(account, password) { return this.call("fillLogin", account, password); }

  async screenshot() {
    if (!this.webContents) return "";
    const img = await this.webContents.capturePage();
    return img.toPNG().toString("base64");
  }

  /** 传入持久化的图片/视频副本，保留真实 MIME 类型。 */
  async prepareDraftImport() {
    const debuggerApi = this.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    await debuggerApi.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    return { ok: true };
  }

  async pasteFiles(files, draft) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return { ok: false, reason: "没有可用的本地文件" };
    for (const file of list) {
      if (!fs.existsSync(file)) return { ok: false, reason: `附件不存在：${path.basename(file)}` };
      if (!MIME[path.extname(file).toLowerCase()]) return { ok: false, reason: "不支持的附件类型" };
    }

    const payload = list.map((f, i) => {
      const ext = path.extname(f).toLowerCase();
      const data = fs.readFileSync(f).toString("base64");
      return { name: path.basename(f) || `ref-${i + 1}${ext}`, dataUrl: `data:${MIME[ext]};base64,${data}` };
    });
    const r = draft ? await this.call("pasteNativeDraftFiles", payload, draft) : await this.call("pasteImages", payload);
    if (r && r.ok) return { ...r, mode: "paste" };
    return r || { ok: false, reason: "页面不接受文件" };
  }

  async cookies(domain) {
    const { readCookies } = require("./session");
    return readCookies(this.instance, domain);
  }

  async setCookies(cookies, domain) {
    const { injectCookie } = require("./session");
    return injectCookie(this.instance, cookies);
  }

  /** 页面由界面上的 webview 持有，驱动自己不做关闭 */
  close() {}
}

/**
 * 打开一个实例的驱动。
 * 内核写死内嵌：必须由调用方给 webContents（即该实例在主窗口里已打开）。
 */
async function open(instance, opts = {}) {
  if (!opts.webContents) throw new Error("内核已写死为内嵌：请先在界面打开该实例");
  const drv = new Driver({ instance, webContents: opts.webContents });
  if (!await drv.ready(opts.timeoutMs ?? 20000)) throw new Error("账号页面自动化未就绪，请检查网页加载状态后重试");
  return drv;
}

module.exports = { Driver, open, sleep };
