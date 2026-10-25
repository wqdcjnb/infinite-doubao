"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { promisify } = require("node:util");

function fixture({ missingPython = false, failFirst = false, missingFfmpeg = false } = {}) {
  const calls = [];
  const jobs = [];
  function execFile() { throw new Error("Use the promise form"); }
  execFile[promisify.custom] = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    await new Promise(resolve => setTimeout(resolve, 25));
    const ffmpeg = cmd === "ffmpeg";
    if ((ffmpeg && missingFfmpeg) || (!ffmpeg && (missingPython || (failFirst && cmd === "python")))) {
      throw new Error("tool unavailable");
    }
    return { stdout: ffmpeg ? "ffmpeg fixture" : "5.0.0\n", stderr: "" };
  };
  const childProcess = {
    execFile,
    spawnSync() { throw new Error("Must not block the main process"); },
    spawn(cmd, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      jobs.push({ cmd, args, options, child });
      return child;
    }
  };
  const context = {
    module: { exports: {} },
    process: { execPath: "C:/fixture/app.exe", env: {} },
    __dirname: path.resolve(__dirname, "../src"),
    require(id) {
      if (id === "node:child_process") return childProcess;
      if (id === "node:fs") return { existsSync: file => /face_mask\.py$|\.onnx$/.test(file) };
      return require(id);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../src/facemask.js"), "utf8"), context);
  return { ...context.module.exports, calls, jobs };
}

test("tool discovery yields to the event loop and coalesces simultaneous panel probes", async () => {
  const f = fixture();
  let heartbeat = 0;
  const timer = setInterval(() => heartbeat++, 2);
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => f.probeFaceMask()));
    assert.ok(heartbeat > 0, "UI/main-process heartbeat must run during discovery");
    assert.equal(f.calls.length, 2, "one Python and one FFmpeg probe for concurrent requests");
    assert.ok(results.every(r => r.opencv === "5.0.0" && r.ffmpegOk && r.model && r.script));
    assert.ok(f.calls.every(c => c.options.windowsHide && c.options.timeout > 0));
    await f.probeFaceMask();
    assert.equal(f.calls.filter(c => c.cmd === "python").length, 1, "cache Python discovery");
    assert.equal(f.calls.filter(c => c.cmd === "ffmpeg").length, 2, "a later probe can retry FFmpeg");
  } finally { clearInterval(timer); }
});

test("discovery preserves Python fallback and reports unavailable FFmpeg", async () => {
  const f = fixture({ failFirst: true, missingFfmpeg: true });
  const r = await f.probeFaceMask();
  assert.equal(r.python, "python3");
  assert.equal(r.ffmpegOk, false);
  assert.deepEqual(f.calls.filter(c => c.cmd !== "ffmpeg").map(c => c.cmd), ["python", "python3"]);
});

test("processing started during discovery shares Python lookup and preserves result/progress delivery", async () => {
  const f = fixture();
  const progress = [];
  const probe = f.probeFaceMask();
  const run = f.runFaceMask({ files: ["中文图片.jpg"], onProgress: p => progress.push(p) });
  await probe;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(c => c.cmd === "python").length, 1);
  assert.equal(f.jobs.length, 1);
  const job = f.jobs[0];
  assert.ok(job.args.includes("中文图片.jpg"));
  assert.equal(job.options.windowsHide, true);
  job.child.stdout.emit("data", Buffer.from('{"event":"progress","percent":50}\n{"event":"done","out":"output.jpg"}\n'));
  job.child.emit("close", 0);
  const result = await run;
  assert.equal(result.ok, true);
  assert.equal(result.results[0].out, "output.jpg");
  assert.equal(progress[0].percent, 50);
});

test("missing Python resolves the existing user-facing failure without launching processing", async () => {
  const f = fixture({ missingPython: true });
  const [probe, run] = await Promise.all([f.probeFaceMask(), f.runFaceMask({ files: ["test.jpg"] })]);
  assert.equal(probe.python, "");
  assert.equal(run.ok, false);
  assert.match(run.message, /Python/);
  assert.equal(f.jobs.length, 0);
});
