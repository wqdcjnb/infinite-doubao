"use strict";

// A persistent task owns dispatch, generation and delivery. Retrying an
// accepted generation resumes it on the same account instead of sending twice.
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const store = require("./store");
const quota = require("./quota");
const storyboard = require("./storyboard");
const assets = require("./assets");
const interceptor = require("./interceptor");
const driverMod = require("./driver");
const accountProbe = require("./account-probe");
const log = require("./logger");

const events = new EventEmitter();
const runtime = { running: new Map(), busy: new Set(), blocked: new Map(), paused: false, stopped: new Set(), timer: null, lastError: "" };
let deps = { resolveDriver: null, findWebContents: null };
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
    model: String(input.model || ""), duration: Number(input.duration) || 0,
    prompt: String(input.prompt || ""), refs: Array.isArray(input.refs) ? input.refs : [],
    status: "queued", stage: "waiting_account", progress: 0, waitReason: "等待分配账号",
    attempts: 0, retryCount: 0, dedupeKey: String(input.dedupeKey || ""),
    createdAt: new Date().toISOString(), startedAt: "", submittedAt: "", generatedAt: "", finishedAt: "",
    error: "", result: null, log: []
  };
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
async function confirmGeneration(driver, task, options, sb) {
  // Older drivers/test adapters only provide the button helper.
  if (!driver.call) { if (options.autoConfirm !== false && driver.confirmGeneration) await driver.confirmGeneration(); return null; }
  const expected = { model: task.model, duration: task.duration };
  const candidate = await driver.call("peekGenerationConfirmation", expected);
  if (!candidate?.kind) return null;
  if (!candidate.ok) return { waiting: true, reason: candidate.reason || "请手动检查生成参数" };
  if (options.autoConfirm === false) return { waiting: true, reason: "等待确认生成参数（自动确认已关闭）" };
  const intents = task.confirmationIntents || {};
  if (intents[candidate.key] || (candidate.kind === "text" && Object.values(intents).some((intent) => intent.kind === "text"))) {
    return { waiting: true, reason: "确认已发送或正在等待平台响应，不会重复确认" };
  }
  checkStopped(sb);
  const intent = { kind: candidate.kind, state: "pending", at: new Date().toISOString() };
  patchTask(task.id, { confirmationIntents: { ...intents, [candidate.key]: intent } }, true);
  let actionAttempted = false;
  try {
    if (candidate.kind === "text") {
      const filled = await driver.setText("确认，开始生成视频。");
      if (!filled?.ok) throw new Error("填写视频参数确认失败");
      const latest = await driver.call("peekGenerationConfirmation", expected);
      if (!latest?.ok || latest.key !== candidate.key) throw new Error("视频参数确认内容发生变化，已暂停确认");
      checkStopped(sb);
      actionAttempted = true;
      const sent = await driver.send();
      if (!sent?.ok) { actionAttempted = false; throw new Error(`发送视频参数确认失败：${sent?.reason || "未找到发送按钮"}`); }
    } else {
      checkStopped(sb);
      actionAttempted = true;
      const confirmed = await driver.call("confirmGeneration", { ...expected, key: candidate.key });
      if (!confirmed?.ok) { actionAttempted = false; throw new Error(confirmed?.reason || "确认按钮已变化"); }
    }
    patchTask(task.id, { confirmationIntents: { ...task.confirmationIntents, [candidate.key]: { ...intent, state: "sent" } } }, true);
    emitLog(task, candidate.kind === "text" ? "已回复确认生成视频参数" : "已确认生成视频参数");
    return { waiting: true, reason: "确认已发送，等待平台开始生成" };
  } catch (error) {
    if (!actionAttempted) {
      const remaining = { ...task.confirmationIntents }; delete remaining[candidate.key];
      patchTask(task.id, { confirmationIntents: remaining }, true);
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
      const prepared = await driver.call("prepareVideoGeneration", { model: task.model, duration: task.duration });
      if (!prepared?.ok) throw Object.assign(new Error(`视频生成参数未就绪：${prepared?.reason || "无法选择模型或时长"}`), {
        code: (prepared?.code ? prepared.code === "model_unavailable" : /未开通|没有.*可选择|不可用|不支持|无权限|升级|会员|付费|当前账号不能使用/.test(prepared?.reason || "")) ? "model_unavailable" : "prepare_failed"
      });
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
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      if (task.progress !== percent) patchTask(task.id, { progress: percent });
      if (lastState !== progress.state) { lastState = progress.state; emitLog(task, `页面状态：${progress.state}`); }
      if (progress.state === "waiting_confirmation" || (confirmation?.waiting && !["failed", "done", "running"].includes(progress.state))) {
        patchTask(task.id, { stage: "waiting_confirmation", waitReason: confirmation?.reason || "等待确认生成参数" });
      } else if (progress.state === "unknown") {
        if (task.stage !== "waiting_result") patchTask(task.id, { stage: "waiting_result", waitReason: "已提交，等待豆包返回本次视频结果" });
      } else if (progress.state === "running" && task.stage !== "generating") patchTask(task.id, { stage: "generating", waitReason: "" });
      if (progress.state === "failed") {
        const quotaFailure = /额度|免费数量|今日次数|已达上限|quota/i.test(progress.snippet || "");
        patchTask(task.id, { submittedAt: "", generatedAt: "", submissionUncertain: false });
        throw Object.assign(new Error(quotaFailure ? "账号额度用尽，等待其他可用账号" : "平台明确返回生成失败"), { code: quotaFailure ? "quota" : "generation_failed" });
      }
      if (progress.state === "done") {
        patchTask(task.id, { generatedAt: task.generatedAt || new Date().toISOString() });
        return await deliver(task, inst, shot, sb, currentMedia(task, inst, progress), options);
      }
    }
    throw Object.assign(new Error("等待生成超时；重试只继续查询本次结果，不会重复提交"), { code: "timeout" });
  } catch (error) {
    const message = String(error?.message || error);
    const code = error?.code;
    runtime.lastError = message;
    if (code === "login_required" || code === "quota" || code === "model_unavailable") {
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
  const fixedId = task.submittedAt ? task.instanceId : task.preferredInstanceId;
  const fixed = fixedId ? store.find(fixedId) : null;
  const exclude = new Set([...(opts.triedInstances || []), ...Object.keys(task.accountExclusions || {})]);
  const inst = fixedId ? (fixed && !exclude.has(fixedId) && instanceReady(fixed, !!task.submittedAt).ok ? fixed : null) : pickInstance(exclude, opts.preferredInstances || []);
  if (!inst) {
    const reasons = store.get().instances.map((i) => `${i.name}：${task.accountExclusions?.[i.id] || instanceReady(i, !!task.submittedAt).reason || "等待派发"}`);
    const waitReason = fixedId && !fixed ? "原生成账号已删除，无法取回结果" : reasons.join("；") || "尚无账号，请添加并登录账号后自动继续";
    if (task.stage !== "waiting_account" || task.waitReason !== waitReason) patchTask(task.id, { stage: "waiting_account", waitReason });
    scheduleWake(); return { ok: false, error: waitReason, taskId: task.id };
  }
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
  patchTask(task.id, { preferredInstanceId: instanceId });
  return retryTask(taskId, { preferredInstances: [instanceId] });
}
function submitTemplate(template) {
  const label = store.MODEL_OPTIONS.find((m) => m.value === template.model)?.label || template.model;
  const prompt = `${template.prompt.trim()}\n\n生成要求：生成 ${template.duration} 秒视频，使用 ${label} 模型。`;
  const sb = storyboard.create({ name: template.name, source: "task-template", shots: [{ title: template.name, videoPrompt: prompt, model: template.model, duration: template.duration, refs: template.attachments.map((a) => a.path) }] });
  const shot = sb.shots[0];
  const task = addTask(newTask({ storyboardId: sb.id, shotId: shot.id, shotIndex: 1, templateId: template.id, templateName: template.name, model: template.model, duration: template.duration, prompt, refs: shot.refs.slice() }));
  storyboard.updateShot(sb.id, shot.id, { taskId: task.id, status: "queued" });
  runtime.paused = false; wakeQueue(); return { taskId: task.id, status: task.status };
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
    running: [...runtime.running.values()].map((c) => ({ taskId: c.task.id, instanceId: c.inst.id, instanceName: c.inst.name, shotId: c.shot.id, shotIndex: c.shot.index, storyboardId: c.sb.id })),
    busy: [...runtime.busy], parallel: maxParallel(), stopped: [...runtime.stopped], lastError: runtime.lastError, stats, tasks: taskList({ limit: 50 }) };
}
module.exports = { init, submitTemplate, stopTask, recoverTemplateTasks, wakeQueue, events, state, start, pause, resume, stop, stopAll, pump, dispatchOne, retryTask, redispatch, taskList, getTask, patchTask, pickInstance, buildShotPayload, quota };
