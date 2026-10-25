"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const P = require("./paths");
const store = require("./store");

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".m4v": "video/mp4", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska"
};
const extensions = Object.keys(MIME).map((ext) => ext.slice(1));
const newId = () => crypto.randomBytes(12).toString("hex");

function options() {
  return {
    models: store.MODEL_OPTIONS,
    defaults: store.get().settings.enhancer,
    directory: P.dir("attachments")
  };
}

function get(id) {
  const item = store.get().taskTemplates.find((t) => t.id === String(id));
  if (!item) throw new Error("模板不存在");
  return item;
}

function list() { return store.get().taskTemplates; }

function values(input, previous = {}) {
  const defaults = store.get().settings.enhancer;
  const model = String(input.model ?? previous.model ?? defaults.model);
  const duration = Number(input.duration ?? previous.duration ?? defaults.duration);
  if (!Object.hasOwn(store.MODEL_LIMITS, model)) throw new Error("请选择列表中的模型");
  if (!Number.isInteger(duration) || duration < 1 || duration > store.maxDurationFor(model)) {
    throw new Error(`当前模型的时长应为 1–${store.maxDurationFor(model)} 秒`);
  }
  return {
    name: String(input.name ?? previous.name ?? "未命名模板").trim() || "未命名模板",
    prompt: String(input.prompt ?? previous.prompt ?? ""), model, duration,
    updatedAt: new Date().toISOString()
  };
}

function create(input = {}, legacyId) {
  const item = { id: newId(), ...values(input), attachments: [], createdAt: new Date().toISOString(), ...(legacyId ? { legacyId } : {}) };
  store.get().taskTemplates.push(item);
  if (!store.save()) { store.get().taskTemplates.pop(); throw new Error("模板保存失败，请检查磁盘空间或目录权限"); }
  return item;
}

function update(id, patch) {
  const item = get(id);
  const previous = { ...item };
  Object.assign(item, values(patch, item));
  if (!store.save()) { Object.assign(item, previous); throw new Error("模板保存失败"); }
  return item;
}

function remove(id) {
  get(id);
  const data = store.get();
  const previous = data.taskTemplates;
  data.taskTemplates = previous.filter((t) => t.id !== id);
  if (!store.save()) { data.taskTemplates = previous; throw new Error("删除模板失败"); }
  // 已提交的任务持有附件路径快照，删除模板不删除这些文件。
  return { removed: id };
}

async function importAttachments(id, files) {
  get(id);
  const sources = [...new Set(files || [])];
  const imported = [];
  const directory = P.dir("attachments");
  await fs.promises.mkdir(directory, { recursive: true });
  try {
    for (const source of sources) {
      const ext = path.extname(source).toLowerCase();
      if (!MIME[ext]) throw new Error(`只支持图片或视频：${path.basename(source)}`);
      const stat = await fs.promises.stat(source);
      if (!stat.isFile() || stat.size === 0) throw new Error(`附件为空或不是文件：${path.basename(source)}`);
      const fileId = newId();
      const target = path.join(directory, fileId + ext);
      await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      imported.push({ id: fileId, name: path.basename(source), path: target, mime: MIME[ext], size: stat.size });
    }
    const item = get(id);
    const previous = item.attachments;
    const updatedAt = item.updatedAt;
    item.attachments = [...previous, ...imported];
    item.updatedAt = new Date().toISOString();
    if (!store.save()) { item.attachments = previous; item.updatedAt = updatedAt; throw new Error("附件记录保存失败"); }
    return item;
  } catch (error) {
    for (const file of imported) await fs.promises.unlink(file.path).catch(() => {});
    throw error;
  }
}

function removeAttachment(id, fileId) {
  const item = get(id);
  const previous = item.attachments;
  item.attachments = previous.filter((file) => file.id !== fileId);
  if (!store.save()) { item.attachments = previous; throw new Error("附件移除失败"); }
  return item;
}

function validateSnapshot(item) {
  if (!item.prompt.trim()) throw new Error("请先填写提示词");
  values(item);
  for (const file of item.attachments) {
    if (file.missing || !fs.existsSync(file.path)) throw new Error(`找不到已保存的附件「${file.name}」，请重新添加`);
  }
  return JSON.parse(JSON.stringify(item));
}

function snapshot(id) { return validateSnapshot(get(id)); }

async function migrateLegacy() {
  const data = store.get();
  if (data.taskTemplatesMigrated) return;
  for (const sb of data.storyboards) {
    if (sb.source === "task-template") continue;
    for (const shot of sb.shots || []) {
      const legacyId = `${sb.id}/${shot.id}`;
      if (data.taskTemplates.some((t) => t.legacyId === legacyId)) continue;
      const config = store.clampEnhancer({ ...data.settings.enhancer, ...(shot.model ? { model: shot.model } : {}), ...(shot.duration ? { duration: shot.duration } : {}) });
      if (!Object.hasOwn(store.MODEL_LIMITS, config.model)) config.model = data.settings.enhancer.model;
      const item = create({ name: `${sb.name} · ${shot.title || `镜头 ${shot.index}`}`, prompt: shot.videoPrompt || shot.imagePrompt || "", model: config.model, duration: Math.min(config.duration, store.maxDurationFor(config.model)) }, legacyId);
      for (const ref of shot.refs || []) {
        try { await importAttachments(item.id, [ref]); }
        catch {
          item.attachments.push({ id: newId(), name: path.basename(ref), path: ref, mime: MIME[path.extname(ref).toLowerCase()] || "", size: 0, missing: true });
        }
      }
      if (!store.save()) throw new Error("旧分镜转换保存失败");
    }
  }
  data.taskTemplatesMigrated = true;
  if (!store.save()) { data.taskTemplatesMigrated = false; throw new Error("模板迁移保存失败"); }
}

module.exports = { MIME, extensions, options, list, get, create, update, remove, importAttachments, removeAttachment, snapshot, validateSnapshot, migrateLegacy };
