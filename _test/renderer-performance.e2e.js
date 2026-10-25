"use strict";

// QA-only entry point: this file is installed as main ONLY in performance-qa.
// Production main/renderer run unchanged against an isolated, account-free profile.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!process.versions.electron) {
  const root = path.resolve(__dirname, "..");
  const home = path.join(root, "build", "performance-userdata");
  const qa = path.join(root, "build", "performance-qa", "豆包工坊");
  const exe = path.join(qa, "豆包工坊.exe");
  assert.ok(fs.existsSync(exe), "Build the private performance-qa runtime first");
  if (fs.existsSync(path.join(home, "store.json"))) {
    assert.ok(fs.existsSync(path.join(home, "performance-fixture.json")), "Never reuse an unmarked profile");
    const data = JSON.parse(fs.readFileSync(path.join(home, "store.json"), "utf8"));
    assert.equal((data.instances || []).length, 0, "Never run against real accounts");
  }
  fs.mkdirSync(path.join(home, "videos"), { recursive: true });
  fs.writeFileSync(path.join(home, "performance-fixture.json"), JSON.stringify({ purpose: "renderer-performance", root }));
  const video = path.join(home, "videos", "性能验证 #1.mp4");
  if (!fs.existsSync(video)) {
    const ffmpeg = path.join(qa, "resources", "tools", "ffmpeg.exe");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", video], { windowsHide: true, timeout: 30000 });
  }
  fs.copyFileSync(video, path.join(home, "videos", "性能验证 #2.mp4"));
  const third = path.join(home, "videos", "性能验证 #3.mp4");
  if (fs.existsSync(third)) fs.unlinkSync(third);
  const stage = fs.mkdtempSync(path.join(root, "build", "performance-stage-"));
  for (const name of ["src", "renderer"]) fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
  fs.mkdirSync(path.join(stage, "_test"));
  for (const name of ["renderer-performance.e2e.js", "cdp.js"]) fs.copyFileSync(path.join(__dirname, name), path.join(stage, "_test", name));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  pkg.main = "_test/renderer-performance.e2e.js";
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg));
  execFileSync(process.execPath, [path.join(root, "tools", "asar.mjs"), "pack", stage, path.join(qa, "resources", "app.asar")], { windowsHide: true });
  const resultFile = path.join(home, "renderer-performance-results.json");
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
  const child = spawn(exe, [`--user-data-dir=${home}`, "--remote-debugging-port=9368", "--no-first-run"], {
    env: { ...process.env, DM_PERF_FIXTURE_HOME: home, DM_TEST_CDP_PORT: "9368" }, stdio: "inherit", windowsHide: true
  });
  const timeout = setTimeout(() => { console.error("Private performance fixture timed out"); child.kill(); }, 90000);
  child.on("error", (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.on("exit", (code) => {
    clearTimeout(timeout);
    if (fs.existsSync(resultFile)) console.log(fs.readFileSync(resultFile, "utf8"));
    process.exitCode = code || (fs.existsSync(resultFile) ? 0 : 1);
  });
} else {
  const { app, ipcMain, BrowserWindow } = require("electron");
  const home = path.resolve(process.env.DM_PERF_FIXTURE_HOME || "invalid-profile");
  assert.equal(path.basename(home), "performance-userdata");
  assert.equal(path.basename(path.dirname(home)), "build");
  assert.ok(fs.existsSync(path.join(home, "performance-fixture.json")));
  app.setPath("userData", home); app.setPath("sessionData", home);
  const P = require("../src/paths"); P.init({ home, resources: process.resourcesPath });
  const store = require("../src/store"); const data = store.load();
  assert.equal(data.instances.length, 0);
  data.settings.server.enabled = false;
  data.settings.downloadDir = path.join(home, "videos");
  data.settings.orchestrator.stopHotkey = "CommandOrControl+Alt+Shift+F7";
  data.tasks = Array.from({ length: 20 }, (_, i) => ({
    id: "performance-" + i, status: i % 2 ? "failed" : "succeeded", createdAt: "2026-10-25T00:00:00Z",
    templateName: "性能验证任务 " + i, prompt: "Local fixture only", model: "seedance_v2.0_mini", duration: 5,
    result: { files: [] }, log: []
  }));
  store.save();
  const orchestrator = require("../src/orchestrator");
  const metrics = { counts: {}, active: {}, maxActive: {}, delayedFilters: false };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
    const tracked = ["dm:state", "dm:server", "dm:tasks", "dm:videos", "dm:logs"].includes(channel);
    if (tracked) {
      metrics.counts[channel] = (metrics.counts[channel] || 0) + 1;
      metrics.active[channel] = (metrics.active[channel] || 0) + 1;
      metrics.maxActive[channel] = Math.max(metrics.maxActive[channel] || 0, metrics.active[channel]);
    }
    try {
      const result = await listener(...args);
      if (channel === "dm:tasks" && metrics.delayedFilters) await delay(args[1]?.status === "failed" ? 350 : 10);
      return result;
    } finally { if (tracked) metrics.active[channel]--; }
  });
  handle("dm:performance:fixture", async (event, action) => {
    assert.equal(path.resolve(app.getPath("userData")), home);
    if (action === "reset") { metrics.counts = {}; metrics.active = {}; metrics.maxActive = {}; }
    if (action === "delay-filters") metrics.delayedFilters = true;
    if (action === "burst") for (let i = 0; i < 100; i++) {
      orchestrator.events.emit("event", { type: "task", task: data.tasks[0] });
      orchestrator.events.emit("event", { type: "log", message: "Fixture log" });
    }
    if (action === "resources") for (let i = 0; i < 100; i++) event.sender.send("dm:resource", { downloaded: "fixture-video.mp4" });
    if (action === "new-video") {
      fs.copyFileSync(path.join(home, "videos", "性能验证 #1.mp4"), path.join(home, "videos", "性能验证 #3.mp4"));
      event.sender.send("dm:resource", { downloaded: "fixture-video.mp4" });
    }
    if (action === "logs") for (let i = 0; i < 1200; i++) event.sender.send("dm:log", { t: new Date().toISOString(), level: "info", event: "perf-log-" + String(i).padStart(4, "0") });
    return { ok: true, data: { counts: metrics.counts, maxActive: metrics.maxActive, active: metrics.active } };
  });
  require("../src/main.js");
  app.whenReady().then(async () => {
    const { CDP } = require("./cdp");
    let c;
    const wait = async (fn, description) => {
      for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(100); }
      throw new Error("Fixture timeout: " + description);
    };
    try {
      await wait(async () => { try { c = await CDP.attach(); return true; } catch { return false; } }, "CDP attach");
      await wait(() => c.eval("!!window.DM && document.querySelector('#verText')?.textContent.includes('v')"), "renderer boot");
      assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
      const click = (selector) => c.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
      const fixture = async (action) => (await c.eval(`DM.call('dm:performance:fixture',${JSON.stringify(action)})`)).data;
      const output = { fixture: home, accounts: data.instances.length };

      await click('.vtab[data-view="tasks"]');
      await wait(() => c.eval("document.querySelectorAll('#taskTable tbody tr').length===20"), "20 fixture tasks");
      await fixture("reset"); await fixture("burst");
      await wait(async () => (await fixture("metrics")).counts["dm:tasks"] >= 1, "coalesced tasks");
      await delay(250); output.burst = await fixture("metrics");
      assert.equal(output.burst.counts["dm:state"], 1); assert.equal(output.burst.counts["dm:server"] || 0, 0);
      assert.equal(output.burst.counts["dm:tasks"], 1);

      await fixture("reset"); await fixture("delay-filters");
      await click('[data-task-status="failed"]');
      await wait(async () => (await fixture("metrics")).active["dm:tasks"] === 1, "slow first filter");
      await click('[data-task-status="succeeded"]');
      await wait(() => c.eval("document.querySelectorAll('#taskTable tbody tr').length===10 && document.querySelectorAll('#taskTable tr.row-failed').length===0"), "latest filter wins");
      output.filters = await fixture("metrics"); assert.equal(output.filters.maxActive["dm:tasks"], 1); assert.equal(output.filters.counts["dm:tasks"], 2);

      await click('.vtab[data-view="assets"]');
      await wait(() => c.eval("document.querySelectorAll('#assetBody video').length===2 && document.querySelector('#assetBody video')?.readyState>=2"), "local media decoded");
      await c.eval("(async()=>{const v=window.__perfVideo=document.querySelector('#assetBody video');v.muted=true;v.loop=true;v.currentTime=0.5;await v.play();})()");
      await fixture("reset"); await fixture("resources"); await delay(300);
      output.media = await c.eval("({same:[...document.querySelectorAll('#assetBody video')].includes(window.__perfVideo),time:window.__perfVideo.currentTime,paused:window.__perfVideo.paused})");
      assert.equal(output.media.same, true); assert.equal(output.media.paused, false); assert.ok(output.media.time > 0.5);
      const mediaRequests = await fixture("metrics"); assert.equal(mediaRequests.counts["dm:videos"], 1);
      await fixture("new-video"); await wait(() => c.eval("document.querySelectorAll('#assetBody video').length===3"), "new media appended");
      assert.equal(await c.eval("[...document.querySelectorAll('#assetBody video')].includes(window.__perfVideo) && !window.__perfVideo.paused"), true);
      output.media.videoReadsForBurst = mediaRequests.counts["dm:videos"];

      await click('.vtab[data-view="logs"]'); await delay(200); await click("#logClear");
      await fixture("logs");
      await wait(() => c.eval("document.querySelector('#logBody').textContent.includes('perf-log-1199')"), "logs streamed");
      output.logRows = await c.eval("document.querySelectorAll('#logBody .log-line').length"); assert.equal(output.logRows, 400);
      const filter = async (value) => { await c.eval(`(()=>{const e=document.querySelector('#logFilter');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await delay(150); };
      await filter("perf-log-0399"); assert.equal(await c.eval("document.querySelectorAll('#logBody .log-line').length"), 0);
      await filter("perf-log-0400"); assert.equal(await c.eval("document.querySelectorAll('#logBody .log-line').length"), 1);
      output.logBuffer = 800; await filter("");
      fs.writeFileSync(path.join(home, "renderer-performance.png"), Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      fs.writeFileSync(path.join(home, "renderer-performance-results.json"), JSON.stringify({ ok: true, ...output }, null, 2));
      c.close(); app.exit(0);
    } catch (error) {
      fs.writeFileSync(path.join(home, "renderer-performance-results.json"), JSON.stringify({ ok: false, error: error.stack }, null, 2));
      if (c) c.close();
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
      app.exit(1);
    }
  });
}
