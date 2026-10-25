"use strict";

/**
 * 文案助手（对标产品的 zizi 模块）
 *
 * 干两件事：
 *   1) 提交前自检：把提示词里容易触发平台内容审核的词标出来并给替代写法，降低白跑一次额度的概率；
 *   2) 被判违规后生成申诉文案：按违规类型（涉政 / 涉黄 / 暴恐 / 侵权 / 其他）分别成文，
 *      带镜头信息与创作意图说明，可直接交给页面自动化去提交。
 *
 * 词表是思路示意，用户可以在设置里覆盖（settings.wording.extra）。
 * 命中不代表一定违规 —— 工具只做提示，不替用户改稿。
 */

const store = require("./store");

const RULES = [
  {
    key: "political",
    label: "政治敏感",
    pattern: /(领导人|国家主席|总理|政治局|示威|游行|暴动|政变|台独|藏独|疆独|法轮|六四|flg)/gi,
    suggest: "改为明确虚构的架空设定（如「某王国」「某星际联邦」），避免指向现实主体",
    appeal: "该内容为虚构世界观设定，人物与事件均为架空创作，不指向任何现实人物或事件。"
  },
  {
    key: "sexual",
    label: "色情低俗",
    pattern: /(裸体|全裸|露出|性交|做爱|性器|乳房|情色|艳照|露点|三陪|嫖|sm调教)/gi,
    suggest: "改用服装与氛围描述（「薄纱长裙/暖光/贴身剪裁」），不描写身体细节",
    appeal: "该内容为人物服装与光影氛围的艺术表现，未涉及裸露或性行为描写。"
  },
  {
    key: "violence",
    label: "暴力血腥",
    pattern: /(血腥|断肢|爆头|肢解|分尸|虐待|虐杀|自残|剖腹|割喉|血泊)/gi,
    suggest: "以动作张力替代伤口细节（「交锋」「倒地」「烟尘四起」）",
    appeal: "该画面为动作戏的戏剧张力表现，未展示伤口、血腥或虐待细节。"
  },
  {
    key: "real_person",
    label: "真实人物/肖像",
    pattern: /(刘德华|成龙|周杰伦|马斯克|特朗普|拜登|普京|泽连斯基|真人明星|某某明星)/g,
    suggest: "改为原创人物名，或明确「虚构角色」",
    appeal: "该人物为原创虚构角色，与任何现实人物无关。"
  },
  {
    key: "brand",
    label: "品牌/商标",
    pattern: /(耐克|阿迪达斯|苹果手机|iPhone|可口可乐|茅台|LV|Gucci|奔驰|宝马|特斯拉|华为)/gi,
    suggest: "去掉商标或改为无标识道具",
    appeal: "画面中的道具均为无标识通用物品，未使用任何商标元素。"
  },
  {
    key: "minor",
    label: "未成年人",
    pattern: /(儿童|幼童|小学生|未成年|萝莉|正太)/g,
    suggest: "涉及未成年角色时避免任何成人化描写，必要时改为成年角色",
    appeal: "该内容为合家欢题材，角色均为成年人或非人物形象。"
  },
  {
    key: "gamble_drug",
    label: "赌博毒品",
    pattern: /(赌博|赌场|下注|老虎机|吸毒|冰毒|大麻|海洛因|贩毒)/g,
    suggest: "改为抽象意象（「筹码状的光斑」「雾气」）",
    appeal: "该内容为抽象视觉意象，未表现赌博或毒品的使用过程。"
  }
];

function extraRules() {
  const w = (store.get().settings || {}).wording || {};
  const list = Array.isArray(w.extra) ? w.extra : [];
  return list.filter((x) => x && x.word).map((x) => ({
    key: "custom_" + String(x.word).slice(0, 6),
    label: x.label || "自定义",
    pattern: new RegExp(String(x.word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    suggest: x.suggest || "换一种说法",
    appeal: x.appeal || "该内容为正常创作，请复核。"
  }));
}

/** 提交前自检 */
function check(text) {
  const src = String(text || "");
  const hits = [];
  for (const rule of RULES.concat(extraRules())) {
    const m = src.match(rule.pattern);
    if (!m) continue;
    hits.push({
      key: rule.key,
      label: rule.label,
      words: [...new Set(m)].slice(0, 8),
      count: m.length,
      suggest: rule.suggest
    });
  }
  const score = hits.reduce((s, h) => s + h.count, 0);
  return {
    level: score === 0 ? "safe" : score <= 2 ? "warn" : "risky",
    score,
    hits
  };
}

/** 软替换（只替换最明确的几个词，其余保留原意） */
function soften(text) {
  let out = String(text || "");
  const map = [
    [/血腥/g, "凌厉"], [/虐杀/g, "制服"], [/裸体/g, "薄纱长裙"], [/性器/g, "衣饰"],
    [/断肢/g, "倒地"], [/爆头/g, "重击"], [/血泊/g, "尘土"], [/赌博/g, "博弈"], [/吸毒/g, "迷雾"]
  ];
  for (const [re, to] of map) out = out.replace(re, to);
  return out;
}

/** 页面文案判定违规类型 */
function classify(pageText) {
  const t = String(pageText || "");
  if (/(涉政|政治|敏感人物)/.test(t)) return "political";
  if (/(涉黄|色情|低俗|裸露)/.test(t)) return "sexual";
  if (/(暴力|血腥|恐怖|惊悚)/.test(t)) return "violence";
  if (/(侵权|版权|商标|肖像)/.test(t)) return "brand";
  if (/(未成年|儿童)/.test(t)) return "minor";
  return "other";
}

/**
 * 生成申诉文案
 * @param {object} opts {kind, shotTitle, prompt, intent}
 */
function appealScript(opts = {}) {
  const kind = String(opts.kind || "other");
  const rule = RULES.find((r) => r.key === kind);
  const tail = rule ? rule.appeal : "该内容为正常创作，未包含违规信息，请复核恢复。";
  const title = String(opts.shotTitle || "").trim();
  const prompt = String(opts.prompt || "").trim().slice(0, 160);
  const intent = String(opts.intent || "").trim();
  const lines = [
    "您好，本次生成被判定为不合规，申请人工复核。",
    title ? `镜头：${title}` : "",
    prompt ? `提示词：${prompt}` : "",
    intent ? `创作意图：${intent}` : "创作意图：商业广告分镜中的正常剧情镜头。",
    `说明：${tail}`,
    "我已阅读并遵守平台规范，如仍有不当之处请指出具体条款，我会立即修改。感谢！"
  ].filter(Boolean);
  return lines.join("\n");
}

/** 批量：给一组镜头做自检，返回需要处理的镜头 */
function checkShots(shots) {
  const out = [];
  for (const s of shots || []) {
    const r = check([s.videoPrompt, s.imagePrompt, s.scene].filter(Boolean).join("\n"));
    if (r.level !== "safe") out.push({ shotId: s.id, index: s.index, title: s.title, ...r });
  }
  return out;
}

module.exports = { check, soften, classify, appealScript, checkShots, RULES };
