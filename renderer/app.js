"use strict";

/* 界面逻辑（无框架，直接操作 DOM） */

const API = window.DM;
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  accounts: [],
  tabs: [],
  activeId: "",
  panel: "",
  paths: null,
  settings: {},
  maskFiles: [],
  maskResults: [],
  maskRunning: false,
  proxyCache: {}
};

const TZ_LIST = [
  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Singapore", "Asia/Tokyo",
  "Asia/Seoul", "Asia/Bangkok", "Asia/Jakarta", "Asia/Kuala_Lumpur", "Asia/Dubai",
  "Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Moscow",
  "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Sao_Paulo"
];

const SCREEN_PRESETS = [
  [1920, 1080, 1], [2560, 1440, 1], [1680, 1050, 1], [1440, 900, 1], [1536, 864, 1.25], [1366, 768, 1]
];

function toast(message, isErr) {
  const box = $("#toasts");
  const t = el("div", "toast" + (isErr ? " err" : ""), message);
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, isErr ? 5200 : 2800);
  setTimeout(() => t.remove(), 6000);
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  try {
    state.paths = await API.paths();
    const res = await API.loadStore();
    state.accounts = res.store.accounts || [];
    state.settings = res.store.settings || {};
  } catch (error) {
    $("#countText").textContent = "ERR";
    $("#sbEnv").textContent = "BOOT FAILED: " + String((error && error.message) || error);
    console.error(error);
    return;
  }
  renderList();

  API.onWatermarkProgress((p) => {
    if (!p) return;
    if (p.done) toast(`${p.ok ? "✅" : "⚠️"} ${p.label}`, !p.ok);
  });
  API.onMaskProgress(onMaskProgress);
  API.onSettingsChanged((settings) => { Object.assign(state.settings, settings || {}); });
  API.onAccountOpen(async ({ instanceId }) => {
    try {
      const current = await API.loadStore();
      state.accounts = current.store.accounts || [];
      const account = state.accounts.find((item) => item.id === instanceId);
      if (account) openAccount(account, { background: true });
    } catch (error) { toast("自动打开账号失败：" + error.message, true); }
  });

  $("#btnNew").addEventListener("click", createAccount);
  if (!API.isWeb) $("#btnWeb").addEventListener("click", async () => {
    try {
      const result = await API.call("dm:web:open");
      if (!result?.ok) throw new Error(result?.error || "网页版启动失败");
    } catch (error) { toast(error.message, true); }
  });
  $("#accClose").addEventListener("click", closeAddModal);
  $("#accCancel").addEventListener("click", closeAddModal);
  $("#accOk").addEventListener("click", submitAddModal);
  $("#accProxyMode").addEventListener("change", (e) => {
    $("#accProxyWrap").classList.toggle("hidden", e.target.value !== "custom");
    if (e.target.value === "custom") $("#accProxyUrl").focus();
  });
  $("#accModal").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); submitAddModal(); }
  });
  $("#search").addEventListener("input", renderList);
  $("#btnHome").addEventListener("click", async () => {
    try { await API.openHome(); } catch (error) { toast("打开视频目录失败：" + error.message, true); }
  });
  $("#btnGo").addEventListener("click", () => navigate($("#address").value));
  $("#address").addEventListener("keydown", (e) => { if (e.key === "Enter") navigate($("#address").value); });
  $("#btnReload").addEventListener("click", () => {
    const tab = activeTab();
    if (tab) tab.view.reload();
  });
  document.querySelectorAll(".tool").forEach((b) => {
    b.addEventListener("click", () => togglePanel(b.dataset.panel));
  });
  $("#drawerClose").addEventListener("click", () => togglePanel(""));
  tickClock();
  setInterval(tickClock, 1000);
  await API.call("dm:renderer:ready");
}

function activeAccount() {
  return state.accounts.find((a) => a.id === state.activeId) || null;
}

/* -------------------------------------------------------------- 状态栏 */

function renderStatus() {
  const acc = activeAccount();
  const fp = acc && acc.fingerprint ? acc.fingerprint : null;
  $("#sbEnv").textContent = acc ? `ENV ${String(acc.name).toUpperCase().slice(0, 16)}` : "ENV —";
  $("#sbFp").textContent = fp ? `FP ${fp.chromeLabel} · ${fp.timezone} · ${fp.screen.width}×${fp.screen.height}` : "FP —";
  const geo = acc ? state.proxyCache[acc.id] : null;
  const drift = geo && geo.ok && geo.timezone && fp && fp.timezone !== geo.timezone;
  $("#sbIp").textContent = geo
    ? (geo.ok ? `IP ${geo.ip} · ${geo.country || ""} ${geo.city || ""}${drift ? " ⚠ TZ" : ""}`.trim() : "IP 检测失败")
    : (acc ? "IP 未检测" : "IP —");
  $("#sbIp").title = drift ? `出口时区 ${geo.timezone} 与指纹 ${fp.timezone} 不一致` : "";
}

