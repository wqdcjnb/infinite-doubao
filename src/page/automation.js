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

  api.send = function () {
    var ed = findEditor();
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
  function taskMessages() {
    if (!tracking) return [];
    var list = messages();
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
  api.beginTask = function (input) {
    var opts = typeof input === "string" ? { taskId: input } : input || {};
    if (tracking && tracking.taskId === opts.taskId && opts.resume) return { ok: true, baselineUrls: tracking.urls, baselineMessageIds: tracking.messageIds };
    var nodes = messages();
    var urls = opts.resume && Array.isArray(opts.baselineUrls) ? opts.baselineUrls : videoUrls();
    var ids = opts.resume && Array.isArray(opts.baselineMessageIds) ? opts.baselineMessageIds : nodes.map(messageId).filter(Boolean);
    tracking = { taskId: opts.taskId, prompt: String(opts.prompt || ""), urls: urls, keys: urls.map(videoKey), messageIds: ids, nodes: opts.resume ? [] : nodes, hadBaseline: ids.length > 0 || (!opts.resume && nodes.length > 0),
      text: document.body ? String(document.body.innerText || "") : "", resumed: !!opts.resume, confirmed: opts.confirmedKeys || [] };
    return { ok: true, baselineUrls: urls, baselineMessageIds: ids };
  };
  function newText() {
    var roots = taskMessages();
    if (messages().length) return roots.map(txt).join("\n");
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
    var roots = taskMessages();
    var urls = messages().length ? roots.reduce(function (out, root) { return out.concat(videoUrls(root)); }, []) : videoUrls();
    urls = urls.filter(function (url, index, list) { return tracking.keys.indexOf(videoKey(url)) < 0 && list.indexOf(url) === index; });
    var tail = newText().slice(-4000);
    var pm = tail.match(/(\d{1,3})\s*%/g);
    var percent = pm && pm.length ? Math.min(100, Math.max.apply(null, pm.map(function (s) { return parseInt(s, 10) || 0; }))) : 0;
    var state = "unknown";
    if (/(生成失败|审核不通过|未通过审核|违规内容|免费数量用完|额度已用完|今日次数已用完|已达上限)/.test(tail)) state = "failed";
    else if (/(生成中|排队中|正在生成|处理中)/.test(tail)) state = "running";
    else if (urls.length || /(生成完成|已完成|已生成)/.test(tail)) state = "done";
    else if (api.peekGenerationConfirmation().kind) state = "waiting_confirmation";
    return { state: state, percent: state === "done" ? 100 : percent, videos: urls.length, mediaUrls: urls, snippet: tail.slice(-400) };
  };
  function confirmationKey(root, content, kind) {
    var hash = 2166136261;
    for (var i = 0; i < content.length; i += 1) { hash ^= content.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return tracking.taskId + ":" + kind + ":" + (messageId(root) || "dialog") + ":" + (hash >>> 0).toString(16);
  }
  function findConfirmation(options) {
    if (!tracking) return { ok: false };
    var current = taskMessages();
    // Once a new assistant response exists, the earlier confirmation request
    // is history and must not be sent again.
    var roots = current.length ? [current[current.length - 1]] : [];
    roots = roots.concat(all('[role="dialog"], dialog').filter(visible));
    for (var i = 0; i < roots.length; i += 1) {
      var root = roots[i];
      var content = txt(root);
      if (!/生成/.test(content)) continue;
      var textRequest = messageRole(root) === "assistant" && /视频生成参数确认/.test(content) && /确认后.{0,25}(开始|生成)/.test(content);
      var blocked = /购买|支付|充值|订阅|开通会员|付费|扣费|升级/.test(content);
      var buttons = all('button, [role="button"]', root).filter(function (button) {
        if (!visible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
        var label = txt(button);
        return /^(确认生成|继续生成|开始生成)$/.test(label) || ((root.getAttribute("role") === "dialog" || root.tagName === "DIALOG") && /^(确认|继续)$/.test(label));
      });
      var kind = buttons.length ? "button" : textRequest ? "text" : "";
      if (!kind) continue;
      var key = confirmationKey(root, content, kind);
      var reason = blocked ? "确认涉及付费或升级，请手动检查" : "";
      if (textRequest && options && options.model) {
        var labels = { "seedance_v2.5": "Seedance 2.5", "seedance_v2.0": "Seedance 2.0", "seedance_v2.0_fast": "Seedance 2.0 Fast", "seedance_v2.0_mini": "Seedance 2.0 Mini" };
        var model = content.match(/Seedance\s*2\.\d+(?:\s+(?:Fast|Mini))?/i);
        var seconds = content.match(/时长\s*[:：]?\s*(\d+)\s*秒/);
        if (!model || model[0].replace(/\s+/g, " ").toLowerCase() !== String(labels[options.model] || "").toLowerCase() || !seconds || Number(seconds[1]) !== Number(options.duration)) reason = "平台确认的模型或时长与任务不一致，请手动检查";
      }
      return { ok: !reason, kind: kind, key: key, text: kind === "text" ? "确认，开始生成视频。" : txt(buttons[0]), reason: reason, button: buttons[0] || null, alreadyConfirmed: tracking.confirmed.indexOf(key) >= 0 };
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
