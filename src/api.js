"use strict";

/**
 * 接口层：REST + SSE + MCP 共用一套业务函数
 *
 * 每个 handler 都只调 src/ 下的模块，不直接碰窗口 —— 这样 CLI、界面、MCP 三条入口
 * 行为完全一致，不会出现「界面能派、接口派不了」的分叉。
 */

const path = require("node:path");
const fs = require("node:fs");
const { session } = require("electron");
const store = require("./store");
const instances = require("./instances");
const quota = require("./quota");
const storyboard = require("./storyboard");
const assets = require("./assets");
const interceptor = require("./interceptor");
const orchestrator = require("./orchestrator");
const accountProbe = require("./account-probe");
const fpCheck = require("./fp-check");
const jianying = require("./jianying");
const zizi = require("./zizi");
const update = require("./update");
const chromium = require("./chromium");
const driverMod = require("./driver");
const markdown = require("./markdown");
const P = require("./paths");
const log = require("./logger");

let deps = {};

function init(d) {
  deps = { ...deps, ...(d || {}) };
}

function parseProxyList(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = raw.split(/[,\s|]+/).filter(Boolean);
    let url = "";
    let label = "";
    if (/^[a-z0-9]+:\/\//i.test(parts[0]) || /^[\w.-]+:\d+$/.test(parts[0])) url = parts[0];
    else if (parts.length >= 2 && /^\d+$/.test(parts[1])) url = `${parts[0]}:${parts[1]}`;
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
      // host port user pass
      url = `${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
      label = parts[4] || "";
    } else if (parts.length >= 3 && !/^\d+$/.test(parts[2])) {
      label = parts.slice(2).join(" ");
    }
    if (!url) continue;
    out.push({ url, label });
  }
  return out;
}

async function testProxy(proxy) {
  const url = String((proxy && (proxy.url || proxy)) || "");
  if (!url) return { ok: false, message: "没有代理地址" };
  const parsed = require("./session").parseProxyUrl(url);
  if (!parsed) return { ok: false, message: "代理地址格式不对" };
  const started = Date.now();
  return new Promise((resolve) => {
    const net = require("node:net");
    const socket = net.connect({ host: parsed.host, port: Number(parsed.port) }, () => {
      const ms = Date.now() - started;
      socket.destroy();
      resolve({ ok: true, latency: ms, host: parsed.host, port: parsed.port, protocol: parsed.protocol });
    });
    socket.setTimeout(8000, () => { socket.destroy(); resolve({ ok: false, message: "连接超时" }); });
    socket.on("error", (error) => resolve({ ok: false, message: String(error && error.message) }));
  });
}

function setup(server) {
  /* ---------------- 基础 ---------------- */

  server.get("/api/state", (c) => {
    c.ok({
      brand: require("./brand"),
      settings: store.get().settings,
      orchestrator: orchestrator.state(),
      quota: quota.snapshot(),
      chromium: chromium.status(),
      counts: {
        instances: store.get().instances.length,
        storyboards: store.get().storyboards.length,
        tasks: store.get().tasks.length,
        assets: Object.values(store.get().assets).reduce((n, arr) => n + (arr ? arr.length : 0), 0),
        resources: interceptor.list({ limit: 999 }).length
      }
    });
  });

  server.get("/api/paths", (c) => c.ok({ paths: P.all(store.get().settings.downloadDir), api: server.info() }));

  // /api/server：本地服务自身的信息（地址 / 端口 / token 文件 / 启动时间）
  server.get("/api/server", (c) => c.ok(server.info()));

  server.post("/api/token/rotate", (c) => c.ok(server.rotateToken()));

  server.get("/api/logs", (c) => c.ok({ items: log.recent(Number(c.query.limit) || 200, c.query.q || "") }));

  /* ---------------- 实例 ---------------- */

  server.get("/api/instances", (c) => c.ok({ items: instances.list().map((i) => ({ ...i, quota: quota.get(i.id) })) }));

  server.get("/api/platforms", (c) => c.ok({ items: instances.PLATFORMS }));

  server.post("/api/instances", (c) => {
    const inst = instances.create(c.body || {});
    return c.json(201, inst);
  });

  server.patch("/api/instances/:id", (c) => {
    const inst = instances.update(c.params.id, c.body || {});
    return inst ? c.ok(inst) : c.fail(404, "实例不存在");
  });

  server.del("/api/instances/:id", (c) => {
    const inst = instances.remove(c.params.id);
    return inst ? c.ok(inst) : c.fail(404, "实例不存在");
  });

  server.post("/api/instances/reorder", (c) => c.ok({ order: instances.reorder((c.body && c.body.ids) || []) }));

  server.post("/api/instances/:id/regenerate-fp", (c) => {
    const fp = instances.regenerateFingerprint(c.params.id);
    return fp ? c.ok({ fingerprint: fp }) : c.fail(404, "实例不存在");
  });

  server.post("/api/instances/:id/probe", async (c) => {
    const inst = store.find(c.params.id);
    if (!inst) return c.fail(404, "实例不存在");
    const r = await accountProbe.probe(inst, { session: session.fromPartition(inst.partition) });
    return c.ok(r);
  });

  // 指纹体检：把页面实际值与档案逐项对照，三个入口（界面 / REST / MCP）同一套判定
  server.post("/api/instances/:id/fp-check", async (c) => {
    const inst = store.find(c.params.id);
    if (!inst) return c.fail(404, "实例不存在");
    const actual = await fpCheck.read({ instance: inst });
    return c.ok(fpCheck.compare(inst.fingerprint || {}, actual));
  });

  server.post("/api/instances/probe-all", async (c) => c.ok({ items: await accountProbe.probeAll() }));

  server.post("/api/instances/:id/cookie", async (c) => {
    const inst = store.find(c.params.id);
    if (!inst) return c.fail(404, "实例不存在");
    const text = (c.body && (c.body.text || c.body.cookie)) || "";
    const list = instances.parseCookies(text);
    if (!list.length) return c.fail(400, "没解析出任何 cookie");
    const n = await require("./session").injectCookie(inst, list);
    return c.ok({ injected: n, total: list.length });
  });

  server.get("/api/instances/:id/cookie", async (c) => {
    const inst = store.find(c.params.id);
    if (!inst) return c.fail(404, "实例不存在");
    const list = await require("./session").readCookies(inst, c.query.domain);
    return c.ok({ items: list, header: instances.cookieHeaderOf(list) });
  });

  server.post("/api/instances/:id/login", async (c) => {
    const inst = store.find(c.params.id);
    if (!inst) return c.fail(404, "实例不存在");
    const body = c.body || {};
    const result = await require("./login").login(inst, { account: body.account, password: body.password }, {
      webContents: deps.findWebContents ? deps.findWebContents(inst) : null,
      onEvent: (e) => { try { deps.notify && deps.notify("login:event", e); } catch {} }
    });
    return c.ok(result);
  });

  /* ---------------- 内核（写死内嵌，不开外部进程） ---------------- */

  server.get("/api/kernel/status", (c) => c.ok(chromium.status()));

  // 这两个入口以前是「启动外挂 Chrome 再返回 CDP 地址」。内核写死内嵌后，
  // 页面由主窗口的 webview 承载，它们只回报该实例当前打开页面的地址。
  const embeddedOpen = async (c) => {
    const inst = store.find(c.params.id);
    if (!inst) return c.fail(404, "实例不存在");
    const wc = deps.findWebContents ? deps.findWebContents(inst) : null;
    if (!wc) return c.fail(409, "该实例还没有在主窗口打开");
    const drv = await driverMod.open(inst, { webContents: wc });
    return c.ok({ kernel: "embedded", instanceId: inst.id, url: await drv.url() });
  };

  server.post("/api/instances/:id/kernel/start", embeddedOpen);

  server.post("/api/instances/:id/kernel/stop", (c) => c.ok({ stopped: false }));

  // 别名：/open 与 /kernel/start 等价，语义更直白（打开这个环境的可控页面）
  server.post("/api/instances/:id/open", embeddedOpen);

  /* ---------------- 代理 ---------------- */

  server.post("/api/proxies/test", async (c) => c.ok(await testProxy(c.body || {})));

  server.post("/api/proxies/parse", (c) => c.ok({ items: parseProxyList((c.body && c.body.text) || "") }));

  server.get("/api/proxies", (c) => c.ok({ items: store.get().proxies }));

  server.post("/api/proxies", (c) => {
    const list = parseProxyList((c.body && c.body.text) || "");
    store.get().proxies = list;
    store.save();
    return c.ok({ items: list });
  });

  /* ---------------- 分镜 ---------------- */

  server.get("/api/storyboards", (c) => c.ok({ items: storyboard.list() }));

  server.post("/api/storyboards", (c) => c.json(201, storyboard.create(c.body || {})));

  server.get("/api/storyboards/:id", (c) => {
    const sb = storyboard.get(c.params.id);
    return sb ? c.ok({ storyboard: sb, stats: storyboard.stats(sb) }) : c.fail(404, "分镜不存在");
  });

  server.patch("/api/storyboards/:id", (c) => {
    const sb = storyboard.update(c.params.id, c.body || {});
    return sb ? c.ok(sb) : c.fail(404, "分镜不存在");
  });

  server.del("/api/storyboards/:id", (c) => {
    const sb = storyboard.remove(c.params.id);
    return sb ? c.ok({ removed: sb.id }) : c.fail(404, "分镜不存在");
  });

  server.post("/api/storyboards/import", (c) => {
    const body = c.body || {};
    const text = body.text || "";
    if (!text.trim()) return c.fail(400, "没有内容");
    const r = storyboard.importMarkdown(body.name, text);
    return c.json(201, r);
  });

  server.get("/api/storyboards/:id/export", (c) => {
    const text = storyboard.exportMarkdown(c.params.id);
    if (!text) return c.fail(404, "分镜不存在");
    c.res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    c.res.end(text);
  });

  server.post("/api/storyboards/:id/start", (c) => c.ok(orchestrator.start(c.params.id, c.body || {})));

  server.post("/api/storyboards/:id/stop", (c) => c.ok(orchestrator.stop(c.params.id)));

  server.post("/api/storyboards/:id/pause", (c) => c.ok(orchestrator.pause(c.params.id)));

  server.post("/api/storyboards/:id/resume", (c) => c.ok(orchestrator.resume(c.params.id, c.body || {})));

  server.post("/api/storyboards/:id/reset", (c) => {
    const r = storyboard.resetShots(c.params.id, (c.body && c.body.statuses) || undefined);
    return r ? c.ok(r) : c.fail(404, "分镜不存在");
  });

  server.post("/api/storyboards/:id/shots", (c) => {
    const sb = storyboard.addShots(c.params.id, (c.body && c.body.shots) || []);
    return sb ? c.ok(sb) : c.fail(404, "分镜不存在");
  });

  server.patch("/api/storyboards/:id/shots/:shotId", (c) => {
    const shot = storyboard.updateShot(c.params.id, c.params.shotId, c.body || {});
    return shot ? c.ok(shot) : c.fail(404, "镜头不存在");
  });

  server.del("/api/storyboards/:id/shots/:shotId", (c) => {
    const shot = storyboard.removeShot(c.params.id, c.params.shotId);
    return shot ? c.ok(shot) : c.fail(404, "镜头不存在");
  });

  server.post("/api/storyboards/:id/check", (c) => {
    const sb = storyboard.get(c.params.id);
    if (!sb) return c.fail(404, "分镜不存在");
    return c.ok({ items: zizi.checkShots(sb.shots) });
  });

  /* ---------------- 任务 ---------------- */

  server.get("/api/tasks", (c) => c.ok({ items: orchestrator.taskList(c.query) }));

  server.get("/api/tasks/:id", (c) => {
    const t = orchestrator.getTask(c.params.id);
    return t ? c.ok(t) : c.fail(404, "任务不存在");
  });

  server.post("/api/tasks/:id/retry", async (c) => c.ok(await orchestrator.retryTask(c.params.id, c.body || {})));

  server.post("/api/tasks/:id/redispatch", async (c) => {
    const body = c.body || {};
    return c.ok(await orchestrator.redispatch(c.params.id, body.instanceId));
  });

  server.post("/api/orchestrator/dispatch", async (c) => {
    const body = c.body || {};
    return c.ok(await orchestrator.dispatchOne(body.storyboardId, body));
  });

  server.post("/api/orchestrator/stop-all", (c) => c.ok(orchestrator.stopAll(c.body || {})));

  server.post("/api/orchestrator/pause", (c) => c.ok(orchestrator.pause("")));

  server.post("/api/orchestrator/resume", (c) => c.ok(orchestrator.resume((c.body && c.body.storyboardId) || "", c.body || {})));

  /* ---------------- 额度 ---------------- */

  server.get("/api/quota", (c) => c.ok({ items: quota.snapshot(), limits: quota.limits() }));

  server.post("/api/quota/:id/cool", (c) => c.ok(quota.cool(c.params.id, (c.body && c.body.minutes) || 0, "手动冷却")));

  server.post("/api/quota/:id/reset", (c) => c.ok(quota.reset(c.params.id)));

  server.post("/api/quota/:id/used", (c) => c.ok(quota.setUsed(c.params.id, (c.body && c.body.kind) || "video", (c.body && c.body.value) || 0)));

  /* ---------------- 素材 ---------------- */

  server.get("/api/assets", (c) => c.ok({ items: assets.list(c.query.kind) }));

  server.post("/api/assets", (c) => {
    const body = c.body || {};
    return c.json(201, assets.add(body.kind, body));
  });

  server.patch("/api/assets/:kind/:id", (c) => {
    const r = assets.update(c.params.kind, c.params.id, c.body || {});
    return r ? c.ok(r) : c.fail(404, "素材不存在");
  });

  server.del("/api/assets/:kind/:id", (c) => {
    const r = assets.remove(c.params.kind, c.params.id);
    return r ? c.ok(r) : c.fail(404, "素材不存在");
  });

  server.post("/api/assets/grid", async (c) => {
    const body = c.body || {};
    const r = await assets.grid(body.files || [], body.out, body);
    return r.ok ? c.ok(r) : c.fail(400, r.message, r);
  });

  server.post("/api/prompt/resolve", (c) => {
    const body = c.body || {};
    const sb = body.storyboardId ? storyboard.get(body.storyboardId) : null;
    const shot = sb ? sb.shots.find((s) => s.id === body.shotId) : body.shot;
    if (!shot) return c.fail(404, "镜头不存在");
    return c.ok(assets.resolveShotPrompt(shot, body));
  });

  /* ---------------- 取源与下载 ---------------- */

  server.get("/api/resources", (c) => c.ok({ items: interceptor.list(c.query) }));

  server.post("/api/resources/clear", (c) => c.ok({ removed: interceptor.clear(c.body || {}) }));

  server.post("/api/resources/download", async (c) => {
    const body = c.body || {};
    // push 内部会统一把 lr/lv=watermark 改写成 unwatermarked；download 默认先请求无水印地址
    const item = interceptor.get(body.id) || interceptor.push({ url: body.url, rawUrl: body.url, from: "api" });
    if (!item) return c.fail(400, "没有可下载的地址");
    const inst = store.find(body.instanceId || item.instanceId) || store.get().instances[0];
    if (!inst) return c.fail(400, "没有实例可用于下载（下载需要登录态）");
    const ses = session.fromPartition(inst.partition);
    const r = await interceptor.download(ses, item, body);
    return r && r.ok === false ? c.fail(500, r.message || "下载失败") : c.ok(r);
  });

  // 别名：/api/resources/:id/download —— 资源 id 放路径里，跟其它资源接口保持一致
  server.post("/api/resources/:id/download", async (c) => {
    const item = interceptor.get(c.params.id);
    if (!item) return c.fail(404, "资源不存在");
    const body = c.body || {};
    const inst = store.find(body.instanceId || item.instanceId) || store.get().instances[0];
    if (!inst) return c.fail(400, "没有实例可用于下载（下载需要登录态）");
    const r = await interceptor.download(session.fromPartition(inst.partition), item, {
      ...body,
      dir: store.get().settings.downloadDir || undefined,
      naming: store.get().settings.naming,
      namingTemplate: store.get().settings.namingTemplate,
      instance: inst
    });
    return r && r.ok === false ? c.fail(500, r.message || "下载失败") : c.ok(r);
  });

  server.post("/api/resources/scan", async (c) => {
    const body = c.body || {};
    const inst = store.find(body.instanceId);
    if (!inst) return c.fail(404, "实例不存在");
    const ses = session.fromPartition(inst.partition);
    const n = await interceptor.scanUrl(ses, body.url, { instanceId: inst.id, instanceName: inst.name });
    return c.ok({ found: n });
  });

  /* ---------------- 剪映 ---------------- */

  server.get("/api/jianying/drafts", (c) => c.ok({ items: jianying.listDrafts(c.query.dir) }));

  server.post("/api/jianying/draft", async (c) => {
    const body = c.body || {};
    const r = await jianying.createDraft(body);
    return r.ok ? c.ok(r) : c.fail(400, r.message, r);
  });

  /* ---------------- 文案 ---------------- */

  server.post("/api/prompt/check", (c) => c.ok(zizi.check((c.body && c.body.text) || "")));

  server.post("/api/prompt/appeal", (c) => c.ok({ script: zizi.appealScript(c.body || {}) }));

  server.post("/api/prompt/soften", (c) => c.ok({ text: zizi.soften((c.body && c.body.text) || "") }));

  /* ---------------- 更新 ---------------- */

  server.get("/api/update/check", async (c) => c.ok(await update.check({ url: c.query.url })));

  /* ---------------- 设置 ---------------- */

  server.get("/api/settings", (c) => c.ok(store.get().settings));

  server.patch("/api/settings", (c) => {
    store.get().settings = { ...store.get().settings, ...(c.body || {}) };
    store.save();
    return c.ok(store.get().settings);
  });

  /* ---------------- 文件 ---------------- */

  server.get("/api/fs/list", (c) => {
    const dir = String(c.query.dir || P.dir("exports"));
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
        name: d.name,
        dir: d.isDirectory(),
        path: path.join(dir, d.name)
      }));
      return c.ok({ dir, items });
    } catch (error) {
      return c.fail(400, String(error && error.message));
    }
  });

  server.post("/api/fs/open", (c) => {
    const target = String((c.body && c.body.path) || "");
    if (!target) return c.fail(400, "没有路径");
    const { shell } = require("electron");
    const stat = fs.existsSync(target) && fs.statSync(target);
    if (stat && stat.isDirectory()) shell.openPath(target);
    else shell.showItemInFolder(target);
    return c.ok({ opened: target });
  });

  return server;
}

module.exports = { setup, init, parseProxyList, testProxy };
