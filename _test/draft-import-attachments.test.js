"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const names = ["1.png", "2.png", "3.png", "4.png", "5.png"];
function fixture({ appearAt = 0, readyAt = 0, persistedAt = 0, persistedCount = 5, failed = false, existing = false, activeExisting = false, collapsed = false, richSkill = false, wrongSkill = false, alternateState = false, staleReady = false, sharedReturn = false, present = names, persistedOrder = names, interrupted = false, pending = "target", catalogAvailable = true, accountKnown = true, changeAccountOnRead = false } = {}) {
  let now = 1000, switched = 0, clicks = 0, unrelatedClicks = 0, active = activeExisting, expanded = !collapsed, changedAccount = false;
  const scope = "account-a", body = "【草稿编号：DB-111111111111111111111111】 视频";
  const prompt = (richSkill ? "[Seedance 2.5](skill://seedance-25?type=2&id=353376777986)\n" : "") + body;
  const visiblePrompt = richSkill ? "Seedance 2.5\n" + body : prompt;
  const metadata = { id: "native", title: prompt, scene: "new-office-task", inputDraftIndex: { accountScope: scope, conversationScope: "local:native", inputId: "primary" } };
  const current = { tagName: "TEXTAREA", value: interrupted ? "" : visiblePrompt, editor: { getText: () => current.value } };
  if (richSkill) current.pmViewDesc = { node: { toJSON: () => ({type:"doc",content:[{type:"paragraph",content:[{type:"mention",attrs:{mentionType:"skill",label:"Seedance 2.5",skillId:"seedance-25",skill_type:2,external_skill_id:wrongSkill?"wrong":"353376777986"}},{type:"text",text:"\n"+body}]}]}) } };
  const row = { dataset: {}, classList: { contains: () => active }, querySelector: () => ({ innerText: prompt }), __reactFiber$test: { memoizedProps: { draft: metadata } }, click() { clicks++; active = true; current.value = visiblePrompt; } };
  const button = { disabled: false, getAttribute: () => null };
  const mode = { innerText: "云电脑" }, section = { querySelector: () => null, querySelectorAll: () => collapsed ? [more] : [] };
  const cards = () => now < 1000 + appearAt ? [] : present.map((name, i) => {
    const currentFiber = { memoizedProps: { attachmentState: { fileName: name, fileKey: now >= 1000 + readyAt ? "key-" + i : "", status: failed ? "Error" : now >= 1000 + readyAt ? "Normal" : "Uploading" } } };
    let fiber = currentFiber;
    if (alternateState) {
      const a = {}, b = {}; a.stateNode = b.stateNode = { current: b }; currentFiber.return = b;
      fiber = { return: a, alternate: currentFiber, memoizedProps: { attachmentState: { fileName: name, fileKey: staleReady ? "old-key" : "", status: staleReady ? "Normal" : "Uploading" } } }; currentFiber.alternate = fiber;
      b.child = currentFiber;
      if (sharedReturn === "same-root") fiber.return = b;
      if (sharedReturn === "shared-child") { currentFiber.return = a; fiber.return = b; a.child = currentFiber; }
    }
    return { getAttribute: key => key === "aria-label" ? name : null, __reactFiber$test: fiber };
  });
  const newChat = { innerText: "新对话", getAttribute: () => null, click() { switched = now; active = false; current.value = ""; } };
  const more = { innerText: "展开更多草稿", getAttribute: () => null, click() { expanded = true; } };
  const unrelated = { innerText: "展开更多草稿", getAttribute: () => null, click() { unrelatedClicks++; } };
  const document = { querySelector: s => s.includes("draft-conversation-section") ? section : s.includes("chat_input_action_mode") ? mode : s.includes("chat_input_send_button") ? button : current,
    querySelectorAll: s => s.includes("attachment_area") ? cards() : s.includes("draft-conversation-section") ? expanded && (existing || switched) ? [row] : [] : [newChat, ...(collapsed ? [unrelated, more] : [])] };
  const inputs = () => ({ state: { accountScope: scope, records: pending === "empty" ? [] : [{ address: metadata.inputDraftIndex, updatedAt: now, units: {
    "input.document": pending === "attachments-only" ? undefined : { updatedAt: now, payload: pending === "unknown" ? { format: "unknown" } : { format: "plain-text", text: prompt } },
    "input.attachments": { payload: { items: now >= 1000 + persistedAt ? persistedOrder.slice(0, persistedCount).map((fileName, i) => ({ fileName, fileKey: "key-" + i })) : [] } }
  } }] } });
  const indexedDB = { databases: async () => catalogAvailable ? [{ name: "flow-draft-conversations-v2" }, { name: "samantha-web" }] : [], open(name) {
    const q = {}; queueMicrotask(() => { q.result = { close() {}, transaction(_name, mode) {
      assert.equal(mode, "readonly"); const tx = { objectStore: () => ({ get: () => { changedAccount=changeAccountOnRead; return read(inputs()); }, getAll: () => read(existing || switched ? [{ accountScope: scope, id: "native", data: metadata }] : []) }) };
      function read(value) { const r = {}; queueMicrotask(() => { r.result = value; r.onsuccess(); queueMicrotask(() => tx.oncomplete()); }); return r; } return tx;
    } }; q.onsuccess(); }); return q;
  } };
  class Clock extends Date { static now() { return now; } }
  const api = {}, context = vm.createContext({ window: { auto: api }, CFG: { autoKey: "auto" }, document, indexedDB, localStorage: { getItem: () => accountKnown ? changedAccount ? "other-account" : scope : "" }, Date: Clock,
    clearTimeout, setTimeout: (fn, delay) => delay > 100 ? setTimeout(fn, delay) : (now += 100, queueMicrotask(fn)) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/page/native-drafts.js"), "utf8"), context);
  return { api, options: { id: "local", prompt, executionMode: "work", attachmentNames: names }, state: () => ({ elapsed: now - 1000, switched: switched ? switched - 1000 : null, clicks, unrelatedClicks }) };
}

test("按钮已可用、正文已同步时仍等待五张图片出现和上传完成才切页", async () => {
  const f = fixture({ appearAt: 1000, readyAt: 5000, persistedAt: 5600 });
  const result = await f.api.saveNativeDraft(f.options);
  assert.equal(result.ok, true, result.reason);
  assert.ok(f.state().switched >= 5000, JSON.stringify(f.state()));
  assert.ok(f.state().elapsed >= 5600);
});
test("React旧状态不能阻塞已完成上传，也不能提前放行当前仍在上传的图片", async () => {
  for (const staleReady of [false, true]) for (const sharedReturn of [false, "same-root", "shared-child"]) {
    const f = fixture({ alternateState: true, staleReady, sharedReturn, readyAt: 5000 });
    const result = await f.api.saveNativeDraft(f.options);
    assert.equal(result.ok, true, result.reason); assert.ok(f.state().switched >= 5000);
  }
});
test("正文已保存但附件只落盘四张时不返回导入成功", async () => {
  const f = fixture({ persistedCount: 4 });
  const result = await f.api.saveNativeDraft(f.options);
  assert.equal(result.ok, false); assert.match(result.reason, /附件|素材|图片/);
});
test("上传失败或少一张图片时保持当前草稿，不切换下一条", async () => {
  for (const options of [{ failed: true }, { present: names.slice(0, 4) }]) {
    const f = fixture(options), result = await f.api.saveNativeDraft(f.options);
    assert.equal(result.ok, false); assert.equal(f.state().switched, null);
  }
});
test("持久附件顺序不同不能冒充完整保存", async () => {
  const f = fixture({ persistedOrder: [...names].reverse() });
  assert.equal((await f.api.saveNativeDraft(f.options)).ok, false);
});
test("恢复已存草稿时完整附件跳过，缺图只返回原草稿缺失项", async () => {
  for (const count of [5, 2, 0]) {
    const f = fixture({ existing: true, persistedCount: count, present: names.slice(0, count) });
    const result = await f.api.resumeNativeDraftImport(f.options);
    assert.equal(result.ok, true, result.reason); assert.equal(result.complete, count === 5);
    assert.deepEqual(Array.from(result.missingNames || []), names.slice(count));
    assert.equal(result.bindings[0].nativeId, "native"); assert.equal(f.state().switched, null);
  }
});
test("原草稿在折叠的更多列表内时，展开后按原ID补图", async () => {
  const f = fixture({ existing: true, collapsed: true, persistedCount: 0, present: [] });
  const result = await f.api.resumeNativeDraftImport(f.options);
  assert.equal(result.ok, true, result.reason); assert.equal(result.bindings[0].nativeId, "native");
  assert.deepEqual(Array.from(result.missingNames), names); assert.equal(f.state().clicks, 1);
  assert.equal(f.state().unrelatedClicks, 0, "不得点击草稿区域以外的同名控件");
});
test("重新打开草稿的技能标签按完整技能ID核对，不能只比较显示文字", async () => {
  for (const wrongSkill of [false, true]) {
    const f = fixture({ existing: true, persistedCount: 0, present: [], richSkill: true, wrongSkill });
    const result = await f.api.resumeNativeDraftImport(f.options);
    assert.equal(result.ok, !wrongSkill, result.reason);
    if (!wrongSkill) assert.deepEqual(Array.from(result.missingNames), names);
  }
});
test("中断后卡片延迟挂载时等待原上传，不误判缺图重复上传", async () => {
  const f = fixture({ appearAt: 2000, readyAt: 5000 });
  const result = await f.api.resumeNativeDraftImport(f.options);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(Array.from(result.missingNames), []);
  assert.ok(f.state().elapsed >= 2000);
  assert.equal(f.state().clicks, 0); assert.equal(f.state().switched, null);
});

test("重开后原输入区已清空时立即提示恢复，不空等六十秒", async () => {
  const f = fixture({ interrupted: true, pending: "empty", present: [] });
  const result = await f.api.resumeNativeDraftImport(f.options);
  assert.equal(result.ok, false); assert.match(result.reason, /中断.*恢复/);
  assert.ok(f.state().elapsed < 3000); assert.equal(f.state().switched, null);
});

test("明确恢复中断导入时，完整存储和输入记录均无原编号才允许重新准备", async () => {
  const f = fixture({ interrupted: true, pending: "empty", present: [] });
  const result = await f.api.resumeNativeDraftImport({ ...f.options, recreateDeleted: true });
  assert.equal(result.ok, true, result.reason); assert.equal(result.restart, true);
  assert.equal(result.accountScope, "account-a"); assert.equal(f.state().switched, null);
});

test("恢复中断不能覆盖残留输入记录，未知存储或未知账号不能认定缺失", async () => {
  for (const options of [{pending:"target"}, {pending:"unknown"}, {pending:"attachments-only"}, {pending:"empty",catalogAvailable:false}, {pending:"empty",accountKnown:false}, {pending:"empty",changeAccountOnRead:true}]) {
    const f = fixture({ interrupted:true, present:[], ...options });
    const result = await f.api.resumeNativeDraftImport({ ...f.options, recreateDeleted:true });
    assert.equal(result.ok, false, JSON.stringify(options)); assert.notEqual(result.restart, true);
    assert.ok(f.state().elapsed < 3000); assert.equal(f.state().switched, null);
  }
});

test("中断后已保存完整的草稿直接确认原ID，不重新准备", async () => {
  const f = fixture({ existing:true, interrupted:true });
  const result = await f.api.resumeNativeDraftImport({ ...f.options, recreateDeleted:true });
  assert.equal(result.ok,true,result.reason); assert.equal(result.complete,true);
  assert.notEqual(result.restart,true); assert.equal(result.bindings[0].nativeId,"native");
  assert.equal(f.state().clicks,0); assert.equal(f.state().switched,null);
});
test("中断上传没有持久回执且图片不足时停止，不推断缺失再上传", async () => {
  const f = fixture({ present: names.slice(0, 2) });
  const result = await f.api.resumeNativeDraftImport(f.options);
  assert.equal(result.ok, false); assert.equal(f.state().switched, null);
});
test("当前已选中原草稿的图片延迟挂载时，也不误判缺图重传", async () => {
  const f = fixture({ existing: true, activeExisting: true, persistedCount: 0, appearAt: 2000, readyAt: 5000 });
  const result = await f.api.resumeNativeDraftImport(f.options);
  assert.equal(result.ok, true, result.reason); assert.deepEqual(Array.from(result.missingNames), []);
  assert.ok(f.state().elapsed >= 2000); assert.equal(f.state().clicks, 0);
});
test("同编号同正文但原生ID改变时，不重绑或宣告保存成功", async () => {
  for (const method of ["resumeNativeDraftImport", "saveNativeDraft"]) {
    const f = fixture({ existing: true });
    const result = await f.api[method]({ ...f.options, nativeId: "original-native" });
    assert.equal(result.ok, false, method); assert.match(result.reason, /ID/);
  }
});
test("已知原生ID的草稿已删除时，不进入新草稿续接或切页", async () => {
  const f = fixture();
  const result = await f.api.resumeNativeDraftImport({ ...f.options, nativeId: "original-native" });
  assert.equal(result.ok, false); assert.match(result.reason, /原草稿/);
  assert.equal(f.state().switched, null);
});

test("有原生ID的中断恢复也必须排除残留正文，不能只看草稿列表缺失",async()=>{
  for(const pending of ["empty","target"]){
    const f=fixture({interrupted:true,present:[],pending});
    const result=await f.api.resumeNativeDraftImport({...f.options,nativeId:"original-native",accountScope:"account-a",recreateDeleted:true});
    assert.equal(result.ok,pending==="empty",result.reason);
    if(pending==="empty")assert.equal(result.restart,true);else assert.match(result.reason,/输入记录/);
    assert.equal(f.state().switched,null);
  }
});
test("原草稿出现不属于本次任务的图片时停止，不追加或覆盖", async () => {
  const f = fixture({ existing: true, present: ["other.png"], persistedCount: 1 });
  const result = await f.api.resumeNativeDraftImport(f.options);
  assert.equal(result.ok, false); assert.match(result.reason, /顺序或名称/);
  assert.equal(f.state().switched, null);
});
test("等待图片期间取消后，即使上传完成也不会迟到切页", async () => {
  const f = fixture({ readyAt: 5000 }), pending = f.api.saveNativeDraft(f.options);
  await Promise.resolve(); f.api.cancelNativeDraftImport();
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.reason, /停止/);
  assert.equal(f.state().switched, null);
});
test("准备阶段已取消后，不再进入下一工作任务准备动作", async () => {
  const f = fixture(); let prepared = 0;
  f.api.prepareWorkTask = async () => { prepared++; return { ok: true }; };
  const pending = f.api.prepareNativeDraft({ executionMode: "work" });
  f.api.cancelNativeDraftImport();
  assert.equal((await pending).ok, false); assert.equal(prepared, 0);
});
