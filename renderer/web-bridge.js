"use strict";

// Desktop keeps its preload bridge; browsers use the same business handlers over HTTP.
if (!window.DM && /^https?:$/.test(location.protocol)) (() => {
  document.documentElement.classList.add("web-mode", "web-locked");
  const subscribers = new Map();
  let events;
  const status = document.createElement("div");
  status.className = "web-connection hidden"; status.setAttribute("role", "status"); document.body.appendChild(status);
  async function request(url, data, method) {
    const response = await fetch(url, { method: method || (data === undefined ? "GET" : "POST"),
      headers: data === undefined ? {} : { "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data), credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 && !document.documentElement.classList.contains("web-locked")) { status.textContent = "连接已失效，请刷新网页并从桌面端重新打开"; status.classList.remove("hidden"); }
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    return result;
  }
  function on(channel, callback) {
    if (!subscribers.has(channel)) subscribers.set(channel, new Set());
    subscribers.get(channel).add(callback);
    return () => subscribers.get(channel)?.delete(callback);
  }
  function connectEvents() {
    events = new EventSource("/web/events");
    events.onopen = () => status.classList.add("hidden");
    events.onerror = () => { status.textContent = "正在重连本机服务…请保持豆包工坊运行"; status.classList.remove("hidden"); };
    events.onmessage = (event) => {
      const { channel, payload } = JSON.parse(event.data);
      for (const callback of subscribers.get(channel) || []) { try { callback(payload); } catch (error) { console.error(error); } }
    };
  }
  function loginForm(error) {
    return new Promise((resolve) => {
      const screen = document.createElement("div"); screen.className = "web-login";
      screen.innerHTML = '<form class="web-login-card"><span class="badge">本机网页版</span><h1>豆包工坊</h1><p>在桌面软件顶部点击「打开网页版」即可连接。</p><p class="hint">也可以输入用户数据目录中 web-access.txt 的访问码。</p><label for="webAccess">本机访问码</label><input id="webAccess" type="password" autocomplete="off" required /><p class="web-login-error" role="alert"></p><button class="primary" type="submit">连接工作台</button></form>';
      document.body.appendChild(screen);
      const form = screen.querySelector("form"), message = screen.querySelector(".web-login-error"), button = screen.querySelector("button");
      message.textContent = error || "";
      form.onsubmit = async (event) => {
        event.preventDefault(); button.disabled = true;
        try { await request("/web/login", { token: screen.querySelector("input").value.trim() }); screen.remove(); resolve(); }
        catch (failure) { message.textContent = failure.message; }
        finally { button.disabled = false; }
      };
    });
  }
  const ready = (async () => {
    const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
    if (ticket) history.replaceState(null, "", location.pathname + location.search);
    try { if (ticket) await request("/web/login", { ticket }); else await request("/web/session"); }
    catch (error) { await loginForm(ticket ? error.message : ""); }
    status.classList.add("hidden"); document.documentElement.classList.remove("web-locked"); connectEvents();
  })();
  async function invoke(channel, ...args) { await ready; return (await request("/web/rpc", { channel, args })).result; }
  async function uploadFiles(files) {
    await ready;
    const paths = [];
    for (const file of files) {
      if (file.size > 512 * 1024 * 1024) throw new Error(`${file.name} 超过 512 MB`);
      const response = await fetch("/web/upload?name=" + encodeURIComponent(file.name), { method: "POST", body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "素材上传失败");
      paths.push(result.path);
    }
    return paths;
  }
  function selectFiles(multiple = true) {
    return new Promise((resolve) => {
      const input = document.createElement("input"); input.type = "file"; input.multiple = multiple;
      input.accept = "image/*,video/*,audio/*"; input.hidden = true; document.body.appendChild(input);
      input.addEventListener("change", () => { const files = Array.from(input.files || []); input.remove(); resolve(files); }, { once: true });
      input.addEventListener("cancel", () => { input.remove(); resolve([]); }, { once: true }); input.click();
    });
  }
  const DM = {
    isWeb: true, ready,
    loadStore: () => invoke("store:load"), saveSettings: (patch) => invoke("store:save-settings", patch),
    createAccount: (input) => invoke("account:create", input), updateAccount: (id, patch) => invoke("account:update", id, patch),
    removeAccount: (id) => invoke("account:remove", id), regenFingerprint: (id) => invoke("account:regenerate-fp", id),
    setFingerprintField: (id, patch) => invoke("account:set-fp-field", id, patch),
    testProxy: (id) => invoke("proxy:test", id), parseProxyList: (text) => invoke("proxy:parse-list", text),
    probeMask: () => invoke("mask:probe"), pickMaskFiles: async () => uploadFiles(await selectFiles()), runMask: (input) => invoke("mask:run", input),
    showItem: (file) => invoke("shell:show-item", file), openPath: (file) => invoke("shell:open-path", file),
    openExternal: (url) => invoke("shell:open-external", url), appHome: () => invoke("app:home"),
    paths: () => invoke("app:paths"), openHome: () => invoke("app:open-home"),
    call: (channel, ...args) => typeof channel === "string" && channel.startsWith("dm:") ? invoke(channel, ...args) : Promise.reject(new Error("非法通道")),
    filesFor: (files) => uploadFiles(Array.from(files || [])), mediaUrl: (file) => "/web/media?path=" + encodeURIComponent(file),
    onEvent: (cb) => on("dm:event", cb), onUpdate: (cb) => on("dm:update", cb), onLog: (cb) => on("dm:log", cb),
    onResource: (cb) => on("dm:resource", cb), onAccountOpen: (cb) => on("dm:account:open", cb),
    onSettingsChanged: (cb) => on("dm:settings", cb), onHotkey: (cb) => on("dm:hotkey", cb),
    onMaskProgress: (cb) => on("mask:progress", cb), onWatermarkProgress: (cb) => on("dm:no-watermark-progress", cb)
  };
  window.DM = DM;
  DM.createAccountView = (account) => {
    const root = document.createElement("div"); root.className = "remote-account";
    const image = document.createElement("img"); image.draggable = false; image.alt = `${account.name}的独立账号网页`;
    const keyboard = document.createElement("textarea"); keyboard.className = "remote-keyboard";
    keyboard.setAttribute("aria-label", "账号网页键盘输入"); keyboard.autocomplete = "off"; keyboard.spellcheck = false;
    const message = document.createElement("div"); message.className = "remote-message"; message.textContent = "正在连接账号网页…";
    const upload = document.createElement("button"); upload.className = "ghost remote-upload"; upload.textContent = "上传素材";
    root.append(image, keyboard, message, upload);
    let stopped = false, imageUrl = "", composing = false, lastMove = 0, multiple = true;
    let inputChain = Promise.resolve();
    const endpoint = (action) => `/web/account/${encodeURIComponent(account.id)}/${action}`;
    const showError = (error) => { message.textContent = error.message; message.classList.remove("hidden"); };
    function action(name, data = {}) { return request(endpoint(name), data); }
    function send(name, data) { inputChain = inputChain.then(() => action(name, data)).catch(showError); return inputChain; }
    function modifiers(event) { return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0); }
    function point(event) {
      const box = image.getBoundingClientRect();
      return { x: (event.clientX - box.left) * (image.naturalWidth / box.width || 1), y: (event.clientY - box.top) * (image.naturalHeight / box.height || 1),
        modifiers: modifiers(event), button: ["left", "middle", "right"][event.button] || "none", buttons: event.buttons };
    }
    image.addEventListener("pointerdown", (event) => {
      event.preventDefault(); keyboard.focus({ preventScroll: true }); image.setPointerCapture(event.pointerId);
      send("input", { ...point(event), type: "mousePressed", clickCount: Math.max(1, event.detail) });
    });
    image.addEventListener("pointerup", (event) => { event.preventDefault(); send("input", { ...point(event), type: "mouseReleased", clickCount: Math.max(1, event.detail) }); });
    image.addEventListener("pointermove", (event) => {
      if (Date.now() - lastMove < 40) return; lastMove = Date.now(); send("input", { ...point(event), type: "mouseMoved" });
    });
    image.addEventListener("wheel", (event) => { event.preventDefault(); send("input", { ...point(event), type: "mouseWheel", deltaX: event.deltaX, deltaY: event.deltaY }); }, { passive: false });
    image.addEventListener("contextmenu", (event) => event.preventDefault());
    root.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
    root.addEventListener("drop", async (event) => {
      event.preventDefault();
      try { const files = Array.from(event.dataTransfer.files); if (files.length) await send("files", { files: await uploadFiles(files) }); }
      catch (error) { showError(error); }
    });
    keyboard.addEventListener("compositionstart", () => { composing = true; });
    keyboard.addEventListener("compositionend", () => { composing = false; if (keyboard.value) send("text", { text: keyboard.value }); keyboard.value = ""; });
    keyboard.addEventListener("input", (event) => {
      if (composing || event.isComposing) return;
      if (keyboard.value) send("text", { text: keyboard.value }); keyboard.value = "";
    });
    keyboard.addEventListener("paste", async (event) => {
      event.preventDefault();
      if (event.clipboardData.files.length) {
        try { await send("files", { files: await uploadFiles(Array.from(event.clipboardData.files)) }); } catch (error) { showError(error); }
      } else send("text", { text: event.clipboardData.getData("text/plain") });
    });
    for (const type of ["keydown", "keyup"]) keyboard.addEventListener(type, async (event) => {
      if (event.isComposing || composing || event.key === "Process") return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
      if ((event.ctrlKey || event.metaKey) && ["c", "x"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        if (type === "keydown") {
          try {
            const result = await action("selection"); await navigator.clipboard.writeText(result.text);
            if (event.key.toLowerCase() === "x") send("input", { type: "keyDown", key: "Backspace", code: "Backspace", keyCode: 8 });
          } catch (error) { showError(error); }
        }
        return;
      }
      if (event.key.length > 1 || event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault(); send("input", { type: type === "keydown" ? "keyDown" : "keyUp", key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event) });
      }
    });
    upload.onclick = async () => {
      const files = await selectFiles(multiple); if (!files.length) return;
      upload.disabled = true; upload.textContent = "上传中…";
      try { await action("files", { files: await uploadFiles(files) }); upload.textContent = "上传素材"; }
      catch (error) { showError(error); upload.textContent = "重试上传素材"; }
      finally { upload.disabled = false; }
    };
    const unsubscribe = on("dm:web:file-chooser", (payload) => {
      if (payload.id !== account.id) return;
      multiple = payload.multiple; upload.textContent = "点击选择网页需要的素材"; upload.focus();
    });
    const observer = new ResizeObserver(() => {
      if (root.clientWidth && root.clientHeight) send("input", { type: "resize", width: root.clientWidth, height: root.clientHeight });
    });
    observer.observe(root);
    root.reload = () => action("reload").catch(showError); root.loadURL = (url) => action("navigate", { url }); root.setZoomFactor = () => {};
    const remove = root.remove.bind(root);
    root.remove = () => { stopped = true; observer.disconnect(); unsubscribe(); if (imageUrl) URL.revokeObjectURL(imageUrl); remove(); action("close").catch(() => {}); };
    async function frame() {
      if (stopped) return;
      try {
        if (!document.hidden && root.isConnected && !root.classList.contains("background-account") && document.querySelector("#view-accounts.active")) {
          const response = await fetch(endpoint("frame"));
          if (!response.ok) throw new Error((await response.json()).error || "账号网页暂时无法连接");
          const next = URL.createObjectURL(await response.blob()); image.src = next;
          if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = next;
          const error = decodeURIComponent(response.headers.get("x-page-error") || "");
          const loading = response.headers.get("x-page-loading") === "true";
          message.textContent = error || (loading ? "账号网页加载中…" : ""); message.classList.toggle("hidden", !message.textContent);
          root.dataset.url = decodeURIComponent(response.headers.get("x-page-url") || "");
        }
      } catch (error) { showError(error); }
      if (!stopped) setTimeout(frame, 150);
    }
    ready.then(() => action("open")).then(() => { root.dispatchEvent(new Event("dom-ready")); frame(); }).catch(showError);
    return root;
  };
  ready.then(() => {
    const button = document.getElementById("btnWeb");
    if (button) { button.textContent = "退出网页版"; button.onclick = async () => { events?.close(); await request("/web/logout", {}); location.reload(); }; }
  });
})();
