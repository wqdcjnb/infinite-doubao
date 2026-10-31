"use strict";

/**
 * 账号网页（webview）注入脚本
 *
 * 两件事：
 *   1) 指纹伪装：向主进程同步取本账号的档案，在主世界 document_start 阶段注入改写。
 *      必须用主世界执行 —— preload 默认在隔离世界，改 navigator 页面根本看不到。
 *   2) 注入云电脑草稿保存、发送和原对话结果核对所需的自动化原语。
 */

const { ipcRenderer, webFrame } = require("electron");
const { installFingerprint } = require("./fp-inject.js");
const { buildPageScript } = require("./page");

try { ipcRenderer.send("dm:preload-alive", { href: String(location.href).slice(0, 120) }); } catch {}

const boot = (() => {
  try { return ipcRenderer.sendSync("dm:fp-profile") || {}; } catch { return {}; }
})();

// ---- 1) 指纹：主世界注入 ---------------------------------------------------
// preload 此时 HTML 还没开始解析；主进程已通过 will-attach-webview 把
// contextIsolation 关掉，所以这里的同步调用直接落在页面主世界，
// 站点在 <head> 里读 navigator 拿到的已经是伪装值。
let fingerprintInstalled = false;
if (boot.profile) {
  try {
    installFingerprint(boot.profile);
    fingerprintInstalled = true;
  } catch (error) {
    try { ipcRenderer.send("dm:fp-error", String((error && error.message) || error)); } catch {}
  }
}

// ---- 1b) 页面增强 + 自动化原语 ---------------------------------------------
// 与外挂内核注入的是同一份源码（page/index.js 统一装配），行为不分叉。
try {
  const pageSource = buildPageScript({
    cfg: {
      // 同一主世界已经同步安装，避免页面脚本再次叠加 Canvas/Audio 等包装。
      // 同步安装失败时仍保留原来的主世界注入回退。
      profile: fingerprintInstalled ? null : boot.profile,
      instanceId: boot.instanceId || boot.accountId || "",
      kernel: "embedded",
      enhancer: boot.enhancer || (boot.mask && boot.mask.enhancer) || {}
    }
  });
  webFrame.executeJavaScript(pageSource).catch((error) => {
    ipcRenderer.send("dm:page-script-error", String((error && error.message) || error));
  });
} catch (error) {
  try { ipcRenderer.send("dm:page-script-error", String((error && error.message) || error)); } catch {}
}


const HOST = (() => {
  try { return location.hostname; } catch { return ""; }
})();
const IS_DOLA = /(^|\.)dola\.com$/i.test(HOST);
const IS_DOUBAO = /(^|\.)(doubao|dola)\.(com|cn)$/i.test(HOST) || /cici/i.test(HOST);

// 桌面端已移除独立视频导出入口；不再向账号网页添加下载按钮。

// 仅在本地探针/调试页显示环境条：真实站点里这条横幅会把账号名和指纹直接写进 DOM，
// 任何脚本读一下 innerText 就知道是哪个账号、用的什么档案，等于自己把牌摊开。
const IS_LOCAL_PAGE = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(HOST);

/* ------------------------------------------------------------ 无水印导出 */

