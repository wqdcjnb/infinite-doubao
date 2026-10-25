"use strict";
process.env.DM_TEST_CDP_PORT = "9263";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CDP } = require("./cdp");
const home = path.resolve(__dirname, "../build/mask-preview-userdata");
const input = path.join(home, "处理测试 #1%.jpg");

(async () => {
  const c = await CDP.attach();
  const wait = async (expression) => {
    for (let n = 0; n < 150; n++) {
      if (await c.eval(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out: " + expression);
  };
  const screenshot = async (name) => {
    const result = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(home, name), Buffer.from(result.data, "base64"));
  };
  try {
    assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
    await c.eval("document.querySelector('.vtab[data-view=settings]').click()");
    await wait("document.querySelector('#settingsBody').textContent.includes('派发与并发')");
    const settingsText = await c.eval("document.querySelector('#settingsBody').textContent");
    assert.doesNotMatch(settingsText, /页面增强|目标时长|默认模型/);
    assert.match(settingsText, /视频保存/);
    console.log("PASS: redundant global controls removed; other settings retained");
    await c.eval("document.querySelector('.vtab[data-view=accounts]').click()");
    await c.eval(`state.maskFiles = [${JSON.stringify(input)}]; document.querySelector('.tool[data-panel=mask]').click()`);
    await wait("document.querySelector('#maskList')");
    await c.eval("Array.from(document.querySelectorAll('#drawerBody button')).find(b=>b.textContent==='开始处理').click()");
    await wait("state.maskResults.length === 1 && document.querySelector('#drawerBody button.primary').disabled === false");
    const results = await c.eval("state.maskResults");
    assert.equal(results[0].kind, "image");
    assert.ok(fs.existsSync(results[0].out));
    assert.notEqual(results[0].out, input);
    await wait("Array.from(document.querySelectorAll('#drawerBody img')).some(img=>img.complete && img.naturalWidth > 0)");
    const image = await c.eval("(() => { const img=document.querySelector('#drawerBody img');return {src:img.src,width:img.naturalWidth,height:img.naturalHeight}; })()");
    assert.ok(decodeURIComponent(image.src).includes(results[0].out.replace(/\\/g, "/")));
    await c.eval("document.querySelector('#drawerBody img').scrollIntoView({block:'center'})");
    await screenshot("processed-preview.png");
    console.log("PASS: real image processing and encoded output thumbnail", JSON.stringify({ faces: results[0].faces, width: image.width, height: image.height }));
    await c.eval("document.querySelector('#drawerBody img').closest('button').click()");
    await wait("Array.from(document.querySelectorAll('.modal-mask img')).some(img=>img.complete && img.naturalWidth > 0)");
    await screenshot("processed-preview-zoom.png");
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await wait("document.querySelectorAll('.modal-mask img').length === 0");
    console.log("PASS: click to enlarge and Escape closes preview");
    await c.eval(`state.maskFiles = [${JSON.stringify(input)}]; renderPanel(); Array.from(document.querySelectorAll('#drawerBody button')).find(b=>b.textContent==='开始处理').click()`);
    await wait("state.maskResults.length === 1 && Array.from(document.querySelectorAll('#drawerBody img')).some(img=>img.complete && img.naturalWidth > 0)");
    assert.notEqual(await c.eval("document.querySelector('#drawerBody img').src"), image.src);
    console.log("PASS: repeated processing refreshes thumbnail instead of showing cached output");
    await c.eval(`state.maskFiles = [${JSON.stringify(path.join(home, "missing.jpg"))}]; renderPanel(); Array.from(document.querySelectorAll('#drawerBody button')).find(b=>b.textContent==='开始处理').click()`);
    await wait("document.querySelector('#drawerBody button.primary').disabled === false");
    assert.equal(await c.eval("document.querySelectorAll('#drawerBody img').length"), 0);
    console.log("PASS: failed processing clears old previews and restores the action button");
  } finally { c.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
