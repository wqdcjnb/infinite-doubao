"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = "D:\\Project\\DolaMod\\_test";

http.createServer((req, res) => {
  const rel = decodeURIComponent(String(req.url || "/").split("?")[0]);

  // 回显请求头：用来核对 sec-ch-ua / accept-language 与页面 JS 是否一致
  if (rel === "/echo") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(req.headers, null, 2));
    return;
  }

  const file = path.join(ROOT, rel === "/" ? "fp.html" : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("no"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(buf);
  });
}).listen(8899, "127.0.0.1", () => process.stdout.write("probe 8899\n"));
