"use strict";

const { isIP } = require("node:net");

const DOMESTIC = "https://myip.ipip.net/";
const DOMESTIC_FALLBACK = "https://ip.3322.net/";
const INTERNATIONAL = "https://ipwho.is/?lang=zh-CN";
const COUNTRY_CODES = {
  中国: "CN", 中国香港: "HK", 中国澳门: "MO", 中国台湾: "TW",
  美国: "US", 日本: "JP", 新加坡: "SG", 韩国: "KR", 英国: "GB",
  德国: "DE", 法国: "FR", 加拿大: "CA", 澳大利亚: "AU", 俄罗斯: "RU", 印度: "IN"
};

function diagnosticError(message) {
  return Object.assign(new Error(message), { diagnostic: true });
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
          cache: "no-store", signal: controller.signal,
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

async function domestic(session, timeoutMs) {
  const primary = await request(session, DOMESTIC, parseDomestic, timeoutMs);
  if (primary.ok) return primary;
  const fallback = await request(session, DOMESTIC_FALLBACK, (body) => ({ ip: ipAddress(body) }), timeoutMs);
  return { ...fallback, message: fallback.ok
    ? "主检测源不可用，备用源仅返回 IP，位置未知"
    : `国内检测源：${primary.message}；备用检测源：${fallback.message}` };
}

async function testProxy(session, opts = {}) {
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;
  const [domesticResult, international] = await Promise.all([
    domestic(session, timeoutMs), request(session, INTERNATIONAL, parseInternational, timeoutMs)
  ]);
  const ok = domesticResult.ok || international.ok;
  return {
    ok, checkedAt: new Date().toISOString(), mode: opts.mode,
    domestic: domesticResult, international,
    differentExits: domesticResult.ok && international.ok && domesticResult.ip !== international.ip,
    ...(!ok ? { message: "国内和国际出口检测均失败，请检查连接后重试" } : {})
  };
}

module.exports = { testProxy };
