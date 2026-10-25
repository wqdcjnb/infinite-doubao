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
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-confirm-"));
let serial = 0;
beforeEach(() => {
  orchestrator.stopAll(); P.init({ home: path.join(root, String(++serial)) }); store.load();
  store.add({ id: "fixture", name: "fixture" });
  Object.assign(store.get().settings.orchestrator, { pollInterval: 1500, taskTimeoutMs: 3500, retryLimit: 0, autoConfirm: true, autoDownload: false });
});
after(() => { orchestrator.stopAll(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
function page() {
  let messages = [];
  const document = { body: { innerText: "" }, querySelectorAll: (sel) => sel === "[data-message-id]" ? messages : [] };
  const context = vm.createContext({ window: {}, document, CFG: { autoKey: "auto" }, URL, location: { href: "https://fixture.invalid/chat/1" } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/automation.js"), "utf8"), context);
  function message(id, text, role) {
    const owner = { getAttribute: (key) => key === "data-message-role" ? role : null };
    return { id, innerText: text, getAttribute: (key) => key === "data-message-id" ? id : null, closest: () => owner, querySelectorAll: () => [] };
  }
  return { api: context.window.auto, message, add(node) { messages.push(node); }, reset() { messages = []; } };
}
const request = "我将为你生成短视频，请先确认参数：视频生成参数确认 模型：Seedance 2.0 Mini 时长：5秒 比例16:9，确认后我再开始生成视频。";
test("识别真实wrapper角色的文字确认，检查模型时长并排除用户、历史及付费请求", () => {
  const p = page(); p.add(p.message("old", request, "assistant")); p.api.beginTask({ taskId: "task" });
  assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
  p.add(p.message("user", request, "user")); assert.equal(p.api.peekGenerationConfirmation().kind, undefined);
  p.add(p.message("new", request, "assistant"));
  const candidate = p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 5 });
  assert.equal(candidate.ok, true); assert.equal(candidate.kind, "text"); assert.equal(candidate.text, "确认，开始生成视频。");
  assert.equal(p.api.readProgress().state, "waiting_confirmation");
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 10 }).ok, false);
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0", duration: 5 }).ok, false);
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 5, ratio: "16:9" }).ok, true);
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 5, ratio: "9:16" }).ok, false);
  p.add(p.message("paid", request + "需要购买会员升级后支付。", "assistant"));
  assert.equal(p.api.peekGenerationConfirmation({ model: "seedance_v2.0_mini", duration: 5 }).ok, false);
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
    call: async (method) => method === "prepareVideoGeneration" ? { ok: true } : method === "peekGenerationConfirmation" ? { ok: true, kind: "text", key: "assistant-message-confirm-key", text: "确认，开始生成视频。" } : { ok: true },
    send: async () => {
      sends.push(text);
      if (text === "确认，开始生成视频。") {
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
  assert.equal(task.status, "succeeded"); assert.equal(fixture.sends.length, 2); assert.equal(fixture.sends[1], "确认，开始生成视频。");
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
