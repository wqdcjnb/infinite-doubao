"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

function page(items, delayed, loading) {
  let now = 1000, active = null, sends = 0, current = items, loadAt = Infinity;
  const editor = { tagName: "TEXTAREA", value: "" }, mode = { innerText: "云电脑" };
  const button = { disabled: false, getAttribute: () => null, click: () => { sends++; } };
  const rows = items.map(item => ({
    item, dataset: {}, isConnected: true,
    querySelector: () => ({ innerText: item.title }),
    classList: { contains: () => active?.item === item },
    click() { active = this; editor.value = item.prompt; mode.innerText = item.mode || "云电脑"; }
  }));
  let expands = 0, scrolls = 0;
  const heading = { innerText: "草稿 对话列表设置", disabled: false, getAttribute: () => null, click() { expands++; current = items.slice(0, 5); } };
  const more = { innerText: "展开更多草稿", disabled: false, getAttribute: () => null, click() { expands++; current = items; } };
  const section = { parentElement: null, clientHeight: 100, scrollHeight: ["scroll", "slow-scroll"].includes(loading) ? 500 : 100, scrollTop: 0,
    querySelectorAll: () => ["expand", "collapsed"].includes(loading) && current.length < items.length ? [more] : [],
    scrollTo({ top }) {
      this.scrollTop = Math.min(top, this.scrollHeight - this.clientHeight); scrolls++;
      if (loading !== "slow-scroll") current = items.slice(0, Math.min(items.length, current.length + 5));
      else if (this.scrollTop === 400) loadAt = now + 1500;
    } };
  const document = {
    querySelector: selector => selector.includes("draft-conversation-section") ? current.length ? section : null : selector.includes("chat_input_action_mode") ? mode : selector.includes("chat_input_send_button") ? button : editor,
    querySelectorAll: selector => selector.includes("draft-conversation-section") ? rows.filter(row => current.includes(row.item)) : selector === 'button, [role="button"]' && !current.length ? [heading] : []
  };
  const context = vm.createContext({ window: { auto: {} }, document, CFG: { autoKey: "auto" }, Date: { now: () => now },
    setTimeout: fn => { now += 100; if ((delayed && now >= 1600) || now >= loadAt) current = items; fn(); } });
  if (delayed) current = items.slice(0, 1);
  if (loading) current = items.slice(0, 5);
  if (loading === "collapsed") current = [];
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/native-drafts.js"), "utf8"), context);
  return { api: context.window.auto, rows, sends: () => sends, expands: () => expands, scrolls: () => scrolls };
}
const binding = (id, title, prompt) => ({ id, title, prompt, executionMode: "work", index: 0, titles: [title] });
const numberA = "DB-111111111111111111111111", numberB = "DB-222222222222222222222222";
const numbered = (number, body = "相同视频提示词") => `【草稿编号：${number}】\n\n${body}`;

