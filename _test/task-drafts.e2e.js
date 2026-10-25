"use strict";
// Dedicated profile and local fixture. Results are withheld until every selected
// draft has been sent, so waiting for generation before the next send fails.
process.env.DM_TEST_CDP_PORT = process.env.DM_TEST_CDP_PORT || "9254";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { CDP } = require("./cdp");
const home = path.resolve(process.env.DM_TEST_HOME || path.join(__dirname, "../build/native-drafts-e2e-userdata"));
const port = 18854, sent = []; let resultsReady = false;
const video = fs.readFileSync(path.join(__dirname, "clip.mp4"));
const server = http.createServer((req,res)=>{
  if(req.url.startsWith('/generated')){res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':video.length});return res.end(video);}
  if(req.url==='/result-ready'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(resultsReady));}
  if(req.url==='/submit'){let data='';req.on('data',c=>data+=c);req.on('end',()=>{sent.push(JSON.parse(data));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:String(10000+sent.length),url:'/generated-'+sent.length+'.mp4?lr=watermark'}));});return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':'sessionid=native-fixture-only; Path=/'});res.end(fs.readFileSync(path.join(__dirname,'native-drafts-fixture.html')));
});
(async()=>{
  await new Promise(r=>server.listen(port,'127.0.0.1',r));const c=await CDP.attach();
  const wait=async fn=>{for(let n=0;n<400;n++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Native fixture timeout');};
  const click=sel=>c.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const fill=(sel,value)=>c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const call=async(channel,...args)=>{const r=await c.eval(`DM.call(${[channel,...args].map(JSON.stringify).join(',')})`);assert.equal(r.ok,true,r.error);return r.data;};
  const page=code=>c.eval(`document.querySelector('webview').executeJavaScript(${JSON.stringify(code)})`);
  try{
    await wait(()=>c.eval('!!window.DM'));assert.equal(path.resolve((await c.eval('DM.paths()')).home),home);
    assert.equal((await call('dm:tasks')).length,0);assert.equal((await call('dm:drafts')).length,0);
    assert.deepEqual(await c.eval("Array.from(document.querySelectorAll('.vtab')).slice(1,4).map(b=>b.dataset.view)"),['templates','drafts','tasks']);
    await click('[data-view="drafts"]');
    await wait(()=>c.eval("document.querySelector('#draftAccount').options.length===3"));
    assert.equal(await c.eval("document.querySelector('#draftAccount').checkVisibility()"),true);
    assert.equal(await c.eval("!!document.querySelector('#draftMode')"),false);
    await click('[data-view="templates"]');
    for(let i=1;i<=3;i++){
      await click('#templateNew');await wait(async()=>(await call('dm:templates')).items.length===i);
      await wait(()=>c.eval("document.activeElement?.id==='templateName'"));
      await fill('#templateName','不同模板 '+i);await fill('#templatePrompt','相同标题前缀，独立提示词 '+i);await click('#templateSave');
      await wait(()=>c.eval("document.querySelector('#templateSaveState').textContent.startsWith('已保存')"));
    }
    const items=(await call('dm:templates')).items;
    await call('dm:template:attach',items[1].id,[path.join(__dirname,'clip.mp4')]);
    for (let i=0;i<3;i++) await c.eval(`document.querySelectorAll('.template-select-row input')[${i}].click()`);
    await click('#templatesAddDrafts');
    await wait(()=>c.eval("document.querySelector('#templateDraftStatus').checkVisibility()&&!document.querySelector('#templateAddDraft').disabled"));
    assert.equal(await c.eval("document.querySelector('#view-templates').classList.contains('active')"),true,'batch collection stays on the template page');
    assert.match(await c.eval("document.querySelector('#templateDraftStatus').textContent"),/3 条任务已加入草稿箱/);
    await click('[data-view="drafts"]');
    await wait(()=>c.eval("document.querySelectorAll('.draft-row').length===3"));
    assert.equal((await call('dm:drafts')).length,3);
    assert.ok((await call('dm:drafts')).every(d=>d.executionMode==='work'&&!d.instanceId&&!d.nativeState));
    assert.equal(await c.eval("document.querySelector('#draftSave').disabled&&document.querySelector('#draftSubmit').disabled"),true);
    assert.equal(sent.length,0);
    await fill('#draftAccount','batch-fixture-2');
    assert.equal(await c.eval("document.querySelector('#draftSave').disabled"),false);
    assert.equal(await c.eval("document.querySelector('#draftSubmit').disabled"),true);
    await click('#draftSave');
    await wait(async()=>{const ds=await call('dm:drafts');return ds.length===3&&ds.every(d=>d.nativeState==='saved');});
    await wait(()=>c.eval("!document.querySelector('#templateAddDraft').disabled"));
    assert.equal(sent.length,0);assert.equal((await call('dm:tasks')).length,0);
    assert.equal(await page("document.querySelector('aside').children.length"),3);
    const ds=await call('dm:drafts');assert.equal(new Set(ds.map(d=>d.instanceId)).size,1);
    assert.ok(ds.every(d=>d.instanceId==='batch-fixture-2'),'explicitly selected account owns the entire batch');
    assert.equal(new Set(ds.map(d=>d.nativeBinding.title)).size,1,'duplicate titles remain independent');
    console.log('PASS: dedicated drafts page between submit and queue; collect first, choose account, save three native cloud drafts together; no sends');
    await c.eval("document.querySelector('webview').reload()");
    await wait(()=>page("document.readyState==='complete'&&document.querySelector('aside').children.length===3"));
    await click('[data-view="drafts"]');await wait(()=>c.eval("document.querySelectorAll('.draft-row').length===3"));
    await fill('#draftAccount','batch-fixture-1');
    assert.equal(await c.eval("document.querySelector('#draftSubmit').disabled"),true,'wrong account cannot send bound drafts');
    await fill('#draftAccount','batch-fixture-2');
    await c.eval("document.querySelectorAll('.draft-row input')[2].click()");
    await c.eval("document.querySelector('#draftBox').scrollIntoView({block:'start'})");
    fs.writeFileSync(path.join(home,'native-drafts.png'),Buffer.from((await c.send('Page.captureScreenshot')).data,'base64'));
    await c.eval("document.querySelector('#draftSubmit').click();document.querySelector('#draftSubmit').click()");
    await wait(()=>sent.length===2);
    assert.equal(resultsReady,false);assert.ok(sent.every(s=>s.mode==='云电脑'));
    assert.ok(sent[0].prompt.includes('独立提示词 1'));assert.ok(sent[1].prompt.includes('独立提示词 2'));
    assert.equal(sent[0].refs.length,0);assert.equal(sent[1].refs.length,1);
    console.log('PASS: both drafts sent before any result, full prompts and reference attachment stay with their template');
    resultsReady=true;
    await wait(async()=>{const ts=await call('dm:tasks');return ts.length===2&&ts.every(t=>t.status==='succeeded');});
    assert.equal(sent.length,2);assert.equal((await call('dm:drafts')).length,1);
    const tasks=await call('dm:tasks');assert.equal(new Set(tasks.map(t=>t.instanceId)).size,1);
    assert.ok(tasks.every(t=>t.conversationLocked&&t.result.files.length&&t.result.files.every(f=>fs.existsSync(f))));
    assert.equal((await c.eval(`DM.call('dm:drafts:submit',${JSON.stringify(ds.slice(0,2).map(d=>d.id))})`)).ok,false);
    console.log('PASS: reload restores ambiguous titles safely, accepted tasks retrieve separate videos without resending; unselected draft retained');
    await click('[data-view="templates"]');
    await wait(()=>c.eval("!document.querySelector('#templateEditor').classList.contains('hidden')"));
    await click('#templateAddDraft');
    await wait(async()=>(await call('dm:drafts')).length===2);
    await wait(()=>c.eval("!document.querySelector('#templateAddDraft').disabled"));
    assert.equal(await c.eval("document.querySelector('#view-templates').classList.contains('active')"),true,'current template collection does not navigate');
    assert.equal(await c.eval("document.querySelector('#templateDraftStatus').checkVisibility()"),true);
    assert.match(await c.eval("document.querySelector('#templateDraftStatus').textContent"),/已加入草稿箱/);
    assert.equal(sent.length,2);
    console.log('PASS: adding current or multiple templates keeps the editor open and displays a success information bar');
  }finally{c.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);server.closeAllConnections();server.close();process.exitCode=1;});
