"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("2000条资源按任务关联元数据，任务id读取量保持线性", async (t) => {
  const count = 2000;
  let idReads = 0;
  const tasks = Array.from({ length: count }, (_, i) => ({
    get id() { idReads++; return `task-${i}`; },
    templateName: `模板 ${i}`, model: `model-${i}`, duration: i % 30 + 1,
    result: { files: [] }
  }));
  const resources = tasks.map((_, i) => ({
    id: `resource-${i}`, taskId: `task-${i}`,
    downloaded: path.resolve("synthetic-video-library", `${i}.mp4`), watermark: "none"
  }));
  const inspectedFiles = [];
  const stubs = {
    "node:fs/promises": {
      readdir: async () => [],
      stat: async (file) => {
        inspectedFiles.push(file);
        return { isFile: () => true, size: 128, mtime: new Date(0) };
      }
    },
    "./paths": { downloadDir: () => path.resolve("synthetic-video-library") },
    "./store": { get: () => ({ settings: {}, tasks }) },
    "./interceptor": { list: () => resources }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/video-library.js"), "utf8"), {
    module, process,
    require: (name) => Object.hasOwn(stubs, name) ? stubs[name] : require(name)
  });
  const result = await module.exports.list();
  assert.equal(result.items.length, count);
  for (const item of result.items) {
    const index = Number(path.basename(item.path, ".mp4"));
    assert.equal(item.taskId, `task-${index}`);
    assert.equal(item.templateName, `模板 ${index}`);
    assert.equal(item.model, `model-${index}`);
    assert.equal(item.duration, index % 30 + 1);
    assert.equal(item.resourceId, `resource-${index}`);
    assert.equal(item.watermark, "none");
  }
  assert.deepEqual(inspectedFiles, resources.map((resource) => resource.downloaded), "stat顺序保持原资源顺序");
  assert.ok(idReads <= count * 2, `关联资源不应逐条遍历所有任务，实际读取 ${idReads}`);
  t.diagnostic(`2000 tasks/resources: ${idReads} task id reads (before: 2003000)`);
});
