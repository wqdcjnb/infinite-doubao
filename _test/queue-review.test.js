"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");

function page() {
  let nodes = [];
  const document = { body: { innerText: "" }, querySelectorAll: (selector) => selector === "[data-message-id]" ? nodes : selector === "video" ? nodes.flatMap((node) => node.querySelectorAll("video")) : [] };
  const context = vm.createContext({ window: {}, document, CFG: { autoKey: "auto" }, URL, location: { href: "https://fixture.invalid/chat/" } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/automation.js"), "utf8"), context);
  return { api: context.window.auto, setNodes(value) { nodes = value; document.body.innerText = nodes.map((node) => node.innerText).join("\n"); } };
}
function message(id, text, url, role = "assistant") {
  return { id, innerText: text, getAttribute: (key) => key === "data-message-id" ? id : key === "data-message-role" ? role : null,
    querySelectorAll: (selector) => selector === "video" && url ? [{ currentSrc: url, querySelector() { return null; } }] : [] };
}

test("开始后插入更早历史消息时不能把旧视频当本次完成结果", () => {
  const fixture = page();
  const baseline = message("baseline", "你好");
  fixture.setNodes([baseline]);
  fixture.api.beginTask({ taskId: "current" });
  fixture.setNodes([message("lazy-older-history", "生成完成", "https://fixture.invalid/old.mp4"), baseline, message("current-user", "请生成新视频", "", "user")]);
  const progress = fixture.api.readProgress();
  assert.equal(progress.mediaUrls.length, 0);
  assert.notEqual(progress.state, "done");
});

test("相同视频端点不同query资源ID应识别为新视频", () => {
  const fixture = page();
  const baseline = message("baseline", "生成完成", "https://fixture.invalid/video?id=100&lr=watermark");
  fixture.setNodes([baseline]);
  fixture.api.beginTask({ taskId: "current" });
  fixture.setNodes([baseline, message("current", "生成完成", "https://fixture.invalid/video?id=200&lr=watermark")]);
  const progress = fixture.api.readProgress();
  assert.deepEqual(Array.from(progress.mediaUrls), ["https://fixture.invalid/video?id=200&lr=watermark"]);
});

test("发送意图落盘失败时不得点击发送", async () => {
  const P = require("../src/paths");
  const store = require("../src/store");
  const templates = require("../src/task-templates");
  const orchestrator = require("../src/orchestrator");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-queue-durable-"));
  P.init({ home: root }); store.load();
  let sends = 0;
  const save = store.save;
  try {
    store.add({ id: "fixture", name: "fixture" });
    store.get().settings.orchestrator.retryLimit = 0;
    const driver = {
      isLoggedIn: async () => ({ loggedIn: true }), call: async () => ({ ok: true }),
      beginTask: async () => ({ ok: true, baselineUrls: [], baselineMessageIds: [] }),
      setGenerationOptions: async () => ({}), url: async () => "https://fixture.invalid/chat/1", navigate: async () => {},
      setText: async () => { store.save = () => { store.save = save; return false; }; return { ok: true }; },
      send: async () => { sends++; return { ok: false, reason: "fixture stop after click" }; }
    };
    orchestrator.init({ resolveDriver: async () => driver, sessionFor: () => ({ cookies: { get: async () => [{ name: "sessionid" }] } }) });
    const template = templates.create({ prompt: "fixture", model: "seedance_v2.0", duration: 5 });
    const result = orchestrator.submitTemplate(templates.snapshot(template.id));
    for (let attempt = 0; attempt < 60 && orchestrator.state().running.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(orchestrator.state().running.length, 0);
    assert.equal(sends, 0);
    assert.equal(orchestrator.getTask(result.taskId).status, "failed");
  } finally {
    store.save = save;
    orchestrator.stopAll();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
