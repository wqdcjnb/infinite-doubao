const { CDP } = require("./cdp.js");
(async () => {
  const c = await CDP.attach("index.html");
  const sel = `(function(){var rows=Array.from(document.querySelectorAll('.s-row'));var row=rows.find(r=>r.querySelector('label')&&r.querySelector('label').textContent==='默认模型');return row.querySelector('select');})()`;
  const dur = `(function(){var rows=Array.from(document.querySelectorAll('.s-row'));var row=rows.find(r=>r.querySelector('label')&&r.querySelector('label').textContent.indexOf('目标时长')===0);return {input:row.querySelector('input'),hint:row.querySelector('.s-hint').textContent};})()`;
  const read = `JSON.stringify((function(){var d=${dur};return{sel:${sel}.value,dur:d.input.value,max:d.input.max,hint:d.hint};})())`;

  console.log("初始  ", await c.eval(read));

  // 切到 2.5：上限应放开到 30
  await c.eval(`(function(){var s=${sel};s.value='seedance_v2.5';s.dispatchEvent(new Event('change'));return 1;})()`);
  await new Promise((r) => setTimeout(r, 1200));
  console.log("选2.5  ", await c.eval(read));

  // 2.5 下填 45：应被压到 30
  await c.eval(`(function(){var i=(${dur}).input;i.value='45';i.dispatchEvent(new Event('change'));return 1;})()`);
  await new Promise((r) => setTimeout(r, 1200));
  console.log("填45   ", await c.eval(read));

  // 再切回 2.0：时长应被压回 15
  await c.eval(`(function(){var s=${sel};s.value='seedance_v2.0';s.dispatchEvent(new Event('change'));return 1;})()`);
  await new Promise((r) => setTimeout(r, 1200));
  console.log("切回2.0", await c.eval(read));
  c.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
