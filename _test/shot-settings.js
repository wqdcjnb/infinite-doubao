const fs = require("node:fs");
const { CDP } = require("./cdp.js");
(async () => {
  const c = await CDP.attach("index.html");
  await c.send("Page.enable");
  await c.eval(`(function(){var t=Array.from(document.querySelectorAll('.vtab')).find(a=>a.dataset.view==='settings');if(t)t.click();return 1;})()`);
  await new Promise((r) => setTimeout(r, 1200));
  const info = await c.eval(`(function(){var s=document.querySelector('.settings');if(!s)return 'no .settings';var r=s.getBoundingClientRect();var v=document.getElementById('view-settings');var active=document.querySelector('.vtab.active');return JSON.stringify({activeTab:active&&active.dataset.view,left:Math.round(r.left),right:Math.round(document.documentElement.clientWidth-r.right),width:Math.round(r.width)});})()`);
  console.log(info);
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("_test/settings-view.png", Buffer.from(shot.data, "base64"));
  c.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
