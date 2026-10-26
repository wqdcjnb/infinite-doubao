"use strict";
const { test, after } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const P = require("../src/paths"), store = require("../src/store"), drafts = require("../src/task-drafts"), templates = require("../src/task-templates"), queue = require("../src/orchestrator");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-import-attachments-"));
after(() => { queue.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
async function setup(name) {
  P.init({ home: path.join(root, name) }); store.load(); const inst = store.add({ name: "导入账号" });
  const item = templates.create({ name: "五图模板", prompt: "只保存草稿", model: "seedance_v2.0_mini", duration: 5 });
  for (let i = 1; i <= 5; i++) { const file = path.join(root, `${i}.png`); fs.writeFileSync(file, Buffer.from([137,80,78,71])); await templates.importAttachments(item.id, [file]); }
  const ids = [drafts.create(item.id).id, drafts.create(item.id).id], files = drafts.list()[0].template.attachments.map(a => a.path), calls = [];
  let resume = { ok: true, complete: true, missingNames: [] }, restore = { ok: true }, preparedScope = "account-a", saveFailure = false, cancel;
  const binding = id => ({ id, nativeId: "native-" + id, accountScope: "account-a", title: id, index: 0, titles: [id] });
  const driver = { isLoggedIn: async () => ({ loggedIn: true }),
    setText: async text => { calls.push({ method: "text", text }); return { ok: true }; },
    pasteFiles: async (files, options) => { calls.push({ method: "upload", files, options }); return { ok: true }; },
    call: async (method, options) => {
      calls.push({ method, options });
      if (method === "resumeNativeDraftImport") return { bindings: resume.restart ? [] : [binding(options.id)], ...resume };
      if (method === "restoreNativeDrafts") return typeof restore === "function" ? restore(options) : restore;
      if (method === "saveNativeDraft") return (typeof saveFailure === "function" ? saveFailure(options.id) : saveFailure) ? { ok: false, reason: "附件未完成" } : { ok: true, bindings: [binding(options.id)] };
      if (method === "cancelNativeDraftImport") cancel = true;
      if (method === "prepareNativeDraft") return { ok: true, accountScope: preparedScope };
      return { ok: true };
    }
  };
  queue.init({ resolveDriver: async () => driver, resolveDraftDriver: null });
  return { inst, ids, files, calls, binding, driver, setResume: value => { resume = value; }, setRestore: value => { restore = value; }, setPreparedScope: value => { preparedScope=value; }, failSave: (value = true) => { saveFailure = value; }, cancelled: () => cancel };
}

test("单条失败关闭独立页后继续下一条，保留错误且不误报整批成功", async () => {
  const f = await setup("skip-one"), order = [];
  f.failSave(id => id === f.ids[0]);
  queue.init({ resolveDraftDriver: async (_inst, { signal }) => {
    const page = order.filter(x => x.startsWith("open")).length;
    order.push("open-" + page);
    const close = () => { if (!order.includes("close-" + page)) order.push("close-" + page); };
    signal.addEventListener("abort", close, { once: true });
    return { ...f.driver, close };
  } });
  const result = await queue.saveDrafts(f.ids, { instanceId: f.inst.id });
  assert.equal(result.count, 1); assert.equal(result.failed, 1); assert.equal(result.total, 2);
  assert.deepEqual(order, ["open-0", "close-0", "open-1", "close-1"]);
  assert.equal(result.errors[0].id, f.ids[0]); assert.match(result.errors[0].message, /附件/);
  assert.equal(drafts.list()[0].nativeState, "saving"); assert.match(drafts.list()[0].nativeError, /附件/);
  assert.equal(drafts.list()[1].nativeState, "saved");
  assert.equal(f.calls.filter(c => c.method === "upload").length, 2);
  assert.ok(f.calls.filter(c => c.method === "upload").every(c => c.options?.prompt && c.options?.attachmentNames.length === 5));
});

test("单条本地附件丢失只跳过该条，其余草稿正常导入", async () => {
  const f = await setup("skip-missing");
  drafts.updateMany({ [f.ids[0]]: { template: { ...drafts.list()[0].template, attachments: [{ name: "丢失图片.png", path: path.join(root, "absent.png") }] } } });
  const result = await queue.saveDrafts(f.ids, { instanceId: f.inst.id });
  assert.equal(result.count, 1); assert.equal(result.failed, 1);
  assert.match(result.errors[0].message, /附件/);
  assert.equal(drafts.list()[1].nativeState, "saved"); assert.equal(drafts.list()[0].nativeState, undefined);
});

test("无图且已标记保存的草稿也须重新核对网页完整内容", async () => {
  const f = await setup("verify-no-image"), id = f.ids[0];
  drafts.updateMany({ [id]: { template: { ...drafts.list()[0].template, attachments: [] }, nativeState: "saved", instanceId: f.inst.id, nativePrompt: "原正文", nativeBinding: f.binding(id) } });
  f.setResume({ ok: false, reason: "网页正文已变化" });
  const result = await queue.saveDrafts([id], { instanceId: f.inst.id });
  assert.equal(result.count, 0); assert.equal(result.failed, 1);
  assert.equal(drafts.list()[0].nativeState, "saving"); assert.match(drafts.list()[0].nativeError, /正文/);
});

test("独立页登录界面尚在加载时等待就绪，不把短暂未知当作导入失败", async () => {
  const f = await setup("wait-import-login"); let waited = 0;
  queue.init({ resolveDraftDriver: async () => ({ ...f.driver, isLoggedIn: async () => ({ loggedIn: false, by: "unknown" }), waitForLogin: async () => { waited++; return { loggedIn: true }; }, close() {} }) });
  const result = await queue.saveDrafts([f.ids[0]], { instanceId: f.inst.id });
  assert.equal(result.count, 1); assert.equal(waited, 1);
});

test("旧版无编号草稿失败恢复和补图不能写入网页不存在的新编号", async () => {
  const f = await setup("legacy-no-number"), id = f.ids[0];
  drafts.updateMany({ [id]: { draftNumber: undefined, nativeState: "saving", instanceId: f.inst.id, nativePrompt: "旧版无编号完整正文", nativeBinding: f.binding(id) } });
  f.setRestore(bindings => bindings.some(b => b.draftNumber) ? { ok: false, reason: "网页不存在这个编号" } : { ok: true });
  f.setResume({ ok: true, complete: false, missingNames: f.files.slice(4).map(p=>path.basename(p)) });
  const result = await queue.saveDrafts([id], { instanceId: f.inst.id });
  assert.equal(result.count, 1, JSON.stringify(result)); assert.equal(drafts.list()[0].draftNumber, undefined);
  assert.equal(f.calls.find(c=>c.method==="text").text, "旧版无编号完整正文");
  f.setResume({ ok: true, complete: true, missingNames: [] });
  assert.equal((await queue.saveDrafts([id], { instanceId: f.inst.id })).count, 1);
});

test("后台导入页先激活输入焦点，才准备正文和图片；不依赖主窗口前台状态", async () => {
  const f = await setup("background-input-focus"); let focused = false, attached = false;
  const driver = new (require("../src/driver").Driver)({ instance: f.inst, webContents: { debugger: {
    isAttached: () => attached, attach() { attached = true; }, async sendCommand(method, value) {
      if (method === "Emulation.setFocusEmulationEnabled") focused = value.enabled;
    }
  } } });
  queue.init({ resolveDraftDriver: async () => ({ ...f.driver, prepareDraftImport: (...args) => driver.prepareDraftImport(...args), waitForLogin: async () => ({ loggedIn: focused }), close() {} }) });
  const result = await queue.saveDrafts([f.ids[0]], { instanceId: f.inst.id });
  assert.equal(result.count, 1, JSON.stringify(result)); assert.equal(focused, true);
});
test("导入传递完整附件清单，图片保存未确认时逐条记录失败", async () => {
  const f = await setup("fresh"); f.failSave();
  const result = await queue.saveDrafts(f.ids, { instanceId: f.inst.id });
  assert.equal(result.count, 0); assert.equal(result.failed, 2);
  assert.deepEqual(f.calls.find(c => c.method === "saveNativeDraft").options.attachmentNames, f.files.map(p => path.basename(p)));
  assert.equal(f.calls.filter(c => c.method === "prepareNativeDraft").length, 2);
  assert.ok(drafts.list().every(d => d.nativeState === "saving" && /附件/.test(d.nativeError)));
  assert.equal(f.calls.some(c => /send|confirm/i.test(c.method)), false); assert.equal(f.cancelled(), true);
});
test("已标记保存但缺图时在原草稿只补缺失附件，完整草稿不重复上传", async () => {
  const f = await setup("resume"), id = f.ids[0];
  drafts.updateMany({ [id]: { nativeState: "saved", instanceId: f.inst.id, nativePrompt: "原正文", nativeBinding: f.binding(id) } });
  f.setResume({ ok: true, complete: false, missingNames: f.files.slice(2).map(p => path.basename(p)) });
  assert.equal((await queue.saveDrafts([id], { instanceId: f.inst.id })).count, 1);
  assert.deepEqual(f.calls.find(c => c.method === "upload").files, f.files.slice(2));
  assert.equal(f.calls.some(c => c.method === "prepareNativeDraft"), false);
  assert.equal(drafts.list()[0].nativeBinding.nativeId, "native-" + id);
  f.calls.length = 0; f.setResume({ ok: true, complete: true, missingNames: [] });
  assert.equal((await queue.saveDrafts([id], { instanceId: f.inst.id })).count, 1);
  assert.equal(f.calls.some(c => ["upload", "text", "saveNativeDraft", "prepareNativeDraft"].includes(c.method)), false);
});

test("用户恢复中断导入后只重建已确认缺失的条目，并保留原编号正文继续剩余条目", async () => {
  const f=await setup("interrupted"), id=f.ids[0], prompt="原编号原正文";
  drafts.updateMany({[id]:{nativeState:"saving",instanceId:f.inst.id,nativePrompt:prompt}});
  f.setResume({ok:true,restart:true,accountScope:"account-a"});
  assert.equal((await queue.saveDrafts(f.ids,{instanceId:f.inst.id,recreateDeleted:true})).count,2);
  assert.equal(f.calls.find(c=>c.method==="resumeNativeDraftImport").options.recreateDeleted,true);
  assert.equal(f.calls.filter(c=>c.method==="prepareNativeDraft").length,2);
  assert.equal(f.calls.find(c=>c.method==="text").text,prompt);
  assert.equal(f.calls.filter(c=>c.method==="upload").length,2);
  assert.equal(f.calls.some(c=>/send|confirm/i.test(c.method)),false);
  assert.ok(drafts.list().every(d=>d.nativeState==="saved"));
});

test("普通核对不能接受重新新建建议，核对失败时保留保存中状态", async () => {
  const f=await setup("interrupted-unknown"),id=f.ids[0];
  drafts.updateMany({[id]:{nativeState:"saving",instanceId:f.inst.id,nativePrompt:"原正文"}});
  f.setResume({ok:true,restart:true,accountScope:"account-a"});
  const result = await queue.saveDrafts([id],{instanceId:f.inst.id});
  assert.equal(result.failed,1); assert.match(result.errors[0].message,/恢复|确认|重复/);
  assert.equal(drafts.list()[0].nativeState,"saving");
  assert.equal(f.calls.some(c=>["text","upload","prepareNativeDraft"].includes(c.method)),false);
});

test("补图中断后原生草稿确已删除时，明确恢复仍保留原正文和编号", async () => {
  const f=await setup("interrupted-bound"),id=f.ids[0],prompt="不重新拼接的原正文";
  drafts.updateMany({[id]:{nativeState:"saving",instanceId:f.inst.id,nativePrompt:prompt,nativeBinding:f.binding(id)}});
  f.setRestore({ok:true,missingIds:[id]});f.setResume({ok:true,restart:true,accountScope:"account-a"});
  assert.equal((await queue.saveDrafts([id],{instanceId:f.inst.id,recreateDeleted:true})).count,1);
  assert.equal(f.calls.find(c=>c.method==="text").text,prompt);
  assert.equal(f.calls.filter(c=>c.method==="prepareNativeDraft").length,1);
  assert.equal(f.calls.some(c=>c.method==="resumeNativeDraftImport"),true);
});

test("有原生ID的中断条目若残留输入记录，恢复失败仍保留原关联",async()=>{
  const f=await setup("interrupted-bound-unknown"),id=f.ids[0],binding=f.binding(id);
  drafts.updateMany({[id]:{nativeState:"saving",instanceId:f.inst.id,nativePrompt:"原正文",nativeBinding:binding}});
  f.setRestore({ok:true,missingIds:[id]});f.setResume({ok:false,reason:"原草稿仍保留在网页输入记录中"});
  const result = await queue.saveDrafts([id],{instanceId:f.inst.id,recreateDeleted:true});
  assert.equal(result.failed,1); assert.match(result.errors[0].message,/输入记录/);
  assert.deepEqual(drafts.list()[0].nativeBinding,binding);
  assert.equal(f.calls.some(c=>["prepareNativeDraft","upload","text"].includes(c.method)),false);
});

test("重新准备时账号变化仍保留原关联，不能下次按无绑定恢复",async()=>{
  const f=await setup("interrupted-account-changed"),id=f.ids[0],binding=f.binding(id);
  drafts.updateMany({[id]:{nativeState:"saving",instanceId:f.inst.id,nativePrompt:"原正文",nativeBinding:binding}});
  f.setRestore({ok:true,missingIds:[id]});f.setResume({ok:true,restart:true,accountScope:"account-a"});f.setPreparedScope("account-b");
  const result = await queue.saveDrafts([id],{instanceId:f.inst.id,recreateDeleted:true});
  assert.equal(result.failed,1); assert.match(result.errors[0].message,/账号已变化/);
  assert.deepEqual(drafts.list()[0].nativeBinding,binding);
  assert.equal(f.calls.some(c=>["upload","text"].includes(c.method)),false);
});
