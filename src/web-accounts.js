"use strict";

const { BrowserWindow } = require("electron");
const store = require("./store");
const { Driver } = require("./driver");

class WebAccounts {
  constructor(opts) { this.opts = opts; this.windows = new Map(); this.opening = new Map(); }
  find(inst) {
    const win = this.windows.get(inst.id);
    return win && !win.isDestroyed() ? win.webContents : null;
  }
  async open(id) {
    const inst = store.find(id);
    if (!inst) throw new Error("账号不存在");
    if (this.opening.has(id)) return this.opening.get(id);
    if (this.find(inst)) return this.windows.get(id);
    const opening = this.create(inst);
    this.opening.set(id, opening);
    try { return await opening; } finally { this.opening.delete(id); }
  }
  async create(inst) {
    await this.opts.prepareSession(inst);
    const win = this.opts.createWindow ? this.opts.createWindow(inst) : new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true,
      webPreferences: { partition: inst.partition, preload: this.opts.preload(), contextIsolation: false,
        nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: false, webSecurity: true,
        backgroundThrottling: false, spellcheck: false } });
    this.windows.set(inst.id, win);
    const wc = win.webContents;
    win.on("closed", () => { if (this.windows.get(inst.id) === win) this.windows.delete(inst.id); });
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) wc.loadURL(url).catch(() => {}); return { action: "deny" }; });
    wc.on("will-navigate", (event, url) => { if (!/^https?:\/\//i.test(url)) event.preventDefault(); });
    wc.on("did-finish-load", () => this.opts.wake(inst.id));
    wc.on("did-navigate-in-page", () => this.opts.wake(inst.id));
    wc.on("console-message", (_event, level, message) => { if (level >= 2) this.opts.log.warn("web-account-console", { id: inst.id, message: String(message).slice(0, 300) }); });
    // A hidden BrowserWindow has no renderer until its first navigation.
    await wc.loadURL("about:blank");
    wc.debugger.attach("1.3");
    wc.debugger.on("message", (_event, method, params) => {
      if (method === "Page.fileChooserOpened") {
        win.fileChooser = params;
        this.opts.publish("dm:web:file-chooser", { id: inst.id, multiple: params.mode === "selectMultiple" });
      }
    });
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
    // Loading continues in the background; the browser can display progress and retry.
    wc.loadURL(inst.url || store.get().settings.defaultUrl).catch((error) => { win.loadError = error.message; });
    return win;
  }
  async handle(req, res, url, api) {
    const match = /^\/web\/account\/([^/]+)\/(open|close|frame|input|navigate|reload|files|text|selection)$/.exec(url.pathname);
    if (!match) return api.json(res, 404, { error: "账号接口不存在" });
    const [, id, action] = match;
    if ((action === "frame" ? "GET" : "POST") !== req.method) return api.json(res, 405, { error: "请求方法不匹配" });
    if (action === "close") { this.close(id); return api.json(res, 200, { ok: true }); }
    const win = await this.open(id), wc = win.webContents;
    if (action === "frame") {
      const img = await wc.capturePage(undefined, { stayHidden: true });
      const data = img.toJPEG(82);
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": data.length,
        "x-page-url": encodeURIComponent(wc.getURL()), "x-page-error": encodeURIComponent(win.loadError || ""), "x-page-loading": String(wc.isLoadingMainFrame()) });
      return res.end(data);
    }
    const input = await api.body(req);
    if (action === "open") return api.json(res, 200, { width: win.getContentSize()[0], height: win.getContentSize()[1] });
    if (action === "reload") { win.loadError = ""; wc.reload(); return api.json(res, 200, { ok: true }); }
    if (action === "navigate") {
      if (!/^https?:\/\//i.test(input.url)) throw new Error("只允许 HTTP 或 HTTPS 地址");
      win.loadError = "";
      wc.loadURL(input.url).catch((error) => { win.loadError = error.message; });
      return api.json(res, 200, { ok: true });
    }
    if (action === "text") {
      const text = String(input.text || "");
      if (text.length > 100000) throw new Error("文本过长");
      await wc.debugger.sendCommand("Input.insertText", { text });
    }
    if (action === "selection") {
      const text = await wc.executeJavaScript("(() => { const e = document.activeElement; return e && typeof e.selectionStart === 'number' ? (e.type === 'password' ? '' : e.value.slice(e.selectionStart, e.selectionEnd)) : String(window.getSelection() || ''); })()", true);
      return api.json(res, 200, { text });
    }
    if (action === "files") {
      const files = Array.isArray(input.files) ? input.files : [];
      if (!files.length || files.some((file) => !api.hasFile(file))) throw new Error("请选择已上传的素材");
      if (win.fileChooser) {
        const chooser = win.fileChooser; win.fileChooser = null;
        await wc.debugger.sendCommand("DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId });
      } else {
        const result = await new Driver({ instance: store.find(id), webContents: wc }).pasteFiles(files);
        if (!result?.ok) throw new Error(result?.reason || "页面未接受素材");
      }
    }
    if (action === "input") {
      if (input.type === "resize") {
        const width = Math.max(640, Math.min(2560, Math.round(Number(input.width) || 1280)));
        const height = Math.max(400, Math.min(1600, Math.round(Number(input.height) || 800)));
        win.setContentSize(width, height);
      } else if (["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(input.type)) {
        const params = { type: input.type, x: Math.max(0, Math.min(2560, Number(input.x) || 0)), y: Math.max(0, Math.min(1600, Number(input.y) || 0)),
          button: ["left", "middle", "right"].includes(input.button) ? input.button : "none", buttons: Number(input.buttons) & 7,
          modifiers: Number(input.modifiers) & 15 };
        if (input.type === "mouseWheel") { params.deltaX = Math.max(-4000, Math.min(4000, Number(input.deltaX) || 0)); params.deltaY = Math.max(-4000, Math.min(4000, Number(input.deltaY) || 0)); }
        else params.clickCount = Math.max(0, Math.min(3, Number(input.clickCount) || 0));
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", params);
      } else if (["keyDown", "keyUp"].includes(input.type)) {
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: input.type,
          key: String(input.key || "").slice(0, 40), code: String(input.code || "").slice(0, 40),
          windowsVirtualKeyCode: Number(input.keyCode) & 255, modifiers: Number(input.modifiers) & 15,
          ...(input.type === "keyDown" && input.key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
      } else throw new Error("不支持的输入事件");
    }
    return api.json(res, 200, { ok: true });
  }
  close(id) { const win = this.windows.get(id); if (win && !win.isDestroyed()) win.destroy(); }
  stop() { for (const id of this.windows.keys()) this.close(id); }
}

module.exports = { WebAccounts };
