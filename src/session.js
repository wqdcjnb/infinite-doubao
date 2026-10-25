"use strict";

/**
 * 会话装配：一个实例 = 一个 persist 分区 + 一份指纹 + 一条出口
 *
 * 这里做四件事，顺序不能乱：
 *   1) UA 与语言（window.navigator 与 HTTP 头必须是同一份）
 *   2) 代理（含鉴权缓存）
 *   3) 请求头对齐 UA-CH（站点对账 navigator.userAgentData 与 sec-ch-ua）
 *   4) Cookie 导入（CK 直填，不走登录）
 */

const { session, app } = require("electron");
const store = require("./store");
const log = require("./logger");

const proxyAuthCache = new Map();
const appliedSessions = new WeakSet();
const proxyStates = new WeakMap();

function parseProxyUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const withScheme = /^[a-z0-9]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    const protocol = u.protocol.replace(":", "").toLowerCase();
    if (!["http", "https", "socks4", "socks5", "socks"].includes(protocol)) return null;
    const port = u.port || (protocol === "http" ? "80" : protocol === "https" ? "443" : "");
    if (!u.hostname || !port) return null;
    return {
      protocol: protocol === "socks" ? "socks5" : protocol,
      host: u.hostname,
      port,
      username: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      raw: withScheme
    };
  } catch {
    return null;
  }
}

function proxyRulesFor(inst) {
  const proxy = (inst && inst.proxy) || { mode: "direct" };
  if (proxy.mode === "direct") return { mode: "direct" };
  if (proxy.mode === "system") return { mode: "system" };
  const full = store.proxyUrlOf(inst);
  const p = parseProxyUrl(full);
  if (!p) throw new Error("代理地址格式不对，请填写有效的代理地址和端口");
  const scheme = p.protocol === "https" ? "https" : p.protocol;
  return { mode: "custom", rules: `${scheme}://${p.host}:${p.port}`, parsed: p };
}

function applyHeaderMask(ses, fp) {
  if (!fp || !fp.uaData) return;
  const brands = (fp.uaData.brands || []).map((b) => `"${b.brand}";v="${b.version}"`).join(", ");
  const full = (fp.uaData.fullVersionList || []).map((b) => `"${b.brand}";v="${b.version}"`).join(", ");
  const lang = String((fp.languages && fp.languages[0]) || "zh-CN");
  const langs = (fp.languages || [lang]).join(",");
  const mapping = {
    "user-agent": fp.userAgent,
    "sec-ch-ua": brands,
    "sec-ch-ua-full-version": `"${fp.uaData.uaFullVersion || ""}"`,
    "sec-ch-ua-full-version-list": full,
    "sec-ch-ua-platform": `"${String(fp.uaData.platform || "Windows")}"`,
    "sec-ch-ua-platform-version": `"${fp.uaData.platformVersion || ""}"`,
    "sec-ch-ua-mobile": fp.uaData.mobile ? "?1" : "?0",
    "sec-ch-ua-arch": `"${fp.uaData.architecture || "x86"}"`,
    "sec-ch-ua-bitness": `"${fp.uaData.bitness || "64"}"`,
    "sec-ch-ua-model": '""',
    "accept-language": langs
  };
  try {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) {
        const target = mapping[key.toLowerCase()];
        if (target) headers[key] = target;
      }
      callback({ requestHeaders: headers });
    });
  } catch (error) {
    log.warn("header-mask-failed", { message: String(error && error.message) });
  }
}

