"use strict";

// Run against a freshly built application; all mutations stay in a new, isolated home.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CDP } = require("./cdp");

(async () => {
  const runtime = process.env.DM_TEST_RUNTIME;
  if (!runtime) throw new Error("Set DM_TEST_RUNTIME to the freshly built Electron application");
  const home = fs.mkdtempSync(path.resolve(__dirname, "../build/dialog-ui-test-"));
  require("../src/paths").init({ home });
  const store = require("../src/store");
  store.load();
  store.get().settings.server.enabled = false;
  require("../src/instances").create({ name: "豆包-1", url: "about:blank" });
  const template = require("../src/task-templates").create({ name: "春日创作模板", prompt: "仅本地验证，不提交生成" });
  require("../src/task-drafts").create(template.id);
  store.save();
  process.env.DM_TEST_CDP_PORT = process.env.DM_TEST_CDP_PORT || "9274";
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(runtime, [`--user-data-dir=${home}`, `--remote-debugging-port=${process.env.DM_TEST_CDP_PORT}`, "--remote-debugging-address=127.0.0.1"], { env, windowsHide: true, stdio: "ignore" });
  const deadline = setTimeout(() => { app.kill(); console.error("Dialog test timed out"); process.exit(1); }, 90000);
  let c;
  const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    for (let n = 0; n < 100 && !c; n++) { try { c = await CDP.attach(); } catch { await delay(); } }
    assert.ok(c, "application starts");
    const wait = async (expression) => {
      for (let n = 0; n < 100; n++) { if (await c.eval(expression)) return; await delay(); }
      throw new Error("UI did not settle: " + expression);
    };
    const click = (selector) => c.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const key = async (key, code, modifiers = 0) => {
      for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, modifiers });
    };
    const shot = async (name) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(home, name + ".png"), Buffer.from(result.data, "base64"));
    };
    const read = () => JSON.parse(fs.readFileSync(path.join(home, "store.json"), "utf8"));
    await wait("document.querySelectorAll('.acc').length === 1 && !!window.DMDialogs");
    assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
    await c.eval("window.confirm = () => { throw new Error('Native confirm must not be used'); }; document.querySelector('.acc-del').focus()");
    await click(".acc-del");
    await wait("document.querySelector('#confirmDialog')?.open");
    assert.equal(await c.eval("document.activeElement.id"), "confirmCancel");
    await shot("delete-account");
    for (let n = 0; n < 5; n++) { await key("Tab", 9); assert.ok(await c.eval("!!document.activeElement.closest('#confirmDialog')")); }
    for (let n = 0; n < 5; n++) { await key("Tab", 9, 8); assert.ok(await c.eval("!!document.activeElement.closest('#confirmDialog')")); }
    await key("Escape", 27);
    await wait("!document.querySelector('#confirmDialog')");
    assert.equal(await c.eval("document.activeElement.className"), "acc-del");
    assert.equal(read().instances.length, 1);
    await click(".acc-del"); await click("#confirmCancel");
    assert.equal(read().instances.length, 1);
    await click(".acc-del");
    for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: 5, y: 5, button: "left", clickCount: 1 });
    await wait("!document.querySelector('#confirmDialog')");
    assert.equal(read().instances.length, 1);
    console.log("PASS: account deletion cancel, Escape, backdrop, safe focus, Tab containment and focus restoration");

    await c.eval(`window.dialogResult = null; void DMDialogs.confirm({ title: '删除这个账号？', message: '较长名称仍完整显示', subject: ${JSON.stringify('<img src=x onerror="window.injected=true">' + "较长的账号名称".repeat(20))}, danger: true }).then(r => window.dialogResult = r)`);
    assert.equal(await c.eval("document.querySelectorAll('#confirmDialog img').length"), 0);
    assert.equal(await c.eval("!!window.injected"), false);
    assert.equal(await c.eval("DMDialogs.confirm({title:'重复请求',message:'不得替换'})"), false);
    await c.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 520, deviceScaleFactor: 1, mobile: false });
    assert.ok(await c.eval("(() => { const r=document.querySelector('.confirm-dialog').getBoundingClientRect(); const b=document.querySelector('#confirmAccept').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && b.bottom<=innerHeight; })()"));
    await shot("compact-confirmation");
    await click("#confirmCancel");
    await wait("window.dialogResult === false");
    await c.send("Emulation.clearDeviceMetricsOverride");

    await click("#btnNew");
    await wait("document.querySelector('#accModal').open");
    assert.equal(await c.eval("document.activeElement.id"), "accName");
    await shot("add-account");
    await key("Escape", 27);
    await wait("!document.querySelector('#accModal').open");
    await click("#btnNew"); await click("#accCancel");
    assert.equal(read().instances.length, 1);
    console.log("PASS: escaped long names, compact layout, duplicate request and repeated form opening");

    await click(".acc");
    await wait("document.querySelectorAll('webview').length === 1");
    await click('.tool[data-panel="env"]');
    await wait("Array.from(document.querySelectorAll('#drawerBody button')).some(b=>b.textContent==='重新随机')");
    const fingerprint = read().instances[0].fingerprint;
    await c.eval("Array.from(document.querySelectorAll('#drawerBody button')).find(b=>b.textContent==='重新随机').click()");
    await wait("document.querySelector('#confirmDialog')?.open");
    assert.ok(await c.eval("document.querySelector('#confirmAccept').classList.contains('primary')"));
    await shot("regenerate-fingerprint"); await key("Escape", 27);
    assert.deepEqual(read().instances[0].fingerprint, fingerprint);
    await click("#drawerClose");
    console.log("PASS: fingerprint reset uses a regular confirmation; cancel preserves the profile over an embedded page");

    await click('.vtab[data-view="api"]');
    await c.eval("Array.from(document.querySelectorAll('#view-api button')).find(b=>b.textContent==='MCP').click()");
    await wait("Array.from(document.querySelectorAll('#view-api button')).some(b=>b.textContent==='查看工具清单')");
    await c.eval("Array.from(document.querySelectorAll('#view-api button')).find(b=>b.textContent==='查看工具清单').click()");
    await wait("document.querySelector('#dmModal').open");
    await shot("tool-list"); await key("Escape", 27);
    await wait("!document.querySelector('#dmModal').open");
    console.log("PASS: shared content dialog scrolls and closes with Escape");

    await click('.vtab[data-view="templates"]');
    await wait(`document.querySelector('#templateName').value === ${JSON.stringify(template.name)}`);
    await click("#templateDelete");
    await wait("document.querySelector('#confirmDialog')?.open");
    await shot("delete-template");
    await click("#confirmCancel");
    assert.equal(read().taskTemplates.length, 1);
    await click('.vtab[data-view="drafts"]');
    await wait("!!document.querySelector('#draftList .delete-icon')");
    await click("#draftList .delete-icon");
    await wait("document.querySelector('#confirmDialog')?.open");
    await shot("remove-draft");
    await click("#confirmCancel");
    assert.equal(read().taskDrafts.length, 1);
    await click("#draftList .delete-icon"); await click("#confirmAccept");
    await wait("document.querySelectorAll('#draftList .delete-icon').length === 0");
    assert.equal(read().taskDrafts.length, 0);
    assert.equal(read().taskTemplates.length, 1);
    await click('.vtab[data-view="templates"]');
    await click("#templateDelete"); await click("#confirmAccept");
    await wait("document.querySelectorAll('.template-item').length === 0");
    assert.equal(read().taskTemplates.length, 0);

    await click('.vtab[data-view="accounts"]');
    await c.eval("showFpReport({ok:true,passed:2,total:2,items:[{label:'时区',expected:'Asia/Shanghai',actual:'Asia/Shanghai',ok:true}]})");
    await wait("!!document.querySelector('dialog[aria-label=指纹体检报告][open]')");
    await shot("fingerprint-report"); await key("Escape", 27);
    await c.eval("showMaskImagePreview('data:image/svg+xml,' + encodeURIComponent('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"720\" height=\"480\"><rect width=\"720\" height=\"480\" fill=\"#eff5ff\"/></svg>'), '预览测试', document.querySelector('#btnNew'))");
    await wait("document.querySelector('#maskImagePreview img')?.naturalWidth > 0");
    await shot("image-preview"); await key("Escape", 27);
    await click(".acc-del");
    await c.eval("const accept=document.querySelector('#confirmAccept'); accept.click(); accept.click()");
    await wait("document.querySelectorAll('.acc').length === 0");
    assert.equal(read().instances.length, 0);
    await c.send("Page.reload");
    await wait("!!window.DMDialogs && document.querySelector('#countText').textContent === '0'");
    assert.equal(read().instances.length, 0);
    console.log("PASS: explicit deletion persists; templates, drafts, reports and image preview use the shared dialogs");
    console.log("Screenshots: " + home);
  } finally {
    clearTimeout(deadline);
    if (c) { try { await Promise.race([c.send("Browser.close"), new Promise((resolve) => setTimeout(resolve, 500))]); } catch {} c.close(); }
    app.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
