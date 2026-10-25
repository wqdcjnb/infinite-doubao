"use strict";

window.DMComponents = (() => {
  const labels = { idle: "未安装 · 按需下载", downloading: "正在下载", verifying: "正在校验", installing: "正在安装", installed: "已安装，可离线使用", error: "下载或安装失败", unavailable: "组件暂不可用" };
  const call = async (action) => {
    const result = await DM.call("dm:components:" + action);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  function panel() {
    const box = document.createElement("section");
    box.className = "s-group component-panel";
    box.innerHTML = '<h4>可选组件 · 本地素材处理</h4><p class="hint">遮脸、图片合成和剪映草稿导出需要此组件。账号、任务提交、视频下载与预览无需安装。仅在点击后下载，安装一次可重复使用。</p><div class="component-status" role="status">正在检查…</div><progress class="component-progress" max="100" value="0" hidden></progress><div class="component-actions"><button type="button" class="primary component-install" disabled>下载并安装</button><button type="button" class="ghost component-cancel" hidden>取消下载</button></div>';
    const status = box.querySelector(".component-status"), progress = box.querySelector("progress"), install = box.querySelector(".component-install"), cancel = box.querySelector(".component-cancel");
    let timer = null;
    function show(s) {
      const busy = ["downloading", "verifying", "installing"].includes(s.phase);
      const size = s.total ? `（${(s.total / 1048576).toFixed(1)} MB）` : "";
      status.textContent = (labels[s.phase] || s.phase) + (s.phase === "installed" ? "" : size) + (s.reason && ["error", "idle", "unavailable"].includes(s.phase) ? "：" + s.reason : "");
      progress.hidden = !busy;
      progress.value = s.total ? Math.round((s.received || 0) / s.total * 100) : 0;
      if (s.phase === "downloading") status.textContent += ` · ${progress.value}%`;
      install.disabled = busy || ["installed", "unavailable"].includes(s.phase);
      install.textContent = s.phase === "installed" ? "组件已就绪" : s.phase === "error" ? "重新下载" : "下载并安装";
      cancel.hidden = s.phase !== "downloading";
      if (busy && !timer) timer = setInterval(async () => {
        if (!box.isConnected) { clearInterval(timer); timer = null; return; }
        try { show(await call("status")); } catch (error) { status.textContent = error.message; }
      }, 800);
      if (!busy && timer) { clearInterval(timer); timer = null; }
    }
    install.onclick = async () => {
      install.disabled = true;
      try {
        const pending = call("install");
        show(await call("status"));
        const state = await pending;
        show(state);
      } catch (error) { show({ phase: "error", reason: error.message }); }
    };
    cancel.onclick = async () => { show(await call("cancel")); };
    call("status").then(show).catch((error) => show({ phase: "unavailable", reason: error.message }));
    return box;
  }
  return { panel };
})();
