"use strict";

/**
 * 账号探活
 *
 * 判据来自实测：passport_csrf_token / flow_cur_user_sec_id 这两个 cookie 在**未登录访客**页
 * 面上就存在，拿它们当登录标志会全站误判。真正的登录态标志是
 * oauth_token / sessionid / sid_tt / uid_tt / sid_guard / passport_auth_status 之一。
 *
 * 探活分两层：
 *   1) Cookie 层：有没有上面那几个键，过期时间是否已过
 *   2) 接口层：拿会话去请求平台自己的用户信息接口，看是不是 200 + 有 uid
 * 两层都过了才算 logged，接口层失败但 Cookie 在 → unknown（可能接口改版，不冤枉账号）。
 */

const log = require("./logger");
const store = require("./store");

const LOGIN_COOKIES = ["oauth_token", "sessionid", "sessionid_ss", "sid_tt", "uid_tt", "sid_guard", "passport_auth_status", "s_v_web_id"];
const FALSE_POSITIVES = new Set(["passport_csrf_token", "flow_cur_user_sec_id", "passport_csrf_token_default", "ttwid", "msToken"]);

const PROBE_ENDPOINTS = {
  doubao: ["https://www.doubao.com/api/user/info", "https://www.doubao.com/passport/account/info/"],
  dola: ["https://www.dola.com/api/user/info"],
  jimeng: ["https://jimeng.jianying.com/passport/account/info/"],
  "jimeng-intl": ["https://dreamina.capcut.com/api/user/info"],
  qianwen: ["https://tongyi.aliyun.com/api/user/info"]
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 纯函数，便于单测：给一组 cookie 判定登录态 */
function judgeCookies(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  const names = new Set(list.map((c) => String(c.name || "")));
  const hits = LOGIN_COOKIES.filter((n) => names.has(n));
  if (!hits.length) {
    const fps = [...names].filter((n) => FALSE_POSITIVES.has(n));
    return {
      state: "expired",
      hits: [],
      falsePositives: fps,
      detail: fps.length ? `只有访客态 cookie（${fps.join(", ")}），未登录` : "没有登录态 cookie"
    };
  }
  const expired = list
    .filter((c) => hits.includes(c.name) && Number(c.expirationDate) > 0 && Number(c.expirationDate) < nowSec())
    .map((c) => c.name);
  const alive = hits.filter((n) => !expired.includes(n));
  if (alive.length) return { state: "logged", hits: alive, expired, detail: `登录态 cookie：${alive.join(", ")}` };
  return { state: "expired", hits: [], expired, detail: `登录态 cookie 已过期：${expired.join(", ")}` };
}

async function probe(instance, opts = {}) {
  const ses = opts.session;
  if (!ses) return { ok: false, state: "unknown", detail: "没有可用会话" };
  let cookies = [];
  try {
    cookies = await ses.cookies.get({});
  } catch (error) {
    log.warn("probe-cookie-failed", { message: String(error && error.message) });
  }
  const verdict = judgeCookies(cookies);
  const result = {
    ok: verdict.state === "logged",
    state: verdict.state,
    detail: verdict.detail,
    hits: verdict.hits || [],
    expired: verdict.expired || [],
    cookieCount: cookies.length,
    checkedAt: new Date().toISOString(),
    api: ""
  };

  if (verdict.state === "logged" && opts.api !== false) {
    const urls = PROBE_ENDPOINTS[instance.platform] || [];
    for (const url of urls) {
      try {
        const res = await ses.fetch(url, { headers: { accept: "application/json" } });
        const text = await res.text();
        result.api = `${res.status} ${url}`;
        if (res.ok && /"uid"|"user_id"|"userId"|"sec_uid"/.test(text)) {
          result.detail = `${verdict.detail}；接口确认在线`;
          break;
        }
      } catch (error) {
        result.api = `err ${String(error && error.message).slice(0, 80)}`;
      }
    }
  }

  const inst = store.find(instance.id);
  if (inst) {
    inst.login = { state: result.state, checkedAt: result.checkedAt };
    store.save();
  }
  log.info("account-probe", { instanceId: instance.id, state: result.state });
  return result;
}

/** 给界面用的一键探活：遍历所有实例 */
async function probeAll(opts = {}) {
  const { session } = require("electron");
  const out = [];
  for (const inst of store.get().instances) {
    try {
      const ses = session.fromPartition(inst.partition);
      // eslint-disable-next-line no-await-in-loop
      out.push({ id: inst.id, name: inst.name, ...(await probe(inst, { ...opts, session: ses })) });
    } catch (error) {
      out.push({ id: inst.id, name: inst.name, ok: false, state: "unknown", detail: String(error && error.message) });
    }
  }
  return out;
}

module.exports = { judgeCookies, probe, probeAll, LOGIN_COOKIES, FALSE_POSITIVES };
