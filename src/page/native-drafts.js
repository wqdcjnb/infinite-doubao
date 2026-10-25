// Operate Doubao's own sidebar drafts. Local records only identify saved rows.
(function () {
  var api = window[CFG.autoKey];
  if (!api) return;
  var beforeSave = [];
  function text(el) { return String(el && (/^(TEXTAREA|INPUT)$/.test(el.tagName) ? el.value : el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim(); }
  function editor() { return document.querySelector('#input-engine-container .tiptap[contenteditable="true"], #input-engine-container textarea, .tiptap.ProseMirror[contenteditable="true"]'); }
  function title(row) { return text(row.querySelector(":scope > span > span")); }
  function rows() { return Array.from(document.querySelectorAll('[data-testid="draft-conversation-section"] > [role="button"][class~="group/conversation-item"]')).filter(function (r) { return title(r) && title(r) !== "新对话"; }); }
  function mode() { return text(document.querySelector('#input-engine-container [data-testid="chat_input_action_mode"]')); }
  function sendButton() { return document.querySelector('button[data-testid="chat_input_send_button"]'); }
  function enabled(button) { return button && !button.disabled && !["aria-disabled", "aria-busy", "data-disabled", "data-loading"].some(function (attr) { return button.getAttribute(attr) === "true"; }); }
  function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function switchTo(work) {
    var prefix = work ? /^新工作任务(?:\s|$)/ : /^新对话(?:\s|$)/;
    var button = Array.from(document.querySelectorAll('button, [role="button"]')).find(function (b) { return prefix.test(text(b)); });
    if (!button) throw new Error("未找到" + (work ? "新工作任务" : "新对话") + "入口");
    button.click();
  }
  async function wait(read, message) {
    var end = Date.now() + 20000;
    while (Date.now() < end) { var result = read(); if (result) return result; await new Promise(function (r) { setTimeout(r, 100); }); }
    throw new Error(message);
  }
  function snapshot() {
    var current = rows(), titles = current.map(title);
    return current.filter(function (r) { return r.dataset.dmDraftId; }).map(function (r) { return { id: r.dataset.dmDraftId, index: current.indexOf(r), title: title(r), titles: titles }; });
  }
  function rowFor(id) { return rows().find(function (r) { return r.dataset.dmDraftId === id; }); }
  function result(fn) { return async function () { try { return await fn.apply(null, arguments); } catch (e) { return { ok: false, reason: String(e.message || e) }; } }; }
  api.restoreNativeDrafts = result(async function (bindings) {
    await wait(editor, "豆包输入区尚未加载");
    if (bindings && bindings.length) await wait(function () { return rows().length >= bindings.length; }, "豆包草稿列表尚未加载或原草稿已被移除");
    var current = rows(), titles = current.map(title), used = new Set();
    var mapped = (bindings || []).map(function (binding) {
      var row = rowFor(binding.id);
      if (!row && JSON.stringify(titles) === JSON.stringify(binding.titles)) row = current[binding.index];
      if (!row || title(row) !== binding.title || used.has(row)) throw new Error("豆包草稿列表已变化，无法确认原草稿，请在账号页面核对；不会按相似标题发送");
      used.add(row);
      return { row: row, id: binding.id };
    });
    mapped.forEach(function (m) { m.row.dataset.dmDraftId = m.id; });
    return { ok: true, bindings: snapshot() };
  });
  api.prepareNativeDraft = result(async function (options) {
    await wait(editor, "豆包输入区尚未加载");
    // Re-clicking New work on an unsent work composer does not save it.
    // Leaving for the opposite composer does, including the user's current text.
    if (text(editor())) {
      switchTo(mode() !== "云电脑");
      await wait(function () { return editor() && !text(editor()); }, "当前草稿尚未保存，请在豆包页面检查");
    }
    var prepared = await api[options.executionMode === "work" ? "prepareWorkTask" : "prepareVideoGeneration"](options);
    if (!prepared.ok) return prepared;
    // The mode label can switch before React replaces the composer. Filling
    // that outgoing node loses the prompt when the new work editor mounts.
    var previousEditor = null, stableAt = 0;
    await wait(function () {
      var current = editor();
      if (!current || text(current) || current !== previousEditor || (options.executionMode === "work" && mode() !== "云电脑")) {
        previousEditor = current; stableAt = Date.now(); return false;
      }
      return Date.now() - stableAt >= 1000;
    }, "工作任务输入区仍在切换，请等待豆包加载完成后重试");
    beforeSave = rows();
    return { ok: true };
  });
  api.saveNativeDraft = result(async function (options) {
    await wait(function () { return text(editor()) === normalize(options.prompt); }, "提示词未完整填入，草稿尚未保存，请检查账号输入区");
    var readyAt = 0;
    await wait(function () {
      if (!enabled(sendButton())) { readyAt = 0; return false; }
      if (!readyAt) readyAt = Date.now();
      return Date.now() - readyAt >= 600;
    }, "素材尚未上传完成或提示词不可提交，请检查豆包输入区");
    switchTo(options.executionMode !== "work");
    var row = await wait(function () {
      if (!editor() || text(editor())) return null;
      var added = rows().filter(function (r) { return !beforeSave.includes(r); });
      if (added.length !== 1) return null;
      var prefix = title(added[0]).replace(/[.…]+$/, "");
      return prefix && normalize(options.prompt).startsWith(prefix) ? added[0] : null;
    }, "未确认豆包原生草稿已保存，请在左侧草稿中核对，避免重复存入");
    row.dataset.dmDraftId = options.id;
    return { ok: true, bindings: snapshot() };
  });
  api.openNativeDraft = result(async function (options) {
    var row = rowFor(options.id);
    if (!row) throw new Error("未找到这条豆包草稿，请刷新账号页面后重试");
    row.click();
    var stableAt = 0;
    await wait(function () {
      var ready = row.isConnected && row.classList.contains("bg-dbx-bg-float") && text(editor()) === normalize(options.prompt) && enabled(sendButton()) &&
        (options.executionMode !== "work" || mode() === "云电脑");
      if (!ready) { stableAt = 0; return false; }
      if (!stableAt) stableAt = Date.now();
      return Date.now() - stableAt >= 600;
    }, "豆包草稿的完整提示词、素材或模式未就绪，已停止发送");
    return { ok: true, conversationIds: Array.from(document.querySelectorAll('a[id^="conversation_"]')).map(function (a) { return a.id.slice(13); }) };
  });
  api.sendNativeDraft = result(async function (options) {
    var row = rowFor(options.id), button = sendButton();
    if (!row || !row.classList.contains("bg-dbx-bg-float") || text(editor()) !== normalize(options.prompt) || !enabled(button)) throw new Error("当前草稿发生变化，尚未点击发送");
    button.click();
    return { ok: true, clickedAt: new Date().toISOString() };
  });
  api.waitNativeDraftAccepted = result(async function (options) {
    await wait(function () {
      var match = location.pathname.match(/^\/chat\/([^/]+)$/), id = match && match[1];
      return !rowFor(options.id) && id && !(options.conversationIds || []).includes(id) && document.getElementById("conversation_" + id);
    }, "尚未确认豆包接收本条草稿，请核对最近任务；不会自动重发");
    return { ok: true, conversationUrl: location.href, bindings: snapshot() };
  });
})();
