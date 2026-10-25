// 指纹审计：打开 webview 指向 audit.html，用账号档案跑一遍检测面
const fs = require("node:fs");
const path = require("node:path");
const { CDP } = require("./cdp.js");

/** 按档案时区算期望的 getTimezoneOffset（Node 侧独立实现，不依赖被测代码） */
function expectedOffset(tz) {
  const d = new Date();
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const p = {};
  for (const it of f.formatToParts(d)) p[it.type] = it.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return String(Math.round((Math.floor(d.getTime() / 1000) * 1000 - asUTC) / 60000));
}

(async () => {
  const storePath = path.join(process.env.APPDATA, "无限豆包", "store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const acc = store.accounts[Number(process.argv[2] || 0)] || store.accounts[0];
  const P = { ...acc.fingerprint, tzOffsetHint: expectedOffset(acc.fingerprint.timezone) };

  const c = await CDP.attach("audit.html");
  await new Promise((r) => setTimeout(r, 500));
  const out = await c.eval(`window.__audit(${JSON.stringify(P)})`);
  const high = await c.eval(`window.__auditHigh(${JSON.stringify(P)})`);
  console.log("=== " + acc.name + " :: " + P.chromeLabel + " / " + P.locale + " / " + P.timezone + " ===");
  console.log(out);
  console.log("· UA-CH 高熵 = " + high);
  console.log("\n--- raw ---");
  console.log(await c.eval(`JSON.stringify({
    ua: navigator.userAgent,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.availTop, screen.availLeft],
    outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight],
    dpr: devicePixelRatio
  })`));
  c.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
