"use strict";

/* 整体包一层 IIFE：避免与 app.js 共享全局词法作用域 */
(function views () {

/**
 * 工作台视图（模板 / 任务 / 素材 / 接口 / 日志 / 设置）
 *
 * 和 app.js 的分工：app.js 只管「账号环境」那一屏（多开、指纹、代理、webview 标签），
 * 这里管其余全部。两边共用主进程的同一批模块，界面能看到的行为和 REST/MCP 完全一致。
 */

const DM = window.DM;

const V = {
  view: "accounts",
  templates: [],
  activeTemplate: "",
  selectedTemplates: new Set(),
  templateOptions: null,
  templateDirty: false,
  drafts: [],
  selectedDrafts: new Set(),
  draftBusy: false,
  draftMessage: "",
  tasks: [],
  taskFilter: "",
  apiTab: "rest",
  server: null,
  settings: {},
  models: [],
  paths: null,
  logLines: [],
  instances: []
};

/* ------------------------------------------------------------------ 工具 */

const q = (sel, root) => (root || document).querySelector(sel);
const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function svgIcon(path, cls) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls || "ic");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", path);
  svg.appendChild(p);
  return svg;
}

function trashButton(label, onClick) {
  const button = node("button", "ghost tiny danger delete-icon");
  button.title = label;
  button.setAttribute("aria-label", label);
  const icon = svgIcon("M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm3 2v8h2v-8H9zm4 0v8h2v-8h-2z");
  icon.setAttribute("aria-hidden", "true");
  button.appendChild(icon);
  button.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return button;
}

function say(text, isErr) {
  const box = q("#toasts");
  if (!box) return;
  const t = node("div", "toast" + (isErr ? " err" : ""), String(text));
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, isErr ? 5200 : 2800);
  setTimeout(() => t.remove(), 6000);
}

function draftSuccess(message) {
  qa(".draft-success-toast").forEach((t) => t.remove());
  const toast = node("div", "toast draft-success-toast", `✓ ${message}`);
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  q("#toasts").appendChild(toast);
  setTimeout(() => toast.remove(), 1800);
}

/** 统一解包主进程的 { ok, data } */
async function call(channel, ...args) {
  const r = await DM.call(channel, ...args);
  if (!r) throw new Error("主进程没有响应");
  if (r.ok === false) throw new Error(r.error || "调用失败");
  return r.data;
}

/** 出错就地提示，不打断界面 */
async function guard(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    say(String((error && error.message) || error), true);
    return fallback;
  }
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function modelLabel(value) {
  return V.models.find((m) => m.value === value)?.label || value;
}

function copyText(text) {
  try {
    navigator.clipboard.writeText(String(text));
    say("已复制");
  } catch {
    say("复制失败", true);
  }
}

// Burst events share one refresh; a change during IPC gets one follow-up read.
const refreshJobs = new Map();
const refreshTimers = new Map();
function queueRefresh(key, refresh) {
  const current = refreshJobs.get(key);
  if (current) { current.again = true; return current.promise; }
  const job = { again: false, promise: null };
  refreshJobs.set(key, job);
  job.promise = Promise.resolve().then(async () => {
    do { job.again = false; await refresh(); } while (job.again);
  }).finally(() => refreshJobs.delete(key));
  return job.promise;
}

function scheduleRefresh(key, refresh, view) {
  if (refreshTimers.has(key)) return;
  refreshTimers.set(key, setTimeout(() => {
    refreshTimers.delete(key);
    if (!document.hidden && (!view || V.view === view)) guard(refresh);
  }, 100));
}

/* ------------------------------------------------------------------ 弹窗 */

let modalOnOk = null;

function openModal(title, bodyNode, footerButtons) {
  q("#dmModalTitle").textContent = title;
  const body = q("#dmModalBody");
  body.replaceChildren(bodyNode);
  const foot = q("#dmModalFoot");
  foot.replaceChildren();
  for (const b of footerButtons || []) {
    const btn = node("button", b.kind === "primary" ? "primary" : "ghost", b.label);
    btn.addEventListener("click", () => {
      if (b.onClick) b.onClick();
      if (b.close !== false) closeModal();
    });
    foot.appendChild(btn);
  }
  q("#dmModal").classList.remove("hidden");
}

function closeModal() {
  q("#dmModal").classList.add("hidden");
  modalOnOk = null;
}

function field(label, input) {
  const wrap = node("div", "field");
  wrap.appendChild(node("label", "", label));
  wrap.appendChild(input);
  return wrap;
}

function textInput(value, placeholder, multiline, rows) {
  const el = document.createElement(multiline ? "textarea" : "input");
  if (multiline) el.rows = rows || 8;
  el.value = value == null ? "" : String(value);
  if (placeholder) el.placeholder = placeholder;
  return el;
}

/* ------------------------------------------------------------- 视图切换 */

