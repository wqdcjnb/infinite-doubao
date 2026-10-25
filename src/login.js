"use strict";

/**
 * 一键登录（Google / 平台账号页状态机）
 *
 * 对标产品把登录自动化写成一条直线：找到输入框→填→点下一步，遇到验证码/两步验证就整条失败。
 * 这里做成状态机：每一轮先判当前处在哪一页（账号页 / 密码页 / 验证码 / 两步验证 / 同意授权），
 * 只做该页该做的事；需要人肉介入的环节挂起并等，超时才算失败，人能接得上。
 *
 * 密码只存在于内存与加密存储里，日志与事件里一律打码。
 */

const log = require("./logger");
const driverMod = require("./driver");

const HUMAN_STAGES = new Set(["challenge", "totp", "verify"]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function maskAccount(account) {
  const s = String(account || "");
  const at = s.indexOf("@");
  if (at > 1) return `${s.slice(0, 2)}***${s.slice(at)}`;
  return s.length > 3 ? `${s.slice(0, 2)}***` : "***";
}

/**
 * @param {object} instance 实例
 * @param {object} driver Driver
 * @param {object} creds {account, password}
 * @param {object} opts {onEvent, timeoutMs, humanTimeoutMs, signal}
 */
async function runLogin(instance, driver, creds, opts = {}) {
  const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : () => {};
  const timeoutMs = Number(opts.timeoutMs) || 180000;
  const humanTimeoutMs = Number(opts.humanTimeoutMs) || 240000;
  const deadline = Date.now() + timeoutMs;
  let humanDeadline = 0;
  let lastStage = "";
  let quiet = 0;

  const emit = (type, data = {}) => {
    try { onEvent({ type, at: new Date().toISOString(), instanceId: instance.id, ...data }); } catch {}
  };

  emit("start", { account: maskAccount(creds.account) });
  log.info("login-start", { instanceId: instance.id, account: maskAccount(creds.account) });

  while (Date.now() < deadline) {
    if (opts.signal && opts.signal.aborted) return { ok: false, stage: "aborted", reason: "已取消" };

    let stage = "unknown";
    try {
      stage = String(await driver.loginStage());
    } catch (error) {
      emit("error", { message: String(error && error.message) });
    }

    if (stage !== lastStage) {
      emit("stage", { stage, previous: lastStage });
      lastStage = stage;
      quiet = 0;
    } else {
      quiet += 1;
    }

    // 登录成功的判定优先：页面上有头像/用户菜单就直接收工
    try {
      const li = await driver.isLoggedIn();
      if (li && li.loggedIn && stage === "unknown") {
        emit("done", { by: li.by });
        log.info("login-done", { instanceId: instance.id });
        return { ok: true, stage: "logged", by: li.by };
      }
    } catch {}

    if (stage === "identifier" || stage === "password") {
      try {
        const r = await driver.fillLogin(creds.account, creds.password);
        emit("fill", { stage, ok: !!(r && r.ok) });
        if (r && r.needHuman) {
          humanDeadline = Date.now() + humanTimeoutMs;
          emit("need-human", { stage, reason: r.reason || "" });
        }
      } catch (error) {
        emit("error", { message: String(error && error.message) });
      }
      await sleep(1200);
      continue;
    }

    if (stage === "consent") {
      const r = await driver.clickText(["同意", "允许", "Continue", "Allow", "继续"]);
      emit("consent", r);
      await sleep(900);
      continue;
    }

    if (HUMAN_STAGES.has(stage)) {
      if (!humanDeadline) {
        humanDeadline = Date.now() + humanTimeoutMs;
        emit("need-human", { stage, reason: "需要人工完成验证（验证码/两步验证），完成后会自动继续" });
      }
      if (Date.now() > humanDeadline) {
        return { ok: false, stage, reason: "等待人工验证超时" };
      }
      await sleep(2000);
      continue;
    }

    // unknown：可能是加载中，也可能是已经登录
    if (quiet > 12) {
      const li = await driver.isLoggedIn().catch(() => null);
      if (li && li.loggedIn) return { ok: true, stage: "logged", by: li.by };
    }
    await sleep(1000);
  }

  return { ok: false, stage: lastStage || "timeout", reason: "登录流程超时" };
}

/** 对外入口：内嵌内核里跑登录流程（页面由界面上的 webview 提供） */
async function login(instance, creds, opts = {}) {
  const drv = await driverMod.open(instance, { webContents: opts.webContents });
  return runLogin(instance, drv, creds, opts);
}

module.exports = { runLogin, login, maskAccount };
