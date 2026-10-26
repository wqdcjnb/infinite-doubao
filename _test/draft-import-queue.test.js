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
  let resume = { ok: true, complete: true, missingNames: [] }, saveFailure = false, cancel;
  const binding = id => ({ id, nativeId: "native-" + id, accountScope: "account-a", title: id, index: 0, titles: [id] });
  const driver = { isLoggedIn: async () => ({ loggedIn: true }),
    setText: async text => { calls.push({ method: "text", text }); return { ok: true }; },
    pasteFiles: async files => { calls.push({ method: "upload", files }); return { ok: true }; },
    call: async (method, options) => {
      calls.push({ method, options });
      if (method === "resumeNativeDraftImport") return { ...resume, bindings: [binding(options.id)] };
      if (method === "saveNativeDraft") return saveFailure ? { ok: false, reason: "附件未完成" } : { ok: true, bindings: [binding(options.id)] };
      if (method === "cancelNativeDraftImport") cancel = true;
      return { ok: true };
    }
  };
  queue.init({ resolveDriver: async () => driver });
  return { inst, ids, files, calls, binding, setResume: value => { resume = value; }, failSave: () => { saveFailure = true; }, cancelled: () => cancel };
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
