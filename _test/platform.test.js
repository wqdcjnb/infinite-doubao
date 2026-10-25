"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const P = require("../src/paths");
const { manifestName, sourceUrl } = require("../src/update");

test("Mac Resources 路径支持中文空格且选择无 exe 的工具", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "豆包 工坊-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resources = path.join(dir, "豆包工坊.app", "Contents", "Resources");
  fs.mkdirSync(path.join(resources, "tools"), { recursive: true });
  fs.mkdirSync(path.join(resources, "py"));
  for (const file of ["tools/ffmpeg", "tools/ffmpeg.exe", "py/face_mask.py"]) fs.writeFileSync(path.join(resources, file), "fixture");
  P.init({ home: path.join(dir, "home"), resources });
  assert.equal(P.tool("ffmpeg", "darwin"), path.join(resources, "tools", "ffmpeg"));
  assert.equal(P.tool("ffmpeg", "win32"), path.join(resources, "tools", "ffmpeg.exe"));
  assert.equal(P.tool("ffprobe", "darwin"), "ffprobe");
  assert.equal(P.pyDir(), path.join(resources, "py"));
});

test("旧更新地址按 Mac 架构选择清单，Windows 保持原地址", () => {
  const saved = process.env.DOLAMOD_UPDATE_URL;
  try {
    process.env.DOLAMOD_UPDATE_URL = "http://127.0.0.1:17824/releases/latest.json?channel=stable";
    assert.equal(manifestName("win32", "x64"), "latest.json");
    for (const arch of ["arm64", "x64"]) assert.equal(sourceUrl("darwin", arch), `http://127.0.0.1:17824/releases/latest-darwin-${arch}.json?channel=stable`);
    assert.equal(sourceUrl("win32", "x64"), process.env.DOLAMOD_UPDATE_URL);
    assert.throws(() => manifestName("darwin", "ia32"), /不支持/);
  } finally { if (saved === undefined) delete process.env.DOLAMOD_UPDATE_URL; else process.env.DOLAMOD_UPDATE_URL = saved; }
});

test("Mac 剪映通过 LaunchServices 打开中文视频路径，不调用注册表或 Windows exe", async () => {
  const { EventEmitter } = require("node:events");
  const video = "/Users/test/视频 & 素材/完成.mp4";
  const app = "/Applications/JianyingPro.app";
  const launches = [];
  const context = { module: { exports: {} }, process: { platform: "darwin", env: {} }, Date, setTimeout, clearTimeout,
    require(name) {
      if (name === "node:path") return path.posix;
      if (name === "node:os") return { homedir: () => "/Users/test" };
      if (name === "node:fs") return { statSync: (file) => ({ isFile: () => [video, app + "/Contents/Info.plist"].includes(file) }) };
      if (name === "./store") return { get: () => ({ tasks: [{ id: "one", status: "succeeded", result: { files: [video] } }] }) };
      if (name === "node:child_process") return { execFile: () => assert.fail("No registry on Mac"), spawn(cmd, args, opts) {
        launches.push({ cmd, args: Array.from(args), opts });
        const child = new EventEmitter(); child.unref = () => {};
        queueMicrotask(() => child.emit("spawn")); return child;
      } };
      throw new Error(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/jianying-import.js"), "utf8"), context);
  assert.equal(await context.module.exports.findExecutable(), app);
  assert.equal((await context.module.exports.importTask({ taskId: "one" })).ok, true);
  assert.equal(launches[0].cmd, "/usr/bin/open");
  assert.deepEqual(launches[0].args, ["-a", app, video]);
  assert.equal(launches[0].opts.shell, false);
});
