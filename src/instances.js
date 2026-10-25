"use strict";

/**
 * 实例（环境）管理
 *
 * 对标产品一个实例 = 一个目录 + 一套会话 + 一套指纹。这里保持同样的语义，
 * 但数据集中在 store.json（会话数据仍由 Chromium 的分区目录管理），
 * 好处是备份/迁移/接口读写都是一份 JSON，不用满硬盘找 instance.json。
 */

const crypto = require("node:crypto");
const store = require("./store");
const { buildProfile } = require("./fingerprint");
const log = require("./logger");

/** 平台预设：url 与默认内核。内核写死内嵌（自带 Chromium），不再区分平台 */
const PLATFORMS = [
  { key: "doubao", name: "豆包", url: "https://www.doubao.com/chat/", kernel: "embedded" },
  { key: "dola", name: "Dola", url: "https://www.dola.com/", kernel: "embedded" },
  { key: "jimeng", name: "即梦", url: "https://jimeng.jianying.com/", kernel: "embedded" },
  { key: "jimeng-intl", name: "即梦国际", url: "https://dreamina.capcut.com/", kernel: "embedded" },
  { key: "qianwen", name: "通义千问", url: "https://tongyi.aliyun.com/qianwen/", kernel: "embedded" },
  { key: "yunque", name: "云雀", url: "https://yunque.volcengine.com/", kernel: "embedded" },
  { key: "custom", name: "自定义", url: "https://www.doubao.com/chat/", kernel: "embedded" }
];

function platformOf(key) {
  return PLATFORMS.find((p) => p.key === key) || PLATFORMS[0];
}

function list() {
  const data = store.get();
  const order = data.order || [];
  const rank = (id) => {
    const i = order.indexOf(id);
    return i < 0 ? 9999 : i;
  };
  return data.instances.slice().sort((a, b) => rank(a.id) - rank(b.id));
}

function get(id) {
  return store.find(id);
}

function create(input = {}) {
  const platform = platformOf(String(input.platform || "doubao"));
  const seed = crypto.randomBytes(16).toString("hex");
  const inst = store.add({
    id: store.newId("inst"),
    name: input.name || `${platform.name}-${store.get().instances.length + 1}`,
    group: input.group || "",
    remark: input.remark || "",
    platform: platform.key,
    url: input.url || platform.url,
    kernel: "embedded",             // 写死：不再接受外部内核实参
    tags: Array.isArray(input.tags) ? input.tags : [],
    proxy: input.proxy || { mode: "direct" },
    fingerprint: input.fingerprint || buildProfile(seed)
  });
  if (input.proxy && input.proxy.url) applyProxyInput(inst.id, input.proxy);
  store.save();
  log.info("instance-created", { id: inst.id, name: inst.name, platform: inst.platform });
  return store.find(inst.id);
}

function update(id, patch = {}) {
  const before = store.find(id);
  if (!before) return null;
  const inst = store.patch(id, patch);
  if (patch && patch.proxy) applyProxyInput(id, patch.proxy);
  store.save();
  return store.find(id);
}

/** 代理密码单独加密落盘，store 里只留掩码 */
function applyProxyInput(id, proxy) {
  if (!proxy || typeof proxy !== "object") return;
  const url = String(proxy.url || "");
  if (!url) return;
  const parsed = store.splitProxyPassword(url);
  if (parsed.hasPassword) store.setProxySecret(id, parsed.password);
  const inst = store.find(id);
  if (!inst) return;
  inst.proxy = {
    ...inst.proxy,
    mode: proxy.mode || inst.proxy.mode || "custom",
    url: parsed.maskUrl,
    hasPassword: parsed.hasPassword,
    label: String(proxy.label || inst.proxy.label || "")
  };
}

function remove(id) {
  const inst = store.remove(id);
  if (inst) {
    store.save();
    log.info("instance-removed", { id: inst.id, name: inst.name });
  }
  return inst;
}