test("回执按当前对话的完整用户提示词核对，侧栏迟到或残留草稿不影响，超过20秒仍等待", async () => {
  let now = 0, content = "错误任务";
  const prompt = numbered(numberA);
  const node = { innerText: "", closest: () => ({ getAttribute: key => key === "data-message-role" ? "user" : null }) };
  const document = { querySelectorAll: sel => sel === '[data-message-id]' ? [{ ...node, innerText: content }] : [], getElementById: () => null };
  const location = { pathname: '/chat/late-receipt', href: 'https://www.doubao.com/chat/late-receipt' };
  const context = vm.createContext({ window: { auto: {} }, document, location, CFG: { autoKey: 'auto' }, Date: { now: () => now }, setTimeout: fn => { now += 100; if (now >= 35000) content = prompt; fn(); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/page/native-drafts.js'), 'utf8'), context);
  const result = await context.window.auto.waitNativeDraftAccepted({ id: 'a', prompt, conversationIds: [] });
  assert.equal(result.ok, true, result.reason); assert.equal(result.conversationUrl, location.href);
  assert.ok(now >= 35000);
  content = numbered(numberB);
  assert.equal(context.window.auto.readNativeDraftReceipt({ prompt }).ok, false);
});

test("19 条草稿只展示最近 5 条时，展开或滚动后仍逐条按完整编号找到全部", async () => {
  const items = Array.from({ length: 19 }, (_, i) => {
    const number = "DB-" + i.toString(16).toUpperCase().padStart(24, "0");
    return { number, title: numbered(number), prompt: numbered(number) };
  });
  for (const loading of ["collapsed", "expand", "scroll"]) for (const [i, item] of items.entries()) {
    const p = page(items, false, loading);
    const result = await p.api.restoreNativeDrafts([{ ...binding(String(i), item.title, item.prompt), draftNumber: item.number }]);
    assert.equal(result.ok, true, `${loading}: draft ${i + 1}: ${result.reason}`);
    assert.equal((await p.api.openNativeDraft({ id: String(i), prompt: item.prompt, executionMode: "work" })).ok, true);
    assert.equal(p.rows[i].dataset.dmDraftId, String(i)); assert.equal(p.sends(), 0);
    if (i >= 5) assert.ok(loading !== "scroll" ? p.expands() > 0 : p.scrolls() > 0);
  }
});

test("编号确定身份，标题后缀和列表顺序改变不影响相同提示词的不同草稿", async () => {
  const p = page([{ title: numbered(numberB, "不同显示标题"), prompt: numbered(numberB) }, { title: numbered(numberA, "新的显示标题"), prompt: numbered(numberA) }]);
  const result = await p.api.restoreNativeDrafts([{ ...binding("a", "旧标题", numbered(numberA)), draftNumber: numberA }]);
  assert.equal(result.ok, true); assert.equal(p.rows[1].dataset.dmDraftId, "a");
  assert.equal((await p.api.openNativeDraft({ id: "a", prompt: numbered(numberA), executionMode: "work" })).ok, true);
  assert.equal(p.sends(), 0);
});
test("侧栏截断编号时打开草稿核对完整编号，相同正文仍可区分", async () => {
  const p = page([{ title: "【草稿编号：DB", prompt: numbered(numberB) }, { title: "【草稿编号：DB", prompt: numbered(numberA) }]);
  assert.equal((await p.api.restoreNativeDrafts([{ ...binding("a", "旧标题", numbered(numberA)), draftNumber: numberA }])).ok, true);
  assert.equal(p.rows[1].dataset.dmDraftId, "a"); assert.equal(p.sends(), 0);
});

test("折叠列表里的截断标题不能冒充已找到目标，先加载剩余草稿再核对完整内容", async () => {
  const items = Array.from({ length: 19 }, (_, i) => ({
    title: "【草稿编号：DB", prompt: numbered("DB-" + i.toString(16).toUpperCase().padStart(24, "0"))
  }));
  for (const loading of ["collapsed", "expand", "scroll"]) {
    const p = page(items, false, loading), item = items[18];
    assert.equal((await p.api.restoreNativeDrafts([{ ...binding("last", item.title, item.prompt), draftNumber: "DB-000000000000000000000012" }])).ok, true);
    assert.equal(p.rows[18].dataset.dmDraftId, "last"); assert.equal(p.sends(), 0);
  }
});

test("截断标题到底后延迟 1500ms 才出现目标，重新读取候选而非按旧的 5 条判失败", async () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ title: "【草稿编号：DB", prompt: numbered("DB-" + i.toString(16).padStart(24, "0")) }));
  const p = page(items, false, "slow-scroll"), item = items[5];
  const result = await p.api.restoreNativeDrafts([{ ...binding("last", item.title, item.prompt), draftNumber: "DB-000000000000000000000005" }]);
  assert.equal(result.ok, true, result.reason); assert.equal(p.rows[5].dataset.dmDraftId, "last"); assert.equal(p.sends(), 0);
});

