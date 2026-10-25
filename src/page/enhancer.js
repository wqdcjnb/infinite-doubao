/**
 * 保存当前任务的模型和时长参数。实际生成选项由 generation-options.js
 * 在平台控件中选择并核验；默认不修改平台返回的模型目录、权限或生成请求。
 * 旧网络适配仅在调用方显式设置 rewriteResponse / rewriteRequest 时运行。
 */
(function () {
  var E = CFG.enhancer || {};
  if (E.enabled === false) return;

  var wantDuration = Number(E.duration) || 0;
  var wantModel = String(E.model || "");
  var wantResolution = String(E.resolution || "");

  var DURATION_KEYS = /^(video_)?duration(_ms|_s|_sec)?$/i;
  var MODEL_KEYS = /^(video_)?model(_key|_name|_id)?$/i;
  var RES_KEYS = /^(resolution|video_resolution|output_resolution|size_ratio|ratio)$/i;
  var CONF_URL = /\/(samantha|alice)\/(skill\/pack|.*(conf|config|ability|model|setting).*)/i;
  var GEN_URL = /\/(samantha|alice)\/(chat|message|conversation|agent_task|video|image)\/(completion|submit|create|generate|gen)/i;

  function rewrite(node, depth) {
    if (!node || typeof node !== "object" || depth > 8) return node;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i += 1) rewrite(node[i], depth + 1);
      return node;
    }
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k += 1) {
      var key = keys[k];
      var val = node[key];
      if (val && typeof val === "object") { rewrite(val, depth + 1); continue; }
      if (wantDuration && DURATION_KEYS.test(key) && (typeof val === "number" || typeof val === "string")) {
        node[key] = typeof val === "number" ? wantDuration : String(wantDuration);
        if (/upper_bound/i.test(key) && node[key] < wantDuration) node[key] = wantDuration;
        continue;
      }
      if (wantModel && MODEL_KEYS.test(key) && typeof val === "string" && val && !/^(auto|default)$/i.test(val)) {
        node[key] = wantModel;
        continue;
      }
      if (wantResolution && RES_KEYS.test(key) && typeof val === "string" && /^\d{1,4}[:x*]\d{1,4}$/i.test(val)) {
        node[key] = wantResolution;
      }
    }
    return node;
  }

  function rewriteText(text) {
    if (!text || text.length > 4 * 1024 * 1024) return text;
    var head = text.slice(0, 1);
    if (head !== "{" && head !== "[") return text;
    try {
      var obj = JSON.parse(text);
      rewrite(obj, 0);
      return JSON.stringify(obj);
    } catch (e) {
      return text;
    }
  }

  function absolute(url) {
    try { return new URL(String(url || ""), location.href).toString(); } catch (e) { return String(url || ""); }
  }

  /* ---- fetch ---- */
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url = absolute(typeof input === "string" ? input : (input && input.url) || "");
      if (E.rewriteRequest && GEN_URL.test(url) && init && typeof init.body === "string") {
        init = Object.assign({}, init, { body: rewriteText(init.body) });
      }
      var p = origFetch.call(this, input, init);
      // Queued tasks select the platform's real model/duration controls.
      // Never rewrite the model catalog or entitlement responses by default.
      if (E.rewriteResponse !== true || !CONF_URL.test(url)) return p;
      return p.then(function (res) {
        try {
          var ct = String(res.headers.get("content-type") || "");
          if (ct.indexOf("json") < 0) return res;
          return res.clone().text().then(function (txt) {
            var out = rewriteText(txt);
            return new Response(out, { status: res.status, statusText: res.statusText, headers: res.headers });
          });
        } catch (e) { return res; }
      });
    };
  }

  /* ---- XHR ---- */
  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    var open = OrigXHR.prototype.open;
    var send = OrigXHR.prototype.send;
    var store = new WeakMap();
    OrigXHR.prototype.open = function (method, url) {
      store.set(this, { url: absolute(url) });
      return open.apply(this, arguments);
    };
    OrigXHR.prototype.send = function (body) {
      var meta = store.get(this) || {};
      var self = this;
      if (E.rewriteRequest && GEN_URL.test(meta.url || "") && typeof body === "string") {
        try { arguments[0] = rewriteText(body); } catch (e) {}
      }
      if (E.rewriteResponse === true && CONF_URL.test(meta.url || "")) {
        this.addEventListener("readystatechange", function () {
          if (self.readyState !== 4) return;
          try { meta.rewritten = rewriteText(String(self.responseText || "")); } catch (e) { meta.rewritten = ""; }
        }, true);
        try {
          Object.defineProperty(this, "responseText", {
            configurable: true,
            get: function () {
              if (typeof meta.rewritten === "string" && meta.rewritten) return meta.rewritten;
              return Object.getOwnPropertyDescriptor(OrigXHR.prototype, "responseText").get.call(self);
            }
          });
          Object.defineProperty(this, "response", {
            configurable: true,
            get: function () {
              if (this.responseType === "" && typeof meta.rewritten === "string" && meta.rewritten) return meta.rewritten;
              return Object.getOwnPropertyDescriptor(OrigXHR.prototype, "response").get.call(self);
            }
          });
        } catch (e) {}
      }
      return send.apply(this, arguments);
    };
  }

  // 供自动化原语查询当前生效的增强档位
  try {
    Object.defineProperty(window, CFG.autoKey + "_enh", {
      value: {
        duration: wantDuration, model: wantModel, resolution: wantResolution, rewriteRequest: !!E.rewriteRequest,
        setOptions: function (options) {
          var previous = { duration: wantDuration, model: wantModel, resolution: wantResolution };
          wantDuration = Number(options.duration) || 0;
          wantModel = String(options.model || "");
          if (options.resolution !== undefined) wantResolution = String(options.resolution || "");
          this.duration = wantDuration;
          this.model = wantModel;
          this.resolution = wantResolution;
          return previous;
        }
      },
      enumerable: false,
      configurable: true
    });
  } catch (e) {}
})();
