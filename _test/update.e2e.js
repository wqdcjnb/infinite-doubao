"use strict";

// Source-app UI test, isolated user data, local signed fixture; never executes a fixture installer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { CDP } = require("./cdp");

(async () => {
  const root = path.resolve(__dirname, "..");
  const current = require("../package.json").version;
  const latest = `${Number(current.split(".")[0]) + 1}.0.0`;
  const home = path.join(root, "build", "update-ui-userdata");
  fs.mkdirSync(home, { recursive: true });
  const key = fs.readFileSync(process.env.DOLAMOD_UPDATE_KEY || path.join(process.env.LOCALAPPDATA, "DoubaoWorkshopPublisher", "update-private.pem"));
  const body = Buffer.alloc(128 * 1024, 65);
  let mode = "available";
  const server = http.createServer((req, res) => {
    if (mode === "offline") { res.writeHead(503); return res.end(); }
    if (req.url === "/latest.json") {
      const m = { version: mode === "current" ? current : latest, platform: "win32", arch: "x64", notes: "测试更新：保留账号与任务", file: {
        url: "fixture.exe", size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") } };
      const signed = { ...m, sig: crypto.sign(null, Buffer.from(JSON.stringify(m)), key).toString("base64") };
      if (mode === "tampered") signed.notes = "tampered";
      return res.end(JSON.stringify(signed));
    }
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, DOLAMOD_UPDATE_URL: `http://127.0.0.1:${server.address().port}/latest.json` };
  delete env.ELECTRON_RUN_AS_NODE;
  process.env.DM_TEST_CDP_PORT = "9256";
  const runtime = process.env.DM_TEST_RUNTIME;
  if (!runtime) throw new Error("Set DM_TEST_RUNTIME to an Electron executable");
  const app = spawn(runtime, [root, `--user-data-dir=${home}`, "--remote-debugging-port=9256", "--remote-debugging-address=127.0.0.1"], { env, stdio: "ignore", windowsHide: true });
  let c;
  const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    for (let i = 0; i < 150 && !c; i++) { try { c = await CDP.attach(); } catch { await delay(); } }
    assert.ok(c, "source app starts");
    const wait = async (code) => { for (let i = 0; i < 150; i++) { if (await c.eval(code)) return; await delay(); } throw new Error("Timed out: " + code); };
    await wait("!!window.DMUpdates");
    assert.equal(path.resolve((await c.eval("DM.paths()")).home), home);
    await c.eval("document.querySelector('#btnUpdate').click()");
    await wait("document.querySelector('#updateAction').textContent === '下载更新'");
    assert.match(await c.eval("document.querySelector('#updateStatus').textContent"), /发现新版本/);
    await c.eval("document.querySelector('#updateAction').click(); document.querySelector('#updateAction').click()");
    await wait("document.querySelector('#updateAction').textContent === '安装并重启'");
    assert.match(await c.eval("document.querySelector('#updateStatus').textContent"), /校验通过/);
    await c.eval("document.querySelector('#updateClose').click(); document.querySelector('#btnUpdate').click()");
    await wait("document.querySelector('#updateDialog').open && document.querySelector('#updateAction').textContent === '安装并重启'");
    mode = "offline";
    await c.eval("document.querySelector('#updateRecheck').click()");
    await wait("document.querySelector('#updateStatus').textContent.includes('503')");
    mode = "tampered";
    await c.eval("document.querySelector('#updateAction').click()");
    await wait("document.querySelector('#updateStatus').textContent.includes('签名不匹配')");
    mode = "current";
    await c.eval("document.querySelector('#updateAction').click()");
    await wait("document.querySelector('#updateStatus').textContent === '已是最新版本'");
    assert.equal(await c.eval("getComputedStyle(document.querySelector('#updateRecheck')).display"), "none");
    const screenshot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(home, "update-ui.png"), Buffer.from(screenshot.data, "base64"));
    console.log("PASS update UI: discover, download, verify, duplicate click, reopen, offline retry, tamper rejection, up-to-date state");
  } finally {
    if (c) { try { await Promise.race([c.send("Browser.close"), new Promise((resolve) => setTimeout(resolve, 500))]); } catch {} c.close(); }
    app.kill();
    server.closeAllConnections(); server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
