"use strict";

/**
 * 指纹档位生成 + 注入脚本构建
 *
 * 设计原则（与对标产品保持一致）：
 *   1) 一个账号一份**固定**档案，落盘保存，每次打开都完全一样 —— 随机但不乱变，
 *      否则同一账号前后两次访问的指纹不同，比不伪装更容易被判。
 *   2) 档案内部必须自洽：UA 版本 ↔ UA-CH brands ↔ 平台版本 ↔ WebGL 显卡 ↔ 屏幕分辨率
 *      互相能对上，任何一个字段单独胡编都会被一次性交叉校验打穿。
 *   3) 补丁体在 fp-inject.js 里，由 webview preload 在 document_start 同步执行，
 *      并对 Function.prototype.toString 做同名回读，避免被检测出被改写。
 */

const crypto = require("node:crypto");

const CHROME_MAJOR = (() => {
  // 用运行时真实 Chromium 主版本，UA 与实际内核版本必须对得上：
  // 报低版本但引擎支持高版本特性，是最容易被打穿的一处。
  const raw = String((process.versions && process.versions.chrome) || "");
  const n = parseInt(raw.split(".")[0], 10);
  if (Number.isFinite(n) && n > 60) return n;
  return 143;
})();

const BUILD_PATCH = [
  "0.7103.114", "0.6834.160", "0.6943.142", "0.6998.118", "0.6698.90", "0.7217.86"
];

/** 按 Chromium 主版本生成自洽的 UA-CH brands（GREASE 版本随主版本取模，与真实 Chrome 一致） */
function brandsFor(major) {
  const grease = [
    ["Not/A)Brand", "99"],
    ["Not_A Brand", "24"],
    ["Not.A/Brand", "24"],
    ["Not(A:Brand", "24"],
    ["Not?A_Brand", "24"]
  ][major % 5];
  return [["Chromium", String(major)], ["Google Chrome", String(major)], grease];
}


const WINDOWS_VERSIONS = [
  { platformVersion: "19.0.0", label: "Windows 11 24H2" },
  { platformVersion: "15.0.0", label: "Windows 11 23H2" },
  { platformVersion: "10.0.0", label: "Windows 10 22H2" }
];

const GPUS = [
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)", family: "nvidia" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)", family: "nvidia" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)", family: "nvidia" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)", family: "intel" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", family: "intel" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)", family: "amd" }
];

// 屏幕档必须能容纳 1480x940 的应用窗口（webview 内容区约 1464x901），
// 所以最小只到 1440x900 往上；1366x768 会让 innerHeight 超过伪装屏高，直接暴露。
const SCREENS = [
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1440, dpr: 1 },
  { width: 1680, height: 1050, dpr: 1 },
  { width: 1440, height: 900, dpr: 1 },
  { width: 1600, height: 900, dpr: 1 },
  { width: 1920, height: 1200, dpr: 1 }
];

/** 语言 ↔ 时区必须配对：en-GB 配 Asia/Taipei 这种组合是最典型的指纹破绽 */
const LOCALES = {
  "zh-CN": { list: ["zh-CN", "zh", "en"], tz: ["Asia/Shanghai"] },
  "zh-TW": { list: ["zh-TW", "zh", "en-US", "en"], tz: ["Asia/Taipei", "Asia/Hong_Kong"] },
  "zh-HK": { list: ["zh-HK", "zh", "en-US", "en"], tz: ["Asia/Hong_Kong"] },
  "en-US": { list: ["en-US", "en"], tz: ["America/New_York", "America/Los_Angeles"] },
  "en-GB": { list: ["en-GB", "en"], tz: ["Europe/London"] },
  "ja-JP": { list: ["ja-JP", "ja", "en-US", "en"], tz: ["Asia/Tokyo"] },
  "ko-KR": { list: ["ko-KR", "ko", "en-US", "en"], tz: ["Asia/Seoul"] }
};

function pick(arr, seed) {
  const n = parseInt(seed.slice(0, 8), 16) || 0;
  return arr[n % arr.length];
}

function hexToInt(s) {
  return parseInt(String(s || "").replace(/[^0-9a-f]/gi, "").slice(0, 12) || "1", 16);
}

/** 依据一个随机种子生成完整、自洽的 Windows Chrome 指纹档 */
function buildProfile(seed) {
  const s = String(seed || crypto.randomBytes(16).toString("hex"));
  const h = hexToInt(s);
  const major = CHROME_MAJOR;
  const build = `${major}.${BUILD_PATCH[h % BUILD_PATCH.length]}`;
  const bs = brandsFor(major);
  const win = WINDOWS_VERSIONS[Math.floor(h / 7) % WINDOWS_VERSIONS.length];
  const gpu = GPUS[Math.floor(h / 13) % GPUS.length];
  const screen = SCREENS[Math.floor(h / 29) % SCREENS.length];
  // 豆包是中文站，语言池按权重倾斜：zh-CN 出现最多，外语只作少数样本，
  // 否则一个 zh-CN 站点的账号挂着 en-GB + Europe/London 反而更可疑。
  const localeKey = ["zh-CN", "zh-CN", "zh-HK", "zh-CN", "zh-TW", "en-US", "zh-CN", "ja-JP"][Math.floor(h / 53) % 8];
  const localeDef = LOCALES[localeKey];
  const tz = localeDef.tz[Math.floor(h / 37) % localeDef.tz.length];
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return {
    seed: s,
    userAgent: ua,
    appVersion: ua.replace("Mozilla/", ""),
    platform: "Win32",
    vendor: "Google Inc.",
    languages: localeDef.list,
    language: localeKey,
    hardwareConcurrency: [8, 12, 16, 8, 4][Math.floor(h / 61) % 5],
    // Chrome 规范上限就是 8，只会返回 0.25/0.5/1/2/4/8；桌面机上 8 是绝对主流，2 太罕见
    deviceMemory: [8, 8, 4, 8, 4][Math.floor(h / 67) % 5],
    maxTouchPoints: 0,
    doNotTrack: false,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.width,
      availHeight: screen.height - 40,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: screen.dpr
    },
    uaData: {
      brands: bs.map(([brand, version]) => ({ brand, version: String(version) })),
      mobile: false,
      platform: "Windows",
      platformVersion: win.platformVersion,
      architecture: "x86",
      bitness: "64",
      model: "",
      uaFullVersion: build,
      wow64: false,
      fullVersionList: bs.map(([brand, version]) => ({
        brand,
        version: brand === "Chromium" || brand === "Google Chrome" ? build : String(version)
      }))
    },
    webgl: { vendor: gpu.vendor, renderer: gpu.renderer, family: gpu.family },
    timezone: tz,
    locale: localeKey,
    // 桌面有线/家宽的典型值：4g + rtt 50~100ms + downlink 8~20Mbps。
    // Electron 默认报 3g/500ms，那是最容易被判成受限环境的组合。
    connection: {
      effectiveType: "4g",
      rtt: [50, 100, 150][Math.floor(h / 71) % 3],
      downlink: [10, 8.5, 15, 20, 9.4][Math.floor(h / 73) % 5],
      saveData: false,
      type: "wifi"
    },
    mediaDevices: "noise",
    speechVoices: "noise",
    canvasNoise: true,
    audioNoise: true,
    clientRectsNoise: false,
    webrtc: "block",
    fontNoise: false,
    windowsLabel: win.label,
    chromeLabel: `Chrome ${major}`
  };
}


module.exports = { buildProfile, LOCALES };
