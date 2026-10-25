"use strict";

// Uses only the dedicated local fixture webview created by connectivity.e2e.js.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { CDP } = require("./cdp");
const source = fs.readFileSync(path.join(__dirname, "../src/page/generation-options.js"), "utf8");

async function fixture(scenario) {
  window.entryClicks = { video: 0, unrelated: 0, send: 0, paid: 0, menus: [] };
  document.body.innerHTML = '<button id="top">对话</button><aside><button id="sidebar">技能</button></aside><button id="new">新对话</button><form id="composer"><textarea></textarea><div id="controls"></div><button type="submit">发送</button></form><div id="popup"></div>';
  document.querySelector("form").onsubmit = (event) => { event.preventDefault(); window.entryClicks.send++; };
  document.querySelector("#top").onclick = document.querySelector("#sidebar").onclick = () => window.entryClicks.unrelated++;
  const controls = document.querySelector("#controls");
  const popup = document.querySelector("#popup");
  function showVideo() {
    window.entryClicks.video++;
    popup.replaceChildren();
    controls.innerHTML = '<button type="button" id="model">Seedance 2.0 Mini</button><button type="button">5s</button>';
    document.querySelector("#model").onclick = () => {
      popup.innerHTML = scenario === "missing-model" ? '<div role="menu">加载中</div>' : '<div role="menu"><button role="menuitem" id="paid">Seedance 2.5 升级</button></div>';
      const paid = document.querySelector("#paid");
      if (paid) paid.onclick = () => window.entryClicks.paid++;
    };
  }
  function mount() {
    if (["paid", "missing-model"].includes(scenario)) { showVideo(); return; }
    if (scenario === "direct") {
      controls.innerHTML = '<button type="button" id="direct">视频生成</button>';
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
  document.querySelector("#new").onclick = () => { controls.replaceChildren(); setTimeout(mount, 450); };
  const result = await window.entryTest.prepareVideoGeneration({ model: ["paid", "missing-model"].includes(scenario) ? "seedance_v2.5" : "seedance_v2.0_mini", duration: 5 });
  return { result, clicks: window.entryClicks };
}

(async () => {
  const c = await CDP.attach();
  try {
    const url = await c.eval("document.querySelector('webview')?.getURL()");
    assert.match(url || "", /^http:\/\/127\.0\.0\.1:\d+\/chat$/);
    for (const scenario of ["direct", "conversation", "skills", "missing", "paid", "missing-model"]) {
      const script = `(async()=>{const CFG={autoKey:'entryTest'};window.entryTest={};${source}\nreturn (${fixture.toString()})(${JSON.stringify(scenario)});})()`;
      const { result, clicks } = await c.eval(`document.querySelector('webview').executeJavaScript(${JSON.stringify(script)})`);
      assert.equal(clicks.unrelated, 0); assert.equal(clicks.send, 0); assert.equal(clicks.paid, 0);
      if (["direct", "conversation", "skills"].includes(scenario)) {
        assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(clicks.video, 1);
        if (scenario === "skills") assert.deepEqual(clicks.menus, ["对话", "技能"]);
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.code, scenario === "missing" ? "video_entry_missing" : scenario === "paid" ? "model_unavailable" : "prepare_failed");
      }
      console.log("PASS: video entry " + scenario);
    }
  } finally { c.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
