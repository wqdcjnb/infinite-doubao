"use strict";
// Exercise the real packaged UI and hidden account pages against a local service.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { spawn } = require("node:child_process");
const { CDP, getJSON } = require("./cdp");
assert.ok(process.env.DM_TEST_HOME && process.env.DM_TEST_CDP_PORT, "Use an isolated profile and debugging port");
const home = path.resolve(process.env.DM_TEST_HOME), marker = path.join(home, "scale-fixture.json");
const count = Number(process.env.DM_TEST_BATCH_SIZE || 50), labelChars = Number(process.env.DM_TEST_LABEL_CHARS || 80);
const port = Number(process.env.DM_TEST_FIXTURE_PORT || 18856), accountId = "scale-fixture-account";
if (process.argv.includes("--prepare")) {
  assert.ok(!fs.existsSync(home), "Refuse to overwrite an existing profile");
  require("../src/paths").init({ home });
  const store = require("../src/store"), templates = require("../src/task-templates"), drafts = require("../src/task-drafts");
  store.load(); store.get().settings.server.enabled = false;
  store.get().settings.web = { enabled: false };
  Object.assign(store.get().settings.orchestrator, { maxParallel: 1, pollInterval: 1500, autoDownload: false, retryLimit: 0, taskTimeoutMs: 30000 });
  const account = store.add({ id: accountId, name: "50条草稿隔离测试", url: `http://127.0.0.1:${port}/chat` });
  const template = templates.create({ name: "相同提示词批量测试", prompt: "仅本地验证，不调用真实豆包生成", duration: 5 });
  const items = Array.from({ length: count }, () => drafts.create(template.id));
  const native = items.map((d, i) => ({ id: "native-" + i, prompt: `【草稿编号：${d.draftNumber}】\n编号仅用于识别。\n\n${template.prompt}`, mode: "云电脑", refs: i % 2 ? ["fixture-reference.png"] : [] }));
  const titles = native.map(d => d.prompt.slice(0, labelChars));
  items.forEach((d, i) => Object.assign(d, { instanceId: account.id, instanceName: account.name, nativeState: "saved", nativePrompt: native[i].prompt,
    nativeBinding: { id: d.id, index: i, title: titles[i], titles } }));
  store.save(); fs.writeFileSync(marker, JSON.stringify({ ids: items.map(d => d.id), native, labelChars }));
  console.log("Prepared", count, "drafts in", home);
} else {
  const fixture = JSON.parse(fs.readFileSync(marker, "utf8")), sent = [], receivedAt = [];
  let firstReceiptReleasedAt = 0;
  const stalled = process.env.DM_TEST_STALL_PAGE === "1";
  const delayedReceipts = Number(process.env.DM_TEST_DELAY_RECEIPTS || 0);
  let pageLoads = 0, peakPages = 0;
  const serviceState = { drafts: fixture.native, conversations: [], version: 0 };
  const indexed = process.env.DM_TEST_NATIVE_STORE === "1";
  const seed = `<script>if(!localStorage.getItem('fixture'))localStorage.setItem('fixture',${JSON.stringify(JSON.stringify({ drafts: fixture.native, conversations: [] }))});${indexed ? fs.readFileSync(path.join(__dirname, "native-drafts-indexeddb.js"), "utf8") : ""}</script>`;
  const html = fs.readFileSync(path.join(__dirname, "native-drafts-fixture.html"), "utf8")
    .replace("<script>", seed + "<script>").replace("d.prompt.slice(0,8)", `d.prompt.slice(0,${fixture.labelChars})`)
    // Real drafts are stored atomically by the service. Do not let concurrent
    // fixture pages overwrite one another with stale localStorage snapshots.
    .replace("localStorage.setItem('fixture',JSON.stringify(saved));", "if((saved.version||0)>=(JSON.parse(localStorage.getItem('fixture')||'{}').version||0))localStorage.setItem('fixture',JSON.stringify(saved));")
    .replace("saved=JSON.parse(e.newValue);render();", "const next=JSON.parse(e.newValue);if((next.version||0)>=(saved.version||0)){saved=next;render();}")
    .replace("saved=JSON.parse(localStorage.getItem('fixture'));saved.drafts=saved.drafts.filter(d=>d.id!==current);const c={...payload,...result};saved.conversations.unshift(c);persist();", "if(result.delayed)while(!await(await fetch('/receipt-ready')).json())await new Promise(r=>setTimeout(r,200));const c={...payload,...result};saved=result.state;persist();");
  const server = http.createServer((req, res) => {
    if (stalled && req.url === "/chat/" && ++pageLoads === 1) return;
    if (req.url === "/receipt-ready") {
      const ready = sent.length === fixture.ids.length;
      if (ready && !firstReceiptReleasedAt) firstReceiptReleasedAt = Date.now();
      res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(ready));
    }
    if (req.url === "/result-ready") { res.setHeader("Content-Type", "application/json"); return res.end("false"); }
    if (req.url === "/submit") {
      let body = ""; req.on("data", c => body += c); req.on("end", () => {
        const payload = JSON.parse(body);
        sent.push(payload); receivedAt.push(Date.now()); const id = 20000 + sent.length;
        setTimeout(() => {
          serviceState.drafts = serviceState.drafts.filter(d => d.prompt !== payload.prompt);
          const conversation = { ...payload, id: String(id), url: "/generated.mp4" };
          serviceState.conversations.unshift(conversation); serviceState.version++;
          res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ...conversation, state: serviceState, delayed: id - 20000 <= delayedReceipts }));
        }, 150);
      }); return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "sessionid=scale-fixture-only; Path=/" }); res.end(html);
  });
  (async () => {
    await new Promise(r => server.listen(port, "127.0.0.1", r));
    let child, c;
    const pause = ms => new Promise(r => setTimeout(r, ms));
    if (process.env.DM_TEST_RUNTIME) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(process.env.DM_TEST_RUNTIME, [`--user-data-dir=${home}`, `--remote-debugging-port=${process.env.DM_TEST_CDP_PORT}`, "--remote-debugging-address=127.0.0.1"], { env, stdio: "ignore", windowsHide: true });
    }
    for (let n = 0; n < 150 && !c; n++) { try { c = await CDP.attach(); } catch { await pause(100); } }
    if (!c) { child?.kill(); throw new Error("Isolated test app did not open"); }
    const started = Date.now();
    const report = { count: fixture.ids.length, labelChars: fixture.labelChars, indexedDraftStore: indexed, initialVisibleDrafts: indexed ? 5 : fixture.ids.length, samples: [] };
    try {
      for (let i = 0; i < 100 && !await c.eval("document.readyState === 'complete' && typeof state !== 'undefined' && state.accounts.length === 1"); i++) await pause(100);
      assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
      await c.eval("document.querySelector('[data-view=\"drafts\"]').click()");
      for (let i = 0; i < 100 && !await c.eval(`document.querySelector('#draftAccount').options.length > 1 && document.querySelector('#draftCount').textContent === '${fixture.ids.length}' && !document.querySelector('#draftSelectAll').disabled`); i++) await pause(100);
      await c.eval(`(()=>{const e=document.querySelector('#draftAccount');e.value=${JSON.stringify(accountId)};e.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#draftSelectAll').click();})()`);
      assert.equal(await c.eval("document.querySelector('#draftSubmit').disabled"), false, await c.eval("document.querySelector('#draftStatus').textContent + ' ' + document.querySelector('#draftSelection').textContent"));
      await c.eval("document.querySelector('#draftSubmit').click()");
      let completed = false;
      for (let i = 0; i < 180; i++) {
        await pause(1000);
        const state = await c.eval("({message:document.querySelector('#draftStatus').textContent,busy:document.querySelector('#draftAccount').disabled})");
        const sample = { seconds: Math.round((Date.now() - started) / 1000), ...state, sent: sent.length, pages: (await getJSON('/json/list')).filter(p => p.url.startsWith(`http://127.0.0.1:${port}`)).length };
        report.samples.push(sample); peakPages = Math.max(peakPages, sample.pages);
        if (i % 5 === 0) console.log(JSON.stringify(sample));
        if (!state.busy) { completed = true; break; }
      }
      report.sent = sent.length; report.elapsedMs = Date.now() - started;
      report.spreadMs = receivedAt.length ? Math.max(...receivedAt) - Math.min(...receivedAt) : null;
      report.dispatchMs = receivedAt.length ? Math.max(...receivedAt) - started : null;
      report.allSentBeforeReceipts = delayedReceipts === fixture.ids.length && firstReceiptReleasedAt >= Math.max(...receivedAt);
      report.completed = completed;
      report.peakPages = peakPages;
      const finalStore = JSON.parse(fs.readFileSync(path.join(home, "store.json"), "utf8"));
      report.confirmed = finalStore.tasks.length;
      report.remaining = finalStore.taskDrafts.map(d => ({ id: d.id, error: d.nativeError, uncertain: !!d.submissionRecord?.task.submissionUncertain }));
      report.logs = (await c.eval("DM.call('dm:logs',30)")).data;
      fs.writeFileSync(path.join(home, "scale-result.png"), Buffer.from((await c.send("Page.captureScreenshot")).data, "base64"));
      fs.writeFileSync(path.join(home, "scale-result.json"), JSON.stringify(report, null, 2));
      if (stalled) {
        assert.equal(sent.length, fixture.ids.length - 1); assert.equal(completed, true); assert.ok(report.elapsedMs < 85000);
        assert.match(report.samples.at(-1).message, /超时/);
        assert.equal(report.samples.at(-1).pages, 1, "Timed-out hidden pages must close");
        assert.equal(report.remaining.length, 1); assert.equal(report.remaining[0].uncertain, false);
        console.log("PASS: stalled page times out, subsequent drafts still sent, failed draft retained", report.elapsedMs); return;
      }
      assert.equal(sent.length, fixture.ids.length, "Every selected draft must be dispatched");
      assert.ok(report.samples.some(s => s.sent > 4 && /已发起 \d+\//.test(s.message)), "Submission progress remains visible");
      assert.equal(new Set(sent.map(s => s.prompt.match(/^【草稿编号：([^】]+)】/)[1])).size, fixture.ids.length);
      assert.ok(sent.every(s => s.mode === "云电脑"));
      if (delayedReceipts) {
        assert.equal(report.confirmed + report.remaining.length, fixture.ids.length);
        assert.ok(report.remaining.length <= delayedReceipts);
        assert.ok(report.remaining.every(d => d.uncertain && /接收结果未确认/.test(d.error)));
      } else assert.equal(report.confirmed, fixture.ids.length);
      if (delayedReceipts === fixture.ids.length) assert.equal(report.allSentBeforeReceipts, true, "all 50 dispatches precede every receipt");
      if (process.env.DM_TEST_MAX_DISPATCH_MS) {
        assert.ok(report.dispatchMs < Number(process.env.DM_TEST_MAX_DISPATCH_MS), `Dispatch too slow: ${report.dispatchMs}ms`);
        assert.equal(report.confirmed, fixture.ids.length, "all receipts arrive within their independent timeouts");
      }
      assert.equal(completed, true, "Operation must finish");
      console.log("PASS", JSON.stringify({ count: report.sent, elapsedMs: report.elapsedMs, spreadMs: report.spreadMs }));
    } finally {
      await Promise.race([c.eval("window.close()").catch(() => {}), pause(1500)]); c.close(); child?.kill(); server.closeAllConnections(); server.close();
    }
  })().catch(error => { console.error(error); server.closeAllConnections(); server.close(); process.exitCode = 1; });
}
