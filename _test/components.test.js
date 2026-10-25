"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const P = require("../src/paths");
const { createManager, catalog } = require("../src/components");

async function fixture(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-components-"));
  const res = path.join(root, "resources"); fs.mkdirSync(res);
  P.init({ home: path.join(root, "home"), resources: res });
  const data = Buffer.from("verified media tool fixture");
  const m = { id: "a".repeat(64), release: "1.4.5", platform: process.platform, arch: process.arch,
    file: { name: `DoubaoWorkshop-MediaTools-1.4.5-${process.platform}-${process.arch}.tar.gz`, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") } };
  fs.writeFileSync(path.join(res, "optional-components.json"), JSON.stringify(m));
  let requests = 0, extracts = 0;
  const server = http.createServer((req, response) => { requests++; if (handler) handler(response, data); else response.end(data); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const options = { urls: [`http://127.0.0.1:${server.address().port}/tools`], extract: async (_file, dir) => {
    extracts++; for (const name of P.optionalFiles()) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "tool"); }
  } };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { res, m, options, requests: () => requests, extracts: () => extracts };
}

test("组件默认不下载；点击后校验、安装，重复点击共用下载，重启复用", async t => {
  const f = await fixture(t);
  const manager = createManager(f.options);
  assert.equal(manager.status().phase, "idle"); assert.equal(f.requests(), 0);
  const first = manager.install(); assert.equal(manager.install(), first);
  assert.equal((await first).phase, "installed"); assert.equal(f.requests(), 1); assert.equal(f.extracts(), 1);
  const next = createManager(f.options); assert.equal(next.status().phase, "installed");
  await next.install(); assert.equal(f.requests(), 1);
  assert.ok(P.tool("ffmpeg").startsWith(P.dir("components")));
  assert.deepEqual(fs.readdirSync(P.dir("components")), [f.m.id]);
});

test("组件大小或哈希不符时不解压，不留下就绪标记，支持重试", async t => {
  let corrupt = true;
  const f = await fixture(t, (res, data) => res.end(corrupt ? Buffer.alloc(data.length, 0) : data));
  const manager = createManager(f.options);
  assert.equal((await manager.install()).phase, "error"); assert.equal(f.extracts(), 0); assert.equal(P.optionalDir(), "");
  assert.deepEqual(fs.readdirSync(P.dir("components")), []);
  corrupt = false; assert.equal((await manager.install()).phase, "installed"); assert.equal(f.requests(), 2);
});

test("用户取消组件下载会清理临时文件，后续可再次安装", async t => {
  let hold = true;
  const f = await fixture(t, (res, data) => { if (hold) res.write(data.subarray(0, 2)); else res.end(data); });
  const manager = createManager(f.options), pending = manager.install();
  for (let i = 0; i < 100 && manager.status().received === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  manager.cancel(); assert.equal((await pending).phase, "idle");
  assert.equal(f.extracts(), 0); assert.deepEqual(fs.readdirSync(P.dir("components")), []);
  hold = false; assert.equal((await manager.install()).phase, "installed");
});

test("旧完整版复用原组件；错误架构清单不能下载安装", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.res, "optional-components.json"), JSON.stringify({ ...f.m, arch: "invalid" }));
  assert.throws(catalog, /不适用/);
  const manager = createManager(f.options); assert.equal(manager.status().phase, "unavailable");
  for (const name of P.optionalFiles()) { const file = path.join(f.res, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "old-tool"); }
  assert.equal(manager.status().phase, "installed"); await manager.install(); assert.equal(f.requests(), 0);
});
