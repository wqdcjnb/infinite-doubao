"use strict";

/**
 * 指纹一致性探针（在目标页面上下文里执行，只读）
 *
 * 目的不是"再注入一层"，而是**回头验收注入是否真的生效**：
 * 把页面上实际能读到的 13 个高频指纹面采集回来，和本地档案逐项比对。
 * 任何一项对不上（比如 canvas 噪声没挂上、时区和语言不配对），
 * 在这里会直接以 ok:false 暴露，而不是等平台风控先发现。
 *
 * 用 async IIFE 返回一个对象，主进程只需 evaluate 后取 value。
 */

const PROBE = `(async () => {
  const out = { items: [], ua: "", tz: "", lang: "" };
  const push = (key, label, actual) => out.items.push({ key, label, actual });

  const safe = (fn, fallback) => { try { const v = fn(); return v == null ? fallback : v } catch (e) { return fallback } };
  const hash = (str) => {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
    return h.toString(16).padStart(8, "0");
  };

  // 1) UA
  out.ua = safe(() => navigator.userAgent, "");
  push("userAgent", "User-Agent", out.ua);

  // 2) UA-CH 高熵值（platformVersion / architecture 是交叉校验重灾区）
  push("uaData", "UA Client Hints", await (async () => {
    try {
      const d = await navigator.userAgentData.getHighEntropyValues(["platformVersion", "architecture", "bitness", "uaFullVersion", "model"]);
      return [d.platform, d.platformVersion, d.architecture, d.bitness, d.uaFullVersion].join(" / ");
    } catch (e) { return "unavailable"; }
  })());

  // 3) 语言列表
  push("languages", "语言列表", safe(() => (navigator.languages || []).join(","), ""));
  out.lang = safe(() => navigator.language, "");

  // 4) CPU 核数
  push("hardwareConcurrency", "CPU 核数", safe(() => navigator.hardwareConcurrency, 0));

  // 5) 内存档位
  push("deviceMemory", "内存档位", safe(() => navigator.deviceMemory, 0));

  // 6) 自动化标记
  push("webdriver", "webdriver 标记", safe(() => navigator.webdriver, null));

  // 7) 屏幕与 DPR
  push("screen", "屏幕 / DPR", safe(() => {
    const s = window.screen;
    return [s.width + "x" + s.height, "avail " + s.availWidth + "x" + s.availHeight, "dpr " + window.devicePixelRatio, "inner " + window.innerWidth + "x" + window.innerHeight].join(" | ");
  }, ""));

  // 8) 时区（Intl 与 Date 两条路都要一致）
  push("timezone", "时区", safe(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const off = new Date().getTimezoneOffset();
    return tz + " / UTC" + (off <= 0 ? "+" : "-") + Math.abs(off / 60);
  }, ""));
  out.tz = safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, "");

  // 9) locale（Intl 缓存是最常见的漏改点）
  push("locale", "Intl locale", safe(() => {
    return [new Intl.NumberFormat().resolvedOptions().locale, new Intl.DateTimeFormat().resolvedOptions().locale].join(" / ");
  }, ""));

  // 10) WebGL 厂商与型号
  push("webgl", "WebGL 显卡", safe(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return "no webgl";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return "no debug_renderer_info";
    return gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) + " | " + gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  }, ""));

  // 11) Canvas 指纹
  push("canvas", "Canvas 指纹", await (async () => {
    try {
      const c = document.createElement("canvas");
      c.width = 240; c.height = 60;
      const ctx = c.getContext("2d");
      ctx.textBaseline = "top";
      ctx.font = "14px Arial";
      ctx.fillStyle = "#f60";
      ctx.fillRect(0, 0, 120, 24);
      ctx.fillStyle = "#069";
      ctx.fillText("无限豆包 fingerprint", 2, 4);
      ctx.fillStyle = "rgba(102,204,0,.7)";
      ctx.fillText("无限豆包 fingerprint", 4, 14);
      return hash(c.toDataURL());
    } catch (e) { return "blocked"; }
  })());

  // 12) AudioContext 指纹参数
  push("audio", "Audio 指纹", safe(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return "no audio";
    const ac = new AC();
    const r = [ac.sampleRate, ac.destination.maxChannelCount, ac.baseLatency || 0].join(" / ");
    ac.close();
    return r;
  }, ""));

  // 13) 字体探测（同一段文字在不同字体族下的宽度差）
  push("fonts", "可用字体数", safe(() => {
    const c = document.createElement("canvas").getContext("2d");
    const base = "monospace";
    const probe = "mmmmmmmmmmlli1";
    c.font = "72px " + base;
    const baseW = c.measureText(probe).width;
    const families = ["Arial", "Calibri", "Cambria", "Consolas", "Georgia", "Impact", "Segoe UI", "Tahoma", "Times New Roman", "Verdana", "Microsoft YaHei", "SimSun"];
    let hit = 0;
    for (const f of families) {
      c.font = "72px '" + f + "', " + base;
      if (Math.abs(c.measureText(probe).width - baseW) > 0.5) hit += 1;
    }
    return hit + "/" + families.length;
  }, ""));

  // 附加：ClientRects 小数位（子像素噪声是否生效）
  push("rects", "ClientRects 精度", safe(() => {
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px";
    document.body.appendChild(d);
    const r = d.getBoundingClientRect().left;
    d.remove();
    return String(r);
  }, ""));

  out.platform = safe(() => navigator.platform, "");
  out.secure = !!window.isSecureContext;
  out.protocol = safe(() => location.protocol, "");
  out.memory = safe(() => navigator.deviceMemory, 0);
  out.cores = safe(() => navigator.hardwareConcurrency, 0);
  return out;
})()`;

module.exports = { PROBE };
