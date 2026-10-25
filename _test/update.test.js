"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { check, createUpdater, cmpVersion } = require("../src/update");
const { createServer } = require("../build/update-server.cjs");
const { activate } = require("../build/activate-update.cjs");

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-updater-"));
  const keys = crypto.generateKeyPairSync("ed25519");
  const body = Buffer.from("MZ-test-installer-bytes");
  const f = { dir, body, manifest: null, requests: 0, status: 200, delay: 0 };
  f.sign = (patch = {}) => {
    const m = { version: "1.3.0", platform: "win32", arch: "x64", notes: "测试版本", file: {
      url: "DoubaoWorkshop-1.3.0-Setup.exe", size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") }, ...patch };
    return { ...m, sig: crypto.sign(null, Buffer.from(JSON.stringify(m)), keys.privateKey).toString("base64") };
  };
  f.manifest = f.sign();
  const server = http.createServer((req, res) => {
    const send = () => {
      res.writeHead(f.status);
      if (req.url === "/latest.json") res.end(JSON.stringify(f.manifest));
      else { f.requests++; res.end(f.body); }
    };
    if (f.delay) setTimeout(send, f.delay); else send();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  f.opts = { platform: "win32", arch: "x64", url: `http://127.0.0.1:${server.address().port}/latest.json`, publicKey: keys.publicKey, currentVersion: "1.2.3", downloadDir: path.join(dir, "updates") };
  fs.writeFileSync(path.join(dir, "update-public-key.pem"), keys.publicKey.export({ type: "spki", format: "pem" }));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}

test("签名版本信息支持相对安装包地址和正确的版本排序", async (t) => {
  const f = await fixture(t);
  const info = await check(f.opts);
  assert.equal(info.ok, true); assert.equal(info.hasUpdate, true);
  assert.match(info.file.url, /^http:\/\/127.0.0.1:\d+\/DoubaoWorkshop-1.3.0-Setup.exe$/);
  assert.equal(cmpVersion("1.10.0", "1.9.9"), 1);
  for (const currentVersion of ["1.3.0", "2.0.0"]) assert.equal((await check({ ...f.opts, currentVersion })).hasUpdate, false);
});

test("可选组件与安装包一同校验发布，损坏组件不会更新清单，服务只开放合法组件文件", async t => {
  const f = await fixture(t);
  const stage = path.join(f.dir, "incoming"); fs.mkdirSync(stage);
  const data = Buffer.from("optional media tools");
  const components = { url: "DoubaoWorkshop-MediaTools-1.3.0-win32-x64.tar.gz", size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
  fs.writeFileSync(path.join(stage, "latest.json"), JSON.stringify(f.sign({ components })));
  fs.writeFileSync(path.join(stage, f.manifest.file.url), f.body);
  fs.writeFileSync(path.join(stage, components.url), "broken");
  await assert.rejects(activate(f.dir, stage), /checksum/);
  assert.equal(fs.existsSync(path.join(f.dir, "public", "latest.json")), false);
  fs.writeFileSync(path.join(stage, components.url), data);
  await activate(f.dir, stage);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, "public", components.url)), data);
  const server = createServer(path.join(f.dir, "public"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    assert.equal((await fetch(base + components.url)).status, 200);
    assert.equal((await fetch(base + "arbitrary.tar.gz")).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("篡改、无签名、无哈希、错误平台和非法版本被拒绝", async (t) => {
  const f = await fixture(t);
  for (const manifest of [ { ...f.sign(), notes: "篡改" }, { ...f.sign(), sig: "" },
    f.sign({ file: { url: "bad.exe", size: 1 } }), f.sign({ platform: "darwin" }), f.sign({ version: "../1.3.0" }),
    f.sign({ file: { ...f.sign().file, url: "file:///C:/bad.exe" } }) ]) {
    f.manifest = manifest; assert.equal((await check(f.opts)).ok, false);
  }
});

test("服务器离线、HTTP错误和超时明确报告失败", async (t) => {
  const f = await fixture(t);
  f.status = 503;
  assert.match((await check(f.opts)).reason, /503/);
  f.delay = 100;
  assert.match((await check({ ...f.opts, timeoutMs: 10 })).reason, /超时/);
  assert.equal((await check({ ...f.opts, url: "http://127.0.0.1:1/latest.json" })).ok, false);
});

test("下载报告进度、复用已验证文件，并只启动主进程保存的安装路径", async (t) => {
  const f = await fixture(t), updater = createUpdater(f.opts);
  const states = []; updater.events.on("change", (s) => states.push(s));
  assert.equal((await updater.check()).phase, "available");
  assert.equal((await updater.download()).phase, "ready");
  assert.ok(states.some((s) => s.phase === "downloading" && s.received === f.body.length));
  await updater.check(); await updater.download(); assert.equal(f.requests, 1);
  let launched = "";
  assert.equal((await updater.install(async (file) => { launched = file; })).phase, "installing");
  assert.equal(launched, path.join(f.opts.downloadDir, "DoubaoWorkshop-1.3.0-Setup.exe"));
  assert.deepEqual(fs.readFileSync(launched), f.body);
  assert.ok(!Object.hasOwn(updater.status(), "file"));
});

test("重复点击检查或下载不会启动第二份下载", async (t) => {
  const f = await fixture(t), updater = createUpdater(f.opts);
  await updater.check(); f.delay = 30;
  const first = updater.download();
  assert.equal((await updater.download()).phase, "downloading");
  assert.equal((await updater.check()).phase, "downloading");
  await first; assert.equal(f.requests, 1);
});

test("无新版本时禁止下载和安装，不能通过参数注入安装包", async (t) => {
  const f = await fixture(t), updater = createUpdater({ ...f.opts, currentVersion: "1.3.0" });
  assert.equal((await updater.check()).phase, "current");
  assert.equal((await updater.download({ file: "bad.exe" })).phase, "error");
  await assert.rejects(updater.install(() => assert.fail("must not launch")), /先下载/);
  assert.equal(f.requests, 0);
});

test("大小不符、哈希不符及HTTP错误不留下可执行文件或部分文件，随后可重试", async (t) => {
  const f = await fixture(t), updater = createUpdater(f.opts);
  for (const body of [Buffer.alloc(3), Buffer.alloc(f.body.length), Buffer.alloc(f.body.length + 1)]) {
    await updater.check(); f.body = body;
    assert.equal((await updater.download()).phase, "error");
    assert.deepEqual(fs.readdirSync(f.opts.downloadDir), []);
  }
  await updater.check(); f.status = 500;
  assert.match((await updater.download()).reason, /500/);
  f.status = 200; f.body = Buffer.from("MZ-test-installer-bytes");
  await updater.check(); assert.equal((await updater.download()).phase, "ready");
});

test("安装前再次校验文件，下载后的篡改不会被执行", async (t) => {
  const f = await fixture(t), updater = createUpdater(f.opts);
  await updater.check(); await updater.download();
  fs.writeFileSync(path.join(f.opts.downloadDir, "DoubaoWorkshop-1.3.0-Setup.exe"), Buffer.alloc(f.body.length));
  const result = await updater.install(() => assert.fail("must not launch"));
  assert.equal(result.phase, "error"); assert.match(result.reason, /校验失败/);
});

test("安装进程无法启动时保留应用并允许重试", async (t) => {
  const f = await fixture(t), updater = createUpdater(f.opts);
  await updater.check(); await updater.download();
  const result = await updater.install(async () => { throw new Error("fixture launch denied"); });
  assert.equal(result.phase, "error"); assert.match(result.reason, /launch denied/);
  await updater.check(); assert.equal((await updater.download()).phase, "ready");
});

test("静态服务只读且只开放安装包和版本信息", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dir, "latest.json"), JSON.stringify(f.manifest));
  fs.writeFileSync(path.join(f.dir, "store.json"), "private fixture");
  const server = createServer(f.dir);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + "/latest.json"); assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store"); await res.text();
  assert.equal((await fetch(base + "/latest.json", { method: "HEAD" })).status, 200);
  assert.equal((await fetch(base + "/latest.json", { method: "POST" })).status, 405);
  for (const name of ["/", "/store.json", "/update-public-key.pem", "/%2e%2e%5cstore.json", "/latest.json.next"]) assert.equal((await fetch(base + name)).status, 404);
});

test("发布先校验上传文件再更新清单，拒绝回退和同版本替换", async (t) => {
  const f = await fixture(t), stage = path.join(f.dir, "incoming"); fs.mkdirSync(stage);
  const write = (manifest, body = f.body) => { fs.writeFileSync(path.join(stage, "latest.json"), JSON.stringify(manifest)); fs.writeFileSync(path.join(stage, manifest.file.url), body); };
  write(f.manifest, Buffer.from("bad")); await assert.rejects(activate(f.dir, stage), /size mismatch/);
  assert.equal(fs.existsSync(path.join(f.dir, "public", "latest.json")), false);
  write(f.manifest); await activate(f.dir, stage);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "public", "latest.json"))).version, "1.3.0");
  write(f.manifest); await activate(f.dir, stage);
  const older = f.sign({ version: "1.2.0", file: { ...f.manifest.file, url: "DoubaoWorkshop-1.2.0-Setup.exe" } });
  write(older); await assert.rejects(activate(f.dir, stage), /rollback/);
  const changed = Buffer.from("different installer");
  const replaced = f.sign({ file: { ...f.manifest.file, size: changed.length, sha256: crypto.createHash("sha256").update(changed).digest("hex") } });
  write(replaced, changed); await assert.rejects(activate(f.dir, stage), /replacement/);
});

