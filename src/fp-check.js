"use strict";

/**
 * 指纹一致性校验收口
 *
 * 把「页面上实际读到的值」和「本地档案里声明的值」逐项对照。
 * 判断逻辑单独放这里，是为了让界面 / REST / MCP 三个入口拿到完全一样的结果，
 * 不会出现界面说通过、接口说漂移这种自相矛盾。
 */

const { PROBE } = require("./page/probe");

const CHECK_KEYS = [
  ["userAgent", "User-Agent"],
  ["uaData", "UA Client Hints"],
  ["languages", "语言列表"],
  ["hardwareConcurrency", "CPU 核数"],
  ["deviceMemory", "内存档位"],
  ["webdriver", "webdriver 标记"],
  ["screen", "屏幕 / DPR"],
  ["timezone", "时区"],
  ["locale", "Intl locale"],
  ["webgl", "WebGL 显卡"]
];

// 噪声类没有"正确值"，只呈现给用户看
const NOTE_KEYS = [
  ["canvas", "Canvas 指纹"],
  ["audio", "Audio 参数"],
  ["fonts", "可用字体"],
  ["rects", "ClientRects 精度"]
];

const norm = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

function compare(fp, actual) {
  const profile = fp || {};
  const screenParts = profile.screen
    ? [profile.screen.width + "x" + profile.screen.height, "avail " + profile.screen.availWidth + "x" + profile.screen.availHeight]
    : [];
  const uaDataStr = profile.uaData
    ? [profile.uaData.platform, profile.uaData.platformVersion, profile.uaData.architecture, profile.uaData.bitness, profile.uaData.uaFullVersion].join(" / ")
    : "";

  const expect = {
    userAgent: norm(profile.userAgent),
    uaData: norm(uaDataStr),
    languages: norm((profile.languages || []).join(",")),
    hardwareConcurrency: norm(profile.hardwareConcurrency),
    deviceMemory: norm(profile.deviceMemory),
    webdriver: "false",
    screen: screenParts.join(" | "),
    timezone: norm(profile.timezone),
    locale: norm(profile.locale),
    webgl: norm(profile.webgl ? `${profile.webgl.vendor} | ${profile.webgl.renderer}` : "")
  };

  const byKey = {};
  for (const item of (actual && actual.items) || []) byKey[item.key] = item.actual;

  const items = [];
  const secure = !!(actual && actual.secure);
  for (const [key, label] of CHECK_KEYS) {
    const got = norm(byKey[key]);
    const want = expect[key];
    // UA-CH 高熵值只在安全上下文（https / localhost）开放，about:blank 等页面拿不到，
    // 这种情况记为参考项，不判失败——否则每次本地自查都会假报漂移。
    if (key === "uaData" && got === "unavailable" && !secure) {
      items.push({ key, label, expected: want || "—", actual: "当前页面非安全上下文，取不到", ok: true, note: true });
      continue;
    }
    let ok;
    if (key === "screen") {
      // innerWidth/innerHeight 随窗口大小变化，不参与判定
      ok = !!want && screenParts.every((p) => got.includes(p));
    } else if (key === "timezone" || key === "locale") {
      ok = !!want && got.split(" / ")[0] === want;
    } else {
      ok = !!want && got === want;
    }
    items.push({ key, label, expected: want || "—", actual: got || "—", ok });
  }

  for (const [key, label] of NOTE_KEYS) {
    if (byKey[key] == null) continue;
    items.push({ key, label, expected: "—", actual: norm(byKey[key]), ok: true, note: true });
  }

  const failed = items.filter((x) => x.ok === false);
  return {
    ok: failed.length === 0,
    passed: items.length - failed.length,
    total: items.length,
    failed: failed.length,
    items,
    checkedAt: new Date().toISOString()
  };
}

module.exports = { compare, read, PROBE, CHECK_KEYS, NOTE_KEYS };

/**
 * 在目标页面里跑探针，取回实际指纹。
 * 内嵌内核找 webview 的 webContents；外挂内核用 CDP 会话。
 * 两边都拿不到就明确报「先打开页面」，而不是返回一份空结果假装通过。
 */
async function read({ instance, webContents } = {}) {
  const inst = instance || {};
  if (webContents) return webContents.executeJavaScript(PROBE, true);
  let electron = null;
  try { electron = require("electron"); } catch {}
  if (electron && inst.partition) {
    let target = null;
    try { target = electron.session.fromPartition(inst.partition); } catch {}
    if (target) {
      for (const wc of electron.webContents.getAllWebContents()) {
        try {
          if (wc.getType() !== "webview") continue;
          if (wc.session === target) return wc.executeJavaScript(PROBE, true);
        } catch {}
      }
    }
  }
  const chromium = require("./chromium");
  const c = chromium.get(inst.id);
  if (c) return c.evaluate(PROBE);
  throw new Error("该环境还没打开，先打开页面再做指纹体检");
}
