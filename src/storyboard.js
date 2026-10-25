"use strict";

/**
 * 分镜中心数据层
 *
 * 对标产品的分镜只有「一串镜头」，派发失败就整批重来。这里每个镜头是一条独立记录：
 * 有自己的状态、尝试次数、结果、错误、去重键，能单条重试 / 改派 / 挂起，
 * 批量任务因此可以中断、续跑、局部重试。
 */

const crypto = require("node:crypto");
const store = require("./store");
const md = require("./markdown");
const log = require("./logger");

const STATUSES = ["pending", "queued", "running", "succeeded", "failed", "cancelled", "parked", "skipped"];

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function normalizeShot(raw, idx) {
  return {
    id: String((raw && raw.id) || newId("shot")),
    index: Number((raw && raw.index) || idx + 1),
    title: String((raw && raw.title) || `镜头 ${idx + 1}`),
    scene: String((raw && raw.scene) || ""),
    imagePrompt: String((raw && raw.imagePrompt) || ""),
    videoPrompt: String((raw && raw.videoPrompt) || ""),
    duration: Number((raw && raw.duration) || 0),
    model: String((raw && raw.model) || ""),
    refs: Array.isArray(raw && raw.refs) ? raw.refs.map(String) : [],
    mode: String((raw && raw.mode) || ""),
    credits: Number((raw && raw.credits) || 0),
    note: String((raw && raw.note) || ""),
    persona: String((raw && raw.persona) || ""),
    sceneAsset: String((raw && raw.sceneAsset) || ""),
    status: STATUSES.includes(raw && raw.status) ? raw.status : "pending",
    taskId: String((raw && raw.taskId) || ""),
    result: (raw && raw.result) || null,
    error: String((raw && raw.error) || ""),
    attempts: Number((raw && raw.attempts) || 0),
    instanceId: String((raw && raw.instanceId) || ""),
    startedAt: String((raw && raw.startedAt) || ""),
    finishedAt: String((raw && raw.finishedAt) || "")
  };
}

function normalizeStoryboard(raw) {
  const now = new Date().toISOString();
  return {
    id: String((raw && raw.id) || newId("sb")),
    name: String((raw && raw.name) || "未命名分镜"),
    note: String((raw && raw.note) || ""),
    source: String((raw && raw.source) || "manual"),
    shots: (Array.isArray(raw && raw.shots) ? raw.shots : []).map(normalizeShot),
    createdAt: String((raw && raw.createdAt) || now),
    updatedAt: String((raw && raw.updatedAt) || now)
  };
}

function list() {
  return store.get().storyboards.map((s) => ({
    id: s.id,
    name: s.name,
    note: s.note,
    source: s.source,
    total: s.shots.length,
    stats: stats(s),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  }));
}

function raw(id) {
  return store.get().storyboards.find((s) => s.id === String(id)) || null;
}

function get(id) {
  return raw(id);
}

function touch(sb) {
  sb.updatedAt = new Date().toISOString();
  store.save();
  return sb;
}

function create(input = {}) {
  const sb = normalizeStoryboard({
    id: input.id,
    name: input.name,
    note: input.note,
    source: input.source || "manual",
    shots: input.shots
  });
  store.get().storyboards.push(sb);
  store.get().settings.lastStoryboardId = sb.id;
  touch(sb);
  log.info("storyboard-created", { id: sb.id, name: sb.name, shots: sb.shots.length });
  return sb;
}

function remove(id) {
  const data = store.get();
  const idx = data.storyboards.findIndex((s) => s.id === String(id));
  if (idx < 0) return null;
  assertDeletable(data.storyboards[idx]);
  const [sb] = data.storyboards.splice(idx, 1);
  data.tasks = data.tasks.filter((t) => t.storyboardId !== sb.id);
  if (data.settings.lastStoryboardId === sb.id) data.settings.lastStoryboardId = "";
  store.save();
  return sb;
}

function update(id, patch = {}) {
  const sb = raw(id);
  if (!sb) return null;
  if (patch.name !== undefined) sb.name = String(patch.name);
  if (patch.note !== undefined) sb.note = String(patch.note);
  return touch(sb);
}

function importMarkdown(name, text) {
  const parsed = md.parse(text);
  const sb = create({ name: name || "导入分镜", shots: parsed.shots, source: "markdown" });
  return { storyboard: sb, warnings: parsed.warnings };
}

function exportMarkdown(id) {
  const sb = raw(id);
  if (!sb) return "";
  return md.stringify(sb);
}

