"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const P = require("../src/paths");
const store = require("../src/store");
const brand = require("../src/brand");
const interceptor = require("../src/interceptor");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-branding-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("改名后默认配置和导出文件使用新品牌，内部产品标识保持兼容", () => {
  assert.equal(brand.name, "豆包工坊");
  assert.equal(require("../package.json").productName, brand.name);
  assert.equal(brand.productKey, "infinite-doubao");
  P.init({ home: path.join(root, "fresh") }); store.load();
  assert.match(interceptor.buildFileName({kind:"video"}), /^豆包工坊_/);
  assert.equal(path.basename(path.dirname(P.downloadDir())), "豆包工坊");
});

test("主进程沿用旧用户和会话目录，同时尊重显式 user-data-dir", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const block = source.slice(source.indexOf('if (!app.commandLine.hasSwitch("user-data-dir"))'), source.indexOf('const instances = require'));
  for (const explicit of [false, true]) {
    const calls = [];
    const appData = path.join(root, "Roaming");
    const app = { commandLine: { hasSwitch: () => explicit }, getPath: (name) => { assert.equal(name, "appData"); return appData; }, setPath: (...args) => calls.push(args) };
    vm.runInNewContext(block, { app, path });
    assert.deepEqual(calls, explicit ? [] : [["userData", path.join(appData, "无限豆包")], ["sessionData", path.join(appData, "无限豆包")]]);
  }
});

test("旧版本升级保留账号、模板、附件与原成片目录，迁移只执行一次", () => {
  const originalLegacyDir = P.legacyDownloadDir;
  const oldVideos = path.join(root, "旧成片");
  fs.mkdirSync(oldVideos);
  P.legacyDownloadDir = () => oldVideos;
  try {
    P.init({ home: path.join(root, "legacy") });
    const raw = store.emptyStore();
    delete raw.brandNameMigrated;
    raw.instances = [{ id: "existing-account", name: "已有账号" }];
    const attachment = path.join(P.dir("attachments"), "reference.mp4");
    fs.writeFileSync(attachment, "retained attachment");
    raw.taskTemplates = [{ id: "existing-template", prompt: "原提示词", attachments: [{path:attachment}] }];
    fs.writeFileSync(path.join(oldVideos, "成片.mp4"), "retained video");
    fs.writeFileSync(path.join(P.home(), "store.json"), JSON.stringify(raw));
    const data = store.load();
    assert.equal(data.instances[0].id, "existing-account");
    assert.equal(data.taskTemplates[0].attachments[0].path, attachment);
    assert.equal(data.settings.downloadDir, oldVideos);
    assert.equal(fs.readFileSync(attachment, "utf8"), "retained attachment");
    assert.equal(fs.readFileSync(path.join(oldVideos, "成片.mp4"), "utf8"), "retained video");
    data.settings.downloadDir = "";
    store.save();
    assert.equal(store.load().settings.downloadDir, "");
    raw.settings.downloadDir = path.join(root, "用户自定义目录");
    fs.writeFileSync(path.join(P.home(), "store.json"), JSON.stringify(raw));
    assert.equal(store.load().settings.downloadDir, raw.settings.downloadDir);
  } finally { P.legacyDownloadDir = originalLegacyDir; }
});
