"use strict";

// 只服务发布目录中的版本清单和安装包，不提供上传、目录列表或用户数据访问。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream");

function createServer(root) {
  return http.createServer((req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
    let name;
    try { name = decodeURIComponent(new URL(req.url, "http://localhost").pathname).slice(1); }
    catch { res.writeHead(400); return res.end(); }
    if (!/^latest(?:-darwin-(?:arm64|x64))?\.json$/.test(name) && !/^DoubaoWorkshop-\d+\.\d+\.\d+-(?:Setup\.exe|mac-(?:arm64|x64)\.dmg)$/.test(name) && !/^DoubaoWorkshop-MediaTools-\d+\.\d+\.\d+-(?:win32-x64|darwin-(?:arm64|x64))\.tar\.gz$/.test(name)) { res.writeHead(404); return res.end(); }
    const file = path.join(root, name);
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        "Content-Type": name.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": name.endsWith(".json") ? "no-store" : "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff"
      });
      if (req.method === "HEAD") return res.end();
      pipeline(fs.createReadStream(file), res, () => {});
    });
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const root = path.resolve(value("--root", path.join(__dirname, "public")));
  const host = value("--host", "10.1.11.88");
  const port = Number(value("--port", "17824"));
  createServer(root).listen(port, host, () => console.log(`Doubao Workshop updates: http://${host}:${port}/latest.json`));
}

module.exports = { createServer };
