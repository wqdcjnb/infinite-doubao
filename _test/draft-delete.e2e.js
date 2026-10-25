"use strict";

// Prepare a fresh profile, then run against an isolated application using that profile.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { CDP } = require("./cdp");
if (!process.env.DM_TEST_HOME) throw new Error("Set DM_TEST_HOME to a dedicated empty test directory");
const home = path.resolve(process.env.DM_TEST_HOME);
const marker = path.join(home, "draft-delete-fixture.json");

if (process.argv.includes("--prepare")) {
  assert.ok(!fs.existsSync(home), "Refuse to overwrite an existing profile");
  require("../src/paths").init({ home });
  const store = require("../src/store"), templates = require("../src/task-templates"), drafts = require("../src/task-drafts");
  store.load(); store.get().settings.server.enabled = false;
  const template = templates.create({ name: "批量删除验收", prompt: "仅在本地验证草稿删除，不提交视频生成" });
  const items = Array.from({ length: 3 }, () => drafts.create(template.id));
  delete items[0].draftNumber; items[0].executionMode = "video";
  items[1].nativeState = "saved"; items[1].instanceId = "old-account";
  store.save();
  fs.writeFileSync(marker, JSON.stringify({ ids: items.map(d => d.id), templateId: template.id }));
  console.log("Prepared isolated draft deletion profile:", home);
} else {
  (async () => {
    assert.ok(process.env.DM_TEST_CDP_PORT, "Use an explicit test debugging port");
    const fixture = JSON.parse(fs.readFileSync(marker, "utf8"));
    const c = await CDP.attach();
    try {
      const wait = async (expression) => {
        for (let n = 0; n < 100; n++) { if (await c.eval(expression)) return; await new Promise(r => setTimeout(r, 100)); }
        throw new Error("UI did not settle: " + expression);
      };
      const click = selector => c.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
      const read = () => JSON.parse(fs.readFileSync(path.join(home, "store.json"), "utf8"));
      assert.equal(path.resolve((await c.eval("DM.paths()")).home), home, "Refuse to touch real user data");
      assert.deepEqual(read().taskDrafts.map(d => d.id), fixture.ids);
      await click('[data-view="drafts"]');
      await wait("document.querySelectorAll('.draft-row').length === 3");
      assert.equal(await c.eval("document.querySelectorAll('.draft-info[open]').length"), 0);
      assert.equal(await c.eval("document.querySelector('.draft-info p').checkVisibility()"), false);
      assert.equal(await c.eval("document.querySelectorAll('.draft-info summary strong').length"), 3);
      assert.equal(await c.eval("document.querySelectorAll('.draft-info summary .draft-number').length"), 3);
      fs.writeFileSync(path.join(home, "drafts-collapsed.png"), Buffer.from((await c.send("Page.captureScreenshot")).data, "base64"));
      await click(".draft-info summary");
      await wait("document.querySelector('.draft-info p').checkVisibility()");
      await click(".draft-info summary");
      await wait("!document.querySelector('.draft-info p').checkVisibility()");
      assert.equal(await c.eval("document.querySelector('#draftDelete').disabled"), true);
      await c.eval("document.querySelectorAll('.draft-row input')[0].click(); document.querySelectorAll('.draft-row input')[1].click()");
      assert.equal(await c.eval("document.querySelector('#draftAccount').value"), "");
      assert.equal(await c.eval("document.querySelector('#draftDelete').disabled"), false, "Deletion needs no account");
      await click("#draftDelete");
      await wait("document.querySelector('#confirmDialog')?.open");
      assert.match(await c.eval("document.querySelector('#confirmTitle').textContent"), /2 条/);
      assert.match(await c.eval("document.querySelector('.confirm-detail').textContent"), /豆包网页.*保留/);
      await click("#confirmCancel"); assert.equal(read().taskDrafts.length, 3);
      await click("#draftDelete");
      fs.writeFileSync(path.join(home, "draft-delete-confirm.png"), Buffer.from((await c.send("Page.captureScreenshot")).data, "base64"));
      await click("#confirmAccept");
      await wait("document.querySelectorAll('.draft-row').length === 1");
      assert.deepEqual(read().taskDrafts.map(d => d.id), [fixture.ids[2]]);
      assert.ok(read().taskTemplates.some(t => t.id === fixture.templateId));
      assert.equal(read().tasks.length, 0);
      await c.send("Page.reload");
      await wait("!!window.DM && !!document.querySelector('[data-view=drafts]')");
      await click('[data-view="drafts"]');
      await wait("document.querySelectorAll('.draft-row').length === 1");
      await click("#draftSelectAll"); await click("#draftDelete"); await click("#confirmAccept");
      await wait("document.querySelectorAll('.draft-row').length === 0 && document.querySelector('#draftDelete').disabled");
      assert.equal(read().taskDrafts.length, 0);
      assert.equal(await c.eval("document.querySelector('#draftSelectAll').checked"), false);
      fs.writeFileSync(path.join(home, "draft-delete-empty.png"), Buffer.from((await c.send("Page.captureScreenshot")).data, "base64"));
      console.log("PASS: collapsed title/number, expand/collapse, old and saved records, selection without account, cancel, partial deletion, reload, select all, empty state");
    } finally { c.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
