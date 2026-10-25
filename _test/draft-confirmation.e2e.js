"use strict";
// Run as the entry point of a disposable Electron copy, never the installed app.
// This fixture uses file:// only and an isolated profile; it cannot submit a video.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-draft-dom-"));
app.setPath("userData", home);
const report = { passed: false, checks: [], electron: process.versions.electron };
const fixture = path.join(__dirname, "draft-confirmation-fixture.html");
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(fixture);
  const evaluate = async source => {
    const result = await win.webContents.executeJavaScript(`(async()=>{try{return await eval(${JSON.stringify(source)})}catch(e){return {fixtureError:e.stack}}})()`, true);
    if (result?.fixtureError) throw new Error(result.fixtureError);
    return result;
  };
  await evaluate('window.CFG = { autoKey: "fixtureAutomation" };');
  for (const name of ["automation", "native-drafts"]) await evaluate(fs.readFileSync(path.join(__dirname, `../src/page/${name}.js`), "utf8"));
  const call = (method, ...args) => evaluate(`window.fixtureAutomation.${method}(${args.map(a => JSON.stringify(a)).join(",")})`);
  const items = await evaluate("window.items");
  for (const item of items) {
    await evaluate("window.reset()");
    const binding = { ...item, executionMode: "work", index: 0, titles: items.map(i => i.title) };
    const restored = await call("restoreNativeDrafts", [binding]);
    assert.equal(restored.ok, true, `draft ${Number(item.id) + 1}: ${restored.reason}`);
    assert.equal((await call("openNativeDraft", binding)).ok, true);
    assert.equal((await call("sendNativeDraft", binding)).ok, true);
  }
  const events = await evaluate("window.events");
  assert.equal(events.filter(e => e.type === "draft").length, 19);
  assert.equal(new Set(events.filter(e => e.type === "draft").map(e => e.id)).size, 19);
  assert.ok(events.some(e => e.type === "expand-heading"));
  assert.ok(events.some(e => e.type === "expand-more"));
  assert.ok(events.some(e => e.type === "load-older"));
  report.checks.push("19/19 collapsed drafts expanded, lazily loaded, matched and sent exactly once");
  await evaluate("window.reset(); window.items.splice(6); window.items.forEach(item => item.title = '【草稿编号：DB'); window.loadDelay = 1500; window.expandCount = 5;");
  const shortened = await evaluate("window.items[5]");
  const recovered = await call("restoreNativeDrafts", [{ ...shortened, executionMode: "work" }]);
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal((await call("openNativeDraft", { ...shortened, executionMode: "work" })).ok, true);
  report.checks.push("truncated titles with 1500ms lazy loading re-enumerated after DOM replacement");
  const question = "是否按以上完整方案（Seedance 2.5 / 30秒 / 16:9 / 写实电影风 / 6段分镜 / 仅环境音无对白）开始生成视频？视频生成为高消耗生成。";
  const expected = { model: "seedance_v2.5", duration: 30, ratio: "16:9" };
  await evaluate("window.reset()");
  await call("beginTask", { taskId: "confirmation-dom" });
  assert.equal((await call("peekGenerationConfirmation", expected)).kind, undefined);
  // The same text typed by the user is not a platform reminder.
  await call("setText", question);
  assert.equal((await call("peekGenerationConfirmation", expected)).kind, undefined);
  await call("setText", "");
  await evaluate(`window.reminder(${JSON.stringify(question)})`);
  const reminder = await call("peekGenerationConfirmation", expected);
  assert.equal(reminder.ok, true); assert.equal(reminder.text, "按要求生成"); assert.equal(reminder.kind, "text");
  assert.equal((await call("setText", reminder.text)).ok, true);
  assert.equal((await call("peekGenerationConfirmation", expected)).key, reminder.key);
  // A missing/disabled send button must never fall through to the panel option.
  await evaluate('document.querySelector("[data-testid=chat_input_send_button]").disabled = true');
  assert.equal((await call("send", { nativeOnly: true })).ok, false);
  await evaluate('document.querySelector("[data-testid=chat_input_send_button]").hidden = true');
  assert.equal((await call("send", { nativeOnly: true })).ok, false);
  await evaluate('Object.assign(document.querySelector("[data-testid=chat_input_send_button]"), { disabled: false, hidden: false })');
  assert.equal((await call("send", { nativeOnly: true })).ok, true);
  const finalEvents = await evaluate("window.events");
  assert.equal(finalEvents.filter(e => e.type === "confirmation").length, 1);
  assert.equal(finalEvents.filter(e => e.type === "option-click").length, 0);
  report.checks.push("real contenteditable reply uses send button; zero confirmation-panel option clicks");
  report.checks.push("user input ignored; reminder identity stable; disabled/missing send button rejected");
  // Real work-task reminder: heading outside the composer, duplicate composer
  // ids, and a textarea whose send button mounts only after a React input turn.
  await evaluate(`(()=>{window.reset();
    const panel = document.createElement('section');
    panel.innerHTML = '<h3>以上为完整方案：Seedance 2.5 模型、30 秒、16:9 横屏。是否按此参数开始生成？</h3><div>按要求生成 暂不生成</div><div id="input-engine-container"><textarea placeholder="自定义描述..."></textarea></div>';
    document.body.append(panel);
    const editor = panel.querySelector('textarea');
    editor.addEventListener('input', () => setTimeout(() => {
      if (!editor.value || panel.querySelector('button')) return;
      const send = document.createElement('button'); send.dataset.testid = 'chat_input_send_button'; send.textContent = '发送';
      send.onclick = () => window.events.push({type:'custom-confirmation', text:editor.value}); panel.append(send);
    }, 200));})()`);
  await call("beginTask", { taskId: "custom-reminder", resume: true, baselineMessageIds: [] });
  const custom = await call("peekGenerationConfirmation", expected);
  assert.equal(custom.ok, true); assert.equal(custom.text, "按要求生成");
  assert.equal((await call("setText", custom.text)).kind, "input");
  assert.equal((await call("peekGenerationConfirmation", expected)).key, custom.key);
  const Driver = require('../src/driver').Driver;
  const driver = new Driver({ instance: { id: 'fixture' }, webContents: win.webContents }); driver.key = 'fixtureAutomation';
  assert.equal((await driver.send({ nativeOnly: true })).ok, true);
  const customEvents = await evaluate("window.events.filter(e => e.type === 'custom-confirmation')");
  assert.deepEqual(customEvents, [{ type: 'custom-confirmation', text: '按要求生成' }]);
  report.checks.push("work section/textarea selected over normal editor; delayed native send appears and receives exactly one reply");
  report.passed = true;
}).catch(error => { report.error = error.stack; }).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  if (process.env.DM_TEST_REPORT) fs.writeFileSync(process.env.DM_TEST_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(report.passed ? 0 : 1);
});
