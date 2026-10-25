"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

/** 统一订阅：返回取消函数，界面视图销毁时能干净摘掉 */
function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("DM", {
  filePath: (file) => webUtils.getPathForFile(file),
  /* ---------------- 旧界面通道（保持原样） ---------------- */
  loadStore: () => ipcRenderer.invoke("store:load"),
  saveSettings: (patch) => ipcRenderer.invoke("store:save-settings", patch),

  createAccount: (input) => ipcRenderer.invoke("account:create", input),
  updateAccount: (id, patch) => ipcRenderer.invoke("account:update", id, patch),
  removeAccount: (id) => ipcRenderer.invoke("account:remove", id),
  regenFingerprint: (id) => ipcRenderer.invoke("account:regenerate-fp", id),
  setFingerprintField: (id, patch) => ipcRenderer.invoke("account:set-fp-field", id, patch),

  testProxy: (id) => ipcRenderer.invoke("proxy:test", id),
  parseProxyList: (text) => ipcRenderer.invoke("proxy:parse-list", text),

  probeMask: () => ipcRenderer.invoke("mask:probe"),
  pickMaskFiles: () => ipcRenderer.invoke("mask:pick"),
  runMask: (input) => ipcRenderer.invoke("mask:run", input),
  onMaskProgress: (cb) => on("mask:progress", cb),

  onWatermarkProgress: (cb) => on("dm:no-watermark-progress", cb),

  showItem: (file) => ipcRenderer.invoke("shell:show-item", file),
  openPath: (p) => ipcRenderer.invoke("shell:open-path", p),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  appHome: () => ipcRenderer.invoke("app:home"),
  paths: () => ipcRenderer.invoke("app:paths"),
  openHome: () => ipcRenderer.invoke("app:open-home"),

  /* ---------------- 新界面通道 ----------------
     业务层通道全走 `dm:` 前缀，这里只放行这一个前缀，
     避免渲染进程拿通用 invoke 去碰主进程别的通道。 */
  call: (channel, ...args) => {
    if (typeof channel !== "string" || !channel.startsWith("dm:")) {
      return Promise.reject(new Error("非法通道：" + channel));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  onEvent: (cb) => on("dm:event", cb),
  onLog: (cb) => on("dm:log", cb),
  onResource: (cb) => on("dm:resource", cb),
  onAccountOpen: (cb) => on("dm:account:open", cb),
  onSettingsChanged: (cb) => on("dm:settings", cb),
  onHotkey: (cb) => on("dm:hotkey", cb)
});
