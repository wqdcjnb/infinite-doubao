"use strict";

/**
 * 分镜 Markdown 解析
 *
 * 对标产品只认自己那一套表格格式，表头换个字就整份导入失败。这里按「关键词命中」认列，
 * 中英文/同义词都能对上；没有表格时退化成编号列表，一份随手写的脚本文档也能直接用。
 *
 * 支持：
 *   | 分镜 | 画面描述 | 视频提示词 | 时长 | 参考图 |
 *   | shot | scene | prompt | duration | refs |
 * 单元格里可以写 ![名字](本地路径或URL)，会自动收进 refs；<br> 视为换行。
 */

const FIELD_HINTS = [
  ["index", /^(分镜|镜头|序号|镜号|shot|no\.?|index)$/i],
  ["title", /^(标题|名称|title|name)$/i],
  ["scene", /^(画面|画面描述|场景|描述|内容|scene|description|desc)$/i],
  ["imagePrompt", /^(图片提示词|图像提示词|首帧提示词|image\s*prompt|image|首帧)$/i],
  ["videoPrompt", /^(视频提示词|提示词|video\s*prompt|prompt|动作)$/i],
  ["duration", /^(时长|秒数|duration|seconds|sec)$/i],
  ["refs", /^(参考图|参考素材|素材|refs?|reference|images?)$/i],
  ["mode", /^(模式|生成模式|mode|gen_?mode)$/i],
  ["credits", /^(积分|消耗|credits?|cost)$/i],
  ["note", /^(备注|说明|note|remark)$/i],
  ["persona", /^(人物|角色|persona|character)$/i],
  ["sceneAsset", /^(场景素材|场景卡|scene\s*asset)$/i]
];

function fieldOf(header) {
  const h = String(header || "").replace(/\*\*/g, "").replace(/[`\s]/g, "").trim();
  if (!h) return "";
  for (const [field, re] of FIELD_HINTS) if (re.test(h)) return field;
  return "";
}

function cleanCell(cell) {
  return String(cell == null ? "" : cell)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\\|/g, "|")
    .replace(/^\s+|\s+$/g, "");
}

function imagesIn(text) {
  const out = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(String(text || "")))) out.push({ name: m[1] || "", value: m[2] });
  return out;
}

function stripImages(text) {
  return String(text || "").replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1").trim();
}

function splitRow(line) {
  let s = String(line).trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = [];
  let buf = "";
  let esc = false;
  for (const ch of s) {
    if (esc) { buf += ch; esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === "|") { cells.push(buf); buf = ""; continue; }
    buf += ch;
  }
  cells.push(buf);
  return cells.map(cleanCell);
}

function isSeparator(line) {
  return /^\s*\|?[\s:-]*-{3,}[\s:|-]*\|?\s*$/.test(String(line));
}

function parseDuration(v) {
  const m = /(\d+(?:\.\d+)?)/.exec(String(v || ""));
  return m ? Math.min(600, Math.max(1, Math.round(Number(m[1])))) : 0;
}

/** 解析一份 Markdown 分镜稿 */
function parse(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const shots = [];
  const warnings = [];
  let currentTitle = "";
  let inCode = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inCode = !inCode; i += 1; continue; }
    if (inCode) { i += 1; continue; }

    const h = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
    if (h) { currentTitle = h[1].trim(); i += 1; continue; }

    if (line.indexOf("|") >= 0 && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const headers = splitRow(line);
      const fields = headers.map(fieldOf);
      if (!fields.some(Boolean)) {
        warnings.push(`第 ${i + 1} 行的表格没认出任何列，已跳过`);
        i += 1;
        continue;
      }
      i += 2;
      while (i < lines.length && lines[i].indexOf("|") >= 0 && !/^\s*$/.test(lines[i])) {
        const cells = splitRow(lines[i]);
        const shot = {};
        cells.forEach((cell, idx) => {
          const field = fields[idx];
          if (!field) return;
          shot[field] = cell;
        });
        if (Object.keys(shot).length) {
          shot.__section = currentTitle;
          shot.__line = i + 1;
          shots.push(shot);
        }
        i += 1;
      }
      continue;
    }

    // 兜底：编号条目 / 列表项
    const bullet = /^\s*(?:[-*+]|\d+[.、)])\s+(.+)$/.exec(line);
    if (bullet && bullet[1].length > 4) {
      const body = bullet[1].trim();
      if (!/^(https?:\/\/|!\[)/.test(body)) {
        shots.push({ videoPrompt: body, __section: currentTitle, __line: i + 1, __loose: true });
      }
    }
    i += 1;
  }

  const normalized = shots.map((raw, idx) => {
    const refs = [];
    for (const key of ["refs", "scene", "videoPrompt", "imagePrompt", "note"]) {
      for (const img of imagesIn(raw[key])) refs.push(img.value);
    }
    const indexText = String(raw.index || "").replace(/[^\d]/g, "");
    return {
      index: indexText ? Number(indexText) : idx + 1,
      title: stripImages(raw.title || "") || stripImages(raw.scene || "").split("\n")[0].slice(0, 30) || `镜头 ${idx + 1}`,
      scene: stripImages(raw.scene || ""),
      imagePrompt: stripImages(raw.imagePrompt || ""),
      videoPrompt: stripImages(raw.videoPrompt || raw.scene || ""),
      duration: parseDuration(raw.duration),
      refs: [...new Set(refs)],
      mode: String(raw.mode || "").trim(),
      credits: Number(String(raw.credits || "").replace(/[^\d.]/g, "")) || 0,
      note: stripImages(raw.note || ""),
      persona: stripImages(raw.persona || ""),
      sceneAsset: stripImages(raw.sceneAsset || ""),
      loose: !!raw.__loose
    };
  }).filter((s) => s.videoPrompt || s.imagePrompt || s.scene);

  if (!normalized.length) warnings.push("这份文档里没解析出任何镜头");
  return { shots: normalized, warnings };
}

/** 反向导出（备份/交接用） */
function stringify(storyboard) {
  const shots = (storyboard && storyboard.shots) || [];
  const head = [
    `# ${storyboard && storyboard.name ? storyboard.name : "分镜"}`,
    "",
    "| 分镜 | 画面描述 | 视频提示词 | 时长 | 参考图 | 备注 |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  const rows = shots.map((s, i) => {
    const refs = (s.refs || []).map((r, n) => `![ref${n + 1}](${r})`).join(" ");
    const esc = (v) => String(v == null ? "" : v).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
    return `| ${s.index || i + 1} | ${esc(s.scene)} | ${esc(s.videoPrompt)} | ${s.duration || ""} | ${esc(refs)} | ${esc(s.note)} |`;
  });
  return head.concat(rows).join("\n") + "\n";
}

module.exports = { parse, stringify, fieldOf, splitRow, imagesIn, parseDuration };
