"use strict";

/**
 * 生成单文件安装包
 *
 * 产出：dist/豆包工坊 v1.2.0 安装包.exe
 * 双击即可装到 %LOCALAPPDATA%\Programs\豆包工坊（用户目录，不需要管理员），
 * 桌面 + 开始菜单各一个快捷方式，卸载走「应用和功能」。
 *
 * 做法：csc 编 installer/Setup.cs 得到 stub，再把 dist 打成 zip 追加到 stub 尾部，
 * 最后写 24 字节尾索引（int64 数据偏移 | int64 数据长度 | "DMINST01"）。
 * 装的时候 Setup 从自身尾部读 zip 解压，卸载器则是 stub 那一段的副本（不含数据，几十 KB）。
 *
 * 用法：node build/installer.mjs [--app dist/豆包工坊] [--out dist] [--name 豆包工坊]
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const APP_NAME = argOf("--name", "豆包工坊");
const APP_DIR = path.resolve(ROOT, argOf("--app", path.join("dist", APP_NAME)));
const OUT_DIR = path.resolve(ROOT, argOf("--out", "dist"));
/** 应用版本取自 src/brand.js（dist 里的 version 文件是 Electron 运行时版本，不是应用版本） */
const VERSION = (() => {
  try {
    const src = fs.readFileSync(path.join(ROOT, "src", "brand.js"), "utf8");
    const m = src.match(/version:\s*"([0-9][^"]*)"/);
    if (m) return m[1];
  } catch {}
  return "1.2.0";
})();

const WORK = path.join(ROOT, "build", "out");
const STUB = path.join(WORK, "Setup.stub.exe");
const ZIP = path.join(WORK, "payload.zip");
const TARGET = path.join(OUT_DIR, `${APP_NAME} v${VERSION} 安装包.exe`);
const MAGIC = "DMINST01";

const log = (m) => process.stdout.write(`[installer] ${m}\n`);

/* ------------------------------------------------------------ stub 编译 */

