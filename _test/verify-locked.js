// 用例：旧 store.json（外挂内核 + 30s/2.5 + 并发 3）经过 load/save 后必须被纠正
const fs = require("node:fs");
const path = require("node:path");
const P = require("../src/paths.js");
const store = require("../src/store.js");

const home = path.join(__dirname, "tmp-store");
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
P.init({ home, resources: path.join(__dirname, "..") });

const legacy = {
  version: 3,
  instances: [{ id: "inst-legacy", name: "老实例", kernel: "external", platform: "dola", url: "https://www.dola.com/" }],
  settings: {
    kernel: "external",
    externalBrowser: "chrome",
    orchestrator: { maxParallel: 3, retryLimit: 2 },
    quota: { perDay: 4, cooldownMin: 0 },
    enhancer: { enabled: false, duration: 30, model: "seedance_v2.0", resolution: "auto" }
  }
};
fs.writeFileSync(path.join(home, "store.json"), JSON.stringify(legacy, null, 2));

store.load();
const s = store.get().settings;
console.log("load 后:", JSON.stringify({
  kernel: s.kernel, externalBrowser: s.externalBrowser, enh: s.enhancer,
  instKernel: store.get().instances[0].kernel
}));
store.save();
const onDisk = JSON.parse(fs.readFileSync(path.join(home, "store.json"), "utf8"));
console.log("落盘 settings:", JSON.stringify(onDisk.settings.enhancer), "kernel:", onDisk.settings.kernel,
  "externalBrowser存在:", Object.prototype.hasOwnProperty.call(onDisk.settings, "externalBrowser"));
console.log("落盘实例 kernel:", onDisk.instances[0].kernel);

// 模拟界面/ REST 强行改成外挂 + 2.0 配 30s，保存后必须被压回
store.get().settings.kernel = "external";
store.get().settings.externalBrowser = "edge";
store.get().settings.enhancer = { enabled: true, duration: 30, model: "seedance_v2.0", resolution: "auto" };
store.save();
const again = JSON.parse(fs.readFileSync(path.join(home, "store.json"), "utf8")).settings;
const ok = again.kernel === "embedded" && !("externalBrowser" in again) &&
  again.enhancer.duration === 15 && again.enhancer.model === "seedance_v2.0" && again.enhancer.enabled === true;
console.log("强制改写后:", JSON.stringify({ kernel: again.kernel, enh: again.enhancer }), ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
