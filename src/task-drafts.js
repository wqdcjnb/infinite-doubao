"use strict";

const crypto = require("node:crypto");
const store = require("./store");
const templates = require("./task-templates");

function list() { return store.get().taskDrafts; }
function numberFor(id) { return `DB-${String(id).toUpperCase()}`; }

function create(templateId, executionMode = "work") {
  return createMany([templateId], executionMode)[0];
}

function createMany(templateIds, executionMode = "work") {
  if (executionMode !== "work") throw new Error("草稿提交仅支持工作任务 · 云电脑");
  if (!Array.isArray(templateIds) || !templateIds.length) throw new Error("请先勾选任务模板");
  const added = [...new Set(templateIds)].map((templateId) => {
    const id = crypto.randomBytes(12).toString("hex");
    return { id, draftNumber: numberFor(id), template: templates.snapshot(templateId), executionMode, createdAt: new Date().toISOString() };
  });
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
  removeMany([id]);
  return { removed: id };
}

function removeMany(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error("请先勾选要删除的草稿");
  const selected = new Set(ids);
  const data = store.get();
  const previous = data.taskDrafts;
  if ([...selected].some((id) => !previous.some((d) => d.id === id))) throw new Error("部分草稿不存在或已提交，请刷新草稿箱");
  data.taskDrafts = previous.filter((d) => !selected.has(d.id));
  if (!store.save()) { data.taskDrafts = previous; throw new Error("删除草稿失败，请检查磁盘空间或目录权限"); }
  return { removed: [...selected], count: selected.size };
}

module.exports = { list, create, createMany, updateMany, remove, removeMany, numberFor };
