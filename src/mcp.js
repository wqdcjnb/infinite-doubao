"use strict";

/**
 * MCP 服务（Model Context Protocol）
 *
 * 对标产品也提供了 MCP，但它与本机 REST 共用同一个无鉴权端口。这里的 MCP 走同一套
 * Bearer token 校验（在 http.js 里统一拦），并按 MCP 规范返回 tools/list、tools/call。
 *
 * 传输：POST /mcp（JSON-RPC 2.0，单次响应）+ GET /mcp/sse（事件流，配合 POST 使用）。
 */

const store = require("./store");
const instances = require("./instances");
const quota = require("./quota");
const storyboard = require("./storyboard");
const assets = require("./assets");
const interceptor = require("./interceptor");
const orchestrator = require("./orchestrator");
const accountProbe = require("./account-probe");
const jianying = require("./jianying");
const zizi = require("./zizi");
const chromium = require("./chromium");
const log = require("./logger");

const PROTOCOL = "2024-11-05";

/** 找到某个实例对应的内嵌 webview 的 webContents（与 main.js 同一套判定） */
function findWebContents(inst) {
  if (!inst) return null;
  let target = null;
  try { target = require("electron").session.fromPartition(inst.partition); } catch { return null; }
  for (const wc of require("electron").webContents.getAllWebContents()) {
    try {
      if (wc.getType() !== "webview") continue;
      if (wc.session === target) return wc;
    } catch {}
  }
  return null;
}

function tools() {
  const def = (name, description, properties = {}, required = []) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required }
  });
  return [
    def("state", "查看整体状态：实例数、分镜数、任务队列、并发", {}),
    def("list_instances", "列出所有实例（环境）：名称、平台、内核、今日额度、登录态", {}),
    def("create_instance", "新建一个实例", {
      name: { type: "string" }, platform: { type: "string" },
      url: { type: "string" }, proxyUrl: { type: "string" }
    }),
    def("probe_instance", "探活某个实例的登录态", { instanceId: { type: "string" } }, ["instanceId"]),
    def("fp_check", "指纹体检：把页面实际指纹与本地档案逐项对照", { instanceId: { type: "string" } }, ["instanceId"]),
    def("open_instance", "在内置内核里打开实例并返回当前页面地址", { instanceId: { type: "string" }, visible: { type: "boolean" } }, ["instanceId"]),
    def("list_storyboards", "列出分镜稿", {}),
    def("create_storyboard", "新建分镜稿", { name: { type: "string" }, shots: { type: "array", items: { type: "object" } } }, ["name"]),
    def("import_storyboard", "从 Markdown 表格导入分镜", { name: { type: "string" }, text: { type: "string" } }, ["name", "text"]),
    def("start_storyboard", "开始批量派发某个分镜", { storyboardId: { type: "string" } }, ["storyboardId"]),
    def("stop_storyboard", "停止某个分镜的派发", { storyboardId: { type: "string" } }, ["storyboardId"]),
    def("storyboard_status", "查看分镜进度与统计", { storyboardId: { type: "string" } }, ["storyboardId"]),
    def("list_tasks", "列出任务（可按分镜/实例/状态过滤）", { storyboardId: { type: "string" }, instanceId: { type: "string" }, status: { type: "string" }, limit: { type: "number" } }),
    def("retry_task", "重试一个失败任务", { taskId: { type: "string" } }, ["taskId"]),
    def("get_quota", "查看每个实例的今日额度与冷却状态", {}),
    def("list_resources", "列出拦截到的媒资（视频/图片/音频）；unwatermarked=true 只看已确认无水印的", { kind: { type: "string" }, unwatermarked: { type: "boolean" }, limit: { type: "number" } }),
    def("download_resource", "下载一个拦截到的媒资到本地（默认先取无水印源，拿不到才回退带水印版）", { id: { type: "string" }, instanceId: { type: "string" } }, ["id"]),
    def("prompt_check", "提交前自检提示词的合规风险", { text: { type: "string" } }, ["text"]),
    def("appeal_script", "生成申诉文案", { kind: { type: "string" }, shotTitle: { type: "string" }, prompt: { type: "string" } }),
    def("list_assets", "列出素材卡片（人物/场景/道具/音色）", { kind: { type: "string" } }),
    def("jianying_draft", "把成片导出成剪映草稿", { name: { type: "string" }, storyboardId: { type: "string" }, files: { type: "array", items: { type: "string" } }, ratio: { type: "string" } }, []),
    def("list_logs", "查看最近日志", { limit: { type: "number" }, q: { type: "string" } })
  ];
}

