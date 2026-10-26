"use strict";
// Isolated app + local website: no real account or generation requests.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { spawn } = require("node:child_process"), { CDP } = require("./cdp");
assert.ok(process.env.DM_TEST_HOME && process.env.DM_TEST_RUNTIME && process.env.DM_TEST_CDP_PORT);
const home = path.resolve(process.env.DM_TEST_HOME), port = Number(process.env.DM_TEST_FIXTURE_PORT || 18861);
assert.ok(!fs.existsSync(home), "Use a new isolated profile");
require("../src/paths").init({ home });
const store = require("../src/store"), templates = require("../src/task-templates"), drafts = require("../src/task-drafts");
store.load(); store.get().settings.server.enabled = false; store.get().settings.web = { enabled: false };
const account = store.add({ id: "save-fixture", name: "草稿保存测试", url: `http://127.0.0.1:${port}/chat/read-only?no-composer=1` });
const items = [templates.create({ name: "模板 A", prompt: "同样的视频正文", duration: 5 }), templates.create({ name: "模板 B", prompt: "另一模板的视频正文", duration: 5 })];
const ids = [];
const pictures = Array.from({length:5}, (_,i) => { const file=path.join(home, `picture-${i+1}.png`);fs.writeFileSync(file,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=","base64"));return file; });
const initialized = templates.importAttachments(items[1].id, pictures).then(() => {
  ids.push(...Array.from({ length: 25 }, (_, i) => drafts.create(items[i % 2].id).id)); store.save();
});
let sends = 0, child, c;
const server = http.createServer((req, res) => {
  if (req.url === "/submit") { sends++; res.writeHead(500); return res.end("must not send"); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "sessionid=fixture-only; Path=/" });
  const seed = `<script>window.fixtureEditorModel=true;window.fixtureUploadWithoutDisabled=true;window.fixtureUploadDelay=1500;if(!localStorage.getItem('fixture'))localStorage.setItem('fixture','{"drafts":[],"conversations":[]}');${fs.readFileSync(path.join(__dirname, "native-drafts-indexeddb.js"), "utf8")}</script>`;
  res.end(fs.readFileSync(path.join(__dirname, "native-drafts-fixture.html"), "utf8").replace("<script>", seed + "<script>"));
});
const pause = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(100); }
  throw new Error("Save fixture timed out");
}
(async () => {
  await initialized;
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(process.env.DM_TEST_RUNTIME, [`--user-data-dir=${home}`, `--remote-debugging-port=${process.env.DM_TEST_CDP_PORT}`, "--remote-debugging-address=127.0.0.1"], { env, stdio: "ignore", windowsHide: true });
  try {
    await wait(async () => { try { c = await CDP.attach(); return true; } catch { return false; } });
    await wait(() => c.eval("document.readyState==='complete' && typeof state!=='undefined' && state.accounts.length===1"));
    assert.equal(await c.eval("!!document.querySelector('#draftPending') && !!document.querySelector('#draftImported')"),true,"drafts must separate pending imports from preserved sending records");
    assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
    assert.equal(await c.eval("document.querySelector('#templateSubmit').disabled"), true);
    await c.eval("document.querySelector('#templateSubmit').click()");
    assert.equal((await c.eval("DM.call('dm:tasks')")).data.length, 0);
    await c.eval("document.querySelector('[data-view=drafts]').click();openAccount(state.accounts[0],{background:true})");
    const page = code => c.eval(`document.querySelector('webview').executeJavaScript(${JSON.stringify(code)})`);
    await wait(() => page("document.readyState==='complete' && window.fixtureReady"));
    assert.equal(await page("!!document.querySelector('textarea')"), false, "old conversation has no composer");
    await wait(() => c.eval("document.querySelector('#draftAccount').options.length===2 && document.querySelectorAll('.draft-row').length===25"));
    await c.eval(`(()=>{const e=document.querySelector('#draftAccount');e.value=${JSON.stringify(account.id)};e.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#draftSelectAll').click()})()`);
    // Surface a preparation failure and keep it readable after the toast fades.
    await page("window.savedEntry=document.querySelector('#new-work');window.savedEntry.remove()");
    await c.eval("document.querySelector('#draftSave').click()");
    await wait(() => c.eval("!document.querySelector('#draftSave').disabled"), 65000);
    assert.match(await c.eval("document.querySelector('#draftStatus').textContent"), /已存入 0\/25.*尚未就绪/);
    await pause(6200);
    assert.match(await c.eval("document.querySelector('#draftStatus').textContent"), /已存入 0\/25/);
    await page("document.body.prepend(window.savedEntry)");
    const start = Date.now();
    await c.eval("document.querySelector('#draftSave').click()");
    await wait(() => c.eval("document.querySelector('#draftStatus').textContent.includes('准备云电脑草稿')"));
    // Interrupt the first image upload, then restart the whole app with its
    // durable local 'saving' intent and no persisted website draft for that ID.
    await wait(() => page("window.fixtureTrace.some(e=>e.event==='upload-start')"));
    await page("document.querySelector('textarea').value=''");
    await wait(() => c.eval("!document.querySelector('#draftSave').disabled"));
    const interrupted = (await c.eval("DM.call('dm:drafts')")).data;
    assert.equal(interrupted.filter(d=>d.nativeState==='saved').length,1);
    assert.equal(interrupted.filter(d=>d.nativeState==='saving').length,1);
    await wait(()=>c.eval("document.querySelectorAll('.draft-row').length===24"));
    assert.match(await c.eval("document.querySelector('#draftImported').textContent"),/1/);
    assert.equal(interrupted.length,25,"moving a row must not delete its sending record");
    fs.writeFileSync(path.join(home,"drafts-pending.png"),Buffer.from((await c.send("Page.captureScreenshot")).data,"base64"));
    const retainedBeforeRestart=interrupted.find(d=>d.nativeState==='saved').nativeBinding.nativeId;
    await new Promise(resolve=>{child.once('exit',resolve);void c.eval("window.close()").catch(()=>{});});
    c.close(); c=null;
    child=spawn(process.env.DM_TEST_RUNTIME,[`--user-data-dir=${home}`,`--remote-debugging-port=${process.env.DM_TEST_CDP_PORT}`,"--remote-debugging-address=127.0.0.1"],{env,stdio:"ignore",windowsHide:true});
    await wait(async()=>{try{c=await CDP.attach();return true;}catch{return false;}});
    await wait(()=>c.eval("document.readyState==='complete' && typeof state!=='undefined' && state.accounts.length===1"));
    await c.eval("document.querySelector('[data-view=drafts]').click();openAccount(state.accounts[0],{background:true})");
    await wait(()=>page("window.fixtureReady"));
    await page("document.querySelector('#new-work').click()");
    await wait(()=>page("!!document.querySelector('textarea.ProseMirror')"));
    await wait(()=>c.eval("document.querySelectorAll('.draft-row').length===24"));
    await c.eval(`(()=>{const e=document.querySelector('#draftAccount');e.value=${JSON.stringify(account.id)};e.dispatchEvent(new Event('change',{bubbles:true}));if(!document.querySelector('#draftSelectAll').checked)document.querySelector('#draftSelectAll').click()})()`);
    const interruptedCheckStart=Date.now();
    await c.eval("document.querySelector('#draftSave').click()");
    await wait(()=>c.eval("!document.querySelector('#draftSave').disabled"));
    assert.match(await c.eval("document.querySelector('#draftStatus').textContent"),/中断.*恢复/);
    assert.ok(Date.now()-interruptedCheckStart<3000,"interrupted input must not wait sixty seconds");
    assert.equal(await c.eval("document.querySelector('#draftRecreate').disabled"),false);
    const resumed=await c.eval(`DM.call('dm:drafts:save',${JSON.stringify(ids)},{instanceId:${JSON.stringify(account.id)},recreateDeleted:true})`);
    assert.equal(resumed.ok,true,resumed.error);assert.equal(resumed.data.count,25);
    assert.equal(await page(`JSON.parse(localStorage.getItem('fixture')).drafts.filter(d=>d.id===${JSON.stringify(retainedBeforeRestart)}).length`),1);
    await wait(async () => {
      const result = await c.eval("DM.call('dm:drafts')");
      return result.ok && result.data.length===25 && result.data.every(d=>d.nativeState==='saved');
    }, 150000);
    const firstSaveMs = Date.now() - start;
    const saved = (await c.eval("DM.call('dm:drafts')")).data;
    assert.equal(new Set(saved.map(d=>d.draftNumber)).size, 25);
    assert.ok(saved.every(d=>d.instanceId===account.id && d.nativeBinding && !d.nativeError));
    assert.equal(await page("JSON.parse(localStorage.getItem('fixture')).drafts.length"), 25);
    assert.equal(sends, 0); assert.equal((await c.eval("DM.call('dm:tasks')")).data.length, 0);
    await c.eval("document.querySelector('#draftRefresh').click()");
    await wait(()=>c.eval("document.querySelectorAll('.draft-row').length===0"));
    assert.match(await c.eval("document.querySelector('#draftImported').textContent"),/25/);
    await c.eval("document.querySelector('#draftImported').click();document.querySelector('#draftSelectAll').click()");
    await wait(()=>c.eval("document.querySelectorAll('.draft-row').length===25 && !document.querySelector('#draftSubmit').disabled"));
    fs.writeFileSync(path.join(home,"drafts-imported.png"),Buffer.from((await c.send("Page.captureScreenshot")).data,"base64"));
    await wait(() => c.eval("!document.querySelector('#draftSave').disabled"));
    await c.eval("document.querySelector('#draftSave').click()");
    await wait(() => c.eval("!document.querySelector('#draftSave').disabled"));
    assert.equal(await page("JSON.parse(localStorage.getItem('fixture')).drafts.length"), 25, "retry does not duplicate saved drafts");
    // Data verification does not depend on either sidebar or composer mounting.
    await page("window.hiddenDraftSection=document.querySelector('aside');window.hiddenComposer=document.querySelector('form');hiddenDraftSection.remove();hiddenComposer.remove()");
    const hidden = await c.eval(`DM.call('dm:drafts:save',${JSON.stringify(ids)},{instanceId:${JSON.stringify(account.id)}})`);
    assert.equal(hidden.ok, true, hidden.error); assert.equal(hidden.data.count, 25);
    await page("document.body.append(hiddenDraftSection,hiddenComposer)");
    // The site no longer lists 24 entries, but the local application keeps all 25.
    const retained = await page("JSON.parse(localStorage.getItem('fixture')).drafts[0].id");
    await page("(async()=>{const s=JSON.parse(localStorage.getItem('fixture'));s.drafts=s.drafts.slice(0,1);localStorage.setItem('fixture',JSON.stringify(s));await (await window.fixtureDraftStore).sync(s)})()");
    await c.eval("document.querySelector('webview').reload()");
    await wait(()=>page("window.fixtureReady"));
    const missingStart = Date.now();
    await c.eval("document.querySelector('#draftSave').click()");
    await wait(()=>c.eval("!document.querySelector('#draftSave').disabled"));
    assert.match(await c.eval("document.querySelector('#draftStatus').textContent"), /找不到.*24.*重新存入/);
    assert.ok(Date.now()-missingStart < 3000, "missing drafts must not wait for a nonexistent sidebar");
    const recoveryStart = Date.now();
    const recovered = await c.eval(`DM.call('dm:drafts:save',${JSON.stringify(ids)},{instanceId:${JSON.stringify(account.id)},recreateDeleted:true})`);
    const recoveryMs = Date.now() - recoveryStart;
    assert.equal(recovered.ok, true, recovered.error); assert.equal(recovered.data.count, 25);
    const native = await page("JSON.parse(localStorage.getItem('fixture')).drafts.map(d=>({id:d.id,prompt:d.prompt,refs:d.refs}))");
    assert.equal(native.length, 25); assert.equal(native.filter(d=>d.id===retained).length, 1);
    assert.equal(new Set(native.map(d=>d.prompt)).size, 25); assert.equal(sends, 0);
    assert.equal(native.filter(d=>d.refs.length===5).length,12);
    console.log(JSON.stringify({ saved:25, templates:2, uniqueNumbers:25, sends, firstSaveMs, recoveryMs, elapsedMs:Date.now()-start, interruptedUploadRecovered:true, wholeAppRestarted:true, retainedBeforeRestart:1, missingComposerRecovered:true, persistentError:true, hiddenSidebarVerified:25, restoredMissing:24, retainedExisting:1, retryDuplicates:0, withAttachments:12 }));
  } finally { c?.close(); child?.kill(); server.closeAllConnections(); server.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
