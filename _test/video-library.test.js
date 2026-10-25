"use strict";

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { fileURLToPath } = require("node:url");
const P = require("../src/paths");
const store = require("../src/store");
const videos = require("../src/video-library");
const interceptor = require("../src/interceptor");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-video-library-"));
let index = 0;
beforeEach(() => {
  P.init({ home: path.join(root, String(++index)) });
  store.load();
  store.get().settings.downloadDir = path.join(P.home(), "生成视频");
  store.save();
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
function write(file, content = "video bytes") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test("素材库只列出视频目录内非空成片，正确处理子目录和特殊文件名", async () => {
  assert.deepEqual((await videos.list()).items, []);
  const dir = store.get().settings.downloadDir;
  const file = write(path.join(dir, "子目录", "成片 #1 中文.MP4"));
  write(path.join(dir, "截图.png"));
  write(path.join(dir, "未完成.mp4.part"));
  write(path.join(dir, "空视频.mp4"), "");
  write(path.join(P.dir("attachments"), "参考视频.mp4"));
  const result = await videos.list();
  assert.equal(result.directory, dir);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].path, file);
  assert.equal(fileURLToPath(result.items[0].url), file);
});

test("任务成片跨保存目录保留并去重，文件移除后刷新不出现失效条目", async () => {
  const dir = store.get().settings.downloadDir;
  const current = write(path.join(dir, "当前.mp4"));
  const old = write(path.join(P.home(), "旧保存目录", "旧成片.webm"));
  store.get().tasks.push({ templateName: "旧模板", model: "seedance_v2.0_fast", duration: 15, result: { files: [old, current, path.join(dir, "丢失.mp4")] } });
  store.save();
  store.load();
  let result = await videos.list();
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find((item) => item.path === old).templateName, "旧模板");
  fs.unlinkSync(old);
  result = await videos.list();
  assert.deepEqual(result.items.map((item) => item.path), [current]);
});

test("下载完成的文件直接进入素材库，重载后仍可读取", async () => {
  const media = Buffer.alloc(32);
  media.write("ftyp", 4);
  const session = { fetch: async () => ({ ok: true, headers: new Map([["content-type", "video/mp4"]]), arrayBuffer: async () => media }) };
  const downloaded = await interceptor.download(session, { url: "https://example.invalid/final.mp4", kind: "video" }, { fileName: "最终视频.mp4" });
  store.load();
  const result = await videos.list();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].path, downloaded.file);
  assert.equal(result.items[0].size, media.length);
});
