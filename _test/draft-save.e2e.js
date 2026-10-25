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
const ids = Array.from({ length: 25 }, (_, i) => drafts.create(items[i % 2].id).id); store.save();
let sends = 0, child, c;
const server = http.createServer((req, res) => {
  if (req.url === "/submit") { sends++; res.writeHead(500); return res.end("must not send"); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "sessionid=fixture-only; Path=/" });
  const seed = `<script>if(!localStorage.getItem('fixture'))localStorage.setItem('fixture','{"drafts":[],"conversations":[]}');${fs.readFileSync(path.join(__dirname, "native-drafts-indexeddb.js"), "utf8")}</script>`;
  res.end(fs.readFileSync(path.join(__dirname, "native-drafts-fixture.html"), "utf8").replace("<script>", seed + "<script>"));
});
const pause = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(100); }
  throw new Error("Save fixture timed out");
}
(async () => {
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(process.env.DM_TEST_RUNTIME, [`--user-data-dir=${home}`, `--remote-debugging-port=${process.env.DM_TEST_CDP_PORT}`, "--remote-debugging-address=127.0.0.1"], { env, stdio: "ignore", windowsHide: true });
  try {
    await wait(async () => { try { c = await CDP.attach(); return true; } catch { return false; } });
    await wait(() => c.eval("document.readyState==='complete' && typeof state!=='undefined' && state.accounts.length===1"));
    assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
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
    await wait(async () => {
      const result = await c.eval("DM.call('dm:drafts')");
      return result.ok && result.data.length===25 && result.data.every(d=>d.nativeState==='saved');
    }, 150000);
    const saved = (await c.eval("DM.call('dm:drafts')")).data;
    assert.equal(new Set(saved.map(d=>d.draftNumber)).size, 25);
    assert.ok(saved.every(d=>d.instanceId===account.id && d.nativeBinding && !d.nativeError));
    assert.equal(await page("JSON.parse(localStorage.getItem('fixture')).drafts.length"), 25);
    assert.equal(sends, 0); assert.equal((await c.eval("DM.call('dm:tasks')")).data.length, 0);
    await wait(() => c.eval("!document.querySelector('#draftSave').disabled"));
    await c.eval("document.querySelector('#draftSave').click()");
    await wait(() => c.eval("!document.querySelector('#draftSave').disabled"));
    assert.equal(await page("JSON.parse(localStorage.getItem('fixture')).drafts.length"), 25, "retry does not duplicate saved drafts");
    console.log(JSON.stringify({ saved:25, templates:2, uniqueNumbers:25, sends, elapsedMs:Date.now()-start, missingComposerRecovered:true, persistentError:true, retryDuplicates:0 }));
  } finally { c?.close(); child?.kill(); server.closeAllConnections(); server.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
