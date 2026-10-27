/**
 * 页面自动化原语
 *
 * 对标产品靠 CDP 拼一长串 JS 字符串在调用点临时拼装，改一个选择器要改十几处。
 * 这里把「找编辑器 / 填字 / 贴图 / 发送 / 读生成进度 / 点确认 / 提交申诉 / 登录填表」
 * 收成一份稳定的 API，主进程只调用，不关心 DOM 细节。
 *
 * 入口挂在 window[CFG.autoKey] 上：不可枚举、可配置，页面遍历 Object.keys 看不到。
 */
(function () {
  var api = {};

  function visible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity || 1) > 0.2;
  }

  function txt(el) {
    return String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  }

  function all(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  }

  function clickable(el) {
    var n = el;
    for (var i = 0; n && i < 5; i += 1) {
      if (n.tagName === "BUTTON" || n.getAttribute && (n.getAttribute("role") === "button" || n.tagName === "A")) return n;
      n = n.parentElement;
    }
    return el;
  }

  function findEditor() {
    var custom = all('textarea[placeholder]').find(function (el) {
      return /^自定义描述/.test(el.getAttribute("placeholder") || "") && visible(el) && !el.disabled && !el.readOnly && el.closest("section");
    });
    if (custom) return custom;
    var sels = [
      '[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[placeholder]',
      'textarea'
    ];
    for (var i = 0; i < sels.length; i += 1) {
      var list = all(sels[i]).filter(function (el) { return visible(el) && !el.disabled && !el.readOnly; });
      if (list.length) {
        list.sort(function (a, b) {
          var ra = a.getBoundingClientRect();
          var rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return list[0];
      }
    }
    return null;
  }

  function nativeSet(el, value) {
    var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  api.setText = function (text) {
    var ed = findEditor();
    if (!ed) return { ok: false, reason: "没找到输入框" };
    try { ed.focus(); ed.click(); } catch (e) {}
    if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") {
      nativeSet(ed, String(text || ""));
      return { ok: true, kind: "input", length: String(text || "").length };
    }
    // contenteditable：先全选删掉，再用 insertText 走一遍输入事件，富文本编辑器才认
    try {
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(ed);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete", false, null);
      var ok = document.execCommand("insertText", false, String(text || ""));
      if (!ok) {
        ed.textContent = String(text || "");
        ed.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(text || ""), inputType: "insertText" }));
      }
    } catch (e) {
      return { ok: false, reason: String(e && e.message) };
    }
    return { ok: true, kind: "contenteditable", length: String(text || "").length };
  };

  function dataUrlToFile(item, index) {
    var m = /^data:([^;,]+);base64,(.*)$/.exec(String(item.dataUrl || ""));
    if (!m) return null;
    var bin = atob(m[2]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    var ext = (m[1].split("/")[1] || "png").replace("jpeg", "jpg");
    var name = item.name || ("ref-" + (index + 1) + "." + ext);
    return new File([bytes], name, { type: m[1] });
  }

  api.pasteImages = function (items) {
    var ed = findEditor();
    if (!ed) return { ok: false, reason: "没找到输入框" };
    var files = (items || []).map(dataUrlToFile).filter(Boolean);
    if (!files.length) return { ok: false, reason: "没有可上传的图片或视频" };
    var dt = new DataTransfer();
    files.forEach(function (f) { dt.items.add(f); });
    var input = all('input[type="file"]').find(function (el) {
      if (el.disabled || (files.length > 1 && !el.multiple)) return false;
      var accept = String(el.accept || "").toLowerCase().split(",").map(function (s) { return s.trim(); });
      return files.every(function (file) {
        var ext = "." + file.name.split(".").pop().toLowerCase();
        return accept.some(function (type) { return !type || type === "*/*" || type === ext || type === file.type || type === file.type.split("/")[0] + "/*"; });
      });
    });
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, count: files.length, mode: "file-input" };
    }
    try { ed.focus(); } catch (e) {}
    var evt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    // 部分 Chromium 版本 ClipboardEvent 构造器不接受 clipboardData，手动挂上去
    try {
      if (!evt.clipboardData || evt.clipboardData.items.length === 0) {
        Object.defineProperty(evt, "clipboardData", { value: dt });
      }
    } catch (e) {}
    ed.dispatchEvent(evt);
    return { ok: true, count: files.length };
  };

  api.send = function (options) {
    var ed = findEditor();
    var panel = ed && /^自定义描述/.test(ed.getAttribute("placeholder") || "") && ed.closest("section");
    var native = panel ? all('[data-testid="chat_input_send_button"]', panel).find(visible) : all('#input-engine-container button[data-testid="chat_input_send_button"]').find(visible);
    if (options && options.nativeOnly && (!ed || !native)) return { ok: false, reason: "未找到对话输入框的发送按钮" };
    if (native) {
      if (native.disabled || ["aria-disabled", "aria-busy", "data-loading"].some(function (attr) { return native.getAttribute(attr) === "true"; })) return { ok: false, reason: "发送按钮尚未就绪" };
      native.click(); return { ok: true, mode: "native" };
    }
    var scope = ed ? (ed.closest("form") || ed.parentElement || document) : document;
    var cands = all('button, [role="button"]', scope).filter(function (b) {
      if (!visible(b) || b.disabled) return false;
      var label = (b.getAttribute("aria-label") || b.title || txt(b) || "").toLowerCase();
      return /发送|send|提交|submit|生成|立即生成/.test(label);
    });
    if (!cands.length) {
      // 豆包的发送键常是只有图标的 square 按钮，退到「编辑器右侧最近的按钮」
      if (ed) {
        var r = ed.getBoundingClientRect();
        var near = all("button").filter(function (b) {
          if (!visible(b) || b.disabled) return false;
          var br = b.getBoundingClientRect();
          return br.left >= r.left && br.top >= r.top - 10 && br.top <= r.bottom + 40;
        });
        near.sort(function (a, b) { return b.getBoundingClientRect().left - a.getBoundingClientRect().left; });
        if (near.length) { near[0].click(); return { ok: true, mode: "nearest" }; }
      }
      return { ok: false, reason: "没找到发送按钮" };
    }
    cands[0].click();
    return { ok: true, mode: "label", label: txt(cands[0]) };
  };

  api.clickText = function (labels) {
    var wanted = (labels || []).map(function (s) { return String(s).toLowerCase(); });
    var nodes = all('button, [role="button"], a, div[class*="btn"], span[class*="btn"]').filter(visible);
    for (var i = 0; i < nodes.length; i += 1) {
      var t = txt(nodes[i]).toLowerCase();
      if (!t || t.length > 24) continue;
      for (var j = 0; j < wanted.length; j += 1) {
        if (t.indexOf(wanted[j]) >= 0) {
          clickable(nodes[i]).click();
          return { ok: true, text: txt(nodes[i]) };
        }
      }
    }
    return { ok: false };
  };

  var tracking = null;
  function videoKey(url) {
    try {
      var parsed = new URL(url, location.href);
      Array.from(parsed.searchParams.keys()).forEach(function (key) {
        if (/^(lr|lv|lr_source|watermark|wm|with_watermark|is_watermark|need_watermark|signature|sign|x-signature|x-expires|expires|expire|token|auth_key)$/i.test(key)) parsed.searchParams.delete(key);
      });
      parsed.searchParams.sort();
      return parsed.origin + parsed.pathname + parsed.search;
    }
    catch (e) { return String(url || "").split("?")[0]; }
  }
  function videoUrls(root) {
    return all("video", root).filter(function (video) {
      return !video.closest || !video.closest('#input-engine-container, form, [contenteditable="true"], [data-message-role="user"], [data-role="user"], [data-testid*="user-message"]');
    }).map(function (video) {
      return video.currentSrc || video.src || (video.querySelector("source") || {}).src || "";
    }).filter(function (url) { return /^https?:\/\//i.test(url); });
  }
  function messages() {
    var exact = all("[data-message-id]");
    return exact.length ? exact : all('[data-testid="message-container"], [data-testid*="message-item"], [data-message-role]');
  }
  function messageId(node) { return node.getAttribute("data-message-id") || node.id || ""; }
  function messageRole(node) {
    var owner = node.closest ? node.closest("[data-message-role], [data-role]") : node;
    return (owner && (owner.getAttribute("data-message-role") || owner.getAttribute("data-role"))) || "";
  }
  function taskMessages(list) {
    if (!tracking) return [];
    list = list || messages();
    var anchor = -1;
    list.forEach(function (node, index) {
      if (tracking.messageIds.indexOf(messageId(node)) >= 0 || tracking.nodes.indexOf(node) >= 0) anchor = index;
    });
    // Loading older history before the baseline is not this task's output.
    // If a virtualized page removed every anchor, wait rather than guess.
    if (anchor < 0 && tracking.hadBaseline) return [];
    return list.filter(function (node, index) {
      if (index <= anchor) return false;
      var role = messageRole(node);
      if (role === "user") return false;
      if (tracking.prompt && txt(node) === tracking.prompt) return false;
      var id = messageId(node);
      return id ? tracking.messageIds.indexOf(id) < 0 : tracking.nodes.indexOf(node) < 0;
    });
  }
  function confirmationPanels() {
    var panels = all('[role="dialog"], dialog, #input-engine-container').filter(visible);
    all('textarea[placeholder]').filter(visible).forEach(function (editor) {
      var panel = /^自定义描述/.test(editor.getAttribute("placeholder") || "") && editor.closest("section");
      if (panel && visible(panel) && panels.indexOf(panel) < 0) panels.push(panel);
    });
    return panels;
  }
  function panelText(root) {
    if (!root.cloneNode) return txt(root);
    var copy = root.cloneNode(true);
    all('[contenteditable], textarea, input', copy).forEach(function (node) { node.remove(); });
    return txt(copy);
  }
  function planQuestion(content) {
    var match = content.match(/(?:以上方案\s*[（(][^?？]{1,800}[）)]\s*是否按此开始生成|是否按(?:以上|上述)(?:完整)?方案\s*[（(][^?？]{1,800}[）)]\s*开始生成视频)[？?]/);
    if (!match) match = content.match(/(?:请确认)?是否按(?:此|以上|上述)[^?？。]{0,240}(?:生成|调用)[^?？。]{0,100}[？?。]/);
    return match ? match[0] : "";
  }
  function quotaExhausted(content) {
    return /(?:额度|免费数量|今日次数)\s*(?:已经?|均已|全部|已全部)?\s*(?:用完|耗尽)|已用完.{0,16}(?:额度|次数)|已达上限/.test(content);
  }
  function failedReply(roots) {
    var latest = roots[roots.length - 1];
    // Work requests can be accepted but fail with an empty assistant message.
    // The native error icon is then the only visible failure evidence. Scope
    // it to the latest reply after this task's receipt, never sidebar/history.
    if (!latest || messageRole(latest) !== "assistant") return false;
    if (all('[data-testid="message_box_failed_icon"]', latest).some(visible)) return true;
    // The native renderer also has explicit terminal errors before its icon
    // mounts. Match the DOM message ID; never infer failure from an empty
    // response or numeric status (the current site's status 4 is Streaming).
    var key = Object.keys(latest).find(function (name) { return name.indexOf("__reactFiber$") === 0; });
    var fiber = key && latest[key], id = messageId(latest);
    for (var i = 0; fiber && i < 16; i += 1, fiber = fiber.return) {
      var props = fiber.memoizedProps;
      var message = props && (props.message || (props.value && props.value.message));
      if (!message || !id || String(message.message_id || "") !== id) continue;
      return !!(message.error_details && message.error_details.has_error) ||
        !!(message.final_status && /^(Error|Timeout)$/.test(message.final_status.message));
    }
    return false;
  }
  function followupConfirmation(content) {
    // Work tasks can finish planning with a declarative reminder instead of a
    // question. Require both an explicit confirmation hold and a quoted reply.
    if (!/(?:等待.{0,8}确认|等.{0,8}确认后|停在确认环节|没有回复确认)/.test(content)) return "";
    var reply = content.match(/(?:回复(?:一句)?|说一声)\s*["“「](按(?:要求|方案)生成|开始生成)["”」]/);
    if (!reply || !/(?:即可开始(?:制作|生成)|我就.{0,100}(?:生成|跑.{0,35}视频)|确认后.{0,15}开始生成)/.test(content)) return "";
    return reply[1];
  }
  api.beginTask = function (input) {
    var opts = typeof input === "string" ? { taskId: input } : input || {};
    if (tracking && tracking.taskId === opts.taskId && opts.resume && !opts.reset) return { ok: true, baselineUrls: tracking.urls, baselineMessageIds: tracking.messageIds };
    var nodes = messages();
    var urls = opts.resume && Array.isArray(opts.baselineUrls) ? opts.baselineUrls : videoUrls();
    var ids = opts.resume && Array.isArray(opts.baselineMessageIds) ? opts.baselineMessageIds : nodes.map(messageId).filter(Boolean);
    tracking = { taskId: opts.taskId, prompt: String(opts.prompt || ""), urls: urls, keys: urls.map(videoKey), messageIds: ids, nodes: opts.resume ? [] : nodes, hadBaseline: ids.length > 0 || (!opts.resume && nodes.length > 0),
      text: document.body ? String(document.body.innerText || "") : "", resumed: !!opts.resume, confirmed: opts.confirmedKeys || [],
      oldPanels: opts.resume ? [] : confirmationPanels().map(function (root) { return planQuestion(panelText(root)); }).filter(Boolean) };
    return { ok: true, baselineUrls: urls, baselineMessageIds: ids };
  };
  function newText(roots, hasMessages) {
    if (hasMessages) return roots.map(txt).join("\n");
    if (!tracking) return "";
    var current = document.body ? String(document.body.innerText || "") : "";
    var before = tracking.text;
    var prefix = 0;
    while (prefix < current.length && prefix < before.length && current[prefix] === before[prefix]) prefix += 1;
    var suffix = 0;
    while (suffix < current.length - prefix && suffix < before.length - prefix && current[current.length - 1 - suffix] === before[before.length - 1 - suffix]) suffix += 1;
    return current.slice(prefix, current.length - suffix);
  }
  api.readProgress = function () {
    if (!tracking) return { state: "unknown", percent: 0, mediaUrls: [], snippet: "尚未建立任务跟踪" };
    // 只在本次同步轮询内复用快照；下一次仍重新读取页面，避免漏掉流式消息或成片。
    var list = messages();
    var roots = taskMessages(list);
    var urls = list.length ? roots.reduce(function (out, root) { return out.concat(videoUrls(root)); }, []) : videoUrls();
    urls = urls.filter(function (url, index, list) { return tracking.keys.indexOf(videoKey(url)) < 0 && list.indexOf(url) === index; });
    var tail = newText(roots, list.length).slice(-4000);
    var pm = tail.match(/(\d{1,3})\s*%/g);
    var percent = pm && pm.length ? Math.min(100, Math.max.apply(null, pm.map(function (s) { return parseInt(s, 10) || 0; }))) : 0;
    var state = "unknown";
    var quotaFailure = quotaExhausted(tail);
    var rejected = failedReply(roots);
    if (quotaFailure || rejected || /(生成失败|视频生成未能(?:提交)?成功|视频没能生成出来|审核不通过|未通过审核|违规内容)/.test(tail)) state = "failed";
    else if (/(生成中|排队中|正在生成|处理中)/.test(tail)) state = "running";
    else if (urls.length || /(生成完成|已完成|已生成)/.test(tail)) state = "done";
    else if (findConfirmation(null, roots).kind) state = "waiting_confirmation";
    var generationStarted = state === "running" && /(?:视频.{0,10}(?:正在生成|生成中|排队中)|正在(?:为你)?生成视频)/.test(tail);
    return { state: state, errorCode: quotaFailure ? "quota" : rejected ? "platform_rejected" : "", generationStarted: generationStarted, percent: state === "done" ? 100 : percent, videos: urls.length, mediaUrls: urls, snippet: rejected && !tail.trim() ? "豆包已接收请求，但助手回复显示失败标记且没有返回内容；平台未提供具体原因，请查看原对话，不会自动重发" : tail.slice(-400) };
  };
  function confirmationKey(root, content, kind) {
    var hash = 2166136261;
    for (var i = 0; i < content.length; i += 1) { hash ^= content.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return tracking.taskId + ":" + kind + ":" + (messageId(root) || "dialog") + ":" + (hash >>> 0).toString(16);
  }
  function findConfirmation(options, current) {
    if (!tracking) return { ok: false };
    current = current || taskMessages();
    // An exhausted quota is a failed attempt, even if the same reply offers a
    // future reminder or a cheaper model. Neither is an immediate confirmation.
    if (failedReply(current) || (current.length && quotaExhausted(txt(current[current.length - 1])))) return { ok: false };
    // Once a new assistant response exists, the earlier confirmation request
    // is history and must not be sent again.
    var roots = current.length ? [current[current.length - 1]] : [];
    var panels = confirmationPanels();
    roots = roots.concat(panels);
    for (var i = 0; i < roots.length; i += 1) {
      var root = roots[i];
      var content = panels.indexOf(root) >= 0 ? panelText(root) : txt(root);
      if (!/生成/.test(content)) continue;
      var question = planQuestion(content);
      var planRequest = !!question && (messageRole(root) === "assistant" || panels.indexOf(root) >= 0);
      var followupText = messageRole(root) === "assistant" ? followupConfirmation(content) : "";
      if (panels.indexOf(root) >= 0 && tracking.oldPanels.indexOf(question) >= 0) continue;
      var textRequest = planRequest || !!followupText || (messageRole(root) === "assistant" && /视频生成参数确认/.test(content) && /确认后.{0,25}(开始|生成)/.test(content));
      // Using the already selected model's quota is covered by auto-confirm;
      // purchasing or upgrading a plan is not.
      var paymentContent = followupText ? content.replace(/付费额度/g, "额度") : content;
      var blocked = /购买|支付|充值|订阅|开通会员|付费|扣费|升级/.test(paymentContent);
      var buttons = all('button, [role="button"]', root).filter(function (button) {
        if (!visible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
        var label = txt(button);
        return /^(确认生成|继续生成|开始生成)$/.test(label) || ((root.getAttribute("role") === "dialog" || root.tagName === "DIALOG") && /^(确认|继续)$/.test(label));
      });
      var kind = planRequest ? "text" : buttons.length ? "button" : textRequest ? "text" : "";
      if (!kind) continue;
      var key = confirmationKey(root, planRequest ? question : content, kind);
      var reason = blocked ? "确认涉及付费或升级，请手动检查" : "", pending = false;
      if (options && options.model) {
        var labels = { "seedance_v2.5": "Seedance 2.5", "seedance_v2.0": "Seedance 2.0", "seedance_v2.0_fast": "Seedance 2.0 Fast", "seedance_v2.0_mini": "Seedance 2.0 Mini" };
        // Short work-task reminders refer to the latest assistant plan. Never
        // borrow parameters from the user's prompt or an older reply.
        var latest = current.length && messageRole(current[current.length - 1]) === "assistant" ? txt(current[current.length - 1]) : "";
        var modelPattern = /Seedance\s*2\.\d+(?:\s+(?:Fast|Mini))?/i;
        var secondsPattern = /(?:时长\s*[:：]?\s*)(\d+)\s*秒/;
        // The settled plan precedes optional "if you want to change..." advice.
        // Elapsed planning time is not the requested clip duration.
        var parameterContent = followupText ? content.replace(/^共用时\s*(?:\d+\s*(?:小时|分钟|分|秒)\s*)+/, "").split(/(?:如果|若)(?:你|您)?想(?:调整|改|换|去掉)/)[0] : content;
        var conflicting = false;
        function parameter(pattern, value, preferred) {
          var sources = [question, parameterContent, planRequest ? latest : ""];
          for (var s = 0; s < sources.length; s += 1) {
            // Only the separate plan fallback may contain shot timings. In a
            // reminder itself every stated duration must agree, labelled or not.
            var rule = s === 2 && preferred && preferred.test(sources[s]) ? preferred : pattern;
            var matches = Array.from(sources[s].matchAll(new RegExp(rule.source, rule.ignoreCase ? "gi" : "g")));
            // A question/plan with conflicting values must never be approved
            // merely because its first value repeats the user's request.
            if (matches.length) {
              if (new Set(matches.map(value)).size === 1) return matches[0];
              conflicting = true; return null;
            }
          }
          return null;
        }
        var model = parameter(modelPattern, function (m) { return m[0].replace(/\s+/g, " ").toLowerCase(); });
        var seconds = parameter(planRequest || followupText ? /(\d+)\s*秒/ : secondsPattern, function (m) { return Number(m[1]); }, secondsPattern);
        if (!model || !seconds) {
          pending = !blocked && !conflicting;
          if (!blocked) reason = pending ? "平台尚未给出完整的模型或时长，等待确认内容加载" : "平台确认的模型或时长相互冲突，请手动检查";
        } else if (model[0].replace(/\s+/g, " ").toLowerCase() !== String(labels[options.model] || "").toLowerCase() || Number(seconds[1]) !== Number(options.duration)) reason = "平台确认的模型或时长与任务不一致，请手动检查";
        if (options.ratio && options.ratio !== "adaptive") {
          var ratioPattern = /(\d+)\s*[:：]\s*(\d+)/;
          var ratio = parameter(ratioPattern, function (m) { return m[1] + ":" + m[2]; });
          if (!ratio || ratio[1] + ":" + ratio[2] !== options.ratio) reason = "平台未确认所选画面比例，请手动检查";
        }
      }
      return { ok: !reason, pending: pending, kind: kind, key: key, text: "按要求生成", nativeOnly: true, reason: reason, button: buttons[0] || null, alreadyConfirmed: tracking.confirmed.indexOf(key) >= 0 };
    }
    return { ok: false };
  };
  api.peekGenerationConfirmation = function (options) {
    var found = findConfirmation(options);
    var result = Object.assign({}, found);
    delete result.button;
    return result;
  };
  api.confirmGeneration = function (options) {
    var found = findConfirmation(options);
    if (!found.ok || found.kind !== "button" || found.alreadyConfirmed || (options && options.key && options.key !== found.key)) return { ok: false, reason: found.reason || "确认内容已变化或已经处理" };
    tracking.confirmed.push(found.key);
    found.button.click();
    return { ok: true, key: found.key, text: found.text };
  };

  api.waitIdle = function (timeoutMs) {
    var deadline = Date.now() + Math.max(2000, Number(timeoutMs) || 120000);
    return new Promise(function (resolve) {
      (function tick() {
        var p = api.readProgress();
        if (p.state === "done" || p.state === "failed" || Date.now() > deadline) resolve(p);
        else setTimeout(tick, 1200);
      })();
    });
  };

  api.appeal = function (script) {
    var opened = api.clickText(["申诉", "反馈", "我不满意", "重新生成"]);
    if (!opened.ok) return { ok: false, reason: "没找到申诉入口" };
    return new Promise(function (resolve) {
      setTimeout(function () {
        var r = api.setText(String(script || "该内容为正常创作，未包含违规信息，请复核。"));
        setTimeout(function () {
          var sent = api.clickText(["提交", "发送", "确认"]);
          resolve({ ok: !!(r.ok && sent.ok), filled: r, sent: sent });
        }, 400);
      }, 600);
    });
  };

  api.isLoggedIn = function () {
    var markers = [
      'img[class*="avatar"]',
      '[class*="avatar"] img',
      '[data-testid*="avatar"]',
      '[class*="user-info"]',
      '[class*="userInfo"]'
    ];
    for (var i = 0; i < markers.length; i += 1) {
      if (all(markers[i]).some(visible)) return { loggedIn: true, by: markers[i] };
    }
    var loginBtn = all('button, a, [role="button"]').filter(visible).some(function (b) {
      return /^(登录|登入|sign in|log in)$/i.test(txt(b));
    });
    if (loginBtn) return { loggedIn: false, by: "login-button" };
    var t = document.body ? String(document.body.innerText || "").slice(0, 3000) : "";
    if (/退出登录|个人中心|我的创作/.test(t)) return { loggedIn: true, by: "text" };
    return { loggedIn: false, by: "unknown" };
  };

  /* ---- 登录表单（Google / 平台账号页） ---- */
  function inputBy(sel, types) {
    var list = all(sel).filter(visible);
    if (types && types.length) {
      var hit = list.filter(function (el) { return types.indexOf(String(el.type || "").toLowerCase()) >= 0; });
      if (hit.length) return hit[0];
    }
    return list[0] || null;
  }

  api.loginStage = function () {
    if (inputBy('input[type="password"]')) return "password";
    if (inputBy('input[type="email"], input[name="identifier"], input[autocomplete="username"]')) return "identifier";
    if (all('iframe[src*="challenge"], iframe[src*="recaptcha"], iframe[src*="captcha"]').some(visible)) return "challenge";
    if (all('input[autocomplete="one-time-code"], input[name="totpPin"]').some(visible)) return "totp";
    var t = document.body ? String(document.body.innerText || "") : "";
    if (/Verify it|确认是您本人|2-Step|两步验证|验证码/.test(t)) return "verify";
    if (/同意|Continue|允许|Allow/.test(t) && all('button, [role="button"]').some(function (b) { return visible(b) && /同意|Continue|允许|Allow/.test(txt(b)); })) return "consent";
    return "unknown";
  };

  api.fillLogin = function (account, password) {
    var stage = api.loginStage();
    if (stage === "identifier") {
      var em = inputBy('input[type="email"], input[name="identifier"], input[autocomplete="username"]');
      if (!em) return { ok: false, stage: stage, reason: "没找到账号输入框" };
      nativeSet(em, String(account || ""));
      var nxt = api.clickText(["下一步", "Next", "继续", "Continue"]);
      return { ok: true, stage: stage, next: nxt };
    }
    if (stage === "password") {
      var pw = inputBy('input[type="password"]');
      if (!pw) return { ok: false, stage: stage, reason: "没找到密码输入框" };
      nativeSet(pw, String(password || ""));
      var go = api.clickText(["下一步", "Next", "登录", "Sign in", "继续", "Continue"]);
      return { ok: true, stage: stage, next: go };
    }
    return { ok: false, stage: stage, needHuman: ["challenge", "totp", "verify"].indexOf(stage) >= 0 };
  };

  api.title = function () { return document.title; };
  api.href = function () { return location.href; };

  try {
    Object.defineProperty(window, CFG.autoKey, {
      value: api,
      enumerable: false,
      configurable: true,
      writable: false
    });
  } catch (e) {}
})();
