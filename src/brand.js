"use strict";

/**
 * 品牌 / 白标配置
 *
 * 对标产品把品牌写死在编译产物里，换一层皮要重新出包。这里做成运行时配置：
 * APP_HOME/brand.json 存在则以它为准，否则用内置默认值，出包后也能改名字和功能开关。
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  name: "豆包工坊",
  englishName: "Doubao Workshop",
  productKey: "infinite-doubao",
  version: "1.3.3",
  slogan: "多账号 AI 素材流水线",
  // 首页问候等地方用到的外链，全部可关
  links: {
    community: "",
    docs: "",
    support: ""
  },
  features: {
    // 内核：只有自带的内嵌 Chromium，不再调用本机 Chrome/Edge
    externalKernel: false,
    // 页面增强（时长/模型/分辨率响应改写）
    pageEnhancer: true,
    // 本地 REST + MCP + SSE
    localServer: true,
    // 剪映草稿导出
    jianying: true,
    // 素材遮脸
    faceMask: true,
    // 分镜批量编排
    orchestrator: true,
    // 账号探活 / 一键登录
    accountOps: true,
    // 自动更新检查
    autoUpdate: false
  }
};

let cache = null;

function merge(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = merge(base[k] || {}, v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** @param {string} home APP_HOME */
function load(home) {
  let patch = null;
  try {
    const file = path.join(home, "brand.json");
    if (fs.existsSync(file)) patch = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    patch = null;
  }
  cache = merge(DEFAULTS, patch || {});
  return cache;
}

function get() {
  return cache || DEFAULTS;
}

function feature(name) {
  const f = get().features || {};
  return f[name] !== false;
}

/** 便捷属性：模块里直接 brand.name / brand.version 读当前生效配置 */
module.exports = {
  load,
  get,
  feature,
  DEFAULTS,
  get name() { return get().name; },
  get version() { return get().version; },
  get englishName() { return get().englishName; },
  get productKey() { return get().productKey; }
};
