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
  const account = require("../src/instances").create({ name: "IP 检测验收", url: "https://www.doubao.com/chat/", proxy: { mode: "direct" } });
  store.save();
  process.env.DM_TEST_CDP_PORT ||= "9374";
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtime, [`--user-data-dir=${home}`, `--remote-debugging-port=${process.env.DM_TEST_CDP_PORT}`, "--remote-debugging-address=127.0.0.1"], { env, stdio: "ignore", windowsHide: true });
  let c, owned = false;
  const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    for (let n = 0; n < 150 && !c; n++) { try { c = await CDP.attach(); } catch { await delay(); } }
    assert.ok(c, "app opens");
    const wait = async (expr) => {
      for (let n = 0; n < 900; n++) { try { if (await c.eval(expr)) return; } catch {} await delay(); }
      throw new Error("Timed out: " + expr);
    };
    await wait("state.accounts.length === 1");
    assert.equal(path.resolve((await c.eval("DM.paths()")).home), home, "isolated user data required");
    owned = true;
    const runtimeState = await c.eval("DM.call('dm:state')");
    assert.equal(runtimeState.ok, true);
    const version = runtimeState.data.brand.version;
    if (process.env.DM_TEST_EXPECT_VERSION) assert.equal(version, process.env.DM_TEST_EXPECT_VERSION, "test the intended packaged version");
    await c.eval(`state.activeId = ${JSON.stringify(account.id)}; renderList(); togglePanel('proxy')`);
    const click = (label) => c.eval(`[...document.querySelectorAll('#drawerBody button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    await click("测 IP");
    await wait("document.querySelectorAll('.proxy-probe-result .proxy-probe-card').length === 1 && !proxyOperations.size");
    const direct = await c.eval("cachedProxyResult(activeAccount())");
    assert.equal(direct.mode, "direct"); assert.equal(direct.ok, true, "a matching live diagnostic source succeeds");
    assert.ok(require("node:net").isIP(direct.ip));
    for (const key of ["domestic", "international", "differentExits"]) assert.equal(key in direct, false, "one flat result only");
    assert.equal(await c.eval("document.querySelectorAll('.proxy-probe-result .proxy-probe-address').length"), 1);
    assert.equal(await c.eval("document.querySelector('.proxy-probe-details').open"), false, "source and route explanation stay in collapsed details");
    const resultText = await c.eval("document.querySelector('.proxy-probe-address').textContent");
    assert.ok(resultText.includes(direct.ip));
    if (direct.countryCode === "CN") {
      assert.match(resultText, /国内 · /);
      if (direct.city) assert.ok(!resultText.includes(direct.city), "domestic city is not shown");
    } else {
      assert.ok(!resultText.includes("国内"), "direct mode does not imply a domestic IP");
      if (direct.country) assert.ok(resultText.includes(direct.country));
      if (direct.city || direct.region) assert.ok(resultText.includes(direct.city || direct.region));
    }
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(home, "direct.png"), Buffer.from(shot.data, "base64"));
    await c.eval("{ const s = document.querySelector('#drawerBody select'); s.value='custom'; s.dispatchEvent(new Event('change')); const i=document.querySelector('#drawerBody input'); i.value='http://127.0.0.1:9'; i.dispatchEvent(new Event('input')); }");
    assert.equal(await c.eval("cachedProxyResult(activeAccount())"), null, "editing clears previous exit");
    await click("测 IP");
    await wait("document.querySelectorAll('.proxy-probe-result .proxy-probe-card').length === 1 && !proxyOperations.size");
    const failed = await c.eval("cachedProxyResult(activeAccount())");
    assert.equal(failed.ok, false, "unreachable custom proxy must not fall back to direct");
    assert.ok(!failed.ip); assert.equal(await c.eval("document.querySelectorAll('.proxy-probe-result .proxy-probe-address').length"), 0);
    assert.equal(await c.eval("[...document.querySelectorAll('#drawerBody button')].find(b=>b.textContent==='测 IP').disabled"), false);
    await c.eval("{ const s=document.querySelector('#drawerBody select'); s.value='direct'; s.dispatchEvent(new Event('change')); }");
    await click("测 IP");
    await wait("document.querySelectorAll('.proxy-probe-result .proxy-probe-card').length === 1 && !proxyOperations.size");
    const restored = await c.eval("cachedProxyResult(activeAccount())");
    assert.equal(restored.ok, true, "switching to direct works immediately");
    assert.equal(restored.mode, "direct"); assert.notEqual(restored.checkedAt, direct.checkedAt);
    assert.ok(require("node:net").isIP(restored.ip));
    assert.equal(await c.eval("document.querySelectorAll('.proxy-probe-result .proxy-probe-address').length"), 1);
    fs.writeFileSync(path.join(home, "results.json"), JSON.stringify({ version, targetUrl: account.url, direct, failed, restored }, null, 2));
    console.log("PASS packaged single IP, source-based country labels, invalidation, failed custom proxy, direct recovery");
    console.log("Evidence: " + home);
  } finally {
    if (c) { if (owned) { try { await Promise.race([c.send("Browser.close"), new Promise((resolve) => setTimeout(resolve, 500))]); } catch {} } c.close(); }
    child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
