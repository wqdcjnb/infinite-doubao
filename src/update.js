"use strict";

/**
 * 更新检查
 *
 * 对标产品的更新流程有两个洞：latest_version.json 与包哈希来自同一个源、且不验 Authenticode，
 * 中间人换掉 json 和包就能推任意程序。这里的规矩：
 *   1) 清单必须带 Ed25519 签名，用内置公钥验，签不过直接拒；
 *   2) 包哈希写在**已签名**的清单里，下载完先比大小再比 sha256；
 *   3) 只落盘到 updates/ 目录，不自动执行；交给用户点「安装」。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const P = require("./paths");
const log = require("./logger");

const DEFAULT_MANIFEST = "https://example.invalid/infinite-doubao/latest.json";

/** 更新清单验签公钥（私钥只留在发布机上，永不进客户端） */
const MANIFEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGZ0Xo3Yv0fQ0mJ3o8v9w2T1p4zK7lLq2n3r5s6u7v8A=
-----END PUBLIC KEY-----`;

function verifyManifest(manifest, publicKeyPem) {
  if (!manifest || typeof manifest !== "object") return { ok: false, reason: "清单为空" };
  const { sig, ...rest } = manifest;
  if (!sig) return { ok: false, reason: "清单没有签名" };
  try {
    const ok = crypto.verify(null, Buffer.from(JSON.stringify(rest)), publicKeyPem || MANIFEST_PUBLIC_KEY_PEM, Buffer.from(sig, "base64"));
    if (!ok) return { ok: false, reason: "清单签名不匹配" };
  } catch (error) {
    return { ok: false, reason: `验签异常：${String(error && error.message)}` };
  }
  return { ok: true, manifest: rest };
}

function cmpVersion(a, b) {
  const pa = String(a || "0").split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchManifest(url) {
  const target = String(url || DEFAULT_MANIFEST);
  const res = await fetch(target, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`清单拉取失败 HTTP ${res.status}`);
  return await res.json();
}

async function check(opts = {}) {
  const currentVersion = require("./brand").version;
  const store = require("./store");
  const url = opts.url || (store.get().settings || {}).updateUrl || process.env.DOLAMOD_UPDATE_URL || DEFAULT_MANIFEST;
  // 没配更新源时不要真的去连 example.invalid，直接把结论说清楚
  if (!url || /example\.invalid|^https?:\/\/(localhost|127\.0\.0\.1)\/?$/i.test(url)) {
    return { ok: false, reason: "还没有配置更新源（设置 → 更新源填一个签名清单地址）", stage: "config", current: currentVersion };
  }
  try {
    const raw = await fetchManifest(url);
    const v = verifyManifest(raw, opts.publicKey);
    if (!v.ok) {
      log.warn("update-manifest-invalid", { reason: v.reason });
      return { ok: false, reason: v.reason, stage: "verify" };
    }
    const m = v.manifest;
    const latest = String(m.version || "0.0.0");
    const hasUpdate = cmpVersion(latest, currentVersion) > 0;
    return {
      ok: true,
      current: currentVersion,
      latest,
      hasUpdate,
      notes: String(m.notes || ""),
      publishedAt: String(m.publishedAt || ""),
      file: m.file ? { url: String(m.file.url || ""), sha256: String(m.file.sha256 || ""), size: Number(m.file.size) || 0 } : null,
      mandatory: !!m.mandatory
    };
  } catch (error) {
    return { ok: false, reason: String(error && error.message), stage: "fetch" };
  }
}

async function download(info, onProgress) {
  if (!info || !info.file || !info.file.url) return { ok: false, reason: "清单里没有可用安装包" };
  const dir = path.join(P.dir("updates"));
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(new URL(info.file.url).pathname) || `infinite-doubao-${info.latest}.zip`;
  const target = path.join(dir, name);

  const res = await fetch(info.file.url);
  if (!res.ok) return { ok: false, reason: `下载失败 HTTP ${res.status}` };
  const total = Number(res.headers.get("content-length")) || info.file.size || 0;
  const hash = crypto.createHash("sha256");
  const chunks = [];
  let received = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    hash.update(chunk);
    received += chunk.length;
    if (info.file.size && received > info.file.size * 1.05) return { ok: false, reason: "包体积超预期，疑似被替换" };
    if (typeof onProgress === "function") onProgress({ received, total });
  }
  const buf = Buffer.concat(chunks);
  if (info.file.size && buf.length !== info.file.size) return { ok: false, reason: `包大小不符（${buf.length} != ${info.file.size}）` };
  const digest = hash.digest("hex");
  if (info.file.sha256 && digest.toLowerCase() !== String(info.file.sha256).toLowerCase()) {
    return { ok: false, reason: "sha256 不符，已丢弃" };
  }
  fs.writeFileSync(target, buf);
  log.info("update-downloaded", { target, size: buf.length });
  return { ok: true, file: target, size: buf.length, sha256: digest };
}

module.exports = { check, download, verifyManifest, cmpVersion };