async function callTool(name, args = {}) {
  switch (name) {
    case "state":
      return {
        brand: (() => { const b = require("./brand"); return { name: b.name, version: b.version }; })(),
        instances: store.get().instances.length,
        storyboards: store.get().storyboards.length,
        tasks: store.get().tasks.length,
        orchestrator: orchestrator.state(),
        chromium: chromium.status()
      };
    case "list_instances":
      return instances.list().map((i) => ({
        id: i.id, name: i.name, platform: i.platform, kernel: i.kernel, url: i.url,
        group: i.group, quota: quota.get(i.id), login: i.login || null
      }));
    case "create_instance":
      return instances.create(args);
    case "probe_instance": {
      const { session } = require("electron");
      const inst = store.find(args.instanceId);
      if (!inst) throw new Error("实例不存在");
      return accountProbe.probe(inst, { session: session.fromPartition(inst.partition) });
    }
    case "fp_check": {
      const fpCheck = require("./fp-check");
      const inst = store.find(args.instanceId);
      if (!inst) throw new Error("实例不存在");
      const actual = await fpCheck.read({ instance: inst });
      return fpCheck.compare(inst.fingerprint || {}, actual);
    }
    case "open_instance": {
      const inst = store.find(args.instanceId);
      if (!inst) throw new Error("实例不存在");
      const wc = findWebContents(inst);
      if (!wc) throw new Error("该实例还没有在主窗口打开，先在界面里点开它");
      const { open } = require("./driver");
      const drv = await open(inst, { webContents: wc });
      return { ok: true, kernel: "embedded", url: await drv.url() };
    }
    case "list_storyboards":
      return storyboard.list();
    case "create_storyboard":
      return storyboard.create(args);
    case "import_storyboard":
      return storyboard.importMarkdown(args.name, args.text);
    case "start_storyboard":
      return orchestrator.start(args.storyboardId, args);
    case "stop_storyboard":
      return orchestrator.stop(args.storyboardId);
    case "storyboard_status": {
      const sb = storyboard.get(args.storyboardId);
      if (!sb) throw new Error("分镜不存在");
      return { storyboard: sb, stats: storyboard.stats(sb), tasks: orchestrator.taskList({ storyboardId: sb.id, limit: 50 }) };
    }
    case "list_tasks":
      return orchestrator.taskList(args);
    case "retry_task":
      return orchestrator.retryTask(args.taskId, args);
    case "get_quota":
      return { items: quota.snapshot(), limits: quota.limits() };
    case "list_resources":
      return interceptor.list({ kind: args.kind, unwatermarked: args.unwatermarked, limit: args.limit || 50 });
    case "download_resource": {
      const item = interceptor.get(args.id);
      if (!item) throw new Error("资源不存在");
      const inst = store.find(args.instanceId || item.instanceId) || store.get().instances[0];
      if (!inst) throw new Error("没有可用于下载的实例");
      const { session } = require("electron");
      // 默认走无水印（interceptor.download 内部先试改写地址，失败回退）
      return interceptor.download(session.fromPartition(inst.partition), item, args);
    }
    case "prompt_check":
      return zizi.check(args.text);
    case "appeal_script":
      return { script: zizi.appealScript(args) };
    case "list_assets":
      return assets.list(args.kind);
    case "jianying_draft":
      return jianying.createDraft({
        name: args.name,
        ratio: args.ratio,
        storyboardId: args.storyboardId,
        files: (args.files || []).map((f) => (typeof f === "string" ? { path: f } : f))
      });
    case "list_logs":
      return log.recent(Number(args.limit) || 100, args.q || "");
    default:
      throw new Error(`没有这个工具：${name}`);
  }
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function setup(server) {
  server.post("/mcp", async (c) => {
    const req = c.body || {};
    const id = req.id === undefined ? null : req.id;
    try {
      if (req.method === "initialize") {
        return c.json(200, rpcResult(id, {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false }, resources: {}, logging: {} },
          serverInfo: { name: "infinite-doubao", version: require("./brand").version },
          instructions: "豆包工坊 MCP：管理实例、分镜、批量派发、素材与取源。"
        }));
      }
      if (req.method === "notifications/initialized" || req.method === "initialized") {
        return c.json(200, { jsonrpc: "2.0", id, result: {} });
      }
      if (req.method === "ping") return c.json(200, rpcResult(id, {}));
      if (req.method === "tools/list") return c.json(200, rpcResult(id, { tools: tools() }));
      if (req.method === "tools/call") {
        const name = req.params && req.params.name;
        const args = (req.params && req.params.arguments) || {};
        const out = await callTool(name, args);
        return c.json(200, rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out === undefined ? null : out, null, 2) }],
          isError: false
        }));
      }
      return c.json(200, rpcError(id, -32601, `没有这个方法：${req.method}`));
    } catch (error) {
      const message = String((error && error.message) || error);
      log.warn("mcp-tool-failed", { method: req.method, message });
      return c.json(200, rpcError(id, -32000, message));
    }
  });

  server.get("/mcp", (c) => c.ok({
    name: "infinite-doubao",
    protocol: PROTOCOL,
    transport: "http",
    tools: tools().map((t) => t.name)
  }));

  // 简化版 SSE 传输：同一个事件流端点，MCP 客户端可用它接收通知
  server.get("/mcp/sse", (c) => {
    c.res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    c.res.write(`event: endpoint\ndata: ${JSON.stringify({ endpoint: "/mcp" })}\n\n`);
    const timer = setInterval(() => { try { c.res.write(": ping\n\n"); } catch {} }, 20000);
    timer.unref && timer.unref();
    c.req.on("close", () => clearInterval(timer));
  });

  return server;
}

module.exports = { setup, tools, callTool, PROTOCOL };
