"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

test("旧会话没有输入框时先打开新工作任务，再等待云电脑输入区", async () => {
  let mounted = false, now = 0, clicks = 0;
  const location = { pathname: "/chat/old-conversation", href: "https://www.doubao.com/chat/old-conversation" };
  const node = text => ({ innerText: text, isConnected: true, getBoundingClientRect: () => ({ width: 600, height: 100 }), getAttribute: () => null, dispatchEvent() {} });
  const input = { ...node(""), tagName: "TEXTAREA", value: "" }, mode = node("云电脑");
  const entry = { ...node("新工作任务"), click() { clicks++; mounted = true; location.pathname = "/chat/"; location.href = "https://www.doubao.com/chat/"; } };
  const root = { querySelectorAll(selector) {
    if (!mounted) return [];
    if (selector.includes("chat_input_action_mode")) return [mode];
    if (selector.includes("textarea")) return [input];
    return [];
  } };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("draft-conversation-section")) return [];
      if (selector === "#input-engine-container") return mounted ? [root] : [];
      if (selector.includes("role=\"button\"")) return [entry];
      return [];
    },
    querySelector(selector) {
      if (selector.includes("draft-conversation-section")) return null;
      if (selector.includes("chat_input_action_mode")) return mounted ? mode : null;
      return mounted ? input : null;
    }
  };
  Object.assign(root, node(""));
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ window: { auto: {} }, CFG: { autoKey: "auto" }, document, location,
    Date: Clock, getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    MouseEvent: class {}, PointerEvent: class {}, setTimeout(fn, ms) { now += ms; queueMicrotask(fn); } });
  for (const name of ["generation-options.js", "native-drafts.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page", name), "utf8"), context);
  const result = await context.window.auto.prepareNativeDraft({ executionMode: "work" });
  assert.equal(result.ok, true, result.reason); assert.equal(clicks, 1); assert.equal(mounted, true);
  assert.ok(now < 2000, "must not wait for the old missing composer");
});