test("Mac 两种架构只接收对应签名 DMG，并下载后再次校验", async (t) => {
  const f = await fixture(t);
  for (const arch of ["arm64", "x64"]) {
    const name = `DoubaoWorkshop-1.3.0-mac-${arch}.dmg`;
    f.manifest = f.sign({ platform: "darwin", arch, file: { ...f.sign().file, url: name } });
    const opts = { ...f.opts, platform: "darwin", arch };
    assert.equal((await check(opts)).ok, true);
    assert.equal((await check({ ...opts, arch: arch === "arm64" ? "x64" : "arm64" })).ok, false);
    assert.equal((await check(f.opts)).ok, false);
    const updater = createUpdater(opts);
    await updater.check();
    assert.equal((await updater.download()).phase, "ready");
    await updater.install(async (file) => assert.equal(path.basename(file), name));
    f.manifest = f.sign({ platform: "darwin", arch });
    assert.equal((await check(opts)).ok, false, "Mac must not execute an exe");
  }
});

test("三个平台清单可独立发布且更新服务不缓存清单", async (t) => {
  const f = await fixture(t), stage = path.join(f.dir, "incoming"); fs.mkdirSync(stage);
  for (const arch of ["arm64", "x64"]) {
    const manifestName = `latest-darwin-${arch}.json`;
    const m = f.sign({ platform: "darwin", arch, file: { ...f.sign().file, url: `DoubaoWorkshop-1.3.0-mac-${arch}.dmg` } });
    fs.writeFileSync(path.join(stage, manifestName), JSON.stringify(m));
    fs.writeFileSync(path.join(stage, m.file.url), f.body);
    await activate(f.dir, stage, manifestName);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "public", manifestName))).arch, arch);
  }
  await assert.rejects(activate(f.dir, stage, "../latest.json"), /Invalid manifest/);
  const server = createServer(path.join(f.dir, "public"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const arch of ["arm64", "x64"]) {
    const res = await fetch(`${base}/latest-darwin-${arch}.json`);
    assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store"); await res.text();
    assert.equal((await fetch(`${base}/DoubaoWorkshop-1.3.0-mac-${arch}.dmg`, { method: "HEAD" })).status, 200);
  }
  assert.equal((await fetch(`${base}/latest-darwin-ia32.json`)).status, 404);
});
