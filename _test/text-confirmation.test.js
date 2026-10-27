"use strict";
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../src/paths");
const store = require("../src/store");
const templates = require("../src/task-templates");
const orchestrator = require("../src/orchestrator");
const { Driver } = require("../src/driver");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-confirm-"));
let serial = 0;
beforeEach(() => {
  orchestrator.stopAll(); P.init({ home: path.join(root, String(++serial)) }); store.load();
  store.add({ id: "fixture", name: "fixture" });
  Object.assign(store.get().settings.orchestrator, { pollInterval: 1500, taskTimeoutMs: 3500, retryLimit: 0, autoConfirm: true, autoDownload: false });
});
after(() => { orchestrator.stopAll(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
function page() {
  let messages = [], panels = [];
  const document = { body: { innerText: "" }, querySelectorAll: (sel) => sel === "[data-message-id]" ? messages : sel.includes("#input-engine-container") ? panels : [] };
  const context = vm.createContext({ window: {}, document, CFG: { autoKey: "auto" }, URL, getComputedStyle: () => ({}), location: { href: "https://fixture.invalid/chat/1" } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/automation.js"), "utf8"), context);
  function message(id, text, role) {
    const owner = { getAttribute: (key) => key === "data-message-role" ? role : null };
    return { id, innerText: text, isConnected: true, getBoundingClientRect: () => ({ width: 500, height: 200 }), getAttribute: (key) => key === "data-message-id" ? id : null, closest: () => owner, querySelectorAll: () => [] };
  }
  return { api: context.window.auto, message, add(node) { messages.push(node); }, panel(node) { panels.push(node); }, reset() { messages = []; } };
}
const request = "我将为你生成短视频，请先确认参数：视频生成参数确认 模型：Seedance 2.0 Mini 时长：5秒 比例16:9，确认后我再开始生成视频。";
const planRequest = "以上方案（Seedance 2.5 / 30秒 / 16:9 / 写实电影风 / 5段分镜 / 仅环境音无配乐）是否按此开始生成？视频生成为高消耗生成。";
const livePlanRequest = "是否按以上完整方案（Seedance 2.5 / 30秒 / 16:9 / 写实电影风 / 6段分镜 / 仅环境音无对白）开始生成视频？视频生成为高消耗生成。";

test("方案完成文字不能冒充成片，当前确认仍须等待按要求生成", () => {
  for (const text of ["方案已完成。", "分镜已生成。", "提示词生成完成。", "视频已生成。"]) {
    const p = page(); p.api.beginTask({ taskId: "planning-complete" });
    const node = p.message("plan", text + livePlanRequest, "assistant"); p.add(node);
    assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.5", duration: 30, ratio: "16:9" }).ok, true);
    let progress = p.api.readProgress();
    assert.equal(progress.state, "waiting_confirmation", text);
    assert.equal(progress.generationStarted, false); assert.equal(progress.percent, 0); assert.equal(progress.mediaUrls.length, 0);
    node.innerText = text;
    progress = p.api.readProgress();
    assert.equal(progress.state, "unknown", text);
    assert.equal(progress.generationStarted, false); assert.equal(progress.percent, 0);
  }
});

test("真实进度需区分视频已开始与本次成片地址", () => {
  const p = page(); p.api.beginTask({ taskId: "video-progress" });
  const node = p.message("new", "视频正在生成 12%", "assistant"); p.add(node);
  let progress = p.api.readProgress();
  assert.equal(progress.state, "running"); assert.equal(progress.generationStarted, true); assert.equal(progress.percent, 12);
  const url = "https://fixture.invalid/current-video.mp4";
  node.innerText = "生成完成";
  node.querySelectorAll = selector => selector === "video" ? [{ currentSrc: url, closest: () => null }] : [];
  progress = p.api.readProgress();
  assert.equal(progress.state, "done"); assert.equal(progress.percent, 100); assert.deepEqual(Array.from(progress.mediaUrls), [url]);
});

test("原对话确认不能因方案已完成跳过唯一一次按要求生成", async () => {
  const p = page(), sent = [];
  p.add(p.message("receipt", "原草稿请求", "user"));
  const reply = p.message("plan", "方案已完成。" + livePlanRequest, "assistant"); p.add(reply);
  const task = { id: "planning-receipt", studioTaskId: "original-task", instanceId: "fixture", status: "submitted",
    receiptUserMessageId: "receipt", conversationUrl: "https://fixture.invalid/chat/1", baselineMessageIds: ["receipt"], baselineUrls: [],
    model: "seedance_v2.5", duration: 30, ratio: "16:9", storyboardId: "board", shotId: "shot", log: [] };
  store.get().tasks.push(task); store.get().storyboards.push({ id: "board", shots: [{ id: "shot" }] }); store.save();
  let text = "";
  const driver = {
    navigate: async () => {}, isLoggedIn: async () => ({ loggedIn: true }),
    beginTask: async options => p.api.beginTask(options), readProgress: async () => p.api.readProgress(),
    call: async (method, options) => p.api[method](options),
    setText: async value => { text = value; return { ok: true }; },
    send: async options => { sent.push({ text, options }); reply.innerText = "视频正在生成 1%"; return { ok: true }; }
  };
  orchestrator.init({ resolveDraftDriver: async () => driver });
  await orchestrator.confirmSubmittedTaskOnce(task.id, { checkLease() {} });
  assert.deepEqual(sent, [{ text: "按要求生成", options: { nativeOnly: true } }]);
  assert.ok(task.generationObservedAt); assert.equal(task.status, "queued");
  await orchestrator.confirmSubmittedTaskOnce(task.id, { checkLease() {} });
  assert.equal(sent.length, 1, "已开始生成的原对话不能再次确认");
});

test("按钮形式的方案改为统一文字确认前仍核对模型时长和比例",()=>{
  const p=page();p.api.beginTask({taskId:"button-parameters"});
  const node=p.message("new","模型：Seedance 2.5 时长：30秒 比例16:9，确认生成。","assistant");
  const button={innerText:"确认生成",isConnected:true,disabled:false,getBoundingClientRect:()=>({width:100,height:30}),getAttribute:()=>null};
  node.querySelectorAll=selector=>selector==='button, [role="button"]'?[button]:[];p.add(node);
  const expected={model:"seedance_v2.5",duration:30,ratio:"16:9"};
  assert.equal(p.api.peekGenerationConfirmation(expected).ok,true);
  for(const changed of [{model:"seedance_v2.0"},{duration:15},{ratio:"9:16"}])assert.equal(p.api.peekGenerationConfirmation({...expected,...changed}).ok,false);
});

test("本次空白助手回复的原生失败图标必须结束等待，旧消息和用户图标不能误判", () => {
  const p = page();
  const icon = p.message("icon", "", "");
  const failed = id => {
    const node = p.message(id, "", "assistant");
    node.querySelectorAll = selector => selector === '[data-testid="message_box_failed_icon"]' ? [icon] : [];
    return node;
  };
  p.add(failed("old-failure")); p.add(p.message("receipt", "本次编号", "user"));
  p.api.beginTask({ taskId: "empty-failure", resume: true, baselineMessageIds: ["receipt"] });
  assert.equal(p.api.readProgress().state, "unknown");
  p.add(failed("current-failure"));
  p.panel(p.message("stale-confirmation", planRequest, ""));
  assert.equal(p.api.readProgress().state, "failed");
  assert.equal(p.api.readProgress().errorCode, "platform_rejected");
  assert.match(p.api.readProgress().snippet, /失败标记.*未提供具体原因/);
  assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
  p.add(p.message("newer", "视频正在生成", "assistant"));
  assert.equal(p.api.readProgress().state, "running");
  icon.hidden = true;
  const user = failed("user-icon"); user.closest = () => ({getAttribute:()=>"user"}); p.add(user);
  assert.notEqual(p.api.readProgress().state, "failed");
});

test("本次助手的明确错误状态不依赖图标，但流式空回复与其他消息不能误判", () => {
  const p = page(); p.api.beginTask({ taskId: "structured-error" });
  const node = p.message("current", "", "assistant"); p.add(node);
  const message = { message_id: "current", status: 4, final_status: {} };
  node.__reactFiber$fixture = { memoizedProps: {}, return: { memoizedProps: { value: { message } } } };
  assert.equal(p.api.readProgress().state, "unknown");
  for (const final of ["Error", "Timeout"]) {
    message.final_status.message = final;
    assert.equal(p.api.readProgress().errorCode, "platform_rejected");
    assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
  }
  message.final_status.message = "Success";
  assert.notEqual(p.api.readProgress().state, "failed");
  message.error_details = { has_error: true };
  assert.equal(p.api.readProgress().state, "failed");
  message.message_id = "another-message";
  assert.notEqual(p.api.readProgress().state, "failed");
});

test("工作任务最终收尾确认识别本次既定参数，忽略耗时及可选换模型建议", () => {
  const reminders = [
    '共用时 1 小时 1 分 8 秒 方案已经准备好了。由于你暂时不在，我没有直接开始生成，考虑到这次使用的是 seedance 2.0 会员模型（会消耗更多额度），我等你确认后再启动。你回来后回复 "按要求生成" 或 "开始生成"，我就立刻按上面的方案后台生成这条 15 秒清晨湖面小鱼视频。如果想调整任何参数（比如换成 fast 模型、改成竖屏），也直接告诉我。',
    '共用时 1 小时 1 分 15 秒 方案已经拟好并停在确认环节，你没有回复确认，我就不擅自消耗会员额度去生成了。你回来后只要说一声 "按方案生成"，我就立即用 seedance 2.0、15 秒、16:9 跑这条清晨湖面小鱼的视频；如果想改比例、或换成更快的 seedance 2.0 fast，也直接告诉我。',
    '共用时 1 小时 1 分 6 秒 方案已经备好，但在等待您确认期间没有收到回复。考虑到您此前明确不希望在未确认的情况下消耗付费额度，我没有自动开始生成这条 seedance 2.0（会员模型）的视频，避免误扣额度。您回来后只需回复一句 "开始生成"，我就按上面的参数（15 秒、16:9、清晨湖面小鱼）直接提交生成；如果想改用消耗更低的 seedance 2.0 fast（同样 15 秒、16:9），也可以直接告诉我。',
    '共用时 1 小时 1 分 25 秒 方案已整理完毕，等待你确认。当前状态：视频生成参数和分镜表已展示在上方，你回来后直接回复 "按要求生成" 即可开始制作，或者告诉我需要调整的地方。核心参数回顾：模型：seedance 2.0（会员模型，消耗更多额度） 时长：15 秒 ｜ 比例：16:9 横版。确认后我会立即开始生成。'
  ];
  const expected = { model: "seedance_v2.0", duration: 15, ratio: "adaptive" };
  reminders.forEach(text => {
    const p = page(); p.api.beginTask({ taskId: "final-reminder" }); p.add(p.message("new", text, "assistant"));
    const found = p.api.peekGenerationConfirmation(expected);
    assert.equal(found.ok, true, found.reason); assert.equal(found.kind, "text"); assert.equal(found.nativeOnly, true);
    assert.equal(found.text, "按要求生成");
    assert.equal(p.api.readProgress().state, "waiting_confirmation");
    assert.equal(p.api.peekGenerationConfirmation({ ...expected, duration: 10 }).ok, false);
    assert.equal(p.api.peekGenerationConfirmation({ ...expected, model: "seedance_v2.0_fast" }).ok, false);
    p.add(p.message("paid", text + " 请先支付 20 元购买会员升级套餐。", "assistant"));
    const paid = p.api.peekGenerationConfirmation(expected); assert.equal(paid.ok, false); assert.equal(paid.pending, false);
  });
});

test("额度已经用完与恢复后替代建议判失败，不能触发生成确认或面板旧确认", () => {
  for (const quota of ["当前 7 天的视频生成额度已经用完了", "近 7 天额度已用完", "近 7 天生成额度已耗尽", "已用完近 7 天的生成额度"]) {
    const p = page(); p.api.beginTask({ taskId: "quota" });
    p.add(p.message("new", `${quota}，预计 11 月 2 日恢复。方案准备好了，等待你确认。恢复后回复 "按要求生成" 即可开始制作，模型 Seedance 2.0，15 秒。是否按此参数开始生成？`, "assistant"));
    p.panel(p.message("old", planRequest, ""));
    assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0", duration: 15 }).kind, undefined);
    assert.equal(p.api.readProgress().state, "failed"); assert.equal(p.api.readProgress().errorCode, "quota");
  }
});

test("已接收消息锚点之前的旧失败和旧确认不属于本次草稿", () => {
  const p = page(); p.add(p.message("old", "额度已用完。" + request, "assistant"));
  p.add(p.message("receipt-user", "本次草稿", "user"));
  p.api.beginTask({ taskId: "received", resume: true, baselineMessageIds: ["receipt-user"] });
  assert.equal(p.api.readProgress().state, "unknown"); assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
  p.add(p.message("new", request, "assistant"));
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 5 }).ok, true);
  assert.equal(p.api.readProgress().state, "waiting_confirmation");
});

test("流式确认先出现问句但尚无参数时等待，参数齐全后才允许确认", () => {
  const p = page(); p.api.beginTask({ taskId: "streaming" });
  const node = p.message("new", "视频生成参数确认，确认后开始生成视频。", "assistant"); p.add(node);
  const options = { model: "seedance_v2.0", duration: 15 };
  const pending = p.api.peekGenerationConfirmation(options);
  assert.equal(pending.ok, false); assert.equal(pending.pending, true);
  node.innerText += " 模型：seedance 2.0 总时长：15 秒";
  assert.equal(p.api.peekGenerationConfirmation(options).ok, true);
  node.innerText = node.innerText.replace("15 秒", "10 秒");
  const changed = p.api.peekGenerationConfirmation(options);
  assert.equal(changed.ok, false); assert.equal(changed.pending, false);
});

test("真实工作任务的冒号方案、请确认句式和短提醒均核对当前方案参数", () => {
  const plan = "模型：Seedance 2.5（seedance_2.5，固定不切换） 时长：30 秒 画面比例：16:9 横屏，按六段分镜生成。";
  const reminders = [
    "以上为完整方案：Seedance 2.5 模型、30 秒、16:9 横屏、写实电影风、按六段分镜生成，无对白无配乐无字幕水印。视频生成为高消耗生成，是否按此参数开始生成？",
    "视频生成为高消耗生成。请确认是否按上述方案立即调用 Seedance 2.5 生成 30 秒 16:9 横屏视频。",
    "是否按以上参数开始生成视频？"
  ];
  for (const reminder of reminders) {
    const p = page(); p.api.beginTask({ taskId: "task" });
    p.add(p.message("plan", plan, "assistant"));
    p.panel(p.message("reminder", reminder + " 按要求生成 暂不生成", ""));
    const options = { model: "seedance_v2.5", duration: 30, ratio: "16:9" };
    const candidate = p.api.peekGenerationConfirmation(options);
    assert.equal(candidate.ok, true, reminder); assert.equal(candidate.text, "按要求生成");
    assert.equal(p.api.peekGenerationConfirmation({ ...options, duration: 15 }).ok, false);
    assert.equal(p.api.peekGenerationConfirmation({ ...options, ratio: "9:16" }).ok, false);
  }
});

test("短提醒不能借用用户要求或旧回复补齐参数，当前方案冲突须停止", () => {
  const p = page(); p.add(p.message("old", "Seedance 2.5，30 秒，16:9", "assistant"));
  p.api.beginTask({ taskId: "task" });
  p.add(p.message("user", "Seedance 2.5，30 秒，16:9", "user"));
  p.panel(p.message("reminder", "是否按以上参数开始生成视频？ 按要求生成 暂不生成", ""));
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.5", duration: 30, ratio: "16:9" }).ok, false);
  p.add(p.message("new", "Seedance 2.0，15 秒，9:16", "assistant"));
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.5", duration: 30, ratio: "16:9" }).ok, false);
});

test("确认问句中的实际参数优先于前文复述的用户要求", () => {
  const p = page(); p.api.beginTask({ taskId: 'mismatch' });
  p.add(p.message('new', '你要求 Seedance 2.5 / 30秒 / 16:9，但当前可用方案如下：以上方案（Seedance 2.0 / 15秒 / 9:16）是否按此开始生成？', 'assistant'));
  assert.equal(p.api.peekGenerationConfirmation({ model: 'seedance_v2.5', duration: 30, ratio: '16:9' }).ok, false);
  for (const actual of ['Seedance 2.0 / 15秒 / 9:16', 'Seedance 2.5 / 15秒 / 16:9']) {
    p.add(p.message('conflict', `你要求 Seedance 2.5 / 30秒 / 16:9，但当前可用的完整方案：${actual}。是否按此参数开始生成？`, 'assistant'));
    assert.equal(p.api.peekGenerationConfirmation({ model: 'seedance_v2.5', duration: 30, ratio: '16:9' }).ok, false);
  }
  p.add(p.message('mixed', '你要求 Seedance 2.5，时长：30秒，16:9；当前可用的完整方案：Seedance 2.5 / 15秒 / 16:9。是否按此参数开始生成？', 'assistant'));
  assert.equal(p.api.peekGenerationConfirmation({ model: 'seedance_v2.5', duration: 30, ratio: '16:9' }).ok, false);
});

test("等待确认发送按钮期间停止，下一轮检查不能再点击", async () => {
  const driver = new Driver({ instance: { id: 'test' } });
  let attempts = 0, stopped = false;
  driver.call = async () => { attempts++; stopped = true; return { ok: false, reason: '未找到对话输入框的发送按钮' }; };
  await assert.rejects(driver.send({ nativeOnly: true }, () => { if (stopped) throw new Error('stopped'); }), /stopped/);
  assert.equal(attempts, 1);
});

test("方案提醒在当前回复或输入区面板出现后才返回按要求生成，输入文字不改变确认身份", () => {
  for (const reminder of [planRequest, livePlanRequest]) for (const location of ["assistant", "composer"]) {
    const p = page(); p.api.beginTask({ taskId: "task" });
    assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
    const node = p.message("reminder", reminder, location === "assistant" ? "assistant" : "");
    if (location === "assistant") p.add(node); else p.panel(node);
    const options = { model: "seedance_v2.5", duration: 30, ratio: "16:9" };
    const result = p.api.peekGenerationConfirmation(options);
    assert.equal(result.ok, true); assert.equal(result.kind, "text"); assert.equal(result.text, "按要求生成");
    node.innerText += " 按要求生成 暂不生成 自定义描述 按要求生成";
    assert.equal(p.api.peekGenerationConfirmation(options).key, result.key);
    assert.equal(p.api.peekGenerationConfirmation({ ...options, duration: 15 }).ok, false);
    assert.equal(p.api.peekGenerationConfirmation({ ...options, model: "seedance_v2.0" }).ok, false);
    assert.equal(p.api.peekGenerationConfirmation({ ...options, ratio: "9:16" }).ok, false);
    node.innerText += " 需要支付";
    assert.equal(p.api.peekGenerationConfirmation(options).ok, false);
  }
});

test("旧面板、历史方案、用户提示词及普通讨论不会触发确认", () => {
  const p = page(); p.panel(p.message("old-panel", planRequest, ""));
  p.add(p.message("history", planRequest, "assistant")); p.api.beginTask({ taskId: "task" });
  assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
  p.add(p.message("user", planRequest, "user")); assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
  p.add(p.message("discussion", "请介绍按要求生成这个功能", "assistant")); assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
});
test("识别真实wrapper角色的文字确认，检查模型时长并排除用户、历史及付费请求", () => {
  const p = page(); p.add(p.message("old", request, "assistant")); p.api.beginTask({ taskId: "task" });
  assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
  p.add(p.message("user", request, "user")); assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
  p.add(p.message("new", request, "assistant"));
  const candidate = p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 5 });
  assert.equal(candidate.ok, true); assert.equal(candidate.kind, "text"); assert.equal(candidate.text, "按要求生成"); assert.equal(candidate.nativeOnly, true);
  assert.equal(p.api.readProgress().state, "waiting_confirmation");
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 10 }).ok, false);
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0", duration: 5 }).ok, false);
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 5, ratio: "16:9" }).ok, true);
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 5, ratio: "9:16" }).ok, false);
  p.add(p.message("paid", request + "需要购买会员升级后支付。", "assistant"));
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 5 }).ok, false);
});
test("按钮型确认保留识别类型和身份，原对话回复也统一按要求生成且peek不点击", () => {
  for (const label of ["确认生成", "继续生成", "开始生成"]) {
    const p = page(); p.api.beginTask({ taskId: "button-reply" });
    let clicks = 0;
    const button = { isConnected: true, disabled: false, innerText: label,
      getBoundingClientRect: () => ({ width: 100, height: 30 }), getAttribute: () => null, click: () => clicks++ };
    const node = p.message("button-confirmation", "视频方案已备好，等待确认生成。", "assistant");
    node.querySelectorAll = selector => selector === 'button, [role="button"]' ? [button] : [];
    p.add(node);
    const candidate = p.api.peekGenerationConfirmation();
    assert.equal(candidate.ok, true); assert.equal(candidate.kind, "button");
    assert.equal(candidate.text, "按要求生成"); assert.equal(candidate.nativeOnly, true);
    assert.equal(p.api.peekGenerationConfirmation().key, candidate.key); assert.equal(clicks, 0);
  }
});
async function settled(id) {
  for (let i = 0; i < 180; i++) { if (!orchestrator.state().running.length) return orchestrator.getTask(id); await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("confirmation fixture timeout");
}
function installDriver({ failAfterConfirmation = false } = {}) {
  let text = "";
  let confirmed = false;
  const sends = [];
  const driver = {
    isLoggedIn: async () => ({ loggedIn: true }),
    beginTask: async () => ({ ok: true, baselineUrls: [], baselineMessageIds: [] }),
    setGenerationOptions: async () => ({}),
    setText: async (value) => { text = value; return { ok: true }; },
    call: async (method) => method === "prepareVideoGeneration" ? { ok: true } : method === "peekGenerationConfirmation" ? { ok: true, kind: "text", key: "assistant-message-confirm-key", text: "按要求生成", nativeOnly: true } : { ok: true },
    send: async () => {
      sends.push(text);
      if (text === "按要求生成") {
        const saved = JSON.parse(fs.readFileSync(path.join(P.home(), "store.json"), "utf8"));
        assert.equal(saved.tasks[0].confirmationIntents["assistant-message-confirm-key"].state, "pending");
        confirmed = true;
        if (failAfterConfirmation) throw new Error("IPC response lost after confirmed click");
      }
      return { ok: true };
    },
    readProgress: async () => confirmed ? { state: "done", mediaUrls: [`https://fixture.invalid/output-${serial}.mp4?lr=watermark`] } : { state: "waiting_confirmation", mediaUrls: [] }
  };
  orchestrator.init({ resolveDriver: async () => driver, sessionFor: () => ({ cookies: { get: async () => [{name:"sessionid"}] } }) });
  return { driver, sends };
}
function submit() { return orchestrator.submitTemplate(templates.snapshot(templates.create({ prompt: "生成一个湖面视频", model: "seedance_v2.0_mini", duration: 5 }).id)).taskId; }
test("文字确认先持久化再发送，原始任务和确认各发送一次", async () => {
  const fixture = installDriver(); const task = await settled(submit());
  assert.equal(task.status, "succeeded"); assert.equal(fixture.sends.length, 2); assert.equal(fixture.sends[1], "按要求生成");
  assert.equal(task.confirmationIntents["assistant-message-confirm-key"].state, "sent");
});
test("确认点击后IPC丢失，重启恢复依靠pending意图不重复发确认或原任务", async () => {
  const fixture = installDriver({ failAfterConfirmation: true }); const id = submit(); let task = await settled(id);
  assert.equal(task.status, "failed"); assert.equal(fixture.sends.length, 2); assert.equal(task.confirmationIntents["assistant-message-confirm-key"].state, "pending");
  task.status = "running"; store.save(); orchestrator.recoverTemplateTasks(); orchestrator.wakeQueue(); task = await settled(id);
  assert.equal(task.status, "succeeded"); assert.equal(fixture.sends.length, 2);
});
test("关闭自动确认保持可见等待原因，不发送文字确认", async () => {
  const fixture = installDriver(); store.get().settings.orchestrator.autoConfirm = false; const id = submit();
  for (let i = 0; i < 80 && orchestrator.getTask(id).stage !== "waiting_confirmation"; i++) await new Promise((r) => setTimeout(r, 50));
  const task = orchestrator.getTask(id); assert.equal(task.stage, "waiting_confirmation"); assert.match(task.waitReason, /自动确认已关闭/); assert.equal(fixture.sends.length, 1);
  orchestrator.stopTask(id); await settled(id);
});
