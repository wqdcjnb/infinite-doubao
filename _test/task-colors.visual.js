"use strict";

// Isolated visual data only: no accounts, cookies, templates or storyboards.
process.env.DM_TEST_CDP_PORT = "9260";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { CDP } = require("./cdp");
const home = path.resolve(__dirname, "../build/task-colors-userdata");
const out = path.resolve(__dirname, "task-colors-visual");
const video = path.join(__dirname, "clip.mp4");

function prepare() {
  assert.ok(fs.existsSync(video), "Local fixture video must exist");
  assert.equal(fs.existsSync(path.join(home, "store.json")), false, "Do not replace existing fixture state");
  const P = require("../src/paths");
  const store = require("../src/store");
  P.init({ home });
  const data = store.load();
  data.settings.server.enabled = false;
  data.settings.orchestrator.stopHotkey = "CommandOrControl+Alt+Shift+F7";
  data.settings.downloadDir = path.join(home, "videos");
  const base = Date.now() - 60 * 60000;
  const cases = [
    { id: "completed", templateName: "春日花园 · 镜头一", model: "seedance_v2.0_mini", duration: 5, instanceName: "视觉示例账号 A", status: "succeeded", stage: "completed", result: { files: [video], watermark: "none", unwatermarked: true }, finishedAt: new Date(base + 78000).toISOString() },
    { id: "failed", templateName: "城市夜景与雨滴细节特写", model: "seedance_v2.0_fast", duration: 10, instanceName: "视觉示例账号 B", status: "failed", stage: "failed", error: "生成服务暂时不可用：平台返回长错误说明，当前任务结果尚未保存，请稍后重试。本行用于检查超长错误文本的截断和完整悬停提示。", finishedAt: new Date(base + 48000).toISOString() },
    { id: "queued", templateName: "山间晨雾航拍", model: "seedance_v2.5", duration: 30, status: "queued", stage: "waiting_account", waitReason: "等待可用账号：当前暂无已登录且有可用额度的账号" },
    { id: "running", templateName: "咖啡拉花 · 近景慢动作", model: "seedance_v2.0", duration: 15, instanceName: "视觉示例账号 C", status: "running", stage: "generating", progress: 42 },
    { id: "cancelled", templateName: "已取消的森林镜头", model: "seedance_v2.0_mini", duration: 5, instanceName: "视觉示例账号 A", status: "cancelled", stage: "cancelled", error: "手动停止", finishedAt: new Date(base + 22000).toISOString() },
    { id: "long", templateName: "这是一个特别长的任务名称，用来验证彩色任务徽标不会撑开表格，同时通过悬停提示保留全部内容", model: "seedance_v2.0_mini_visual_long_model_name_for_truncation", duration: 15, instanceName: "视觉示例账号名称特别长的情况", status: "running", stage: "waiting_result", waitReason: "已提交，等待豆包返回本次视频结果" },
    { id: "warning", templateName: "手绘风格的海边小屋", model: "seedance_v2.0_fast", duration: 10, instanceName: "视觉示例账号 B", status: "succeeded", stage: "completed", result: { downloadSkipped: true, warning: "自动下载已关闭，视频尚未保存到素材库" }, finishedAt: new Date(base + 96000).toISOString() }
  ];
  data.tasks = cases.map((item, i) => ({
    prompt: "仅用于本地视觉检查，不执行生成", refs: [], log: [], attempts: 0, retryCount: 0, progress: 0,
    createdAt: new Date(base - i * 60000).toISOString(), startedAt: "", finishedAt: "", instanceName: "", result: null,
    ...item, id: "visual-task-" + item.id
  })).reverse();
  assert.deepEqual(data.instances, []);
  assert.deepEqual(data.storyboards, []);
  assert.deepEqual(data.taskTemplates, []);
  assert.ok(data.tasks.every((task) => !task.templateId && !task.storyboardId));
  assert.equal(store.save(), true);
  console.log(JSON.stringify({ home, tasks: data.tasks.length, debugPort: 9260, serverEnabled: false }));
}

