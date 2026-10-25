"use strict";

process.env.DM_TEST_CDP_PORT = "9236";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { CDP } = require("./cdp");
const models = [
  ["seedance_v2.5", "Seedance 2.5", 30],
  ["seedance_v2.0", "Seedance 2.0", 15],
  ["seedance_v2.0_fast", "Seedance 2.0 Fast", 15],
  ["seedance_v2.0_mini", "Seedance 2.0 Mini", 15]
];

(async () => {
  const c = await CDP.attach();
  const wait = async (expression) => {
    for (let n = 0; n < 100; n++) {
      if (await c.eval(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("等待界面超时: " + expression);
  };
  const click = (selector) => c.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const row = (label) => `Array.from(document.querySelectorAll('.s-row')).find(r => r.querySelector('label')?.textContent === ${JSON.stringify(label)})`;
  const settingModel = `${row("默认模型")}.querySelector('select')`;
  const settingDuration = `${row("目标时长（秒）")}.querySelector('input')`;
  try {
    const paths = await c.eval("DM.paths()");
    assert.equal(path.resolve(paths.home), path.resolve(__dirname, "../build/model-settings-userdata"));
    await click('.vtab[data-view="settings"]');
    await wait(`!!${row("默认模型")}`);
    assert.deepEqual(await c.eval(`Array.from(${settingModel}.options).map(o => [o.value,o.textContent])`), models.map(([value, label]) => [value, label]));
    assert.equal(await c.eval("/请求改写|不碰签名|运行内核|外挂浏览器|自带内嵌内核/.test(document.querySelector('#settingsBody').textContent)"), false);
    for (const [model, , cap] of models) {
      await c.eval(`(() => { const input = ${settingModel}; input.value = ${JSON.stringify(model)}; input.dispatchEvent(new Event('change')); })()`);
      await wait(`${settingModel}.value === ${JSON.stringify(model)} && ${settingDuration}.max === '${cap}'`);
      await c.eval(`(() => { const input = ${settingDuration}; input.value = '30'; input.dispatchEvent(new Event('change')); })()`);
      await wait(`${settingDuration}.value === '${cap}'`);
      assert.equal((await c.eval("DM.call('dm:state')")).data.settings.enhancer.duration, cap);
      await click('.vtab[data-view="templates"]');
      await click('#templateNew');
      await wait(`document.querySelector('#templateModel').value === ${JSON.stringify(model)} && document.querySelector('#templateDuration').value === '${cap}'`);
      assert.deepEqual(await c.eval("Array.from(document.querySelector('#templateModel').options).map(o => [o.value,o.textContent])"), models.map(([value, label]) => [value, label]));
      assert.equal(await c.eval("document.querySelector('#templateDuration').max"), String(cap));
      await click('.vtab[data-view="settings"]');
      await wait(`!!${row("默认模型")}`);
    }
    await c.send('Page.reload');
    await wait("!!document.querySelector('.vtab[data-view=\"settings\"]') && !!window.DM");
    await click('.vtab[data-view="settings"]');
    await wait(`!!${row("默认模型")} && ${settingModel}.value === 'seedance_v2.0_mini'`);
    assert.equal(await c.eval(`${settingDuration}.value`), '15');
    await c.send('Page.enable');
    fs.writeFileSync(path.join(__dirname, 'model-settings.png'), Buffer.from((await c.send('Page.captureScreenshot', {format:'png'})).data, 'base64'));
    await click('.vtab[data-view="templates"]');
    await wait("document.querySelectorAll('.template-item').length >= 4");
    await c.eval("Array.from(document.querySelectorAll('.template-item')).find(b => b.textContent.includes('Seedance 2.0 Mini')).click()");
    await wait("document.querySelector('#templateModel').value === 'seedance_v2.0_mini'");
    await c.eval("document.querySelector('#templateModel').value = 'seedance_v2.5'; document.querySelector('#templateModel').dispatchEvent(new Event('change')); document.querySelector('#templateDuration').value = '30'; document.querySelector('#templateModel').value = 'seedance_v2.0_fast'; document.querySelector('#templateModel').dispatchEvent(new Event('change'));");
    assert.equal(await c.eval("document.querySelector('#templateDuration').value"), '15');
    assert.equal(await c.eval("document.querySelector('#templateDuration').max"), "15");
    await click('#templateSave');
    await wait("document.querySelector('#templateSaveState').textContent.startsWith('已保存')");
    console.log('PASS: 四种模型顺序/名称一致；默认设置与模板时长限制正确；新模板继承默认模型；刷新保留；指定说明与内核区域已删除');
  } finally { c.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
