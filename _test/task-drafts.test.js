"use strict";
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const P = require("../src/paths"), store = require("../src/store");
const templates = require("../src/task-templates"), drafts = require("../src/task-drafts"), queue = require("../src/orchestrator");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-drafts-"));
let count = 0;
beforeEach(() => { P.init({ home: path.join(root, String(++count)) }); store.load(); });
after(() => fs.rmSync(root, { recursive: true, force: true }));
function template(prompt = "清晨湖面的小鱼") { return templates.create({ name: "草稿", prompt, model: "seedance_v2.0_mini", duration: 5 }); }

test("重复添加同一模板分配独立编号，重载和编辑模板不改变编号", () => {
  const t = template(), a = drafts.create(t.id), b = drafts.create(t.id);
  assert.match(a.draftNumber, /^DB-[0-9A-F]{24}$/);
  assert.notEqual(a.draftNumber, b.draftNumber);
  templates.update(t.id, { prompt: "改动后的模板" }); store.load();
  assert.deepEqual(drafts.list().map(d => d.draftNumber), [a.draftNumber, b.draftNumber]);
  assert.ok(drafts.list().every(d => d.template.prompt === "清晨湖面的小鱼"));
  drafts.remove(a.id); assert.notEqual(drafts.create(t.id).draftNumber, a.draftNumber);
});
test("草稿保存提示词和附件快照，重载不发送", async () => {
  const t = template(), file = path.join(P.home(), "ref.png"); fs.writeFileSync(file, "image");
  await templates.importAttachments(t.id, [file]); const d = drafts.create(t.id);
  templates.update(t.id, { prompt: "另一条" }); templates.remove(t.id); store.load();
  assert.equal(drafts.list()[0].template.prompt, "清晨湖面的小鱼");
  assert.ok(fs.existsSync(d.template.attachments[0].path)); assert.equal(store.get().tasks.length, 0);
});
test("多选模板一次保存独立快照，本地草稿不能直接冒充豆包草稿发送", async () => {
  const a = template(), b = template("第二条");
  const added = drafts.createMany([a.id, b.id, a.id]); assert.equal(added.length, 2);
  await assert.rejects(queue.submitDrafts(added.map((d) => d.id)), /先将所选草稿存入豆包/);
  store.load(); assert.equal(drafts.list()[1].template.prompt, "第二条"); assert.equal(store.get().tasks.length, 0);
});
test("整批附件校验失败不开始保存或发送", async () => {
  const t = template(), first = drafts.create(t.id), file = path.join(P.home(), "ref.mp4"); fs.writeFileSync(file, "video");
  await templates.importAttachments(t.id, [file]); const second = drafts.create(t.id); fs.unlinkSync(second.template.attachments[0].path);
  await assert.rejects(queue.saveDrafts([first.id, second.id]), /附件/);
  assert.equal(store.get().tasks.length, 0); assert.equal(drafts.list().length, 2);
});
test("写盘失败回滚整批快照和草稿状态", () => {
  const d = drafts.create(template().id), save = store.save; store.save = () => false;
  try {
    assert.throws(() => drafts.createMany([d.template.id]), /保存失败/);
    assert.throws(() => drafts.updateMany({ [d.id]: { nativeState: "saved" } }), /保存失败/);
  } finally { store.save = save; }
  assert.equal(drafts.list()[0].nativeState, undefined); store.load(); assert.equal(drafts.list().length, 1);
});
test("空提示词非法模式空选择被拒绝，移除记录保留模板", async () => {
  assert.throws(() => drafts.create(template(" ").id), /提示词/);
  const t = template(); assert.throws(() => drafts.create(t.id, "invalid"), /仅支持/);
  assert.throws(() => drafts.create(t.id, "video"), /仅支持工作任务 · 云电脑/);
  await assert.rejects(queue.submitDrafts([]), /勾选/);
  const d = drafts.create(t.id); drafts.remove(d.id); assert.equal(drafts.list().length, 0); assert.ok(templates.get(t.id));
});
