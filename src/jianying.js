"use strict";

/**
 * 剪映草稿导出
 *
 * 对标产品是把视频文件按顺序丢进一个文件夹、让人自己拖进剪映。这里直接生成剪映能识别的
 * 草稿工程（draft_content.json + draft_meta_info.json），打开剪映就能看到已经排好的时间线：
 * 素材顺序、每段时长、画布比例都对好，配音轨留空给用户自己加。
 *
 * 时间单位统一微秒（剪映内部就是这么存的），fps 默认 30。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const P = require("./paths");
const store = require("./store");
const log = require("./logger");

const RATIOS = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "21:9": { width: 2520, height: 1080 }
};

function ffprobeBin() {
  return P.tool("ffprobe");
}

function probeDurationMs(file) {
  return new Promise((resolve) => {
    const child = spawn(ffprobeBin(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(0); }, 15000);
    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.on("close", () => {
      clearTimeout(timer);
      const sec = Number(String(out).trim());
      resolve(Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0);
    });
    child.on("error", () => { clearTimeout(timer); resolve(0); });
  });
}

function uuid() {
  const h = crypto.randomBytes(16).toString("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function safeName(s) {
  return String(s || "草稿").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 40) || "草稿";
}

async function buildTimeline(files, opts = {}) {
  const fps = Number(opts.fps) || 30;
  const segments = [];
  let cursor = 0;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    // eslint-disable-next-line no-await-in-loop
    const probed = await probeDurationMs(f.file || f.path);
    const ms = Math.max(200, probed || Number(f.durationMs) || Number(f.duration) * 1000 || 5000);
    const dur = Math.round((ms / 1000) * fps) * Math.round(1000000 / fps);
    segments.push({
      file: f.file || f.path,
      start: cursor,
      duration: dur,
      index: i
    });
    cursor += dur;
  }
  return { segments, total: cursor };
}

/**
 * 把一个分镜里已完成的成片按镜号拼成 files 列表
 * @param {string} storyboardId
 */
function filesFromStoryboard(storyboardId) {
  const id = String(storyboardId || "");
  const tasks = (store.get().tasks || []).filter((t) => t.storyboardId === id && t.status === "succeeded");
  tasks.sort((a, b) => (Number(a.shotIndex) || 0) - (Number(b.shotIndex) || 0));
  const out = [];
  const seen = new Set();
  for (const t of tasks) {
    for (const f of (t.result && t.result.files) || []) {
      const file = String(f || "");
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push({ file });
    }
  }
  return out;
}

/**
 * 生成剪映草稿
 * @param {object} opts {name, storyboardId, files:[{file|path,durationMs}], ratio, dir, fps, width, height}
 */
