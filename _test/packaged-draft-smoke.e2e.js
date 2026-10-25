"use strict";
// Bootstrap from a disposable Electron runtime. Never point userData at a real profile.
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { DM_TEST_ASAR: archive, DM_TEST_HOME: home, DM_TEST_REPORT: output } = process.env;
assert.ok(archive && home && output, "An isolated archive, profile and report are required");
assert.ok(!fs.existsSync(home), "Refuse an existing profile");
app.commandLine.appendSwitch("user-data-dir", home);
app.setPath("userData", home); app.setPath("sessionData", home);
const P = require(path.join(archive, "src/paths")), store = require(path.join(archive, "src/store"));
P.init({ home }); store.load(); store.get().settings.server.enabled = false; store.save();
const report = { passed: false, version: require(path.join(archive, "package.json")).version, checks: [] };
let finished = false;
const finish = error => {
  if (finished) return; finished = true;
  if (error) report.error = error.stack || String(error); else report.passed = true;
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  app.exit(error ? 1 : 0);
};
setTimeout(() => finish(new Error("Packaged window smoke test timed out")), 20000);
app.on("browser-window-created", (_event, win) => {
  win.webContents.once("did-finish-load", async () => {
    try {
      const evaluate = expression => win.webContents.executeJavaScript(expression, true);
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`document.querySelector('#verText')?.textContent === 'v${report.version}' && typeof DM !== 'undefined'`)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(await evaluate("document.querySelector('#verText').textContent"), `v${report.version}`);
      assert.equal(path.resolve((await evaluate("DM.paths()")).home), path.resolve(home));
      assert.equal((await evaluate("DM.call('dm:instances')")).data.length, 0);
      assert.equal((await evaluate("DM.call('dm:drafts')")).data.length, 0);
      for (const view of ["templates", "drafts", "tasks", "assets", "settings", "accounts"]) {
        await evaluate(`document.querySelector('.vtab[data-view="${view}"]').click()`);
        assert.equal(await evaluate(`document.querySelector('#view-${view}').classList.contains('active')`), true);
      }
      report.checks.push("packaged main window, version, IPC and six navigation pages");
      const source = path.resolve(__dirname, ".."), files = [];
      function walk(dir, relative = "") {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name), rel = path.join(relative, name);
          if (fs.statSync(full).isDirectory()) walk(full, rel); else files.push(rel);
        }
      }
      walk(archive);
      for (const file of files) assert.deepEqual(fs.readFileSync(path.join(archive, file)), fs.readFileSync(path.join(source, file)), file);
      const resources = path.dirname(archive);
      for (const name of fs.readdirSync(path.join(source, "src/page"))) assert.deepEqual(fs.readFileSync(path.join(resources, "page", name)), fs.readFileSync(path.join(source, "src/page", name)), name);
      report.checks.push(`${files.length} packaged source files and external page scripts exactly match checkout`);
      finish();
    } catch (error) { finish(error); }
  });
});
require(path.join(archive, "src/main.js"));
