"use strict";
process.env.DM_TEST_CDP_PORT = "9235";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CDP } = require("./cdp");

(async () => {
  const c = await CDP.attach("index.html");
  const wait = async (expr) => {
    for (let n = 0; n < 80; n++) {
      try { if (await c.eval(expr)) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("等待界面超时: " + expr);
  };
  const click = (selector) => c.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  try {
    const appPaths = await c.eval("DM.paths()");
    assert.equal(path.resolve(appPaths.home), path.resolve(__dirname, "../build/task-templates-userdata"), "仅允许操作隔离测试数据");
    await wait("document.querySelector('#countText').textContent === '0'");
    assert.equal(await c.eval("document.querySelector('.list-head span').textContent"), "账号列表");
    assert.equal(await c.eval("document.querySelectorAll('.acc').length"), 0);
    assert.equal(await c.eval("document.querySelectorAll('.feat').length"), 6);
    assert.equal(await c.eval("document.querySelector('#homeRunning').textContent"), "0");
    console.log("PASS: 空账号列表与真实首页统计");

    for (const name of ["templates", "tasks", "assets", "api", "logs", "settings"]) {
      await click(`[data-home-view="${name}"]`);
      await wait(`document.querySelector('#view-${name}').classList.contains('active')`);
      await click('.vtab[data-view="accounts"]');
    }
    await click('[data-home-action="account"]');
    await wait("!document.querySelector('#accModal').classList.contains('hidden')");
    await click("#accCancel");
    await click('[data-home-action="mask"]');
    await wait("!document.querySelector('#drawer').classList.contains('hidden')");
    await click("#drawerClose");
    console.log("PASS: 首页功能入口与常用工具");

    assert.equal(await c.eval("DM.openHome()"), appPaths.downloads);
    assert.equal(fs.existsSync(appPaths.downloads), true);
    await click('.vtab[data-view="settings"]');
    await wait("Array.from(document.querySelectorAll('.s-row')).some(r => r.querySelector('label')?.textContent === '自定义目录')");
    const custom = path.resolve(__dirname, "../build/task-templates-userdata/测试成片");
    await c.eval(`(() => {const row = Array.from(document.querySelectorAll('.s-row')).find(r => r.querySelector('label')?.textContent === '自定义目录'); const input = row.querySelector('input'); input.value = ${JSON.stringify(custom)}; input.dispatchEvent(new Event('change', {bubbles:true}));})()`);
    await wait(`Array.from(document.querySelectorAll('.s-row')).some(r => r.querySelector('label')?.textContent === '当前视频目录' && r.textContent.includes(${JSON.stringify(custom)}))`);
    assert.equal((await c.eval("DM.paths()")).downloads, custom);
    assert.equal(await c.eval("DM.openHome()"), custom);
    await c.send("Page.reload");
    await wait("!!window.DM && document.querySelector('#countText').textContent === '0'");
    assert.equal((await c.eval("DM.paths()")).downloads, custom);
    await c.eval("DM.saveSettings({downloadDir:''})");
    await click('.vtab[data-view="accounts"]');
    console.log("PASS: 默认与自定义视频目录打开、设置保存与刷新保持");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1164, height: 681, deviceScaleFactor: 1, mobile: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await c.eval("document.documentElement.scrollWidth <= innerWidth"), true);
    const compact = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(__dirname, "ui-fixes-compact.png"), Buffer.from(compact.data, "base64"));
    await c.send("Emulation.clearDeviceMetricsOverride");
  } finally { c.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
