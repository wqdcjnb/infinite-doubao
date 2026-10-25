"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const P = require("../src/paths");
const store = require("../src/store");
const storyboard = require("../src/storyboard");
const interceptor = require("../src/interceptor");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-ui-fixes-"));
P.init({ home });
after(() => fs.rmSync(home, { recursive: true, force: true }));

test("新用户和重新加载后均不生成演示账号", () => {
  assert.deepEqual(store.load().instances, []);
  assert.equal(store.save(), true);
  assert.deepEqual(store.load().instances, []);
  assert.deepEqual(store.get().order, []);
});

test("默认视频目录使用专用文件夹，路径表遵循自定义目录", () => {
  assert.equal(P.downloadDir(), path.join(os.homedir(), "Downloads", "豆包工坊", "生成视频"));
  const custom = path.join(home, "生成视频");
  assert.equal(P.downloadDir(`  ${custom}  `), custom);
  assert.equal(P.all(custom).downloads, custom);
  assert.equal(P.all().downloads, P.downloadDir());
});

test("自动下载和手动下载使用同一设置并真实写入视频文件", async () => {
  const custom = path.join(home, "成片");
  store.get().settings.downloadDir = custom;
  const media = Buffer.alloc(32);
  media.write("ftyp", 4);
  const session = { fetch: async () => ({ ok: true, headers: new Map([["content-type", "video/mp4"]]), arrayBuffer: async () => media }) };
  const item = { url: "https://example.invalid/video.mp4", kind: "video" };
  const automatic = await interceptor.download(session, { ...item }, { fileName: "自动.mp4" });
  const manual = await interceptor.download(session, { ...item }, { fileName: "手动.mp4", dir: custom });
  assert.equal(path.dirname(automatic.file), custom);
  assert.equal(path.dirname(manual.file), custom);
  assert.deepEqual(fs.readFileSync(automatic.file), media);
  assert.deepEqual(fs.readFileSync(manual.file), media);
});

test("删除镜头后重排序号、清理关联任务并持久保存", () => {
  const sb = storyboard.create({ name: "镜头删除", shots: [{ title: "一" }, { title: "二" }, { title: "三" }] });
  const deleted = sb.shots[1].id;
  store.get().tasks.push({ id: "removed-task", storyboardId: sb.id, shotId: deleted, status: "failed" });
  store.get().tasks.push({ id: "kept-task", storyboardId: sb.id, shotId: sb.shots[0].id, status: "succeeded" });
  storyboard.removeShot(sb.id, deleted);
  store.load();
  assert.deepEqual(storyboard.get(sb.id).shots.map((s) => [s.title, s.index]), [["一", 1], ["三", 2]]);
  assert.equal(storyboard.list().find((s) => s.id === sb.id).total, 2);
  assert.equal(store.get().tasks.some((t) => t.id === "removed-task"), false);
  assert.equal(store.get().tasks.some((t) => t.id === "kept-task"), true);
});

test("删除整份分镜稿与任务记录，保留其他分镜及下载文件", () => {
  const sb = storyboard.create({ name: "整稿删除", shots: [{ title: "镜头" }] });
  store.get().tasks.push({ id: "board-task", storyboardId: sb.id, shotId: sb.shots[0].id, status: "succeeded" });
  const file = path.join(home, "已下载.mp4");
  fs.writeFileSync(file, "keep");
  storyboard.remove(sb.id);
  store.load();
  assert.equal(storyboard.get(sb.id), null);
  assert.equal(store.get().settings.lastStoryboardId, "");
  assert.equal(store.get().tasks.some((t) => t.storyboardId === sb.id), false);
  assert.equal(storyboard.list().length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
});

test("运行或排队中的镜头与分镜稿拒绝删除且不改动数据", () => {
  const sb = storyboard.create({ name: "运行中", shots: [{ status: "running" }, { status: "pending" }] });
  assert.throws(() => storyboard.remove(sb.id), /请先停止派发/);
  assert.throws(() => storyboard.removeShot(sb.id, sb.shots[0].id), /请先停止派发/);
  store.get().tasks.push({ id: "queued-task", storyboardId: sb.id, shotId: sb.shots[1].id, status: "queued" });
  assert.throws(() => storyboard.removeShot(sb.id, sb.shots[1].id), /请先停止派发/);
  assert.equal(storyboard.get(sb.id).shots.length, 2);
});
