"use strict";

const crypto = require("node:crypto");
const store = require("./store");
const templates = require("./task-templates");

function list() { return store.get().taskDrafts; }

function create(templateId, executionMode = "work") {
  return createMany([templateId], executionMode)[0];
}

function createMany(templateIds, executionMode = "work") {
  if (!["video", "work"].includes(executionMode)) throw new Error("请选择对话视频生成或工作任务 · 云电脑");
  if (!Array.isArray(templateIds) || !templateIds.length) throw new Error("请先勾选任务模板");
  const added = [...new Set(templateIds)].map((id) => ({ id: crypto.randomBytes(12).toString("hex"), template: templates.snapshot(id), executionMode, createdAt: new Date().toISOString() }));
  const previous = list();
  store.get().taskDrafts = [...previous, ...added];
  if (!store.save()) { store.get().taskDrafts = previous; throw new Error("草稿保存失败，请检查磁盘空间或目录权限"); }
  return added;
}

function updateMany(patches) {
  const previous = list();
  store.get().taskDrafts = previous.map((d) => patches[d.id] ? { ...d, ...patches[d.id] } : d);
  if (!store.save()) { store.get().taskDrafts = previous; throw new Error("草稿状态保存失败，请检查磁盘空间或目录权限"); }
}

function remove(id) {
  const data = store.get();
  const previous = data.taskDrafts;
  if (!previous.some((d) => d.id === id)) throw new Error("草稿不存在或已提交，请刷新草稿箱");
  data.taskDrafts = previous.filter((d) => d.id !== id);
  if (!store.save()) { data.taskDrafts = previous; throw new Error("移除草稿失败"); }
  return { removed: id };
}

module.exports = { list, create, createMany, updateMany, remove };