function addShots(id, shots) {
  const sb = raw(id);
  if (!sb) return null;
  const base = sb.shots.length;
  for (const s of shots || []) sb.shots.push(normalizeShot(s, base + sb.shots.length));
  return touch(sb);
}

function updateShot(sbId, shotId, patch = {}) {
  const sb = raw(sbId);
  if (!sb) return null;
  const shot = sb.shots.find((s) => s.id === String(shotId));
  if (!shot) return null;
  Object.assign(shot, patch, { id: shot.id });
  touch(sb);
  return shot;
}

function removeShot(sbId, shotId) {
  const sb = raw(sbId);
  if (!sb) return null;
  const idx = sb.shots.findIndex((s) => s.id === String(shotId));
  if (idx < 0) return null;
  assertDeletable(sb, shotId);
  const [shot] = sb.shots.splice(idx, 1);
  store.get().tasks = store.get().tasks.filter((t) => t.storyboardId !== sb.id || t.shotId !== shot.id);
  // 重排序号，避免删完中间留空
  sb.shots.forEach((s, i) => { s.index = i + 1; });
  touch(sb);
  return shot;
}

function assertDeletable(sb, shotId) {
  const active = (status) => status === "queued" || status === "running";
  const shots = shotId ? sb.shots.filter((s) => s.id === shotId) : sb.shots;
  const tasks = store.get().tasks.filter((t) => t.storyboardId === sb.id && (!shotId || t.shotId === shotId));
  if (shots.some((s) => active(s.status)) || tasks.some((t) => active(t.status))) {
    throw new Error("还有排队或生成中的任务，请先停止派发并等待任务结束后再删除。");
  }
}

function reorderShots(sbId, ids) {
  const sb = raw(sbId);
  if (!sb) return null;
  const map = new Map(sb.shots.map((s) => [s.id, s]));
  const next = [];
  for (const id of ids || []) {
    const s = map.get(String(id));
    if (s) { next.push(s); map.delete(String(id)); }
  }
  for (const s of map.values()) next.push(s);
  next.forEach((s, i) => { s.index = i + 1; });
  sb.shots = next;
  return touch(sb);
}

function setStatus(sbId, shotId, status, extra = {}) {
  if (!STATUSES.includes(status)) throw new Error("未知状态：" + status);
  return updateShot(sbId, shotId, { status, ...extra });
}

/** 重置失败/取消的镜头，供续跑 */
function resetShots(sbId, statuses = ["failed", "cancelled", "skipped", "parked"]) {
  const sb = raw(sbId);
  if (!sb) return null;
  let n = 0;
  for (const shot of sb.shots) {
    if (statuses.includes(shot.status)) {
      shot.status = "pending";
      shot.error = "";
      n += 1;
    }
  }
  touch(sb);
  return { reset: n };
}

/** 去重键：同一分镜同一条提示词 + 同一组参考图只派一次 */
function dedupeKey(storyboardId, shot) {
  const h = crypto.createHash("sha1")
    .update([storyboardId, shot.index, shot.videoPrompt, (shot.refs || []).join(",")].join("|"))
    .digest("hex");
  return h.slice(0, 16);
}

function seenKeys(storyboardId) {
  const sb = raw(storyboardId);
  if (!sb) return new Set();
  return new Set(sb.shots.filter((s) => s.status === "succeeded" || s.status === "running").map((s) => dedupeKey(sb.id, s)));
}

function stats(sb) {
  const out = { total: 0, pending: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, parked: 0, skipped: 0 };
  for (const s of (sb && sb.shots) || []) {
    out.total += 1;
    out[s.status] = (out[s.status] || 0) + 1;
  }
  return out;
}

/** 下一个可派发的镜头（按序号，跳过已完成/运行中） */
function nextDispatchable(sbId, opts = {}) {
  const sb = raw(sbId);
  if (!sb) return null;
  const seen = seenKeys(sbId);
  const skip = new Set(opts.skipIds || []);
  return sb.shots.find((s) => {
    if (skip.has(s.id)) return false;
    if (!["pending", "queued", "failed"].includes(s.status) && !opts.includeFailed) {
      if (!["pending"].includes(s.status)) return false;
    }
    if (s.status === "running") return false;
    if (opts.dedupe !== false && seen.has(dedupeKey(sbId, s))) return false;
    return true;
  }) || null;
}

module.exports = {
  STATUSES,
  normalizeShot,
  list,
  get,
  raw,
  create,
  update,
  remove,
  importMarkdown,
  exportMarkdown,
  addShots,
  updateShot,
  removeShot,
  reorderShots,
  setStatus,
  resetShots,
  dedupeKey,
  seenKeys,
  stats,
  nextDispatchable
};
