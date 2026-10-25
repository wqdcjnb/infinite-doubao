"use strict";

// Manual invocation only. --submit sends one explicitly labelled 5-second live verification.
process.env.DM_TEST_CDP_PORT = "9252";
const { CDP } = require("./cdp");
const mode = process.argv[2] || "--status";
const name = "连通性实测 · Mini 5秒";
const { autoKeyFor } = require("../src/page");
(async () => {
  const c = await CDP.attach();
  try {
    const context = await c.eval(`(async()=>({home:(await DM.paths()).home,id:state.accounts[0]?.id,accounts:state.accounts.length}))()`);
    if (!context.home.endsWith("\\Roaming\\无限豆包") || context.accounts !== 1) throw new Error("Unexpected live application context");
    const key = autoKeyFor(context.id);
    if (mode === "--prepare") {
      await c.eval("openAccount(state.accounts[0], {background:true})");
      for (let n = 0; n < 60; n++) {
        try {
          if (await c.eval(`document.querySelector('webview').executeJavaScript(${JSON.stringify(`!!window[${JSON.stringify(key)}] && document.readyState !== 'loading'`)})`)) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/page/generation-options.js"), "utf8");
      await c.eval(`document.querySelector('webview').executeJavaScript(${JSON.stringify(`(()=>{var CFG={autoKey:${JSON.stringify(key)}};${source}})()`)})`);
      const script = `(async()=>({prepared:await window[${JSON.stringify(key)}].prepareVideoGeneration({model:'seedance_v2.0_mini',duration:5}),controls:Array.from(document.querySelectorAll('#input-engine-container button,[role="menuitem"],[role="option"]')).map(e=>e.innerText).filter(Boolean).slice(-35)}))()`;
      console.log(JSON.stringify(await c.eval(`document.querySelector('webview').executeJavaScript(${JSON.stringify(script)})`), null, 2));
    } else if (mode === "--submit") {
      const result = await c.eval(`(async()=>{
        const all=(await DM.call('dm:templates')).data.items;
        let template=all.find(t=>t.name===${JSON.stringify(name)});
        const existing=(await DM.call('dm:tasks')).data.find(t=>t.templateName===${JSON.stringify(name)});
        if(existing)return {alreadySubmitted:true,taskId:existing.id,status:existing.status};
        if(!template){const r=await DM.call('dm:template:create',{name:${JSON.stringify(name)},prompt:'清晨的湖面，一只小鱼在清澈的水中缓缓游动，固定镜头，自然光线，无文字，无字幕。',model:'seedance_v2.0_mini',duration:5});if(!r.ok)throw new Error(r.error);template=r.data;}
        const previous=(await DM.call('dm:state')).data.settings.orchestrator.retryLimit;
        await DM.saveSettings({orchestrator:{retryLimit:0}});
        try{const r=await DM.call('dm:template:submit',template.id);if(!r.ok)throw new Error(r.error);document.querySelector('[data-view="tasks"]')?.click();return r.data;}
        finally{await DM.saveSettings({orchestrator:{retryLimit:previous}});}
      })()`);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await c.eval(`(async()=>{const t=(await DM.call('dm:tasks')).data.find(t=>t.templateName===${JSON.stringify(name)});if(!t)return {submitted:false};return {id:t.id,status:t.status,stage:t.stage,progress:t.progress,error:t.error,waitReason:t.waitReason,submittedAt:t.submittedAt,generatedAt:t.generatedAt,result:t.result?{files:t.result.files,unwatermarked:t.result.unwatermarked}:null,log:t.log.slice(-5)}})()`);
      console.log(JSON.stringify(result, null, 2));
    }
  } finally { c.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
