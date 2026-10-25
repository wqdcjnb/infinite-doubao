"use strict";

process.env.DM_TEST_CDP_PORT = "9236";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CDP } = require("./cdp");

(async () => {
  const c = await CDP.attach();
  const wait = async (expression) => {
    for (let n = 0; n < 100; n++) {
      if (await c.eval(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("等待视频界面超时: " + expression);
  };
  const click = (selector) => c.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  try {
    const paths = await c.eval('DM.paths()');
    assert.equal(path.resolve(paths.home), path.resolve(__dirname, '../build/model-settings-userdata'));
    const directory = path.join(paths.home, '成片视频');
    const file = path.join(directory, '最终视频 #1.mp4');
    if (!process.argv.includes('--verify-restart')) {
      fs.mkdirSync(directory, {recursive:true});
      fs.copyFileSync(path.join(__dirname, 'clip.mp4'), file);
      fs.writeFileSync(path.join(directory, '图片.png'), 'not a final video');
      fs.copyFileSync(path.join(__dirname, 'clip.mp4'), path.join(paths.paths.attachments, '参考视频.mp4'));
      await c.eval(`DM.saveSettings({downloadDir:${JSON.stringify(directory)}})`);
    }
    await click('.vtab[data-view="assets"]');
    await wait("document.querySelectorAll('.video-card').length === 1");
    assert.equal(await c.eval("document.querySelectorAll('[data-asset-tab]').length"), 0);
    assert.ok((await c.eval("document.querySelector('#videoDirectory').textContent")).includes(directory));
    await wait("document.querySelector('#assetBody video')?.readyState >= 2");
    assert.equal(await c.eval("(async () => { const v=document.querySelector('#assetBody video'); v.muted=true; await v.play(); return !v.paused; })()"), true);
    await wait("document.querySelector('#assetBody video').currentTime > 0.1");
    await c.eval("document.querySelector('#assetBody video').pause()");
    if (process.argv.includes('--verify-restart')) {
      console.log('PASS: 重启后成片库仍能读取、解码并播放本地视频');
      return;
    }
    await c.send('Page.enable');
    fs.writeFileSync(path.join(__dirname, 'video-library.png'), Buffer.from((await c.send('Page.captureScreenshot', {format:'png'})).data, 'base64'));
    await c.send('Emulation.setDeviceMetricsOverride', {width:1164,height:681,deviceScaleFactor:1,mobile:false});
    assert.equal(await c.eval('document.documentElement.scrollWidth <= innerWidth'), true);
    await c.send('Emulation.clearDeviceMetricsOverride');
    fs.renameSync(file, file + '.moved');
    await click('#videoRefresh');
    await wait("document.querySelectorAll('.video-card').length === 0");
    assert.ok((await c.eval("document.querySelector('#assetBody').textContent")).includes('还没有保存的成片'));
    fs.renameSync(file + '.moved', file);
    await click('#videoRefresh');
    await wait("document.querySelector('#assetBody video')?.readyState >= 2");
    await click('.vtab[data-view="tasks"]');
    assert.equal(await c.eval("document.querySelector('#assetBody video').paused"), true);
    await click('.vtab[data-view="assets"]');
    await wait("document.querySelectorAll('.video-card').length === 1");
    console.log('PASS: 成片目录读取、参考附件排除、真实视频预览播放、文件刷新与空状态、小窗口布局');
  } finally { c.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
