"use strict";

(() => {
  const dialog = document.createElement("dialog");
  dialog.id = "updateDialog";
  dialog.className = "update-dialog";
  dialog.setAttribute("aria-labelledby", "updateTitle");
  dialog.innerHTML = `<h2 id="updateTitle">软件更新</h2>
    <p id="updateVersion" class="hint"></p><p id="updateStatus" role="status" aria-live="polite"></p>
    <progress id="updateProgress" max="100" value="0" hidden></progress>
    <pre id="updateNotes" hidden></pre><p id="updateSource" class="hint"></p>
    <p id="updateInstallHint" class="hint"></p>
    <div class="update-actions"><button id="updateClose" class="ghost">稍后</button>
    <button id="updateRecheck" class="ghost">重新检查</button><button id="updateAction" class="primary">检查更新</button></div>`;
  document.body.appendChild(dialog);
  const q = (id) => dialog.querySelector("#" + id);
  const topButton = document.querySelector("#btnUpdate");
  let state = { phase: "idle" };
  let requesting = false;

  function render(next) {
    state = next;
    const mac = next.platform === "darwin";
    q("updateInstallHint").textContent = mac
      ? "打开安装镜像后应用将退出。将豆包工坊拖入“应用程序”并替换旧版，再重新打开；账号、任务、素材和设置保留。请先完成或停止正在执行的任务。"
      : "安装时将关闭并重启应用，保留账号、任务、素材和设置。请先完成或停止正在执行的任务。";
    const percent = next.total ? Math.min(100, Math.floor((next.received || 0) * 100 / next.total)) : 0;
    const titles = { idle: "点击检查最新版本", checking: "正在连接更新服务器…", available: `发现新版本 v${next.latest}`,
      current: "已是最新版本", downloading: `正在下载 ${percent}% · ${((next.received || 0) / 1048576).toFixed(1)} / ${(next.total / 1048576).toFixed(1)} MB`,
      ready: "下载完成，安装包校验通过", installing: "正在准备安装，应用即将退出…", error: next.reason || "更新失败，请重试" };
    q("updateVersion").textContent = `当前版本 v${next.current || "—"}${next.latest ? ` · 最新版本 v${next.latest}` : ""}`;
    q("updateStatus").textContent = titles[next.phase] || "";
    q("updateStatus").classList.toggle("update-error", next.phase === "error");
    q("updateSource").textContent = `更新服务器：${next.source || "—"}`;
    q("updateNotes").textContent = next.notes || "";
    q("updateNotes").hidden = !next.notes;
    q("updateProgress").hidden = !["downloading", "ready"].includes(next.phase);
    q("updateProgress").value = percent;
    const busy = ["checking", "downloading", "installing"].includes(next.phase);
    q("updateAction").disabled = busy || requesting;
    q("updateRecheck").disabled = busy || requesting;
    q("updateRecheck").hidden = !["available", "ready"].includes(next.phase);
    q("updateAction").textContent = next.phase === "available" ? "下载更新" : next.phase === "ready" ? (mac ? "打开安装镜像" : "安装并重启") : busy ? "请稍候…" : "检查更新";
    topButton.textContent = next.phase === "available" ? "发现新版本" : next.phase === "downloading" ? `下载中 ${percent}%` : next.phase === "ready" ? "安装更新" : "检查更新";
  }

  async function call(action) {
    const response = await window.DM.call("dm:update:" + action);
    if (!response?.ok) throw new Error(response?.error || "更新操作失败");
    return response.data;
  }

  async function run(action) {
    if (requesting) return;
    requesting = true;
    render(state);
    try {
      if (action === "install") await window.DMUpdates.beforeInstall?.();
      render(await call(action));
    } catch (error) {
      // 运行中任务等安装阻碍保留已下载状态，完成任务后可直接重试安装。
      q("updateStatus").textContent = error.message;
      q("updateStatus").classList.add("update-error");
    } finally {
      requesting = false;
      q("updateAction").disabled = ["checking", "downloading", "installing"].includes(state.phase);
      q("updateRecheck").disabled = q("updateAction").disabled;
    }
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    try {
      render(await call("status"));
      if (["idle", "current", "error"].includes(state.phase)) await run("check");
    } catch (error) { render({ ...state, phase: "error", reason: error.message }); }
  }
  q("updateAction").addEventListener("click", () => run(state.phase === "available" ? "download" : state.phase === "ready" ? "install" : "check"));
  q("updateRecheck").addEventListener("click", () => run("check"));
  q("updateClose").addEventListener("click", () => dialog.close());
  topButton.addEventListener("click", open);
  window.DM.onUpdate(render);
  window.DMUpdates = { open, beforeInstall: null };
})();
