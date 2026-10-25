// 截图：node _test/shot.js 输出路径 [前置JS]
const fs = require("node:fs");
const { CDP } = require("./cdp.js");

(async () => {
  const out = process.argv[2] || "_test/shot.png";
  const pre = process.argv[3] || "";
  const c = await CDP.attach("index.html");
  await c.send("Page.enable");
  if (pre) {
    const r = await c.eval(pre);
    if (r && r.error) console.error("pre error:", r.error);
    await new Promise((r2) => setTimeout(r2, 500));
  }
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("saved", out);
  c.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
