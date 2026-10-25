"use strict";

/**
 * 额度与冷却
 *
 * 对标产品把免费号当 4 条/天，靠人肉盯着不能超。这里做成显式账本：
 *   - 按实例记账，日期按配置时区算（默认东京，跟豆包/海外的自然日对齐）
 *   - 支持图片/视频两条通道
 *   - 撞到「今日免费数量用完」直接给实例上冷却，编排器下一轮自动跳过
 *   - 允许手动修正（换号、额度重置、误记）
 */

const store = require("./store");
const log = require("./logger");

function dateKey(tz) {
  const zone = String(tz || (store.get().settings.quota || {}).resetTz || "Asia/Tokyo");
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function limits() {
  const q = store.get().settings.quota || {};
  return {
    perDay: Math.max(1, Number(q.perDay) || 4),
    cooldownMin: Math.max(0, Number(q.cooldownMin) || 0),
    resetTz: q.resetTz || "Asia/Tokyo"
  };
}

function blank() {
  return { date: dateKey(), video: 0, image: 0, coolingUntil: 0, history: [] };
}

function entry(instanceId, create) {
  const data = store.get();
  const key = String(instanceId || "");
  if (!key) return blank();
  const cur = data.quota[key];
  const today = dateKey();
  if (!cur || cur.date !== today) {
    if (!create) return { ...blank(), date: today };
    data.quota[key] = blank();
  }
  const e = data.quota[key];
  if (!Array.isArray(e.history)) e.history = [];
  return e;
}

function get(instanceId) {
  const e = entry(instanceId, false);
  const lim = limits();
  return {
    date: e.date,
    video: Number(e.video) || 0,
    image: Number(e.image) || 0,
    perDay: lim.perDay,
    remaining: Math.max(0, lim.perDay - (Number(e.video) || 0)),
    coolingUntil: Number(e.coolingUntil) || 0,
    cooling: Number(e.coolingUntil) > Date.now(),
    history: (e.history || []).slice(-30)
  };
}

function canUse(instanceId, kind = "video") {
  const lim = limits();
  const e = entry(instanceId, false);
  if (e.coolingUntil && e.coolingUntil > Date.now()) {
    return { ok: false, reason: "cooling", retryAt: e.coolingUntil, message: "实例处于冷却中" };
  }
  const used = Number(kind === "image" ? e.image : e.video) || 0;
  if (used >= lim.perDay) {
    return { ok: false, reason: "quota", used, perDay: lim.perDay, message: `今日额度已用 ${used}/${lim.perDay}` };
  }
  return { ok: true, used, perDay: lim.perDay-0, remaining: lim.perDay - used };
}

function consume(instanceId, kind = "video", meta = {}) {
  const e = entry(instanceId, true);
  const key = kind === "image" ? "image" : "video";
  // A crash may persist the ledger before the task's quotaConsumed flag. The
  // accepted task ID is the idempotency key when delivery resumes afterwards.
  if (meta.taskId && e.history.some((item) => item.taskId === meta.taskId && item.kind === key)) return get(instanceId);
  e[key] = (Number(e[key]) || 0) + 1;
  e.history.push({ at: new Date().toISOString(), kind: key, shotId: meta.shotId || "", taskId: meta.taskId || "" });
  if (e.history.length > 200) e.history = e.history.slice(-200);
  store.save();
  log.info("quota-consume", { instanceId, kind: key, used: e[key] });
  return get(instanceId);
}

function release(instanceId, kind = "video") {
  const e = entry(instanceId, true);
  const key = kind === "image" ? "image" : "video";
  e[key] = Math.max(0, (Number(e[key]) || 0) - 1);
  store.save();
  return get(instanceId);
}

/** 手动修正到指定已用数（负数/越界自动夹紧） */
function setUsed(instanceId, kind, value) {
  const e = entry(instanceId, true);
  const lim = limits();
  const key = kind === "image" ? "image" : "video";
  e[key] = Math.max(0, Math.min(lim.perDay, Math.round(Number(value) || 0)));
  store.save();
  return get(instanceId);
}

function cool(instanceId, minutes, reason = "") {
  const e = entry(instanceId, true);
  const lim = limits();
  const mins = Number(minutes) > 0 ? Number(minutes) : lim.cooldownMin;
  e.coolingUntil = mins > 0 ? Date.now() + mins * 60000 : 0;
  store.save();
  log.warn("quota-cool", { instanceId, minutes: mins, reason });
  return get(instanceId);
}

function clearCool(instanceId) {
  const e = entry(instanceId, true);
  e.coolingUntil = 0;
  store.save();
  return get(instanceId);
}

function reset(instanceId) {
  const data = store.get();
  data.quota[String(instanceId)] = blank();
  store.save();
  return get(instanceId);
}

function snapshot() {
  const data = store.get();
  const out = {};
  for (const inst of data.instances) out[inst.id] = get(inst.id);
  return out;
}

/** 从页面文案判定「额度用完」并上冷却（编排器调用） */
function notePageSignal(instanceId, text) {
  const t = String(text || "");
  if (/免费数量用完|额度已用完|今日次数已用完|已达上限|quota/i.test(t)) {
    const lim = limits();
    return cool(instanceId, lim.cooldownMin || 180, "页面提示额度用尽");
  }
  return get(instanceId);
}

module.exports = { limits, dateKey, get, canUse, consume, release, setUsed, cool, clearCool, reset, snapshot, notePageSignal };
