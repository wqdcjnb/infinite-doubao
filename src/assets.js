"use strict";

/**
 * 素材宝库
 *
 * 对标产品的素材库只是「一堆参考图」，派发时靠人记哪张图配哪条提示词。这里做成卡片：
 *   人物（persona）/ 场景 / 道具 / 音色，各有自己的提示词片段与参考图，
 *   派发分镜时把镜头提示词与卡片片段按变量拼起来，同一套人物可以在几十个镜头里保持一致。
 *
 * 九宫格参考图用 ffmpeg xstack 合成，不引第三方图像库。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const store = require("./store");
const P = require("./paths");
const log = require("./logger");

const KINDS = ["persons", "scenes", "props", "voices"];
const ALIAS = { person: "persons", persons: "persons", scene: "scenes", scenes: "scenes", prop: "props", props: "props", voice: "voices", voices: "voices" };

function kindKey(kind) {
  return ALIAS[String(kind || "").toLowerCase()] || "persons";
}

function list(kind) {
  const box = store.get().assets;
  if (kind) return (box[kindKey(kind)] || []).slice();
  const out = {};
  for (const k of KINDS) out[k] = (box[k] || []).slice();
  return out;
}

function get(kind, id) {
  return (store.get().assets[kindKey(kind)] || []).find((x) => x.id === String(id)) || null;
}

function add(kind, item = {}) {
  const box = store.get().assets;
  const key = kindKey(kind);
  if (!Array.isArray(box[key])) box[key] = [];
  const entry = {
    id: `as-${crypto.randomBytes(6).toString("hex")}`,
    name: String(item.name || "未命名素材"),
    persona: String(item.persona || ""),
    prompt: String(item.prompt || ""),
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    refs: Array.isArray(item.refs) ? item.refs.map(String) : [],
    note: String(item.note || ""),
    createdAt: new Date().toISOString()
  };
  box[key].push(entry);
  store.save();
  log.info("asset-added", { kind: key, id: entry.id, name: entry.name });
  return entry;
}

function update(kind, id, patch = {}) {
  const entry = get(kind, id);
  if (!entry) return null;
  for (const f of ["name", "persona", "prompt", "note"]) {
    if (patch[f] !== undefined) entry[f] = String(patch[f]);
  }
  if (Array.isArray(patch.tags)) entry.tags = patch.tags.map(String);
  if (Array.isArray(patch.refs)) entry.refs = patch.refs.map(String);
  store.save();
  return entry;
}

function remove(kind, id) {
  const box = store.get().assets;
  const key = kindKey(kind);
  const arr = box[key] || [];
  const idx = arr.findIndex((x) => x.id === String(id));
  if (idx < 0) return null;
  const [entry] = arr.splice(idx, 1);
  store.save();
  return entry;
}

/* --------------------------------------------------------- 提示词拼装 */

const VARS = {
  "{persona}": (ctx) => (ctx.persona && ctx.persona.prompt) || "",
  "{persona_name}": (ctx) => (ctx.persona && ctx.persona.name) || "",
  "{scene}": (ctx) => (ctx.scene && ctx.scene.prompt) || "",
  "{scene_name}": (ctx) => (ctx.scene && ctx.scene.name) || "",
  "{prop}": (ctx) => (ctx.prop && ctx.prop.prompt) || "",
  "{style}": (ctx) => ctx.style || "",
  "{prev}": (ctx) => ctx.prev || "",
  "{duration}": (ctx) => (ctx.duration ? String(ctx.duration) : "")
};

