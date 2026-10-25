"use strict";

// Uses only the dedicated local fixture webview created by connectivity.e2e.js.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { CDP } = require("./cdp");
const source = fs.readFileSync(path.join(__dirname, "../src/page/generation-options.js"), "utf8");

async function fixture(scenario) {
  window.entryClicks = { video: 0, newChat: 0, unrelated: 0, send: 0, paid: 0, menus: [] };
  document.body.innerHTML = '<button id="top">对话</button><aside><button id="sidebar">技能</button></aside><button id="new">新对话</button><form id="composer"><textarea></textarea><div id="controls"></div><button type="submit">发送</button></form><div id="popup"></div>';
  document.querySelector("form").onsubmit = (event) => { event.preventDefault(); window.entryClicks.send++; };
  document.querySelector("#top").onclick = document.querySelector("#sidebar").onclick = () => window.entryClicks.unrelated++;
  const controls = document.querySelector("#controls");
  const popup = document.querySelector("#popup");
  function showVideo() {
    window.entryClicks.video++;
    popup.replaceChildren();
    if (scenario === "replaced-editor" && window.entryClicks.video === 1) {
      controls.replaceChildren();
      setTimeout(mount, 350);
      return;
    }
    const render = () => {
    controls.innerHTML = scenario === "combobox" ? '<div role="combobox" id="model" tabindex="0">Seedance 2.0 Mini</div><div role="combobox" tabindex="0">5s</div>' : '<button type="button" id="model">Seedance 2.0 Mini</button><button type="button">5s</button>';
    document.querySelector("#model").onclick = () => {
      popup.innerHTML = scenario === "missing-model" ? '<div role="menu">加载中</div>' : '<div role="menu"><button role="menuitem" id="paid">Seedance 2.5 升级</button></div>';
      const paid = document.querySelector("#paid");
      if (paid) paid.onclick = () => window.entryClicks.paid++;
    };
    };
    if (scenario === "slow-video") setTimeout(render, 6500); else render();
  }
  function mount() {
    if (["paid", "missing-model"].includes(scenario)) { showVideo(); return; }
    if (["direct", "slow-video", "empty-home", "slow-new-chat", "combobox", "replaced-editor"].includes(scenario)) {
      controls.innerHTML = '<button type="button" id="direct">视频生成</button>';
      if (scenario === "replaced-editor") controls.insertAdjacentHTML("beforeend", '<button type="button" aria-haspopup="menu">对话</button>');
      document.querySelector("#direct").onclick = showVideo;
      return;
    }
    controls.innerHTML = '<div role="button" tabindex="0" aria-haspopup="menu" aria-expanded="false">对话</div><button type="button" aria-haspopup="menu" aria-expanded="false">技能</button>';
    for (const menu of controls.children) {
      menu.onclick = () => {
        const open = menu.getAttribute("aria-expanded") !== "true";
        menu.setAttribute("aria-expanded", String(open));
        popup.replaceChildren();
        if (!open) return;
        window.entryClicks.menus.push(menu.textContent);
        if (scenario === "missing" || (scenario === "skills" && menu.textContent !== "技能")) return;
        setTimeout(() => {
          popup.innerHTML = '<div role="menu"><div role="menuitem" tabindex="0" id="video">视频生成 <small>创作视频</small></div></div>';
          document.querySelector("#video").onclick = showVideo;
        }, 400);
      };
      menu.onkeydown = (event) => { if (event.key === "Escape") { menu.setAttribute("aria-expanded", "false"); popup.replaceChildren(); } };
    }
  }
  document.querySelector("textarea").value = scenario === "empty-home" ? "" : "existing draft";
  if (scenario === "empty-home") {
    document.querySelector("form").id = "input-engine-container";
    document.querySelector("form").insertAdjacentHTML("beforeend", '<div data-testid="skill_input_exit_button"><img aria-hidden="true" style="width:16px;height:16px" alt=""></div>');
  }
  mount();
  document.querySelector("#new").onclick = () => {
    window.entryClicks.newChat++;
    setTimeout(() => { document.querySelector("textarea").value = ""; controls.replaceChildren(); mount(); }, scenario === "slow-new-chat" ? 800 : 450);
  };
  const result = await window.entryTest.prepareVideoGeneration({ model: ["paid", "missing-model"].includes(scenario) ? "seedance_v2.5" : "seedance_v2.0_mini", duration: 5 });
  return { result, clicks: window.entryClicks };
}

(async () => {
  const c = await CDP.attach();
  const timeout = setTimeout(() => { console.error("Video entry fixture timed out"); process.exit(1); }, 120000);
  try {
    const url = await c.eval("document.querySelector('webview')?.getURL()");
    assert.match(url || "", /^http:\/\/127\.0\.0\.1:\d+\/chat$/);
    for (const scenario of (process.env.DM_TEST_ENTRY_CASES || "slow-video,slow-new-chat,replaced-editor,empty-home,combobox,direct,conversation,skills,missing,paid,missing-model").split(",")) {
      const script = `(async()=>{const CFG={autoKey:'entryTest'};window.entryTest={};${source}\nreturn (${fixture.toString()})(${JSON.stringify(scenario)});})()`;
      const { result, clicks } = await c.eval(`document.querySelector('webview').executeJavaScript(${JSON.stringify(script)})`);
      assert.equal(clicks.unrelated, 0); assert.equal(clicks.send, 0); assert.equal(clicks.paid, 0);
      if (["direct", "conversation", "skills", "slow-video", "slow-new-chat", "empty-home", "combobox", "replaced-editor"].includes(scenario)) {
        assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(clicks.video, scenario === "replaced-editor" ? 2 : 1);
        assert.equal(clicks.newChat, scenario === "empty-home" ? 0 : 1);
        if (scenario === "skills") assert.deepEqual(clicks.menus, ["对话", "技能"]);
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.code, scenario === "missing" ? "video_entry_missing" : scenario === "paid" ? "model_unavailable" : "prepare_failed");
        assert.equal(result.diagnostics.phase, scenario === "missing" ? "video-entry" : "model");
        assert.equal(result.diagnostics.editorFound, true);
      }
      console.log("PASS: video entry " + scenario);
    }
    console.log("PASS: all requested video entry cases completed");
  } finally { clearTimeout(timeout); c.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
