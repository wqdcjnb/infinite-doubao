"use strict";

// Runs a packaged app with disposable accounts; never reads the user's profile.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CDP } = require("./cdp");

(async () => {
  const runtime = process.env.DM_TEST_RUNTIME;
  assert.ok(runtime, "Set DM_TEST_RUNTIME to the packaged test executable");
  const root = path.resolve(__dirname, "..");
  const home = fs.mkdtempSync(path.join(root, "build", "ip-e2e-"));
  const P = require("../src/paths"), store = require("../src/store");
  P.init({ home }); store.load();
  store.get().settings.server.enabled = false;
  store.get().settings.orchestrator.stopHotkey = "CommandOrControl+Alt+Shift+F8";
  const account = require("../src/instances").create({ name: "IP 检测验收", url: "about:blank", proxy: { mode: "direct" } });
  store.save();
  process.env.DM_TEST_CDP_PORT ||= "9374";
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtime, [`--user-data-dir=${home}`, `--remote-debugging-port=${process.env.DM_TEST_CDP_PORT}`, "--remote-debugging-address=127.0.0.1"], { env, stdio: "ignore", windowsHide: true });
  let c;
  const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    for (let n = 0; n < 150 && !c; n++) { try { c = await CDP.attach(); } catch { await delay(); } }
    assert.ok(c, "app opens");
    const wait = async (expr) => {
      for (let n = 0; n < 350; n++) { try { if (await c.eval(expr)) return; } catch {} await delay(); }
      throw new Error("Timed out: " + expr);
    };
    await wait("state.accounts.length === 1");
    assert.equal(path.resolve((await c.eval("DM.paths()")).home), home, "isolated user data required");
    await c.eval(`state.activeId = ${JSON.stringify(account.id)}; renderList(); togglePanel('proxy')`);
    const click = (label) => c.eval(`[...document.querySelectorAll('#drawerBody button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    await click("测 IP");
    await wait("document.querySelectorAll('.proxy-probe-site').length === 2 && !proxyOperations.size");
    const direct = await c.eval("cachedProxyResult(activeAccount())");
    assert.equal(direct.mode, "direct"); assert.equal(direct.ok, true, "at least one actual live probe succeeds");
    for (const site of [direct.domestic, direct.international]) {
      if (site.ok) assert.ok(require("node:net").isIP(site.ip));
    }
    const resultText = await c.eval("document.querySelector('.proxy-probe-result').textContent");
    if (direct.domestic.countryCode === "CN") {
      assert.match(resultText, /国内 · /);
      if (direct.domestic.city) assert.ok(!resultText.includes(direct.domestic.city), "domestic city is not shown");
    }
    if (direct.international.countryCode && direct.international.countryCode !== "CN") assert.ok(resultText.includes(direct.international.city || direct.international.country));
    if (direct.differentExits) assert.match(resultText, /出口不同，可能存在分流/);
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(home, "direct.png"), Buffer.from(shot.data, "base64"));
    await c.eval("{ const s = document.querySelector('#drawerBody select'); s.value='custom'; s.dispatchEvent(new Event('change')); const i=document.querySelector('#drawerBody input'); i.value='http://127.0.0.1:9'; i.dispatchEvent(new Event('input')); }");
    assert.equal(await c.eval("cachedProxyResult(activeAccount())"), null, "editing clears previous exit");
    await click("测 IP");
    await wait("document.querySelectorAll('.proxy-probe-site').length === 2 && !proxyOperations.size");
    const failed = await c.eval("cachedProxyResult(activeAccount())");
    assert.equal(failed.ok, false, "unreachable custom proxy must not fall back to direct");
    assert.equal(await c.eval("[...document.querySelectorAll('#drawerBody button')].find(b=>b.textContent==='测 IP').disabled"), false);
    await c.eval("{ const s=document.querySelector('#drawerBody select'); s.value='direct'; s.dispatchEvent(new Event('change')); }");
    await click("测 IP");
    await wait("document.querySelectorAll('.proxy-probe-site').length === 2 && !proxyOperations.size");
    const restored = await c.eval("cachedProxyResult(activeAccount())");
    assert.equal(restored.ok, true, "switching to direct works immediately");
    assert.equal(restored.mode, "direct"); assert.notEqual(restored.checkedAt, direct.checkedAt);
    fs.writeFileSync(path.join(home, "results.json"), JSON.stringify({ direct, failed, restored }, null, 2));
    console.log("PASS packaged live IP probes, domestic/foreign labels, split exits, invalidation, failed custom proxy, direct recovery");
    console.log("Evidence: " + home);
  } finally {
    if (c) { try { await Promise.race([c.send("Browser.close"), new Promise((resolve) => setTimeout(resolve, 500))]); } catch {} c.close(); }
    child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