function installNoWatermark() {
  const IPC = ipcRenderer;
  const BTN_CLASS = "nw-export-btn";
  const STYLE_ID = "nw-export-css";
  const seenUrls = new Set();
  const videoQueue = [];

  const abs = (u) => {
    try {
      const a = new URL(String(u || ""), location.href);
      return /^https?:$/i.test(a.protocol) ? a.toString() : "";
    } catch { return ""; }
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = `
      .${BTN_CLASS} {
        position: absolute !important;
        right: 12px !important;
        bottom: 12px !important;
        z-index: 2147483640 !important;
        min-width: 108px !important;
        height: 32px !important;
        padding: 0 14px !important;
        border: 1px solid rgba(34,227,182,.42) !important;
        border-radius: 8px !important;
        background: linear-gradient(135deg, rgba(9,26,24,.94), rgba(8,15,22,.95)) !important;
        color: #4ff0c8 !important;
        box-shadow: 0 0 0 1px rgba(34,227,182,.1), 0 8px 24px -12px rgba(34,227,182,.9) !important;
        backdrop-filter: blur(10px) !important;
        font: 600 12.5px/30px "Microsoft YaHei UI", sans-serif !important;
        letter-spacing: .3px !important;
        cursor: pointer !important;
        white-space: nowrap !important;
        transition: border-color .18s, box-shadow .18s, background .18s !important;
      }
      .${BTN_CLASS}:hover {
        border-color: rgba(34,227,182,.85) !important;
        background: linear-gradient(135deg, rgba(16,52,44,.96), rgba(10,22,28,.96)) !important;
        box-shadow: 0 0 0 1px rgba(34,227,182,.24), 0 10px 28px -10px rgba(34,227,182,1) !important;
      }
      .${BTN_CLASS}[disabled] { cursor: wait !important; opacity: .78 !important; }
    `;
    document.documentElement.appendChild(st);
  }

  function visible(el, minW, minH) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width >= minW && r.height >= minH && s.display !== "none" && s.visibility !== "hidden";
  }

  function wrapOf(video) {
    const r = video.getBoundingClientRect();
    let node = video.parentElement;
    let best = node;
    for (let i = 0; node && node !== document.body && i < 6; i += 1) {
      const nr = node.getBoundingClientRect();
      if (nr.width >= r.width * 0.9 && nr.height >= r.height * 0.9) {
        best = node;
        if (nr.width <= r.width + 80 && nr.height <= r.height + 100) return node;
      }
      node = node.parentElement;
    }
    return best;
  }

  function attach(host) {
    if (!host || host.querySelector(`:scope > .${BTN_CLASS}`)) return;
    if (host.closest(".nw-export-skip")) return;
    const r = host.getBoundingClientRect();
    if (r.width < 160 || r.height < 100) return;
    host.style.setProperty("position", "relative", "important");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    btn.textContent = "无水印下载";
    btn.title = "解析官方无水印原片并保存到下载目录";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      if (btn.disabled) return;
      const requestId = "dm-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
      btn.dataset.requestId = requestId;
      btn.disabled = true;
      btn.textContent = "解析中…";
      handleClick(requestId, btn, host).catch((error) => {
        btn.textContent = "失败：" + String((error && error.message) || error).slice(0, 18);
        setTimeout(() => { btn.disabled = false; btn.textContent = "无水印下载"; }, 2600);
      });
    }, true);
    host.appendChild(btn);
  }

  function scan(root) {
    if (!root || root.nodeType !== 1 && root.nodeType !== 9) return;
    ensureStyle();
    const videos = [];
    if (root.nodeType === 1 && root.tagName === "VIDEO") videos.push(root);
    if (root.querySelectorAll) videos.push(...root.querySelectorAll("video"));
    for (const v of videos) {
      if (!visible(v, 180, 100)) continue;
      attach(wrapOf(v));
    }
    const cards = root.querySelectorAll ? root.querySelectorAll('[class*="block-video"]') : [];
    for (const c of cards) if (visible(c, 160, 100)) attach(c);
  }

  // ---- 主世界数据挖掘 ----
  const harvestWaiters = new Map();
  let seq = 0;
  window.addEventListener("message", (e) => {
    const d = e && e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "dm:harvest-result") {
      const w = harvestWaiters.get(String(d.requestId || ""));
      if (w) { harvestWaiters.delete(String(d.requestId)); w(d); }
    }
  });

  function requestHarvest(messageId, timeout = 1800) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v || { urls: [], fallbackApi: "" }); } };
      seq += 1;
      const requestId = "dm-h-" + seq + "-" + Date.now();
      harvestWaiters.set(requestId, finish);
      try {
        window.postMessage({ type: "dm:harvest-request", requestId, messageId: String(messageId || "") }, "*");
      } catch { finish(null); }
      setTimeout(() => { harvestWaiters.delete(requestId); finish(null); }, timeout);
    });
  }

  function frameContext(el) {
    const out = [];
    let cur = el;
    for (let i = 0; cur && i < 8; i += 1) {
      const keys = Object.keys(cur);
      const fk = keys.find((k) => k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactProps$") === 0 || k.indexOf("__reactInternalInstance$") === 0);
      if (fk) out.push(cur[fk]);
      cur = cur.parentElement;
    }
    return out;
  }

  async function mainWorldHarvest(btn) {
    // 把 React 上下文挑出来交给主世界（隔离世界读不到 expando 属性）
    return requestHarvest(String(btn.closest("[data-message-id]")?.getAttribute("data-message-id") || ""));
  }

  async function officialDownloadInfo() {
    const H = { accept: "application/json", "content-type": "application/json", "agw-js-conv": "str" };
    const post = async (p, body) => {
      const r = await fetch(p, { method: "POST", credentials: "include", headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    };
    const collectIds = (root) => {
      const ids = [];
      const seen = new Set();
      const walk = (n, depth) => {
        if (!n || typeof n !== "object" || depth > 6 || ids.length > 60 || seen.has(n)) return;
        seen.add(n);
        if (n.id && /^\d{8,}$/.test(String(n.id))) ids.push(String(n.id));
        for (const k of Object.keys(n).slice(0, 40)) {
          const v = n[k];
          if (v && typeof v === "object") walk(v, depth + 1);
        }
      };
      walk(root, 0);
      return ids;
    };
    let rootId = "";
    try {
      const home = await post("/samantha/aispace/homepage", {});
      const data = (home && home.data) || home;
      const objs = [];
      const walk = (n, depth) => {
        if (!n || typeof n !== "object" || depth > 5 || objs.length > 200) return;
        if (n.id && /^\d{8,}$/.test(String(n.id))) objs.push(n);
        for (const k of Object.keys(n).slice(0, 40)) {
          const v = n[k];
          if (v && typeof v === "object") walk(v, depth + 1);
        }
      };
      walk(data, 0);
      const mine = objs.find((n) => /我的创作/.test(String(n.name || n.title || "")));
      rootId = String((mine && mine.id) || (objs[0] && objs[0].id) || "");
    } catch {}
    if (!rootId) return [];
    const nodeIds = [];
    let cursor = "";
    for (let page = 0; page < 3 && nodeIds.length < 40; page += 1) {
      const body = {
        node_id: rootId, need_full_path: true,
        sort_param: { need_sort_config: true, sort_order: 1, sort_type: 0 }, size: 50
      };
      if (cursor) { body.cursor = cursor; body.next_cursor_with_sort = cursor; }
      let res;
      try { res = await post("/samantha/aispace/node_info", body); } catch { break; }
      collectIds((res && res.data) || res).forEach((x) => { if (nodeIds.indexOf(x) < 0) nodeIds.push(x); });
      const d = (res && res.data) || {};
      cursor = String(d.next_cursor || d.nextCursor || "");
      if (!d.has_more || !cursor) break;
    }
    const valid = (u) => /\/download/i.test(u) && /download=true/i.test(u) && /video_mp4/i.test(u);
    const out = [];
    for (const id of nodeIds.slice(0, 10)) {
      try {
        const j = await post("/samantha/aispace/get_download_info", { requests: [{ node_id: id }] });
        const infos = (j && j.data && j.data.download_infos) || [];
        for (const it of infos.slice(0, 2)) {
          const u = it && (it.main_url || it.mainUrl);
          if (typeof u === "string" && valid(u) && out.indexOf(u) < 0) out.push(u);
        }
      } catch {}
    }
    return out;
  }

  function score(u) {
    const s = String(u);
    let n = 0;
    if (/origin|download=true|main_?url|raw_?url/i.test(s)) n += 4;
    if (/no_?watermark|without_?watermark|no-?watermark|noop/i.test(s)) n += 4;
    if (/video_mp4|\.mp4/i.test(s)) n += 2;
    if (/\/download/i.test(s)) n += 2;
    if (/watermark/i.test(s)) n -= 4;
    if (/preview|thumb|cover/i.test(s)) n -= 3;
    return n;
  }

  async function handleClick(requestId, btn, host) {
    const video = host.querySelector("video");
    const pageUrl = location.href;
    const push = (arr, u) => {
      const a = abs(u);
      if (!a || a === pageUrl || arr.indexOf(a) >= 0) return;
      arr.push(a);
    };
    const candidates = [];
    if (video) { push(candidates, video.currentSrc); push(candidates, video.src); }
    const harvested = await mainWorldHarvest(btn);
    const harvestedUrls = Array.isArray(harvested.urls) ? harvested.urls : [];
    harvestedUrls.forEach((u) => push(candidates, u));
    try {
      performance.getEntriesByType("resource").forEach((e) => {
        const n = String(e.name || "");
        if (/\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(n) || /tos-|videoweb|fplay/i.test(n)) push(candidates, n);
      });
    } catch {}
    candidates.sort((a, b) => score(b) - score(a));

    if (!candidates.length && !harvested.fallbackApi) {
      btn.textContent = "未找到视频地址";
      setTimeout(() => { btn.disabled = false; btn.textContent = "无水印下载"; }, 2400);
      return;
    }

    btn.textContent = "下载中…";
    const name = `豆包无水印_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}.mp4`;
    IPC.send("dm:no-watermark-download", {
      requestId,
      candidates: candidates.slice(0, 12),
      fallbackApi: String(harvested.fallbackApi || ""),
      filename: name,
      url: candidates[0] || "",
      messageId: String(btn.closest("[data-message-id]")?.getAttribute("data-message-id") || "")
    });

    // 顺带试一次官方原片接口（Dola 部分地区可用），拿到的地址排在候选最前
    setTimeout(async () => {
      try {
        const official = await officialDownloadInfo();
        if (official.length) {
          IPC.send("dm:no-watermark-download", {
            requestId: requestId + "-official",
            candidates: official,
            filename: name,
            url: official[0]
          });
        }
      } catch {}
    }, 60);
  }

  // 进度回写
  window.addEventListener("message", (e) => {
    const d = e && e.data;
    if (!d || typeof d !== "object" || d.type !== "dm:no-watermark-progress") return;
    const btn = Array.from(document.querySelectorAll(`.${BTN_CLASS}`)).find((b) => b.dataset.requestId === String(d.requestId || ""));
    if (!btn) return;
    btn.textContent = String(d.label || "处理中…");
    if (d.done) {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "无水印下载";
        delete btn.dataset.requestId;
      }, d.ok ? 1800 : 3000);
    }
  });

  ipcRenderer.on("dm:no-watermark-progress", (_e, p) => {
    window.postMessage({ type: "dm:no-watermark-progress", ...(p || {}) }, "*");
  });

  // 主世界守护脚本：React fiber 挖掘 + 卡片数据里的 fallback_api
  try {
    webFrame.executeJavaScript(`(function(){
      // 不用 window 上的自造标记做幂等（getOwnPropertyNames 一扫就露），
      // 本脚本由 preload 在每份文档里只调用一次，天然不需要守卫。
      const STRONG = /origin|_ori\\b|ori_?url|download|main_?url|raw_?url|without_?watermark|no_?watermark|fallback_?api/i;
      const abs = (u) => { try { const a = new URL(String(u||''), location.href); return /^https?:$/i.test(a.protocol) ? a.toString() : ''; } catch(e){ return ''; } };
      function collect(node, out) {
        const seen = new Set();
        const stack = [node];
        let steps = 0;
        while (stack.length && out.urls.length < 26 && steps < 8000) {
          steps += 1;
          const cur = stack.shift();
          if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
          seen.add(cur);
          let keys = [];
          try { keys = Object.keys(cur).slice(0, 56); } catch(e){ continue; }
          for (const k of keys) {
            let v;
            try { v = cur[k]; } catch(e){ continue; }
            if (typeof v === 'string') {
              if (/fallback/i.test(k) && /^https?:\\/\\//i.test(v)) out.fallbackApi = out.fallbackApi || v;
              if (STRONG.test(k) || /(tos-|\\.mp4|video_mp4)/i.test(v)) {
                const a = abs(v);
                if (a && out.urls.indexOf(a) < 0) out.urls.push(a);
              }
            } else if (v && typeof v === 'object') stack.push(v);
          }
        }
      }
      window.addEventListener('message', (e) => {
        const d = e && e.data;
        if (!d || d.type !== 'dm:harvest-request') return;
        const out = { urls: [], fallbackApi: '' };
        try {
          const mid = String(d.messageId || '');
          const nodes = mid ? Array.from(document.querySelectorAll('[data-message-id="' + CSS.escape(mid) + '"]')) : [];
          const scope = nodes.length ? nodes : Array.from(document.querySelectorAll('[data-message-id]')).slice(-6);
          for (const el of scope) {
            const keys = Object.keys(el);
            const fk = keys.find(k => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactProps$') === 0);
            if (fk) collect(el[fk], out);
            const pk = keys.find(k => k.indexOf('__reactProps$') === 0);
            if (pk) { try { collect(el[pk], out); } catch(err){} }
          }
        } catch(err){}
        window.postMessage({ type: 'dm:harvest-result', requestId: d.requestId, urls: out.urls, fallbackApi: out.fallbackApi }, '*');
      });
    })();`).catch(() => {});
  } catch {}

  window.addEventListener("DOMContentLoaded", () => {
    scan(document.body);
    let timer = 0;
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
      clearTimeout(timer);
      timer = setTimeout(() => scan(document), 200);
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => scan(document), 2000);
  });
}

/* ------------------------------------------------------------- 宿主提示条 */

// 页面左下角环境条：只在本地探针页出现，真实站点不注入（见 IS_LOCAL_PAGE 注释）
window.addEventListener("DOMContentLoaded", () => {
  if (!boot.profile || !IS_LOCAL_PAGE) return;
  try {
    const tip = document.createElement("div");
    const fp = boot.profile;
    tip.textContent = `[${boot.accountName || "账号"}] ${fp.chromeLabel} · ${fp.timezone} · ${fp.screen.width}x${fp.screen.height}`;
    tip.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:2147483647;padding:3px 10px;border-radius:7px;border:1px solid rgba(34,227,182,.28);background:rgba(6,12,18,.8);color:#4ff0c8;font:10.5px/17px 'Cascadia Code','Microsoft YaHei UI',monospace;letter-spacing:.4px;pointer-events:none;opacity:.8;backdrop-filter:blur(6px);";
    document.documentElement.appendChild(tip);
    setTimeout(() => { tip.style.opacity = "0"; tip.style.transition = "opacity .6s"; }, 6000);
  } catch {}
});
