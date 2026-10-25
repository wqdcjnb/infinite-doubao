"use strict";

/**
 * 事件流（SSE）
 *
 * 界面、CLI、MCP 三条入口看同一份事件流：任务状态、镜头进度、日志、抓到的媒资。
 * 对标产品靠 1.5 秒一次的轮询刷新界面，慢半拍；这里任务一有变化就推。
 */

const log = require("./logger");
const orchestrator = require("./orchestrator");
const interceptor = require("./interceptor");

const clients = new Set();
let heartbeat = null;

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data === undefined ? null : data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function setup(server) {
  server.get("/events", (c) => {
    const res = c.res;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write(`retry: 3000\n\n`);
    clients.add(res);
    try {
      res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString(), state: orchestrator.state() })}\n\n`);
    } catch {}

    c.req.on("close", () => clients.delete(res));
    res.on("close", () => clients.delete(res));
  });

  server.get("/api/events", (c) => c.ok({ clients: clients.size }));

  orchestrator.events.on("event", (e) => broadcast("task", e));
  log.onLog((line) => broadcast("log", line));
  interceptor.events.on("add", (item) => broadcast("resource", item));
  interceptor.events.on("update", (item) => broadcast("resource", item));

  if (!heartbeat) {
    heartbeat = setInterval(() => broadcast("ping", { at: Date.now() }), 20000);
    heartbeat.unref && heartbeat.unref();
  }
  return server;
}

function close() {
  for (const res of clients) { try { res.end(); } catch {} }
  clients.clear();
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

function count() {
  return clients.size;
}

module.exports = { setup, broadcast, close, count };
