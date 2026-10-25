"use strict";

/**
 * 指纹补丁体（由 fingerprint.js 生成后固化为真实模块）
 *
 * 为什么不用字符串 + eval/webFrame.executeJavaScript：
 *   - 主世界 eval 受页面 CSP 的 unsafe-eval 限制，豆包这类站点会被拦；
 *   - webFrame.executeJavaScript 在 contextIsolation 下落在隔离世界，改了页面看不见。
 * 做成普通模块后由 preload 在 document_start 同步调用，时序和作用域都确定。
 *
 * @param {object} P 账号指纹档案（buildProfile 产出）
 */
let installed = false;

function installFingerprint(P) {

  // 幂等：用模块作用域的私有变量，不往 window 上挂自造属性（getOwnPropertyNames 一扫就露）。
  // 不能用「UA 是否已是档案值」来判断 —— webview 的 useragent 属性已经把 UA 设成档案值了，
  // 那样会在第一行就 return，整个补丁一条都不生效。
  if (installed) return;
  installed = true;
  if (!P) return;
  const origToString = Function.prototype.toString;
  const sourceMap = new WeakMap();
  function mark(fn, fake){ try { sourceMap.set(fn, fake); } catch(e){} return fn; }
  function nativeLike(fn, name){
    const fake = "function " + (name || fn.name || "") + "() { [native code] }";
    return mark(fn, fake);
  }
  try {
    Object.defineProperty(Function.prototype, "toString", {
      configurable: true, writable: true,
      value: function toString(){
        if (sourceMap.has(this)) return sourceMap.get(this);
        return origToString.call(this);
      }
    });
    nativeLike(Function.prototype.toString, "toString");
  } catch(e){}
  const def = (obj, key, getter) => {
    try { Object.defineProperty(obj, key, { configurable: true, enumerable: true, get: nativeLike(getter, "get " + key) }); } catch(e){}
  };
  const NAV = Navigator.prototype;
  def(NAV, "userAgent", () => P.userAgent);
  def(NAV, "appVersion", () => P.appVersion);
  def(NAV, "platform", () => P.platform);
  def(NAV, "vendor", () => P.vendor);
  def(NAV, "language", () => P.languages[0]);
  def(NAV, "languages", () => Object.freeze(P.languages.slice()));
  def(NAV, "hardwareConcurrency", () => P.hardwareConcurrency);
  def(NAV, "deviceMemory", () => P.deviceMemory);
  def(NAV, "maxTouchPoints", () => P.maxTouchPoints);
  def(NAV, "webdriver", () => false);
  try { Object.defineProperty(NAV, "doNotTrack", { configurable: true, get: () => (P.doNotTrack ? "1" : null) }); } catch(e){}
  // ---- userAgentData ----
  // 不能自造一个 {brands, mobile, platform, getHighEntropyValues} 对象塞给 navigator：
  // 那样 instanceof NavigatorUAData 为 false、Object.prototype.toString 变 [object Object]、
  // 自有属性一个个列得出来、getHighEntropyValues.toString() 还能看到源码。
  // 正确做法是就地改 NavigatorUAData.prototype，让真实实例原样返回。
  try {
    const brands = Object.freeze(P.uaData.brands.map(b => Object.freeze({ brand: b.brand, version: b.version })));
    const full = Object.freeze(P.uaData.fullVersionList.map(b => Object.freeze({ brand: b.brand, version: b.version })));
    const values = {
      brands, mobile: P.uaData.mobile, platform: P.uaData.platform,
      architecture: P.uaData.architecture, bitness: P.uaData.bitness,
      model: P.uaData.model, platformVersion: P.uaData.platformVersion,
      uaFullVersion: P.uaData.uaFullVersion, wow64: P.uaData.wow64,
      fullVersionList: full
    };
    const UADP = window.NavigatorUAData && window.NavigatorUAData.prototype;
    if (UADP) {
      ["brands", "mobile", "platform"].forEach(function (k) {
        try {
          Object.defineProperty(UADP, k, {
            configurable: true, enumerable: true,
            get: nativeLike(function () { return values[k]; }, "get " + k)
          });
        } catch (e) {}
      });
      if (typeof UADP.getHighEntropyValues === "function") {
        Object.defineProperty(UADP, "getHighEntropyValues", {
          configurable: true, enumerable: true, writable: true,
          value: nativeLike(function getHighEntropyValues(hints) {
            // 真实 Chrome 即使只请求高熵项，返回里也一定带 brands / mobile / platform，
            // 少了这三个字段，一句 getHighEntropyValues().then(d => d.platform) 就露馅。
            const out = { brands: values.brands, mobile: values.mobile, platform: values.platform };
            (hints || []).forEach(function (k) { if (k in values) out[k] = values[k]; });
            return Promise.resolve(out);
          }, "getHighEntropyValues")
        });
      }
    } else {
      // 回退：极少数环境根本不暴露 NavigatorUAData，这时才用自造对象
      const uad = {
        brands, mobile: values.mobile, platform: values.platform,
        getHighEntropyValues(hints) {
          const out = { brands, mobile: values.mobile, platform: values.platform };
          (hints || []).forEach(function (k) { if (k in values) out[k] = values[k]; });
          return Promise.resolve(out);
        },
        toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; }
      };
      Object.defineProperty(NAV, "userAgentData", { configurable: true, enumerable: true, get: () => uad });
    }
  } catch (e) {}
  // ---- window.chrome ----
  // Electron 的 guest 页里有 chrome 对象但成员是空的：csi / loadTimes / app / runtime 全是
  // undefined。真实 Chrome 这四个都在，缺一个就等于在脸上写着"这不是浏览器"。
  (function(){
    try {
      const c = window.chrome || (window.chrome = {});
      const t = performance.timing || {};
      if (typeof c.csi !== "function") {
        Object.defineProperty(c, "csi", {
          configurable: true, enumerable: true, writable: true,
          value: nativeLike(function csi(){
            return {
              onloadT: t.domContentLoadedEventEnd || 0,
              startE: t.navigationStart || 0,
              pageT: performance.now(),
              tran: 15
            };
          }, "csi")
        });
      }
      if (typeof c.loadTimes !== "function") {
        const nt = (t.navigationStart || 0) / 1000;
        Object.defineProperty(c, "loadTimes", {
          configurable: true, enumerable: true, writable: true,
          value: nativeLike(function loadTimes(){
            const ev = t.domContentLoadedEventEnd || t.navigationStart || 0;
            return {
              commitLoadTime: nt + 0.05, connectionInfo: "h2", finishDocumentLoadTime: nt + 0.35,
              finishLoadTime: (t.loadEventEnd || ev) / 1000, firstPaintAfterLoadTime: 0,
              firstPaintTime: nt + 0.28, navigationType: "Other",
              npnNegotiatedProtocol: "h2", requestTime: nt, startLoadTime: nt,
              wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true
            };
          }, "loadTimes")
        });
      }
      if (!c.app) {
        Object.defineProperty(c, "app", {
          configurable: true, enumerable: true, writable: true,
          value: {
            isInstalled: false,
            InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
            RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
            getDetails: nativeLike(function getDetails(){ return null; }, "getDetails"),
            getIsInstalled: nativeLike(function getIsInstalled(){ return false; }, "getIsInstalled"),
            runningState: nativeLike(function runningState(){ return "cannot_run"; }, "runningState")
          }
        });
      }
      if (!c.runtime) {
        Object.defineProperty(c, "runtime", {
          configurable: true, enumerable: true, writable: true,
          value: {
            id: undefined,
            connect: nativeLike(function connect(){ throw new Error("Could not establish connection. Receiving end does not exist."); }, "connect"),
            sendMessage: nativeLike(function sendMessage(){ throw new Error("Could not establish connection. Receiving end does not exist."); }, "sendMessage")
          }
        });
      }
    } catch(e){}
  })();
  // ---- 网络信息 ----
  (function(){
    const C = P.connection;
    if (!C) return;
    const mk = () => {
      const o = {
        effectiveType: C.effectiveType, rtt: C.rtt, downlink: C.downlink,
        saveData: C.saveData, type: C.type,
        downlinkMax: Infinity,
        addEventListener: nativeLike(function addEventListener(){}, "addEventListener"),
        removeEventListener: nativeLike(function removeEventListener(){}, "removeEventListener"),
        dispatchEvent: nativeLike(function dispatchEvent(){ return true; }, "dispatchEvent")
      };
      try {
        Object.defineProperty(o, "onchange", { configurable: true, enumerable: true, writable: true, value: null });
      } catch(e){}
      return o;
    };
    const inst = mk();
    def(NAV, "connection", () => inst);
    try { def(NAV, "mozConnection", () => inst); } catch(e){}
    try { def(NAV, "webkitConnection", () => inst); } catch(e){}
  })();
  const SCR = Screen.prototype;
  def(SCR, "width", () => P.screen.width);
  def(SCR, "height", () => P.screen.height);
  def(SCR, "availWidth", () => P.screen.availWidth);
  def(SCR, "availHeight", () => P.screen.availHeight);
  def(SCR, "colorDepth", () => P.screen.colorDepth);
  def(SCR, "pixelDepth", () => P.screen.pixelDepth);
  def(window, "devicePixelRatio", () => P.screen.devicePixelRatio);
  // 窗口尺寸必须恒满足 inner <= outer <= screen，且 outer-inner 只能是窗口边框（几十像素）。
  // guest 里 innerWidth 会随宿主布局变化，所以 outer 用 getter 实时按当前 inner 换算。
  (function(){
    const ow = () => Math.min(P.screen.width, (window.innerWidth || 0) + 16);
    const oh = () => Math.min(P.screen.availHeight, (window.innerHeight || 0) + 120);
    try { Object.defineProperty(window, "outerWidth", { configurable: true, enumerable: true, get: nativeLike(function(){ return ow(); }, "get outerWidth") }); } catch(e){}
    try { Object.defineProperty(window, "outerHeight", { configurable: true, enumerable: true, get: nativeLike(function(){ return oh(); }, "get outerHeight") }); } catch(e){}
    // innerWidth/innerHeight 保持真实：webview 内容区就是真实尺寸，改它会让页面布局错乱
  })();
  // ---- 时区 / Date 全套一致 ----
  // 站点不会只看 resolvedOptions().timeZone：它会拿 getTimezoneOffset、toString、
  // toLocaleString、getHours 四个来源交叉对账，任一处走系统时区就是穿帮。
  (function(){
    const tz = P.timezone, loc = P.locale || "zh-CN";
    if (!tz) return;
    const OrigDTF = Intl.DateTimeFormat;
    const pad = (n) => (n < 10 ? "0" : "") + n;
    const NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    const partsOf = (() => {
      // 缓存格式化器：日期字段 getter 会被页面高频调用，每次 new 一个 DTF 会把页面拖慢一个量级
      let F = null;
      return (date) => {
        try {
          if (!date || isNaN(date.getTime())) return null;
          if (!F) {
            F = new OrigDTF("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
              hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" });
          }
          const p = {};
          for (const it of F.formatToParts(date)) p[it.type] = it.value;
          return { year: +p.year, month: +p.month - 1, day: +p.day,
                   hour: +p.hour % 24, minute: +p.minute, second: +p.second,
                   weekday: Math.max(0, NAMES.indexOf(String(p.weekday).slice(0, 3))) };
        } catch (e) { return null; }
      };
    })();

    // 偏移必须取整：真实 Chrome 永远返回整数分钟，479.9949 这种值一眼就是改的
    const offsetOf = (date) => {
      const p = partsOf(date);
      if (!p) return 0;
      const asUTC = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
      return Math.round((Math.floor(date.getTime() / 1000) * 1000 - asUTC) / 60000);
    };

    // 时区长名交给 Intl，夏令时自动正确，不用硬编码
    const tzNameOf = (date) => {
      try {
        const it = new OrigDTF(loc, { timeZone: tz, timeZoneName: "long" }).formatToParts(date)
          .find((x) => x.type === "timeZoneName");
        return it ? it.value : "";
      } catch (e) { return ""; }
    };

    const offStr = (date) => {
      const m = -offsetOf(date);
      const sign = m >= 0 ? "+" : "-";
      const a = Math.abs(m);
      return "GMT" + sign + pad(Math.floor(a / 60)) + pad(a % 60);
    };

    const timeStr = (p) => pad(p.hour) + ":" + pad(p.minute) + ":" + pad(p.second);
    const dateEn = (p) => NAMES[p.weekday] + " " + MONTHS[p.month] + " " + pad(p.day) + " " + p.year;

    const D = Date.prototype;
    // ---- Date 构造 / Date.parse 的本地时间换算 ----
    // 只改 prototype 上的 getter 是不够的：new Date(2026, 9, 24, 19, 0) 和
    // new Date("2026-10-24T19:00:00")（不带时区）都按宿主时区解析，
    // 站点拿它跟 getTimezoneOffset 一对账就露馅。这里把构造路径也搬到档案时区。
    const OrigDate = Date;
    const DateUTC = OrigDate.UTC;
    const origParse = OrigDate.parse;

    // 本地时间 → epoch：先当真 UTC 猜一次，再用猜到的时刻查偏移修正一次（处理夏令时边界）
    // 注意符号：offsetOf 与 getTimezoneOffset 同号（UTC 减本地），所以是 guess + off，不是减。
    const localToEpoch = (y, mo, d, h, mi, s, ms) => {
      if (y >= 0 && y <= 99) y += 1900;
      const guess = DateUTC(y, mo, d, h || 0, mi || 0, s || 0, ms || 0);
      if (isNaN(guess)) return NaN;
      let off = offsetOf(new OrigDate(guess));
      let epoch = guess + off * 60000;
      const off2 = offsetOf(new OrigDate(epoch));
      if (off2 !== off) epoch = guess + off2 * 60000;
      return epoch;
    };

    // ISO 日期时间串（无时区后缀）拆成分量。按规范只有日期没有时间的写法按 UTC 解析，
    // 所以这里只接管「带时间但没写时区」的形式。
    const splitLocalString = (str) => {
      const t = String(str).trim();
      if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(t)) return null;
      const m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
      if (!m) return null;
      return [+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +(m[7] || 0) * (m[7] ? Math.pow(10, 3 - m[7].length) : 0)];
    };

    function PatchedDate(...args) {
      if (!new.target) {
        // Date() 当函数用只返回当前时间的字符串，行为不变
        return new OrigDate().toString();
      }
      if (args.length === 0) return new OrigDate();
      if (args.length === 1) {
        const a = args[0];
        if (typeof a === "string") {
          const p = splitLocalString(a);
          if (p) return new OrigDate(localToEpoch(p[0], p[1], p[2], p[3], p[4], p[5], p[6]));
          return new OrigDate(a);
        }
        // Date 对象入参会走 valueOf，和原生一致
        return new OrigDate(a);
      }
      return new OrigDate(localToEpoch(+args[0], +args[1], args.length > 2 ? +args[2] : 1,
        args.length > 3 ? +args[3] : 0, args.length > 4 ? +args[4] : 0,
        args.length > 5 ? +args[5] : 0, args.length > 6 ? +args[6] : 0));
    }
    PatchedDate.prototype = OrigDate.prototype;
    PatchedDate.now = OrigDate.now;
    PatchedDate.UTC = DateUTC;
    PatchedDate.parse = nativeLike(function parse(str){
      const p = typeof str === "string" ? splitLocalString(str) : null;
      return p ? localToEpoch(p[0], p[1], p[2], p[3], p[4], p[5], p[6]) : origParse.apply(OrigDate, arguments);
    }, "parse");
    try { Object.defineProperty(PatchedDate, "name", { value: "Date" }); } catch (e) {}
    try { Object.defineProperty(PatchedDate, "length", { value: 7 }); } catch (e) {}
    // 换了构造器就必须把它挂回 prototype.constructor，否则 (new Date).constructor === Date
    // 直接是 false —— 这是最省事的一行检测
    try {
      Object.defineProperty(OrigDate.prototype, "constructor", { value: PatchedDate, writable: true, configurable: true, enumerable: false });
    } catch (e) {}
    window.Date = nativeLike(PatchedDate, "Date");

    // 符号约定：getTimezoneOffset 返回「UTC 减本地」的分钟数，UTC+8 必须是 -480。
    // offsetOf 算的是「本地减 UTC」（+480），所以这里直接用，不能再取负。
    D.getTimezoneOffset = nativeLike(function getTimezoneOffset(){
      return isNaN(this.getTime()) ? NaN : offsetOf(this);
    }, "getTimezoneOffset");

    D.toString = nativeLike(function toString(){
      const p = partsOf(this);
      return p ? dateEn(p) + " " + timeStr(p) + " " + offStr(this) + " (" + tzNameOf(this) + ")" : "Invalid Date";
    }, "toString");

    D.toDateString = nativeLike(function toDateString(){
      const p = partsOf(this);
      return p ? dateEn(p) : "Invalid Date";
    }, "toDateString");

    D.toTimeString = nativeLike(function toTimeString(){
      const p = partsOf(this);
      return p ? timeStr(p) + " " + offStr(this) + " (" + tzNameOf(this) + ")" : "Invalid Date";
    }, "toTimeString");

    const dtf = (opts, l) => new OrigDTF(l || loc, Object.assign({ timeZone: tz }, opts));
    // toLocaleString 的原生默认是「日期 + 时间」，而 Intl.DateTimeFormat 的默认只有日期，
    // 直接透传会让 toLocaleString 少掉时分秒（2026/10/24 而不是 2026/10/24 19:36:59）。
    const FULL = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" };
    D.toLocaleString = nativeLike(function toLocaleString(l, o){
      if (isNaN(this.getTime())) return "Invalid Date";
      return dtf(Object.assign({}, FULL, o), l).format(this);
    }, "toLocaleString");
    D.toLocaleDateString = nativeLike(function toLocaleDateString(l, o){
      if (isNaN(this.getTime())) return "Invalid Date";
      return dtf(Object.assign({ year: "numeric", month: "numeric", day: "numeric" }, o), l).format(this);
    }, "toLocaleDateString");
    D.toLocaleTimeString = nativeLike(function toLocaleTimeString(l, o){
      if (isNaN(this.getTime())) return "Invalid Date";
      return dtf(Object.assign({ hour: "numeric", minute: "numeric", second: "numeric" }, o), l).format(this);
    }, "toLocaleTimeString");

    // getHours/getDate/getMonth/... 走的是系统时区，必须一起搬
    const FIELD = { FullYear: "year", Month: "month", Date: "day", Day: "weekday", Hours: "hour", Minutes: "minute", Seconds: "second" };
    Object.keys(FIELD).forEach(function (k) {
      const f = FIELD[k];
      D["get" + k] = nativeLike(function () {
        const p = partsOf(this);
        return p ? p[f] : NaN;
      }, "get" + k);
    });

    // 不带 timeZone 参数构造时默认就是系统时区，format 输出会跟 resolvedOptions 打架，
    // 所以构造阶段就把 profile 时区注入进去
    // 不带 timeZone 参数构造时默认就是系统时区，format 输出会跟 resolvedOptions 打架，
    // 所以构造阶段就把 profile 时区注入进去；但调用方显式指定了时区就必须让它生效，
    // 否则 new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Tokyo"}) 也返回上海，是明显破绽。
    const injected = new WeakSet();
    function PatchedDTF(locales, options) {
      const o = Object.assign({}, options || {});
      const auto = !o.timeZone;
      if (auto) o.timeZone = tz;
      const inst = new OrigDTF(locales || loc, o);
      if (auto) { try { injected.add(inst); } catch (e) {} }
      return inst;
    }
    PatchedDTF.prototype = OrigDTF.prototype;
    PatchedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf;
    try { Object.defineProperty(PatchedDTF, "name", { value: "DateTimeFormat" }); } catch (e) {}
    try { Object.defineProperty(PatchedDTF, "length", { value: 0 }); } catch (e) {}
    try {
      Object.defineProperty(OrigDTF.prototype, "constructor", { value: PatchedDTF, writable: true, configurable: true, enumerable: false });
    } catch (e) {}
    Intl.DateTimeFormat = nativeLike(PatchedDTF, "DateTimeFormat");

    const origResolved = OrigDTF.prototype.resolvedOptions;
    OrigDTF.prototype.resolvedOptions = nativeLike(function resolvedOptions() {
      const o = origResolved.call(this);
      // 只给被我们注入过时区的实例改写回报值，显式指定时区的实例原样放行
      if (!injected.has(this)) return o;
      try { Object.defineProperty(o, "timeZone", { value: tz, configurable: true, enumerable: true }); } catch (e) {}
      return o;
    }, "resolvedOptions");

    // ---- 其余 Intl 构造器与数字本地化 ----
    // navigator.language 改成了 en-US，但 new Intl.NumberFormat().resolvedOptions().locale
    // 还是系统的 zh-CN，(1234.5).toLocaleString() 出来还是 1,234.5 的中文分隔/数字形，
    // 站点把这两个一对比就知道语言是假的。这里把所有 Intl 构造器和数字本地化一起搬。
    const INTL = ["NumberFormat", "Collator", "PluralRules", "RelativeTimeFormat", "ListFormat", "Segmenter", "DisplayNames"];
    INTL.forEach(function (name) {
      const Orig = Intl[name];
      if (typeof Orig !== "function") return;
      const mark = new WeakSet();
      function Patched(locales, options) {
        const auto = locales === undefined || locales === null;
        const inst = new Orig(auto ? loc : locales, options);
        if (auto) { try { mark.add(inst); } catch (e) {} }
        return inst;
      }
      Patched.prototype = Orig.prototype;
      if (Orig.supportedLocalesOf) Patched.supportedLocalesOf = Orig.supportedLocalesOf;
      try { Object.defineProperty(Patched, "name", { value: name }); } catch (e) {}
      try { Object.defineProperty(Patched, "length", { value: 0 }); } catch (e) {}
      try {
        Object.defineProperty(Orig.prototype, "constructor", { value: Patched, writable: true, configurable: true, enumerable: false });
      } catch (e) {}
      Intl[name] = nativeLike(Patched, name);

      const origRO = Orig.prototype.resolvedOptions;
      if (typeof origRO === "function") {
        Orig.prototype.resolvedOptions = nativeLike(function resolvedOptions() {
          const o = origRO.call(this);
          if (!mark.has(this)) return o;
          try { Object.defineProperty(o, "locale", { value: loc, configurable: true, enumerable: true }); } catch (e) {}
          return o;
        }, "resolvedOptions");
      }
    });

    // (1234.5).toLocaleString() 默认走系统 locale，必须跟着档案走
    const origNumLocale = Number.prototype.toLocaleString;
    Number.prototype.toLocaleString = nativeLike(function toLocaleString(l, o) {
      return origNumLocale.call(this, l === undefined ? loc : l, o);
    }, "toLocaleString");
    const origBigLocale = typeof BigInt === "function" && BigInt.prototype.toLocaleString;
    if (origBigLocale) {
      BigInt.prototype.toLocaleString = nativeLike(function toLocaleString(l, o) {
        return origBigLocale.call(this, l === undefined ? loc : l, o);
      }, "toLocaleString");
    }
    const origCmp = String.prototype.localeCompare;
    String.prototype.localeCompare = nativeLike(function localeCompare(that, l, o) {
      return origCmp.call(this, that, l === undefined ? loc : l, o);
    }, "localeCompare");
    const origStrLocale = String.prototype.toLocaleLowerCase;
    const origStrUpper = String.prototype.toLocaleUpperCase;
    String.prototype.toLocaleLowerCase = nativeLike(function toLocaleLowerCase(l) {
      return origStrLocale.call(this, l === undefined ? loc : l);
    }, "toLocaleLowerCase");
    String.prototype.toLocaleUpperCase = nativeLike(function toLocaleUpperCase(l) {
      return origStrUpper.call(this, l === undefined ? loc : l);
    }, "toLocaleUpperCase");
  })();
  // ---- WebGL ----
  (function(){
    const patch = (proto) => {
      if (!proto) return;
      const gp = proto.getParameter;
      if (!gp) return;
      proto.getParameter = nativeLike(function getParameter(p){
        const ext = this.getExtension && this.getExtension("WEBGL_debug_renderer_info");
        if (ext && p === ext.UNMASKED_VENDOR_WEBGL) return P.webgl.vendor;
        if (ext && p === ext.UNMASKED_RENDERER_WEBGL) return P.webgl.renderer;
        if (p === 0x1F00) return P.webgl.vendor;
        if (p === 0x1F01) return P.webgl.renderer;
        return gp.call(this, p);
      }, "getParameter");
    };
    patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  })();
  // ---- Canvas 噪声 ----
  // 原实现拿到 ctx 后就地 putImageData 回源画布，等于把噪声永久写进了页面自己的画布：
  // 同一画布连续两次 toDataURL 结果不同、且视觉上真被改花。这里改成
  // 「复制到离屏画布 → 在副本上加噪 → 从副本导出」，源画布一个像素都不动。
  (function(){
    if (!P.canvasNoise) return;
    const seed = (function(){ let n = 0; for (const ch of P.seed) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return n || 1; })();
    // 噪声必须由「seed + 这块画布的内容」派生，不能用一个会推进的全局 PRNG：
    // 全局 PRNG 每导一次就往前走一步，同一画布连出两次结果不同，反而是最扎眼的信号。
    const hash3 = (a, b, c) => {
      let h = seed ^ 0x9e3779b9;
      h = (h ^ a) * 16777619 >>> 0;
      h = (h ^ b) * 16777619 >>> 0;
      h = (h ^ c) * 16777619 >>> 0;
      return h;
    };

    // 副本：同尺寸离屏画布，加完噪返回。内部一律用 origGetImageData，
    // 免得更噪时又被 getImageData 的坐标偏移叠一层。
    const noisedCopy = (src) => {
      try {
        if (!src || !src.width || !src.height) return null;
        const c = document.createElement("canvas");
        c.width = src.width; c.height = src.height;
        const cx = c.getContext("2d");
        if (!cx) return null;
        cx.drawImage(src, 0, 0);
        const n = Math.min(3, c.width), m = Math.min(3, c.height);
        const g = origGetImageData ? origGetImageData.call(cx, 0, 0, n, m) : cx.getImageData(0, 0, n, m);
        for (let i = 0; i < g.data.length; i += 4) {
          // 每个像素的位移只取决于它的原值、位置和档案种子 —— 同内容同结果
          const h = hash3(g.data[i] | (g.data[i + 1] << 8) | (g.data[i + 2] << 16), i, c.width * 31 + c.height);
          const d = (h % 3) - 1;
          if (d === 0) continue;
          g.data[i] = Math.max(0, Math.min(255, g.data[i] + d));
          g.data[i + 1] = Math.max(0, Math.min(255, g.data[i + 1] + ((h >>> 4) % 3) - 1));
        }
        cx.putImageData(g, 0, 0);
        return c;
      } catch (e) { return null; }
    };

    // 注意：包装函数不能与外层的原始方法同名。具名函数表达式会在函数体内建立同名绑定，
    // 把外层的 orig 遮蔽掉，action 里再调它就是调自己 —— 无限递归、栈溢出。
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = nativeLike(function toDataURL(){
      const c = noisedCopy(this);
      return origToDataURL.apply(c || this, arguments);
    }, "toDataURL");

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    if (origToBlob) {
      HTMLCanvasElement.prototype.toBlob = nativeLike(function toBlob(){
        const c = noisedCopy(this);
        return origToBlob.apply(c || this, arguments);
      }, "toBlob");
    }

    // getImageData 是读数路径，不能改源数据；按坐标做确定性偏移，同一像素每次读值恒定，
    // 不同位置不同 —— 这样批量取哈希的脚本拿到的仍是稳定的、可复现的另一组值。
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = nativeLike(function getImageData(x, y, w, h){
      const out = origGetImageData.apply(this, arguments);
      try {
        if (out && out.data && out.data.length) {
          const base = (Math.abs(Math.round(x || 0)) * 31 + Math.abs(Math.round(y || 0)) * 17 + (out.data.length | 0)) % 3;
          for (let i = 0; i < Math.min(out.data.length, 64); i += 4) {
            const d = ((i / 4 | 0) + base) % 3 ? 0 : (base - 1);
            out.data[i] = Math.max(0, Math.min(255, out.data[i] + d));
          }
        }
      } catch(e){}
      return out;
    }, "getImageData");
  })();
  // ---- Audio 噪声 ----
  // 原实现对同一个 Float32Array 反复 += delta，同一个缓冲区读三次就累加三次，
  // 探针一眼看出线性漂移。这里用 WeakSet 保证每个缓冲区只加一次噪声，之后恒定可复现。
  (function(){
    if (!P.audioNoise) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    const seedv = (function(){ let n = 7; for (const ch of P.seed) n = (n * 33 + ch.charCodeAt(0)) >>> 0; return n || 7; })();
    const delta = ((seedv % 1000) / 1e7) + 1e-7;
    const done = new WeakSet();
    AudioBuffer.prototype.getChannelData = nativeLike(function getChannelData(){
      const arr = origGetChannelData.apply(this, arguments);
      try {
        if (arr && arr.length && !done.has(arr)) {
          done.add(arr);
          arr[0] = arr[0] + delta;
          if (arr.length > 2) arr[2] = arr[2] + delta;
        }
      } catch(e){}
      return arr;
    }, "getChannelData");
  })();
  // ---- 媒体设备 / 语音 ----
  // deviceId/groupId 必须是「每个账号、每个 origin 内恒定」的：真实 Chrome 的 deviceId
  // 由 origin + 设备盐派生，每次刷新都在变是最明显的伪造痕迹，所以这里改成按档案种子派生。
  (function(){
    var seedHash = (function(){ let n = 5381; for (const ch of (P.seed || "x")) n = ((n * 33) ^ ch.charCodeAt(0)) >>> 0; return n; })();
    const md = navigator.mediaDevices;
    if (md && md.enumerateDevices && P.mediaDevices !== "off") {
      // 不能在 enumerateDevices 里返回自造普通对象：那样 instanceof MediaDeviceInfo 为 false，
      // 而且原实现把宿主真实设备名（"扬声器 (Realtek(R) Audio)"、显示器型号）直接透出去了 ——
      // 既泄漏本机硬件，又和档案语言对不上。改成保持原生实例、在原型上接管三个 getter。
      const orig = md.enumerateDevices.bind(md);
      const tag = new WeakMap();
      const deriveId = (kind, i, salt) => {
        let n = seedHash ^ (salt === "g" ? 0x85ebca6b : 0x27d4eb2f);
        const s = String(kind) + "#" + i + "#" + salt;
        for (let k = 0; k < s.length; k++) n = ((n * 33) ^ s.charCodeAt(k)) >>> 0;
        let out = "";
        for (let k = 0; k < 64; k++) { n = (n * 1103515245 + 12345) >>> 0; out += "0123456789abcdef"[(n >>> 16) & 15]; }
        return out;
      };
      const idxOf = (el) => {
        const hit = tag.get(el);
        if (hit !== undefined) return hit;
        try {
          const all = [...document.querySelectorAll("video,audio")];
          return all.indexOf(el) | 0;
        } catch (e) { return 0; }
      };
      const MDI = window.MediaDeviceInfo && window.MediaDeviceInfo.prototype;
      if (MDI) {
        Object.defineProperty(MDI, "deviceId", {
          configurable: true, enumerable: true,
          get: nativeLike(function () { return deriveId(this.kind, idxOf(this), "d"); }, "get deviceId")
        });
        Object.defineProperty(MDI, "groupId", {
          configurable: true, enumerable: true,
          get: nativeLike(function () { return deriveId(this.kind, idxOf(this), "g"); }, "get groupId")
        });
        // 未授权麦克风/摄像头时，真实 Chrome 的 label 一律是空串。留空既符合默认态，
        // 也不会把本机声卡/显示器型号写进指纹。
        Object.defineProperty(MDI, "label", {
          configurable: true, enumerable: true,
          get: nativeLike(function () { return ""; }, "get label")
        });
      }
      md.enumerateDevices = nativeLike(function enumerateDevices(){
        return orig().then(list => {
          if (P.mediaDevices === "block") return [];
          list.forEach((d, i) => { try { tag.set(d, i); } catch (e) {} });
          return list;
        });
      }, "enumerateDevices");
    }
    if (window.speechSynthesis && P.speechVoices !== "off") {
      const orig = speechSynthesis.getVoices.bind(speechSynthesis);
      speechSynthesis.getVoices = nativeLike(function getVoices(){
        if (P.speechVoices === "block") return [];
        return orig();
      }, "getVoices");
    }
  })();
  // ---- WebRTC 防泄漏 ----
  // 关键：构造函数必须能被 RTCPeerConnection.name 读回原名、toString() 读回 native，
  // 否则一个 name === "Patched" 就把整条注入链路卖干净了。
  (function(){
    if (P.webrtc !== "block") return;
    const origRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!origRTC) return;
    const Patched = function RTCPeerConnection(config, ...rest){
      try {
        const cfg = Object.assign({}, config || {});
        cfg.iceServers = [];
        cfg.iceTransportPolicy = "relay";
        return new origRTC(cfg, ...rest);
      } catch(e) { return new origRTC(config, ...rest); }
    };
    Patched.prototype = origRTC.prototype;
    try { Object.defineProperty(origRTC.prototype, "constructor", { value: Patched, configurable: true, writable: true }); } catch(e){}
    window.RTCPeerConnection = nativeLike(Patched, "RTCPeerConnection");
    window.webkitRTCPeerConnection = window.RTCPeerConnection;
  })();
  // ---- 顶层页面不得有 frameElement ----
  // 作为顶层文档时 Chrome 返回 null；webview 会把宿主 <webview> 元素暴露出来，
  // 站点拿 frameElement.tagName 就能读到 "WEBVIEW"。window 上定义失败就退到 Window.prototype。
  (function(){
    try {
      if (window.top !== window || !window.frameElement) return;
      const g = nativeLike(function(){ return null; }, "get frameElement");
      try {
        Object.defineProperty(window, "frameElement", { configurable: true, enumerable: true, get: g });
      } catch(e) {
        Object.defineProperty(Window.prototype, "frameElement", { configurable: true, enumerable: true, get: g });
      }
    } catch(e){}
  })();
  // ---- ClientRects 微噪声 ----
  (function(){
    if (!P.clientRectsNoise) return;
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = nativeLike(function getBoundingClientRect(){
      const r = orig.call(this);
      const e = 0.0001;
      try {
        Object.defineProperty(r, "x", { value: r.x + e, configurable: true });
        Object.defineProperty(r, "y", { value: r.y + e, configurable: true });
      } catch(err){}
      return r;
    }, "getBoundingClientRect");
  })();

}

module.exports = { installFingerprint };