function tickClock() {
  const node = $("#sbClock");
  if (!node) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  node.textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

/* -------------------------------------------------------------- 账号列表 */

function renderList() {
  const box = $("#accountList");
  const kw = String($("#search").value || "").trim().toLowerCase();
  box.textContent = "";
  const list = state.accounts.filter((a) => {
    if (!kw) return true;
    return `${a.name} ${a.group} ${a.remark}`.toLowerCase().includes(kw);
  });
  if (!list.length) {
    if (state.accounts.length) {
      const empty = el("div", "hint", "没有匹配的账号");
      empty.style.padding = "10px 4px";
      box.appendChild(empty);
    } else {
      const stub = el("div", "empty-stub");
      stub.appendChild(el("b", null, "暂无账号"));
      stub.appendChild(el("span", null, "点击上方「添加豆包账号」\n登录后即可开始创作"));
      stub.querySelector("span").style.whiteSpace = "pre-line";
      box.appendChild(stub);
    }
  }
  for (const acc of list) {
    const item = el("div", "acc" + (acc.id === state.activeId ? " active" : ""));
    const nameRow = el("div", "acc-name");
    const dot = el("i", "dot" + (state.tabs.some((t) => t.id === acc.id) ? " on" : ""));
    nameRow.appendChild(dot);
    nameRow.appendChild(el("span", null, acc.name));
    item.appendChild(nameRow);

    const meta = el("div", "acc-meta");
    const proxyText = acc.proxy && acc.proxy.mode === "custom"
      ? `代理 ${(acc.proxy.url || "").replace(/\/\/.*@/, "//***@")}`
      : (acc.proxy && acc.proxy.mode === "system" ? "系统代理" : "直连");
    meta.appendChild(el("span", null, proxyText));
    const geo = state.proxyCache[acc.id];
    if (geo && geo.ok) meta.appendChild(el("span", null, geo.ip));
    meta.appendChild(el("span", null, acc.fingerprint ? acc.fingerprint.timezone : ""));
    item.appendChild(meta);

    const del = el("button", "acc-del", "✕");
    del.title = "删除账号";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!await window.DMDialogs.confirm({
        title: "删除这个账号？", subject: acc.name,
        message: "删除后，该账号在本机保存的登录状态也会清除。",
        detail: "此操作无法撤销，再次使用需重新添加并登录。",
        confirmLabel: "删除账号", danger: true
      })) return;
      try { await API.removeAccount(acc.id); }
      catch (error) { toast("删除账号失败：" + error.message, true); return; }
      closeTab(acc.id);
      state.accounts = state.accounts.filter((a) => a.id !== acc.id);
      if (state.activeId === acc.id) state.activeId = "";
      renderList();
      toast("已删除账号");
    });
    item.appendChild(del);

    item.addEventListener("click", () => openAccount(acc));
    box.appendChild(item);
  }
  $("#countText").textContent = String(state.accounts.length);
  renderStatus();
}

async function createAccount() {
  return openAddModal();
}

/* ---- 添加豆包账号弹窗 ---- */

function openAddModal() {
  const mask = $("#accModal");
  const nameIn = $("#accName");
  const groupIn = $("#accGroup");
  const remarkIn = $("#accRemark");
  const modeSel = $("#accProxyMode");
  const urlIn = $("#accProxyUrl");
  const wrap = $("#accProxyWrap");

  nameIn.value = `豆包-${state.accounts.length + 1}`;
  groupIn.value = "";
  remarkIn.value = "";
  modeSel.value = "direct";
  urlIn.value = "";
  wrap.classList.add("hidden");
  window.DMDialogs.open(mask, { focus: nameIn });
  nameIn.select();
}

function closeAddModal() {
  window.DMDialogs.close($("#accModal"));
}

