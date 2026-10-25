import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export function splitComponents({ resources, out, version, platform = process.platform, arch = process.arch }) {
  const root = path.resolve(resources);
  const required = platform === "win32" ? ["python/python.exe", "tools/ffmpeg.exe"] : ["python/bin/python3", "tools/ffmpeg", "tools/ffprobe"];
  for (const file of required) if (!fs.existsSync(path.join(root, file))) throw new Error("Missing component tool: " + file);
  const content = crypto.createHash("sha256");
  function hashTree(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      content.update(path.relative(root, file).replace(/\\/g, "/") + "\0");
      if (stat.isSymbolicLink()) content.update("link:" + fs.readlinkSync(file));
      else if (stat.isDirectory()) hashTree(file);
      else content.update(crypto.createHash("sha256").update(fs.readFileSync(file)).digest());
    }
  }
  for (const dir of ["python", "tools"]) hashTree(path.join(root, dir));
  const name = `DoubaoWorkshop-MediaTools-${version}-${platform}-${arch}.tar.gz`;
  const archive = path.resolve(out, name);
  const tar = platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
  execFileSync(tar, ["-czf", archive, "-C", root, "python", "tools"], { stdio: "inherit", windowsHide: true });
  const manifest = { id: content.digest("hex"), release: version, platform, arch,
    file: { name, size: fs.statSync(archive).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex") } };
  const json = JSON.stringify(manifest, null, 2) + "\n";
  fs.writeFileSync(path.join(root, "optional-components.json"), json);
  fs.writeFileSync(path.join(out, `components-${platform}-${arch}.json`), json);
  for (const dir of ["python", "tools"]) {
    const target = path.resolve(root, dir);
    if (path.dirname(target) !== root) throw new Error("Unsafe component path");
    fs.rmSync(target, { recursive: true, force: true });
  }
  console.log(`Optional media tools: ${(manifest.file.size / 1048576).toFixed(1)} MiB, excluded from main installer`);
  return manifest;
}