function findCsc() {
  const win = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(win, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(win, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function buildStub() {
  const csc = findCsc();
  if (!csc) throw new Error("找不到 csc.exe（.NET Framework 4.x 编译器）");
  fs.mkdirSync(WORK, { recursive: true });
  log(`编译安装器：${path.basename(csc)}`);

  // 版本号要和安装包名字一致：编译前把源码里的 AppVersion 换成实际版本，编完删掉临时副本
  const source = fs.readFileSync(path.join(ROOT, "installer", "Setup.cs"), "utf8")
    .replace(/(internal const string AppVersion = ")[^"]*(")/, `$1${VERSION}$2`);
  const tmpSource = path.join(WORK, "Setup.g.cs");
  fs.writeFileSync(tmpSource, source, "utf8");
  execFileSync(
    csc,
    [
      "/nologo", "/target:winexe", "/optimize+",
      `/out:${STUB}`,
      "/reference:System.dll", "/reference:System.Core.dll",
      "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll",
      "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll",
      `/win32manifest:${path.join(ROOT, "installer", "Setup.manifest")}`,
      tmpSource
    ],
    { stdio: "inherit" }
  );
  try { fs.unlinkSync(tmpSource); } catch {}
  if (!fs.existsSync(STUB)) throw new Error("安装器编译失败：没有产出 stub");
  log(`stub：${(fs.statSync(STUB).size / 1024).toFixed(0)} KB`);
}

/* ------------------------------------------------------------ zip 写入 */

const CRC_TABLE = (() => {
  if (typeof zlib.crc32 === "function") return null;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const full = path.join(abs, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, relPath);
      else out.push({ abs: full, name: relPath, mtime: st.mtime, size: st.size });
    }
  };
  walk(dir, "");
  return out;
}

function writeZip(dir, target) {
  const files = listFiles(dir);
  if (!files.length) throw new Error(`没有可打包的文件：${dir}`);
  const manifestName = ".doubao-files.sha256";
  if (files.some((f) => f.name === manifestName)) throw new Error("应用目录包含安装器保留的校验文件");
  const manifest = Buffer.from(files.map((f) => `${crypto.createHash("sha256").update(fs.readFileSync(f.abs)).digest("hex")} ${f.name}\n`).join(""));
  files.push({ name: manifestName, data: manifest, size: manifest.length, mtime: new Date() });

  const fd = fs.openSync(target, "w");
  const central = [];
  let offset = 0;
  let rawTotal = 0;
  let packedTotal = 0;

  try {
    for (const f of files) {
      const raw = f.data || fs.readFileSync(f.abs);
      const sum = crc32(raw);
      const def = zlib.deflateRawSync(raw, { level: 6 });
      const method = def.length < raw.length ? 8 : 0;
      const data = method === 8 ? def : raw;
      const nameBuf = Buffer.from(f.name, "utf8");
      const { time, date } = dosTime(f.mtime);

      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(0x0800, 6);          // bit 11：文件名是 UTF-8
      head.writeUInt16LE(method, 8);
      head.writeUInt16LE(time, 10);
      head.writeUInt16LE(date, 12);
      head.writeUInt32LE(sum, 14);
      head.writeUInt32LE(data.length, 18);
      head.writeUInt32LE(raw.length, 22);
      head.writeUInt16LE(nameBuf.length, 26);
      head.writeUInt16LE(0, 28);

      fs.writeSync(fd, head);
      fs.writeSync(fd, nameBuf);
      fs.writeSync(fd, data);

      central.push({ nameBuf, method, time, date, sum, csize: data.length, usize: raw.length, offset });
      offset += 30 + nameBuf.length + data.length;
      rawTotal += raw.length;
      packedTotal += data.length;
      process.stdout.write(`\r[installer] 打包 ${((rawTotal / 1048576) | 0)} MB / ${((files.reduce((n, x) => n + x.size, 0)) / 1048576) | 0} MB  ${f.name.slice(-40).padEnd(40)}`);
    }
    process.stdout.write("\n");

    const cdStart = offset;
    for (const e of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.sum, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE(0, 38);
      h.writeUInt32LE(e.offset, 42);
      fs.writeSync(fd, h);
      fs.writeSync(fd, e.nameBuf);
      offset += 46 + e.nameBuf.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(fd, eocd);
    offset += 22;
  } finally {
    fs.closeSync(fd);
  }

  return { count: files.length, rawTotal, packedTotal, zipSize: offset };
}

/* ------------------------------------------------------------ 拼接 */

function appendCopy(dstFd, srcPath, size) {
  const srcFd = fs.openSync(srcPath, "r");
  try {
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
    let left = size;
    while (left > 0) {
      const want = Math.min(buf.length, left);
      const n = fs.readSync(srcFd, buf, 0, want, size - left);
      if (n <= 0) throw new Error("复制 zip 数据时读到了文件尾");
      fs.writeSync(dstFd, buf, 0, n);
      left -= n;
    }
  } finally {
    fs.closeSync(srcFd);
  }
}

function assemble() {
  const stubSize = fs.statSync(STUB).size;
  const zipSize = fs.statSync(ZIP).size;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try { fs.unlinkSync(TARGET); } catch {}

  const fd = fs.openSync(TARGET, "w");
  try {
    appendCopy(fd, STUB, stubSize);
    appendCopy(fd, ZIP, zipSize);
    const tail = Buffer.alloc(24);
    tail.writeBigInt64LE(BigInt(stubSize), 0);
    tail.writeBigInt64LE(BigInt(zipSize), 8);
    tail.write(MAGIC, 16, "ascii");
    fs.writeSync(fd, tail);
  } finally {
    fs.closeSync(fd);
  }
  return fs.statSync(TARGET).size;
}

/* ------------------------------------------------------------ 主流程 */

function main() {
  if (!fs.existsSync(APP_DIR)) throw new Error(`没有找到应用目录：${APP_DIR}（先跑 node build/build.mjs）`);
  const exe = path.join(APP_DIR, `${APP_NAME}.exe`);
  if (!fs.existsSync(exe)) throw new Error(`应用目录里没有 ${APP_NAME}.exe：${APP_DIR}`);

  buildStub();
  fs.mkdirSync(WORK, { recursive: true });
  log("打包应用文件…");
  const z = writeZip(APP_DIR, ZIP);
  log(`${z.count} 个文件：${(z.rawTotal / 1048576).toFixed(0)} MB → ${(z.packedTotal / 1048576).toFixed(0)} MB`);

  const size = assemble();
  log(`完成：${TARGET}`);
  log(`安装包 ${(size / 1048576).toFixed(0)} MB（应用 ${(z.rawTotal / 1048576).toFixed(0)} MB）`);
}

main();