async function submitAddModal() {
  const name = $("#accName").value.trim();
  const group = $("#accGroup").value.trim();
  const remark = $("#accRemark").value.trim();
  const mode = $("#accProxyMode").value;
  const proxyUrl = $("#accProxyUrl").value.trim();

  if (mode === "custom" && !proxyUrl) {
    toast("填一下代理地址，或把出口改成直连", true);
    $("#accProxyUrl").focus();
    return;
  }

  const okBtn = $("#accOk");
  okBtn.disabled = true;
  try {
    const acc = await API.createAccount({
      name: name || undefined,
      group,
      remark,
      proxy: { mode, url: mode === "custom" ? proxyUrl : "" }
    });
    state.accounts.push(acc);
    closeAddModal();
    renderList();
    openAccount(acc);
    toast("账号已添加，正在打开豆包");
  } catch (error) {
    toast("添加失败：" + ((error && error.message) || error), true);
  } finally {
    okBtn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 标签页 */

function openAccount(acc, opts = {}) {
  if (!opts.background) state.activeId = acc.id;
  const existing = state.tabs.find((t) => t.id === acc.id);
  if (existing) {
    if (!opts.background) activateTab(acc.id);
    renderList();
    return;
  }
  $("#welcome").style.display = "none";
  const targetUrl = acc.url || state.settings.defaultUrl || "https://www.doubao.com/chat/";
  const view = API.createAccountView ? API.createAccountView(acc) : document.createElement("webview");
  view.setAttribute("partition", acc.partition);
  // preload 必须传磁盘绝对路径：Electron 43 的 webview 对 file:// URL 形式的 preload
  // 会静默不加载（既不报错也不执行），只有绝对路径可靠。
  view.setAttribute("preload", state.paths.webviewPreload || "");
  view.setAttribute("useragent", (acc.fingerprint && acc.fingerprint.userAgent) || "");
  view.setAttribute("allowpopups", "");
  view.setAttribute("webpreferences", "contextIsolation=false,nodeIntegration=false,sandbox=false,spellcheck=false,backgroundThrottling=false");
  view.setAttribute("src", targetUrl);
  view.style.display = "flex";
  view.classList.add("background-account");
  $("#stack").appendChild(view);

  view.addEventListener("dom-ready", () => {
    try { view.setZoomFactor(1); } catch {}
  });

  state.tabs.push({ id: acc.id, view, acc });
  if (!opts.background || !state.activeId) activateTab(acc.id);
  renderList();
  renderTabs();
}

function activateTab(id) {
  state.activeId = id;
  const acc = state.accounts.find((a) => a.id === id);
  for (const t of state.tabs) {
    t.view.style.display = "flex";
    t.view.classList.toggle("background-account", t.id !== id);
  }
  $("#welcome").style.display = state.tabs.length ? "none" : "flex";
  if (acc) $("#address").value = acc.url || "";
  renderTabs();
  renderList();
  renderStatus();
  if (state.panel) renderPanel();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [tab] = state.tabs.splice(idx, 1);
  try { tab.view.remove(); } catch {}
  if (state.activeId === id) {
    const next = state.tabs[Math.max(0, idx - 1)];
    state.activeId = next ? next.id : "";
    if (next) activateTab(next.id);
    else {
      $("#welcome").style.display = "flex";
      $("#address").value = "";
      renderStatus();
    }
  }
  renderTabs();
  renderList();
}

function renderTabs() {
  const box = $("#tabs");
  box.textContent = "";
  for (const t of state.tabs) {
    const acc = state.accounts.find((a) => a.id === t.id) || t.acc;
    const tab = el("div", "tab" + (t.id === state.activeId ? " active" : ""));
    tab.appendChild(el("span", null, acc ? acc.name : "账号"));
    const x = el("span", "x", "✕");
    x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
    tab.appendChild(x);
    tab.addEventListener("click", () => activateTab(t.id));
    box.appendChild(tab);
  }
}

function navigate(url) {
  const tab = activeTab();
  const target = String(url || "").trim();
  if (!tab || !target) return;
  const full = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  tab.view.loadURL(full).catch((error) => toast("打开失败：" + error.message, true));
  const acc = state.accounts.find((a) => a.id === tab.id);
  if (acc) { acc.url = full; API.updateAccount(acc.id, { url: full }); }
}

/* ---------------------------------------------------------------- 抽屉面板 */

function togglePanel(name) {
  state.panel = state.panel === name ? "" : name;
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.panel === state.panel));
  $("#drawer").classList.toggle("hidden", !state.panel);
  if (state.panel) renderPanel();
}

function renderPanel() {
  const titles = { env: "环境指纹", proxy: "代理 / IP", mask: "素材遮脸" };
  $("#drawerTitle").textContent = titles[state.panel] || "";
  const body = $("#drawerBody");
  body.textContent = "";
  if (state.panel === "env") renderEnvPanel(body);
  else if (state.panel === "proxy") renderProxyPanel(body);
  else if (state.panel === "mask") renderMaskPanel(body);
}

/* ---- 环境面板 ---- */