async function setView(name) {
  if (V.view === "templates" && name !== "templates" && V.templateDirty) {
    if (!await guard(saveTemplate, null)) return;
  }
  if (V.view === "assets" && name !== "assets") qa("#assetBody video").forEach((video) => video.pause());
  V.view = name;
  qa(".vtab").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  qa(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${name}`));
  if (name === "templates") await guard(refreshTemplates);
  if (name === "drafts") await guard(refreshDrafts);
  if (name === "tasks") refreshTasks();
  if (name === "assets") refreshAssets();
  if (name === "api") refreshApi();
  if (name === "logs") refreshLogs();
  if (name === "settings") refreshSettings();
}

/* ------------------------------------------------------------ 通用数据 */

async function refreshBadges() {
  return queueRefresh("badges", updateBadges);
}

async function updateBadges() {
  const state = await guard(() => call("dm:state"), null);
  if (state) {
    V.settings = state.settings || V.settings;
    q("#verText").textContent = `v${state.brand.version}`;
    V.models = state.models;
    q("#homeAccounts").textContent = String((state.counts && state.counts.instances) || 0);
    q("#homeTemplates").textContent = String((state.counts && state.counts.templates) || 0);
    q("#homeRunning").textContent = String(((state.orchestrator && state.orchestrator.running) || []).length);
    const work = q("#sbWork");
    if (work) {
      const o = state.orchestrator || {};
      work.textContent = `WORK ${(o.running || []).length}/${o.parallel || 0} · Q${o.queued || 0} · F${o.failed || 0}`;
    }
    const dot = q("#taskDot");
    if (dot) dot.classList.toggle("on", ((state.orchestrator && state.orchestrator.running) || []).length > 0);
  }
  if (!state) return;
  V.server = state.server;
  const badge = q("#vbServer");
  if (badge) {
    const on = !!(V.server && V.server.port);
    badge.textContent = on ? `API :${V.server.port}` : "API 关";
    badge.classList.toggle("ok", on);
  }
}

/* ============================================================== 任务模板 */

async function refreshTemplates() {
  const result = await call("dm:templates");
  V.templates = result.items;
  V.selectedTemplates = new Set([...V.selectedTemplates].filter((id) => V.templates.some((t) => t.id === id)));
  V.templateOptions = result.options;
  V.models = result.options.models;
  if (!V.templates.some((t) => t.id === V.activeTemplate)) V.activeTemplate = V.templates[0]?.id || "";
  renderTemplateList();
  if (!V.templateDirty) renderTemplateEditor();
  await refreshDrafts();
}

function renderTemplateList() {
  const box = q("#templateList");
  box.replaceChildren();
  q("#templateCount").textContent = String(V.templates.length);
  q("#templatesAddDrafts").disabled = V.draftBusy || !V.selectedTemplates.size;
  q("#templateSelection").textContent = `已选 ${V.selectedTemplates.size} 个模板`;
  if (!V.templates.length) box.appendChild(node("div", "empty-hint", "还没有模板，点击「新建模板」开始。"));
  for (const template of V.templates) {
    const row = node("div", "template-select-row");
    const check = node("input");
    check.type = "checkbox";
    check.checked = V.selectedTemplates.has(template.id);
    check.disabled = V.draftBusy;
    check.setAttribute("aria-label", `选择模板「${template.name}」`);
    check.addEventListener("change", () => { check.checked ? V.selectedTemplates.add(template.id) : V.selectedTemplates.delete(template.id); renderTemplateList(); });
    const button = node("button", "template-item" + (template.id === V.activeTemplate ? " active" : ""));
    button.appendChild(node("strong", "", template.name));
    button.appendChild(node("span", "", `${modelLabel(template.model)} · ${template.duration}s · ${template.attachments.length} 附件`));
    button.addEventListener("click", () => guard(async () => {
      if (V.templateDirty) await saveTemplate();
      V.activeTemplate = template.id;
      renderTemplateList();
      renderTemplateEditor();
    }));
    row.append(check, button);
    box.appendChild(row);
  }
}

function renderDuration(value) {
  const model = V.templateOptions.models.find((m) => m.value === q("#templateModel").value);
  const input = q("#templateDuration");
  input.min = String(model.minDuration);
  input.max = String(model.maxDuration);
  input.value = String(Math.max(model.minDuration, Math.min(Math.round(Number(value) || 5), model.maxDuration)));
  q("#templateDurationMin").textContent = `${model.minDuration} 秒`;
  q("#templateDurationMax").textContent = `${model.maxDuration} 秒`;
  renderDurationValue();
}

function renderDurationValue() {
  const input = q("#templateDuration");
  const label = `${input.value} 秒`;
  q("#templateDurationValue").value = label;
  input.setAttribute("aria-valuetext", label);
  input.style.setProperty("--duration-progress", `${(Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
}

function renderRatio(value) {
  const box = q("#templateRatio");
  box.dataset.value = value;
  box.replaceChildren();
  for (const ratio of V.templateOptions.ratios) {
    const button = node("button", "ratio-option", ratio.label);
    button.type = "button";
    button.dataset.ratio = ratio.value;
    button.setAttribute("aria-pressed", String(ratio.value === value));
    const shape = node("i", "ratio-shape" + (ratio.value === "adaptive" ? " auto" : ""));
    shape.setAttribute("aria-hidden", "true");
    const [w, h] = ratio.value === "adaptive" ? [1, 1] : ratio.value.split(":").map(Number);
    shape.style.setProperty("--ratio-width", `${20 * w / Math.max(w, h)}px`);
    shape.style.setProperty("--ratio-height", `${20 * h / Math.max(w, h)}px`);
    button.prepend(shape);
    button.addEventListener("click", () => { renderRatio(ratio.value); markTemplateDirty(); });
    box.appendChild(button);
  }
}

function renderTemplateEditor() {
  const template = V.templates.find((t) => t.id === V.activeTemplate);
  q("#templateEmpty").classList.toggle("hidden", !!template);
  q("#templateEditor").classList.toggle("hidden", !template);
  if (!template) return;
  q("#templateName").value = template.name;
  q("#templatePrompt").value = template.prompt;
  const model = q("#templateModel");
  model.replaceChildren();
  for (const m of V.templateOptions.models) {
    const option = node("option", "", m.label);
    option.value = m.value;
    model.appendChild(option);
  }
  model.value = template.model;
  renderDuration(template.duration);
  renderRatio(template.ratio || "adaptive");
  q("#templateSaveState").textContent = `已保存 · ${fmtTime(template.updatedAt)}`;
  q("#templateAttachmentDir").textContent = V.templateOptions.directory;
  renderTemplateAttachments(template);
}

function renderTemplateAttachments(template) {
  const box = q("#templateAttachments");
  box.replaceChildren();
  q("#attachmentCount").textContent = `${template.attachments.length} 个`;
  if (!template.attachments.length) box.appendChild(node("div", "attachment-empty", "添加参考图片或视频。文件会复制到本地，原文件移动后仍可使用。"));
  for (const file of template.attachments) {
    const row = node("div", "attachment-row");
    row.appendChild(node("span", "attachment-kind", file.mime.startsWith("video/") ? "视频" : "图片"));
    const info = node("div", "attachment-info");
    info.appendChild(node("strong", "", file.name));
    const size = file.size >= 1048576 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    info.appendChild(node("span", file.missing ? "attachment-missing" : "", file.missing ? "旧附件未能复制，请移除后重新添加" : `${size} · 已保存到本地`));
    row.appendChild(info);
    const open = node("button", "ghost tiny", "定位");
    open.title = file.path;
    open.addEventListener("click", () => DM.showItem(file.path));
    row.appendChild(open);
    row.appendChild(trashButton(`移除附件「${file.name}」`, () => guard(async () => {
      await saveTemplate();
      await call("dm:template:detach", template.id, file.id);
      await refreshTemplates();
    })));
    box.appendChild(row);
  }
}

function markTemplateDirty() {
  V.templateDirty = true;
  q("#templateSaveState").textContent = "有未保存的修改";
}

async function saveTemplate() {
  if (!V.activeTemplate) return null;
  const id = V.activeTemplate;
  const patch = { name: q("#templateName").value, prompt: q("#templatePrompt").value, model: q("#templateModel").value, duration: Number(q("#templateDuration").value), ratio: q("#templateRatio").dataset.value };
  const item = await call("dm:template:update", id, patch);
  V.templates = V.templates.map((t) => t.id === id ? item : t);
  const current = { name: q("#templateName").value, prompt: q("#templatePrompt").value, model: q("#templateModel").value, duration: Number(q("#templateDuration").value), ratio: q("#templateRatio").dataset.value };
  V.templateDirty = JSON.stringify(current) !== JSON.stringify(patch);
  renderTemplateList();
  q("#templateSaveState").textContent = V.templateDirty ? "有未保存的修改" : `已保存 · ${fmtTime(item.updatedAt)}`;
  return item;
}

async function newTemplate() {
  if (V.templateDirty) await saveTemplate();
  const item = await call("dm:template:create", { name: `任务模板 ${V.templates.length + 1}` });
  V.activeTemplate = item.id;
  V.templateDirty = false;
  await refreshTemplates();
  await refreshBadges();
  q("#templateName").focus();
  q("#templateName").select();
}

function deleteTemplate() {
  const template = V.templates.find((t) => t.id === V.activeTemplate);
  if (!template) return;
  openModal("删除任务模板", node("div", "hint", `删除「${template.name}」？已提交的任务及附件副本会保留。`), [
    { label: "取消" },
    { label: "确认删除", kind: "primary", close: false, onClick: () => guard(async () => {
      await call("dm:template:remove", template.id);
      V.templateDirty = false;
      closeModal();
      await refreshTemplates();
      await refreshBadges();
      say("模板已删除");
    }) }
  ]);
}

async function attachTemplateFiles() {
  const input = q("#templateFileInput");
  const files = Array.from(input.files || []).map((file) => DM.filePath(file));
  input.value = "";
  if (!files.length) return;
  q("#templateAddFiles").disabled = true;
  q("#templateSubmit").disabled = true;
  q("#templateAddDraft").disabled = true;
  try {
    const template = await saveTemplate();
    await call("dm:template:attach", template.id, files);
    await refreshTemplates();
    say(`已将 ${files.length} 个附件保存到本地`);
  } finally {
    q("#templateAddFiles").disabled = false;
    q("#templateSubmit").disabled = false;
    q("#templateAddDraft").disabled = false;
  }
}

async function submitTemplate() {
  const button = q("#templateSubmit");
  if (button.disabled) return;
  button.disabled = true;
  try {
    const template = await saveTemplate();
    await call("dm:template:submit", template.id);
    say("任务已提交，可在任务队列查看进度");
    await setView("tasks");
  } finally { button.disabled = false; }
}

function bindTemplateEvents() {
  q("#templateAddDraft").addEventListener("click", () => guard(addTemplateDraft));
  q("#templatesAddDrafts").addEventListener("click", () => guard(() => addTemplateDraft(true)));
  q("#templateShowDrafts").addEventListener("click", () => setView("drafts"));
  q("#draftAccount").addEventListener("change", renderDrafts);
  q("#draftRefresh").addEventListener("click", () => guard(refreshDrafts));
  q("#draftSubmit").addEventListener("click", () => guard(submitSelectedDrafts));
  q("#draftSave").addEventListener("click", () => guard(async () => {
    if (q("#draftSave").disabled) return;
    V.draftBusy = true; V.draftMessage = ""; renderDrafts(); renderTemplateList();
    try {
      const result = await call("dm:drafts:save", [...V.selectedDrafts], { instanceId: q("#draftAccount").value });
      draftSuccess(`保存成功：${result.count} 条任务已存入 ${result.instanceName} 的豆包草稿`);
    } finally { V.draftBusy = false; await refreshDrafts(); renderTemplateList(); }
  }));
  q("#draftSelectAll").addEventListener("change", (event) => {
    V.selectedDrafts = new Set(event.target.checked ? V.drafts.map((d) => d.id) : []);
    renderDrafts();
  });
  q("#templateNew").addEventListener("click", () => guard(newTemplate));
  q("#templateEmptyNew").addEventListener("click", () => guard(newTemplate));
  q("#templateSave").addEventListener("click", () => guard(async () => { await saveTemplate(); say("模板已保存"); }));
  q("#templateDelete").replaceChildren(svgIcon("M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm3 2v8h2v-8H9zm4 0v8h2v-8h-2z"));
  q("#templateDelete").addEventListener("click", deleteTemplate);
  q("#templateSubmit").addEventListener("click", () => guard(submitTemplate));
  q("#templateAddFiles").addEventListener("click", () => q("#templateFileInput").click());
  q("#templateFileInput").addEventListener("change", () => guard(attachTemplateFiles));
  q("#templateOpenDir").addEventListener("click", () => DM.openPath(V.templateOptions.directory));
  for (const selector of ["#templateName", "#templatePrompt", "#templateDuration"]) q(selector).addEventListener("input", markTemplateDirty);
  q("#templateDuration").addEventListener("input", renderDurationValue);
  q("#templateModel").addEventListener("change", () => { renderDuration(q("#templateDuration").value); markTemplateDirty(); });
}

async function refreshDrafts() {
  V.drafts = await call("dm:drafts");
  const account = q("#draftAccount"), chosen = account.value;
  V.instances = await call("dm:instances");
  account.replaceChildren(node("option", "", "请选择豆包账号"));
  account.firstElementChild.value = "";
  for (const inst of V.instances) { const option = node("option", "", inst.name); option.value = inst.id; account.appendChild(option); }
  account.value = V.instances.some((i) => i.id === chosen) ? chosen : "";
  V.selectedDrafts = new Set([...V.selectedDrafts].filter((id) => V.drafts.some((d) => d.id === id)));
  renderDrafts();
}

function renderDrafts() {
  q("#draftCount").textContent = String(V.drafts.length);
  q("#draftSelection").textContent = `已选 ${V.selectedDrafts.size} / ${V.drafts.length} 条`;
  const selected = V.drafts.filter((d) => V.selectedDrafts.has(d.id));
  const account = q("#draftAccount").value;
  const mismatch = selected.find((d) => d.instanceId && d.instanceId !== account);
  const uncertain = selected.some((d) => d.nativeState === "saving" || d.submissionRecord?.task.submissionUncertain);
  const ready = selected.every((d) => d.nativeState === "saved" || d.submissionRecord);
  const blocked = V.draftBusy || !selected.length || !account || !!mismatch || uncertain;
  q("#draftSubmit").disabled = blocked || !ready;
  q("#draftSave").disabled = blocked || selected.some((d) => d.submissionRecord);
  q("#draftStatus").textContent = V.draftBusy ? V.draftMessage || "正在处理所选草稿，请稍候…" : !selected.length ? "勾选要一起保存或发送的草稿。" : !account ? "请在上方选择一个豆包账号，再保存或发送所选草稿。" : mismatch ? `所选草稿包含 ${mismatch.instanceName || "其他账号"} 的网页草稿，请只勾选同一账号的草稿，并选择该账号。` : uncertain ? "部分草稿上次操作尚未确认，请先打开所属账号的豆包页面核对。" : !ready ? "先点击 ①，将所选草稿全部存入豆包网页，再点击 ② 一起发送。" : `所选草稿将由 ${V.instances.find((i) => i.id === account)?.name || "所选账号"} 通过云电脑同时提交。`;
  q("#templateAddDraft").disabled = V.draftBusy;
  q("#draftAccount").disabled = V.draftBusy;
  const all = q("#draftSelectAll");
  all.checked = !!V.drafts.length && V.selectedDrafts.size === V.drafts.length;
  all.indeterminate = V.selectedDrafts.size > 0 && V.selectedDrafts.size < V.drafts.length;
  all.disabled = V.draftBusy || !V.drafts.length;
  const box = q("#draftList");
  box.replaceChildren();
  if (!V.drafts.length) box.appendChild(node("div", "empty-hint", "在「任务提交」中勾选多个不同模板，点击「所选模板加入草稿箱」，再到这里指定账号、统一保存和发送。"));
  for (const draft of V.drafts) {
    const t = draft.template;
    const row = node("div", "draft-row");
    const check = node("input");
    check.type = "checkbox";
    check.checked = V.selectedDrafts.has(draft.id);
    check.disabled = V.draftBusy;
    check.setAttribute("aria-label", `选择草稿「${t.name}」`);
    check.addEventListener("change", () => { check.checked ? V.selectedDrafts.add(draft.id) : V.selectedDrafts.delete(draft.id); renderDrafts(); });
    const info = node("div", "draft-info");
    info.appendChild(node("strong", "", t.name));
    info.appendChild(node("small", "draft-number", draft.draftNumber ? `编号：${draft.draftNumber}` : draft.nativeState ? "旧版草稿（未编号）；重新加入草稿箱后可按编号识别" : "保存到豆包时自动生成编号"));
    const state = draft.submissionRecord?.task.submissionUncertain ? "发送结果待核对" : draft.nativeState === "sent" ? "已发送，待取回结果" : draft.nativeState === "saved" ? "已存入豆包草稿" : draft.nativeState === "saving" ? "保存结果待核对" : "待存入豆包";
    info.appendChild(node("small", "", `${state}${draft.instanceName ? ` · ${draft.instanceName}` : ""}`));
    if (draft.nativeError) info.appendChild(node("small", "attachment-missing", draft.nativeError));
    info.appendChild(node("p", "", t.prompt));
    info.appendChild(node("small", "", `${draft.executionMode !== "work" && draft.instanceId ? "旧版对话草稿，请重新加入云电脑草稿" : "工作任务 · 云电脑"} · ${modelLabel(t.model)} · ${t.duration} 秒 · ${t.attachments.length} 附件 · ${fmtTime(draft.createdAt)}`));
    row.append(check, info);
    const remove = trashButton(`移除草稿「${t.name}」`, () => {
      openModal("移除草稿记录", node("div", "hint", `移除「${t.name}」的软件记录？豆包网页中的草稿、原模板和本地附件会保留。`), [
        { label: "取消" }, { label: "移除", close: false, onClick: () => guard(async () => { await call("dm:draft:remove", draft.id); closeModal(); await refreshDrafts(); }) }
      ]);
    });
    remove.disabled = V.draftBusy;
    row.appendChild(remove);
    box.appendChild(row);
  }
}

async function addTemplateDraft(multiple = false) {
  if (V.draftBusy) return;
  V.draftBusy = true; V.draftMessage = ""; renderDrafts(); renderTemplateList();
  try {
    const template = await saveTemplate();
    const added = await call("dm:drafts:collect", multiple ? [...V.selectedTemplates] : [template.id]);
    V.selectedDrafts = new Set(added.map((d) => d.id));
    draftSuccess(`${multiple ? `${added.length} 条任务` : `「${template.name}」`}已加入草稿箱`);
  } finally { V.draftBusy = false; await refreshDrafts(); renderTemplateList(); }
}

async function submitSelectedDrafts() {
  if (q("#draftSubmit").disabled) return;
  const ids = [...V.selectedDrafts];
  V.draftBusy = true;
  V.draftMessage = "正在准备所选草稿，全部就绪后同时提交…";
  renderDrafts(); renderTemplateList();
  let result;
  try {
    result = await call("dm:drafts:submit", ids, { instanceId: q("#draftAccount").value });
    ids.forEach((id) => V.selectedDrafts.delete(id));
    say(`${result.count} 条草稿已由 ${result.instanceName} 全部发送，正在取回视频结果`);
  } finally {
    V.draftBusy = false;
    await refreshDrafts();
    renderTemplateList();
  }
  if (result) await setView("tasks");
}


/* ============================================================== 任务队列 */

const jianyingOpeningTasks = new Set();

async function refreshTasks() {
  return queueRefresh("tasks", updateTasks);
}

async function updateTasks() {
  const status = V.taskFilter;
  const filter = {};
  if (V.taskFilter) filter.status = V.taskFilter;
  filter.limit = 200;
  const tasks = await guard(() => call("dm:tasks", filter), []) || [];
  if (status !== V.taskFilter) return;
  V.tasks = tasks;
  if (V.view === "tasks") renderTaskTable();
}

function taskStatusText(task) {
  const statuses = { queued: "排队中", running: "处理中", succeeded: "已完成", failed: "失败", cancelled: "已取消" };
  const stages = { waiting_account: "等待可用账号", waiting_confirmation: "等待参数确认", waiting_result: "等待平台结果", retrying: "等待重试", preparing: "准备账号", submitting: "提交中", generating: "生成中", downloading: "下载并检查成片", completed: "已完成", failed: "失败", cancelled: "已取消" };
  if (["failed", "cancelled"].includes(task.status)) return statuses[task.status];
  const label = stages[task.stage] || statuses[task.status] || task.status;
  const progress = Number(task.progress);
  return task.stage === "generating" && Number.isFinite(progress) ? `${label} ${Math.max(0, Math.min(100, progress))}%` : label;
}

function taskResultText(task) {
  const result = task.result || {};
  const messages = [task.error, task.waitReason];
  if (result.downloadSkipped) messages.push("自动下载已关闭，视频尚未保存到素材库");
  if (result.warning) messages.push(result.warning);
  if (Array.isArray(result.warnings)) messages.push(...result.warnings);
  if (result.files?.length && (result.watermark === "kept" || result.unwatermarked === false)) messages.push("成片尚未确认为无水印");
  messages.push(...(result.files || []).map((file) => String(file).split(/[\\/]/).pop()));
  return [...new Set(messages.filter(Boolean))].join("；") || "—";
}

function renderTaskTable() {
  const wrap = q("#taskTable");
  wrap.replaceChildren();
  if (!V.tasks.length) {
    wrap.appendChild(node("div", "empty-hint", "还没有任务。去「任务提交」创建模板，填写提示词并提交。"));
    return;
  }
  const table = node("table", "tbl task-table");
  const thead = node("thead");
  const hr = node("tr");
  for (const [label, cls] of [["时间", "task-time"], ["任务 / 模板", "task-name"], ["模型 / 时长", "task-model"], ["账号", "task-account"], ["状态", "task-status"], ["耗时", "task-elapsed"], ["结果 / 提示", "task-result"], ["操作", "task-ops"]]) {
    const heading = node("th", cls, label);
    heading.scope = "col";
    hr.appendChild(heading);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = node("tbody");
  for (const t of V.tasks) {
    const tr = node("tr", "row-" + t.status);
    const time = node("td", "task-time");
    const timeValue = node("span", "task-pill", fmtTime(t.createdAt));
    timeValue.title = t.createdAt || "";
    time.appendChild(timeValue);
    tr.appendChild(time);
    const name = node("td", "task-name");
    const nameValue = node("span", "task-pill task-truncate", t.templateName || t.prompt || "历史任务");
    nameValue.title = nameValue.textContent;
    name.appendChild(nameValue);
    if (t.executionMode === "work") nameValue.title += " · 工作任务 · 云电脑";
    tr.appendChild(name);
    const model = node("td", "task-model");
    const modelValues = node("div", "task-model-values");
    const modelValue = node("span", "task-pill task-truncate", t.model ? modelLabel(t.model) : "—");
    modelValue.title = modelValue.textContent;
    modelValues.appendChild(modelValue);
    if (t.model) modelValues.appendChild(node("span", "task-pill task-duration", `${t.duration} 秒`));
    model.appendChild(modelValues);
    tr.appendChild(model);
    const account = node("td", "task-account");
    const batchAccount = t.draftBatchId && V.instances.find((i) => i.id === t.preferredInstanceId);
    const accountValue = node("span", "task-pill task-truncate", t.instanceName || t.instanceId || batchAccount?.name || "—");
    accountValue.title = accountValue.textContent;
    account.appendChild(accountValue);
    tr.appendChild(account);
    const status = node("td", "task-status");
    status.appendChild(node("span", "task-pill task-status-badge status-" + t.status, taskStatusText(t)));
    tr.appendChild(status);
    const elapsed = node("td", "task-elapsed");
    elapsed.appendChild(node("span", "task-pill", t.finishedAt ? fmtDur(new Date(t.finishedAt) - new Date(t.createdAt)) : "—"));
    tr.appendChild(elapsed);
    const info = node("td", "task-result");
    const result = t.result || {};
    const resultWarning = result.warning || result.warnings?.length || result.downloadSkipped || (result.files?.length && (result.watermark === "kept" || result.unwatermarked === false));
    const resultTone = t.error ? " is-error" : resultWarning ? " is-warning" : "";
    info.appendChild(node("span", "task-pill task-truncate" + resultTone, taskResultText(t)));
    info.title = info.textContent;
    tr.appendChild(info);
    const ops = node("td", "task-ops");
    const actions = node("div", "task-actions");
    if (["failed", "cancelled", "queued"].includes(t.status)) {
      const retry = node("button", "ghost tiny task-retry", t.submittedAt || t.generatedAt ? "继续取回" : t.status === "queued" ? "继续" : "重试");
      retry.addEventListener("click", async () => {
        await guard(async () => {
          const result = await call("dm:task:retry", t.id);
          if (!result.ok) throw new Error(result.error);
          say("已加入队列");
          refreshTasks();
        });
      });
      actions.appendChild(retry);
      const redispatch = node("button", "ghost tiny", "改派");
      redispatch.addEventListener("click", () => redispatchTask(t));
      if (t.status !== "queued") actions.appendChild(redispatch);
    }
    if (t.templateId && ["running", "queued"].includes(t.status)) {
      const stop = node("button", "ghost tiny danger", "停止");
      stop.addEventListener("click", () => guard(async () => { await call("dm:task:stop", t.id); await refreshTasks(); }));
      actions.appendChild(stop);
    }
    if (t.result && (t.result.files || []).length) {
      const open = node("button", "ghost tiny", "打开位置");
      open.title = "在文件资源管理器中定位生成的视频文件";
      open.addEventListener("click", () => DM.showItem(t.result.files[0]));
      actions.appendChild(open);
      const edit = node("button", "ghost tiny task-draft", jianyingOpeningTasks.has(t.id) ? "正在打开…" : "在剪映中编辑");
      edit.disabled = jianyingOpeningTasks.has(t.id);
      edit.title = "将视频发送到剪映继续剪辑；剪映已打开工程时，会加入当前工程";
      edit.addEventListener("click", () => chooseTaskVideoForJianying(t));
      actions.appendChild(edit);
    }
    ops.appendChild(actions);
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

async function editTaskInJianying(task, file) {
  if (jianyingOpeningTasks.has(task.id)) return;
  jianyingOpeningTasks.add(task.id);
  renderTaskTable();
  try {
    await guard(async () => {
      const result = await call("dm:jianying:edit", { taskId: task.id, file });
      if (result?.ok !== true || typeof result.file !== "string" || !result.file.trim()) {
        throw new Error(result?.error || "未能确认视频已发送到剪映，请重试");
      }
      say("已发送到剪映，可在剪映时间线继续编辑");
    });
  } finally {
    jianyingOpeningTasks.delete(task.id);
    renderTaskTable();
  }
}

function chooseTaskVideoForJianying(task) {
  if (jianyingOpeningTasks.has(task.id)) return;
  const files = task.result?.files || [];
  if (!files.length) return;
  if (files.length === 1) return editTaskInJianying(task, files[0]);
  const wrap = node("div");
  wrap.appendChild(node("p", "hint", `此任务有 ${files.length} 个视频，请选择本次要编辑的一个。其余视频仍保留在任务结果中。剪映已打开工程时，所选视频会加入当前工程。`));
  const select = node("select");
  for (const [index, file] of files.entries()) {
    const option = node("option", "", `${index + 1}. ${String(file).split(/[\\/]/).pop()}`);
    option.value = file;
    option.title = file;
    select.appendChild(option);
  }
  const selectedPath = node("p", "s-value", select.value);
  select.title = select.value;
  select.addEventListener("change", () => { selectedPath.textContent = select.value; select.title = select.value; });
  wrap.appendChild(field("选择视频", select));
  wrap.appendChild(selectedPath);
  openModal("在剪映中编辑", wrap, [
    { label: "取消" },
    { label: "打开所选视频", kind: "primary", onClick: () => editTaskInJianying(task, select.value) }
  ]);
}

async function redispatchTask(task) {
  const list = V.instances.length ? V.instances : await guard(() => call("dm:instances"), []) || [];
  if (!list.length) return say("还没有实例", true);
  const wrap = node("div", "");
  const sel = document.createElement("select");
  for (const inst of list) {
    const o = document.createElement("option");
    o.value = inst.id;
    o.textContent = `${inst.name} · ${inst.platform}`;
    sel.appendChild(o);
  }
  wrap.appendChild(field("改派到实例", sel));
  openModal("改派任务", wrap, [
    { label: "取消" },
    {
      label: "改派",
      kind: "primary",
      onClick: async () => {
        await guard(async () => {
          const result = await call("dm:task:redispatch", task.id, sel.value);
          if (!result.ok) throw new Error(result.error);
          say("已改派");
          await refreshTasks();
        });
      }
    }
  ]);
}

/* ============================================================== 素材库 */

let assetGrid = null;
const assetCards = new Map();

async function refreshAssets() {
  return queueRefresh("assets", updateAssets);
}

async function updateAssets() {
  const result = await guard(() => call("dm:videos"), null);
  if (V.view !== "assets") return;
  const body = q("#assetBody");
  q("#videoCount").textContent = String(result?.items.length || 0);
  q("#videoDirectory").textContent = result ? `保存目录：${result.directory}` : "";
  if (!result?.items.length) {
    assetGrid = null;
    assetCards.clear();
    body.replaceChildren(node("div", "empty-hint", result
      ? "还没有保存的成片。生成并下载完成后，视频会自动出现在这里。"
      : "读取视频目录失败，请检查目录后刷新。"));
    return;
  }
  if (!assetGrid) { assetGrid = node("div", "video-grid"); body.replaceChildren(assetGrid); }
  const paths = new Set(result.items.map((item) => item.path));
  for (const [file, cached] of assetCards) {
    if (!paths.has(file)) { cached.card.remove(); assetCards.delete(file); }
  }
  result.items.forEach((item, index) => {
    const signature = JSON.stringify(item);
    let cached = assetCards.get(item.path);
    if (!cached || cached.signature !== signature) {
      const card = videoCard(item);
      if (cached) cached.card.replaceWith(card);
      cached = { signature, card };
      assetCards.set(item.path, cached);
    }
    // Inserting a new first item leaves existing players attached and playing.
    if (assetGrid.children[index] !== cached.card) assetGrid.insertBefore(cached.card, assetGrid.children[index] || null);
  });
}

function videoCard(item) {
  const card = node("article", "video-card");
  const player = document.createElement("video");
  player.src = item.url;
  player.controls = true;
  player.preload = "metadata";
  player.setAttribute("aria-label", item.name);
  player.addEventListener("play", () => qa("#assetBody video").forEach((other) => { if (other !== player) other.pause(); }));
  player.addEventListener("error", () => {
    const hint = node("div", "video-preview-error", "此格式请使用下方「打开视频」播放。");
    player.replaceWith(hint);
  }, { once: true });
  card.appendChild(player);
  const meta = node("div", "video-meta");
  const title = node("strong", "", item.name);
  title.title = item.name;
  meta.appendChild(title);
  const size = item.size >= 1048576 ? `${(item.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(item.size / 1024))} KB`;
  meta.appendChild(node("p", "", `${size} · ${fmtTime(item.modifiedAt)}`));
  if (item.templateName) meta.appendChild(node("p", "", item.templateName));
  if (item.model) meta.appendChild(node("p", "", `${modelLabel(item.model)} · ${item.duration} 秒`));
  meta.appendChild(node("p", "", item.watermark === "none" ? "无水印成片" : item.watermark === "kept" ? "成片保留水印" : "水印状态未确认"));
  card.appendChild(meta);
  const actions = node("div", "video-actions");
  const open = node("button", "ghost tiny", "打开视频");
  open.addEventListener("click", () => guard(() => DM.openPath(item.path)));
  const locate = node("button", "ghost tiny", "打开所在文件夹");
  locate.addEventListener("click", () => DM.showItem(item.path));
  actions.append(open, locate);
  card.appendChild(actions);
  return card;
}

/* ============================================================ 接口 / MCP */

const REST_ENDPOINTS = [
  ["GET", "/api/state", "整体状态：编排器、额度、线程数"],
  ["GET", "/api/instances", "实例列表（含今日额度、登录态）"],
  ["POST", "/api/instances", "新建实例 { name, platform, url, proxy }"],
  ["PATCH", "/api/instances/:id", "改实例（名称/代理/指纹字段）"],
  ["DELETE", "/api/instances/:id", "删实例（连会话分区一起清）"],
  ["POST", "/api/instances/:id/probe", "探活登录态"],
  ["POST", "/api/instances/:id/fp-check", "指纹体检：页面实际值 vs 本地档案"],
  ["POST", "/api/instances/:id/open", "取该实例当前页面地址（内嵌内核）"],
  ["POST", "/api/instances/:id/cookie", "导入 CK 文本"],
  ["GET", "/api/instances/:id/cookie", "导出 CK（JSON）"],
  ["GET", "/api/storyboards", "分镜稿列表"],
  ["POST", "/api/storyboards/import", "从 Markdown 导入 { name, text }"],
  ["GET", "/api/storyboards/:id", "单个分镜 + 统计 + 任务"],
  ["POST", "/api/storyboards/:id/start", "开始批量派发"],
  ["POST", "/api/storyboards/:id/pause", "暂停"],
  ["POST", "/api/storyboards/:id/resume", "继续"],
  ["POST", "/api/storyboards/:id/stop", "停止"],
  ["PATCH", "/api/storyboards/:id/shots/:shotId", "改镜头（提示词/时长/模型/参考图）"],
  ["GET", "/api/storyboards/:id/export", "导出 Markdown"],
  ["GET", "/api/tasks", "任务列表 ?status=&storyboardId=&limit="],
  ["POST", "/api/tasks/:id/retry", "重试任务"],
  ["POST", "/api/tasks/:id/redispatch", "改派到指定实例"],
  ["GET", "/api/quota", "额度快照"],
  ["POST", "/api/quota/:id/reset", "重置某实例的今日额度"],
  ["GET", "/api/resources", "拦截到的媒资 ?kind=&unwatermarked="],
  ["POST", "/api/resources/:id/download", "下载媒资到本地"],
  ["POST", "/api/jianying/draft", "生成剪映草稿"],
  ["POST", "/api/prompt/check", "提示词合规自检"],
  ["POST", "/api/prompt/appeal", "生成申诉文案"],
  ["GET", "/api/assets", "素材卡片 ?kind="],
  ["GET", "/api/logs", "日志 ?limit=&q="],
  ["GET", "/api/paths", "所有落盘目录"],
  ["GET", "/api/server", "本地服务信息"],
  ["POST", "/api/token/rotate", "轮换 Bearer token"],
  ["GET", "/api/events", "SSE 事件流（?token=）"]
];

async function refreshApi() {
  qa("[data-api-tab]").forEach((b) => b.classList.toggle("active", b.dataset.apiTab === V.apiTab));
  const box = q("#apiBody");
  box.replaceChildren();
  const server = V.server || await guard(() => call("dm:server"), null);
  const paths = V.paths || await guard(() => DM.paths(), null);
  const base = server ? `http://127.0.0.1:${server.port}` : "http://127.0.0.1:17823";

  if (V.apiTab === "rest") {
    const head = node("div", "api-head");
    const line = node("div", "api-line");
    line.appendChild(node("span", "api-k", "BASE"));
    line.appendChild(node("code", "api-v", base));
    const cp = node("button", "ghost tiny", "复制");
    cp.addEventListener("click", () => copyText(base));
    line.appendChild(cp);
    head.appendChild(line);

    const tokenLine = node("div", "api-line");
    tokenLine.appendChild(node("span", "api-k", "TOKEN"));
    const token = (server && (server.token || server.tokenHint)) || "(见 api-token.txt)";
    tokenLine.appendChild(node("code", "api-v", token));
    const cpt = node("button", "ghost tiny", "复制");
    cpt.addEventListener("click", () => copyText(token));
    tokenLine.appendChild(cpt);
    head.appendChild(tokenLine);
    head.appendChild(node("div", "hint", "所有请求都要带 Authorization: Bearer <token>；只监听 127.0.0.1，不对公网暴露。"));
    box.appendChild(head);

    const table = node("table", "tbl api-tbl");
    const thead = node("thead");
    const hr = node("tr");
    for (const h of ["方法", "路径", "说明", ""]) hr.appendChild(node("th", "", h));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = node("tbody");
    for (const [method, p, desc] of REST_ENDPOINTS) {
      const tr = node("tr");
      tr.appendChild(node("td", "m-" + method.toLowerCase(), method));
      tr.appendChild(node("td", "", p));
      tr.appendChild(node("td", "dim", desc));
      const ops = node("td", "");
      const c = node("button", "ghost tiny", "curl");
      c.addEventListener("click", () => copyText(`curl -s "${base}${p.replace(/:\w+/g, "ID")}" -H "Authorization: Bearer ${token}"`));
      ops.appendChild(c);
      tr.appendChild(ops);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return;
  }

  if (V.apiTab === "mcp") {
    const cfg = {
      mcpServers: {
        "infinite-doubao": {
          type: "http",
          url: `${base}/mcp`,
          headers: { Authorization: `Bearer ${(server && server.token) || "TOKEN"}` }
        }
      }
    };
    const head = node("div", "api-head");
    head.appendChild(node("div", "hint", "MCP 走同一个本地端口：POST /mcp 是 JSON-RPC 2.0 单次响应，GET /mcp/sse 是流式通道。把下面这段贴进客户端的 mcp 配置即可。"));
    const area = textInput(JSON.stringify(cfg, null, 2), "", true, 12);
    head.appendChild(area);
    const row = node("div", "row-gap");
    const cp = node("button", "ghost tiny", "复制配置");
    cp.addEventListener("click", () => copyText(area.value));
    row.appendChild(cp);
    const list = node("button", "ghost tiny", "查看工具清单");
    list.addEventListener("click", async () => {
      const r = await guard(() => call("dm:mcp:tools"), null);
      if (!r) return;
      const wrap = node("div", "");
      const t = node("table", "tbl");
      const tb = node("tbody");
      for (const tool of r) {
        const tr = node("tr");
        tr.appendChild(node("td", "", tool.name));
        tr.appendChild(node("td", "dim", tool.description || ""));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      wrap.appendChild(t);
      openModal("MCP 工具清单", wrap, [{ label: "关闭" }]);
    });
    row.appendChild(list);
    head.appendChild(row);
    box.appendChild(head);
    return;
  }

  if (V.apiTab === "sse") {
    const head = node("div", "api-head");
    head.appendChild(node("div", "hint", "事件流按变化即推，不用轮询。curl 一行就能看："));
    const cmdEl = textInput(`curl -N "${base}/api/events?token=${(server && server.token) || "TOKEN"}"`, "", false);
    cmdEl.readOnly = true;
    head.appendChild(cmdEl);
    head.appendChild(node("div", "hint", "事件类型：task / shot / resource / orchestrator / log。界面「任务队列」与「日志」就是吃这条流。"));
    const live = node("div", "sse-live");
    live.id = "ssePreview";
    live.appendChild(node("div", "hint", "最近事件会在这里滚出来："));
    const pre = node("pre", "sse-pre");
    pre.id = "ssePre";
    live.appendChild(pre);
    head.appendChild(live);
    box.appendChild(head);
    return;
  }

  const head = node("div", "api-head");
  head.appendChild(node("div", "hint", "不想开界面也能跑批：CLI 直接读同一个 APP_HOME，不需要 Electron。"));
  const cmds = [
    ["看整体状态", "node src/cli.js state"],
    ["列出实例与额度", "node src/cli.js instances"],
    ["导入并开跑", "node src/cli.js start <storyboardId>"],
    ["看进度", "node src/cli.js status <storyboardId>"],
    ["只看失败任务", "node src/cli.js tasks --status failed"],
    ["下载所有无水印原片", "node src/cli.js resources --kind video --unwatermarked"],
    ["取 token", "node src/cli.js token"]
  ];
  for (const [label, cmd] of cmds) {
    const line = node("div", "api-line");
    line.appendChild(node("span", "api-k", label));
    line.appendChild(node("code", "api-v", cmd));
    const c = node("button", "ghost tiny", "复制");
    c.addEventListener("click", () => copyText(cmd));
    line.appendChild(c);
    head.appendChild(line);
  }
  if (paths) head.appendChild(node("div", "hint", `APP_HOME：${paths.home}`));
  box.appendChild(head);
}

/* ================================================================ 日志 */

let renderedLogLines = [];
let renderedLogFilter = "";

async function refreshLogs() {
  return queueRefresh("logs", async () => {
    V.logLines = await guard(() => call("dm:logs", 300, q("#logFilter").value.trim()), []) || [];
    if (V.view === "logs") renderLogs();
  });
}

function renderLogs() {
  const body = q("#logBody");
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
  const filter = q("#logFilter").value.trim().toLowerCase();
  const filtered = filter
    ? V.logLines.filter((l) => JSON.stringify(l).toLowerCase().includes(filter))
    : V.logLines;
  const list = filtered.slice(-400);
  const offset = renderedLogLines.indexOf(list[0]);
  let retained = Math.min(renderedLogLines.length - offset, list.length);
  if (filter !== renderedLogFilter || offset < 0 || body.children.length !== renderedLogLines.length ||
      !list.slice(0, retained).every((line, i) => line === renderedLogLines[offset + i])) {
    body.replaceChildren();
    retained = 0;
  } else {
    for (let i = 0; i < offset; i++) body.firstElementChild.remove();
    while (body.children.length > retained) body.lastElementChild.remove();
  }
  for (const line of list.slice(retained)) {
    const row = node("div", "log-line lv-" + (line.level || "info"));
    row.appendChild(node("span", "log-t", (line.t || "").slice(11, 19)));
    row.appendChild(node("span", "log-lv", String(line.level || "info").toUpperCase()));
    row.appendChild(node("span", "log-ev", line.event || ""));
    const extra = { ...line };
    delete extra.t; delete extra.level; delete extra.event;
    const text = Object.keys(extra).length ? JSON.stringify(extra) : "";
    if (text) row.appendChild(node("span", "log-msg", text));
    body.appendChild(row);
  }
  renderedLogLines = list;
  renderedLogFilter = filter;
  if (atBottom) body.scrollTop = body.scrollHeight;
}

/* ================================================================ 设置 */

async function refreshSettings() {
  const state = await guard(() => call("dm:state"), null);
  if (state) {
    V.settings = state.settings || {};
    V.models = state.models;
  }
  const box = q("#settingsBody");
  box.replaceChildren();

  const s = V.settings || {};
  const orch = s.orchestrator || {};
  const srv = s.server || {};

  box.appendChild(group("派发与并发", [
    numberRow("并发上限", orch.maxParallel, "同时执行的任务数，不超过可用账号数", (v) => patchSetting(["orchestrator", "maxParallel"], v), { min: 1 }),
    numberRow("轮询间隔 (ms)", orch.pollInterval, "生成进度检查间隔，最少 1500 ms", (v) => patchSetting(["orchestrator", "pollInterval"], v), { min: 1500 }),
    numberRow("失败重试次数", orch.retryLimit, "自动恢复上限为 0–10 次，0 表示不自动重试", (v) => patchSetting(["orchestrator", "retryLimit"], v), { min: 0, max: 10 }),
    toggleRow("自动下载成片", orch.autoDownload !== false, "生成完自动存进视频目录", (v) => patchSetting(["orchestrator", "autoDownload"], v)),
    toggleRow("自动确认生成", orch.autoConfirm !== false, "自动确认本次任务的生成参数，不处理付费或升级请求", (v) => patchSetting(["orchestrator", "autoConfirm"], v)),
    textRow("停止热键", orch.stopHotkey || "F10", "任何窗口按一下，整批立刻停", (v) => patchSetting(["orchestrator", "stopHotkey"], v))
  ]));

  const storageGroup = group("视频保存", [
    kvRow("当前视频目录", (state && state.paths && state.paths.downloads) || ""),
    kvRow("模板附件目录", (state && state.paths && state.paths.attachments) || ""),
    textRow("自定义目录", s.downloadDir || "", "留空使用 下载 / 豆包工坊 / 生成视频", (v) => patchSetting(["downloadDir"], v.trim()))
  ]);
  const openVideos = node("button", "ghost tiny", "打开视频目录");
  openVideos.addEventListener("click", () => guard(() => DM.openHome()));
  storageGroup.appendChild(openVideos);
  box.appendChild(storageGroup);
  box.appendChild(window.DMComponents.panel());

  box.appendChild(group("额度与命名", [
    numberRow("每实例每日条数", (s.quota || {}).perDay || 2, `本地派发上限，按 ${(s.quota || {}).resetTz || "Asia/Tokyo"} 每日重置；平台实际额度以账号为准`, (v) => patchSetting(["quota", "perDay"], v), { min: 1 }),
    selectRow("命名规则", s.naming || "timestamp", [["timestamp", "时间戳"], ["prompt", "提示词前 40 字"], ["custom", "自定义模板"]], (v) => patchSetting(["naming"], v)),
    textRow("命名模板", s.namingTemplate || "{account}_{date}_{index}", "可用占位符：{account} {date} {index} {prompt}", (v) => patchSetting(["namingTemplate"], v))
  ]));

  box.appendChild(group("本地接口", [
    toggleRow("开工即启动", srv.enabled !== false, "立即启停本地服务，同时记住下次启动状态", (v) => patchServer("enabled", v)),
    numberRow("端口", srv.port || 17823, "服务运行时会自动切换到新端口", (v) => patchServer("port", v), { min: 1, max: 65535 }),
    textRow("Bearer token", srv.token || "", "留空沿用本机生成的 token；修改后立即应用", (v) => patchServer("token", v))
  ]));

  const aboutGroup = group("关于", [
    kvRow("版本", (state && state.brand && state.brand.version) || "1.2.0"),
    kvRow("配置与缓存目录", (V.paths && V.paths.home) || ""),
    textRow("更新源", s.updateUrl || "", "留空使用默认更新服务器；更换地址后重新检查更新", (v) => patchSetting(["updateUrl"], v.trim()))
  ]);
  const upd = node("button", "ghost tiny", "检查更新");
  upd.addEventListener("click", () => window.DMUpdates.open());
  aboutGroup.appendChild(upd);
  box.appendChild(aboutGroup);
}

function group(title, rows) {
  const box = node("div", "s-group");
  box.appendChild(node("h4", "", title));
  for (const r of rows) box.appendChild(r);
  return box;
}

function kvRow(label, value) {
  const row = node("div", "s-row");
  row.appendChild(node("label", "", label));
  row.appendChild(node("div", "s-value", value || "—"));
  return row;
}

function numberRow(label, value, hint, onChange, opts) {
  const row = node("div", "s-row");
  row.appendChild(node("label", "", label));
  const right = node("div", "s-right");
  const input = document.createElement("input");
  input.type = "number";
  input.step = "1";
  input.className = "s-input";
  if (opts && opts.min != null) input.min = String(opts.min);
  if (opts && opts.max != null) input.max = String(opts.max);
  input.value = value == null ? "" : String(value);
  input.addEventListener("change", () => {
    // 越界当场压回框里再上报，用户能直接看见被限到哪
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = Number((opts && opts.min) || 0);
    v = Math.round(v);
    if (opts && opts.min != null) v = Math.max(opts.min, v);
    if (opts && opts.max != null) v = Math.min(opts.max, v);
    input.value = String(v);
    onChange(v);
  });
  right.appendChild(input);
  if (hint) right.appendChild(node("span", "s-hint", hint));
  row.appendChild(right);
  return row;
}

function textRow(label, value, hint, onChange) {
  const row = node("div", "s-row");
  row.appendChild(node("label", "", label));
  const right = node("div", "s-right");
  const input = document.createElement("input");
  input.className = "s-input wide";
  input.value = value == null ? "" : String(value);
  input.addEventListener("change", () => onChange(input.value.trim()));
  right.appendChild(input);
  if (hint) right.appendChild(node("span", "s-hint", hint));
  row.appendChild(right);
  return row;
}

function toggleRow(label, value, hint, onChange) {
  const row = node("div", "s-row");
  row.appendChild(node("label", "", label));
  const right = node("div", "s-right");
  const wrap = node("label", "switch");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!value;
  input.addEventListener("change", () => onChange(input.checked));
  wrap.appendChild(input);
  right.appendChild(wrap);
  if (hint) right.appendChild(node("span", "s-hint", hint));
  row.appendChild(right);
  return row;
}

function selectRow(label, value, options, onChange) {
  const row = node("div", "s-row");
  row.appendChild(node("label", "", label));
  const right = node("div", "s-right");
  const sel = document.createElement("select");
  sel.className = "s-input";
  for (const [v, t] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    if (String(value) === String(v)) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  right.appendChild(sel);
  row.appendChild(right);
  return row;
}

async function patchSetting(path, value) {
  const patch = {};
  let cur = patch;
  for (let i = 0; i < path.length; i += 1) {
    if (i === path.length - 1) cur[path[i]] = value;
    else { cur[path[i]] = {}; cur = cur[path[i]]; }
  }
  await guard(async () => {
    V.settings = await DM.saveSettings(patch);
    if (path[0] === "downloadDir") {
      await refreshSettings();
      say("视频目录已保存");
    } else if (path[0] === "orchestrator" && path[1] === "stopHotkey") say("停止热键已生效");
    else if (path[0] === "updateUrl") say("更新源已保存，下次检查更新时使用");
    else say("已保存，后续任务使用新设置");
  });
}

async function patchServer(key, value) {
  await guard(async () => {
    V.settings = await DM.saveSettings({ server: { [key]: value } });
    await refreshBadges();
    await refreshSettings();
    say(key === "enabled" ? (value ? "本地接口已启动" : "本地接口已关闭") : V.server?.running ? "本地接口设置已生效" : "已保存，下次启动本地接口时使用");
  });
}

/* ============================================================ 事件与启动 */

function bindEvents() {
  window.DMUpdates.beforeInstall = async () => { if (V.templateDirty) await saveTemplate(); };
  qa(".vtab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  qa("[data-home-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.homeView)));
  qa("[data-home-action]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.homeAction === "downloads") guard(() => DM.openHome());
    if (b.dataset.homeAction === "account") q("#btnNew").click();
    if (b.dataset.homeAction === "mask") q('.tool[data-panel="mask"]').click();
  }));

  bindTemplateEvents();

  qa("[data-task-status]").forEach((b) => b.addEventListener("click", () => {
    V.taskFilter = b.dataset.taskStatus;
    qa("[data-task-status]").forEach((x) => x.classList.toggle("active", x === b));
    refreshTasks();
  }));
  q("#taskRefresh").addEventListener("click", refreshTasks);
  q("#taskStopAll").addEventListener("click", async () => {
    await guard(() => call("dm:orchestrator:stop-all"), null);
    say("已全部停止");
    refreshTasks();
  });

  q("#videoRefresh").addEventListener("click", refreshAssets);
  q("#videoOpenDirectory").addEventListener("click", () => guard(() => DM.openHome()));
  qa("[data-api-tab]").forEach((b) => b.addEventListener("click", () => { V.apiTab = b.dataset.apiTab; refreshApi(); }));
  q("#apiRotate").addEventListener("click", async () => {
    await guard(() => call("dm:server:rotate"), null);
    say("token 已轮换（旧 token 立即失效）");
    V.server = await guard(() => call("dm:server"), null);
    refreshApi();
    refreshBadges();
  });
  q("#apiRestart").addEventListener("click", async () => {
    await guard(async () => { await call("dm:server:stop"); await call("dm:server:start"); }, null);
    V.server = await guard(() => call("dm:server"), null);
    say("服务已重启");
    refreshApi();
    refreshBadges();
  });

  q("#logFilter").addEventListener("input", () => scheduleRefresh("log-filter", renderLogs, "logs"));
  q("#logClear").addEventListener("click", () => { V.logLines = []; renderLogs(); });
  q("#logLive").addEventListener("change", () => { if (q("#logLive").checked) renderLogs(); });

  q("#dmModalClose").addEventListener("click", closeModal);
  q("#dmModal").addEventListener("click", (e) => { if (e.target.id === "dmModal") closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !q("#dmModal").classList.contains("hidden")) closeModal();
  });

  // 主进程事件 → 界面
  DM.onEvent((e) => {
    if (!e || e.type === "log") return;
    if (e.type === "draft") { V.draftMessage = e.message; say(e.message); if (["templates", "drafts"].includes(V.view)) scheduleRefresh("drafts", refreshDrafts, V.view); }
    scheduleRefresh("badges", refreshBadges);
    if (V.view === "tasks") scheduleRefresh("tasks", refreshTasks, "tasks");
    if (V.view === "assets" && e.type === "task" && e.task?.status === "succeeded") scheduleRefresh("assets", refreshAssets, "assets");
  });
  DM.onLog((line) => {
    if (!line) return;
    V.logLines.push(line);
    if (V.logLines.length > 800) V.logLines = V.logLines.slice(-800);
    if (V.view === "logs" && q("#logLive").checked) scheduleRefresh("logs", () => { if (q("#logLive").checked) renderLogs(); }, "logs");
  });
  DM.onResource((item) => { if (V.view === "assets" && item?.downloaded) scheduleRefresh("assets", refreshAssets, "assets"); });
  DM.onHotkey((payload) => say(`已按 ${payload.key} 全部停止`, true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    scheduleRefresh("badges", refreshBadges);
    if (V.view === "tasks") scheduleRefresh("tasks", refreshTasks, "tasks");
    if (V.view === "assets") scheduleRefresh("assets", refreshAssets, "assets");
    if (V.view === "logs" && q("#logLive").checked) scheduleRefresh("logs", renderLogs, "logs");
  });
}

async function boot() {
  bindEvents();
  V.paths = await guard(() => DM.paths(), null);
  V.instances = await guard(() => call("dm:instances"), []) || [];
  await refreshBadges();
  setView("accounts");
  setInterval(() => { if (!document.hidden) refreshBadges(); }, 8000);

}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();