async function run() {
  const c = await CDP.attach();
  try {
    const actualPaths = await c.eval("DM.paths()");
    assert.equal(path.resolve(actualPaths.home), home, "Only inspect the isolated visual fixture");
    const cssOverride = process.argv.includes("--refresh-css");
    if (cssOverride) {
      const css = fs.readFileSync(path.resolve(__dirname, "../renderer/views.css"), "utf8");
      await c.eval(`(() => {let style=document.querySelector('#visual-candidate-css');if(!style){style=document.createElement('style');style.id='visual-candidate-css';document.head.append(style);}style.textContent=${JSON.stringify(css)};})()`);
    }
    await c.eval("document.querySelector('.vtab[data-view=tasks]').click()");
    const deadline = Date.now() + 10000;
    while (await c.eval("document.querySelectorAll('#taskTable tbody tr').length") !== 7) {
      if (Date.now() > deadline) throw new Error("Fixture tasks did not render");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fs.mkdirSync(out, { recursive: true });
    const results = [];
    let nativeWindow;
    try { nativeWindow = await c.send("Browser.getWindowForTarget"); } catch {}
    for (const width of [1480, 1180]) {
      if (nativeWindow) {
        await c.send("Browser.setWindowBounds", { windowId: nativeWindow.windowId, bounds: { windowState: "normal" } });
        await c.send("Browser.setWindowBounds", { windowId: nativeWindow.windowId, bounds: { width, height: 940 } });
      } else {
        await c.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      }
      await c.eval("document.fonts.ready.then(()=>new Promise(resolve=>{setTimeout(resolve,250);requestAnimationFrame(()=>requestAnimationFrame(resolve));}))");
      const metrics = await c.eval(`(() => {
        const wrap=document.querySelector('#taskTable');
        const table=wrap.querySelector('table');
        const pills=[...table.querySelectorAll('.task-truncate')];
        const clipped=pills.filter(el=>el.scrollWidth>el.clientWidth+1);
        const colours=[...table.querySelector('tbody tr').querySelectorAll('td')].slice(0,7).map(td=>{const el=td.querySelector('.task-pill');const s=getComputedStyle(el);return {column:td.className,colour:s.color,background:s.backgroundColor};});
        return {viewport:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,viewRight:document.querySelector('#view-tasks').getBoundingClientRect().right,tableWidth:table.getBoundingClientRect().width,tableWrapWidth:wrap.clientWidth,tableWrapScrollWidth:wrap.scrollWidth,tableOverflow:getComputedStyle(wrap).overflowX,rows:table.tBodies[0].rows.length,colours,clipped:clipped.map(el=>({text:el.textContent,title:el.title||el.closest('[title]')?.title||''})),clippedStandardModels:clipped.filter(el=>el.closest('.task-model')&&/^Seedance 2\\.(0|5)( Mini| Fast)?$/.test(el.textContent)).map(el=>el.textContent),statuses:[...table.querySelectorAll('.task-status-badge')].map(el=>el.textContent),actionTitles:[...table.querySelectorAll('button[title]')].map(el=>({text:el.textContent,title:el.title}))};
      })()`);
      assert.ok(metrics.documentWidth <= metrics.viewport + 1, JSON.stringify(metrics));
      assert.ok(metrics.bodyWidth <= metrics.viewport + 1, JSON.stringify(metrics));
      assert.ok(metrics.viewRight <= metrics.viewport + 1, JSON.stringify(metrics));
      assert.equal(metrics.rows, 7);
      assert.ok(metrics.clipped.length > 0, "Long fixture text should truncate");
      assert.ok(metrics.clipped.every((item) => item.title === item.text), "Clipped text must retain its complete tooltip");
      assert.deepEqual(metrics.clippedStandardModels, [], "Standard model names must show Mini/Fast without clipping");
      assert.ok(new Set(metrics.colours.map((item) => item.colour)).size >= 6, "Task columns must show differentiated colours");
      assert.ok(metrics.statuses.includes("生成中 42%"));
      assert.ok(metrics.actionTitles.some((item) => item.text === "打开位置" && item.title.includes("视频文件")));
      assert.ok(metrics.actionTitles.some((item) => item.text === "导出剪映草稿" && item.title.includes("剪辑")));
      if (metrics.tableWrapScrollWidth > metrics.tableWrapWidth + 1) assert.ok(["auto", "scroll"].includes(metrics.tableOverflow));
      const screenshot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const screenshotPath = path.join(out, `task-queue-${width}.png`);
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
      results.push({ windowWidth: width, resizeMode: nativeWindow ? "native-window" : "viewport-emulation", cssOverride, screenshot: screenshotPath, ...metrics });
      console.log(`PASS ${width}: viewport=${metrics.viewport}, rows=7, globalOverflow=0, localTableOverflow=${metrics.tableWrapScrollWidth-metrics.tableWrapWidth}, clippedTooltips=${metrics.clipped.length}`);
    }
    const state = (await c.eval("DM.call('dm:state')")).data;
    assert.equal(state.settings.server.enabled, false);
    assert.equal((await c.eval("DM.call('dm:instances')")).data.length, 0);
    assert.equal(await c.eval("document.querySelectorAll('webview').length"), 0);
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  } finally { c.close(); }
}

if (process.argv.includes("--prepare")) prepare();
else run().catch((error) => { console.error(error); process.exitCode = 1; });
