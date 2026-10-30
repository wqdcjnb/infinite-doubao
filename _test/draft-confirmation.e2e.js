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
  assert.equal(reminder.ok, true); assert.equal(reminder.text, "按要求生成"); assert.equal(reminder.kind, "text"); assert.equal(reminder.nativeOnly, true);
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
  for (const requestedReply of ["按方案生成", "开始生成"]) {
    await evaluate("window.reset()");
    const eventCount = (await evaluate("window.events")).length;
    await call("beginTask", { taskId: "fixed-reply-" + requestedReply });
    const followup = `方案已准备好，等待你确认。回来后回复 "${requestedReply}"，我就用 Seedance 2.5、30 秒、16:9 生成视频。`;
    await evaluate(`(()=>{const node=document.createElement('div');node.dataset.messageRole='assistant';node.dataset.messageId='followup';node.textContent=${JSON.stringify(followup)};document.querySelector('#messages').append(node);})()`);
    const candidate = await call("peekGenerationConfirmation", expected);
    assert.equal(candidate.ok, true); assert.equal(candidate.kind, "text");
    assert.equal(candidate.text, "按要求生成"); assert.equal(candidate.nativeOnly, true);
    assert.equal((await call("peekGenerationConfirmation", expected)).key, candidate.key);
    assert.equal((await evaluate("window.events")).length, eventCount);
  }
  report.checks.push("alternate requested reply phrases normalize to the same native conversation text without clicks");
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
  assert.equal(custom.ok, true); assert.equal(custom.text, "按要求生成"); assert.equal(custom.nativeOnly, true);
  assert.equal((await call("setText", custom.text)).kind, "input");
  assert.equal((await call("peekGenerationConfirmation", expected)).key, custom.key);
  const Driver = require('../src/driver').Driver;
  const driver = new Driver({ instance: { id: 'fixture' }, webContents: win.webContents }); driver.key = 'fixtureAutomation';
  assert.equal((await driver.send({ nativeOnly: true })).ok, true);
  const customEvents = await evaluate("window.events.filter(e => e.type === 'custom-confirmation')");
  assert.deepEqual(customEvents, [{ type: 'custom-confirmation', text: '按要求生成' }]);
  report.checks.push("work section/textarea selected over normal editor; delayed native send appears and receives exactly one reply");
  await evaluate(`(()=>{window.reset();
    document.querySelectorAll('section').forEach(n=>n.remove());
    const user=document.createElement('div'); user.dataset.messageRole='user'; user.dataset.messageId='receipt'; document.body.append(user);
    const reply=document.createElement('div'); reply.dataset.messageRole='assistant'; reply.dataset.messageId='response'; document.body.append(reply);
    reply.__reactFiber$fixture={memoizedProps:{message:{message_id:'response',status:4,final_status:{}}}};
  })()`);
  await call("beginTask", { taskId: "native-failure", resume: true, baselineMessageIds: ["receipt"] });
  assert.equal((await call("readProgress")).state, "unknown");
  await evaluate(`document.querySelector('[data-message-id="response"]').__reactFiber$fixture.memoizedProps.message.final_status.message='Timeout'`);
  assert.equal((await call("readProgress")).state, "unknown");
  await evaluate(`(()=>{const reply=document.querySelector('[data-message-id="response"]');reply.__reactFiber$fixture.memoizedProps.message.final_status={};reply.innerHTML='<span data-testid="message_box_failed_icon" style="display:inline-block;width:20px;height:20px">!</span>';})()`);
  assert.equal((await call("readProgress")).state, "unknown");
  assert.equal((await call("peekGenerationConfirmation", expected)).kind, undefined);
  report.checks.push("empty streaming, timeout and failure icon remain pending verification and stop confirmation until a settled reply");
  await evaluate(`(()=>{window.reset();document.querySelectorAll('[data-message-id]').forEach(n=>n.remove());
    const user=document.createElement('div');user.dataset.messageId='receipt';user.dataset.messageRole='user';document.body.append(user);
    const reply=document.createElement('div');reply.dataset.messageId='expired';reply.dataset.messageRole='assistant';
    reply.innerHTML='<section data-testid="preamble-elapsed" data-message-content-collapsed="true"><button aria-expanded="false">共用时 1 小时 0 分 47 秒</button><div hidden>模型：Seedance 2.5 总时长：30 秒 画面比例：16:9。分镜0—6秒、6—12秒、12—18秒、18—24秒、24—30秒。</div></section><p>方案已展示完毕，等待你确认后再开始生成。回复 "按要求生成" 即可启动，或告诉我需要调整的地方。</p>';
    const section=reply.querySelector('section'),button=section.querySelector('button');
    button.onclick=()=>{section.dataset.messageContentCollapsed='false';button.setAttribute('aria-expanded','true');section.querySelector('div').hidden=false;window.events.push({type:'expand-original-plan'});};document.body.append(reply);
  })()`);
  await call("beginTask", { taskId: "expired-original", resume: true, baselineMessageIds: ["receipt"] });
  assert.equal((await call("peekGenerationConfirmation", expected)).ok, false);
  assert.equal((await driver.expandGenerationPlan()).expanded, true);
  assert.equal((await driver.expandGenerationPlan()).expanded, false);
  assert.equal((await call("peekGenerationConfirmation", expected)).ok, true);
  assert.equal((await evaluate("window.events.filter(e=>e.type==='expand-original-plan')")).length,1);
  await evaluate(`document.querySelector('[data-message-id="expired"] section div').textContent='模型：Seedance 2.5 总时长15秒 比例16:9'`);
  assert.equal((await call("peekGenerationConfirmation", expected)).ok, false);
  report.checks.push("expired original plan expands once through the real Driver; only that same assistant supplies missing parameters");
  await evaluate(`document.querySelector('[data-message-id="expired"]').textContent='视频生成未能启动，免费体验套餐不支持创作类视频生成，需要升级正式订阅。'`);
  assert.equal((await call("readProgress")).state,"failed");
  assert.equal((await call("peekGenerationConfirmation", expected)).ok,false);
  report.checks.push("explicit startup/package rejection stops confirmation without buying, sending or borrowing another plan");
  const nativeStore=require('../src/store'),nativePaths=require('../src/paths'),orchestrator=require('../src/orchestrator');
  for(const hasInput of [true,false]){
    await evaluate(`(()=>{document.body.innerHTML='<main><div data-message-id="choice-receipt" data-message-role="user">原草稿</div><div id="provider-plan" data-message-id="choice-plan" data-message-role="assistant"></div></main><div id="input-engine-container"><div id="main-chat" contenteditable="true" role="textbox"></div><button id="main-send" data-testid="chat_input_send_button">发送</button></div><section aria-labelledby="choice-heading"><h2 id="choice-heading">任意变化的确认标题</h2><label><input type="radio" name="choice">1 按要求生成<p>使用 Seedance 2.5 生成30秒16:9视频</p></label><label><input type="radio" name="choice">2 暂不生成</label>'+(${hasInput}?' <textarea id="panel-editor"></textarea><button id="panel-send" data-testid="chat_input_send_button">发送</button>':'')+'</section>';
      window.choiceEvents=[];const reply=document.querySelector('#provider-plan');reply.textContent=${JSON.stringify(hasInput?'模型Seedance 2.5 总时长30秒 比例16:9，方案已就绪。':'是否按以上完整方案（Seedance 2.5 / 30秒 / 16:9）开始生成视频？')};
      document.querySelector('#main-send').onclick=()=>{window.choiceEvents.push({type:'main-send',text:document.querySelector('#main-chat').innerText});reply.textContent='视频正在生成 1%';};
      const button=document.querySelector('#panel-send');if(button)button.onclick=()=>{window.choiceEvents.push({type:'panel-send',text:document.querySelector('#panel-editor').value});reply.textContent='视频正在生成 1%';};
      document.querySelector('section input').onchange=()=>{window.choiceEvents.push({type:'first-option'});reply.textContent='视频正在生成 1%';};})()`);
    if(hasInput){
      await call('beginTask',{taskId:'panel-binding',resume:true,baselineMessageIds:['choice-receipt']});
      const confirmation={...expected,receiptUserMessageId:'choice-receipt'};confirmation.key=(await call('peekGenerationConfirmation',confirmation)).key;
      assert.equal((await call('fillGenerationConfirmation',confirmation)).ok,true);
      assert.equal(await evaluate('document.querySelector("#main-chat").innerText'),'');
      await evaluate('(()=>{const editor=document.querySelector("#panel-editor");editor.replaceWith(editor.cloneNode(true));})()');
      assert.equal((await call('sendGenerationConfirmation',confirmation)).ok,false,'a replaced editor must require a fresh binding');
      assert.deepEqual(await evaluate('window.choiceEvents'),[]);
      await evaluate('(()=>{const button=document.querySelector("#panel-send");button.disabled=true;document.querySelector("#panel-editor").oninput=()=>setTimeout(()=>{button.disabled=false;},350);})()');
    }
    orchestrator.stopAll();nativePaths.init({home:path.join(home,'native-choice-'+hasInput)});nativeStore.load();nativeStore.add({id:'fixture',name:'fixture'});
    Object.assign(nativeStore.get().settings.orchestrator,{autoConfirm:true,autoDownload:false});
    const task={id:'native-choice',studioTaskId:'factory-original',instanceId:'fixture',status:'submitted',receiptUserMessageId:'choice-receipt',conversationUrl:win.webContents.getURL(),baselineMessageIds:['choice-receipt'],baselineUrls:[],model:'seedance_v2.5',duration:30,ratio:'16:9',storyboardId:'board',shotId:'shot',log:[]};
    nativeStore.get().tasks.push(task);nativeStore.get().storyboards.push({id:'board',shots:[{id:'shot'}]});nativeStore.save();
    driver.navigate=async()=>{};driver.isLoggedIn=async()=>({loggedIn:true});orchestrator.init({resolveDraftDriver:async()=>driver});
    await orchestrator.confirmSubmittedTaskOnce(task.id,{checkLease(){}});
    assert.equal(await evaluate('document.querySelector("#main-chat").innerText'),'','must never write to the main chat behind a confirmation');
    assert.deepEqual(await evaluate('window.choiceEvents'),hasInput?[{type:'panel-send',text:'按要求生成'}]:[{type:'first-option'}]);
    await orchestrator.confirmSubmittedTaskOnce(task.id,{checkLease(){}});
    assert.equal((await evaluate('window.choiceEvents')).length,1);
    report.checks.push(hasInput?'factory text reply stays in the exact confirmation panel despite a visible main chat':'factory no-input panel overrides an assistant question and selects its first option exactly once');
  }
  orchestrator.stopAll();
  report.passed = true;
}).catch(error => { report.error = error.stack; }).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  if (process.env.DM_TEST_REPORT) fs.writeFileSync(process.env.DM_TEST_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(report.passed ? 0 : 1);
});
