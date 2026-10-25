"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const exec = require("node:util").promisify(execFile);
const P = require("./paths");
const { verifyFile } = require("./update");

function catalog() {
  const m = JSON.parse(fs.readFileSync(P.res("optional-components.json"), "utf8"));
  if (m.platform !== process.platform || m.arch !== process.arch || !/^[a-f0-9]{64}$/.test(m.id) ||
      !/^\d+\.\d+\.\d+$/.test(m.release) || !/^DoubaoWorkshop-MediaTools-\d+\.\d+\.\d+-(?:win32-x64|darwin-(?:arm64|x64))\.tar\.gz$/.test(m.file?.name) ||
      !/^[a-f0-9]{64}$/.test(m.file.sha256) || !Number.isSafeInteger(m.file.size) || m.file.size <= 0) throw new Error("组件信息不适用于当前版本，请重新安装应用");
  return m;
}

function createManager(options = {}) {
  let current = { phase: "idle", received: 0, total: 0 }, active = null, controller;
  const read = options.catalog || catalog;
  const ready = options.ready || P.optionalDir;
  const status = () => {
    const root = ready();
    if (root) return { phase: "installed", directory: root, reason: "本地素材处理组件已就绪" };
    try { const m = read(); return { ...current, total: m.file.size }; }
    catch (error) { return { phase: "unavailable", reason: error.message }; }
  };
  const set = (patch) => { current = { ...current, ...patch }; return status(); };
  async function install() {
    if (ready()) return status();
    controller = new AbortController();
    let archive, stage;
    try {
      const m = read();
      const base = options.directory || P.dir("components");
      fs.mkdirSync(base, { recursive: true });
      archive = path.join(base, m.file.name + ".part");
      set({ phase: "downloading", received: 0, reason: "" });
      const source = new URL(require("./update").sourceUrl());
      const urls = options.urls || [new URL(m.file.name, source).href, `https://github.com/wqdcjnb/infinite-doubao/releases/download/v${m.release}/${m.file.name}`];
      let response;
      for (const url of urls) {
        const attempt = new AbortController();
        const headerTimer = setTimeout(() => attempt.abort(), 10000);
        try {
          response = await fetch(url, { signal: AbortSignal.any([controller.signal, attempt.signal, AbortSignal.timeout(30 * 60 * 1000)]), headers: { "cache-control": "no-cache" } });
          if (!response.ok || !response.body) throw new Error(`组件下载失败（HTTP ${response.status}）`);
          break;
        } catch (error) { if (controller.signal.aborted || url === urls.at(-1)) throw error; }
        finally { clearTimeout(headerTimer); }
      }
      const file = await fs.promises.open(archive, "w");
      let received = 0;
      try {
        for await (const chunk of response.body) {
          if (controller.signal.aborted) throw new Error("下载已取消");
          received += chunk.length;
          if (received > m.file.size) throw new Error("组件大小不符，请重试");
          await file.writeFile(chunk);
          current.received = received;
        }
      } finally { await file.close(); }
      set({ phase: "verifying" });
      await verifyFile(archive, m.file);
      if (controller.signal.aborted) throw new Error("下载已取消");
      set({ phase: "installing" });
      stage = fs.mkdtempSync(path.join(base, ".install-"));
      // The archive hash is pinned in the installed application's catalog.
      // Extract only after validation, into an app-owned temporary directory.
      const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
      await (options.extract || ((file, dir) => exec(tar, ["-xzf", file, "-C", dir], { windowsHide: true, timeout: 180000 })))(archive, stage);
      for (const file of P.optionalFiles()) if (!fs.existsSync(path.join(stage, file))) throw new Error("组件解压不完整，请重试");
      fs.writeFileSync(path.join(stage, "ready.json"), JSON.stringify({ id: m.id }));
      const target = path.join(base, m.id);
      // Only an incomplete component with this exact content id is replaced.
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(stage, target); stage = null;
      require("./facemask").resetProbe();
      return set({ phase: "installed", directory: target, received: m.file.size });
    } catch (error) {
      return set({ phase: controller.signal.aborted ? "idle" : "error", reason: controller.signal.aborted ? "已取消下载，可稍后重试" : String(error.message || error) });
    } finally {
      if (archive) fs.rmSync(archive, { force: true });
      if (stage) fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  return {
    status,
    install() { if (!active) active = install().finally(() => { active = null; }); return active; },
    cancel() { if (current.phase === "downloading") controller?.abort(); return status(); }
  };
}

module.exports = { catalog, createManager };
