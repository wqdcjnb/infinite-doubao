"use strict";

/**
 * 内核状态
 *
 * 外挂真实 Chrome / Edge 的方案已下线：内核写死为应用自带的 Chromium（内嵌 webview），
 * 用户不再需要在第三方浏览器之间挑，运行环境也不依赖本机装没装 Chrome。
 * 这里只保留状态查询与空操作，历史调用点（/api/kernel/status、实例删除清理、
 * 指纹体检兜底）语义不变，不会因为没有外挂内核而炸。
 */

function status() {
  return {
    builtin: true,
    name: "自带内嵌内核（Chromium）",
    available: [],
    ready: true,
    running: []
  };
}

/** 外挂内核已下线，恒返回 null；调用方应改用主窗口里的 webview */
function get() {
  return null;
}

function stop() {
  return false;
}

function stopAll() {
  return 0;
}

module.exports = { status, get, stop, stopAll };
