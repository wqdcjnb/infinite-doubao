"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const source = fs.readFileSync(path.join(__dirname, "../src/jianying-import.js"), "utf8");
const winPath = path.win32;
const local = "C:\\Users\\测试 用户\\AppData\\Local";
const installed = winPath.join(local, "JianyingPro", "Apps", "JianyingPro.exe");
const video = "C:\\视频成片\\清晨湖面 第1条 & 终版.mp4";
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(options = {}) {
  const tasks = options.tasks || [{ id: "task-one", status: "succeeded", result: { files: [video] } }];
  const entries = new Map((options.files || [installed, video]).map((file) => [winPath.resolve(file).toLowerCase(), true]));
  for (const dir of options.directories || []) entries.set(winPath.resolve(dir).toLowerCase(), false);
  const launches = []; const registryCalls = []; const timers = []; const writes = [];
  let now = 10000;
  class Clock extends Date { static now() { return now; } }
  const fakeFs = new Proxy({
    statSync(file) {
      const value = entries.get(winPath.resolve(file).toLowerCase());
      if (value === undefined) throw Object.assign(new Error("fixture file missing"), { code: "ENOENT" });
      return { isFile: () => value };
    }
  }, { get(target, name) {
    if (name in target) return target[name];
    return (...args) => { writes.push([name, args]); throw new Error(`导入不应写入或重建工程：${String(name)}`); };
  } });
  const context = vm.createContext({
    module: { exports: {} }, Date: Clock,
    process: { env: { LOCALAPPDATA: options.local === undefined ? local : options.local } },
    setTimeout: (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cancelled = true; },
    require(name) {
      if (name === "node:fs") return fakeFs;
      if (name === "node:path") return winPath;
      if (name === "./store") return { get: () => ({ tasks }) };
      if (name === "node:child_process") return {
        execFile(executable, args, settings, callback) {
          registryCalls.push({ executable, args: plain(args), settings: plain(settings) });
          queueMicrotask(() => callback(options.registryError || null, options.registry || ""));
        },
        spawn(executable, args, settings) {
          const child = new EventEmitter(); child.unref = () => { child.unreferenced = true; };
          launches.push({ executable, args: plain(args), settings: plain(settings), child });
          queueMicrotask(() => {
            if (options.spawnError) child.emit("error", options.spawnError);
            else { child.emit("spawn"); if (options.exitCode !== undefined) child.emit("exit", options.exitCode, null); }
          });
          return child;
        }
      };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  vm.runInContext(source, context, { filename: "src/jianying-import.js" });
  return {
    api: context.module.exports, tasks, launches, registryCalls, writes, entries,
    advance(ms) { now += ms; },
    async settle() {
      await flush();
      for (const timer of timers.splice(0)) if (!timer.cancelled) { now += timer.delay; timer.fn(); }
      await flush();
    }
  };
}

test("优先发现用户本地剪映安装，无需查询或执行注册表命令", async () => {
  const f = fixture();
  assert.equal(await f.api.findExecutable(), installed);
  assert.equal(f.registryCalls.length, 0); assert.equal(f.launches.length, 0);
});

test("本地安装缺失时从注册表提取带中文空格的exe，仅执行固定查询脚本", async () => {
  const custom = "D:\\应用 软件\\剪映专业版\\JianyingPro.exe";
  const registry = `    "D:\\已删除\\JianyingPro.exe" -import_project "%1"\r\n    "${custom}" -import_project "%1"`;
  const f = fixture({ files: [custom, video], registry });
  assert.equal(await f.api.findExecutable(), custom);
  assert.equal(f.launches.length, 0); assert.equal(f.registryCalls.length, 1);
  const call = f.registryCalls[0];
  assert.equal(call.executable, "powershell.exe"); assert.equal(call.settings.shell, false); assert.equal(call.settings.encoding, "utf8");
  assert.ok(call.args.includes("-NoProfile")); assert.ok(call.args.includes("-NonInteractive"));
  assert.match(call.args.at(-1), /HKEY_CURRENT_USER/); assert.match(call.args.at(-1), /HKEY_LOCAL_MACHINE/);
  assert.match(call.args.at(-1), /JianyingPro\.JYPack/);
  assert.equal(call.args.at(-1).includes(custom), false, "注册表原命令不参与脚本拼接或执行");
});

test("失效安装、目录伪装exe、无关注册表命令及查询失败均明确报错", async () => {
  for (const options of [
    { registry: '"C:\\missing\\JianyingPro.exe" "%1"' },
    { directories: [installed], registry: '"C:\\Windows\\System32\\cmd.exe" /c echo fixture' },
    { registryError: new Error("registry unavailable") }
  ]) {
    const f = fixture({ files: [video], ...options });
    await assert.rejects(f.api.findExecutable(), /未找到剪映专业版/);
    assert.equal(f.launches.length, 0);
  }
});

test("单任务视频使用一个原生argv传递中文空格和符号，不写工程或任务", async () => {
  const f = fixture(); const before = JSON.stringify(f.tasks);
  const resultPromise = f.api.importTask({ taskId: "task-one" }); await f.settle();
  const result = await resultPromise;
  assert.deepEqual(plain(result), { ok: true, file: video }); assert.equal(f.launches.length, 1);
  const call = f.launches[0]; assert.equal(call.executable, installed);
  assert.deepEqual(call.args, [`-open-file=${video}`]);
  assert.equal(call.settings.shell, false); assert.equal(call.settings.detached, true); assert.equal(call.settings.stdio, "ignore");
  assert.equal(call.settings.windowsHide, false); assert.equal(call.child.unreferenced, true);
  assert.deepEqual(f.writes, []); assert.equal(JSON.stringify(f.tasks), before);
});

test("未知任务、未完成任务和无本地结果均不会触发剪映", async () => {
  for (const [tasks, opts, expected] of [
    [[], { taskId: "missing" }, /任务不存在/],
    [[{ id: "one", status: "running", result: { files: [video] } }], { taskId: "one" }, /生成完成/],
    [[{ id: "one", status: "succeeded", result: { files: [] } }], { taskId: "one" }, /没有可导入/],
    [[{ id: "one", status: "succeeded" }], { taskId: "one" }, /没有可导入/]
  ]) {
    const f = fixture({ tasks }); await assert.rejects(f.api.importTask(opts), expected);
    assert.equal(f.launches.length, 0); assert.equal(f.registryCalls.length, 0);
  }
});

test("只允许选择本任务结果，别的任务或任意文件不能借该taskId导入", async () => {
  const other = "C:\\视频成片\\另一个任务.mp4";
  const tasks = [{ id: "one", status: "succeeded", result: { files: [video] } }, { id: "two", status: "succeeded", result: { files: [other] } }];
  const f = fixture({ tasks, files: [installed, video, other] });
  await assert.rejects(f.api.importTask({ taskId: "one", file: other }), /不属于该任务/);
  assert.equal(f.launches.length, 0);
});

test("多视频结果必须明确选择，只导入所选一条且重复结果不造成误判", async () => {
  const second = "C:\\视频成片\\第二条.mp4";
  const f = fixture({ files: [installed, video, second], tasks: [{ id: "one", status: "succeeded", result: { files: [video, second, second] } }] });
  await assert.rejects(f.api.importTask({ taskId: "one" }), /多个视频/);
  assert.equal(f.launches.length, 0);
  const resultPromise = f.api.importTask({ taskId: "one", file: second }); await f.settle(); await resultPromise;
  assert.deepEqual(f.launches[0].args, [`-open-file=${second}`]);
  const duplicate = fixture({ tasks: [{ id: "one", status: "succeeded", result: { files: [video, video] } }] });
  const deduplicated = duplicate.api.importTask({ taskId: "one" }); await duplicate.settle(); await deduplicated;
  assert.equal(duplicate.launches.length, 1);
});

test("缺失文件、目录、相对路径、引号和控制字符路径在启动前被拒绝", async () => {
  for (const [file, options, expected] of [
    [video, { files: [installed] }, /移动或删除/],
    [video, { files: [installed], directories: [video] }, /移动或删除/],
    ["relative.mp4", {}, /路径无效/],
    ['C:\\视频\\引号".mp4', {}, /路径无效/],
    ["C:\\视频\\换行\n.mp4", {}, /路径无效/],
    ["C:\\视频\\空字符\x00.mp4", {}, /路径无效/]
  ]) {
    const f = fixture({ ...options, tasks: [{ id: "one", status: "succeeded", result: { files: [file] } }] });
    await assert.rejects(f.api.importTask({ taskId: "one" }), expected);
    assert.equal(f.launches.length, 0);
  }
});

test("并发及五秒内重复点击只启动一次，窗口期过后允许明确再次导入", async () => {
  const f = fixture();
  const first = f.api.importTask({ taskId: "task-one" });
  const second = f.api.importTask({ taskId: "task-one", file: video });
  await f.settle(); const results = await Promise.all([first, second]);
  assert.equal(f.launches.length, 1); assert.equal(results[0], results[1]);
  f.advance(4999); assert.equal(await f.api.importTask({ taskId: "task-one" }), results[0]); assert.equal(f.launches.length, 1);
  f.advance(1); const later = f.api.importTask({ taskId: "task-one" }); await f.settle(); await later;
  assert.equal(f.launches.length, 2);
});

test("启动错误或短期非零退出不返回成功，并允许用户重试", async () => {
  for (const options of [{ spawnError: new Error("ENOENT") }, { exitCode: 2 }]) {
    const f = fixture(options);
    const firstFailure = assert.rejects(f.api.importTask({ taskId: "task-one" }), /无法打开剪映/);
    await f.settle(); await firstFailure;
    const retryFailure = assert.rejects(f.api.importTask({ taskId: "task-one" }), /无法打开剪映/);
    await f.settle(); await retryFailure;
    assert.equal(f.launches.length, 2); assert.deepEqual(f.writes, []);
  }
});