async function applySession(inst) {
  const ses = session.fromPartition(inst.partition);
  const fp = inst.fingerprint || {};
  try {
    ses.setUserAgent(String(fp.userAgent || app.userAgentFallback), String((fp.languages && fp.languages[0]) || "zh-CN"));
  } catch (error) {
    log.warn("set-user-agent-failed", { message: String(error && error.message) });
  }

  const pr = proxyRulesFor(inst);
  const config = pr.mode === "custom"
    ? { mode: "fixed_servers", proxyRules: pr.rules, proxyBypassRules: "<local>" }
    : { mode: pr.mode };
  const authKey = pr.parsed && (pr.parsed.username || pr.parsed.password)
    ? JSON.stringify([pr.parsed.username, pr.parsed.password]) : "";
  const key = JSON.stringify([config, authKey]);
  let state = proxyStates.get(ses);
  if (!state) {
    state = { key: null, authKey: "", applied: false, pending: Promise.resolve() };
    proxyStates.set(ses, state);
  }
  // 同一会话串行应用快照；普通 prepare / 检测不得重置正在使用的连接。
  const pending = state.pending.catch(() => {}).then(async () => {
    if (state.key === key) return;
    const changed = state.applied;
    state.key = null;
    await ses.setProxy(config);
    state.applied = true;
    if (changed && state.authKey !== authKey) await ses.clearAuthCache();
    if (changed) await ses.closeAllConnections();
    if (pr.parsed) proxyAuthCache.set(`${pr.parsed.host}:${pr.parsed.port}`, pr.parsed);
    state.key = key;
    state.authKey = authKey;
  });
  state.pending = pending;
  try {
    await pending;
  } catch (error) {
    log.warn("set-proxy-failed", { message: String(error && error.message), rules: pr.rules || pr.mode });
    throw error;
  }

  try {
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      const allow = ["media", "clipboard-read", "clipboard-sanitized-write", "notifications", "fullscreen", "geolocation", "pointerLock", "display-capture"];
      callback(allow.includes(permission));
    });
  } catch {}

  try { ses.setSpellCheckerEnabled(false); } catch {}

  if (!appliedSessions.has(ses)) {
    applyHeaderMask(ses, fp);
    appliedSessions.add(ses);
  }

  return ses;
}

/** 把 CK 写进分区（浏览器级 Cookie，页面直接带登录态） */
async function injectCookie(inst, cookies) {
  const ses = session.fromPartition(inst.partition);
  const host = (() => {
    try { return new URL(inst.url).hostname; } catch { return ""; }
  })();
  let ok = 0;
  for (const c of Array.isArray(cookies) ? cookies : []) {
    const domain = String(c.domain || "").replace(/^\./, "") || host;
    if (!domain) continue;
    const url = `https://${domain}${String(c.path || "/").startsWith("/") ? c.path : "/" + c.path}`;
    const details = {
      url,
      name: c.name,
      value: String(c.value == null ? "" : c.value),
      domain: c.domain && String(c.domain).startsWith(".") ? c.domain : undefined,
      path: c.path || "/",
      secure: c.secure !== false,
      httpOnly: !!c.httpOnly
    };
    if (c.expirationDate > 0) details.expirationDate = Number(c.expirationDate);
    try {
      await ses.cookies.set(details);
      ok += 1;
    } catch (error) {
      log.warn("cookie-set-failed", { name: c.name, message: String(error && error.message) });
    }
  }
  return ok;
}

/** 读分区里的 Cookie（导出用，默认只导目标站点域） */
async function readCookies(inst, domainFilter) {
  const ses = session.fromPartition(inst.partition);
  const urls = [];
  const host = (() => { try { return new URL(inst.url).hostname; } catch { return ""; } })();
  const dom = String(domainFilter || host || "").replace(/^\./, "");
  if (!dom) return [];
  urls.push(`https://${dom}/`, `https://www.${dom.replace(/^www\./, "")}/`);
  const out = [];
  const seen = new Set();
  for (const u of urls) {
    try {
      for (const c of await ses.cookies.get({ url: u })) {
        const key = `${c.domain}|${c.name}|${c.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate || 0
        });
      }
    } catch {}
  }
  return out;
}

function authFor(hostPort) {
  return proxyAuthCache.get(String(hostPort || "")) || null;
}

function accountBySession(ses) {
  if (!ses) return null;
  for (const inst of store.get().instances) {
    try { if (session.fromPartition(inst.partition) === ses) return inst; } catch {}
  }
  return null;
}

module.exports = {
  parseProxyUrl,
  proxyRulesFor,
  applySession,
  injectCookie,
  readCookies,
  authFor,
  accountBySession
};
