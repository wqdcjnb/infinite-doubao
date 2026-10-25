"use strict";

// Reuses only connectivity.e2e.js's isolated, localhost webview.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { CDP } = require("./cdp");
const source = fs.readFileSync(path.join(__dirname, "../src/page/generation-options.js"), "utf8");

async function fixture() {
  document.body.innerHTML = '<form id="input-engine-container"><textarea></textarea><button type="button">Seedance 2.0 Mini</button><button type="button" id="params" aria-expanded="false">自动 · 10s</button><button type="submit">发送</button></form><div id="popup"></div>';
  let ratio = "adaptive", duration = 10, sends = 0, ignoreRatio = false;
  const popup = document.querySelector("#popup");
  document.querySelector("form").onsubmit = (event) => { event.preventDefault(); sends++; };
  const ratios = ["3:4", "4:3", "9:16", "16:9", "1:1", "21:9", "adaptive"];
  const update = () => { document.querySelector("#params").textContent = (ratio === "adaptive" ? "自动" : ratio) + " · " + duration + "s"; };
  const bind = () => {
    document.querySelector("#params").onclick = (event) => {
      const button = event.currentTarget, open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      popup.innerHTML = open ? '<div role="menu"><span>画面比例</span>' + ratios.map(r => '<button type="button" data-ratio="' + r + '">' + (r === "adaptive" ? "自动" : r) + '</button>').join("") + '<span>视频时长</span><span>4s</span><div role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="11" style="width:300px;height:20px"></div><span>15s</span></div>' : "";
    };
  };
  bind();
  popup.onclick = (event) => {
    const choice = event.target.closest("[data-ratio]");
    if (!choice || ignoreRatio) return;
    ratio = choice.dataset.ratio;
    // A React render may replace the trigger while the popover remains open.
    const previous = document.querySelector("#params");
    previous.replaceWith(previous.cloneNode(true));
    update(); bind();
  };
  popup.onkeydown = (event) => {
    if (event.target.getAttribute("role") !== "slider" || !["ArrowRight", "ArrowLeft"].includes(event.key)) return;
    duration = Math.max(4, Math.min(15, duration + (event.key === "ArrowRight" ? 1 : -1)));
    update();
  };
  const results = [];
  for (const selected of ratios) {
    const result = await window.ratioTest.prepareVideoGeneration({ model: "seedance_v2.0_mini", duration: 5, ratio: selected });
    results.push({ result, ratio, duration, open: document.querySelector("#params").getAttribute("aria-expanded") });
  }
  ignoreRatio = true;
  const rejected = await window.ratioTest.prepareVideoGeneration({ model: "seedance_v2.0_mini", duration: 5, ratio: "9:16" });
  return { results, rejected, sends };
}

(async () => {
  const c = await CDP.attach();
  try {
    assert.match(await c.eval("document.querySelector('webview')?.getURL()") || "", /^http:\/\/127\.0\.0\.1:\d+\/chat$/);
    const script = `(async()=>{const CFG={autoKey:'ratioTest'};window.ratioTest={};${source}\nreturn (${fixture.toString()})();})()`;
    const output = await c.eval(`document.querySelector('webview').executeJavaScript(${JSON.stringify(script)})`);
    for (const item of output.results) {
      assert.equal(item.result.ok, true, JSON.stringify(item));
      assert.equal(item.result.ratio, item.ratio);
      assert.equal(item.result.duration, item.duration);
      assert.equal(item.open, "false");
    }
    assert.equal(output.rejected.ok, false);
    assert.equal(output.rejected.diagnostics.phase, "ratio");
    assert.match(output.rejected.reason, /未接受/);
    assert.equal(output.sends, 0);
    console.log("PASS: 七种网页比例、切回自动、同时修改时长、替换控件和不接受比例时阻止提交");
  } finally { c.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
