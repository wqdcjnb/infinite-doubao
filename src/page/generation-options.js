// Select the platform's visible video controls before sending a queued task.
// Changing enhancer state alone does not change an already-open editor's options.
(function () {
  var api = window[CFG.autoKey];
  if (!api) return;
  var MODELS = {
    "seedance_v2.5": "Seedance 2.5",
    "seedance_v2.0": "Seedance 2.0",
    "seedance_v2.0_fast": "Seedance 2.0 Fast",
    "seedance_v2.0_mini": "Seedance 2.0 Mini"
  };
  var CONTROLS = 'button, [role="button"], [role="combobox"], [aria-haspopup]';
  var LOAD_TIMEOUT = 20000;
  function text(el) { return String(el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim(); }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
  }
  function nodes(selector, root) { return Array.from((root || document).querySelectorAll(selector)).filter(visible); }
  function editorRoot() { return nodes("#input-engine-container")[0] || document; }
  function editor() {
    return nodes('textarea, [contenteditable="true"], [role="textbox"]', editorRoot()).filter(function (el) { return !el.disabled && !el.readOnly; }).sort(function (a, b) {
      var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    })[0];
  }
  function hasDraft() {
    var input = editor(), root = editorRoot();
    return !!(input && String(input.value === undefined ? text(input) : input.value).trim()) ||
      (root !== document && nodes('img:not([aria-hidden="true"]), video', root).some(function (el) { return !el.closest(CONTROLS + ', [data-testid="skill_input_exit_button"]'); })) ||
      nodes('input[type="file"]', root).some(function (el) { return el.files && el.files.length; });
  }
  function hasMessages() { return nodes('[data-message-id]').length > 0; }
  function modelName(el) { var m = text(el).match(/Seedance\s*2\.\d+(?:\s+(?:Fast|Mini))?/i); return m ? m[0].replace(/\s+/g, " ").toLowerCase() : ""; }
  function modelButton() { return nodes(CONTROLS, editorRoot()).find(function (el) { return modelName(el); }); }
  function durationButton() { return nodes(CONTROLS, editorRoot()).find(function (el) { return /(?:\d+\s*s\b|\d+\s*秒)/i.test(text(el)) && !modelName(el); }); }
  function durationOf(el) { var m = text(el).match(/(\d+)\s*(?:s\b|秒)/i); return m ? Number(m[1]) : 0; }
  function activate(el) {
    var r = el.getBoundingClientRect();
    var init = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, init, { buttons: 1 })));
    el.dispatchEvent(new MouseEvent("mousedown", Object.assign({}, init, { buttons: 1 })));
    if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, init, { buttons: 0 })));
    el.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, init, { buttons: 0 })));
    el.click();
  }
  async function waitFor(find, message, timeout) {
    var end = Date.now() + (timeout || 5000);
    while (Date.now() < end) { var value = await find(); if (value) return value; await new Promise(function (r) { setTimeout(r, 100); }); }
    if (message) throw new Error(message);
    return null;
  }
  function unavailable(el) { return el.disabled || el.getAttribute("aria-disabled") === "true" || /升级|购买|开通|支付|订阅|充值/.test(text(el)); }
  function videoEntry() {
    return nodes('button, [role="button"], [role="menuitem"], [role="option"]').find(function (el) { return /^(视频生成|生成视频)(?:\s|$)/.test(text(el)); });
  }
  function modeMenu(label) {
    var root = editorRoot();
    if (root === document) {
      // Only inspect the composer, not the page's main 对话 / 工作 tabs.
      var editor = nodes('textarea, [contenteditable="true"], [role="textbox"]')[0];
      root = editor && editor.parentElement;
      for (var i = 0; root && i < 5; i++, root = root.parentElement) {
        if (root === document.body) return null;
        var found = find(root);
        if (found) return found;
      }
      return null;
    }
    return find(root);
    function find(parent) {
      return nodes('button, [role="button"], [aria-haspopup], [tabindex="0"]', parent).find(function (el) {
        return new RegExp('^' + label + '\\s*[>›»]?$').test(text(el));
      });
    }
  }
  async function enterVideoMode() {
    await waitFor(function () { return modelButton() || videoEntry() || modeMenu("对话") || modeMenu("技能"); }, "页面输入区尚未就绪，请等待网页加载后重试", LOAD_TIMEOUT);
    if (modelButton()) return;
    var entry = videoEntry();
    for (var label of ["对话", "技能"]) {
      if (entry) break;
      var menu = modeMenu(label);
      if (!menu || unavailable(menu)) continue;
      if (menu.getAttribute("aria-expanded") !== "true") activate(menu);
      entry = await waitFor(videoEntry, "", 5000);
      if (!entry) {
        menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        if (menu.getAttribute("aria-expanded") === "true") activate(menu);
      }
    }
    if (!entry) throw Object.assign(new Error("未找到视频生成入口，请在账号页展开输入框底部的“对话”或“技能”检查；任务尚未发送，可打开视频生成后重试"), { code: "video_entry_missing" });
    if (unavailable(entry)) throw Object.assign(new Error("当前账号的视频生成入口需要开通权限"), { code: "model_unavailable" });
    activate(entry);
    return entry;
  }
  api.prepareVideoGeneration = async function (options) {
    var phase = "page-ready";
    try {
      var label = MODELS[options && options.model];
      var duration = Number(options && options.duration);
      if (!label || !Number.isInteger(duration) || duration < 1) throw new Error("视频模型或时长无效");
      await waitFor(editor, "页面输入区尚未就绪，请等待网页加载后重试", LOAD_TIMEOUT);
      // An empty home composer is already a new conversation. Resetting it can
      // race with the asynchronously loaded video editor and discard its controls.
      var previousUrl = location.href;
      var inConversation = /\/chat\/[^/?#]+/.test(location.pathname);
      if (inConversation || hasDraft() || hasMessages()) {
        phase = "new-conversation";
        var newChat = nodes("button, [role=button]").find(function (el) { return /^新对话(?:\s|$)/.test(text(el)); });
        if (!newChat) throw new Error("未找到新对话按钮，已保留当前输入内容，请手动新建对话后重试");
        activate(newChat);
        await waitFor(function () { return editor() && !hasDraft() && !hasMessages() && (!inConversation || location.href !== previousUrl); }, "新对话尚未加载完成，任务尚未发送", LOAD_TIMEOUT);
      }
      phase = "video-entry";
      var entry = modelButton() ? null : await enterVideoMode();
      phase = "video-controls";
      var reentered = false;
      var model = await waitFor(async function () {
        if (modelButton()) return modelButton();
        // A late route render can replace the clicked entry with a fresh chat
        // composer. Select video once on the replacement, without resetting chat.
        if (!reentered && entry && !entry.isConnected && (modeMenu("对话") || modeMenu("技能"))) {
          reentered = true;
          entry = await enterVideoMode();
        }
        return modelButton();
      }, "视频生成控件未加载完成", LOAD_TIMEOUT);
      phase = "model";
      if (modelName(model) !== label.toLowerCase()) {
        activate(model);
        var option = await waitFor(function () {
          return nodes('[role="menuitem"], [role="option"], [role="radio"]').find(function (el) { return modelName(el) === label.toLowerCase(); });
        }, "当前页面未显示可选择的 " + label, LOAD_TIMEOUT);
        if (unavailable(option)) throw Object.assign(new Error("当前账号未开通 " + label + "，请使用有权限的账号或修改任务模型"), { code: "model_unavailable" });
        activate(option);
        await waitFor(function () { return modelName(modelButton()) === label.toLowerCase(); }, "豆包未接受所选视频模型");
      }
      phase = "duration";
      var durationControl = await waitFor(durationButton, "未找到豆包视频时长控件", LOAD_TIMEOUT);
      if (durationOf(durationControl) !== duration) {
        activate(durationControl);
        var durationOption = await waitFor(function () {
          var buttons = nodes('[role="menuitem"], [role="option"], [role="radio"], button');
          var choice = buttons.find(function (el) { return new RegExp("^" + duration + "\\s*(s|秒)$", "i").test(text(el)); });
          if (choice) return choice;
          var panel = nodes('[role="menu"], [role="dialog"], [data-state="open"]').find(function (el) { return /时长/.test(text(el)); });
          if (!panel) return null;
          var inputs = nodes('input[type="number"], input[type="range"]', panel);
          if (inputs.length === 1) return inputs[0];
          var sliders = nodes('[role="slider"]', panel);
          return sliders.length === 1 ? sliders[0] : null;
        }, "当前模型不支持在页面中选择 " + duration + " 秒视频");
        if (unavailable(durationOption)) throw Object.assign(new Error("当前账号不能使用所选视频时长"), { code: "model_unavailable" });
        if (durationOption.tagName === "INPUT") {
          var min = Number(durationOption.min || 1);
          var max = Number(durationOption.max || 30);
          if (duration < min || duration > max) throw new Error("平台当前允许时长 " + min + "–" + max + " 秒");
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(durationOption, String(duration));
          durationOption.dispatchEvent(new Event("input", { bubbles: true }));
          durationOption.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (durationOption.getAttribute("role") === "slider") {
          var menu = durationOption.closest('[role="menu"], [role="dialog"]');
          var seconds = (text(menu).match(/\d+\s*(?:s\b|秒)/gi) || []).map(function (s) { return parseInt(s, 10); });
          var low = Math.min.apply(null, seconds);
          var high = Math.max.apply(null, seconds);
          var indexLow = Number(durationOption.getAttribute("aria-valuemin"));
          var indexHigh = Number(durationOption.getAttribute("aria-valuemax"));
          var step = (high - low) / (indexHigh - indexLow);
          var delta = (duration - durationOf(durationButton())) / step;
          if (!seconds.length || !Number.isFinite(step) || step <= 0 || duration < low || duration > high || !Number.isInteger(delta)) throw new Error("当前页面支持的时长为 " + low + "–" + high + " 秒");
          durationOption.focus();
          for (var i = 0; i < Math.abs(delta); i++) {
            var key = delta > 0 ? "ArrowRight" : "ArrowLeft";
            durationOption.dispatchEvent(new KeyboardEvent("keydown", { key: key, code: key, bubbles: true, cancelable: true }));
            durationOption.dispatchEvent(new KeyboardEvent("keyup", { key: key, code: key, bubbles: true, cancelable: true }));
            await new Promise(function (resolve) { setTimeout(resolve, 60); });
          }
        } else activate(durationOption);
        await waitFor(function () { return durationOf(durationButton()) === duration; }, "豆包未接受所选视频时长");
        if (durationControl.getAttribute("aria-expanded") === "true") activate(durationControl);
      }
      return { ok: true, model: options.model, duration: duration, verified: "page-controls" };
    } catch (error) {
      return { ok: false, code: error.code || "prepare_failed", reason: String(error && error.message || error), diagnostics: {
        phase: phase, readyState: document.readyState, editorFound: !!editor(), videoEntryFound: !!videoEntry(),
        modelControl: modelName(modelButton()), durationControl: durationOf(durationButton()),
        openMenus: nodes('[role="menu"], [role="dialog"]').length
      } };
    }
  };
})();
