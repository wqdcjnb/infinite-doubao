const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const tests = fs.readdirSync(__dirname).filter((name) => name.endsWith(".test.js")).sort().map((name) => path.join(__dirname, name));
const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
