"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("默认模型配置不改写平台的模型目录、权限或生成请求", async () => {
  const calls = [];
  const original = JSON.stringify({ models: [{ model: "seedance_v2.0_mini", duration_ms: 5000, allowed: true }, { model: "seedance_v2.5", duration_ms: 30000, allowed: false }] });
  const context = vm.createContext({
    CFG: { autoKey: "test", enhancer: { enabled: true, model: "seedance_v2.5", duration: 30 } },
    location: { href: "https://www.doubao.com/chat/" }, URL, Response,
    window: { fetch: async (input, init) => { calls.push({ input, init }); return new Response(original, { headers: { "content-type": "application/json" } }); } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/enhancer.js"), "utf8"), context);
  const config = await context.window.fetch("/samantha/skill/pack");
  assert.equal(await config.text(), original);
  const body = JSON.stringify({ model: "chat-model", content: "generate video" });
  await context.window.fetch("/samantha/chat/completion", { body });
  assert.equal(calls[1].init.body, body);
  const previous = context.window.test_enh.setOptions({ model: "seedance_v2.0_mini", duration: 5 });
  assert.equal(previous.model, "seedance_v2.5");
  assert.equal(context.window.test_enh.duration, 5);
});
