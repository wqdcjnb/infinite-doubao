"use strict";

/**
 * 页面脚本装配
 *
 * 三个页面侧脚本共用一次注入（document_start）：
 *   fp-inject  —— 指纹伪装（已有模块，原样复用，保证内外核一致）
 *   enhancer   —— 请求/响应改写（替代对标产品那个 dola30 扩展）
 *   automation —— 页面自动化原语（粘贴/发送/读进度/确认/申诉）
 *
 * 内嵌内核走 webview preload（webFrame.executeJavaScript），外挂内核走 CDP
 * Page.addScriptToEvaluateOnNewDocument，两边注入的是同一份源码 —— 行为不会分叉。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PAGE_DIR = __dirname;

function read(file) {
  const candidates = [
    path.join(PAGE_DIR, file),
    path.join(PAGE_DIR, "..", file),
    path.join(path.dirname(process.execPath), "resources", file)
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, "utf8"); } catch {}
  }
  return "";
}

/** 稳定的自动化入口名（不挂可枚举属性，页面扫 Object.keys 看不到） */
function autoKeyFor(instanceId) {
  const h = crypto.createHash("sha1").update(String(instanceId || "anonymous")).digest("hex").slice(0, 10);
  return "__dm" + h;
}

/** 去掉 CommonJS 尾巴，让 fp-inject 能以函数体形式被包进闭包 */
function stripCommonjs(src) {
  return String(src || "")
    .replace(/^"use strict";\s*/m, "")
    .replace(/module\.exports\s*=\s*\{[^}]*\};?/g, "")
    .trim();
}

function buildPageScript(opts) {
  const cfg = (opts && opts.cfg) || {};
  const instanceId = cfg.instanceId || "";
  const payload = {
    profile: cfg.profile || null,
    instanceId,
    kernel: cfg.kernel || "embedded",
    enhancer: cfg.enhancer || {},
    autoKey: autoKeyFor(instanceId)
  };
  const fpBody = stripCommonjs(read("fp-inject.js"));
  const enhancer = read("enhancer.js");
  const automation = read("automation.js");
  const generationOptions = read("generation-options.js");
  const nativeDrafts = read("native-drafts.js");
  return `(function(){
var CFG = ${JSON.stringify(payload)};
try {
${fpBody}
if (CFG.profile) installFingerprint(CFG.profile);
} catch (e) {}
try {
${enhancer}
} catch (e) {}
try {
${automation}
} catch (e) {}
try {
${generationOptions}
} catch (e) {}
try {
${nativeDrafts}
} catch (e) {}
})();`;
}

/** 只构建指纹部分（探针页/单测用） */
function buildFingerprintScript(profile, instanceId) {
  const body = stripCommonjs(read("fp-inject.js"));
  return `(function(){ var P = ${JSON.stringify(profile || {})}; try { ${body}; if (P) installFingerprint(P); } catch (e) {} })();`;
}

module.exports = { buildPageScript, buildFingerprintScript, autoKeyFor, PAGE_DIR };
