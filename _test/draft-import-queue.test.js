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
    pasteFiles: async files => { calls.push({ method: "upload", files }); return { ok: true }; },
    call: async (method, options) => {
      calls.push({ method, options });
      if (method === "resumeNativeDraftImport") return { bindings: resume.restart ? [] : [binding(options.id)], ...resume };
      if (method === "restoreNativeDrafts") return restore;
      if (method === "saveNativeDraft") return saveFailure ? { ok: false, reason: "附件未完成" } : { ok: true, bindings: [binding(options.id)] };
      if (method === "cancelNativeDraftImport") cancel = true;
      if (method === "prepareNativeDraft") return { ok: true, accountScope: preparedScope };
      return { ok: true };
    }
  };
  queue.init({ resolveDriver: async () => driver });
  return { inst, ids, files, calls, binding, setResume: value => { resume = value; }, setRestore: value => { restore = value; }, setPreparedScope: value => { preparedScope=value; }, failSave: () => { saveFailure = true; }, cancelled: () => cancel };
}
test("导入传递完整附件清单，图片保存未确认时不开始下一条", async () => {
  const f = await setup("fresh"); f.failSave();
  await assert.rejects(queue.saveDrafts(f.ids, { instanceId: f.inst.id }), /附件/);
  assert.deepEqual(f.calls.find(c => c.method === "saveNativeDraft").options.attachmentNames, f.files.map(p => path.basename(p)));
  assert.equal(f.calls.filter(c => c.method === "prepareNativeDraft").length, 1);
  assert.equal(drafts.list()[0].nativeState, "saving"); assert.equal(drafts.list()[1].nativeState, undefined);
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
  await assert.rejects(queue.saveDrafts([id],{instanceId:f.inst.id}),/恢复|确认|重复/);
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
  await assert.rejects(queue.saveDrafts([id],{instanceId:f.inst.id,recreateDeleted:true}),/输入记录/);
  assert.deepEqual(drafts.list()[0].nativeBinding,binding);
  assert.equal(f.calls.some(c=>["prepareNativeDraft","upload","text"].includes(c.method)),false);
});

test("重新准备时账号变化仍保留原关联，不能下次按无绑定恢复",async()=>{
  const f=await setup("interrupted-account-changed"),id=f.ids[0],binding=f.binding(id);
  drafts.updateMany({[id]:{nativeState:"saving",instanceId:f.inst.id,nativePrompt:"原正文",nativeBinding:binding}});
  f.setRestore({ok:true,missingIds:[id]});f.setResume({ok:true,restart:true,accountScope:"account-a"});f.setPreparedScope("account-b");
  await assert.rejects(queue.saveDrafts([id],{instanceId:f.inst.id,recreateDeleted:true}),/账号已变化/);
  assert.deepEqual(drafts.list()[0].nativeBinding,binding);
  assert.equal(f.calls.some(c=>["upload","text"].includes(c.method)),false);
});