function renderEnvPanel(body) {
  const acc = activeAccount();
  if (!acc) { body.appendChild(el("div", "hint", "先在左侧选一个环境")); return; }
  const fp = acc.fingerprint || {};

  const info = el("div", "card");
  info.appendChild(el("h4", null, "当前档案"));
  const kv = el("div", "kv");
  const rows = [
    ["UA", fp.userAgent || ""],
    ["平台", `${fp.windowsLabel || "Windows"} · ${fp.platform} · ${(fp.languages || []).join(",")}`],
    ["屏幕", `${fp.screen ? fp.screen.width + "x" + fp.screen.height : ""} @${fp.screen ? fp.screen.devicePixelRatio : 1}x`],
    ["时区", fp.timezone || ""],
    ["CPU/内存", `${fp.hardwareConcurrency || 8} 核 / ${fp.deviceMemory || 8} GB`],
    ["显卡", fp.webgl ? fp.webgl.renderer : ""],
    ["WebRTC", fp.webrtc === "block" ? "已阻断（不泄漏本机 IP）" : "直通"],
    ["Canvas/Audio", `${fp.canvasNoise ? "噪声" : "原样"} / ${fp.audioNoise ? "噪声" : "原样"}`]
  ];
  for (const [k, v] of rows) { kv.appendChild(el("span", null, k)); kv.appendChild(el("span", null, v)); }
  info.appendChild(kv);
  body.appendChild(info);

  const edit = el("div", "card");
  edit.appendChild(el("h4", null, "手工微调（保存后重新打开该环境生效）"));

  const fTz = field(edit, "时区");
  const tzSel = el("select");
  for (const tz of TZ_LIST) {
    const o = el("option", null, tz);
    o.value = tz;
    if (fp.timezone === tz) o.selected = true;
    tzSel.appendChild(o);
  }
  fTz.appendChild(tzSel);

  const fScr = field(edit, "屏幕分辨率 / 缩放");
  const scrSel = el("select");
  const presets = SCREEN_PRESETS.slice();
  const curScr = fp.screen || {};
  const curIdx = presets.findIndex(([w, h]) => w === curScr.width && h === curScr.height);
  if (curIdx < 0 && curScr.width && curScr.height) presets.unshift([curScr.width, curScr.height, curScr.devicePixelRatio || 1]);
  presets.forEach(([w, h, d], i) => {
    const o = el("option", null, `${w}x${h} @${d}x`);
    o.value = String(i);
    if (curIdx < 0 ? i === 0 : i === curIdx) o.selected = true;
    scrSel.appendChild(o);
  });
  fScr.appendChild(scrSel);

  const fWeb = field(edit, "WebGL 渲染器");
  const webSel = el("select");
  [
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  ].forEach((r) => {
    const o = el("option", null, r.replace("ANGLE (", "").replace(", D3D11)", ""));
    o.value = r;
    if (fp.webgl && fp.webgl.renderer === r) o.selected = true;
    webSel.appendChild(o);
  });
  fWeb.appendChild(webSel);

  const fLang = field(edit, "语言（导航器 languages，逗号分隔）");
  const langIn = el("input");
  langIn.value = (fp.languages || []).join(",");
  fLang.appendChild(langIn);

  const fCore = field(edit, "CPU 核心数 / 内存 GB");
  const coreRow = el("div", "row");
  const coreIn = el("input");
  coreIn.value = String(fp.hardwareConcurrency || 8);
  const memIn = el("input");
  memIn.value = String(fp.deviceMemory || 8);
  coreRow.appendChild(coreIn);
  coreRow.appendChild(memIn);
  fCore.appendChild(coreRow);

  const chkWrap = el("div", "row");
  const mk = (label, key, val) => {
    const w = el("label");
    w.style.cssText = "display:flex;align-items:center;gap:5px;flex:1;font-size:11px;color:var(--text-dim)";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.style.width = "auto";
    c.checked = val;
    c.dataset.key = key;
    w.appendChild(c);
    w.appendChild(document.createTextNode(label));
    chkWrap.appendChild(w);
  };
  mk("Canvas 噪声", "canvasNoise", fp.canvasNoise !== false);
  mk("Audio 噪声", "audioNoise", fp.audioNoise !== false);
  mk("WebRTC 阻断", "webrtc", fp.webrtc === "block");
  edit.appendChild(chkWrap);

  const btns = el("div", "row");
  btns.style.marginTop = "8px";
  const saveBtn = el("button", "primary", "保存并应用");
  saveBtn.addEventListener("click", async () => {
    const [w, h, d] = presets[Number(scrSel.value)] || [1920, 1080, 1];
    const patch = {
      timezone: tzSel.value,
      language: tzSel.value,
      screen: { width: w, height: h, availWidth: w, availHeight: h - 40, colorDepth: 24, pixelDepth: 24, devicePixelRatio: d },
      webgl: { ...(fp.webgl || {}), vendor: (webSel.value.match(/^ANGLE \(([^,]+)/) || [, "Google Inc. (NVIDIA)"])[1], renderer: webSel.value },
      languages: langIn.value.split(",").map((s) => s.trim()).filter(Boolean),
      hardwareConcurrency: Number(coreIn.value) || 8,
      deviceMemory: Number(memIn.value) || 8,
      canvasNoise: chkWrap.querySelector('[data-key="canvasNoise"]').checked,
      audioNoise: chkWrap.querySelector('[data-key="audioNoise"]').checked,
      webrtc: chkWrap.querySelector('[data-key="webrtc"]').checked ? "block" : "off"
    };
    const updated = await API.setFingerprintField(acc.id, patch);
    Object.assign(acc, { fingerprint: updated });
    toast("已保存，重新打开该环境后生效");
    renderList();
  });
  const regenBtn = el("button", "ghost", "重新随机");
  regenBtn.addEventListener("click", async () => {
    if (!await window.DMDialogs.confirm({
      title: "重新生成环境指纹？", subject: acc.name,
      message: "将重新随机生成浏览器标识、屏幕、时区和硬件信息。",
      detail: "保存后，重新打开该账号环境即可生效。", confirmLabel: "重新生成"
    })) return;
    const next = await API.regenFingerprint(acc.id);
    acc.fingerprint = next;
    toast("已重新生成档案");
    renderPanel();
    renderList();
  });
  btns.appendChild(saveBtn);
  btns.appendChild(regenBtn);

  // 指纹体检：打开页面后跑一次探针，把页面实际值与档案逐项对照
  const checkBtn = el("button", "ghost", "指纹体检");
  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = "体检中…";
    try {
      const r = await API.call("dm:instance:fp-check", acc.id);
      showFpReport(r);
    } catch (error) {
      toast("体检失败：" + ((error && error.message) || error), true);
    } finally {
      checkBtn.disabled = false;
      checkBtn.textContent = "指纹体检";
    }
  });
  btns.appendChild(checkBtn);

  edit.appendChild(btns);
  body.appendChild(edit);
}

