// Operate Doubao's own sidebar drafts. Local records only identify saved rows.
(function () {
  var api = window[CFG.autoKey];
  if (!api) return;
  var preparedAt = 0, inputScope = "";
  var storedBindings = new Map();
  var importEpoch = 0;
  var sendAttachmentProof = null;
  var captchaFrames = new WeakMap(), captchaEpoch = 0, captchaDocumentId = "";
  api.readNativeDeliveryState = function (point) {
    var mask = Array.from(document.querySelectorAll('#captcha_container')).some(visible);
    var frames = Array.from(document.querySelectorAll('iframe[src*="/verifycenter/captcha"]')).filter(visible);
    if (!frames.length) return { captchaDetected: mask };
    if (frames.length !== 1) return { captchaDetected: true };
    var frame = frames[0], rect = frame.getBoundingClientRect(), style = getComputedStyle(frame);
    var width = window.innerWidth || document.documentElement.clientWidth, height = window.innerHeight || document.documentElement.clientHeight;
    if (style.opacity === "0" || rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 || rect.right > width || rect.bottom > height) return { captchaDetected: true };
    var inset = Math.min(3, rect.width / 4, rect.height / 4);
    var points = [[rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset], [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset], [rect.left + rect.width / 2, rect.top + rect.height / 2]];
    if (points.some(function (point) { return document.elementFromPoint(point[0], point[1]) !== frame; })) return { captchaDetected: true };
    if (point && (![point.x, point.y].every(Number.isFinite) || point.x < rect.left || point.y < rect.top || point.x >= rect.right || point.y >= rect.bottom || document.elementFromPoint(point.x, point.y) !== frame)) return { captchaDetected: true };
    var src = frame.getAttribute("src") || "", known = captchaFrames.get(frame);
    if (!known || known.src !== src) {
      if (!window.crypto || typeof window.crypto.randomUUID !== "function") return { captchaDetected: true };
      if (!captchaDocumentId) captchaDocumentId = window.crypto.randomUUID();
      known = { src: src, id: "captcha-" + captchaDocumentId + "-" + (++captchaEpoch) }; captchaFrames.set(frame, known);
    }
    return { captchaDetected: true, captcha: { id: known.id, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, focused: document.activeElement === frame } };
  };
  function text(el) { return String(el && (/^(TEXTAREA|INPUT)$/.test(el.tagName) ? el.value : el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim(); }
  function editor() { return document.querySelector('#input-engine-container .tiptap[contenteditable="true"], #input-engine-container textarea, .tiptap.ProseMirror[contenteditable="true"]'); }
  function title(row) { return text(row.querySelector(":scope > span > span")); }
  function rows() { return Array.from(document.querySelectorAll('[data-testid="draft-conversation-section"] > [role="button"][class~="group/conversation-item"]')).filter(function (r) { return title(r) && !/^新(?:对话|對話)$/.test(title(r)); }); }
  // Only UI labels are canonicalized; prompts and persisted draft content stay exact.
  function cloudLabel(value) { return /^(?:云(?:端)?电脑|雲(?:端)?電腦)\s*[>›»]?$/.test(value); }
  function cloudModeNode(node) {
    return node && (cloudLabel(text(node)) || (node.querySelectorAll && Array.from(node.querySelectorAll("*")).some(function (child) {
      return (!child.children || !child.children.length) && visible(child) && cloudLabel(text(child));
    })));
  }
  function mode() { var node = document.querySelector('#input-engine-container [data-testid="chat_input_action_mode"]'); return cloudModeNode(node) ? "云电脑" : text(node); }
  function sendButton() { return document.querySelector('button[data-testid="chat_input_send_button"]'); }
  function enabled(button) { return button && !button.disabled && !["aria-disabled", "aria-busy", "data-disabled", "data-loading"].some(function (attr) { return button.getAttribute(attr) === "true"; }); }
  function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function visible(el) {
    if (!el || el.isConnected === false || el.hidden) return false;
    if (el.closest && el.closest('[hidden], [aria-hidden="true"]')) return false;
    if (el.getClientRects && !el.getClientRects().length) return false;
    if (typeof getComputedStyle === "function") {
      var style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function visibleNodes(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter(visible);
  }
  function selected(row) {
    if (!row || row.isConnected === false) return false;
    if (row.getAttribute) {
      var aria = row.getAttribute("aria-selected");
      if (aria !== null) return aria === "true";
      var current = row.getAttribute("aria-current"), state = row.getAttribute("data-state");
      if (current === "page" || current === "true" || state === "selected") return true;
    }
    return row.classList && row.classList.contains("bg-dbx-bg-float");
  }
  function readiness(options) {
    var reasons = [], row = rowFor(options.id);
    if (!row || row.isConnected === false) reasons.push("对应原生草稿条目尚未挂载");
    else if (!selected(row)) reasons.push("对应原生草稿尚未选中");
    var editors = visibleNodes(document, '#input-engine-container .tiptap[contenteditable="true"], #input-engine-container textarea, .tiptap.ProseMirror[contenteditable="true"]');
    var current = editors.length === 1 ? editors[0] : null;
    if (!current) reasons.push(editors.length ? "存在多个可见输入框，无法确认当前草稿输入区" : "当前草稿输入框尚未挂载");
    var root = current && current.closest && current.closest("#input-engine-container") || document;
    var prompt = current ? text(current) : "", rich = current && current.editor;
    if (current && current.pmViewDesc && current.pmViewDesc.node && current.pmViewDesc.node.toJSON) prompt = importText(current);
    else if (rich && typeof rich.getText === "function") {
      try { prompt = rich.isDestroyed ? "" : normalize(rich.getText()); } catch (_) { prompt = ""; }
    }
    if (current && (!normalize(options.prompt) || prompt !== normalize(options.prompt))) reasons.push("完整提示词不一致（预期 " + normalize(options.prompt).length + " 字，当前 " + prompt.length + " 字）");
    var modes = visibleNodes(root, '[data-testid="chat_input_action_mode"]'), modeNode = modes.length === 1 ? modes[0] : null;
    var isWork = cloudModeNode(modeNode);
    if (options.executionMode === "work" && !isWork) reasons.push("工作模式未就绪（当前：" + (modeNode ? text(modeNode).slice(0, 40) : "模式标签未唯一加载") + "）");
    var uploading = root.querySelectorAll('[aria-busy="true"], [data-loading="true"], [role="progressbar"], progress');
    if (Array.from(uploading).some(function (node) {
      if (!visible(node)) return false;
      if (node.getAttribute("aria-busy") === "true" || node.getAttribute("data-loading") === "true") return true;
      var now = node.tagName === "PROGRESS" ? node.value : node.getAttribute("aria-valuenow");
      var max = node.tagName === "PROGRESS" ? node.max : node.getAttribute("aria-valuemax");
      return now === null || now === "" || !Number.isFinite(Number(now)) || Number(now) < (Number(max) || 100);
    })) reasons.push("输入区素材仍在上传或加载");
    var buttons = visibleNodes(root, 'button[data-testid="chat_input_send_button"]'), button = buttons.length === 1 ? buttons[0] : null;
    if (!button) reasons.push("发送按钮尚未唯一加载");
    else if (!enabled(button) || button.getAttribute("data-disabled") === "" || button.getAttribute("data-loading") === "") reasons.push("发送按钮仍不可用（可能仍在上传素材）");
    var attachmentSignature = null;
    // Undefined keeps legacy text callers compatible. An explicit [] is an
    // exact empty manifest and must reject attachments left in the composer.
    if (options.attachmentNames !== undefined) {
      if (!Array.isArray(options.attachmentNames)) reasons.push("预期附件清单无效，尚未确认附件就绪");
      else {
        var cards = importCards(), names = cards.map(function (card) { return card.name; });
        if (!sameNames(names, options.attachmentNames)) reasons.push("附件清单不一致（预期 " + options.attachmentNames.length + " 个，当前 " + cards.length + " 个；名称和顺序必须完全一致）");
        if (cards.some(function (card) { return card.failed; })) reasons.push("草稿附件上传失败");
        else if (cards.some(function (card) { return !card.ready; })) reasons.push("草稿附件尚未全部上传就绪（需当前状态Normal、fileKey和正确fileName）");
        attachmentSignature = JSON.stringify(cards.map(function (card) { return [card.name, card.fileKey]; }));
      }
    }
    return { reasons: reasons, editor: current, button: button, attachmentSignature: attachmentSignature };
  }
  function numberIn(value) {
    var body = normalize(value).replace(/^\[Seedance 2\.5\]\(skill:\/\/seedance-25\?type=2&id=353376777986\)\s*/, "");
    var match = body.match(/^【草稿编号：(DB-[0-9A-F]{24})】/); return match && match[1];
  }
  function rowDraft(row) {
    // The native row keeps the complete record even when its label is ellipsized.
    var fiber = row && row[Object.keys(row).find(function (key) { return key.startsWith("__reactFiber$"); })];
    for (var i = 0; fiber && i < 6; i++, fiber = fiber.return) {
      var props = fiber.memoizedProps;
      if (props && props.draft && props.draft.inputDraftIndex) return props.draft;
    }
    return null;
  }
  async function expandDrafts() {
    var section = document.querySelector('[data-testid="draft-conversation-section"]');
    if (!section) return;
    if (!rows().length) {
      var header = section.querySelector(':scope > [role="button"][class~="group/section-header"]');
      if (header) { header.click(); await wait(function () { return rows().length; }, "豆包草稿列表尚未展开"); }
    }
    var more = section.querySelector(':scope > button[aria-expanded="false"]');
    if (more) {
      var count = rows().length;
      more.click();
      await wait(function () { return !more.isConnected || rows().length > count; }, "豆包隐藏草稿尚未展开");
    }
  }
  async function readStore(database, storeName, key) {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(database), db, settled = false;
      var timer = setTimeout(function () { finish(new Error("读取豆包完整草稿数据超时")); }, 5000);
      function finish(error, value) {
        if (settled) return; settled = true; clearTimeout(timer);
        if (db) db.close();
        error ? reject(error) : resolve(value);
      }
      request.onupgradeneeded = function () { request.transaction.abort(); };
      request.onerror = function () { finish(new Error("无法读取豆包草稿数据库，请刷新账号页面")); };
      request.onblocked = function () { finish(new Error("豆包草稿数据库正被占用，请稍后重试")); };
      request.onsuccess = function () {
        db = request.result;
        if (settled) { db.close(); return; }
        try {
          var tx = db.transaction(storeName, "readonly"), store = tx.objectStore(storeName);
          var read = key === undefined ? store.getAll() : store.get(key), value;
          read.onsuccess = function () { value = read.result; };
          tx.oncomplete = function () { finish(null, value); };
          tx.onabort = tx.onerror = function () { finish(new Error("豆包草稿数据读取失败")); };
        } catch (error) { finish(error); }
      };
    });
  }
  async function catalog(strictReadOnly) {
    // Older pages may not use this store. Never create or modify a website DB.
    if (typeof indexedDB === "undefined" || !indexedDB.databases) return null;
    var databases = await indexedDB.databases();
    if (!databases.some(function (db) { return db.name === "flow-draft-conversations-v2"; })) return null;
    var records = await readStore("flow-draft-conversations-v2", "drafts");
    // The site's current user ID remains available when the sidebar is hidden
    // or omitted for an empty draft store. Do not infer it from historical rows.
    var identity = "";
    try { identity = String(localStorage.getItem("flow_tea_user_id") || "").trim(); } catch (_) {}
    var scopes = new Set(rows().map(rowDraft).filter(Boolean).map(function (d) { return d.inputDraftIndex.accountScope; }));
    if (identity) scopes.add(identity);
    if (!strictReadOnly && !scopes.size && document.querySelector('[data-testid="draft-conversation-section"]')) {
      await expandDrafts();
      rows().map(rowDraft).filter(Boolean).forEach(function (d) { scopes.add(d.inputDraftIndex.accountScope); });
    }
    if (scopes.size > 1 || (!scopes.size && records.length)) throw new Error("无法确认当前豆包账号的草稿数据，请打开账号草稿列表后重试");
    var scope = Array.from(scopes)[0];
    records = records.filter(function (r) { return !r.deleted && r.accountScope === scope && r.data && r.data.id === r.id && r.data.inputDraftIndex && r.data.inputDraftIndex.accountScope === scope; });
    if (!records.length) return { items: [], accountScope: scope };
    var input = await readStore("samantha-web", "store", "input-engine-draft:v3:account:" + encodeURIComponent(scope));
    if (!input || !input.state || input.state.accountScope !== scope || !Array.isArray(input.state.records)) throw new Error("豆包完整草稿正文尚未加载，请刷新账号页面后重试");
    return { accountScope: scope, items: records.map(function (r) {
      var index = r.data.inputDraftIndex;
      var document = input.state.records.find(function (p) { return p.address && p.address.accountScope === scope && p.address.conversationScope === index.conversationScope && p.address.inputId === index.inputId; });
      var unit = document && document.units && document.units["input.document"], payload = unit && !unit.tombstone && unit.payload;
      var prompt = payload && (payload.format === "plain-text" ? payload.text : payload.plainTextFallback);
      return { nativeId: r.id, accountScope: scope, title: r.data.title, prompt: typeof prompt === "string" ? prompt : null, executionMode: r.data.scene === "new-office-task" ? "work" : "chat" };
    }) };
  }
  function candidatesFor(binding) {
    return rows().filter(function (row) {
      var label = title(row);
      if (!binding.draftNumber) return label === binding.title;
      var number = numberIn(label);
      if (number) return number === binding.draftNumber;
      // A shortened sidebar label only selects candidates; the full editor
      // content must still match the complete number and prompt before sending.
      var prefix = label.replace(/[.…]+$/, "");
      return prefix && ("【草稿编号：" + binding.draftNumber + "】").startsWith(prefix);
    });
  }
  function switchTo(work) {
    var prefix = work ? /^新工作任[务務](?:\s|$)/ : /^新(?:对话|對話)(?:\s|$)/;
    var button = Array.from(document.querySelectorAll('button, [role="button"]')).find(function (b) { return prefix.test(text(b)); });
    if (!button) throw new Error("未找到" + (work ? "新工作任务" : "新对话") + "入口");
    button.click();
  }
  async function wait(read, message, deadline) {
    var end = deadline || Date.now() + 20000;
    while (Date.now() < end) { var result = await read(); if (result) return result; await new Promise(function (r) { setTimeout(r, 100); }); }
    throw new Error(typeof message === "function" ? message() : message);
  }
  function snapshot() {
    var current = rows(), titles = current.map(title);
    current.filter(function (r) { return r.dataset.dmDraftId; }).forEach(function (r) {
      var native = rowDraft(r), binding = { id: r.dataset.dmDraftId, index: current.indexOf(r), title: title(r), titles: titles };
      if (native) Object.assign(binding, { nativeId: native.id, accountScope: native.inputDraftIndex.accountScope });
      storedBindings.set(binding.id, binding);
    });
    return Array.from(storedBindings.values()).filter(function (binding) { return rowFor(binding.id); });
  }
  function rowFor(id) {
    var binding = storedBindings.get(id);
    return rows().find(function (r) {
      if (!binding || !binding.nativeId) return r.dataset.dmDraftId === id;
      var native = rowDraft(r);
      return native && native.id === binding.nativeId && native.inputDraftIndex.accountScope === binding.accountScope;
    });
  }
  function revealDrafts(clicked, sectionOnly) {
    // The Drafts heading can be collapsed; its expanded list initially shows
    // only five rows. Never click a conversation or its menu to reveal more.
    var section = document.querySelector('[data-testid="draft-conversation-section"]');
    var controls = sectionOnly ? [] : Array.from(document.querySelectorAll('button, [role="button"]'));
    if (section) controls = controls.concat(Array.from(section.querySelectorAll('button, [role="button"]')));
    var button = controls.find(function (el) {
      var label = text(el);
      if (sectionOnly && el.closest && el.closest('[class~="group/conversation-item"]')) return false;
      return !clicked.has(el) && enabled(el) && (!el.getClientRects || el.getClientRects().length) &&
        (/^展开更多草稿$/.test(label) || (!rows().length && /^草稿(?:\s*对话列表设置)?$/.test(label)));
    });
    if (button) { clicked.add(button); button.click(); return true; }
    // Load older rows in the draft area or its sidebar scroll container.
    for (var node = section, depth = 0; node && depth < 6 && node !== document.body; node = node.parentElement, depth++) {
      if (node.scrollHeight > node.clientHeight + 2 && node.clientHeight > 0) {
        var top = node.scrollTop || 0, next = Math.min(node.scrollHeight - node.clientHeight, top + node.clientHeight * 0.8);
        if (next > top + 1) { node.scrollTo({ top: next, behavior: "instant" }); return true; }
      }
    }
    return false;
  }
  function result(fn) { return async function () { try { return await fn.apply(null, arguments); } catch (e) { return { ok: false, reason: String(e.message || e) }; } }; }
  api.readNativeDrafts = result(async function (options) {
    var data = await catalog(Boolean(options && options.strictReadOnly));
    return { ok: true, source: data ? "indexeddb" : "sidebar", accountScope: data && data.accountScope, items: data ? data.items : [], total: data ? data.items.length : rows().length };
  });
  async function savedDraft(options) {
    var data = await catalog(Boolean(options.strictReadOnly)), number = numberIn(options.prompt);
    if (!data || !data.accountScope || (!number && !(options.nativeId && options.accountScope && !options.strictReadOnly))) return null;
    if (options.accountScope && options.accountScope !== data.accountScope) throw new Error("当前豆包账号与保存草稿的账号不一致");
    var matches = data.items.filter(function (d) { return number ? numberIn(d.prompt) === number : d.nativeId === options.nativeId && d.accountScope === options.accountScope; });
    if (matches.length > 1) throw new Error("发现重复草稿编号 " + number + "，请核对网页草稿");
    if (!matches.length) return null;
    var match = matches[0];
    if (options.nativeId && match.nativeId !== options.nativeId) throw new Error("原生草稿 ID 已变化，未重绑或重复导入");
    if (normalize(match.prompt) !== normalize(options.prompt) || match.executionMode !== options.executionMode) {
      if (options.waitForPersistence) return { pending: true };
      throw new Error("已保存草稿的完整正文或工作模式不一致，请核对网页草稿");
    }
    var binding = { id: options.id, nativeId: match.nativeId, accountScope: data.accountScope, title: match.title, index: data.items.indexOf(match), titles: data.items.map(function (d) { return d.title; }) };
    if (!options.strictReadOnly) storedBindings.set(binding.id, binding);
    return { ok: true, bindings: [binding] };
  }
  api.verifyNativeDraftSaved = result(async function (options) {
    var saved = await savedDraft(Object.assign({}, options, { strictReadOnly: true }));
    if (!saved) throw new Error("完整存储中未找到同编号、同正文的草稿；不会重复存入，请在原账号页面核对");
    return Object.assign(saved, { readOnly: true });
  });
  // Import completion is stronger than a usable send button: every expected
  // attachment must be uploaded, then persisted under this exact draft address.
  function currentImportFiber(fiber) {
    if (!fiber || !fiber.alternate) return fiber;
    function root(node) { while (node.return) node = node.return; return node; }
    var a = root(fiber), current = a.stateNode && a.stateNode.current;
    if (!current) return null;
    // React can reuse children without updating return pointers, even across
    // different roots. Only child/sibling reachability proves committed state.
    var pending = [current];
    while (pending.length) {
      var node = pending.pop();
      if (node === fiber || node === fiber.alternate) return node;
      if (node.sibling) pending.push(node.sibling);
      if (node.child) pending.push(node.child);
    }
    return null;
  }
  function importCards() {
    return Array.from(document.querySelectorAll('#input-engine-container [data-testid="attachment_area"] [data-kind][aria-label]')).filter(visible).map(function (card) {
      var fiber = card[Object.keys(card).find(function (key) { return key.startsWith("__reactFiber$"); })], state;
      for (var i = 0; fiber && i < 6; i++, fiber = fiber.return) {
        if (fiber.memoizedProps && fiber.memoizedProps.attachmentState) {
          fiber = currentImportFiber(fiber);
          state = fiber && fiber.memoizedProps && fiber.memoizedProps.attachmentState;
          break;
        }
      }
      return { name: card.getAttribute("aria-label"), fileKey: state && state.fileKey || "", ready: !!(state && state.fileKey && state.status === "Normal" && state.fileName === card.getAttribute("aria-label")), failed: !!(state && /error|fail/i.test(state.status || "")) };
    });
  }
  function sameNames(actual, expected) { return JSON.stringify(actual) === JSON.stringify(expected); }
  function importEditor() {
    var candidates = Array.from(document.querySelectorAll('#input-engine-container .tiptap[contenteditable="true"], #input-engine-container textarea'));
    var current = candidates.find(function (node) { return (node.tagName === "TEXTAREA" || node.getAttribute && node.getAttribute("contenteditable") === "true") && visible(node); }) || editor();
    return visible(current) ? current : null;
  }
  function importText(el) {
    el = el || importEditor();
    var node = el && el.pmViewDesc && el.pmViewDesc.node;
    if (!node || !node.toJSON) return text(el);
    // Restored skill links are mentions. Preserve their identity, not just label.
    function content(n) {
      if (n.type === "text") return n.text || "";
      if (n.type === "hardBreak") return "\n";
      if (n.type === "mention") {
        var a = n.attrs || {};
        if (a.mentionType !== "skill" || !a.label || !a.skillId || a.skill_type == null || !a.external_skill_id) return "\uFFFD";
        return "[" + a.label + "](skill://" + a.skillId + "?type=" + a.skill_type + "&id=" + a.external_skill_id + ")";
      }
      return (n.content || []).map(content).join(n.type === "paragraph" ? "" : "\n");
    }
    return normalize(content(node.toJSON()));
  }
  api.pasteNativeDraftFiles = result(async function (items, options) {
    var epoch = importEpoch, el = importEditor(), root = el && el.closest && el.closest("#input-engine-container");
    function checkComposer() {
      checkImport(epoch);
      if (importText() !== normalize(options.prompt)) throw new Error("上传期间草稿正文已变化，未继续上传");
      el = importEditor();
      root = el && el.closest && el.closest("#input-engine-container");
      if (!root) throw new Error("当前草稿输入区尚未加载，未继续上传");
      if (options.executionMode === "work" && mode() !== "云电脑") throw new Error("草稿工作模式已变化，未继续上传");
    }
    if (!el || !root) throw new Error("当前草稿输入区尚未加载，未上传附件");
    checkComposer();
    // A new work task initially exposes a guidance textarea. Focusing mounts
    // the rich editor and its upload handlers; a paste on the old node is lost.
    if (typeof el.focus === "function") el.focus();
    await wait(function () {
      checkImport(epoch);
      var current = importEditor(), currentRoot = current && current.closest && current.closest("#input-engine-container");
      if (!currentRoot || importText() !== normalize(options.prompt)) return false;
      var rich = current.classList && current.classList.contains("ProseMirror");
      if (!rich && !currentRoot.querySelectorAll('input[type="file"]').length) return false;
      el = current; root = currentRoot; return true;
    }, "草稿附件输入区尚未激活，已保留正文，未上传图片", Date.now() + 20000);
    checkComposer();
    var before = importCards().map(function (card) { return card.name; });
    if (items.some(function (item) { return before.includes(item.name); })) throw new Error("输入区已存在待上传的同名附件，请核对原草稿，未重复上传");
    var files = items.map(function (item) {
      var match = /^data:([^;,]+);base64,(.*)$/.exec(String(item.dataUrl || ""));
      if (!match) throw new Error("草稿附件数据无效：" + item.name);
      var binary = atob(match[2]), bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], item.name, { type: match[1] });
    });
    var transfer = new DataTransfer();
    files.forEach(function (file) { transfer.items.add(file); });
    // Other composers can retain file controls during a route transition.
    // Only the verified composer may receive these files.
    var input = Array.from(root.querySelectorAll('input[type="file"]')).find(function (node) {
      if (node.disabled || (files.length > 1 && !node.multiple)) return false;
      var accept = String(node.getAttribute("accept") || "").toLowerCase().split(",").map(function (value) { return value.trim(); });
      return files.every(function (file) { return accept.some(function (value) { return !value || value === "*/*" || value === "." + file.name.split(".").pop().toLowerCase() || value === file.type || value === file.type.split("/")[0] + "/*"; }); });
    });
    checkComposer();
    if (input) {
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      var event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
      if (!event.clipboardData || !event.clipboardData.items.length) Object.defineProperty(event, "clipboardData", { value: transfer });
      el.dispatchEvent(event);
    }
    await wait(function () {
      checkComposer();
      return sameNames(importCards().map(function (card) { return card.name; }), options.attachmentNames);
    }, function () { return "网页接收附件未完成：当前 " + importCards().length + "/" + options.attachmentNames.length + " 个，原草稿已保留"; }, Date.now() + 15000);
    return { ok: true, count: files.length };
  });
  function checkImport(epoch) { if (epoch !== importEpoch) throw new Error("草稿导入已停止，未继续切换页面"); }
  async function persistedImportAttachments(binding) {
    var drafts = await readStore("flow-draft-conversations-v2", "drafts");
    var draft = drafts.find(function (d) { return !d.deleted && d.id === binding.nativeId && d.accountScope === binding.accountScope; });
    var index = draft && draft.data && draft.data.inputDraftIndex;
    if (!index || index.accountScope !== binding.accountScope) throw new Error("无法确认原草稿的附件归属，未重复导入");
    var input = await readStore("samantha-web", "store", "input-engine-draft:v3:account:" + encodeURIComponent(index.accountScope));
    if (!input || !input.state || input.state.accountScope !== index.accountScope || !Array.isArray(input.state.records)) throw new Error("草稿附件存储尚未加载");
    var record = input.state.records.find(function (r) { return r.address && r.address.accountScope === index.accountScope && r.address.conversationScope === index.conversationScope && r.address.inputId === index.inputId; });
    if (!record) throw new Error("原草稿完整记录尚未加载");
    var unit = record.units && record.units["input.attachments"], payload = unit && !unit.tombstone && unit.payload;
    if (!payload) return [];
    if (!Array.isArray(payload.items)) throw new Error("无法识别草稿附件记录，未继续导入");
    return payload.items;
  }
  api.cancelNativeDraftImport = function () { importEpoch++; return { ok: true }; };
  async function confirmInterruptedImportMissing(options) {
    var data = await catalog(), number = numberIn(options.prompt);
    if (!data || !data.accountScope || !number || data.items.some(function (d) { return d.prompt === null; })) throw new Error("无法完整核对账号草稿，未重新导入，请等待页面加载完成后重试");
    if (options.accountScope && data.accountScope !== options.accountScope) throw new Error("当前豆包账号与原草稿账号不一致，未重新导入");
    if (data.items.some(function (d) { return numberIn(d.prompt) === number; })) throw new Error("原草稿刚刚保存，请重新核对，未重复导入");
    var input = await readStore("samantha-web", "store", "input-engine-draft:v3:account:" + encodeURIComponent(data.accountScope));
    if (!input || !input.state || input.state.accountScope !== data.accountScope || !Array.isArray(input.state.records)) throw new Error("未能核对网页输入记录，未重新导入");
    for (var record of input.state.records) {
      if (!record.address || record.address.accountScope !== data.accountScope) throw new Error("网页输入记录归属不明，未重新导入");
      var unit = record.units && record.units["input.document"], payload = unit && !unit.tombstone && unit.payload;
      if (unit && unit.tombstone) continue;
      if (!unit) {
        var attachments = record.units && record.units["input.attachments"];
        if (attachments && !attachments.tombstone && (!attachments.payload || !Array.isArray(attachments.payload.items) || attachments.payload.items.length)) throw new Error("网页残留附件的正文不明，无法确认缺失，未重新导入");
        continue;
      }
      var prompt = payload && (payload.format === "plain-text" ? payload.text : payload.plainTextFallback);
      if (typeof prompt !== "string") throw new Error("网页仍有未能识别的输入记录，无法确认缺失，未重新导入");
      if (prompt.includes(number)) throw new Error("原草稿仍保留在网页输入记录中，请恢复原输入区后核对；未新建重复草稿");
    }
    if (String(localStorage.getItem("flow_tea_user_id") || "").trim() !== data.accountScope) throw new Error("核对期间豆包账号已变化，未重新导入");
    if (!editor() || importText() || importCards().length) throw new Error("请先打开空白工作任务输入区，再恢复中断草稿；未覆盖当前内容");
    return { ok: true, restart: true, accountScope: data.accountScope };
  }
  api.verifyNativeDraftMissing = result(async function (options) {
    var missing = await confirmInterruptedImportMissing(options);
    return { ok: true, readOnly: true, absent: true, accountScope: missing.accountScope };
  });
  api.resumeNativeDraftImport = result(async function (options) {
    var epoch = importEpoch, expected = options.attachmentNames || [], verified = await savedDraft(options);
    checkImport(epoch);
    if (options.nativeId && !verified) {
      if (options.recreateDeleted === true) {
        var missingBound = await confirmInterruptedImportMissing(options); checkImport(epoch); return missingBound;
      }
      throw new Error("未找到原草稿，未新建或重复导入；如已删除，请使用重新存入恢复");
    }
    var persisted = verified ? await persistedImportAttachments(verified.bindings[0]) : [];
    if (verified && sameNames(persisted.map(function (a) { return a.fileName; }), expected) && persisted.every(function (a) { return !!a.fileKey; })) return { ...verified, complete: true, missingNames: [] };
    if (!verified) {
      await wait(function () { checkImport(epoch); return editor(); }, "账号输入区尚未加载，请打开工作任务页面后重试");
      if (importText() !== normalize(options.prompt)) {
        if (options.recreateDeleted === true) {
          var missing = await confirmInterruptedImportMissing(options); checkImport(epoch); return missing;
        }
        throw new Error("上次导入已中断，当前输入区已变化；请点击“恢复中断/缺失草稿”核对后继续，未重复导入");
      }
    }
    var uploading = !verified;
    if (verified) {
      await expandDrafts();
      var clicked = new Set(), revealAt = 0;
      var row = await wait(function () {
        checkImport(epoch);
        var found = rowFor(options.id);
        if (!found && Date.now() - revealAt >= 600) { revealAt = Date.now(); revealDrafts(clicked, true); }
        return found;
      }, "原草稿尚未显示，未新建重复草稿");
      checkImport(epoch); uploading = !options.isolated && selected(row);
      if (!selected(row)) row.click();
    }
    var stableAt = 0, previous = "";
    var cards = await wait(function () {
      checkImport(epoch);
      if (importText() !== normalize(options.prompt) || (options.executionMode === "work" && mode() !== "云电脑")) return false;
      if (verified && !selected(rowFor(options.id))) return false;
      var current = importCards(), names = current.map(function (a) { return a.name; });
      // An active or unpersisted draft's earlier upload may still be mounting.
      // Wait for its complete manifest; never infer missing files and re-upload.
      if (uploading && !sameNames(names, expected)) return false;
      if (names.length < persisted.length) return false;
      var signature = JSON.stringify(names);
      if (signature !== previous) { previous = signature; stableAt = Date.now(); }
      if (!stableAt) stableAt = Date.now();
      return Date.now() - stableAt >= 600 ? current : false;
    }, "原草稿正文或附件仍在加载，未重复上传", Date.now() + 60000);
    if (!sameNames(cards.map(function (a) { return a.name; }), expected.slice(0, cards.length))) throw new Error("原草稿附件顺序或名称不一致，请核对；未覆盖或重复导入");
    if (cards.some(function (a) { return a.failed; })) throw new Error("原草稿存在上传失败的附件，请在网页重试该附件后继续导入");
    inputScope = verified ? verified.bindings[0].accountScope : String(localStorage.getItem("flow_tea_user_id") || "").trim();
    preparedAt = Date.now();
    return { ok: true, complete: false, missingNames: expected.slice(cards.length), bindings: verified ? verified.bindings : [] };
  });
  api.parkNativeDraftImport = result(async function (options) {
    if (!options.isolated) throw new Error("仅允许保留本条独立处理页中的草稿");
    var saved = await savedDraft(options);
    if (saved) return saved;
    if (importText() !== normalize(options.prompt) || (options.executionMode === "work" && mode() !== "云电脑")) throw new Error("未确认失败草稿正文归属，已保留本地记录");
    ++importEpoch;
    switchTo(options.executionMode !== "work");
    return await wait(function () { return savedDraft(options); }, "失败草稿的网页保存结果待核对，本地正文和附件已保留", Date.now() + 10000);
  });
  api.restoreNativeDrafts = result(async function (bindings, options) {
    bindings = bindings || [];
    var data = options && options.catalog;
    if (data) {
      // The batch reads once in the account page. Each sender must still be in
      // that account, and opening/sending rechecks the exact ID and full body.
      var identity = "";
      try { identity = String(localStorage.getItem("flow_tea_user_id") || "").trim(); } catch (_) {}
      if (!identity || identity !== data.accountScope) throw new Error("当前投递页面的豆包账号与草稿账号不一致，未触发发送");
    } else data = bindings.length ? await catalog() : null;
    if (data) {
      if (bindings.some(function (b) { return b.accountScope && data.accountScope && b.accountScope !== data.accountScope; })) throw new Error("当前登录的豆包账号与原草稿账号不一致，请切回原账号");
      if (options && options.allowMissing && bindings.some(function (b) { return b.accountScope; }) && !data.accountScope) throw new Error("尚未确认当前豆包账号，不能重新存入草稿，请等待账号登录完成");
      var full = data.items, resolved = [], missingIds = [], usedIds = new Set(), titles = full.map(function (d) { return d.title; });
      for (var binding of bindings) {
        var matches = full.filter(function (d) { return binding.draftNumber ? numberIn(d.prompt) === binding.draftNumber : normalize(d.prompt) === normalize(binding.prompt); });
        if (binding.draftNumber && matches.length > 1) throw new Error("发现重复草稿编号 " + binding.draftNumber + "，未触发发送，请核对网页草稿");
        var original = binding.nativeId && full.find(function (d) { return d.nativeId === binding.nativeId && d.accountScope === binding.accountScope; });
        if (!matches.length && !original) {
          if (full.some(function (d) { return d.prompt === null; })) throw new Error("部分豆包草稿正文尚未完整加载，不能确认原草稿是否缺失，请刷新后重试");
          missingIds.push(binding.id); continue;
        }
        if (binding.nativeId) matches = matches.filter(function (d) { return d.nativeId === binding.nativeId && d.accountScope === binding.accountScope; });
        if (matches.length !== 1) throw new Error("完整草稿数据中未找到唯一对应的任务，请核对编号或原生草稿 ID，未触发发送");
        var match = matches[0];
        if (!match.prompt || normalize(match.prompt) !== normalize(binding.prompt) || match.executionMode !== binding.executionMode || usedIds.has(match.nativeId)) throw new Error("豆包草稿完整正文或模式与本地记录不一致，未触发发送");
        usedIds.add(match.nativeId);
        resolved.push({ id: binding.id, nativeId: match.nativeId, accountScope: match.accountScope, title: match.title, index: full.indexOf(match), titles: titles });
      }
      if (missingIds.length && !(options && options.allowMissing)) throw new Error("豆包网页中已找不到所选的 " + missingIds.length + " 条草稿，本地提示词和素材已保留。请点击「恢复中断/缺失草稿」重新存入缺失草稿");
      resolved.forEach(function (b) { storedBindings.set(b.id, b); });
      return { ok: true, source: "indexeddb", total: full.length, bindings: resolved, missingIds: missingIds };
    }
    if (options && options.allowMissing) throw new Error("当前豆包页面不支持完整草稿核对，不能确认哪些草稿已删除，请打开账号页面检查");
    await wait(editor, "豆包输入区尚未加载", Date.now() + 60000);
    await expandDrafts();
    // Truncated labels require checking each full prompt (600ms stable per row).
    // Keep the list-load limit at 20s, but allow the existing 60s preparation
    // budget for large candidate sets instead of cutting off after 33 rows.
    var previous = "", stableAt = Date.now(), revealAt = 0, revealing = false, clicked = new Set(), deadline = Date.now() + 60000;
    if (bindings.length) await wait(function () {
      var current = rows(), signature = JSON.stringify(current.map(title));
      if (signature !== previous) { previous = signature; stableAt = Date.now(); }
      var found = bindings.every(function (b) { return candidatesFor(b).length; });
      var shortened = bindings.some(function (b) { return b.draftNumber && !candidatesFor(b).some(function (r) { return numberIn(title(r)) === b.draftNumber; }); });
      if ((!found || shortened) && Date.now() - revealAt >= 600) { revealAt = Date.now(); revealing = revealDrafts(clicked); }
      return found && (!shortened || !revealing) && Date.now() - stableAt >= 600;
    }, "未找到所选豆包草稿，可能尚未同步或已被移除，请在账号页面核对后重试", Date.now() + 20000);
    var used = new Set(), mapped = [];
    for (var binding of bindings) {
      var row = await wait(async function () {
        var candidates = candidatesFor(binding);
        if (!candidates.length) { revealDrafts(clicked); return null; }
        var exact = candidates.filter(function (r) { return numberIn(title(r)) === binding.draftNumber; });
        if (binding.draftNumber && exact.length > 1) throw new Error("发现重复草稿编号 " + binding.draftNumber + "，未触发发送，请核对网页草稿");
        if (binding.draftNumber && !exact.length && revealDrafts(clicked)) return null;
        var matched = rowFor(binding.id);
        if (matched && (!candidates.includes(matched) || (binding.draftNumber && candidates.length > 1))) matched = null;
        if (matched) return matched;
        if (candidates.length === 1 && (!binding.draftNumber || exact.length)) return candidates[0];
        {
          // Sidebar order is not an identity: other tabs can add or reorder drafts.
          // Equal sidebar titles must be resolved by the complete saved prompt.
          if (!normalize(binding.prompt)) throw new Error("多条草稿标题相同，缺少完整提示词，无法确认原草稿");
          var matches = [], numberMatches = 0;
          for (var candidate of candidates) {
            if (!candidate.isConnected) return null;
            candidate.click();
            var lastContent = "", contentAt = Date.now();
            await wait(function () {
              var content = text(editor()) + "\n" + mode();
              if (content !== lastContent) { lastContent = content; contentAt = Date.now(); }
              return !candidate.isConnected || (candidate.classList.contains("bg-dbx-bg-float") && text(editor()) && Date.now() - contentAt >= 600);
            }, "草稿内容尚未加载，未触发发送，请重试", deadline);
            if (!candidate.isConnected) return null;
            if (binding.draftNumber && numberIn(text(editor())) === binding.draftNumber) numberMatches++;
            if (text(editor()) === normalize(binding.prompt) && (binding.executionMode !== "work" || mode() === "云电脑")) matches.push(candidate);
          }
          if (numberMatches > 1) throw new Error("发现重复草稿编号 " + binding.draftNumber + "，未触发发送，请核对网页草稿");
          if (matches.length > 1) throw new Error("多条豆包草稿的完整提示词相同，无法区分附件归属；请在账号页面核对并区分这些草稿后重试");
          if (matches[0]) return matches[0];
        }
        // Lazy rows may have arrived while we inspected the earlier candidates.
        // Re-enumerate on the next poll until the shared deadline, never guess.
        revealDrafts(clicked);
        return null;
      }, "未找到与所选任务完整内容对应的豆包草稿，未触发发送，请在账号页面核对", deadline);
      if (used.has(row)) throw new Error("所选草稿映射到同一条网页草稿，未触发发送，请核对");
      used.add(row);
      mapped.push({ row: row, id: binding.id });
    }
    mapped.forEach(function (m) { m.row.dataset.dmDraftId = m.id; });
    return { ok: true, bindings: snapshot() };
  });
  api.prepareNativeDraft = result(async function (options) {
    var epoch = importEpoch;
    // Re-clicking New work on an unsent work composer does not save it.
    // Leaving for the opposite composer does, including the user's current text.
    if (text(editor())) {
      switchTo(mode() !== "云电脑");
      await wait(function () { checkImport(epoch); return editor() && !text(editor()); }, "当前草稿尚未保存，请在豆包页面检查");
    }
    checkImport(epoch);
    var outgoingEditor = editor();
    var prepared = await api[options.executionMode === "work" ? "prepareWorkTask" : "prepareVideoGeneration"](options);
    checkImport(epoch);
    if (!prepared.ok) return prepared;
    await expandDrafts();
    // The mode label can precede the new composer. Once React has replaced the
    // outgoing editor, do not add another fixed second. Reused editors retain
    // the stability guard because their route transition has no node boundary.
    var previousEditor = null, stableAt = 0;
    await wait(function () {
      checkImport(epoch);
      var current = editor();
      if (!current || text(current) || current !== previousEditor || (options.executionMode === "work" && mode() !== "云电脑")) {
        previousEditor = current; stableAt = Date.now(); return false;
      }
      var mountedRichEditor = current !== outgoingEditor && current.classList && current.classList.contains("ProseMirror");
      return Date.now() - stableAt >= (mountedRichEditor ? 100 : 1000);
    }, "工作任务输入区仍在切换，请等待豆包加载完成后重试");
    preparedAt = Date.now(); inputScope = "";
    if (typeof indexedDB !== "undefined" && indexedDB.databases) {
      var databases = await indexedDB.databases();
      if (databases.some(function (db) { return db.name === "samantha-web"; })) {
        try { inputScope = String(localStorage.getItem("flow_tea_user_id") || "").trim(); } catch (_) {}
      }
    }
    return { ok: true, accountScope: inputScope };
  });
  api.saveNativeDraft = result(async function (options) {
    var epoch = importEpoch, expected = options.attachmentNames || [];
    await wait(function () { checkImport(epoch); return importText() === normalize(options.prompt); }, "提示词未完整填入，草稿尚未保存，请检查账号输入区");
    if (!await catalog()) throw new Error("当前豆包页面不支持完整草稿保存核对，已保留原草稿");
    if (!expected.length && importCards().length) throw new Error("原草稿没有附件，但网页输入区存在附件，未认定为导入成功");
    if (expected.length) await wait(function () {
      checkImport(epoch);
      if (importText() !== normalize(options.prompt)) throw new Error("当前草稿正文已变化，未继续导入");
      var cards = importCards();
      if (cards.some(function (card) { return card.failed; })) throw new Error("草稿图片上传失败，已保留当前草稿，请重试失败附件");
      return sameNames(cards.map(function (card) { return card.name; }), expected) && cards.every(function (card) { return card.ready; });
    }, function () {
      var cards = importCards();
      return "草稿附件尚未全部上传完成：网页 " + cards.length + "/" + expected.length + " 个，已完成 " + cards.filter(function (card) { return card.ready; }).length + " 个";
    }, Date.now() + 120000);
    var readyAt = 0;
    await wait(async function () {
      checkImport(epoch);
      if (!enabled(sendButton())) { readyAt = 0; return false; }
      if (!readyAt) readyAt = Date.now();
      // The mounted editor's document, unlike DOM text alone, has already
      // consumed the input transaction. Navigation flushes its draft; verify
      // the full persisted body below before reporting success.
      var rich = editor() && editor().editor;
      if (rich && !rich.isDestroyed && typeof rich.getText === "function" && normalize(rich.getText()) === normalize(options.prompt)) return true;
      if (Date.now() - readyAt >= 600) return true;
      // A freshly persisted full document is stronger evidence than a timer.
      // Older/unchanged documents cannot satisfy this fast path.
      if (inputScope) {
        var input = await readStore("samantha-web", "store", "input-engine-draft:v3:account:" + encodeURIComponent(inputScope));
        return input && input.state && input.state.accountScope === inputScope && Array.isArray(input.state.records) && input.state.records.some(function (r) {
          var unit = r.units && r.units["input.document"], payload = unit && !unit.tombstone && unit.payload;
          var prompt = payload && (payload.format === "plain-text" ? payload.text : payload.plainTextFallback);
          return r.address && r.address.accountScope === inputScope && r.updatedAt >= preparedAt && unit && unit.updatedAt >= preparedAt && normalize(prompt) === normalize(options.prompt);
        });
      }
      return false;
    }, "素材尚未上传完成或提示词不可提交，请检查豆包输入区");
    if (options.nativeId && !await savedDraft(options)) throw new Error("未找到原草稿，未切换页面或新建重复草稿");
    checkImport(epoch);
    switchTo(options.executionMode !== "work");
    var verified;
    await wait(async function () {
      checkImport(epoch);
      // Sidebar rows may all remount, remain collapsed, or omit the new draft.
      // The complete account-scoped record is the receipt, not a DOM delta.
      var saved = await savedDraft({ ...options, accountScope: inputScope, waitForPersistence: true });
      if (saved && saved.pending) return false;
      verified = saved;
      if (verified) {
        var items = await persistedImportAttachments(verified.bindings[0]);
        return sameNames(items.map(function (a) { return a.fileName; }), expected) && items.every(function (a) { return !!a.fileKey; });
      }
      return false;
    }, expected.length ? "未确认全部草稿附件已保存，已停止导入下一条，请在原草稿核对" : "未确认豆包原生草稿已保存，请在左侧草稿中核对，避免重复存入", Date.now() + (expected.length ? 60000 : 20000));
    return verified;
  });
  api.openNativeDraft = result(async function (options) {
    sendAttachmentProof = null;
    var deadline = Date.now() + 60000;
    // IndexedDB can finish before the sidebar mounts in a fresh sender page.
    // Wait for this verified native ID, rather than treating a missing DOM row
    // as a deleted draft or selecting a similar title.
    await wait(async function () {
      if (!rowFor(options.id)) await expandDrafts();
      var row = rowFor(options.id);
      if (!row || !row.isConnected) return false;
      // React can replace a row at the await boundary. Click the freshly
      // resolved connected row before yielding to storage/render callbacks.
      row.click();
      return true;
    }, "草稿数据已核对，但网页尚未显示对应条目，请检查豆包侧栏后重试；尚未发送", deadline);
    var stableAt = 0, previousEditor = null, previousAttachments = null, state, lastSelectionAt = Date.now();
    await wait(async function () {
      state = readiness(options);
      if (state.reasons.length || state.editor !== previousEditor || state.attachmentSignature !== previousAttachments) { previousEditor = state.editor; previousAttachments = state.attachmentSignature; stableAt = 0; }
      if (state.reasons.length) {
        // Sidebar synchronization may remount/collapse the selected row after
        // its first click. Re-resolve only this native ID; a detached click must
        // not turn into twenty seconds of waiting on an unrelated composer.
        if (Date.now() - lastSelectionAt >= 1000) {
          lastSelectionAt = Date.now();
          var row = rowFor(options.id);
          if (!row) { await expandDrafts(); row = rowFor(options.id); }
          if (row && row.isConnected && !selected(row)) row.click();
        }
        return false;
      }
      if (!stableAt) stableAt = Date.now();
      return Date.now() - stableAt >= 600;
    }, function () { return "豆包草稿未就绪：" + (state && state.reasons.length ? state.reasons.join("；") : "输入区仍在切换") + "；尚未发送"; }, deadline);
    if (options.attachmentNames !== undefined) sendAttachmentProof = { id: options.id, editor: state.editor, signature: state.attachmentSignature };
    return { ok: true, conversationIds: Array.from(document.querySelectorAll('a[id^="conversation_"]')).map(function (a) { return a.id.slice(13); }) };
  });
  api.sendNativeDraft = result(async function (options) {
    var state = readiness(options);
    if (options.attachmentNames !== undefined && (state.reasons.length || !sendAttachmentProof || sendAttachmentProof.id !== options.id || sendAttachmentProof.editor !== state.editor || sendAttachmentProof.signature !== state.attachmentSignature)) {
      sendAttachmentProof = null; state.reasons.push("草稿附件尚未稳定核对或发送前已变化，请重新打开原草稿核对");
    }
    if (state.reasons.length) throw new Error("当前草稿未就绪：" + state.reasons.join("；") + "；尚未点击发送");
    var attachmentProof = options.attachmentNames !== undefined ? { version: 1, names: options.attachmentNames.slice(), fileKeys: JSON.parse(state.attachmentSignature).map(function (item) { return item[1]; }) } : null;
    state.button.click();
    return { ok: true, clickedAt: new Date().toISOString(), ...(attachmentProof ? { attachmentProof: attachmentProof } : {}) };
  });
  api.readNativeDraftReceipt = function (options) {
    if (api.readNativeDeliveryState().captchaDetected) return { ok: false };
    var match = location.pathname.match(/^\/chat\/([^/]+)$/), id = match && match[1];
    if (!id || /^local_/.test(id) || (options.conversationIds || []).includes(id) || !normalize(options.prompt)) return { ok: false };
    var number = numberIn(options.prompt), baseline = new Set(options.baselineMessageIds || []), accepted = new Set();
    Array.from(document.querySelectorAll('[data-message-id]')).forEach(function (node) {
      var messageId = String(node.getAttribute("data-message-id") || "").trim();
      if (!messageId || baseline.has(messageId)) return;
      var owner = node.closest('[data-message-role], [data-role]');
      // Rendered paragraphs/attachments can change whitespace and truncate the
      // displayed body. Our complete, unique draft number survives that render.
      if (owner && (owner.getAttribute('data-message-role') || owner.getAttribute('data-role')) === 'user' &&
        (number ? String(node.textContent || text(node)).includes('【草稿编号：' + number + '】') : text(node).includes(normalize(options.prompt)))) accepted.add(messageId);
    });
    return accepted.size === 1 ? { ok: true, conversationUrl: location.href, userMessageId: Array.from(accepted)[0], bindings: snapshot() } : { ok: false };
  };
  api.readNativeQuotaResponse = function (options) {
    if (typeof location === "undefined" || !normalize(options.prompt) || !Array.isArray(options.conversationIds) || !Array.isArray(options.baselineMessageIds)) return null;
    var match = location.pathname.match(/^\/chat\/([^/]+)$/);
    if (!match || (options.conversationIds || []).includes(match[1]) || api.readNativeDeliveryState().captchaDetected) return null;
    var baseline = new Set(options.baselineMessageIds), messages = Array.from(document.querySelectorAll('[data-message-id]'));
    var positions = new Map(), currentUsers = new Set(), userIndex = -1, baselineIndex = -1, number = numberIn(options.prompt);
    function role(node) {
      var owner = node.closest && node.closest('[data-message-role], [data-role]');
      return owner && (owner.getAttribute('data-message-role') || owner.getAttribute('data-role'));
    }
    messages.forEach(function (item, index) {
      var id = String(item.getAttribute('data-message-id') || '').trim();
      if (!id) return;
      positions.set(id, index);
      if (baseline.has(id)) { baselineIndex = index; return; }
      if (visible(item) && role(item) === 'user' && (number ? String(item.textContent || text(item)).includes('【草稿编号：' + number + '】') : text(item).includes(normalize(options.prompt)))) {
        currentUsers.add(id); userIndex = index;
      }
    });
    if (currentUsers.size > 1) return null;
    var node = Array.from(document.querySelectorAll('p, [data-message-id]')).find(function (item) {
      var owner = item.closest && item.closest('[data-message-id]'), id = String(owner && owner.getAttribute('data-message-id') || '').trim(), body = normalize(text(item));
      return id && positions.has(id) && !baseline.has(id) && positions.get(id) > Math.max(userIndex, baselineIndex) && role(item) === 'assistant' && visible(item) &&
        !item.closest('nav, aside, #input-engine-container, [contenteditable="true"], blockquote, q') && (!item.querySelectorAll || !item.querySelectorAll('blockquote, q').length) &&
        /^近\s*7\s*天免费额度已用完[，,]/.test(body) && !normalize(options.prompt).includes(body);
    });
    return node ? { ok: true, quotaLimited: true, conversationUrl: location.href, providerMessage: normalize(text(node)).slice(0, 300) } : null;
  };
  api.waitNativeDraftAccepted = result(async function (options) {
    var receiptRemaining = 120000, checkedAt = Date.now(), paused = false, pendingAttachments = false, clearedAt = null, clearedMessage = "", clearedRoot = null, clearedEditor = null;
    for (;;) {
      var now = Date.now(), delivery = api.readNativeDeliveryState();
      if (!paused) receiptRemaining -= now - checkedAt;
      checkedAt = now; paused = delivery.captchaDetected;
      if (paused) {
        clearedAt = null; clearedMessage = ""; clearedRoot = null; clearedEditor = null;
        await new Promise(function (resolve) { setTimeout(resolve, 250); });
        continue;
      }
      if (receiptRemaining <= 0) break;
      var quota = api.readNativeQuotaResponse(options); if (quota) return quota;
      var receipt = api.readNativeDraftReceipt(options);
      if (receipt.ok) {
        if (!Array.isArray(options.attachmentNames) || !options.attachmentNames.length) return receipt;
        pendingAttachments = true;
        var root = document.querySelector("#input-engine-container"), current = importEditor();
        var remaining = root && Array.from(root.querySelectorAll('[data-testid="attachment_area"] [data-kind][aria-label]'));
        var busy = root && Array.from(root.querySelectorAll('[aria-busy="true"], [data-loading="true"], [role="progressbar"], progress')).some(visible);
        var challenge = api.readNativeDeliveryState().captchaDetected;
        if (root && visible(root) && current && visible(current) && current.closest && current.closest("#input-engine-container") === root && !importText(current) && remaining.length === 0 && !busy && !challenge) {
          var message = receipt.conversationUrl + "/" + receipt.userMessageId;
          if (clearedAt === null || clearedMessage !== message || clearedRoot !== root || clearedEditor !== current) { clearedAt = Date.now(); clearedMessage = message; clearedRoot = root; clearedEditor = current; }
          if (Date.now() - clearedAt >= 500) return { ...receipt, attachmentConsumptionProof: { version: 1, names: options.attachmentNames.slice(), userMessageId: receipt.userMessageId, checkedAt: new Date().toISOString() } };
        } else { clearedAt = null; clearedMessage = ""; clearedRoot = null; clearedEditor = null; }
      } else { clearedAt = null; clearedMessage = ""; clearedRoot = null; clearedEditor = null; }
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
    if (pendingAttachments) return { ok: false, attachmentsPending: true, reason: "文字消息已出现，但未确认附件已从输入框完整提交；保留原页和发送意图，停止后续投递，不会自动重发" };
    throw new Error("尚未确认豆包接收本条草稿，请核对最近任务；不会自动重发");
  });
})();
