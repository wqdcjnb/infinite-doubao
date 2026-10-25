// 读 webview 里真实发出的请求头（走本地 /echo 回显），核对与页面 JS 是否同一份
const { getJSON } = require("./cdp.js");

(async () => {
  const list = (await getJSON("/json/list")).filter((t) => t.type === "webview");
  if (!list.length) { console.log("no webview"); return; }
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description);
    return r.result.value;
  };

  const head = await ev(`fetch('/echo?t=' + Date.now(), { cache: 'no-store' }).then(r => r.json())`);
  const js = await ev(`JSON.stringify({
    ua: navigator.userAgent,
    brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand + '/' + b.version).join(' | ') : 'n/a',
    platform: navigator.userAgentData ? navigator.userAgentData.platform : 'n/a',
    languages: navigator.languages.join(',')
  })`);
  console.log("--- 实际请求头 ---");
  console.log(JSON.stringify({
    ua: head["user-agent"],
    "sec-ch-ua": head["sec-ch-ua"],
    "sec-ch-ua-platform": head["sec-ch-ua-platform"],
    "sec-ch-ua-platform-version": head["sec-ch-ua-platform-version"],
    "sec-ch-ua-full-version-list": head["sec-ch-ua-full-version-list"],
    "accept-language": head["accept-language"]
  }, null, 1));
  console.log("--- 页面 JS ---");
  console.log(js);
  ws.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