function showFpReport(r) {
  const mask = el("dialog", "modal-mask");
  mask.setAttribute("aria-label", "指纹体检报告");
  const box = el("div", "modal wide");
  const head = el("div", "modal-head");
  head.appendChild(el("strong", null, r.ok ? `指纹体检通过 ${r.passed}/${r.total}` : `指纹体检 ${r.failed} 项不一致`));
  const x = el("button", "dialog-close", "×");
  x.setAttribute("aria-label", "关闭弹窗");
  x.addEventListener("click", () => window.DMDialogs.close(mask));
  head.appendChild(x);
  box.appendChild(head);
  const body = el("div", "modal-body");
  const tbl = el("table", "tbl");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["检查项", "档案声明", "页面实际", ""]) hr.appendChild(el("th", null, h));
  thead.appendChild(hr);
  tbl.appendChild(thead);
  const tb = el("tbody");
  for (const item of r.items || []) {
    const tr = el("tr");
    tr.appendChild(el("td", null, item.label));
    tr.appendChild(el("td", "dim ellipsis", item.expected));
    tr.appendChild(el("td", "dim ellipsis", item.actual));
    tr.appendChild(el("td", "ops", item.note ? "参考" : item.ok ? "✅" : "❌"));
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  body.appendChild(tbl);
  body.appendChild(el("div", "hint", "「参考」项是噪声类指纹（canvas/audio/字体/子像素），本来就没有标准值，只用来确认注入层是否在工作；不一致项说明这一层没生效，重新打开环境即可重挂。"));
  box.appendChild(body);
  mask.appendChild(box);
  document.body.appendChild(mask);
  window.DMDialogs.open(mask, { remove: true });
}

function field(parent, label) {
  const f = el("div", "field");
  f.appendChild(el("label", null, label));
  parent.appendChild(f);
  return f;
}

/* ---- 代理面板 ---- */

