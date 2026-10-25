"use strict";

/**
 * 密钥落盘
 *
 * 对标产品把 Cookie、代理密码、Rose API Key 明文写在配置里（报告 9.4 节），
 * 本机任意程序读一遍 store 就全拿走。这里统一走 Electron safeStorage（DPAPI），
 * 拿不到系统密钥时退化成明文存储并打标记，界面会提示。
 *
 * 存储形态：APP_HOME/secrets.json
 *   { "plain": false, "v": 1, "items": { "cookie.<id>": "<base64 密文>" } }
 */

const fs = require("node:fs");
const path = require("node:path");
const P = require("./paths");

const FILE = () => path.join(P.home(), "secrets.json");

let cache = null;
let plainMode = false;

function safeStorage() {
  try {
    // eslint-disable-next-line global-require
    const { safeStorage } = require("electron");
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === "function") return safeStorage;
  } catch {}
  return null;
}

function read() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    cache = {
      plain: !!raw.plain,
      v: Number(raw.v) || 1,
      items: raw.items && typeof raw.items === "object" ? raw.items : {}
    };
  } catch {
    cache = { plain: false, v: 1, items: {} };
  }
  return cache;
}

function flush() {
  P.ensure();
  const data = read();
  try {
    fs.writeFileSync(FILE(), JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function encrypt(text) {
  const s = safeStorage();
  if (s && s.isEncryptionAvailable()) {
    try { return { plain: false, value: s.encryptString(String(text)).toString("base64") }; } catch {}
  }
  plainMode = true;
  return { plain: true, value: Buffer.from(String(text), "utf8").toString("base64") };
}

function decrypt(item, plain) {
  const buf = Buffer.from(String(item || ""), "base64");
  if (plain) return buf.toString("utf8");
  const s = safeStorage();
  if (!s) return "";
  try { return s.decryptString(buf); } catch { return ""; }
}

function setSecret(scope, key, value) {
  const data = read();
  const k = `${scope}.${key}`;
  if (value === null || value === undefined || value === "") {
    delete data.items[k];
    flush();
    return true;
  }
  const enc = encrypt(value);
  data.items[k] = enc.value;
  data.plain = data.plain || enc.plain;
  plainMode = enc.plain;
  flush();
  return true;
}

function getSecret(scope, key) {
  const data = read();
  const v = data.items[`${scope}.${key}`];
  if (!v) return "";
  return decrypt(v, data.plain);
}

function removeSecret(scope, key) {
  return setSecret(scope, key, null);
}

/** 批量读某 scope 下所有 key（不返回值，只列 key，界面用） */
function listKeys(scope) {
  const data = read();
  const prefix = `${scope}.`;
  return Object.keys(data.items).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

function status() {
  const s = safeStorage();
  const ok = !!(s && s.isEncryptionAvailable());
  return {
    encrypted: ok && !read().plain,
    backend: ok ? "safeStorage(DPAPI)" : "plain",
    warning: plainMode || read().plain ? "当前环境拿不到系统密钥，密钥以明文保存，建议在正式机器上重新录入" : ""
  };
}

module.exports = { setSecret, getSecret, removeSecret, listKeys, status };
