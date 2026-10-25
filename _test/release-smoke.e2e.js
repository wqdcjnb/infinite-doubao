"use strict";
process.env.DM_TEST_CDP_PORT = "9237";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {CDP} = require("./cdp");
(async () => {
  const c = await CDP.attach();
  const wait = async (expression) => {
    for (let n=0; n<100; n++) {
      if (await c.eval(expression)) return;
      await new Promise(r=>setTimeout(r,100));
    }
    throw new Error("等待界面超时");
  };
  try {
    const paths = await c.eval("DM.paths()");
    assert.equal(paths.home, path.resolve(__dirname, '../build/workshop-fresh-userdata'));
    assert.equal(await c.eval('document.title'), '豆包工坊');
    assert.equal(await c.eval("document.querySelector('#verText').textContent"), 'v1.2.0');
    const options = (await c.eval("DM.call('dm:templates')")).data;
    assert.deepEqual(options.options.models.map(m=>m.maxDuration), [30,15,15,15]);
    if (process.argv.includes('--verify-restart')) {
      const item = options.items.find(t=>t.name==='发布包持久化检查');
      assert.equal(item.prompt, '本地持久化验证');
      assert.equal(item.model, 'seedance_v2.0_mini');
      assert.ok(item.attachments.every(f=>fs.existsSync(f.path)));
      assert.equal((await c.eval("DM.call('dm:videos')")).data.items.length, 1);
      console.log('PASS: 发布包重启后模板、两个附件和本地成片全部保留');
      return;
    }
    assert.equal(options.items.length, 0);
    assert.equal((await c.eval("DM.call('dm:instances')")).data.length, 0);
    for (const name of ['templates','tasks','assets','api','logs','settings','accounts']) {
      await c.eval(`document.querySelector('.vtab[data-view="${name}"]').click()`);
      await wait(`document.querySelector('#view-${name}').classList.contains('active')`);
    }
    const mask = await c.eval('DM.probeMask()');
    assert.ok(mask.python.includes('department-release-1.2.0'));
    assert.ok(mask.ffmpegOk && mask.model && mask.script);
    const inputs = ['图片参考.jpg','视频参考.mp4'].map(f=>path.resolve(__dirname,'../build/workshop-mask-inputs',f));
    const output = path.join(paths.home,'成片检查');
    const result = await c.eval(`DM.runMask(${JSON.stringify({files:inputs,outDir:output})})`);
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every(r=>fs.existsSync(r.out) && r.faces>0));
    await c.eval(`DM.saveSettings({downloadDir:${JSON.stringify(output)}})`);
    const template = (await c.eval("DM.call('dm:template:create',{name:'发布包持久化检查',prompt:'本地持久化验证',model:'seedance_v2.0_mini',duration:15})")).data;
    assert.equal((await c.eval(`DM.call('dm:template:attach',${JSON.stringify(template.id)},${JSON.stringify(inputs)})`)).ok, true);
    await c.eval("document.querySelector('.vtab[data-view=\"assets\"]').click()");
    await wait("document.querySelector('#assetBody video')?.readyState>=2");
    assert.equal(await c.eval("document.querySelectorAll('.video-card').length"),1);
    console.log('PASS: 发布包名称/版本、空账号模板、全部导航、内置Python/OpenCV/FFmpeg、中文图片视频遮脸、成片解码与附件保存');
  } finally { c.close(); }
})().catch(e=>{ console.error(e); process.exitCode=1; });
