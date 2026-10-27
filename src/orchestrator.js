"use strict";

// A persistent task owns dispatch, generation and delivery. Retrying an
// accepted generation resumes it on the same account instead of sending twice.
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const path = require("node:path");
const store = require("./store");
const quota = require("./quota");
const storyboard = require("./storyboard");
const assets = require("./assets");
const interceptor = require("./interceptor");
const driverMod = require("./driver");
const accountProbe = require("./account-probe");
const templates = require("./task-templates");
const drafts = require("./task-drafts");
const log = require("./logger");

const events = new EventEmitter();
const runtime = { running: new Map(), nativeDrafts: new Map(), busy: new Set(), blocked: new Map(), paused: false, stopped: new Set(), timer: null, lastError: "" };
let deps = { resolveDriver: null, resolveDraftDriver: null, findWebContents: null };
function init(d) { deps = { ...deps, ...(d || {}) }; }
function emit(type, payload) {
  try { events.emit("event", { type, at: new Date().toISOString(), ...payload }); } catch {}
  try { events.emit(type, payload); } catch {}
}
function emitLog(task, message, level = "info") {
  const line = { at: new Date().toISOString(), level, message: String(message) };
  if (task) { task.log = [...(task.log || []), line].slice(-200); store.save(); }
  emit("log", { taskId: task?.id || "", ...line });
  log[level === "error" ? "error" : level === "warn" ? "warn" : "info"]("task-log", { taskId: task?.id || "", message: line.message });
}
function newTask(input) {
  return {
    id: `task-${crypto.randomBytes(6).toString("hex")}`,
    storyboardId: String(input.storyboardId || ""), shotId: String(input.shotId || ""), shotIndex: Number(input.shotIndex) || 0,
    instanceId: String(input.instanceId || ""), instanceName: "", kind: String(input.kind || "video"),
    templateId: String(input.templateId || ""), templateName: String(input.templateName || ""),
    executionMode: input.executionMode === "work" ? "work" : "video",
    model: String(input.model || ""), duration: Number(input.duration) || 0, ratio: String(input.ratio || "adaptive"),
    prompt: withSeedanceSkill(input.prompt), refs: Array.isArray(input.refs) ? input.refs : [],
    status: "queued", stage: "waiting_account", progress: 0, waitReason: "等待分配账号",
    attempts: 0, retryCount: 0, dedupeKey: String(input.dedupeKey || ""),
    createdAt: new Date().toISOString(), startedAt: "", submittedAt: "", generatedAt: "", finishedAt: "",
    error: "", result: null, log: []
  };
}
function withSeedanceSkill(prompt) {
  const skill = "[Seedance 2.5](skill://seedance-25?type=2&id=353376777986)";
  const body = String(prompt || "").split(/\r?\n/).filter(line => line.trim() !== skill).join("\n").trim();
  return `${skill}\n${body}`;
}
function addTask(task) {
  store.get().tasks.push(task);
  if (!store.save()) { store.get().tasks.pop(); throw new Error("任务保存失败，请检查配置目录是否可写"); }
  emit("task", { task }); return task;
}
function getTask(id) { return store.get().tasks.find((t) => t.id === String(id)) || null; }
function taskList(filter = {}) {
  let out = store.get().tasks.slice().reverse();
  for (const key of ["storyboardId", "instanceId", "status"]) if (filter[key]) out = out.filter((t) => t[key] === filter[key]);
  return out.slice(0, Number(filter.limit) || 200);
}
function patchTask(id, patch, durable = false) {
  const task = getTask(id);
  if (!task) return null;
  if (!durable && Object.entries(patch || {}).every(([key, value]) => Object.is(task[key], value))) return task;
  const previous = Object.fromEntries(Object.keys(patch || {}).map((key) => [key, task[key]]));
  Object.assign(task, patch || {});
  if (!store.save() && durable) { Object.assign(task, previous); throw new Error("任务状态保存失败，已阻止重复提交风险，请检查配置目录"); }
  emit("task", { task }); return task;
}
function instanceReady(inst, resumeGeneration = false) {
  if (runtime.busy.has(inst.id)) return { ok: false, reason: "账号正在执行其他任务" };
  const block = runtime.blocked.get(inst.id);
  if (block?.retryAt > Date.now()) return { ok: false, reason: block.reason };
  if (block) runtime.blocked.delete(inst.id);
  if (!resumeGeneration) {
    const q = quota.canUse(inst.id);
    if (!q.ok) return { ok: false, reason: q.message || q.reason };
  }
  return { ok: true };
}
function pickInstance(exclude = new Set(), preferred = []) {
  const list = store.get().instances;
  const ordered = [...preferred.map((id) => list.find((i) => i.id === id)).filter(Boolean), ...list.filter((i) => !preferred.includes(i.id))];
  return ordered.find((inst) => !exclude.has(inst.id) && instanceReady(inst).ok) || null;
}
function bindDraftBatch(task, inst) {
  if (!task.draftBatchId || task.preferredInstanceId) return;
  const batch = store.get().tasks.filter((t) => t.draftBatchId === task.draftBatchId);
  const previous = batch.map((t) => t.preferredInstanceId);
  batch.forEach((t) => { t.preferredInstanceId = inst.id; });
  // Bind the whole batch durably before any page action; recovery and retries
  // use the existing fixed-account dispatch path.
  if (!store.save()) {
    batch.forEach((t, i) => { if (previous[i] === undefined) delete t.preferredInstanceId; else t.preferredInstanceId = previous[i]; });
    throw new Error("草稿批次账号保存失败，任务尚未发送，请检查磁盘空间或目录权限");
  }
  batch.forEach((t) => emit("task", { task: t }));
}
function buildShotPayload(sb, shot, opts = {}) {
  const prev = (sb.shots || []).find((s) => s.index === shot.index - 1);
  return assets.resolveShotPrompt(shot, { style: opts.style || "", chain: opts.chain !== false, prevPrompt: prev?.videoPrompt || "" });
}
function checkStopped(sb) {
  if (runtime.stopped.has(sb.id)) throw Object.assign(new Error("手动停止；已提交的生成不会重复发送"), { code: "stopped" });
}
function sessionFor(inst) { return deps.sessionFor ? deps.sessionFor(inst) : require("electron").session.fromPartition(inst.partition); }
function mediaKey(url) {
  if (interceptor.mediaKey) return interceptor.mediaKey(url);
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return String(url || ""); }
}
async function beginTracking(driver, task, inst, resume) {
  const tracking = await driver.beginTask({ taskId: task.id, prompt: task.prompt, baselineUrls: task.baselineUrls, baselineMessageIds: task.baselineMessageIds, confirmedKeys: Object.keys(task.confirmationIntents || {}), resume });
  if (!tracking?.ok) throw new Error("无法建立本次任务的结果跟踪，请刷新账号页面");
  if (!resume) {
    const baselineUrls = tracking.baselineUrls || [];
    const baselineMediaKeys = [...new Set([...baselineUrls.map(mediaKey), ...interceptor.list({ instanceId: inst.id, kind: "video", limit: 800 }).map((m) => mediaKey(m.url))])];
    patchTask(task.id, { baselineUrls, baselineMediaKeys, baselineMessageIds: tracking.baselineMessageIds || [], confirmationIntents: {} }, true);
  }
}
async function confirmGeneration(driver, task, options, sb, context = {}) {
  if (!driver.call) return null;
  const expected = { model: task.model, duration: task.duration, ratio: task.ratio };
  const check = context.check || (() => checkStopped(sb));
  const persist = context.persist || (values => patchTask(task.id, values, true));
  const candidate = await driver.call("peekGenerationConfirmation", expected);
  check();
  if (!candidate?.kind) return null;
  if (candidate.pending) return { waiting: true, reason: candidate.reason };
  if (!candidate.ok) return { waiting: true, blocked: true, reason: candidate.reason || "请手动检查生成参数" };
  if (options.autoConfirm === false) return { waiting: true, blocked: true, reason: "等待确认生成参数（自动确认已关闭）" };
  const intents = task.confirmationIntents || {};
  if (task.studioTaskId && Object.keys(intents).length) return { waiting: true, recorded: true, reason: "本草稿已有生成确认意图，只核对原结果，不再次确认" };
  if (intents[candidate.key] || Object.values(intents).some((intent) => intent.kind === "text")) {
    return { waiting: true, recorded: true, reason: "确认已发送或正在等待平台响应，不会重复确认" };
  }
  if (task.studioTaskId && !context.checkLease) return { waiting: true, blocked: true, reason: "只读取回原对话；新的生成确认需要有效发送租约" };
  const checkAction = () => { check(); if (task.studioTaskId) context.checkLease?.(); };
  checkAction();
  const intent = { kind: "text", state: "pending", at: new Date().toISOString() };
  persist({ confirmationIntents: { ...intents, [candidate.key]: intent } });
  let actionAttempted = false;
  try {
    checkAction();
    const filled = await driver.setText("按要求生成", checkAction);
    if (!filled?.ok) throw new Error("填写视频参数确认失败");
    const latest = await driver.call("peekGenerationConfirmation", expected);
    if (!latest?.ok || latest.key !== candidate.key) {
      // Streaming replies can change between inspection and filling. No
      // click was issued: discard this intent and inspect again next poll.
      const remaining = { ...task.confirmationIntents }; delete remaining[candidate.key];
      persist({ confirmationIntents: remaining });
      return { waiting: true, reason: "生成确认内容仍在更新，等待完整参数" };
    }
    checkAction();
    actionAttempted = true;
    const sent = await driver.send({ nativeOnly: true }, checkAction);
    if (!sent?.ok) { actionAttempted = false; throw new Error(`发送视频参数确认失败：${sent?.reason || "未找到发送按钮"}`); }
    check();
    persist({ confirmationIntents: { ...task.confirmationIntents, [candidate.key]: { ...intent, state: "sent" } } });
    emitLog(task, "已回复“按要求生成”");
    return { waiting: true, sent: true, reason: "确认已发送，等待平台开始生成" };
  } catch (error) {
    if (!actionAttempted) {
      const remaining = { ...task.confirmationIntents }; delete remaining[candidate.key];
      persist({ confirmationIntents: remaining });
    }
    throw error;
  }
}
async function rememberConversation(driver, task) {
  if (!driver.url || task.conversationLocked) return;
  const url = await driver.url();
  if (/^https?:\/\//i.test(url) && !/oauth|passport|login|callback/i.test(url)) {
    patchTask(task.id, { conversationUrl: url, conversationLocked: /\/chat\/[^/?#]+/.test(url) });
  }
}
function currentMedia(task, inst, progress) {
  const excluded = new Set(task.baselineMediaKeys || []);
  // seenAt can change when an old video is replayed. Only current-page output
  // URLs or a previously persisted task association identify this result.
  for (const url of progress?.mediaUrls || []) {
    if (!/^https?:\/\//i.test(url) || excluded.has(mediaKey(url))) continue;
    const item = interceptor.push({ url, rawUrl: url, kind: "video", instanceId: inst.id, instanceName: inst.name, from: "task-dom" });
    if (item) interceptor.annotate(item, { taskId: task.id, templateName: task.templateName });
  }
  const ids = new Set(task.result?.resourceIds || []);
  return interceptor.list({ instanceId: inst.id, kind: "video", limit: 800 }).filter((item) => (item.taskId === task.id || ids.has(item.id)) && !excluded.has(mediaKey(item.url)));
}
async function deliver(task, inst, shot, sb, media, options) {
  if (!media.length) throw Object.assign(new Error("生成页面没有返回本次任务的视频地址，请继续取回结果"), { code: "result_missing" });
  const result = { ...(task.result || {}), urls: media.map((m) => m.url), resourceIds: media.map((m) => m.id), files: task.result?.files || [], downloads: task.result?.downloads || [], percent: 100, unwatermarked: false };
  patchTask(task.id, { generatedAt: task.generatedAt || new Date().toISOString(), stage: "downloading", result });
  if (!task.quotaConsumed) {
    quota.consume(inst.id, "video", { taskId: task.id, shotId: shot.id });
    patchTask(task.id, { quotaConsumed: true });
  }
  if (options.autoDownload === false) {
    result.downloadSkipped = true;
    result.warning = "自动下载已关闭，视频地址已保存；尚未交付无水印文件";
  } else {
    result.downloadSkipped = false;
    const ses = sessionFor(inst);
    for (const item of media) {
      checkStopped(sb);
      interceptor.annotate(item, { taskId: task.id, templateName: task.templateName });
      const downloaded = await interceptor.download(ses, item, { requireUnwatermarked: true, taskId: task.id, templateName: task.templateName, prompt: task.prompt, index: shot.index });
      if (!downloaded?.ok || !downloaded.file || downloaded.unwatermarked !== true) throw new Error("未取得已确认的无水印文件，任务保留以便继续下载");
      if (!result.files.includes(downloaded.file)) result.files.push(downloaded.file);
      result.downloads = result.downloads.filter((d) => d.resourceId !== item.id);
      result.downloads.push({ resourceId: item.id, file: downloaded.file, url: downloaded.url, unwatermarked: true });
      patchTask(task.id, { result: { ...result } });
    }
    if (!result.files.length) throw new Error("没有可交付的视频文件");
    result.unwatermarked = result.downloads.length === media.length && result.downloads.every((d) => d.unwatermarked === true);
    result.warning = "";
  }
  checkStopped(sb);
  patchTask(task.id, { status: "succeeded", stage: "completed", progress: 100, error: "", waitReason: "", finishedAt: new Date().toISOString(), result }, true);
  storyboard.setStatus(sb.id, shot.id, "succeeded", { taskId: task.id, result, finishedAt: task.finishedAt, error: "" });
  const record = store.find(inst.id);
  if (record) { record.stat = record.stat || {}; record.stat.success = (record.stat.success || 0) + 1; store.save(); }
  emitLog(task, options.autoDownload === false ? "生成完成，已保存视频地址（自动下载关闭）" : `无水印视频已保存到素材库：${result.files.length} 个文件`);
  return { ok: true, ...result };
}
async function runTask(task, inst, shot, sb) {
  const options = { ...((store.get().settings || {}).orchestrator || {}) };
  const retryLimit = Math.max(0, Math.min(10, Number(options.retryLimit) || 0));
  runtime.running.set(task.id, { task, inst, shot, sb }); runtime.busy.add(inst.id);
  patchTask(task.id, { status: "running", stage: "preparing", waitReason: "", error: "", finishedAt: "", instanceId: inst.id, instanceName: inst.name, startedAt: task.startedAt || new Date().toISOString(), attempts: (task.attempts || 0) + 1 });
  storyboard.setStatus(sb.id, shot.id, "running", { taskId: task.id, instanceId: inst.id, error: "" });
  let driver;
  let previousOptions;
  try {
    checkStopped(sb);
    const savedMedia = currentMedia(task, inst, null);
    if (task.generatedAt && savedMedia.length) return await deliver(task, inst, shot, sb, savedMedia, options);
    emitLog(task, task.submittedAt ? `继续取回 ${inst.name} 的生成结果` : `准备账号 ${inst.name}`);
    driver = deps.resolveDriver ? await deps.resolveDriver(inst) : await driverMod.open(inst, { webContents: deps.findWebContents?.(inst) });
    if (!driver) throw new Error("账号页面尚未就绪");
    checkStopped(sb);
    if (task.submittedAt && task.conversationUrl && driver.url && driver.navigate) {
      if (await driver.url() !== task.conversationUrl) {
        await driver.navigate(task.conversationUrl);
        if (driver.ready && !await driver.ready()) throw new Error("原生成会话尚未加载完成，请继续取回");
        checkStopped(sb);
      }
    }
    let login = null;
    if (driver.isLoggedIn) login = await driver.isLoggedIn().catch(() => null);
    let probe = null;
    try { probe = await accountProbe.probe(inst, { session: sessionFor(inst), api: false }); } catch {}
    if ((login?.loggedIn === false && login.by !== "unknown") || (probe?.state === "expired" && login?.loggedIn !== true)) {
      throw Object.assign(new Error(`账号 ${inst.name} 需要登录，登录后将自动继续`), { code: "login_required" });
    }
    if (!task.submittedAt && driver.call) {
      const prepared = await driver.call(task.executionMode === "work" ? "prepareWorkTask" : "prepareVideoGeneration", { model: task.model, duration: task.duration, ratio: task.ratio });
      if (!prepared?.ok) {
        if (prepared?.diagnostics) log.warn("video-prepare-failed", { taskId: task.id, instanceId: inst.id, diagnostics: prepared.diagnostics });
        throw Object.assign(new Error(`任务页面未就绪：${prepared?.reason || "无法选择任务模式或参数"}`), {
          code: (prepared?.code ? prepared.code === "model_unavailable" : /未开通|没有.*可选择|不可用|不支持|无权限|升级|会员|付费|当前账号不能使用/.test(prepared?.reason || "")) ? "model_unavailable" : "prepare_failed"
        });
      }
      checkStopped(sb);
    }
    if (!task.submittedAt) {
      patchTask(task.id, { stage: "submitting", progress: 0 });
      if (task.model) previousOptions = await driver.setGenerationOptions({ model: task.model, duration: task.duration });
      if (task.refs?.length) {
        const uploaded = await driver.pasteFiles(task.refs);
        if (!uploaded?.ok) throw new Error(`附件上传失败：${uploaded?.reason || "页面未接受附件"}`);
      }
      const filled = await driver.setText(task.prompt);
      if (!filled?.ok) throw new Error(`填写提示词失败：${filled?.reason || "输入框不可用"}`);
      checkStopped(sb);
      // Snapshot after upload and filling: reference videos are baseline input,
      // never new generated output. The page also excludes input/user videos.
      await beginTracking(driver, task, inst, false);
      // Persist intent before clicking so recovery cannot send a second job if
      // the click succeeds but its IPC response is lost.
      patchTask(task.id, { submittedAt: new Date().toISOString(), submissionUncertain: true }, true);
      const sent = await driver.send();
      if (!sent?.ok) {
        patchTask(task.id, { submittedAt: "", submissionUncertain: false });
        throw new Error(`发送失败：${sent?.reason || "未找到发送按钮"}`);
      }
      patchTask(task.id, { submissionUncertain: false });
      await rememberConversation(driver, task);
      emitLog(task, "已提交生成");
    } else await beginTracking(driver, task, inst, true);
    patchTask(task.id, { stage: "generating" });
    const deadline = Date.now() + (Number(options.taskTimeoutMs) || 12 * 60 * 1000);
    const pollMs = Math.max(1500, Number(options.pollInterval) || 4000);
    let progress = null;
    let lastState = "";
    while (Date.now() < deadline) {
      checkStopped(sb);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      checkStopped(sb);
      if (task.conversationLocked && driver.url && await driver.url() !== task.conversationUrl) {
        throw new Error("账号已切换到其他会话，请继续取回原生成结果");
      }
      await rememberConversation(driver, task);
      const confirmation = await confirmGeneration(driver, task, options, sb);
      progress = await driver.readProgress().catch(() => null);
      if (!progress) continue;
      if (task.studioTaskId && !task.generationObservedAt && (progress.generationStarted || progress.mediaUrls?.length || progress.state === "done")) patchTask(task.id, { generationObservedAt: new Date().toISOString() }, true);
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      if (task.progress !== percent) patchTask(task.id, { progress: percent });
      if (lastState !== progress.state) { lastState = progress.state; emitLog(task, `页面状态：${progress.state}`); }
      if (progress.state === "waiting_confirmation" || (confirmation?.waiting && !["failed", "done", "running"].includes(progress.state))) {
        patchTask(task.id, { stage: "waiting_confirmation", waitReason: confirmation?.reason || "等待确认生成参数" });
      } else if (progress.state === "unknown") {
        if (task.stage !== "waiting_result") patchTask(task.id, { stage: "waiting_result", waitReason: "已提交，等待豆包返回本次视频结果" });
      } else if (progress.state === "running" && task.stage !== "generating") patchTask(task.id, { stage: "generating", waitReason: "" });
      if (progress.state === "failed") {
        const quotaFailure = progress.errorCode === "quota" || /额度|免费数量|今日次数|已达上限|quota/i.test(progress.snippet || "");
        // A received native draft is already a platform task. A failed result
        // must never turn it back into a fresh prompt submission.
        if (!task.studioTaskId && !task.draftBatchId) patchTask(task.id, { submittedAt: "", generatedAt: "", submissionUncertain: false });
        throw Object.assign(new Error(quotaFailure ? (task.draftBatchId ? "已接收草稿的对话提示额度不足，请核对原对话；不会重新发送" : "账号额度用尽，等待其他可用账号") : progress.snippet || "平台明确返回生成失败"), { code: quotaFailure ? "quota" : progress.errorCode || "generation_failed" });
      }
      if (progress.state === "done") {
        patchTask(task.id, { generatedAt: task.generatedAt || new Date().toISOString() });
        return await deliver(task, inst, shot, sb, currentMedia(task, inst, progress), options);
      }
    }
    throw Object.assign(new Error("等待生成超时；重试只继续查询本次结果，不会重复提交"), { code: "timeout" });
  } catch (error) {
    let message = String(error?.message || error);
    const code = error?.code;
    runtime.lastError = message;
    if (task.studioTaskId || (task.draftBatchId && code !== "stopped")) {
      // Draft failures require manual recovery, regardless of legacy retry
      // settings. Preserve the original submission and conversation.
      const failed = { status: "failed", stage: "failed", error: message, errorCode: code || "unknown", finishedAt: new Date().toISOString() };
      try { patchTask(task.id, failed, true); }
      catch {
        message += "；失败状态未保存，请检查本地存储后人工核对";
        Object.assign(task, failed, { error: message });
        runtime.lastError = message;
      }
      storyboard.setStatus(sb.id, shot.id, "failed", { error: message });
    } else if (code === "login_required" || code === "quota" || code === "model_unavailable") {
      if (code === "login_required") runtime.blocked.set(inst.id, { reason: message, retryAt: Date.now() + 30000 });
      else if (code === "quota") { quota.setUsed(inst.id, "video", quota.get(inst.id).perDay); quota.cool(inst.id, 0, message); }
      else task.accountExclusions = { ...(task.accountExclusions || {}), [inst.id]: message };
      patchTask(task.id, { status: "queued", stage: "waiting_account", waitReason: message, error: "", nextAttemptAt: 0 });
      storyboard.setStatus(sb.id, shot.id, "queued", { error: message });
    } else if (code === "stopped") {
      patchTask(task.id, { status: "cancelled", stage: "cancelled", error: message, finishedAt: new Date().toISOString() });
      storyboard.setStatus(sb.id, shot.id, "cancelled", { error: message });
    } else if ((task.retryCount || 0) < retryLimit) {
      const retryCount = (task.retryCount || 0) + 1;
      patchTask(task.id, { status: "queued", stage: "retrying", retryCount, waitReason: `第 ${retryCount}/${retryLimit} 次重试：${message}`, error: message, nextAttemptAt: Date.now() + 1500 });
      storyboard.setStatus(sb.id, shot.id, "queued", { error: message });
    } else {
      patchTask(task.id, { status: "failed", stage: "failed", error: message, finishedAt: new Date().toISOString() });
      storyboard.setStatus(sb.id, shot.id, "failed", { error: message });
      const record = store.find(inst.id);
      if (record) { record.stat = record.stat || {}; record.stat.failed = (record.stat.failed || 0) + 1; store.save(); }
    }
    emitLog(task, message, task.status === "failed" ? "error" : "warn");
    return { ok: false, error: message };
  } finally {
    if (driver && previousOptions) await driver.setGenerationOptions(previousOptions).catch(() => {});
    runtime.running.delete(task.id); runtime.busy.delete(inst.id); emit("change", {});
    if (!task.templateId) pump(sb.id);
    wakeQueue();
  }
}
function activeCount() { return runtime.running.size; }
function maxParallel() { return Math.max(1, Math.min(Number(store.get().settings.orchestrator?.maxParallel) || 3, store.get().instances.length || 1)); }
async function dispatchOne(sbId, opts = {}) {
  const sb = storyboard.raw(sbId);
  if (!sb) return { ok: false, error: "分镜不存在" };
  const shot = sb.shots.find((s) => ["pending", "queued"].includes(s.status) && !(opts.skipIds || []).includes(s.id));
  if (!shot) return { ok: false, error: "没有可派发的镜头", done: true };
  let task = getTask(shot.taskId);
  if (!task || task.status !== "queued") {
    const payload = buildShotPayload(sb, shot, opts);
    if (!payload.videoPrompt) return { ok: false, error: "镜头提示词为空" };
    const enhancer = store.get().settings.enhancer || {};
    task = addTask(newTask({ storyboardId: sb.id, shotId: shot.id, shotIndex: shot.index, prompt: payload.videoPrompt, refs: payload.refs, model: shot.model || enhancer.model, duration: shot.duration || enhancer.duration, dedupeKey: storyboard.dedupeKey(sb.id, shot) }));
    storyboard.updateShot(sb.id, shot.id, { taskId: task.id, status: "queued" });
  }
  if (runtime.running.has(task.id) || Number(task.nextAttemptAt) > Date.now()) return { ok: false, error: "等待重试" };
  // Older versions cleared submittedAt after a quota error even for accepted
  // drafts. Their durable sentAt still forbids sending the prompt again.
  if (task.draftBatchId && task.sentAt && !task.submittedAt) patchTask(task.id, { submittedAt: task.sentAt }, true);
  const fixedId = task.submittedAt ? task.instanceId : task.preferredInstanceId;
  const fixed = fixedId ? store.find(fixedId) : null;
  const exclude = new Set([...(opts.triedInstances || []), ...Object.keys(task.accountExclusions || {})]);
  const inst = fixedId ? (fixed && !exclude.has(fixedId) && instanceReady(fixed, !!task.submittedAt).ok ? fixed : null) : pickInstance(exclude, opts.preferredInstances || []);
  if (!inst) {
    const reasons = store.get().instances.map((i) => `${i.name}：${task.accountExclusions?.[i.id] || instanceReady(i, !!task.submittedAt).reason || "等待派发"}`);
    const waitReason = task.draftBatchId && fixedId
      ? (fixed ? `等待批次账号 ${fixed.name}：${task.accountExclusions?.[fixedId] || instanceReady(fixed, !!task.submittedAt).reason || "等待派发"}` : "批次账号已删除，无法继续发送该批任务")
      : fixedId && !fixed ? "原生成账号已删除，无法取回结果" : reasons.join("；") || "尚无账号，请添加并登录账号后自动继续";
    if (task.stage !== "waiting_account" || task.waitReason !== waitReason) patchTask(task.id, { stage: "waiting_account", waitReason });
    scheduleWake(); return { ok: false, error: waitReason, taskId: task.id };
  }
  bindDraftBatch(task, inst);
  storyboard.updateShot(sb.id, shot.id, { status: "queued", attempts: (shot.attempts || 0) + 1, taskId: task.id });
  void runTask(task, inst, shot, sb);
  return { ok: true, taskId: task.id, shotId: shot.id, instanceId: inst.id };
}
function pump(sbId, opts = {}) {
  const sb = storyboard.raw(String(sbId || ""));
  if (!sb || runtime.paused || runtime.stopped.has(sb.id)) return;
  while (activeCount() < maxParallel()) {
    const before = activeCount();
    dispatchOne(sb.id, opts).catch((error) => { runtime.lastError = String(error.message || error); log.error("dispatch-failed", { message: runtime.lastError }); });
    if (before === activeCount()) break;
  }
}
function scheduleWake() {
  if (runtime.timer || runtime.paused || !store.get().tasks.some((t) => t.status === "queued" && !runtime.stopped.has(t.storyboardId))) return;
  runtime.timer = setTimeout(() => { runtime.timer = null; wakeQueue(); }, 2000); runtime.timer.unref?.();
}
function wakeQueue(instanceId) {
  if (instanceId) {
    runtime.blocked.delete(String(instanceId));
    for (const task of store.get().tasks) if (task.status === "queued" && task.accountExclusions?.[instanceId]) delete task.accountExclusions[instanceId];
  }
  if (runtime.paused) return;
  for (const task of store.get().tasks) {
    if (activeCount() >= maxParallel()) break;
    if (task.status === "queued" && !runtime.stopped.has(task.storyboardId)) pump(task.storyboardId);
  }
  scheduleWake();
}
function start(sbId, opts = {}) {
  const sb = storyboard.raw(sbId);
  if (!sb) return { ok: false, error: "分镜不存在" };
  runtime.stopped.delete(sb.id); runtime.paused = false;
  for (const shot of sb.shots) {
    const task = getTask(shot.taskId);
    if (["queued", "running"].includes(shot.status) && !runtime.running.has(shot.taskId)) {
      shot.status = "queued";
      if (task) patchTask(task.id, { status: "queued" });
    }
  }
  store.save(); pump(sb.id, opts); scheduleWake(); emit("started", { storyboardId: sb.id });
  return { ok: true, storyboardId: sb.id, parallel: maxParallel() };
}
function pause(sbId) { runtime.paused = true; emit("paused", { storyboardId: sbId }); return { ok: true }; }
function resume(sbId, opts = {}) { runtime.paused = false; runtime.stopped.delete(String(sbId)); pump(sbId, opts); wakeQueue(); emit("resumed", { storyboardId: sbId }); return { ok: true }; }
function stop(sbId) { runtime.stopped.add(String(sbId)); emit("stopped", { storyboardId: sbId }); return { ok: true }; }
function stopTask(id) {
  const task = getTask(id);
  if (!task) throw new Error("任务不存在");
  stop(task.storyboardId);
  if (task.status === "queued") { patchTask(id, { status: "cancelled", stage: "cancelled", error: "手动停止", finishedAt: new Date().toISOString() }); storyboard.setStatus(task.storyboardId, task.shotId, "cancelled"); }
  return { stopped: id };
}
function stopAll() {
  runtime.paused = true;
  for (const operation of runtime.nativeDrafts.values()) { operation.stopped = true; operation.controller.abort(new Error("已停止批量操作；已发送的任务不会重发")); }
  if (runtime.timer) { clearTimeout(runtime.timer); runtime.timer = null; }
  for (const task of store.get().tasks) if (["queued", "running"].includes(task.status)) stopTask(task.id);
  emit("stopped", {}); return { ok: true, running: runtime.running.size };
}
async function retryTask(taskId, opts = {}) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: "任务不存在" };
  if (runtime.running.has(task.id)) return { ok: false, error: "任务还在运行" };
  const sb = storyboard.raw(task.storyboardId);
  const shot = sb?.shots.find((s) => s.id === task.shotId);
  if (!shot) return { ok: false, error: "分镜或镜头不存在" };
  runtime.stopped.delete(sb.id); runtime.paused = false; runtime.blocked.delete(task.instanceId);
  storyboard.updateShot(sb.id, shot.id, { status: "queued", error: "" });
  patchTask(task.id, { status: "queued", stage: "waiting_account", error: "", finishedAt: "", retryCount: 0, nextAttemptAt: 0, accountExclusions: {} });
  pump(sb.id, opts); scheduleWake(); return { ok: true, taskId };
}
async function redispatch(taskId, instanceId) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: "任务不存在" };
  if (!store.find(instanceId)) return { ok: false, error: "账号不存在" };
  if (task.submittedAt && task.instanceId !== instanceId) return { ok: false, error: "此任务已提交，只能在原账号继续取回结果" };
  if (runtime.running.has(task.id)) return { ok: false, error: "任务还在运行" };
  if (task.draftBatchId && task.preferredInstanceId && task.preferredInstanceId !== instanceId) return { ok: false, error: "草稿批次已绑定同一个账号，不能单独改派其中的任务" };
  bindDraftBatch(task, store.find(instanceId));
  patchTask(task.id, { preferredInstanceId: instanceId });
  return retryTask(taskId, { preferredInstances: [instanceId] });
}
function templateRecords(template, executionMode = "video", { sendOnly = false } = {}) {
  const label = store.MODEL_OPTIONS.find((m) => m.value === template.model)?.label || template.model;
  const ratio = template.ratio || "adaptive";
  const prompt = sendOnly ? template.prompt.trim() : `${template.prompt.trim()}\n\n生成要求：生成 ${template.duration} 秒视频，使用 ${label} 模型。${ratio === "adaptive" ? "" : `画面比例 ${ratio}。`}`;
  const sb = storyboard.normalizeStoryboard({ name: template.name, source: "task-template", shots: [{ title: template.name, videoPrompt: prompt, model: template.model, duration: template.duration, refs: template.attachments.map((a) => a.path) }] });
  const shot = sb.shots[0];
  const task = newTask({ storyboardId: sb.id, shotId: shot.id, shotIndex: 1, templateId: template.id, templateName: template.name, executionMode, model: template.model, duration: template.duration, ratio, prompt, refs: shot.refs.slice() });
  if (template.studioTaskId) task.studioTaskId = template.studioTaskId;
  Object.assign(shot, { taskId: task.id, status: "queued" });
  return { sb, task };
}
function commitTemplates(records, draftIds = [], startQueue = true) {
  const data = store.get();
  const previous = { storyboards: data.storyboards, tasks: data.tasks, taskDrafts: data.taskDrafts };
  const previousStoryboardId = data.settings.lastStoryboardId;
  data.storyboards = [...data.storyboards, ...records.map((r) => r.sb)];
  data.tasks = [...data.tasks, ...records.map((r) => r.task)];
  data.taskDrafts = data.taskDrafts.filter((d) => !draftIds.includes(d.id));
  data.settings.lastStoryboardId = records[records.length - 1].sb.id;
  // Queue insertion and draft removal share one durable write. No partial batch
  // can escape to the page, and repeating the same request cannot send twice.
  if (!store.save()) { Object.assign(data, previous); data.settings.lastStoryboardId = previousStoryboardId; throw new Error("任务保存失败，草稿已保留，请检查磁盘空间或目录权限"); }
  records.forEach(({ task }) => emit("task", { task }));
  if (startQueue) { runtime.paused = false; wakeQueue(); }
  return records.map(({ task }) => ({ taskId: task.id, status: task.status }));
}
function submitTemplate(template) {
  return commitTemplates([templateRecords(templates.validateSnapshot(template))])[0];
}
function removeDrafts(ids) {
  if (runtime.nativeDrafts.size) throw new Error("草稿正在保存或发送，请完成后再删除");
  return drafts.removeMany(ids);
}
function selectedDrafts(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error("请先勾选要提交的草稿");
  return [...new Set(ids)].map((id) => {
    const draft = drafts.list().find((d) => d.id === id);
    if (!draft) throw new Error("部分草稿不存在或已提交，请刷新草稿箱");
    return draft;
  });
}
function requirePage(result) {
  if (!result?.ok) throw new Error(result?.reason || "豆包页面未完成操作，请检查账号页面");
  return result;
}
function nativeBindings(instanceId) {
  return drafts.list().filter((d) => d.instanceId === instanceId && d.nativeState === "saved" && d.nativeBinding).map((d) => ({ ...d.nativeBinding, draftNumber: d.draftNumber, prompt: d.nativePrompt, executionMode: d.executionMode }));
}
function bindingPatches(bindings) {
  return Object.fromEntries((bindings || []).map((binding) => [binding.id, { nativeBinding: binding }]));
}
function remainingDraftBindings(bindings, acceptedIds) {
  const removed = bindings.filter((b) => acceptedIds.has(b.id));
  return bindings.filter((b) => !acceptedIds.has(b.id)).map((b) => {
    const indexes = new Set(removed.filter((r) => JSON.stringify(r.titles) === JSON.stringify(b.titles)).map((r) => r.index));
    return { ...b, index: b.index - [...indexes].filter((i) => i < b.index).length, titles: b.titles.filter((_title, i) => !indexes.has(i)) };
  });
}
async function draftStep(operation, label, run, timeoutMs = 60000) {
  const { signal } = operation.controller;
  signal.throwIfAborted();
  let timer, abort;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }), new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => operation.controller.abort(new Error(`${label}超时，请检查账号页面或网络后重试`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
function watchDraftLease(operation, checkLease) {
  if (!checkLease) return () => {};
  checkLease();
  const timer = setInterval(() => { try { checkLease(); } catch (error) { operation.controller.abort(error); } }, 100);
  timer.unref?.();
  return () => clearInterval(timer);
}
async function confirmSubmittedTaskOnce(taskId, { checkLease, onDeliveryPage } = {}) {
  const task = getTask(taskId);
  if (!task?.studioTaskId || !checkLease) throw new Error("生成确认需要当前工厂任务租约");
  if (task.studioSendOnly || !task.receiptUserMessageId || !task.conversationUrl || task.submissionUncertain) return;
  const inst = store.find(task.instanceId);
  if (!inst || !deps.resolveDraftDriver) throw new Error("原账号确认页面未就绪");
  const operation = { controller: new AbortController() };
  let driver, activity, pinned = false, stopWatch = () => {};
  const check = () => { operation.controller.signal.throwIfAborted(); checkLease(); if(pinned&&driver?.webContents?.getURL&&driver.webContents.getURL()!==task.conversationUrl)throw Error("原生成会话已变化，只保留本次记录，不确认其他会话"); };
  const waitHuman = async () => {
    if(!activity)return;
    for(;;){
      check();const frame=await activity.snapshot();check();
      if(frame.captchaStateKnown&&!frame.captchaDetected&&!activity.inputHeld&&!activity.inputInFlight){
        if(await activity.observe({taskId:activity.taskId,pageId:activity.pageId},{automatic:true}))return;
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  };
  const observeProgress = progress => {
    if(!progress)return;
    const quotaRejected=progress.errorCode==="quota"||/额度(?:不足|(?:已)?用(?:完|尽))|免费数量(?:已)?用完|今日次数(?:已)?用完|已达上限|quota.{0,12}(?:exceeded|exhausted|insufficient)/i.test(progress.snippet||"");
    if(progress.state==="failed"||quotaRejected){patchTask(task.id,{status:"failed",errorCode:quotaRejected?"quota":"generation_failed",error:"平台明确返回生成失败"},true);storyboard.setStatus(task.storyboardId,task.shotId,"failed",{error:task.error});return "failed";}
    if(progress.generationStarted||progress.mediaUrls?.length||progress.state==="done"){patchTask(task.id,{generationObservedAt:task.generationObservedAt||new Date().toISOString()},true);return "started";}
  };
  try {
    stopWatch = watchDraftLease(operation, checkLease);
      driver = await draftStep(operation, "原对话页面", () => deps.resolveDraftDriver(inst, { signal: operation.controller.signal }));
      activity=onDeliveryPage?.({driver,cancel:error=>operation.controller.abort(error)});
      check();
      await draftStep(operation, "原对话加载", () => driver.navigate(task.conversationUrl)); pinned=true;check();
      const login = await draftStep(operation, "原对话登录检查", () => driver.waitForLogin ? driver.waitForLogin({ timeoutMs: 30000, check }) : driver.isLoggedIn());
      check(); if (login?.loggedIn !== true) return;
      await waitHuman();check();await draftStep(operation, "原对话跟踪", () => beginTracking(driver,task,inst,true));check();
      const initial=observeProgress(await draftStep(operation, "原对话状态", () => driver.readProgress()));check();if(initial==="failed")return;
      if(initial!=="started"){
        activity?.setStage?.("waiting_receipt");
        const confirm=()=>draftStep(operation, "原对话确认", () => confirmGeneration(driver,task,store.get().settings.orchestrator||{},{id:task.storyboardId},{check,checkLease,persist:patch=>patchTask(task.id,patch,true)}));
        const confirmation=activity?.runAutomation?await activity.runAutomation(confirm):await confirm();
        if(confirmation?.sent){
          let deadline=Date.now()+120000;
          for(;;){
            const before=Date.now();await waitHuman();deadline+=Date.now()-before;check();
            const state=observeProgress(await draftStep(operation, "原对话状态", () => driver.readProgress()));check();if(state==="failed")return;if(state==="started")break;
            if(Date.now()>=deadline)throw Error("生成确认已投递，开始状态待核验；保留原意图，不再次确认");
            await new Promise(resolve=>setTimeout(resolve,250));
          }
        }
      }
      await waitHuman();check();
      if (task.generationObservedAt || Object.values(task.confirmationIntents || {}).some(intent => intent.state === "sent")) {
        patchTask(task.id, { status: "queued", stage: "generating" }, true);
        storyboard.updateShot(task.storyboardId, task.shotId, { status: "queued" });
      }
  } catch(error) {
    if(activity&&(activity.humanTouched||activity.captchaSeen||Object.keys(task.confirmationIntents||{}).length)){activity.keepOpen=true;driver?.preserve?.();}
    throw error;
  } finally {
    stopWatch();const keepOpen=activity?.keepOpen===true;if(keepOpen)driver?.preserve?.();activity?.close?.();operation.controller.abort(new Error("本次确认租约操作已归还"));if(!keepOpen)driver?.close?.();
  }
}
async function withNativeDrafts(selected, options, fn) {
  const fixed = [...new Set(selected.map((d) => d.instanceId).filter(Boolean))];
  if (fixed.length > 1) throw new Error("请选择同一个豆包号里的草稿一起发送");
  const chosen = String(options.instanceId || "");
  if (chosen && fixed.length && chosen !== fixed[0]) throw new Error(`所选草稿已存入 ${selected.find((d) => d.instanceId)?.instanceName || "原账号"}，请使用该账号发送；若需更换账号，请将模板存入目标账号的草稿`);
  if (chosen && !store.find(chosen)) throw new Error("指定的豆包账号不存在，请重新选择");
  const inst = chosen || fixed.length ? store.find(chosen || fixed[0]) :
    store.find(drafts.list().find((d) => d.nativeState === "saved" && !runtime.busy.has(d.instanceId))?.instanceId) ||
    pickInstance() || store.get().instances.find((i) => !runtime.busy.has(i.id));
  if (!inst) throw new Error("请先添加并登录一个豆包号；草稿记录已保留");
  if (runtime.busy.has(inst.id)) throw new Error(`账号 ${inst.name} 正在执行任务，请空闲后重试`);
  const operation = { instanceId: inst.id, instanceName: inst.name, stopped: false, controller: new AbortController() };
  runtime.busy.add(inst.id); runtime.nativeDrafts.set(inst.id, operation);
  const check = () => operation.controller.signal.throwIfAborted();
  const checkAction = () => { check(); options.checkLease?.(); };
  let stopWatch = () => {};
  try {
    stopWatch = watchDraftLease(operation, options.checkLease);
    emit("draft", { message: `正在连接 ${inst.name}，准备处理 ${selected.length} 条草稿…`, instanceId: inst.id });
    const driver = await draftStep(operation, "账号页面加载", () => deps.resolveDriver ? deps.resolveDriver(inst) : driverMod.open(inst, { webContents: deps.findWebContents?.(inst) }));
    emit("draft", { message: `已连接 ${inst.name}，正在检查登录状态…`, instanceId: inst.id });
    const login = await draftStep(operation, "账号登录检查", () => driver.isLoggedIn());
    if (login?.loggedIn !== true) throw new Error(`请先在账号 ${inst.name} 的豆包页面登录`);
    check();
    return await fn(driver, inst, check, operation, checkAction);
  } finally {
    stopWatch();
    operation.controller.abort(new Error("草稿操作已结束"));
    runtime.nativeDrafts.delete(inst.id); runtime.busy.delete(inst.id); wakeQueue();
  }
}
async function saveDrafts(ids, options = {}) {
  let selected = selectedDrafts(ids);
  for (const d of selected) {
    if (d.submissionRecord || (d.nativeState === "saving" && (!d.instanceId || !d.nativePrompt))) throw new Error(`草稿「${d.template.name}」上次操作未确认，请先在豆包页面核对，避免重复保存或发送`);
    if (d.executionMode !== "work" && (d.instanceId || d.nativeBinding || d.nativeState)) throw new Error(`草稿「${d.template.name}」是旧版对话草稿，草稿提交仅支持云电脑，请将模板重新加入草稿箱`);
  }
  const converted = selected.filter(d => d.executionMode !== "work");
  if (converted.length) {
    drafts.updateMany(Object.fromEntries(converted.map(d => [d.id, { executionMode: "work" }])));
    selected = selectedDrafts(ids);
  }
  return withNativeDrafts(selected, options, async (accountDriver, inst, check, operation, checkAction) => {
    const errors = [];
    let count = 0;
    for (const [index, draft] of selected.entries()) {
      checkAction();
      const child = { controller: new AbortController() };
      const abort = () => child.controller.abort(operation.controller.signal.reason);
      operation.controller.signal.addEventListener("abort", abort, { once: true });
      let driver, importOptions, releaseObservation;
      const position = `${index + 1}/${selected.length}`;
      const step = async (label, run, timeoutMs) => {
        emit("draft", { message: label + "…", instanceId: inst.id });
        log.info("draft-save-step", { instanceId: inst.id, draftId: draft.id, stage: label });
        const result = await draftStep(child, label, run, timeoutMs);
        checkAction(); child.controller.signal.throwIfAborted();
        return requirePage(result);
      };
      try {
        if (!draft.nativeBinding || options.recreateDeleted === true) templates.validateSnapshot(draft.template);
        // Check durable storage before an action can change the website page.
        drafts.updateMany({ [draft.id]: { nativeError: "" } });
        // A failed page never becomes the next draft's composer. The factory
        // owns this page until its receipt is checked or its signal is aborted.
        driver = deps.resolveDraftDriver ? await draftStep(child, `正在打开草稿处理页 ${position}`, async () => {
          const opened = await deps.resolveDraftDriver(inst, { signal: child.controller.signal, purpose: "import" });
          if (child.controller.signal.aborted) { opened.close?.(); child.controller.signal.throwIfAborted(); }
          return opened;
        }) : accountDriver;
        releaseObservation = options.onImportPage?.({ draft, driver });
        if (driver !== accountDriver && driver.prepareDraftImport) await step(`正在激活草稿输入区 ${position}`, () => driver.prepareDraftImport());
        await step(`正在检查草稿账号 ${position}`, async () => {
          const state = driver.waitForLogin ? await driver.waitForLogin({ timeoutMs: 30000, check: () => { checkAction(); child.controller.signal.throwIfAborted(); } }) : await driver.isLoggedIn();
          return state?.loggedIn === true ? { ok: true } : { ok: false, reason: `请先在账号 ${inst.name} 的豆包页面登录` };
        });
        const record = templateRecords(draft.template, draft.executionMode, { sendOnly: draft.studioSendOnly === true });
        const draftNumber = draft.nativePrompt ? draft.draftNumber : draft.draftNumber || drafts.numberFor(draft.id);
        record.task.prompt = draft.nativePrompt || withSeedanceSkill(`【草稿编号：${draftNumber}】\n编号仅用于识别本次任务，请勿将编号或此说明作为画面、字幕或旁白。\n\n${record.task.prompt}`);
        const attachmentNames = record.task.refs.map(file => path.basename(file));
        importOptions = { id: draft.id, prompt: record.task.prompt, executionMode: draft.executionMode, attachmentNames, nativeId: draft.nativeBinding?.nativeId, accountScope: draft.nativeBinding?.accountScope || options.expectedAccountScope, recreateDeleted: options.recreateDeleted === true, isolated: !!deps.resolveDraftDriver };
        let prepare = draft.nativeState !== "saved" && draft.nativeState !== "saving", uploadRefs = record.task.refs;
        const bindings = nativeBindings(inst.id).filter(b => b.id === draft.id);
        if (draft.nativeState === "saving" && draft.nativeBinding) bindings.push({ ...draft.nativeBinding, draftNumber, prompt: record.task.prompt, executionMode: draft.executionMode });
        if (bindings.length) {
          const restored = await step(`正在核对已保存的豆包草稿 ${position}`, () => driver.call("restoreNativeDrafts", bindings, { allowMissing: options.recreateDeleted === true }));
          if (restored.bindings?.length) drafts.updateMany(bindingPatches(restored.bindings));
          if (options.recreateDeleted === true && draft.nativeState === "saved" && restored.missingIds?.includes(draft.id)) {
            delete importOptions.nativeId; prepare = true;
          }
        }
        if (!prepare) {
          const resumed = await step(`正在核对草稿完整内容 ${position}`, () => driver.call("resumeNativeDraftImport", importOptions), 75000);
          if (resumed.bindings?.length) drafts.updateMany(bindingPatches(resumed.bindings));
          const binding = resumed.bindings?.find(b => b.id === draft.id);
          if (binding) Object.assign(importOptions, { nativeId: binding.nativeId, accountScope: binding.accountScope });
          if (resumed.complete) {
            drafts.updateMany({ [draft.id]: { nativeState: "saved", nativeError: "" } }); count++; continue;
          }
          if (resumed.restart) {
            if (options.recreateDeleted !== true || !resumed.accountScope || (draft.nativeBinding && draft.nativeBinding.accountScope !== resumed.accountScope)) throw new Error("未确认中断草稿可恢复，未重复导入");
            delete importOptions.nativeId;
            importOptions.accountScope = resumed.accountScope; prepare = true;
          } else {
            if (!Array.isArray(resumed.missingNames) || resumed.missingNames.some(name => !attachmentNames.includes(name))) throw new Error("未确认原草稿缺失的素材，未重复导入");
            uploadRefs = record.task.refs.filter(file => resumed.missingNames.includes(path.basename(file)));
          }
        }
        if (prepare) {
          const prepared = await step(`正在准备云电脑草稿 ${position}`, () => driver.call("prepareNativeDraft", { executionMode: draft.executionMode, model: record.task.model, duration: record.task.duration, ratio: record.task.ratio }));
          if (importOptions.accountScope && prepared.accountScope !== importOptions.accountScope) throw new Error("恢复期间豆包账号已变化，未填写或上传草稿");
        }
        checkAction(); child.controller.signal.throwIfAborted();
        drafts.updateMany({ [draft.id]: { draftNumber, instanceId: inst.id, instanceName: inst.name, nativeState: "saving", nativePrompt: record.task.prompt, nativeError: "", ...(prepare ? { nativeBinding: null } : {}) } });
        await step(`正在填写草稿提示词 ${position}`, () => driver.setText(record.task.prompt));
        if (uploadRefs.length) await step(`正在接收草稿素材 ${position}`, () => driver.pasteFiles(uploadRefs, importOptions));
        const saved = await step(`正在确认豆包草稿完整保存 ${position}`, () => driver.call("saveNativeDraft", importOptions), 210000);
        const patches = bindingPatches(saved.bindings);
        if (!patches[draft.id]) throw new Error("豆包未返回新草稿的位置，请在左侧草稿核对");
        patches[draft.id].nativeState = "saved"; patches[draft.id].nativeError = "";
        drafts.updateMany(patches); count++;
        emit("draft", { message: `已存入豆包草稿 ${count}/${selected.length}，已跳过 ${errors.length} 条`, instanceId: inst.id });
      } catch (error) {
        checkAction();
        const message = String(error.message || error);
        if (driver && importOptions?.isolated && !child.controller.signal.aborted) {
          try {
            const parked = await draftStep(child, "保留未完成的网页草稿", () => driver.call("parkNativeDraftImport", importOptions), 15000);
            checkAction();
            if (parked?.ok && parked.bindings?.length) drafts.updateMany(bindingPatches(parked.bindings));
          } catch { checkAction(); }
        }
        log.warn("draft-save-failed", { instanceId: inst.id, draftId: draft.id, saved: count, total: selected.length, message });
        drafts.updateMany({ [draft.id]: { nativeError: message, ...(draft.nativeState === "saved" ? { nativeState: "saving" } : {}) } });
        errors.push({ id: draft.id, draftNumber: draft.draftNumber || drafts.numberFor(draft.id), name: draft.template.name, message });
        emit("draft", { message: `草稿 ${draft.draftNumber || drafts.numberFor(draft.id)} 导入失败：${message}；已跳过，继续下一条（${position}）`, instanceId: inst.id });
      } finally {
        releaseObservation?.();
        operation.controller.signal.removeEventListener("abort", abort);
        // The signal closes a dedicated page, including any late upload callbacks.
        child.controller.abort(new Error("本条草稿导入已结束"));
        if (driver) {
          void driver.call("cancelNativeDraftImport").catch(() => {});
          if (driver !== accountDriver) driver.close?.();
        }
      }
    }
    return { count, failed: errors.length, total: selected.length, errors, instanceId: inst.id, instanceName: inst.name };
  });
}
async function submitDrafts(ids, options = {}) {
  if (options.dispatchOnly === true && options.sendOnly !== true) throw new Error("仅允许只发送验收记录投递动作，不得启动生成");
  const requested = selectedDrafts(ids), unresolved = [];
  const selected = requested.filter(d => {
    if (!d.submissionRecord?.task.submissionUncertain) return true;
    unresolved.push(d); return false;
  });
  if (!selected.length) throw new Error("所选草稿发送结果尚未确认，请核对豆包最近任务，不会自动重发");
  for (const d of selected) {
    const recorded = d.submissionRecord?.task;
    // Pre-1.5.14 accepted records have no message anchor. Their persisted sent
    // state and locked conversation still permit committing the existing task.
    const legacyAccepted = d.nativeState === "sent" && recorded?.submissionUncertain === false && recorded.sentAt && recorded.conversationLocked === true && /^https?:\/\/[^/]+\/chat\/[^/?#]+(?:[?#].*)?$/.test(recorded.conversationUrl || "");
    if (d.submissionRecord && (!recorded || recorded.submissionUncertain || !recorded.conversationUrl || (!recorded.receiptUserMessageId && !legacyAccepted))) throw new Error(`草稿「${d.template.name}」发送结果尚未确认，请核对豆包最近任务，不会自动重发`);
    if (d.executionMode !== "work" && !d.submissionRecord) throw new Error(`草稿「${d.template.name}」仅支持通过云电脑提交，请先存入云电脑草稿`);
    if (!d.submissionRecord && d.nativeState !== "saved") throw new Error("请先将所选草稿存入豆包网页，再一起发送");
  }
  return withNativeDrafts(requested, options, async (_driver, inst, check, operation, checkAction) => {
    const accepted = selected.filter((d) => d.submissionRecord).map((d) => ({ id: d.id, record: d.submissionRecord }));
    const pending = selected.filter((d) => !d.submissionRecord), errors = unresolved.map(d => ({ phase: "receipt", message: `草稿「${d.template.name}」上次发送结果尚未确认，不会自动重发` })), children = new Set();
    const bindings = nativeBindings(inst.id), draftBatchId = `draft-batch-${crypto.randomBytes(12).toString("hex")}`;
    let failure, deliveryPause, launched = 0;
    const checkDispatch = () => {
      checkAction();
    };
    const progress = message => {
      const count = phase => errors.filter(e => e.phase === phase).length;
      emit("draft", { message: `${message} · 本次发起 ${launched}/${pending.length} 条，豆包已接收 ${accepted.length}/${requested.length} 条；未发送 ${count("prepare")} 条，接收待核对 ${count("receipt")} 条`, instanceId: inst.id });
    };
    const abortChildren = () => {
      for (const child of children) child.controller.abort(operation.controller.signal.reason);
    };
    operation.controller.signal.addEventListener("abort", abortChildren, { once: true });
    try {
      if (pending.length && !deps.resolveDraftDriver) throw new Error("草稿投递页面未就绪，请更新并重启应用");
      const data = pending.length ? requirePage(await draftStep(operation, "读取本批完整草稿", () => _driver.call("readNativeDrafts"))) : null;
      const catalog = data?.source === "indexeddb" ? { accountScope: data.accountScope, items: data.items } : null;
      // Finish this receipt and close its page before preparing the next draft.
      // Generation confirmation remains separate from draft submission.
      async function dispatchDraft(draft, index) {
        checkAction();
        const preparingAt = Date.now();
        const child = { controller: new AbortController() };
        children.add(child);
        let driver, record, activity, issued = false, received = false, trackingReceipt = false, holdPage = false;
        const checkDraft = () => { check(); child.controller.signal.throwIfAborted(); };
        const cleanup = () => { const keepOpen=holdPage||activity?.keepOpen===true;if(keepOpen)driver?.preserve?.();activity?.close?.();children.delete(child);child.controller.abort(new Error("本条草稿核对已结束"));if(!keepOpen)driver?.close(); };
        const recordFailure = error => {
          if (issued && !received && draft.template.studioTaskId && draft.template.attachments.length) { holdPage = true; if(activity)activity.keepOpen=true; }
          const mustPause = options.continueOnFailure !== true || error.code === "CAPTCHA_HANDOFF_INTERRUPTED" || activity?.inputHeld || activity?.inputInFlight;
          if (mustPause && (holdPage || (!received && activity?.captchaSeen) || activity?.keepOpen || error.code === "CAPTCHA_HANDOFF_INTERRUPTED")) deliveryPause = {
            reason: holdPage || activity?.keepOpen || error.code === "CAPTCHA_HANDOFF_INTERRUPTED" ? "manual_interrupted" : "captcha_wait_ended",
            taskId: draft.template.studioTaskId, draftId: draft.id,
            notStartedDraftIds: pending.slice(issued ? index + 1 : index).map(item => item.id)
          };
          const message = `${received ? "草稿已接收，保存任务失败" : issued ? "已发起发送，接收结果未确认" : "尚未发送"}：${error.message}`;
          errors.push({ message, phase: received ? "commit" : issued ? "receipt" : "prepare" });
          if (issued && !received && record) { try { const observed = driver?.webContents?.getURL?.(); if (/^https:\/\/www\.doubao\.com\/chat\/[^/?#]+$/.test(observed || "")) record.task.unverifiedConversationUrl = observed; } catch {} }
          drafts.updateMany({ [draft.id]: { nativeError: message, ...(received || issued ? { submissionRecord: JSON.parse(JSON.stringify(record)) } : {}) } });
          log.warn("draft-dispatch-failed", { draftBatchId, draftId: draft.id, instanceId: inst.id, issued, message });
          progress("本条异常已记录，继续投递其他草稿");
        };
        progress(`正在准备第 ${index + 1} 条`);
        try {
          checkDispatch();
          await draftStep(child, `第 ${index + 1} 条草稿页面`, async () => {
            driver = await deps.resolveDraftDriver(inst, { signal: child.controller.signal });
            log.info("draft-preparation-stage", { draftBatchId, draftId: draft.id, index: index + 1, stage: "page_ready", elapsedMs: Date.now() - preparingAt });
            if (child.controller.signal.aborted) driver.close();
            checkDraft();
            activity = options.onDeliveryPage?.({ draft, driver, cancel: error => child.controller.abort(error) });
            activity?.setStage?.("preparing");
            const login = await driver.waitForLogin({ check: checkDraft });
            if (login?.loggedIn !== true) throw new Error(login?.by === "login-button"
              ? `账号 ${inst.name} 的草稿页面仍显示登录入口，请在该账号页面确认登录后重试`
              : `账号 ${inst.name} 的草稿页面登录状态尚未加载完成，请等待页面加载或检查网络后重试`);
            log.info("draft-preparation-stage", { draftBatchId, draftId: draft.id, index: index + 1, stage: "login_ready", elapsedMs: Date.now() - preparingAt });
          }, 120000);
          const prepare = () => draftStep(child, `第 ${index + 1} 条草稿准备`, async () => {
            requirePage(await driver.call("restoreNativeDrafts", bindings.filter((b) => b.id === draft.id), catalog ? { catalog } : undefined));
            const pageOptions = { id: draft.id, prompt: draft.nativePrompt, executionMode: draft.executionMode, attachmentNames: draft.template.attachments.map(file => path.basename(file.path)) };
            checkDispatch();
            const opened = requirePage(await driver.call("openNativeDraft", pageOptions));
            log.info("draft-preparation-stage", { draftBatchId, draftId: draft.id, index: index + 1, stage: "draft_ready", elapsedMs: Date.now() - preparingAt });
            const record = templateRecords(draft.template, draft.executionMode, { sendOnly: draft.studioSendOnly === true }), task = record.task;
            if (typeof draft.studioSendOnly === "boolean") task.studioSendOnly = draft.studioSendOnly;
            Object.assign(task, { prompt: draft.nativePrompt, draftNumber: draft.draftNumber, draftBatchId, instanceId: inst.id, instanceName: inst.name, preferredInstanceId: inst.id, submissionUncertain: true });
            const tracking = requirePage(await driver.beginTask({ taskId: task.id, prompt: task.prompt, resume: false }));
            Object.assign(task, { baselineUrls: tracking.baselineUrls || [], baselineMessageIds: tracking.baselineMessageIds || [], baselineMediaKeys: [...new Set([...(tracking.baselineUrls || []).map(mediaKey), ...interceptor.list({ instanceId: inst.id, kind: "video", limit: 800 }).map((m) => mediaKey(m.url))])], confirmationIntents: {} });
            checkDispatch();
            await driver.setGenerationOptions({ model: task.model, duration: task.duration });
            checkDraft();
            return { pageOptions, opened, record };
          }, 120000);
          const prepared = await (activity?.runAutomation ? activity.runAutomation(prepare) : prepare());
          const { pageOptions, opened } = prepared;
          record = prepared.record;
          let sent;
          const dispatch = async () => {
            checkDispatch();record.task.submittedAt = new Date().toISOString();
            drafts.updateMany({ [draft.id]: { nativeError: "", submissionRecord: JSON.parse(JSON.stringify(record)) } });
            activity?.setStage?.("waiting_receipt");
            sent = driver.call("sendNativeDraft", pageOptions);issued = true;launched++;
            log.info("draft-dispatch-started", { draftBatchId, draftId: draft.id, instanceId: inst.id, index: index + 1, total: pending.length, preparationMs: Date.now() - preparingAt });
            progress("已发起发送，后台核对回执");return sent;
          };
          if(activity?.runAutomation)await activity.runAutomation(dispatch);else await dispatch();
          trackingReceipt = true;
          await draftStep(child, "豆包接收回执", async () => {
            const clicked = await sent;
            if (!clicked?.ok) { issued = false; drafts.updateMany({ [draft.id]: { submissionRecord: null } }); requirePage(clicked); }
            record.task.sentAt = clicked.clickedAt || record.task.submittedAt;
            if (options.dispatchOnly || record.task.studioTaskId) {
              record.task.dispatchReceipt = { taskId: draft.template.studioTaskId, draftId: draft.id, nativeId: draft.nativeBinding.nativeId, clickedAt: record.task.sentAt, outcome: "pending" };
              const proof = clicked.attachmentProof;
              const proofValid = proof?.version === 1 && Array.isArray(proof.names) && JSON.stringify(proof.names) === JSON.stringify(pageOptions.attachmentNames) && Array.isArray(proof.fileKeys) && proof.fileKeys.length === pageOptions.attachmentNames.length && proof.fileKeys.every(key => typeof key === "string" && key.length > 0 && key.length <= 2048);
              if (proofValid) record.task.attachmentSendProof = { version: 1, names: proof.names.slice(), referenceCount: proof.names.length, fileKeySha256s: proof.fileKeys.map(key => crypto.createHash("sha256").update(key).digest("hex")), clickedAt: record.task.sentAt };
              drafts.updateMany({ [draft.id]: { submissionRecord: JSON.parse(JSON.stringify(record)), dispatchReceipt: record.task.dispatchReceipt } });
              if (record.task.studioTaskId && pageOptions.attachmentNames.length && !proofValid) throw new Error("未取得逐张附件发送证明，保留本次意图，不将文字回执作为五图发送成功");
            }
            const response = await driver.call("waitNativeDraftAccepted", { ...pageOptions, conversationIds: opened.conversationIds, baselineMessageIds: record.task.baselineMessageIds, dispatchOnly: options.dispatchOnly === true });
            if (response?.attachmentsPending === true) { holdPage = true; if(activity)activity.keepOpen=true; }
            const receipt = requirePage(response);
            checkDraft();
            if (receipt.quotaLimited === true && /^https:\/\/www\.doubao\.com\/chat\/[^/?#]+$/.test(receipt.conversationUrl || "")) {
              Object.assign(record.task.dispatchReceipt, { outcome: "quota_limited", conversationUrl: receipt.conversationUrl, providerMessage: receipt.providerMessage });
              drafts.updateMany({ [draft.id]: { submissionRecord: JSON.parse(JSON.stringify(record)), dispatchReceipt: record.task.dispatchReceipt, nativeError: "已点击发送，豆包返回免费额度限制；未生成" } });
              progress("本条已投递，豆包返回限额；继续下一条");return "quota_limited";
            }
            if (!receipt.userMessageId) throw new Error("回执缺少本次用户消息标识，请核对原对话；不会自动重发");
            if (record.task.studioTaskId && pageOptions.attachmentNames.length) {
              const proof = receipt.attachmentConsumptionProof;
              if (proof?.version !== 1 || JSON.stringify(proof.names) !== JSON.stringify(pageOptions.attachmentNames) || proof.userMessageId !== receipt.userMessageId || !Number.isFinite(Date.parse(proof.checkedAt)) || Date.parse(proof.checkedAt) < Date.parse(record.task.sentAt)) {
                holdPage = true; if(activity)activity.keepOpen=true;
                throw new Error("未取得原消息对应的附件清空证明，保留原页和发送意图，停止后续投递；不会自动重发");
              }
              record.task.attachmentConsumptionProof = { version: 1, names: proof.names.slice(), userMessageId: proof.userMessageId, checkedAt: proof.checkedAt };
            }
            Object.assign(record.task, { conversationUrl: receipt.conversationUrl, conversationLocked: true, submissionUncertain: false, receiptUserMessageId: receipt.userMessageId, baselineMessageIds: [receipt.userMessageId] });
            if (record.task.dispatchReceipt) Object.assign(record.task.dispatchReceipt, { outcome: "message_accepted", conversationUrl: receipt.conversationUrl });
            if (options.sendOnly) {
              Object.assign(record.task, { status: "submitted", stage: "submitted", waitReason: "已发送到豆包；生成确认暂不处理" });
              record.sb.shots[0].status = "submitted";
            }
            drafts.updateMany({ [draft.id]: { nativeState: "sent", nativeBinding: null, nativeError: "", submissionRecord: JSON.parse(JSON.stringify(record)) } });
            received = true;
            accepted.push({ id: draft.id, record });
            // Move this confirmed receipt atomically, without waiting for the
            // other drafts or its generation reminder.
            commitTemplates([record], [draft.id], false);
            progress("后台已确认接收");
          }, 15 * 60 * 1000).then(outcome=>activity?.waitForResume?.({receiptAccepted:outcome!=="quota_limited",providerResponded:outcome==="quota_limited"})).catch(recordFailure).finally(cleanup);
        } catch (error) { recordFailure(error); }
        finally { if (!trackingReceipt) cleanup(); }
        return { issued, received };
      }
      for (let index = 0; index < pending.length; index++) {
        check();
        const processed = await dispatchDraft(pending[index], index);
        checkAction();
        await options.onDraftProcessed?.({ draft: pending[index], index, ...processed });
        if (deliveryPause) break;
      }
    } catch (error) { failure = error; }
    finally {
      progress("投递阶段结束，核对发送回执");
      operation.controller.signal.removeEventListener("abort", abortChildren);
    }
    drafts.updateMany(bindingPatches(remainingDraftBindings(bindings, new Set(accepted.map((a) => a.id)))));
    accepted.sort((a, b) => selected.findIndex((d) => d.id === a.id) - selected.findIndex((d) => d.id === b.id));
    const remaining = accepted.filter(a => !getTask(a.record.task.id));
    if (remaining.length) commitTemplates(remaining.map(a => a.record), remaining.map(a => a.id), false);
    if (deliveryPause) options.onDeliveryPause?.(deliveryPause);
    const items = accepted.map(a => ({ taskId: a.record.task.id, status: a.record.task.status }));
    if (items.length && !operation.stopped && !options.sendOnly && options.startQueue !== false) { runtime.paused = false; wakeQueue(); }
    if (failure || errors.length) throw new Error(`已确认发送 ${accepted.length}/${requested.length} 条。未发送 ${errors.filter(e => e.phase === "prepare").length} 条，接收待核对 ${errors.filter(e => e.phase === "receipt").length} 条，任务保存异常 ${errors.filter(e => e.phase === "commit").length} 条。${failure?.message || errors[0].message}；各条失败原因已保存，其余草稿记录已保留`);
    return { items, count: items.length, instanceId: inst.id, instanceName: inst.name };
  });
}

function recoverTemplateTasks() {
  for (const task of store.get().tasks) {
    if (!task.templateId || !["running", "queued"].includes(task.status)) continue;
    // Legacy running tasks have no submission marker. Do not guess and resend.
    if (task.status === "running" && !Object.hasOwn(task, "submittedAt")) {
      Object.assign(task, { status: "failed", stage: "failed", submittedAt: task.startedAt || task.createdAt || new Date().toISOString(), submissionUncertain: true, error: "应用上次退出时任务未完成，请确认页面状态后重试（仅取回，不重复提交）", finishedAt: new Date().toISOString() });
      storyboard.setStatus(task.storyboardId, task.shotId, "failed", { error: task.error });
    } else {
      Object.assign(task, { status: "queued", stage: "waiting_account", waitReason: task.submittedAt ? "恢复后继续取回原账号的结果" : "恢复排队，等待账号", nextAttemptAt: 0 });
      storyboard.setStatus(task.storyboardId, task.shotId, "queued", { error: "" });
    }
  }
  store.save();
}
function state() {
  const stats = {};
  for (const sb of store.get().storyboards) stats[sb.id] = storyboard.stats(sb);
  return { paused: runtime.paused, queued: store.get().tasks.filter((t) => t.status === "queued").length, failed: store.get().tasks.filter((t) => t.status === "failed").length,
    running: [...runtime.running.values()].map((c) => ({ taskId: c.task.id, instanceId: c.inst.id, instanceName: c.inst.name, shotId: c.shot.id, shotIndex: c.shot.index, storyboardId: c.sb.id })).concat([...runtime.nativeDrafts.values()].map((c) => ({ ...c, taskId: "native-drafts", storyboardId: "" }))),
    busy: [...runtime.busy], parallel: maxParallel(), stopped: [...runtime.stopped], lastError: runtime.lastError, stats, tasks: taskList({ limit: 50 }) };
}
module.exports = { init, submitTemplate, saveDrafts, submitDrafts, confirmSubmittedTaskOnce, removeDrafts, stopTask, recoverTemplateTasks, wakeQueue, events, state, start, pause, resume, stop, stopAll, pump, dispatchOne, retryTask, redispatch, taskList, getTask, patchTask, pickInstance, buildShotPayload, quota };
