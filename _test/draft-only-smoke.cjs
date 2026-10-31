"use strict";
// Real packaged Electron with a disposable profile and local website fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { CDP } = require("./cdp");
const runtime = process.env.DM_TEST_RUNTIME;
assert.ok(runtime, "DM_TEST_RUNTIME must point to the packaged application executable");
const output = path.resolve(process.env.DM_TEST_OUTPUT || path.join(__dirname, "../output/draft-only"));
const traditional = process.env.DM_TEST_FIXTURE_LANGUAGE === "zh-HK";
const fixtureLabel = value => traditional ? value.replaceAll("云电脑", "雲端電腦").replaceAll("新工作任务", "新工作任務").replaceAll("新对话", "新對話").replaceAll("对话", "對話") : value;
fs.mkdirSync(output, { recursive: true });
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doubao-draft-only-smoke-")));
process.env.DM_TEST_CDP_PORT ||= "9268";
const report = { home, runtime, language: traditional ? "zh-HK" : "zh-CN", checks: [], sends: [], errors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, c;
const server = http.createServer((req, res) => {
  if (req.url === "/submit") {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      report.sends.push(JSON.parse(data));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: String(10000 + report.sends.length), url: "/generated.mp4" }));
    });
    return;
  }
  if (req.url === "/result-ready") { res.setHeader("Content-Type", "application/json"); return res.end("false"); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "sessionid=local-fixture-only; Path=/" });
  const fixture = fs.readFileSync(path.join(__dirname, "native-drafts-fixture.html"), "utf8");
  const seed = "<script>if(!localStorage.getItem('fixture'))localStorage.setItem('fixture','{\"drafts\":[],\"conversations\":[]}');" + fs.readFileSync(path.join(__dirname, "native-drafts-indexeddb.js"), "utf8") + "</script>";
  res.end(fixtureLabel(fixture.replace("<script>", seed + "<script>")));
});
async function wait(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw Error("Packaged client check timed out");
}
const click = selector => c.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
const fill = (selector, value) => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
async function call(channel, ...args) {
  const result = await c.eval(`DM.call(${[channel, ...args].map(value => JSON.stringify(value)).join(",")})`);
  assert.equal(result.ok, true, result.error); return result.data;
}
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const P = require("../src/paths"), store = require("../src/store");
  P.init({ home }); store.load();
  store.add({ id: "smoke-account", name: "隔离草稿测试", url: `http://127.0.0.1:${server.address().port}/chat/` });
  // Persisted legacy settings and flags must not reactivate either service.
  store.get().settings.server.enabled = true;
  Object.assign(store.get().settings.orchestrator, { stopHotkey: "CommandOrControl+Alt+Shift+F8", autoDownload: false });
  store.save();
  const image = path.join(home, "参考图.png");
  fs.writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(runtime, [`--user-data-dir=${home}`, `--remote-debugging-port=${process.env.DM_TEST_CDP_PORT}`, "--remote-debugging-address=127.0.0.1", "--web", "--web-server"], { env, stdio: "ignore" });
  await wait(async () => { try { c = await CDP.attach(); return await c.eval("!!window.DM && document.readyState==='complete'"); } catch { c?.close(); return false; } });
  c.ws.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.method === "Runtime.exceptionThrown") report.errors.push(message.params.exceptionDetails); });
  await c.send("Runtime.enable");
  assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
  assert.deepEqual(await c.eval("Array.from(document.querySelectorAll('.vtab')).map(e=>e.dataset.view)"), ["accounts", "templates", "drafts", "tasks", "logs", "settings"]);
  assert.equal(await c.eval("document.querySelector('.view.active').id"), "view-templates");
  assert.equal(await c.eval("!!document.querySelector('#templateSubmit,#btnWeb,[data-panel=mask],#view-assets,#view-api')"), false);
  for (const channel of ["dm:template:submit", "dm:web:open", "dm:server:start", "dm:asset:grid", "dm:jianying:edit"]) {
    await assert.rejects(c.eval(`DM.call(${JSON.stringify(channel)})`), /No handler registered/);
  }
  const listeners = process.platform === "win32"
    ? execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" }).split(/\r?\n/).filter(line => {
      const fields = line.trim().split(/\s+/);
      return fields.at(-1) === String(child.pid) && fields.includes("LISTENING");
    }).join("\n")
    : execFileSync("lsof", ["-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
  assert.ok(!/:17823\b|:17825\b/.test(listeners), listeners);
  report.checks.push("Only draft workflow navigation; no retired IPC or local web/API listener, including legacy startup flags");

  for (let index = 1; index <= 2; index++) {
    await click("#templateNew");
    await wait(async () => (await call("dm:templates")).items.length === index);
    await wait(() => c.eval("document.activeElement?.id==='templateName'"));
    await fill("#templateName", `隔离模板 ${index}`); await fill("#templatePrompt", `本地验收任务 ${index}`);
    await click("#templateSave");
    await wait(() => c.eval("document.querySelector('#templateSaveState').textContent.startsWith('已保存')"));
    if (index === 2) {
      const document = await c.send("DOM.getDocument");
      const input = await c.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#templateFileInput" });
      await c.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [image] });
      await wait(() => c.eval("document.querySelectorAll('.attachment-row').length===1"));
    }
  }
  for (let index = 0; index < 2; index++) await c.eval(`document.querySelectorAll('.template-select-row input')[${index}].click()`);
  await click("#templatesAddDrafts");
  await wait(async () => (await call("dm:drafts")).length === 2);
  await wait(() => c.eval("!document.querySelector('#templateAddDraft').disabled"));
  assert.equal(await c.eval("document.querySelector('.view.active').id"), "view-templates");
  report.checks.push("Template editor and real image attachment picker; collecting multiple templates keeps editor open");
  await click('[data-view="drafts"]');
  await wait(() => c.eval("document.querySelector('#draftAccount').options.length===2"));
  await fill("#draftAccount", "smoke-account");
  await c.eval("if(!document.querySelector('#draftSelectAll').checked)document.querySelector('#draftSelectAll').click()");
  await click("#draftSave");
  await wait(async () => { const drafts = await call("dm:drafts"); return drafts.length === 2 && drafts.every(draft => draft.nativeState === "saved"); }, 90000);
  assert.equal(report.sends.length, 0);
  await wait(() => c.eval("!document.querySelector('#draftRefresh').disabled"));
  await click("#draftImported"); await click("#draftSelectAll");
  await wait(() => c.eval("!document.querySelector('#draftSubmit').disabled"));
  fs.writeFileSync(path.join(output, "drafts-saved.png"), Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  report.checks.push("Two cloud-computer native drafts saved with unique IDs and reference attachment; no send during save");
  // Keep this integration focused on acceptance; no video generation or downloads.
  await click("#draftSubmit");
  await wait(async () => (await call("dm:tasks")).length === 2 && (await call("dm:drafts")).length === 0, 90000);
  assert.equal(report.sends.length, 2);
  assert.ok(report.sends.every(send => send.mode === fixtureLabel("云电脑")));
  assert.deepEqual(report.sends.map(send => send.refs.length).sort(), [0, 1]);
  assert.equal((await call("dm:drafts")).length, 0);
  assert.ok((await call("dm:tasks")).every(task => task.status === "submitted" && task.draftBatchId));
  await click('[data-view="tasks"]');
  await wait(() => c.eval("document.querySelectorAll('#taskTable tbody tr').length===2"));
  assert.equal(await c.eval("Array.from(document.querySelectorAll('#taskTable button')).some(b=>/改派|剪映/.test(b.textContent))"), false);
  report.checks.push("Serial batch acceptance of text and image drafts; submitted records visible without retired task actions");
  await click('[data-view="settings"]'); await delay(200);
  assert.equal(await c.eval("/本地接口|素材处理组件|每实例每日条数|失败重试次数/.test(document.querySelector('#settingsBody').textContent)"), false);
  await click('[data-view="templates"]');
  await click('[data-view="accounts"]');
  assert.equal(await c.eval("document.querySelector('.view.active').id"), "view-accounts");
  await click('[data-view="templates"]');
  fs.writeFileSync(path.join(output, "client-window.png"), Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  assert.deepEqual(report.errors, []);
  report.checks.push("Account navigation, scoped settings and template screen render without JavaScript exceptions");
  report.ok = true;
})().catch(async error => {
  report.ok = false; report.error = error.stack; process.exitCode = 1;
  if (c) try {
    report.diagnostics = await c.eval("(async()=>({text:document.body.innerText.slice(-2500),drafts:await DM.call('dm:drafts'),logs:await DM.call('dm:logs',15)}))()");
    const guestSnapshot = `({url:location.href,ready:window.fixtureReady,text:document.body.innerText.slice(-4000),trace:window.fixtureTrace,editors:Array.from(document.querySelectorAll('textarea,[contenteditable=true]')).map(e=>({value:e.value,text:e.textContent,connected:e.isConnected,rect:e.getBoundingClientRect().toJSON()})),modes:Array.from(document.querySelectorAll('[data-testid=chat_input_action_mode]')).map(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON(),display:getComputedStyle(e).display})),files:Array.from(document.querySelectorAll('input[type=file]')).map(e=>e.files.length)})`;
    report.guestDiagnostics = await c.eval(`Promise.all(Array.from(document.querySelectorAll('webview')).map(async v=>{try{return await v.executeJavaScript(${JSON.stringify(guestSnapshot)})}catch(e){return {error:String(e)}}}))`);
    fs.writeFileSync(path.join(output, "failure.png"), Buffer.from((await c.send("Page.captureScreenshot")).data, "base64"));
  } catch {}
}).finally(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM"); await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  c?.close(); server.closeAllConnections(); server.close();
  fs.writeFileSync(path.join(output, "smoke-results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks, error: report.error }, null, 2));
});