function renderProxyPanel(body) {
  const acc = activeAccount();
  if (!acc) { body.appendChild(el("div", "hint", "先在左侧选一个环境")); return; }
  const proxy = acc.proxy || { mode: "direct" };

  const card = el("div", "card");
  card.appendChild(el("h4", null, "出口 IP"));

  const modeSel = el("select");
  [["direct", "直连（本机 IP）"], ["system", "跟随系统代理（Clash / v2rayN）"], ["custom", "自定义代理"]].forEach(([v, t]) => {
    const o = el("option", null, t);
    o.value = v;
    if (proxy.mode === v) o.selected = true;
    modeSel.appendChild(o);
  });
  const fMode = field(card, "模式");
  fMode.appendChild(modeSel);

  const fUrl = field(card, "代理地址（支持 http:// socks5:// 带账号密码）");
  const urlIn = el("input");
  urlIn.placeholder = "socks5://user:pass@1.2.3.4:1080";
  urlIn.value = proxy.url || "";
  fUrl.appendChild(urlIn);

  const btnRow = el("div", "row");
  btnRow.style.marginTop = "8px";
  const saveBtn = el("button", "primary", "保存");
  const testBtn = el("button", "ghost", "测 IP");
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(testBtn);
  card.appendChild(btnRow);

  const result = el("div", "hint");
  result.style.marginTop = "8px";
  const geo = state.proxyCache[acc.id];
  result.textContent = geo ? (geo.ok ? `${geo.ip} · ${geo.country} ${geo.region} ${geo.city} · ${geo.isp} · ${geo.latency}ms · ${geo.timezone}` : `失败：${geo.message}`) : "点「测 IP」检测当前出口";
  card.appendChild(result);
  body.appendChild(card);

  saveBtn.addEventListener("click", async () => {
    const patch = { proxy: { mode: modeSel.value, url: urlIn.value.trim() } };
    const updated = await API.updateAccount(acc.id, patch);
    if (updated) acc.proxy = updated.proxy;
    toast("代理已保存（该环境下次打开生效）");
    renderList();
  });

  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    result.textContent = "检测中…";
    const patch = { proxy: { mode: modeSel.value, url: urlIn.value.trim() } };
    await API.updateAccount(acc.id, patch);
    acc.proxy = patch.proxy;
    const r = await API.testProxy(acc.id);
    state.proxyCache[acc.id] = r;
    const mismatch = r.ok && r.timezone && acc.fingerprint && acc.fingerprint.timezone !== r.timezone;
    result.textContent = r.ok
      ? `✅ ${r.ip} · ${r.country} ${r.region} ${r.city} · ${r.isp} · ${r.latency}ms · ${r.timezone}`
        + (mismatch ? ` ｜ ⚠️ 时区不一致：指纹 ${acc.fingerprint.timezone}，出口 ${r.timezone}` : "")
      : `❌ ${r.message}（${r.latency}ms）`;
    result.style.color = mismatch ? "#f5b544" : "";
    testBtn.disabled = false;
    renderList();
  });

  const batch = el("div", "card");
  batch.appendChild(el("h4", null, "批量导入（一行一个，可带 # 备注）"));
  const ta = document.createElement("textarea");
  ta.rows = 6;
  ta.placeholder = "socks5://user:pass@1.1.1.1:1080  # 香港\nhttp://user:pass@2.2.2.2:8080   # 美国";
  batch.appendChild(ta);
  const row2 = el("div", "row");
  row2.style.marginTop = "8px";
  const parseBtn = el("button", "ghost", "解析并保存");
  const applyBtn = el("button", "ghost", "给当前环境用第一条");
  row2.appendChild(parseBtn);
  row2.appendChild(applyBtn);
  batch.appendChild(row2);
  const listBox = el("div", "hint");
  listBox.style.marginTop = "8px";
  batch.appendChild(listBox);
  body.appendChild(batch);

  parseBtn.addEventListener("click", async () => {
    const list = await API.parseProxyList(ta.value);
    listBox.textContent = `已解析 ${list.length} 条代理`;
    toast(`解析到 ${list.length} 条`);
  });
  applyBtn.addEventListener("click", async () => {
    const list = await API.parseProxyList(ta.value);
    if (!list.length) { toast("没有解析到有效代理", true); return; }
    const first = list[0];
    const url = `${first.protocol}://${first.username ? `${encodeURIComponent(first.username)}:${encodeURIComponent(first.password)}@` : ""}${first.host}:${first.port}`;
    const updated = await API.updateAccount(acc.id, { proxy: { mode: "custom", url } });
    if (updated) acc.proxy = updated.proxy;
    urlIn.value = url;
    modeSel.value = "custom";
    toast("已套用第一条代理，点「测 IP」验证");
  });
}

/* ---- 遮脸面板 ---- */

function maskImageUrl(file) {
  if (API.mediaUrl) return API.mediaUrl(file);
  const encoded = String(file).replace(/\\/g, "/").split("/")
    .map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join("/");
  const url = encoded.startsWith("//") ? "file:" + encoded : "file://" + (encoded.startsWith("/") ? encoded : "/" + encoded);
  return `${url}?preview=${Date.now()}`;
}

