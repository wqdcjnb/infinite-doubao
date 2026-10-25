"use strict";

/**
 * 素材遮脸：调用本地 Python（OpenCV YuNet）做人脸检测，图片直接输出，视频走 ffmpeg 管道逐帧处理。
 *
 * 为什么不用纯 JS 做：人脸检测要模型推理，Electron 里塞 tfjs/onnxruntime 会让体积翻好几倍；
 * 本机已有 Python + opencv，走子进程最省事，也方便单独调试脚本。
 */

const { spawn, execFile } = require("node:child_process");
const execFileAsync = require("node:util").promisify(execFile);
const path = require("node:path");
const fs = require("node:fs");
const P = require("./paths");

const PY_DIR = P.pyDir();
const SCRIPT = path.join(PY_DIR, "face_mask.py");
const MODEL = path.join(PY_DIR, "face_detection_yunet_2023mar.onnx");

let cachedPython = null;
let pendingProbe = null;

function candidateFfmpeg() {
  return P.tool("ffmpeg");
}

async function tryPython(cmd, args) {
  try {
    const r = await execFileAsync(cmd, [...args, "-B", "-c", "import cv2,sys;print(cv2.__version__)"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (String(r.stdout || "").trim()) return { cmd, args, version: String(r.stdout).trim() };
  } catch {}
  return null;
}

function findPython() {
  if (cachedPython) return cachedPython;
  // Share discovery while opening the panel and starting a job overlap.
  cachedPython = discoverPython();
  return cachedPython;
}

async function discoverPython() {
  const env = process.env.DOLAMOD_PYTHON;
  const cands = [];
  const runtime = P.optionalDir() || P.resources();
  if (fs.existsSync(P.res("optional-components.json")) && !P.optionalDir()) return { cmd: "", args: [], missing: true };
  const bundled = process.platform === "win32" ? path.join(runtime, "python", "python.exe") : path.join(runtime, "python", "bin", "python3");
  try { if (fs.existsSync(bundled)) cands.push({ cmd: bundled, args: ["-I"] }); } catch {}
  if (env) cands.push({ cmd: env, args: [] });
  for (const cmd of process.platform === "darwin" ? ["python3", "python"] : ["python", "python3"]) cands.push({ cmd, args: [] });
  if (process.platform === "win32") cands.push({ cmd: "py", args: ["-3"] });
  for (const c of cands) {
    const hit = await tryPython(c.cmd, c.args);
    if (hit) return hit;
  }
  return { cmd: "", args: [], missing: true };
}

function probeFaceMask() {
  if (!pendingProbe) pendingProbe = probeTools().finally(() => { pendingProbe = null; });
  return pendingProbe;
}

async function probeTools() {
  const ffmpeg = candidateFfmpeg();
  const [py, ffmpegOk] = await Promise.all([findPython(), (async () => {
    try {
      await execFileAsync(ffmpeg, ["-version"], { encoding: "utf8", timeout: 8000, windowsHide: true });
      return true;
    } catch { return false; }
  })()]);
  return {
    python: py.missing ? "" : `${py.cmd} ${py.args.join(" ")}`.trim(),
    opencv: py.version || "",
    model: fs.existsSync(MODEL),
    ffmpeg,
    ffmpegOk,
    script: fs.existsSync(SCRIPT)
  };
}

async function runFaceMask(opts) {
  const py = await findPython();
  return new Promise((resolve) => {
    if (py.missing) {
      resolve({ ok: false, message: "请先在设置中下载“本地素材处理组件”，安装后即可使用遮脸功能。" });
      return;
    }
    if (!fs.existsSync(SCRIPT)) {
      resolve({ ok: false, message: "缺少 py/face_mask.py" });
      return;
    }
    if (!fs.existsSync(MODEL)) {
      resolve({ ok: false, message: "缺少人脸检测模型 face_detection_yunet_2023mar.onnx（放在 py/ 目录）" });
      return;
    }

    const args = [
      "-B", "-X", "utf8",
      SCRIPT,
      "--mode", String(opts.mode || "mosaic"),
      "--strength", String(Math.max(2, Math.min(80, Number(opts.strength) || 18))),
      "--pad", String(Math.max(0, Math.min(0.8, Number(opts.padRatio) || 0.18))),
      "--model", MODEL,
      "--ffmpeg", candidateFfmpeg(),
      "--ffprobe", P.tool("ffprobe"),
      "--json-progress"
    ];
    if (opts.keepOriginal === false) args.push("--no-keep");
    if (opts.outDir) args.push("--out-dir", String(opts.outDir));
    args.push("--files", ...opts.files.map(String));

    const child = spawn(py.cmd, [...py.args, ...args], { windowsHide: true, cwd: PY_DIR });
    let out = "";
    let err = "";
    const results = [];

    child.stdout.on("data", (buf) => {
      out += buf.toString("utf8");
      const lines = out.split(/\r?\n/);
      out = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith("{")) {
          let j = null;
          try { j = JSON.parse(t); } catch {}
          if (j && j.event === "progress" && typeof opts.onProgress === "function") opts.onProgress(j);
          else if (j && j.event === "done") results.push(j);
          else if (j && j.event === "error" && typeof opts.onProgress === "function") opts.onProgress(j);
        }
      }
    });
    child.stderr.on("data", (buf) => { err += buf.toString("utf8"); });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code, results, stderr: err.slice(-2000) });
    });
    child.on("error", (error) => resolve({ ok: false, message: String(error && error.message) }));
  });
}

function resetProbe() { cachedPython = null; pendingProbe = null; }
module.exports = { runFaceMask, probeFaceMask, resetProbe };