async function createDraft(opts = {}) {
  const settings = store.get().settings || {};
  if (opts.storyboardId && !(opts.files || []).length) {
    opts = { ...opts, files: filesFromStoryboard(opts.storyboardId) };
  }
  if (!opts.name && opts.storyboardId) {
    const sb = (store.get().storyboards || []).find((s) => s.id === String(opts.storyboardId));
    if (sb && sb.name) opts = { ...opts, name: sb.name };
  }
  const dirRoot = opts.dir || settings.jianyingDir || path.join(P.dir("drafts"));
  const name = safeName(opts.name || `${require("./brand").name}_${new Date().toISOString().slice(0, 10)}`);
  const draftDir = path.join(dirRoot, name);
  fs.mkdirSync(draftDir, { recursive: true });

  const files = (opts.files || []).filter((f) => {
    try { return fs.existsSync(f.file || f.path); } catch { return false; }
  });
  if (!files.length) return { ok: false, message: "没有可用的本地成片" };

  const ratio = RATIOS[opts.ratio] ? opts.ratio : "16:9";
  const width = Number(opts.width) || RATIOS[ratio].width;
  const height = Number(opts.height) || RATIOS[ratio].height;
  const fps = Number(opts.fps) || 30;
  const { segments, total } = await buildTimeline(files, { fps });

  const videoMaterials = segments.map((s) => ({
    id: uuid(),
    type: "video",
    path: s.file.replace(/\\/g, "/"),
    material_name: path.basename(s.file),
    duration: s.duration,
    width,
    height,
    has_audio: true,
    crop: { upper_left_x: 0, upper_left_y: 0, upper_right_x: 0, upper_right_y: 0, lower_left_x: 0, lower_left_y: 0, lower_right_x: 0, lower_right_y: 0 },
    extra_type_option: 0
  }));

  const tracks = [{
    id: uuid(),
    type: "video",
    attribute: 0,
    flag: 0,
    segments: segments.map((s, i) => ({
      id: uuid(),
      material_id: videoMaterials[i].id,
      target_timerange: { start: s.start, duration: s.duration },
      source_timerange: { start: 0, duration: s.duration },
      speed: 1,
      volume: 1,
      visible: true,
      reverse: false,
      clip: { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
      extra_material_refs: [],
      render_index: 1
    }))
  }];

  const draftId = uuid();
  const content = {
    canvas_config: { width, height, ratio },
    color_space: 0,
    config: { adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null, extract_audio_last_index: 1, lyrics_recognition_id: "", lyrics_sync: true, maintrack_adsorb: true, material_save_mode: 0, multi_language_current: "none", multi_language_list: [], multi_language_main: "none", multi_language_mode: "none", original_sound_last_index: 1, recognize_audio_last_index: 1, record_audio_last_index: 1, sticker_max_index: 1, subtitle_keywords_config: null, subtitle_recognition_id: "", subtitle_sync: true, system_font_list: [], video_mute: false, zoom_info_params: null },
    duration: total,
    extra_info: null,
    fps,
    free_render_index_mode_on: false,
    group_container: null,
    id: draftId,
    keyframe_graph_list: [],
    materials: {
      audios: [],
      canvases: [],
      videos: videoMaterials,
      texts: [],
      images: [],
      stickers: [],
      videos_extra: []
    },
    mutable_materials: { audios: [], videos: [], texts: [] },
    name: name,
    new_version: "90.0.0",
    platform: { app_id: 3704, app_source: "lv", app_version: "4.9.0", device_id: "", hard_disk_id: "", mac_address: "", os: "windows", os_version: "10.0" },
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: "default",
    tracks,
    version: 360000
  };

  const meta = {
    draft_cloud_capcut_purchase_info: "",
    draft_cloud_last_action_download: false,
    draft_cloud_materials: [],
    draft_cloud_purchase_info: "",
    draft_cloud_template_id: "",
    draft_cloud_tutorial_info: "",
    draft_cloud_videocut_purchase_info: "",
    draft_cover: "draft_cover.jpg",
    draft_deeplink_url: "",
    draft_enterprise_info: { draft_enterprise_extra: "", draft_enterprise_id: "", draft_enterprise_name: "", enterprise_material: "" },
    draft_fold_path: draftDir.replace(/\\/g, "/"),
    draft_id: draftId,
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: "false",
    draft_is_invisible: false,
    draft_materials: [
      ...videoMaterials.map((m) => ({ type: 0, value: m.id })),
      { type: 1, value: "" },
      { type: 2, value: "" },
      { type: 3, value: "" },
      { type: 6, value: "" },
      { type: 7, value: "" }
    ],
    draft_materials_copied_info: [],
    draft_name: name,
    draft_new_version: "",
    draft_removable_storage_device: "",
    draft_root_path: dirRoot.replace(/\\/g, "/"),
    draft_segment_extra_info: [],
    draft_timeline_materials_size_: 0,
    draft_type: "",
    tm_draft_cloud_completed: "",
    tm_draft_cloud_entry_id: -1,
    tm_draft_cloud_modified: 0,
    tm_draft_cloud_parent_entry_id: -1,
    tm_draft_cloud_rating: 0,
    tm_draft_cloud_root_parent_entry_id: -1,
    tm_draft_cloud_space_id: -1,
    tm_draft_cloud_user_id: -1,
    tm_draft_create: Date.now() * 1000,
    tm_draft_modified: Date.now() * 1000,
    tm_draft_removed: 0,
    tm_duration: total
  };

  fs.writeFileSync(path.join(draftDir, "draft_content.json"), JSON.stringify(content, null, 2), "utf8");
  fs.writeFileSync(path.join(draftDir, "draft_meta_info.json"), JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(path.join(draftDir, "draft_agency_config.json"), JSON.stringify({ is_auto_agency_enabled: false, is_auto_agency_popup: false, is_use_agency: false }, null, 2), "utf8");

  log.info("jianying-draft-created", { dir: draftDir, segments: segments.length, total });
  return { ok: true, dir: draftDir, name, ratio, totalMs: Math.round(total / 1000), segments: segments.length };
}

function listDrafts(dir) {
  const root = dir || (store.get().settings || {}).jianyingDir || P.dir("drafts");
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  return names.map((name) => {
    const full = path.join(root, name);
    let mtime = 0;
    try { mtime = fs.statSync(path.join(full, "draft_content.json")).mtimeMs; } catch {}
    return { name, dir: full, updatedAt: mtime ? new Date(mtime).toISOString() : "" };
  }).sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
}

module.exports = { createDraft, listDrafts, probeDurationMs, filesFromStoryboard, RATIOS };