test("33、50、53 条截断标题的完整核对不被固定 20 秒提前截断", async () => {
  for (const count of [33, 50, 53]) {
    const items = Array.from({ length: count }, (_, i) => ({ title: "【草稿编号：DB", prompt: numbered("DB-" + i.toString(16).toUpperCase().padStart(24, "0")) }));
    const p = page(items), item = items[0];
    const result = await p.api.restoreNativeDrafts([{ ...binding("first", item.title, item.prompt), draftNumber: "DB-000000000000000000000000" }]);
    assert.equal(result.ok, true, `${count}: ${result.reason}`); assert.equal(p.rows[0].dataset.dmDraftId, "first"); assert.equal(p.sends(), 0);
  }
});
test("复制编号导致重复或修改编号时停止，不能回退按标题猜测", async () => {
  for (const shortened of [false, true]) for (const alreadyMapped of [false, true]) {
    const p = page(["正文 A", "正文 B"].map(body => ({ title: shortened ? "【草稿编号：DB" : numbered(numberA, body), prompt: numbered(numberA, body) })));
    if (alreadyMapped) p.rows[0].dataset.dmDraftId = "a";
    const result = await p.api.restoreNativeDrafts([{ ...binding("a", "旧标题", numbered(numberA, "正文 A")), draftNumber: numberA }]);
    assert.equal(result.ok, false); assert.match(result.reason, /重复草稿编号/); assert.equal(p.sends(), 0);
  }
  const p = page([{ title: numbered(numberB), prompt: numbered(numberB) }]);
  assert.equal((await p.api.restoreNativeDrafts([{ ...binding("a", numbered(numberB), numbered(numberA)), draftNumber: numberA }])).ok, false);
  assert.equal(p.sends(), 0);
});

test("新增无关草稿或列表重排后按所选草稿恢复，不依赖旧位置", async () => {
  const p = page([{ title: "新草稿", prompt: "其他内容" }, { title: "原草稿", prompt: "完整任务" }]);
  const result = await p.api.restoreNativeDrafts([binding("a", "原草稿", "完整任务")]);
  assert.equal(result.ok, true); assert.equal(p.rows[1].dataset.dmDraftId, "a");
  assert.equal((await p.api.openNativeDraft({ id: "a", prompt: "完整任务", executionMode: "work" })).ok, true);
  assert.equal(p.sends(), 0);
});
test("同名草稿重排后逐条核对完整提示词，不能只信标题和旧索引", async () => {
  const p = page([{ title: "相同前缀", prompt: "完整任务 B" }, { title: "相同前缀", prompt: "完整任务 A" }]);
  const result = await p.api.restoreNativeDrafts([binding("a", "相同前缀", "完整任务 A"), binding("b", "相同前缀", "完整任务 B")]);
  assert.equal(result.ok, true); assert.equal(p.rows[1].dataset.dmDraftId, "a"); assert.equal(p.rows[0].dataset.dmDraftId, "b");
  assert.equal(p.sends(), 0);
});
test("等所选草稿加载完成，已有无关条目不能提前结束等待", async () => {
  const p = page([{ title: "无关", prompt: "其他" }, { title: "稍后加载", prompt: "完整任务" }], true);
  assert.equal((await p.api.restoreNativeDrafts([binding("a", "稍后加载", "完整任务")])).ok, true);
  assert.equal(p.rows[1].dataset.dmDraftId, "a");
});
test("完全相同提示词无法区分附件时保留草稿，拒绝猜测", async () => {
  const p = page([{ title: "同名", prompt: "相同任务" }, { title: "同名", prompt: "相同任务" }]);
  const result = await p.api.restoreNativeDrafts([binding("a", "同名", "相同任务")]);
  assert.equal(result.ok, false); assert.match(result.reason, /无法区分附件归属/);
  assert.ok(p.rows.every(row => !row.dataset.dmDraftId)); assert.equal(p.sends(), 0);
});
test("草稿被移除或内容被改写时不能触发发送", async () => {
  const missing = page([{ title: "别的草稿", prompt: "其他" }]);
  assert.equal((await missing.api.restoreNativeDrafts([binding("a", "已移除", "原内容")])).ok, false);
  const changed = page([{ title: "同名", prompt: "修改后的内容" }]);
  assert.equal((await changed.api.restoreNativeDrafts([binding("a", "同名", "原内容")])).ok, true);
  assert.equal((await changed.api.openNativeDraft({ id: "a", prompt: "原内容", executionMode: "work" })).ok, false);
  assert.equal((await changed.api.sendNativeDraft({ id: "a", prompt: "原内容" })).ok, false);
  assert.equal(changed.sends(), 0);
});
