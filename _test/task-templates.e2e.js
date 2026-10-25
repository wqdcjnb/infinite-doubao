"use strict";

process.env.DM_TEST_CDP_PORT = "9235";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CDP } = require("./cdp");
const name = "新品耳机 · 生活方式短片";
const prompt = "午后阳光洒进咖啡馆，年轻人戴着白色耳机坐在窗边。镜头从耳机细节缓缓拉远，呈现轻松自然的生活氛围。画面干净，暖色光线，保持产品外观一致。";

(async () => {
  const c = await CDP.attach();
  const wait = async (expr) => {
    for (let n = 0; n < 120; n++) {
      try { if (await c.eval(expr)) return; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("等待界面超时: " + expr);
  };
  const click = (selector) => c.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value, event = "input") => c.eval(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true})); })()`);
  const list = async () => (await c.eval("DM.call('dm:templates')")).data.items;
  const openTemplate = async () => {
    await c.eval(`Array.from(document.querySelectorAll('.template-item')).find(b => b.querySelector('strong').textContent === ${JSON.stringify(name)}).click()`);
    await wait(`document.querySelector('#templateName').value === ${JSON.stringify(name)}`);
  };
  try {
    await wait("document.querySelector('#vbServer')?.textContent === 'API 关'");
    const paths = await c.eval("DM.paths()");
    assert.equal(path.resolve(paths.home), path.resolve(__dirname, "../build/task-templates-userdata"));
    assert.equal(await c.eval("document.querySelector('#view-storyboards')"), null);
    await click('.vtab[data-view="templates"]');
    await wait("document.querySelector('#templateList').childElementCount > 0");
    if (process.argv.includes("--verify-restart")) {
      const item = (await list()).find((t) => t.name === name);
      assert.ok(item);
      assert.equal(item.prompt, prompt);
      assert.equal(item.duration, 15);
      assert.equal(item.model, "seedance_v2.0");
      assert.equal(item.attachments.length, 2);
      assert.ok(item.attachments.every((f) => fs.existsSync(f.path)));
      await openTemplate();
      await wait("document.querySelectorAll('.attachment-row').length === 2");
      console.log("PASS: 关闭并重新启动程序后，模板参数和两个本地附件均保留");
      return;
    }
    assert.ok((await list()).some((t) => t.legacyId === "legacy-ui-board/legacy-ui-shot"));
    for (const template of await list()) {
      if (!template.legacyId) await c.eval(`DM.call('dm:template:remove', ${JSON.stringify(template.id)})`);
    }
    await click('.vtab[data-view="accounts"]');
    await click('.vtab[data-view="templates"]');
    await click("#templateNew");
    await wait("document.querySelector('#templateName').value.startsWith('任务模板')");
    await fill("#templateName", name);
    await fill("#templatePrompt", prompt);
    await fill("#templateModel", "seedance_v2.0", "change");
    assert.equal(await c.eval("document.querySelector('#templateDuration').options.length"), 15);
    await fill("#templateDuration", "15");
    await click("#templateSave");
    await wait("document.querySelector('#templateSaveState').textContent.startsWith('已保存')");
    console.log("PASS: 创建、保存模板及模型/时长选择");

    const inputDir = path.resolve(__dirname, "../build/task-templates-inputs");
    const files = ["参考图片.jpg", "参考视频.mp4"].map((f) => path.join(inputDir, f));
    for (const file of files) if (!fs.existsSync(file)) fs.copyFileSync(file + ".moved", file);
    const document = await c.send("DOM.getDocument");
    const input = await c.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#templateFileInput" });
    await c.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files });
    await wait("document.querySelectorAll('.attachment-row').length === 2");
    let item = (await list()).find((t) => t.name === name);
    assert.equal(item.attachments[0].mime, "image/jpeg");
    assert.equal(item.attachments[1].mime, "video/mp4");
    for (let n = 0; n < files.length; n++) {
      assert.deepEqual(fs.readFileSync(files[n]), fs.readFileSync(item.attachments[n].path));
      if (fs.existsSync(files[n] + ".moved")) fs.unlinkSync(files[n] + ".moved");
      fs.renameSync(files[n], files[n] + ".moved");
    }
    console.log("PASS: 文件选择器传入真实图片/视频，副本内容一致且不依赖原文件");

    await click('.vtab[data-view="tasks"]');
    await click('.vtab[data-view="templates"]');
    await wait("document.querySelectorAll('.attachment-row').length === 2");
    await c.send("Page.reload");
    await wait("document.querySelector('#vbServer')?.textContent === 'API 关'");
    await click('.vtab[data-view="templates"]');
    await openTemplate();
    await wait("document.querySelectorAll('.attachment-row').length === 2");
    assert.equal(await c.eval("document.querySelector('#templatePrompt').value"), prompt);
    await click("#templateSubmit");
    await wait("document.querySelector('#toasts').textContent.includes('请先在左侧打开一个账号')");
    assert.equal((await c.eval("DM.call('dm:tasks')")).data.length, 0);
    console.log("PASS: 切页、刷新保持；缺少已打开账号时提示明确，不创建假任务");

    await c.send("Page.enable");
    let shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(__dirname, "task-templates-desktop.png"), Buffer.from(shot.data, "base64"));
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1164, height: 681, deviceScaleFactor: 1, mobile: false });
    assert.equal(await c.eval("document.documentElement.scrollWidth <= innerWidth"), true);
    shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(__dirname, "task-templates-compact.png"), Buffer.from(shot.data, "base64"));
    await c.send("Emulation.clearDeviceMetricsOverride");

    await click("#templateNew");
    await wait("document.querySelector('#templateName').value.startsWith('任务模板')");
    const temporary = (await list()).find((t) => t.name.startsWith("任务模板"));
    await click("#templateDelete");
    await click("#dmModalFoot button:first-child");
    assert.ok((await list()).some((t) => t.id === temporary.id));
    await click("#templateDelete");
    await click("#dmModalFoot button:last-child");
    await wait("document.querySelector('#dmModal').classList.contains('hidden')");
    assert.equal((await list()).some((t) => t.id === temporary.id), false);
    await openTemplate();
    console.log("PASS: 模板删除与取消，桌面及小窗口布局无水平溢出");
  } finally { c.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