function reorder(ids) {
  const data = store.get();
  const known = new Set(data.instances.map((i) => i.id));
  const next = (Array.isArray(ids) ? ids : []).filter((id) => known.has(String(id)));
  for (const i of data.instances) if (!next.includes(i.id)) next.push(i.id);
  data.order = next;
  store.save();
  return next;
}

function groups() {
  const map = new Map();
  for (const inst of list()) {
    const g = inst.group || "未分组";
    map.set(g, (map.get(g) || 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count }));
}

function regenerateFingerprint(id) {
  const inst = store.patch(id, { fingerprint: buildProfile(crypto.randomBytes(16).toString("hex")) });
  store.save();
  return inst ? inst.fingerprint : null;
}

function setFingerprintField(id, patch) {
  const inst = store.find(id);
  if (!inst) return null;
  const next = { ...inst.fingerprint, ...(patch || {}) };
  store.patch(id, { fingerprint: next });
  store.save();
  return next;
}

/* ------------------------------------------------------------ 批量 / 迁移 */

function importMany(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    try {
      out.push(create(item));
    } catch (error) {
      log.warn("instance-import-failed", { message: String(error && error.message), name: item && item.name });
    }
  }
  return out;
}

function exportAll() {
  const data = store.get();
  return {
    version: store.VERSION,
    exportedAt: new Date().toISOString(),
    instances: list().map((i) => ({
      id: i.id,
      name: i.name,
      group: i.group,
      remark: i.remark,
      platform: i.platform,
      url: i.url,
      kernel: i.kernel,
      tags: i.tags,
      proxy: { mode: i.proxy.mode, url: i.proxy.url, hasPassword: i.proxy.hasPassword, label: i.proxy.label },
      fingerprint: i.fingerprint,
      hasCookie: i.cookie.has,
      createdAt: i.createdAt
    })),
    storyboards: data.storyboards,
    assets: data.assets
  };
}

/* -------------------------------------------------------------- Cookie */

/**
 * 解析三种常见格式：
 *   1) 单行 Cookie 头：a=1; b=2
 *   2) Netscape cookies.txt（7 列 TSV）
 *   3) 浏览器扩展导出的 JSON 数组 [{name,value,domain,...}]
 */
function parseCookies(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr
          .filter((c) => c && c.name)
          .map((c) => ({
            name: String(c.name),
            value: String(c.value == null ? "" : c.value),
            domain: String(c.domain || ""),
            path: String(c.path || "/"),
            secure: c.secure !== false,
            httpOnly: !!c.httpOnly,
            expirationDate: Number(c.expirationDate) || 0
          }));
      }
    } catch {}
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const netscape = lines.filter((l) => l.split("\t").length >= 7);
  if (netscape.length) {
    return netscape.map((l) => {
      const parts = l.split("\t");
      return {
        name: parts[5],
        value: parts[6],
        domain: parts[0].replace(/^\./, "."),
        path: parts[2] || "/",
        secure: /TRUE/i.test(parts[3]),
        httpOnly: /TRUE/i.test(parts[1]),
        expirationDate: Number(parts[4]) || 0
      };
    });
  }
  return lines.map((pair) => {
    const i = pair.indexOf("=");
    if (i < 0) return null;
    return {
      name: pair.slice(0, i).trim(),
      value: pair.slice(i + 1).trim(),
      domain: "",
      path: "/",
      secure: true,
      httpOnly: false,
      expirationDate: 0
    };
  }).filter(Boolean);
}

/** 把 Cookie 列表压回「Cookie 头」字符串 */
function cookieHeaderOf(cookies) {
  return (Array.isArray(cookies) ? cookies : []).map((c) => `${c.name}=${c.value}`).join("; ");
}

module.exports = {
  PLATFORMS,
  platformOf,
  list,
  get,
  create,
  update,
  remove,
  reorder,
  groups,
  regenerateFingerprint,
  setFingerprintField,
  importMany,
  exportAll,
  parseCookies,
  cookieHeaderOf
};
