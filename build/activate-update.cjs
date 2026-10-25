"use strict";

// 服务器本地激活：先验证完整上传的包，再原子替换清单；客户端不会看到半上传版本。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

async function activate(root, staging) {
  const raw = JSON.parse(fs.readFileSync(path.join(staging, "latest.json"), "utf8"));
  const { sig, ...m } = raw;
  const key = fs.readFileSync(path.join(root, "update-public-key.pem"));
  if (!sig || !crypto.verify(null, Buffer.from(JSON.stringify(m)), key, Buffer.from(sig, "base64"))) throw new Error("Invalid update signature");
  if (!/^\d+\.\d+\.\d+$/.test(m.version) || m.file.url !== `DoubaoWorkshop-${m.version}-Setup.exe`) throw new Error("Invalid release filename");
  const file = path.join(staging, m.file.url);
  if (fs.statSync(file).size !== m.file.size) throw new Error("Uploaded file size mismatch");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== m.file.sha256) throw new Error("Uploaded file checksum mismatch");
  const publicDir = path.join(root, "public");
  const latest = path.join(publicDir, "latest.json");
  const target = path.join(publicDir, m.file.url);
  fs.mkdirSync(publicDir, { recursive: true });
  if (fs.existsSync(latest)) {
    const prior = JSON.parse(fs.readFileSync(latest, "utf8"));
    const a = m.version.split(".").map(Number), b = prior.version.split(".").map(Number);
    const difference = a.map((n, i) => n - b[i]).find((n) => n !== 0) || 0;
    if (difference < 0 || (difference === 0 && prior.file.sha256 !== m.file.sha256)) throw new Error("Refusing rollback or replacement of an existing version");
  }
  if (fs.existsSync(target)) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    if (hash.digest("hex") !== m.file.sha256) throw new Error("An installer with this version already exists");
  } else fs.renameSync(file, target);
  fs.copyFileSync(path.join(staging, "latest.json"), latest + ".next");
  fs.renameSync(latest + ".next", latest);
  console.log(`Published ${m.version}, ${m.file.size} bytes, SHA256 ${m.file.sha256}`);
}

if (require.main === module) activate(path.resolve(process.argv[2]), path.resolve(process.argv[3])).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { activate };
