"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

async function openBrowser(url, { app, shell, platform = process.platform, exists = fs.existsSync, launch = spawn, env = process.env }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]+$/.test(url)) throw new Error("无效的本机网页版地址");
  if (platform === "win32") {
    // Some Windows installations retain a stale HTTP association and show Open With.
    // Launch the registered browser executable without modifying any OS defaults.
    let registered = "";
    try { registered = (await app.getApplicationInfoForProtocol("http://")).path; } catch {}
    const candidates = [registered, path.join(env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")];
    const browser = candidates.find((file) => file && /^(chrome|msedge|firefox|brave|vivaldi|opera)\.exe$/i.test(path.win32.basename(file)) && exists(file));
    if (browser) {
      await new Promise((resolve, reject) => {
        const child = launch(browser, [url], { detached: true, stdio: "ignore" });
        child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
      });
      return;
    }
  }
  await shell.openExternal(url);
}
module.exports = { openBrowser };
