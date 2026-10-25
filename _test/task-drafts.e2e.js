"use strict";

// Dedicated test profile + local page only; no real account or platform requests.
process.env.DM_TEST_CDP_PORT = process.env.DM_TEST_CDP_PORT || "9254";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { CDP } = require("./cdp");
const home = path.resolve(process.env.DM_TEST_HOME || path.join(__dirname, "../build/drafts-e2e-userdata"));
const port = Number(process.env.DM_TEST_HTTP_PORT) || 18854;
const sent = [];
const video = fs.readFileSync(path.join(__dirname, "clip.mp4"));
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/generated")) { res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": video.length }); return res.end(video); }
  if (req.url === "/submit") {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => { sent.push(JSON.parse(data)); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ url: "/generated-" + sent.length + ".mp4?lr=watermark" })); });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "sessionid=drafts-fixture-only; Path=/" });
  res.end(`<!doctype html><html><body><img alt="avatar" class="avatar" width="30" height="30"><span>我的创作</span><button id="new">新工作任务</button><div id="messages"></div>
    <form id="input-engine-container"><textarea placeholder="创建任务" style="width:600px;height:100px"></textarea><button type="button" data-testid="chat_input_action_mode">对话</button><button type="submit">发送</button></form><script>
    const mode=document.querySelector('[data-testid="chat_input_action_mode"]'), editor=document.querySelector('textarea'), messages=document.querySelector('#messages');
    document.querySelector('#new').onclick=()=>{mode.textContent='云电脑';messages.replaceChildren();editor.value='';};
    document.querySelector('form').onsubmit=async(event)=>{event.preventDefault();const prompt=editor.value;editor.value='';const result=await (await fetch('/submit',{method:'POST',body:JSON.stringify({prompt,mode:mode.textContent})})).json();
    const user=document.createElement('div');user.dataset.messageRole='user';user.dataset.messageId='user-'+Date.now();user.textContent=prompt;messages.append(user);
    const output=document.createElement('div');output.dataset.messageRole='assistant';output.dataset.messageId='reply-'+Date.now();output.textContent='正在生成 10%';messages.append(output);
    setTimeout(()=>{output.innerHTML='生成完成 100%<video src="'+result.url+'" controls></video>';},250);};
    </script></body></html>`);
});
(async () => {
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const c = await CDP.attach();
  const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("Fixture wait timed out"); };
  const click = (sel) => c.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const fill = (sel, value) => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const call = async (channel, ...args) => { const r = await c.eval(`DM.call(${[channel, ...args].map(JSON.stringify).join(",")})`); assert.equal(r.ok, true, r.error); return r.data; };
  try {
    await wait(() => c.eval("!!window.DM"));
    assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
    assert.equal((await call("dm:tasks")).length, 0, "Use a fresh fixture profile after dispatch tests");
    for (const d of await call("dm:drafts")) await call("dm:draft:remove", d.id);
    await click('[data-view="templates"]');
    await wait(() => c.eval("!document.querySelector('#templateEditor').classList.contains('hidden')"));
    for (let i = 1; i <= 3; i++) {
      await fill("#templateName", "批量草稿 " + i);
      await fill("#templatePrompt", "本地视频提示词 " + i);
      await click("#templateAddDraft");
      await wait(async () => (await call("dm:drafts")).length === i);
      await wait(() => c.eval("!document.querySelector('#templateAddDraft').disabled"));
    }
    assert.equal((await call("dm:tasks")).length, 0);
    assert.equal(sent.length, 0);
    await c.send("Page.reload");
    await wait(() => c.eval("!!window.DM && document.querySelector('#vbServer')?.textContent === 'API 关'"));
    await click('[data-view="templates"]');
    await wait(() => c.eval("document.querySelectorAll('.draft-row').length===3"));
    assert.equal((await call("dm:drafts"))[0].template.prompt, "本地视频提示词 1");
    assert.equal(await c.eval("document.querySelector('#draftSubmit').disabled"), true);
    console.log("PASS: UI creates three independent persistent drafts without sending");
    await click("#draftSelectAll");
    await c.eval("document.querySelectorAll('.draft-row input')[2].click()");
    assert.equal(await c.eval("document.querySelector('#draftSelectAll').indeterminate"), true);
    await c.eval("document.querySelector('#draftBox').scrollIntoView({block:'start'})");
    fs.writeFileSync(path.join(home, "drafts.png"), Buffer.from((await c.send("Page.captureScreenshot")).data, "base64"));
    const ids = (await call("dm:drafts")).slice(0, 2).map((d) => d.id);
    await c.eval("document.querySelector('#draftSubmit').click();document.querySelector('#draftSubmit').click()");
    await wait(async () => (await call("dm:tasks")).length === 2);
    await wait(async () => (await call("dm:tasks")).every((t) => t.status === "succeeded"));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((s) => s.mode), ["云电脑", "云电脑"]);
    assert.ok(sent[0].prompt.includes("本地视频提示词 1"));
    assert.ok(sent[1].prompt.includes("本地视频提示词 2"));
    const tasks = await call("dm:tasks");
    assert.ok(tasks.every((t) => t.result.files.length && t.result.files.every((f) => fs.existsSync(f))));
    assert.equal((await call("dm:drafts")).length, 1);
    const duplicate = await c.eval(`DM.call('dm:drafts:submit',${JSON.stringify(ids)})`);
    assert.equal(duplicate.ok, false);
    assert.equal((await call("dm:tasks")).length, 2);
    console.log("PASS: selected drafts dispatched in cloud mode exactly once, both videos delivered; unselected draft retained");
    await click('[data-view="templates"]');
    await wait(() => c.eval("document.querySelectorAll('.draft-row').length===1"));
    await click(".draft-row .delete-icon");
    await wait(() => c.eval("!document.querySelector('#dmModal').classList.contains('hidden')"));
    await c.eval("document.querySelector('#dmModalFoot').lastElementChild.click()");
    await wait(async () => (await call("dm:drafts")).length === 0);
    assert.equal((await call("dm:templates")).items.length, 1);
    console.log("PASS: removing a draft retains its reusable template");
    const output = await promisify(execFile)(process.execPath, [path.join(__dirname, "work-entry.e2e.js")], { env: process.env });
    process.stdout.write(output.stdout);
  } finally { c.close(); server.closeAllConnections(); server.close(); }
})().catch((error) => { console.error(error); server.closeAllConnections(); server.close(); process.exitCode = 1; });