function showMaskImagePreview(url, name, trigger) {
  const previous = $("#maskImagePreview");
  if (previous) window.DMDialogs.close(previous);
  const mask = el("dialog", "modal-mask");
  mask.id = "maskImagePreview";
  mask.setAttribute("role", "dialog");
  mask.setAttribute("aria-modal", "true");
  mask.setAttribute("aria-labelledby", "maskImagePreviewTitle");
  const box = el("div", "modal mask-image-modal");
  const head = el("div", "modal-head");
  const title = el("strong", null, `处理后图片 · ${name}`);
  title.id = "maskImagePreviewTitle";
  title.title = name;
  head.appendChild(title);
  const close = () => window.DMDialogs.close(mask);
  const closeBtn = el("button", "dialog-close", "×");
  closeBtn.setAttribute("aria-label", "关闭预览");
  closeBtn.addEventListener("click", close);
  head.appendChild(closeBtn);
  box.appendChild(head);
  const body = el("div", "modal-body");
  const img = el("img", "hidden");
  img.alt = `处理后的 ${name}`;
  const hint = el("div", "hint", "图片加载中…");
  img.addEventListener("load", () => { img.classList.remove("hidden"); hint.remove(); });
  img.addEventListener("error", () => { img.classList.add("hidden"); hint.textContent = "图片预览加载失败，请关闭后定位文件检查。"; body.appendChild(hint); });
  img.src = url;
  body.appendChild(img);
  body.appendChild(hint);
  box.appendChild(body);
  mask.appendChild(box);
  document.body.appendChild(mask);
  window.DMDialogs.open(mask, { focus: closeBtn, remove: true, onClose: () => { if (trigger?.isConnected) trigger.focus(); } });
}

