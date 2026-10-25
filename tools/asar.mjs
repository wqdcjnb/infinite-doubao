"use strict";

/**
 * 极简 asar 打包 / 解包（纯 Node，无外部依赖）
 *
 * 为什么自己写：electron-builder / @electron/asar 都要联网取包，离线机器上直接卡死。
 * asar 就是一串 Pickle 加一段 JSON 索引，格式如下（实测真实 app.asar 得来）：
 *
 *   0   u32 = 4                        —— 下面那个 size 字段自身的 payload 长度
 *   4   u32 = headerSize               —— headerPickle 总长 = 8 + jsonLen + pad
 *   8   u32 = headerPayload            —— headerPickle 的 payload 长度 = 4 + jsonLen + pad
 *   12  u32 = jsonLen                  —— JSON 字符串真实长度
 *   16  ...  JSON（4 字节对齐补 0）
 *   16+jsonLen+pad 起：各文件内容，entry.offset 相对这里
 *
 * 用法：
 *   node tools/asar.mjs pack <srcDir> <out.asar>
 *   node tools/asar.mjs list <app.asar>
 *   node tools/asar.mjs extract <app.asar> <outDir>
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

const HEAD = 16;

function pad4(n) {
  const r = n % 4;
  return r === 0 ? 0 : 4 - r;
}

/** 目录 → asar header 节点（offset 必须是字符串，Electron 用 FindString 取；内容不补齐对齐） */
function walk(dir, files) {
  const node = { files: {} };
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      node.files[name] = walk(abs, files);
    } else if (stat.isFile()) {
      const offset = files.reduce((n, f) => n + f.size, 0);
      const buf = fs.readFileSync(abs);
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      files.push({ abs, size: stat.size, buf });
      node.files[name] = {
        size: stat.size,
        offset: String(offset),
        integrity: { algorithm: "SHA256", hash, blockSize: 4194304, blocks: [hash] }
      };
    }
  }
  return node;
}

function pack(srcDir, outFile) {
  const files = [];
  const header = walk(srcDir, files);
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const jsonLen = json.length;
  const pad = pad4(jsonLen);
  const headerSize = 8 + jsonLen + pad;

  const head = Buffer.alloc(HEAD);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerSize, 4);
  head.writeUInt32LE(headerSize - 4, 8);
  head.writeUInt32LE(jsonLen, 12);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, "w");
  fs.writeSync(fd, head);
  fs.writeSync(fd, json);
  if (pad) fs.writeSync(fd, Buffer.alloc(pad));
  for (const f of files) fs.writeSync(fd, f.buf);
  fs.closeSync(fd);
  return { file: outFile, files: files.length, bytes: fs.statSync(outFile).size };
}

function readHeader(asarFile) {
  const fd = fs.openSync(asarFile, "r");
  const head = Buffer.alloc(HEAD);
  fs.readSync(fd, head, 0, HEAD, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, HEAD);
  fs.closeSync(fd);
  return { header: JSON.parse(jsonBuf.toString("utf8")), jsonLen, base: HEAD + jsonLen + pad4(jsonLen) };
}

function flatten(node, base, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = base ? `${base}/${name}` : name;
    if (child.files) flatten(child, rel, out);
    else out.push({ rel, size: child.size, offset: child.offset });
  }
  return out;
}

function list(asarFile) {
  const { header } = readHeader(asarFile);
  return flatten(header, "", []).map((f) => `${String(f.size).padStart(10)}  ${f.rel}`);
}

function extract(asarFile, outDir) {
  const { header, base } = readHeader(asarFile);
  const entries = flatten(header, "", []);
  const fd = fs.openSync(asarFile, "r");
  for (const e of entries) {
    const target = path.join(outDir, e.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, base + Number(e.offset));
    fs.writeFileSync(target, buf);
  }
  fs.closeSync(fd);
  return entries.length;
}

const [, , cmd, a, b] = process.argv;
if (cmd === "pack") {
  const r = pack(path.resolve(a), path.resolve(b));
  console.log(`[asar] ${r.files} 个文件 → ${r.file}（${(r.bytes / 1024 / 1024).toFixed(2)} MB）`);
} else if (cmd === "list") {
  console.log(list(path.resolve(a)).join("\n"));
} else if (cmd === "extract") {
  console.log(`[asar] 解出 ${extract(path.resolve(a), path.resolve(b))} 个文件`);
} else {
  console.log("用法：node tools/asar.mjs pack|list|extract <a> [b]");
  process.exitCode = 1;
}
