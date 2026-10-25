// CDP 驱动：直接对渲染进程求值 / 点击，不依赖窗口焦点
const http = require("node:http");

function getJSON(path) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: Number(process.env.DM_TEST_CDP_PORT) || 9222, path }, (r) => {
      let b = "";
      r.on("data", (d) => (b += d));
      r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(targetFilter = "index.html") {
    const list = await getJSON("/json/list");
    const t = list.find((x) => x.url.includes(targetFilter) && x.type !== "browser")
      || list.find((x) => x.type === "page");
    if (!t) throw new Error("no page target");
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : "eval error");
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

module.exports = { CDP, getJSON };

if (require.main === module) {
  (async () => {
    const c = await CDP.attach();
    const code = process.argv[2];
    const out = await c.eval(code);
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    c.close();
  })().catch((e) => { console.error("ERR", e.message); process.exit(1); });
}
