import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (flag, fallback = "") => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const installer = arg("--installer");
if (!installer) throw new Error("Usage: node build/publish-update.mjs --installer <Setup.exe> --notes-file <release-notes.txt> [--upload]");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Use a stable x.y.z release version");
const keyFile = arg("--key", process.env.DOLAMOD_UPDATE_KEY || path.join(process.env.LOCALAPPDATA, "DoubaoWorkshopPublisher", "update-private.pem"));
const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
const publicKey = fs.readFileSync(path.join(root, "src", "update-public-key.pem"));
const proof = Buffer.from("doubao-update-publisher");
if (!crypto.verify(null, proof, publicKey, crypto.sign(null, proof, key))) throw new Error("Publishing key does not match the key embedded in clients");
const hash = crypto.createHash("sha256");
for await (const chunk of fs.createReadStream(installer)) hash.update(chunk);
const name = `DoubaoWorkshop-${version}-Setup.exe`;
const manifest = { version, platform: "win32", arch: "x64", publishedAt: new Date().toISOString(),
  notes: arg("--notes-file") ? fs.readFileSync(arg("--notes-file"), "utf8").trim() : "修复与改进，请安装最新版本。",
  file: { url: name, size: fs.statSync(installer).size, sha256: hash.digest("hex") } };
const signed = { ...manifest, sig: crypto.sign(null, Buffer.from(JSON.stringify(manifest)), key).toString("base64") };
const out = path.resolve(arg("--out", path.join(root, "build", "lan-update-release", version)));
fs.mkdirSync(out, { recursive: true });
if (path.resolve(installer) !== path.join(out, name)) fs.copyFileSync(installer, path.join(out, name));
fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(signed, null, 2) + "\n");
fs.writeFileSync(path.join(out, "SHA256SUMS.txt"), `${manifest.file.sha256}  ${name}\n`);
console.log(`Signed update bundle: ${out}`);

if (args.includes("--upload")) {
  const host = arg("--host", "codex-10-1-11-88");
  const remoteRoot = "C:/ProgramData/DoubaoWorkshopUpdates";
  const stage = `${remoteRoot}/incoming/${version}-${crypto.randomUUID()}`;
  const run = (exe, values) => execFileSync(exe, values, { stdio: "inherit", windowsHide: true });
  const remote = (script) => run("ssh", ["-o", "BatchMode=yes", host, "powershell -NoProfile -NonInteractive -EncodedCommand " + Buffer.from("$ErrorActionPreference='Stop'; " + script, "utf16le").toString("base64")]);
  remote(`New-Item -ItemType Directory -Path '${stage}' -Force | Out-Null`);
  for (const file of [name, "latest.json"]) run("scp", ["-q", "-o", "BatchMode=yes", path.join(out, file), `${host}:${stage}/${file}`]);
  remote(`& node '${remoteRoot}/activate-update.cjs' '${remoteRoot}' '${stage}'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
  const response = await fetch("http://10.1.11.88:17824/latest.json", { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`LAN verification failed: HTTP ${response.status}`);
  const actual = await response.json();
  if (actual.sig !== signed.sig) throw new Error("LAN server did not return the newly published manifest");
  console.log(`LAN release verified: ${version}`);
}
