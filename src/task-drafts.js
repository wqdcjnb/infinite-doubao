"use strict";

const crypto = require("node:crypto");
const store = require("./store");
const templates = require("./task-templates");

function list() { return store.get().taskDrafts; }

function create(templateId, executionMode = "work") {
  if (!["video", "work"].includes(executionMode)) throw new Error("请选择对话视频生成或工作任务 · 云电脑");
  const draft = { id: crypto.randomBytes(12).toString("hex"), template: templates.snapshot(templateId), executionMode, createdAt: new Date().toISOString() };
  list().push(draft);
  if (!store.save()) { list().pop(); throw new Error("草稿保存失败，请检查磁盘空间或目录权限"); }
  return draft;
}

function remove(id) {
  const data = store.get();
  const previous = data.taskDrafts;
  if (!previous.some((d) => d.id === id)) throw new Error("草稿不存在或已提交，请刷新草稿箱");
  data.taskDrafts = previous.filter((d) => d.id !== id);
  if (!store.save()) { data.taskDrafts = previous; throw new Error("移除草稿失败"); }
  return { removed: id };
}

module.exports = { list, create, remove };
