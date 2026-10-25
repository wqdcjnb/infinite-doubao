"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CDP } = require("./cdp");
const home = process.env.DM_TEST_HOME;
if (!home || !process.env.DM_TEST_CDP_PORT) throw new Error("Set a dedicated DM_TEST_HOME and DM_TEST_CDP_PORT");
const name = "视频时长滑块验证";

if (process.argv.includes("--prepare")) {
  if (fs.existsSync(path.join(home, "store.json"))) throw new Error("Choose a fresh test home");
  require("../src/paths").init({ home });
  const store = require("../src/store");
  store.load();
  store.get().settings.server.enabled = false;
  require("../src/task-templates").create({ name, prompt: "本地滑块验证，不提交生成", model: "seedance_v2.5", duration: 30 });
  assert.equal(store.save(), true);
} else {
  const deadline = setTimeout(() => { console.error("Slider test timed out"); process.exit(1); }, 90000);
  (async () => {
    const c = await CDP.attach();
    const wait = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await c.eval(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("UI did not settle: " + expression);
    };
    const selectModel = (model) => c.eval(`(() => { const m=document.querySelector('#templateModel');m.value=${JSON.stringify(model)};m.dispatchEvent(new Event('change')); })()`);
    const read = () => c.eval(`(() => { const r=document.querySelector('#templateDuration');return {type:r.type,min:r.min,max:r.max,step:r.step,value:r.value,label:document.querySelector('#templateDurationValue').value,accessible:r.getAttribute('aria-valuetext')}; })()`);
    const dragTo = async (seconds) => {
      const rect = await c.eval(`(() => { const r=document.querySelector('#templateDuration'),b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2,width:b.width,min:+r.min,max:+r.max,value:+r.value}; })()`);
      const x = (value) => rect.x + 8 + (rect.width - 16) * (value - rect.min) / (rect.max - rect.min);
      const from = x(rect.value), to = x(seconds);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from, y: rect.y });
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from + (to - from) * i / 8, y: rect.y, button: "left", buttons: 1 });
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to, y: rect.y, button: "left", clickCount: 1 });
      await wait(`document.querySelector('#templateDuration').value === '${seconds}'`);
      const state = await read();
      assert.equal(state.value, String(seconds));
      assert.equal(state.label, `${seconds} 秒`);
      assert.equal(state.accessible, state.label);
    };
    try {
      assert.equal(path.resolve((await c.eval("DM.paths()")).home), path.resolve(home));
      await wait("document.querySelector('#vbServer').textContent === 'API 关'");
      await c.eval("document.querySelector('.vtab[data-view=templates]').click()");
      await wait(`document.querySelector('#templateName').value === ${JSON.stringify(name)}`);
      if (!process.argv.includes("--verify-restart")) {
        assert.deepEqual(await read(), { type: "range", min: "4", max: "30", step: "1", value: "30", label: "30 秒", accessible: "30 秒" });
        for (const seconds of [4, 5, 30]) await dragTo(seconds);
        await selectModel("seedance_v2.0_fast");
        assert.equal((await read()).value, "15");
        for (const model of ["seedance_v2.0", "seedance_v2.0_mini", "seedance_v2.0_fast"]) {
          await selectModel(model);
          assert.deepEqual(await read(), { type: "range", min: "4", max: "15", step: "1", value: "15", label: "15 秒", accessible: "15 秒" });
        }
        await dragTo(9);
        assert.deepEqual(await c.eval("Array.from(document.querySelectorAll('#templateRatio button')).map(b=>b.textContent)"), ["自动", "3:4", "4:3", "9:16", "16:9", "1:1", "21:9"]);
        for (const ratio of ["adaptive", "3:4", "4:3", "9:16", "16:9", "1:1", "21:9", "9:16"]) {
          await c.eval(`document.querySelector('[data-ratio="${ratio}"]').click()`);
          assert.equal(await c.eval("document.querySelector('#templateRatio button[aria-pressed=true]').dataset.ratio"), ratio);
        }
        await c.eval("document.querySelector('#templateSave').click()");
        await wait("document.querySelector('#templateSaveState').textContent.startsWith('已保存')");
        const saved = (await c.eval("DM.call('dm:templates')")).data.items.find((item) => item.name === name);
        assert.equal(saved.duration, 9);
        assert.equal(saved.model, "seedance_v2.0_fast");
        assert.equal(saved.ratio, "9:16");
        await c.send("Page.reload");
        await wait("document.querySelector('#vbServer')?.textContent === 'API 关'");
        await c.eval("document.querySelector('.vtab[data-view=templates]').click()");
        await wait(`document.querySelector('#templateName').value === ${JSON.stringify(name)}`);
      }
      assert.equal((await read()).value, "9");
      assert.equal((await read()).label, "9 秒");
      assert.equal(await c.eval("document.querySelector('#templateModel').value"), "seedance_v2.0_fast");
      assert.equal(await c.eval("document.querySelector('#templateRatio').dataset.value"), "9:16");
      const screenshot = await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(home, "duration-slider.png"), Buffer.from(screenshot.data, "base64"));
      console.log("PASS: 拖动4/5/9/30秒、四种模型范围、七种比例、切换模型上限、实时读数、保存和重载");
    } finally { c.close(); clearTimeout(deadline); }
  })().catch((error) => { console.error(error); process.exitCode = 1; clearTimeout(deadline); });
}
