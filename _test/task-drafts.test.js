"use strict";

const { test, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const P = require("../src/paths");
const store = require("../src/store");
const templates = require("../src/task-templates");
const drafts = require("../src/task-drafts");
const queue = require("../src/orchestrator");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-drafts-"));
let count = 0;
beforeEach(() => { P.init({ home: path.join(root, String(++count)) }); store.load(); });
afterEach(() => queue.stopAll());
after(() => fs.rmSync(root, { recursive: true, force: true }));
function template(prompt = "清晨湖面，一条小鱼跃出水面") { return templates.create({ name: "视频草稿", prompt, model: "seedance_v2.0_mini", duration: 5 }); }

test("草稿独立保存提示词、模式和附件快照，重载后不自动发送", async () => {
  const t = template();
  const file = path.join(P.home(), "reference.png");
  fs.writeFileSync(file, "image");
  await templates.importAttachments(t.id, [file]);
  const d = drafts.create(t.id);
  templates.update(t.id, { prompt: "另一段视频" });
  templates.remove(t.id);
  store.load();
  assert.equal(drafts.list().length, 1);
  assert.equal(drafts.list()[0].template.prompt, "清晨湖面，一条小鱼跃出水面");
  assert.equal(drafts.list()[0].executionMode, "work");
  assert.ok(fs.existsSync(d.template.attachments[0].path));
  assert.equal(store.get().tasks.length, 0);
});

test("只提交所选草稿，一次保存整批，重复请求不会创建第二份任务", () => {
  const t = template();
  const first = drafts.create(t.id);
  templates.update(t.id, { prompt: "第二条提示词" });
  const second = drafts.create(t.id, "video");
  const retained = drafts.create(t.id);
  const result = queue.submitDrafts([first.id, second.id, first.id]);
  assert.equal(result.count, 2);
  assert.deepEqual(store.get().tasks.map((t) => t.executionMode), ["work", "video"]);
  assert.match(store.get().tasks[0].prompt, /清晨湖面/);
  assert.match(store.get().tasks[1].prompt, /第二条提示词/);
  assert.deepEqual(drafts.list().map((d) => d.id), [retained.id]);
  assert.equal(store.get().settings.lastStoryboardId, store.get().tasks[1].storyboardId);
  assert.throws(() => queue.submitDrafts([first.id, retained.id]), /已提交/);
  assert.equal(store.get().tasks.length, 2);
  store.load();
  assert.equal(store.get().tasks.length, 2);
  assert.equal(drafts.list().length, 1);
});

test("整批校验失败不入队、不移除草稿", async () => {
  const t = template();
  const first = drafts.create(t.id);
  const file = path.join(P.home(), "ref.mp4");
  fs.writeFileSync(file, "video");
  await templates.importAttachments(t.id, [file]);
  const second = drafts.create(t.id);
  fs.unlinkSync(second.template.attachments[0].path);
  assert.throws(() => queue.submitDrafts([first.id, second.id]), /附件/);
  assert.equal(store.get().tasks.length, 0);
  assert.equal(store.get().storyboards.length, 0);
  assert.equal(drafts.list().length, 2);
});

test("磁盘写入失败回滚整批，恢复后可重新提交", () => {
  const d = drafts.create(template().id);
  store.get().settings.lastStoryboardId = "previous-board";
  store.save();
  const save = store.save;
  store.save = () => false;
  try { assert.throws(() => queue.submitDrafts([d.id]), /保存失败/); }
  finally { store.save = save; }
  assert.equal(store.get().tasks.length, 0);
  assert.equal(store.get().storyboards.length, 0);
  assert.equal(drafts.list().length, 1);
  assert.equal(store.get().settings.lastStoryboardId, "previous-board");
  store.load();
  assert.equal(queue.submitDrafts([d.id]).count, 1);
});

test("空提示词、非法模式和空选择不能提交，移除草稿保留模板", () => {
  assert.throws(() => drafts.create(template(" ").id), /提示词/);
  const t = template();
  assert.throws(() => drafts.create(t.id, "invalid"), /请选择/);
  assert.throws(() => queue.submitDrafts([]), /勾选/);
  const d = drafts.create(t.id);
  drafts.remove(d.id);
  assert.equal(drafts.list().length, 0);
  assert.ok(templates.get(t.id));
});
