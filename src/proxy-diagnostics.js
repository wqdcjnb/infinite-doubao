"use strict";

const { isIP } = require("node:net");

const DOMESTIC = "https://myip.ipip.net/";
const DOMESTIC_FALLBACK = "https://ip.3322.net/";
const INTERNATIONAL = "https://ipwho.is/?lang=zh-CN";
const DEFAULT_TARGET = "https://www.doubao.com/chat/";
const COUNTRY_CODES = {
  中国: "CN", 中国香港: "HK", 中国澳门: "MO", 中国台湾: "TW",
  美国: "US", 日本: "JP", 新加坡: "SG", 韩国: "KR", 英国: "GB",
  德国: "DE", 法国: "FR", 加拿大: "CA", 澳大利亚: "AU", 俄罗斯: "RU", 印度: "IN"
};

function diagnosticError(message) {
  return Object.assign(new Error(message), { diagnostic: true });
}

function routeKey(value) {
  if (typeof value !== "string" || !value.trim()) throw diagnosticError("当前账号线路为空，无法确认 IP");
  const rules = value.split(";").map((part) => part.trim()).filter(Boolean);
  if (!rules.length) throw diagnosticError("当前账号线路为空，无法确认 IP");
  return rules.map((rule) => {
    if (/^DIRECT$/i.test(rule)) return "DIRECT";
    const match = rule.match(/^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5|QUIC)\s+((?:\[[0-9a-f:]+\]|[^\s:/@?#]+):(\d+))$/i);
    if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) throw diagnosticError("当前账号线路格式无法确认，请检查代理设置");
    const address = new URL(`http://${match[2]}`);
    return `${match[1].toUpperCase()} ${address.hostname.toLowerCase()}:${Number(match[3])}`;
  }).join("; ");
}

function budget(timeoutMs, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw diagnosticError("检测超时，请重试");
  return Math.min(timeoutMs, remaining);
}

async function resolveRoute(session, url, timeoutMs, deadline) {
  let timer;
  try {
    const ms = budget(Math.min(timeoutMs, 5000), deadline);
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(diagnosticError("账号线路解析超时，请重试")), ms);
    });
    const raw = await Promise.race([Promise.resolve().then(() => session.resolveProxy(url)), timeout]);
    return routeKey(raw);
  } catch (error) {
    throw error?.diagnostic ? error : diagnosticError("无法确认当前账号线路，请检查代理配置后重试");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function ipAddress(value) {
  const ip = typeof value === "string" ? value.trim() : "";
  const version = isIP(ip);
  if (!version || ip.includes("%")) throw diagnosticError("检测源未返回有效 IP 地址");
  // Equivalent IPv6 spellings must not be reported as different exits.
  return version === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}

function text(value) { return typeof value === "string" ? value.trim().slice(0, 200) : ""; }
function location(country, region, city) {
  return [...new Set([country, region, city].filter(Boolean))].join(" ") || "位置未知";
}

function parseDomestic(body) {
  const match = body.trim().match(/^当前\s*IP\s*[:：]\s*(\S+?)\s*来自于\s*[:：]\s*(.*)$/i);
  if (!match) throw diagnosticError("国内检测源返回格式无法识别");
  const ip = ipAddress(match[1]);
  const [country = "", region = "", city = "", ...provider] = text(match[2]).split(/\s+/);
  return { ip, countryCode: COUNTRY_CODES[country] || "", country, region, city, location: location(country, region, city), isp: provider.join(" ") };
}

function parseInternational(body) {
  let data;
  try { data = JSON.parse(body); } catch { throw diagnosticError("国际检测源返回格式无法识别"); }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.success === false) throw diagnosticError("国际检测源未能完成查询");
  const ip = ipAddress(data.ip);
  const countryCode = /^[A-Z]{2}$/.test(text(data.country_code).toUpperCase()) ? text(data.country_code).toUpperCase() : "";
  const country = text(data.country), region = text(data.region), city = text(data.city);
  return { ip, countryCode, country, region, city, location: location(country, region, city), isp: text(data.connection?.isp) };
}

async function request(session, source, parse, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const empty = { ok: false, ip: "", countryCode: "", country: "", region: "", city: "", location: "位置未知", isp: "", source, latency: 0, message: "" };
  let timer;
  try {
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(diagnosticError("检测超时，请重试")); }, timeoutMs);
    });
    const result = await Promise.race([
      (async () => {
        const response = await session.fetch(source, {
          cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { accept: source === INTERNATIONAL ? "application/json" : "text/plain" }
        });
        if (!response.ok) throw diagnosticError(`检测源请求失败（HTTP ${Number(response.status) || 0}）`);
        return parse(await response.text());
      })(),
      timeout
    ]);
    return { ...empty, ...result, ok: true, latency: Date.now() - started };
  } catch (error) {
    // Network errors can contain proxy credentials; return only controlled messages.
    const message = controller.signal.aborted ? "检测超时，请重试" : error?.diagnostic ? error.message : "请求失败，请检查网络或代理连接";
    return { ...empty, latency: Date.now() - started, message };
  } finally {
    clearTimeout(timer);
  }
}

async function testProxy(session, opts = {}) {
  const started = Date.now(), deadline = started + 30000;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Math.min(Number(opts.timeoutMs), 30000) : 10000;
  const empty = { ok: false, ip: "", countryCode: "", country: "", region: "", city: "", location: "位置未知", isp: "", source: "", latency: 0 };
  const report = (result) => ({ ...empty, ...result, checkedAt: new Date().toISOString(), mode: opts.mode });
  let source = "";
  try {
    let target;
    try {
      target = new URL(opts.targetUrl || DEFAULT_TARGET);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error();
    } catch { throw diagnosticError("账号目标网址无效，只支持 HTTP 或 HTTPS"); }
    const route = await resolveRoute(session, target.href, timeoutMs, deadline);
    let lastFailure;
    for (const [url, parse] of [[DOMESTIC, parseDomestic], [DOMESTIC_FALLBACK, (body) => ({ ip: ipAddress(body) })], [INTERNATIONAL, parseInternational]]) {
      // Compare the entire ordered fallback chain, not just its first proxy.
      if (await resolveRoute(session, url, timeoutMs, deadline) !== route) continue;
      source = url;
      const result = await request(session, url, parse, budget(timeoutMs, deadline));
      if (!result.ok) { lastFailure = result; continue; }
      const targetAfter = await resolveRoute(session, target.href, timeoutMs, deadline);
      const sourceAfter = await resolveRoute(session, url, timeoutMs, deadline);
      if (targetAfter !== route || sourceAfter !== route) throw diagnosticError("账号线路在检测期间发生变化，请重新检测");
      // Matching Chromium rules cannot prove the same physical exit behind TUN/upstream routing.
      if (url === DOMESTIC_FALLBACK) result.message = "当前检测源仅返回 IP，位置未知";
      return report(result);
    }
    return report({ source, latency: Date.now() - started, message: lastFailure
      ? `匹配当前账号线路的检测源均失败：${lastFailure.message}`
      : "没有与当前账号线路匹配的 IP 检测源，无法确认 IP" });
  } catch (error) {
    return report({ source, latency: Date.now() - started, message: error?.diagnostic ? error.message : "当前账号 IP 检测失败，请重试" });
  }
}

module.exports = { testProxy };
