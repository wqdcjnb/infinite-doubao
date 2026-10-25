"use strict";

// Run only against the dedicated local fixture webview. Never send real prompts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CDP } = require("./cdp");
const source = fs.readFileSync(path.join(__dirname, "../src/page/generation-options.js"), "utf8");
async function fixture(scenario) {
  document.body.innerHTML = '<button id="new">新工作任务</button><button id="video">视频生成</button><div id="input-engine-container"><textarea></textarea><button data-testid="chat_input_action_mode">对话</button><button id="send">发送</button></div><div id="menu"></div>';
  const counts = { work: 0, video: 0, send: 0, cloud: 0 };
  const mode = document.querySelector('[data-testid="chat_input_action_mode"]');
  const editor = document.querySelector("textarea");
  document.querySelector("#send").onclick = () => counts.send++;
  document.querySelector("#video").onclick = () => counts.video++;
  document.querySelector("#new").onclick = () => {
    counts.work++;
    setTimeout(() => { editor.value = ""; mode.textContent = scenario === "menu" ? "本机电脑" : "云电脑"; }, 150);
  };
  mode.onclick = () => {
    document.querySelector("#menu").innerHTML = '<button role="menuitem">云电脑</button>';
    document.querySelector('[role="menuitem"]').onclick = () => { counts.cloud++; mode.textContent = "云电脑"; document.querySelector("#menu").replaceChildren(); };
  };
  if (scenario === "already-work") mode.textContent = "云电脑";
  if (scenario === "existing-draft") { mode.textContent = "云电脑"; editor.value = "preserve existing draft"; }
  if (scenario === "missing-entry") document.querySelector("#new").remove();
  const result = await window.workTest.prepareWorkTask();
  return { result, counts, text: editor.value };
}
(async () => {
  const c = await CDP.attach();
  try {
    assert.match(await c.eval("document.querySelector('webview').getURL()"), /^http:\/\/127\.0\.0\.1:\d+\/chat$/);
    for (const scenario of ["chat", "already-work", "existing-draft", "menu", "missing-entry"]) {
      const script = `(async()=>{const CFG={autoKey:'workTest'};window.workTest={};${source}\nreturn (${fixture.toString()})(${JSON.stringify(scenario)});})()`;
      const { result, counts, text } = await c.eval(`document.querySelector('webview').executeJavaScript(${JSON.stringify(script)})`);
      assert.equal(counts.send, 0);
      assert.equal(counts.video, 0);
      assert.equal(result.ok, scenario !== "missing-entry", JSON.stringify(result));
      if (result.ok) { assert.equal(text, ""); assert.equal(counts.work, scenario === "already-work" ? 0 : 1); }
      if (scenario === "menu") assert.equal(counts.cloud, 1);
      console.log("PASS: work entry " + scenario);
    }
  } finally { c.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
