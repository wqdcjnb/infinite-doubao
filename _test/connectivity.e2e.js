"use strict";

// Runs a local video-generation fixture through the real packaged Electron UI.
// The account, cookies, prompts, and downloaded video all stay in the fixture home.
process.env.DM_TEST_CDP_PORT = process.env.DM_TEST_CDP_PORT || "9247";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { CDP } = require("./cdp");
const home = path.resolve(process.env.DM_TEST_HOME || path.join(__dirname, "../build/connectivity-userdata"));
const port = Number(process.env.DM_TEST_HTTP_PORT) || 18843;
const menuEntry = process.env.DM_TEST_VIDEO_ENTRY === "menu";
const accountId = "connectivity-local-fixture";
const templateName = "连通性本地验证";
const prompt = "本地验证：一段可播放的视频，不向豆包发送真实请求";
const confirmationPrompt = "确认，开始生成视频。";
const base = `http://127.0.0.1:${port}`;

if (process.argv.includes("--prepare")) {
  if (fs.existsSync(path.join(home, "store.json"))) throw new Error("Dedicated fixture home already exists; choose a fresh home before preparing");
  const P = require("../src/paths");
  const store = require("../src/store");
  P.init({ home });
  store.load();
  store.add({ id: accountId, name: "本地验证账号", platform: "local-fixture", url: base + "/chat" });
  Object.assign(store.get().settings, { downloadDir: path.join(home, "videos") });
  Object.assign(store.get().settings.server, { enabled: false });
  Object.assign(store.get().settings.orchestrator, { maxParallel: 1, pollInterval: 1500, autoDownload: true, taskTimeoutMs: 20000, retryLimit: 1, stopHotkey: "CommandOrControl+Alt+Shift+F9", appeal: false });
  require("../src/task-templates").create({ name: templateName, prompt, model: "seedance_v2.0_mini", duration: 5, ratio: "9:16" });
  assert.equal(store.save(), true);
  console.log(JSON.stringify({ home, url: base, debugPort: process.env.DM_TEST_CDP_PORT }));
} else {
  (async () => {
    const video = fs.readFileSync(path.join(__dirname, "clip.mp4"));
    const submissions = [];
    const mediaRequests = [];
    let generationRequests = 0;
    let confirmationRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/generated-")) {
        mediaRequests.push(req.url);
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": video.length });
        return res.end(video);
      }
      if (req.url === "/submit" && req.method === "POST") {
        let body = "";
        req.on("data", (part) => { body += part; });
        req.on("end", () => {
          const submission = JSON.parse(body);
          submissions.push(submission);
          let response;
          if (submissions.length === 1 && submission.prompt.includes(prompt)) {
            generationRequests++;
            response = { ok: true, state: "confirmation_required", messageId: "parameter-confirmation-" + Date.now(), text: "视频生成参数确认：模型：Seedance 2.0 Mini；时长：5秒；画面比例：9:16。确认后我再开始生成视频。" };
          } else if (generationRequests === 1 && confirmationRequests === 0 && submission.prompt === confirmationPrompt) {
            confirmationRequests++;
            response = { ok: true, state: "generating", messageId: "video-result-" + Date.now(), mediaUrl: "/generated-" + Date.now() + ".mp4?lr=watermark" };
          } else response = { ok: false, state: "failed", text: "生成失败：确认重复或文本不符合约定" };
          res.writeHead(response.ok ? 200 : 400, {"Content-Type":"application/json"});
          res.end(JSON.stringify(response));
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "sessionid=local-fixture-local-only; Path=/; SameSite=Lax" });
      res.end(`<!doctype html><html><head><title>本地生成验证</title><style>body{font:16px sans-serif;margin:30px}textarea{display:block;width:700px;height:140px}button{padding:10px 30px}.avatar{width:30px;height:30px}video{width:640px;height:360px}</style></head><body>
      <img class="avatar" alt="avatar" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='30'%3E%3Crect width='30' height='30' fill='green'/%3E%3C/svg%3E"><span>我的创作</span>
      <div id="messages"><div data-message-role="assistant"><div data-message-id="old-message">旧消息：已完成</div></div></div>
      <button type="button" id="new-chat">新对话</button>
      <button type="button" id="video-mode" ${menuEntry ? 'hidden role="menuitem"' : ''}>视频生成</button>
      <div id="video-options" hidden><button type="button" id="model-picker" role="button" aria-expanded="false">模型 Seedance 2.0 Fast</button><button type="button" id="duration-picker" role="button" aria-expanded="false">自动 · 10s</button></div><div id="menus"></div>
      <form id="composer"><textarea placeholder="输入提示词"></textarea>${menuEntry ? '<button type="button" id="chat-mode" aria-haspopup="menu" aria-expanded="false">对话</button><button type="button" id="skills" aria-haspopup="menu" aria-expanded="false">技能</button>' : ''}<button type="submit">生成</button></form>
      <script>
      let selectedModel='Seedance 2.0 Fast', selectedDuration=10, selectedRatio='adaptive';
      const controlEvents={modelPointerDown:0,durationPointerDown:0,durationKeys:[],skillsOpened:0};
      document.querySelector('#new-chat').onclick=()=>document.querySelector('#messages').replaceChildren();
      const chatMode=document.querySelector('#chat-mode'), skills=document.querySelector('#skills');
      if(chatMode){chatMode.onclick=()=>chatMode.setAttribute('aria-expanded',String(chatMode.getAttribute('aria-expanded')!=='true'));chatMode.onkeydown=()=>chatMode.setAttribute('aria-expanded','false');}
      if(skills)skills.onclick=()=>{skills.setAttribute('aria-expanded','true');controlEvents.skillsOpened++;setTimeout(()=>{document.querySelector('#video-mode').hidden=false;},400);};
      document.querySelector('#video-mode').onclick=()=>{document.querySelector('#video-options').hidden=false;document.querySelector('#video-mode').hidden=true;};
      document.querySelector('#model-picker').onpointerdown=(event)=>{if(event.button!==0)return;controlEvents.modelPointerDown++;event.currentTarget.setAttribute('aria-expanded','true');document.querySelector('#menus').innerHTML='<div role="menu"><button role="menuitem" data-model="Seedance 2.5">Seedance 2.5 升级</button><button role="menuitem" data-model="Seedance 2.0">Seedance 2.0 升级</button><button role="menuitem" data-model="Seedance 2.0 Fast">Seedance 2.0 Fast 快速生成</button><button role="menuitem" data-model="Seedance 2.0 Mini">Seedance 2.0 Mini 日常创作</button></div>';};
      document.querySelector('#duration-picker').onpointerdown=(event)=>{if(event.button!==0)return;controlEvents.durationPointerDown++;const opened=event.currentTarget.getAttribute('aria-expanded')==='true';event.currentTarget.setAttribute('aria-expanded',String(!opened));if(opened){document.querySelector('#menus').replaceChildren();return;}document.querySelector('#menus').innerHTML='<div role="menu" data-state="open"><span>画面比例</span>'+['adaptive','3:4','4:3','9:16','16:9','1:1','21:9'].map(r=>'<button data-ratio="'+r+'">'+(r==='adaptive'?'自动':r)+'</button>').join('')+'<span>视频时长</span><span>4s</span><div role="slider" tabindex="0" aria-label="视频时长" aria-valuemin="0" aria-valuemax="11" aria-valuenow="'+(selectedDuration-4)+'" style="width:260px;height:24px;background:lightgray"></div><span>15s</span></div>';};
      function updateDuration(){document.querySelector('#duration-picker').textContent=(selectedRatio==='adaptive'?'自动':selectedRatio)+' · '+selectedDuration+'s';}
      document.querySelector('#menus').onpointerup=(event)=>{const ratio=event.target.closest('[data-ratio]');if(ratio){selectedRatio=ratio.dataset.ratio;updateDuration();return;}const model=event.target.closest('[data-model]');if(!model)return;selectedModel=model.dataset.model;document.querySelector('#model-picker').textContent='模型 '+selectedModel;document.querySelector('#model-picker').setAttribute('aria-expanded','false');document.querySelector('#menus').replaceChildren();};
      document.querySelector('#menus').onkeydown=(event)=>{const slider=event.target.closest('[role="slider"]');if(!slider||!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();controlEvents.durationKeys.push(event.key);selectedDuration=Math.max(4,Math.min(15,selectedDuration+(event.key==='ArrowRight'?1:-1)));slider.setAttribute('aria-valuenow',String(selectedDuration-4));updateDuration();};
      function appendMessage(role,id,text){const wrapper=document.createElement('div');wrapper.dataset.messageRole=role;const row=document.createElement('div');row.dataset.messageId=id;row.textContent=text;wrapper.append(row);document.querySelector('#messages').append(wrapper);return row;}
      document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();const editor=document.querySelector('textarea');const prompt=editor.value;appendMessage('user','user-message-'+Date.now(),prompt);editor.value='';const response=await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,model:selectedModel,duration:selectedDuration,ratio:selectedRatio,controlEvents})});const result=await response.json();if(result.state==='confirmation_required'){appendMessage('assistant',result.messageId,result.text);return;}if(!result.ok){appendMessage('assistant','failed-'+Date.now(),result.text);return;}const row=appendMessage('assistant',result.messageId,'正在生成 10%');setTimeout(()=>{row.innerHTML='生成完成 100%<video controls src="'+result.mediaUrl+'"></video>';},1800);};</script>
      </body></html>`);
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    let c;
    try {
      const attachDeadline = Date.now() + 20000;
      while (!c && Date.now() < attachDeadline) {
        try { c = await CDP.attach(); }
        catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
      }
      if (!c) throw new Error("Dedicated Electron fixture did not expose its debug port");
      const wait = async (read, check, timeout = 30000) => {
        const until = Date.now() + timeout;
        let last;
        while (Date.now() < until) {
          last = await read();
          if (check(last)) return last;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error("Fixture timeout: " + JSON.stringify(last));
      };
      const paths = await c.eval("DM.paths()");
      assert.equal(path.resolve(paths.home), home);
      await wait(() => c.eval("document.querySelector('#vbServer')?.textContent"), (value) => value === "API 关");
      if (process.argv.includes("--verify-restart")) {
        const state = (await c.eval("DM.call('dm:state')")).data;
        assert.equal(state.settings.orchestrator.stopHotkey, "CommandOrControl+Alt+Shift+F8");
        assert.equal(state.settings.server.enabled, false);
        const tasks = (await c.eval("DM.call('dm:tasks')")).data;
        const previous = tasks.find((item) => item.status === "succeeded" && item.result?.files?.length);
        assert.ok(previous);
        assert.equal(Object.values(previous.confirmationIntents || {}).filter((intent) => intent.kind === "text" && intent.state === "sent").length, 1);
        assert.ok(fs.existsSync(previous.result.files[0]));
        const resources = (await c.eval("DM.call('dm:resources')")).data;
        assert.ok(resources.some((item) => item.taskId === previous.id && item.watermark === "none"));
        await c.eval("document.querySelector('.vtab[data-view=assets]').click()");
        await wait(() => c.eval("({active:document.querySelector('#view-assets').classList.contains('active'),ready:document.querySelector('#assetBody video')?.readyState,duration:document.querySelector('#assetBody video')?.duration})"), (value) => value.active && value.ready >= 1 && value.duration > 0);
        assert.equal(submissions.length, 0);
        console.log("PASS: 重启后任务、无水印状态、本地素材视频预览保留且没有重复提交");
        return;
      }
      await c.eval("document.querySelector('.vtab[data-view=templates]').click()");
      await wait(() => c.eval("document.querySelector('#templateName')?.value"), (value) => value === templateName);
      assert.equal(await c.eval("document.querySelectorAll('webview').length"), 0);
      await c.eval(`DM.call('dm:quota:reset', ${JSON.stringify(accountId)})`);
      const previousTasks = new Set((await c.eval("DM.call('dm:tasks')")).data.map((item) => item.id));
      await c.eval("document.querySelector('#templateSubmit').click()");
      const taskStates = [];
      const task = await wait(async () => {
        const result = await c.eval("DM.call('dm:tasks')");
        const current = result.data?.find((item) => !previousTasks.has(item.id));
        if (current) taskStates.push({ status: current.status, stage: current.stage });
        return current;
      }, (value) => value && ["succeeded", "failed", "cancelled"].includes(value.status), 60000);
      assert.equal(task.status, "succeeded", JSON.stringify(task));
      assert.equal(await c.eval("document.querySelector('#view-tasks').classList.contains('active')"), true);
      assert.equal(submissions.length, 2);
      assert.equal(generationRequests, 1);
      assert.equal(confirmationRequests, 1);
      assert.equal(submissions[1].prompt, confirmationPrompt);
      assert.equal(Object.values(task.confirmationIntents || {}).filter((intent) => intent.kind === "text" && intent.state === "sent").length, 1);
      assert.ok(submissions[0].prompt.includes(prompt));
      assert.equal(submissions[0].model, "Seedance 2.0 Mini");
      assert.equal(submissions[0].duration, 5);
      assert.equal(submissions[0].ratio, "9:16");
      assert.equal(task.ratio, "9:16");
      assert.equal(submissions[0].controlEvents.modelPointerDown, 1);
      assert.equal(submissions[0].controlEvents.durationPointerDown, 4);
      assert.equal(submissions[0].controlEvents.skillsOpened, menuEntry ? 1 : 0);
      assert.deepEqual(submissions[0].controlEvents.durationKeys, Array(5).fill("ArrowLeft"));
      assert.ok(mediaRequests.some((url) => url.includes("lr=unwatermarked")));
      assert.equal(task.result.files.length, 1);
      assert.deepEqual(fs.readFileSync(task.result.files[0]), video);
      const viewport = await c.eval("document.querySelector('webview').executeJavaScript('({width:innerWidth,height:innerHeight,editorWidth:document.querySelector(\"textarea\").getBoundingClientRect().width})')");
      assert.ok(viewport.width > 600 && viewport.height > 300 && viewport.editorWidth > 0, JSON.stringify(viewport));
      const library = (await c.eval("DM.call('dm:videos')")).data;
      assert.ok(library.items.some((item) => path.resolve(item.path) === path.resolve(task.result.files[0])));
      const resources = (await c.eval("DM.call('dm:resources')")).data;
      assert.ok(resources.some((item) => item.taskId === task.id && item.watermark === "none"));
      await c.eval("document.querySelector('.vtab[data-view=assets]').click()");
      await wait(() => c.eval("({active:document.querySelector('#view-assets').classList.contains('active'),ready:document.querySelector('#assetBody video')?.readyState,duration:document.querySelector('#assetBody video')?.duration})"), (value) => value.active && value.ready >= 1 && value.duration > 0);
      await c.eval("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const screenshot = await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(__dirname, "connectivity-library.png"), Buffer.from(screenshot.data, "base64"));
      const tokenOne = require("node:crypto").randomBytes(24).toString("hex");
      const tokenTwo = require("node:crypto").randomBytes(24).toString("hex");
      const saveSettings = (patch) => c.eval(`DM.saveSettings(${JSON.stringify(patch)}).then(() => true)`);
      const requestStatus = async (apiPort, token) => {
        const response = await fetch(`http://127.0.0.1:${apiPort}/api/instances`, { headers: { authorization: `Bearer ${token}`, connection: "close" }, signal: AbortSignal.timeout(3000) });
        await response.arrayBuffer();
        return response.status;
      };
      await saveSettings({ server: { enabled: true, port: 18941, token: tokenOne } });
      assert.equal(await requestStatus(18941, tokenOne), 200);
      await saveSettings({ server: { port: 18942 } });
      assert.equal(await requestStatus(18942, tokenOne), 200);
      await assert.rejects(requestStatus(18941, tokenOne));
      await saveSettings({ server: { token: tokenTwo } });
      assert.equal(await requestStatus(18942, tokenOne), 401);
      assert.equal(await requestStatus(18942, tokenTwo), 200);
      await saveSettings({ server: { enabled: false } });
      await assert.rejects(requestStatus(18942, tokenTwo));
      const hotkey = "CommandOrControl+Alt+Shift+F8";
      await saveSettings({ orchestrator: { stopHotkey: hotkey } });
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, "store.json"), "utf8")).settings.orchestrator.stopHotkey, hotkey);
      await assert.rejects(saveSettings({ orchestrator: { stopHotkey: "INVALID_SHORTCUT_NAME" } }), /无法注册/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, "store.json"), "utf8")).settings.orchestrator.stopHotkey, hotkey);
      const settingsChecks = { startService: true, rebindPort: true, oldTokenRejected: true, newTokenAccepted: true, stopService: true, hotkeyChangedAndPersisted: true, invalidHotkeyRetainsPrevious: true };
      const result = { test: "real Electron + local HTTP fixture", taskId: task.id, taskStates, viewport, submitted: submissions.length, generationRequests, confirmationRequests, confirmationText: submissions[1].prompt, controls: submissions[0].controlEvents, selectedModel: submissions[0].model, selectedDuration: submissions[0].duration, file: task.result.files[0], mediaRequests, libraryVideos: library.items.length, settingsChecks };
      fs.writeFileSync(path.join(__dirname, "connectivity-e2e-results.json"), JSON.stringify(result, null, 2));
      console.log("PASS: 任务页提交、后台自动打开账号、真实页面填写和发送、进度、严格无水印下载、素材库视频预览");
      console.log(JSON.stringify(result, null, 2));
    } finally {
      if (c) c.close();
      await new Promise((resolve) => server.close(resolve));
    }
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