function applyTemplate(template, ctx) {
  let out = String(template || "");
  for (const [token, fn] of Object.entries(VARS)) {
    if (out.indexOf(token) >= 0) {
      let val = "";
      try { val = fn(ctx) || ""; } catch { val = ""; }
      out = out.split(token).join(val);
    }
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 解析一个镜头最终要提交的提示词与参考图。
 * 优先级：镜头自带 > 素材卡片 > 上一个镜头（链式承接）
 */
function resolveShotPrompt(shot, opts = {}) {
  const box = store.get().assets;
  const persona = shot.persona
    ? (box.persons || []).find((p) => p.id === shot.persona || p.name === shot.persona)
    : null;
  const scene = shot.sceneAsset
    ? (box.scenes || []).find((s) => s.id === shot.sceneAsset || s.name === shot.sceneAsset)
    : null;
  const ctx = {
    persona,
    scene,
    style: opts.style || "",
    duration: shot.duration,
    prev: opts.prevPrompt || ""
  };

  let videoPrompt = applyTemplate(shot.videoPrompt || shot.scene || "", ctx);
  let imagePrompt = applyTemplate(shot.imagePrompt || "", ctx);
  if (!videoPrompt && imagePrompt) videoPrompt = imagePrompt;
  if (!imagePrompt && videoPrompt) imagePrompt = videoPrompt;

  const refs = new Set(shot.refs || []);
  for (const card of [persona, scene]) {
    for (const r of (card && card.refs) || []) refs.add(r);
  }
  if (opts.chain !== false && opts.prevPrompt) {
    // 链式承接：只做提示词级别的一致性提示，不塞上个镜头的结果视频（平台不接受跨任务参考）
    videoPrompt = `${videoPrompt}\n（延续上一镜头的人物、服装与光线，不要出现剪辑断层）`;
  }
  return { videoPrompt, imagePrompt, refs: [...refs].filter(Boolean), persona: persona ? persona.name : "", scene: scene ? scene.name : "" };
}

/* ------------------------------------------------------------ 九宫格 */

function ffmpegBin() {
  return P.tool("ffmpeg");
}

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stderr.on("data", (b) => { err += b.toString("utf8"); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr: err.slice(-2000) }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stderr: String(error && error.message) }); });
  });
}

/**
 * 把 N 张图拼成一张九宫格/四宫格（3x3 或 2x2），空白用黑底补齐。
 * @param {string[]} files 本地图片
 * @param {string} outPath 输出图片
 */
async function grid(files, outPath, opts = {}) {
  if (fs.existsSync(P.res("optional-components.json")) && !P.optionalDir()) return { ok: false, message: "请先在设置中下载本地素材处理组件" };
  const paths = (Array.isArray(files) ? files : []).filter((f) => {
    try { return fs.existsSync(f); } catch { return false; }
  });
  if (!paths.length) return { ok: false, message: "没有可用的本地图片" };
  const count = paths.length;
  const cols = Number(opts.cols) || (count > 4 ? 3 : 2);
  const rows = Math.ceil(count / cols);
  const cell = Math.max(256, Math.min(1024, Number(opts.cell) || 512));
  const target = outPath || path.join(P.dir("assets"), `grid-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const inputs = [];
  for (const p of paths) inputs.push("-i", p);
  // 不足一整格的用黑底补齐，xstack 要求输入数量固定
  const blanks = cols * rows - count;
  const filters = paths.map((_, i) => `[${i}:v]scale=${cell}:${cell}:force_original_aspect_ratio=decrease,pad=${cell}:${cell}:(ow-iw)/2:(oh-ih)/2:black[v${i}]`);
  if (blanks > 0) {
    filters.push(`color=c=black:s=${cell}x${cell}:d=1[b0]`);
    for (let i = 1; i < blanks; i += 1) filters.push(`[b0]split=1[b${i}]`);
  }
  const labels = [];
  for (let i = 0; i < count; i += 1) labels.push(`[v${i}]`);
  for (let i = 0; i < blanks; i += 1) labels.push(`[b${i}]`);
  const layout = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) layout.push(`${c * cell}_${r * cell}`);
  }
  filters.push(`${labels.join("")}xstack=inputs=${cols * rows}:layout=${layout.join("|")}:fill=black[out]`);

  const args = ["-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", "1", target];
  const r = await run(ffmpegBin(), args);
  if (r.code !== 0 || !fs.existsSync(target)) {
    log.warn("grid-failed", { stderr: r.stderr });
    return { ok: false, message: "九宫格合成失败", stderr: r.stderr };
  }
  return { ok: true, file: target, cols, rows, count };
}

module.exports = { KINDS, list, get, add, update, remove, applyTemplate, resolveShotPrompt, grid };