function renderMaskPanel(body) {
  const card = el("div", "card");
  card.appendChild(el("h4", null, "上传前处理素材"));
  const probe = el("div", "hint", "检测环境加载中…");
  card.appendChild(probe);
  card.appendChild(window.DMComponents.panel());
  API.probeMask().then((p) => {
    const ok = p.opencv && p.model && p.script;
    probe.innerHTML = ok
      ? `<span class="badge">OpenCV ${p.opencv}</span> <span class="badge">YuNet 模型就绪</span> <span class="badge${p.ffmpegOk ? "" : " warn"}">ffmpeg ${p.ffmpegOk ? "就绪" : "未找到"}</span>`
      : "请先安装上方的本地素材处理组件，完成后重新打开此面板即可使用。";
  });

  const fMode = field(card, "打码方式");
  const modeSel = el("select");
  [["mosaic", "马赛克（像素块）"], ["blur", "高斯模糊"], ["dot", "圆点阵（打点）"], ["black", "压暗纯色"]].forEach(([v, t]) => {
    const o = el("option", null, t);
    o.value = v;
    if ((state.settings.maskMode || "mosaic") === v) o.selected = true;
    modeSel.appendChild(o);
  });
  fMode.appendChild(modeSel);

  const fStr = field(card, "强度（块大小 / 模糊半径）");
  const strIn = document.createElement("input");
  strIn.type = "range";
  strIn.min = "4";
  strIn.max = "60";
  strIn.value = String(state.settings.maskStrength || 18);
  fStr.appendChild(strIn);
  const strVal = el("div", "hint", `${strIn.value} px`);
  strIn.addEventListener("input", () => { strVal.textContent = `${strIn.value} px`; });
  fStr.appendChild(strVal);

  const fPad = field(card, "外扩比例（把边缘也盖住）");
  const padIn = document.createElement("input");
  padIn.type = "range";
  padIn.min = "0";
  padIn.max = "60";
  padIn.value = "18";
  fPad.appendChild(padIn);
  const padVal = el("div", "hint", "0.18 倍");
  padIn.addEventListener("input", () => { padVal.textContent = `${(Number(padIn.value) / 100).toFixed(2)} 倍`; });
  fPad.appendChild(padVal);

  const keepWrap = el("label");
  keepWrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim)";
  const keepC = document.createElement("input");
  keepC.type = "checkbox";
  keepC.style.width = "auto";
  keepC.checked = state.settings.keepOriginal !== false;
  keepWrap.appendChild(keepC);
  keepWrap.appendChild(document.createTextNode("保留原文件（输出另存为 xxx_masked）"));
  card.appendChild(keepWrap);

  const btnRow = el("div", "row");
  btnRow.style.marginTop = "10px";
  const pickBtn = el("button", "ghost", "选择素材");
  const runBtn = el("button", "primary", state.maskRunning ? "处理中…" : "开始处理");
  pickBtn.disabled = runBtn.disabled = state.maskRunning;
  btnRow.appendChild(pickBtn);
  btnRow.appendChild(runBtn);
  card.appendChild(btnRow);
  body.appendChild(card);

  const listCard = el("div", "card");
  listCard.appendChild(el("h4", null, "待处理 / 结果"));
  const listBox = el("div", "mask-list");
  listBox.id = "maskList";
  listCard.appendChild(listBox);
  const bar = el("div", "progress");
  const fill = el("i");
  bar.appendChild(fill);
  listCard.appendChild(bar);
  const previews = el("div", "mask-previews");
  previews.id = "maskPreviews";
  listCard.appendChild(previews);
  body.appendChild(listCard);
  paintMaskList();

  pickBtn.addEventListener("click", async () => {
    const files = await API.pickMaskFiles();
    if (!files.length) return;
    state.maskFiles = files.concat(state.maskFiles).slice(0, 60);
    state.maskResults = [];
    $("#maskImagePreview")?.remove();
    fill.style.width = "0%";
    paintMaskList();
  });

  runBtn.addEventListener("click", async () => {
    if (state.maskRunning) return;
    if (!state.maskFiles.length) { toast("先选素材", true); return; }
    state.maskRunning = true;
    pickBtn.disabled = runBtn.disabled = true;
    runBtn.textContent = "处理中…";
    state.maskResults = [];
    $("#maskImagePreview")?.remove();
    fill.style.width = "0%";
    paintMaskList();
    try {
      const out = await API.runMask({
        files: state.maskFiles,
        mode: modeSel.value,
        strength: Number(strIn.value),
        pad: Number(padIn.value) / 100,
        keepOriginal: keepC.checked
      });
      if (out.ok) {
        state.maskResults = (out.results || []).filter((r) => r.event === "done" && typeof r.out === "string" && r.out);
        toast(`处理完成：${state.maskResults.length} 个文件`);
        const done = new Set(state.maskResults.map((r) => r.file));
        state.maskFiles = state.maskFiles.filter((f) => !done.has(f));
        fill.style.width = "100%";
        paintMaskList();
      } else {
        toast("处理失败：" + (out.message || out.stderr || "未知错误"), true);
      }
    } catch (error) {
      toast("处理失败：" + ((error && error.message) || error), true);
    } finally {
      state.maskRunning = false;
      pickBtn.disabled = runBtn.disabled = false;
      runBtn.textContent = "开始处理";
      if (!listBox.isConnected && state.panel === "mask") renderPanel();
    }
  });

  function paintMaskList() {
    if (!listBox) return;
    listBox.textContent = "";
    previews.replaceChildren();
    for (const r of state.maskResults) {
      const item = el("div", "mask-item");
      item.appendChild(el("span", null, r.out.split(/[\\/]/).pop()));
      const right = el("span", "p", `${r.faces} 张脸`);
      right.style.cursor = "pointer";
      right.addEventListener("click", () => API.showItem(r.out));
      item.appendChild(right);
      listBox.appendChild(item);
      if (r.kind === "image") {
        const name = r.out.split(/[\\/]/).pop();
        const preview = el("div", "mask-preview-card");
        const button = el("button", "mask-preview-trigger");
        button.disabled = true;
        button.title = `点击放大处理后的 ${name}`;
        button.setAttribute("aria-label", button.title);
        const img = el("img", "hidden");
        img.alt = `处理后的 ${name}`;
        img.decoding = "async";
        const hint = el("span", "hint", "预览加载中…");
        img.addEventListener("load", () => { img.classList.remove("hidden"); hint.remove(); button.disabled = false; });
        img.addEventListener("error", () => { img.classList.add("hidden"); button.disabled = true; hint.textContent = "图片预览加载失败，请定位文件检查"; button.appendChild(hint); });
        img.src = maskImageUrl(r.out);
        button.appendChild(img);
        button.appendChild(hint);
        button.addEventListener("click", () => showMaskImagePreview(img.src, name, button));
        preview.appendChild(button);
        const caption = el("div", "mask-preview-caption");
        const filename = el("strong", null, name);
        filename.title = r.out;
        caption.appendChild(filename);
        caption.appendChild(el("span", "hint", "处理后图片 · 点击图片放大"));
        preview.appendChild(caption);
        previews.appendChild(preview);
      }
    }
    for (const f of state.maskFiles) {
      const item = el("div", "mask-item");
      item.appendChild(el("span", null, f.split(/[\\/]/).pop()));
      item.appendChild(el("span", "hint", "待处理"));
      listBox.appendChild(item);
    }
    if (!state.maskFiles.length && !state.maskResults.length) {
      listBox.appendChild(el("div", "hint", "还没有素材，点「选择素材」"));
    }
  }
}

function onMaskProgress(p) {
  if (!p) return;
  if (p.event === "progress") {
    const fill = $("#drawerBody .progress > i");
    if (fill) fill.style.width = `${Math.min(99, Number(p.percent) || 0)}%`;
  } else if (p.event === "done") {
    toast(`✅ ${String(p.out || "").split(/[\\/]/).pop()}（${p.faces} 张脸）`);
  } else if (p.event === "error") {
    toast(`⚠️ ${String(p.file || "").split(/[\\/]/).pop()}：${p.message}`, true);
  }
}

boot().catch((error) => {
  toast("初始化失败：" + error.message, true);
});
