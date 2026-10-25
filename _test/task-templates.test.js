"use strict";

const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const P = require("../src/paths");
const store = require("../src/store");
const templates = require("../src/task-templates");
const storyboard = require("../src/storyboard");
const orchestrator = require("../src/orchestrator");
const { Driver } = require("../src/driver");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-templates-"));
let counter = 0;
beforeEach(() => { P.init({ home: path.join(root, String(++counter)) }); store.load(); });
after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(name, content = "media fixture") {
  const file = path.join(P.home(), name);
  fs.writeFileSync(file, content);
  return file;
}
async function done() {
  for (let n = 0; n < 150; n++) {
    if (!orchestrator.state().running.length && store.get().tasks.every((t) => !["running", "queued"].includes(t.status))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("测试任务未结束");
}

test("模板及图片、视频副本重载后保留，原文件移走后仍可提交", async () => {
  const item = templates.create({ name: "产品展示", prompt: "旋转展示产品", model: "seedance_v2.0", duration: 15 });
  const files = [fixture("参考 图.png", "image bytes"), fixture("参考 视频.mp4", "video bytes")];
  await templates.importAttachments(item.id, files);
  for (const file of files) fs.renameSync(file, file + ".moved");
  store.load();
  const saved = templates.snapshot(item.id);
  assert.equal(saved.prompt, "旋转展示产品");
  assert.equal(saved.duration, 15);
  assert.equal(saved.model, "seedance_v2.0");
  assert.deepEqual(saved.attachments.map((a) => a.mime), ["image/png", "video/mp4"]);
  assert.equal(fs.readFileSync(saved.attachments[0].path, "utf8"), "image bytes");
  assert.equal(fs.readFileSync(saved.attachments[1].path, "utf8"), "video bytes");
  assert.ok(saved.attachments.every((a) => a.path.startsWith(P.dir("attachments") + path.sep)));
});

test("批量导入附件失败时不留下半份记录，不覆盖同名文件", async () => {
  const item = templates.create();
  const image = fixture("same.png", "first");
  await assert.rejects(templates.importAttachments(item.id, [image, fixture("unsupported.txt")]), /只支持/);
  assert.equal(item.attachments.length, 0);
  assert.equal(fs.readdirSync(P.dir("attachments")).length, 0);
  await templates.importAttachments(item.id, [image]);
  fs.writeFileSync(image, "second");
  await templates.importAttachments(item.id, [image]);
  assert.notEqual(item.attachments[0].path, item.attachments[1].path);
  assert.equal(fs.readFileSync(item.attachments[0].path, "utf8"), "first");
});

test("旧分镜逐镜转换一次，附件复制后可用，删除模板不重新生成", async () => {
  const original = fixture("legacy.mp4");
  const board = storyboard.create({ name: "旧稿", shots: [{ title: "镜头一", videoPrompt: "山景", duration: 10, model: "seedance_v2.0", refs: [original] }, { title: "镜头二", videoPrompt: "海景", refs: [path.join(P.home(), "missing.png")] }] });
  await templates.migrateLegacy();
  store.load();
  await templates.migrateLegacy();
  assert.equal(templates.list().length, 2);
  assert.equal(templates.list()[0].model, "seedance_v2.0");
  assert.notEqual(templates.list()[0].attachments[0].path, original);
  assert.equal(templates.list()[1].attachments[0].missing, true);
  assert.throws(() => templates.snapshot(templates.list()[1].id), /请重新添加/);
  templates.remove(templates.list()[0].id);
  store.load();
  await templates.migrateLegacy();
  assert.equal(templates.list().length, 1);
  assert.equal(storyboard.get(board.id).shots.length, 2);
});

test("校验提示词、模型、时长与缺失附件，删除模板不破坏任务快照", async () => {
  assert.throws(() => templates.create({ model: "invalid" }), /请选择/);
  assert.throws(() => templates.create({ model: "seedance_v2.0", duration: 30 }), /4–15/);
  const item = templates.create();
  assert.throws(() => templates.snapshot(item.id), /提示词/);
  templates.update(item.id, { prompt: "original" });
  await templates.importAttachments(item.id, [fixture("file.mp4")]);
  const snap = templates.snapshot(item.id);
  templates.update(item.id, { prompt: "changed" });
  templates.removeAttachment(item.id, item.attachments[0].id);
  templates.remove(item.id);
  assert.equal(snap.prompt, "original");
  assert.equal(fs.existsSync(snap.attachments[0].path), true);
});

test("四种模型在设置、模板中一致，只有 2.5 允许 30 秒", () => {
  const expected = [
    ["seedance_v2.5", "Seedance 2.5", 30],
    ["seedance_v2.0", "Seedance 2.0", 15],
    ["seedance_v2.0_fast", "Seedance 2.0 Fast", 15],
    ["seedance_v2.0_mini", "Seedance 2.0 Mini", 15]
  ];
  assert.deepEqual(templates.options().models.map((m) => [m.value, m.label, m.maxDuration]), expected);
  for (const [model, , cap] of expected) {
    store.get().settings.enhancer = { model, duration: 30 };
    assert.equal(store.save(), true);
    store.load();
    assert.equal(store.get().settings.enhancer.model, model);
    assert.equal(store.get().settings.enhancer.duration, cap);
    const item = templates.create({ prompt: "测试视频" });
    assert.equal(item.model, model);
    assert.equal(item.duration, cap);
    assert.throws(() => templates.update(item.id, { duration: cap + 1 }), /时长应为/);
  }
  assert.equal(store.maxDurationFor("unknown"), 15);
});

test("视频时长从 4 秒开始，模板和草稿均拒绝越界或小数秒", () => {
  for (const { value: model, minDuration, maxDuration } of templates.options().models) {
    assert.equal(minDuration, 4);
    for (const duration of [0, 1, 2, 3, 4.5, maxDuration + 1]) {
      assert.throws(() => templates.create({ model, duration }), /时长应为/);
    }
    const item = templates.create({ model, duration: 4, prompt: "边界测试" });
    assert.equal(templates.snapshot(item.id).duration, 4);
    templates.update(item.id, { duration: maxDuration });
    assert.equal(templates.snapshot(item.id).duration, maxDuration);
    assert.throws(() => templates.update(item.id, { duration: 3 }), /时长应为/);
    assert.throws(() => templates.validateSnapshot({ ...item, duration: 3 }), /时长应为/);
    assert.equal(store.clampEnhancer({ model, duration: 3 }).duration, 4);
  }
});

test("旧版 1–3 秒模板升级为 4 秒，历史任务与草稿快照保持不变", () => {
  const item = templates.create({ model: "seedance_v2.0_mini", duration: 4, prompt: "保留提示词" });
  item.duration = 2;
  store.get().settings.enhancer.duration = 2;
  store.get().tasks.push({ id: "history", duration: 2 });
  store.get().taskDrafts.push({ id: "saved-draft", template: { ...item } });
  assert.equal(store.save(), true);
  store.load();
  assert.equal(templates.get(item.id).duration, 4);
  assert.equal(templates.get(item.id).prompt, "保留提示词");
  assert.equal(store.get().settings.enhancer.duration, 4);
  assert.equal(store.get().tasks[0].duration, 2);
  assert.equal(store.get().taskDrafts[0].template.duration, 2);
});

test("七种比例可保存，草稿保持快照，非法比例拒绝写入", () => {
  const expected = ["adaptive", "3:4", "4:3", "9:16", "16:9", "1:1", "21:9"];
  assert.deepEqual(templates.options().ratios.map((r) => r.value), expected);
  const drafts = require("../src/task-drafts");
  const item = templates.create({ prompt: "比例测试", ratio: "9:16" });
  const draft = drafts.create(item.id);
  for (const ratio of expected) assert.equal(templates.update(item.id, { ratio }).ratio, ratio);
  assert.throws(() => templates.update(item.id, { ratio: "2:1" }), /画面比例/);
  store.load();
  assert.equal(templates.get(item.id).ratio, "21:9");
  assert.equal(drafts.list().find((d) => d.id === draft.id).template.ratio, "9:16");
});

test("视频上传保留 video MIME，任一文件丢失时不静默少传", async () => {
  const files = [fixture("picture.png"), fixture("clip.mp4")];
  const driver = new Driver({ instance: { id: "test" }, webContents: {} });
  let payload;
  driver.call = async (_method, items) => { payload = items; return { ok: true, count: items.length }; };
  assert.equal((await driver.pasteFiles(files)).count, 2);
  assert.ok(payload[1].dataUrl.startsWith("data:video/mp4;base64,"));
  assert.equal((await driver.pasteFiles([...files, path.join(P.home(), "missing.mp4")])).ok, false);
});

test("每任务模型时长进入页面增强状态，结束后能恢复原配置", async () => {
  const { autoKeyFor } = require("../src/page");
  const key = autoKeyFor("test");
  const context = vm.createContext({ window: {}, CFG: { autoKey: key, enhancer: { enabled: true, model: "seedance_v2.5", duration: 30 } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/enhancer.js"), "utf8"), context);
  const driver = new Driver({ instance: { id: "test" }, webContents: { executeJavaScript: async (script) => vm.runInContext(script, context) } });
  const previous = await driver.setGenerationOptions({ model: "seedance_v2.0", duration: 10 });
  assert.equal(context.window[key + "_enh"].model, "seedance_v2.0");
  assert.equal(context.window[key + "_enh"].duration, 10);
  await driver.setGenerationOptions(previous);
  assert.equal(context.window[key + "_enh"].model, "seedance_v2.5");
  assert.equal(context.window[key + "_enh"].duration, 30);
});

test("多次提交独立排队，快照不随模板编辑变化，无重复任务记录", async () => {
  store.add({ id: "test", name: "测试账号" });
  store.get().settings.quota.perDay = 10;
  Object.assign(store.get().settings.orchestrator, { maxParallel: 1, pollInterval: 1500, autoDownload: false });
  const calls = [];
  const driver = {
    beginTask: async () => ({ ok: true, baselineUrls: [] }),
    setGenerationOptions: async (value) => { calls.push(["options", value]); return { model: "seedance_v2.5", duration: 30 }; },
    pasteFiles: async (files) => { calls.push(["files", files]); return { ok: true }; },
    setText: async (text) => { calls.push(["prompt", text]); return { ok: true }; },
    send: async () => ({ ok: true }), readProgress: async () => ({ state: "done", mediaUrls: [`https://fixture.invalid/task-${calls.length}.mp4?lr=watermark`] }), evaluate: async () => []
  };
  orchestrator.init({ findWebContents: () => ({}), resolveDriver: async () => driver });
  const item = templates.create({ prompt: "原始提示词", model: "seedance_v2.0", duration: 10, ratio: "9:16" });
  await templates.importAttachments(item.id, [fixture("reference.mp4")]);
  const first = orchestrator.submitTemplate(templates.snapshot(item.id));
  const second = orchestrator.submitTemplate(templates.snapshot(item.id));
  assert.notEqual(first.taskId, second.taskId);
  assert.equal(orchestrator.getTask(second.taskId).status, "queued");
  templates.update(item.id, { prompt: "新的提示词" });
  templates.remove(item.id);
  await done();
  assert.deepEqual(store.get().tasks.map((t) => t.status), ["succeeded", "succeeded"]);
  assert.equal(store.get().tasks.length, 2);
  assert.ok(store.get().tasks.every((task) => task.ratio === "9:16" && task.prompt.includes("画面比例 9:16")));
  assert.ok(calls.filter(([kind]) => kind === "prompt").every(([, text]) => text.includes("原始提示词") && text.includes("10 秒") && text.includes("Seedance 2.0")));
  assert.equal(calls.filter(([kind]) => kind === "files").length, 2);
  assert.equal(calls.filter(([kind]) => kind === "options").length, 4);
  store.load();
  assert.equal(store.get().tasks[1].templateName, "未命名模板");
});

test("附件传入失败时不发送任务；没有账号时保留排队记录", async () => {
  const item = templates.create({ prompt: "测试" });
  await templates.importAttachments(item.id, [fixture("bad.mp4")]);
  orchestrator.init({ findWebContents: () => null });
  const waiting = orchestrator.submitTemplate(templates.snapshot(item.id));
  assert.equal(orchestrator.getTask(waiting.taskId).stage, "waiting_account");
  assert.match(orchestrator.getTask(waiting.taskId).waitReason, /尚无账号/);
  orchestrator.stopTask(waiting.taskId);
  store.add({ id: "test", name: "测试账号" });
  store.get().settings.orchestrator.retryLimit = 0;
  let sent = false;
  orchestrator.init({ findWebContents: () => ({}), resolveDriver: async () => ({ beginTask: async () => ({ ok: true, baselineUrls: [] }), setGenerationOptions: async () => ({}), pasteFiles: async () => ({ ok: false, reason: "失败" }), send: async () => { sent = true; } }) });
  const result = orchestrator.submitTemplate(templates.snapshot(item.id));
  await done();
  assert.equal(sent, false);
  assert.equal(orchestrator.getTask(result.taskId).status, "failed");
  assert.match(orchestrator.getTask(result.taskId).error, /附件上传失败/);
});

test("停止排队任务不会发送，全部停止能在提交前取消正在准备的任务", async () => {
  store.add({ id: "stop-test", name: "测试账号" });
  store.get().settings.quota.perDay = 10;
  store.get().settings.orchestrator.maxParallel = 1;
  let release;
  let sent = false;
  orchestrator.init({ findWebContents: () => ({}), resolveDriver: () => new Promise((resolve) => { release = resolve; }) });
  const item = templates.create({ prompt: "待停止任务" });
  const first = orchestrator.submitTemplate(templates.snapshot(item.id));
  const second = orchestrator.submitTemplate(templates.snapshot(item.id));
  orchestrator.stopTask(second.taskId);
  assert.equal(orchestrator.getTask(second.taskId).status, "cancelled");
  orchestrator.stopAll();
  release({ send: async () => { sent = true; } });
  await done();
  assert.equal(orchestrator.getTask(first.taskId).status, "cancelled");
  assert.equal(sent, false);
});

test("重启后未结束的模板任务标记为中断，保留快照以供手动重试", () => {
  const sb = storyboard.create({ source: "task-template", name: "恢复", shots: [{ videoPrompt: "继续用原始内容", status: "running" }] });
  store.get().tasks.push({ id: "interrupted", templateId: "removed-template", templateName: "原模板", storyboardId: sb.id, shotId: sb.shots[0].id, prompt: "继续用原始内容", model: "seedance_v2.0", duration: 15, refs: [], status: "running" });
  store.save();
  store.load();
  orchestrator.recoverTemplateTasks();
  store.save();
  store.load();
  const task = orchestrator.getTask("interrupted");
  assert.equal(task.status, "failed");
  assert.match(task.error, /确认页面状态后重试/);
  assert.equal(task.model, "seedance_v2.0");
  assert.equal(task.prompt, "继续用原始内容");
});
