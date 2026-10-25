// 模型路由 + 故障切换（学校免费网关 + DeepSeek 官方）
//
// ① 按难度路由：日常闲聊走免费主模型（学校网关 zjsru-*），判定为难题的会话走 DeepSeek 官方
//    （付费，用户 2026-10-18 同意："每次遇到困难的问题都给 deepseek，简单的给 qwen3.8 27b"）。
//    难度在 before-context 里按触发消息做确定性判定（零 token），按 sessionId 记下，
//    llm.endpoint-pick 时取用（核心会把 messages / context 一起传进来）。
// ② 熔断：端点失败一次，冷却期内改走备用 —— 官方失败 → 免费路由；免费主模型失败 → 另一个免费模型。
//    核心 chatCompletionWithRetry 的同模型重试会再次调用 endpoint-pick，所以第一次失败后重试那一发就切过去了。
//
// llm.endpoint-pick 只认第一个提供者，所以路由和熔断必须在同一个插件里。
import { getConfig } from '../../src/config.js';
import { logger } from '../../src/logger.js';

const FREE_HOST = /(^|\.)tokens\.zjsru\.edu\.cn$/i;
const ID_PRIMARY = 'zjsru-failover:primary';
const ID_FALLBACK = 'zjsru-failover:fallback';
const ID_HARD = 'zjsru-failover:hard';

// 跨热重载保留状态（热重载会 import 出新模块实例）
const G = globalThis.__zjsruFailover ??= { openUntil: 0, lastError: '' };
G.hardOpenUntil ??= 0;
G.decisions ??= new Map();
G.hardCalls ??= [];
G.picks ??= new Map();   // sessionId → { model, why, at }：给顶栏显示"这个会话实际走了哪个模型"

function remember(sessionId, model, why) {
  if (!sessionId) return;
  G.picks.set(String(sessionId), { model, why, at: Date.now() });
  for (const [k, v] of G.picks) if (Date.now() - v.at > 3600000) G.picks.delete(k);
}

let cfg = () => ({});

export function setup(api) {
  cfg = api.config;
}

function settings() {
  const c = cfg() || {};
  return {
    fallbackModel: String(c.fallbackModel || 'zjsru-DeepSeek-V4-flash-0731'),
    cooldownMinutes: Math.max(1, Number(c.cooldownMinutes) || 10),
    routerEnabled: c.routerEnabled !== false,
    hardBaseUrl: String(c.hardBaseUrl || 'https://api.deepseek.com').trim(),
    hardModel: String(c.hardModel || 'deepseek-flash').trim(),
    hardApiKey: String(c.hardApiKey || '').trim(),
    maxHardCallsPerHour: Math.max(0, Number(c.maxHardCallsPerHour ?? 40)),
    ownerAlwaysHard: c.ownerAlwaysHard !== false,
    freeFailoverToHard: c.freeFailoverToHard !== false
  };
}

function hostOf(baseUrl) {
  try { return new URL(String(baseUrl || '')).hostname; } catch { return ''; }
}

function hasImage(messages) {
  return (Array.isArray(messages) ? messages : []).some((m) => Array.isArray(m?.content)
    && m.content.some((p) => p?.type === 'image_url' || p?.type === 'video_url'));
}

// ── 难度判定（确定性、零 token） ─────────────────────────────────────────

const TECH = /```|报错|error|exception|bug|代码|函数|编译|脚本|python|java|c\+\+|javascript|sql|正则|算法|数据结构|公式|证明|计算|求解|方程|积分|概率|翻译成|论文|配置|linux|windows|nginx|docker|服务器|部署|数据库|git\b|npm|环境变量|端口|反向代理|安装/i;
const DEEP = /为什么|为啥|怎么|如何|原理|区别|对比|比较一下|分析|解释|推荐几|帮我(查|找|看|写|算|分析|想)|总结一下|写一(篇|段|个|首)|规划|攻略|建议|教程|靠谱吗|值得|求助|求教/;

// 卡片还原插件会把 B站视频卡片展开成「[图片]标题 ▶️播放 简介… 热门评论…」一大段，
// 那是别人转发的内容，不是在提问；不剔掉的话又长又杂，会被误判成难题
function ownWords(text) {
  const t = String(text || '').replace(/\[CQ:[^\]]*\]/g, ' ');
  if (/▶️|简介[:：]|热门评论|\[卡片消息\]|\[转发|合并转发/.test(t)) return '';
  return t.replace(/\[(图片|表情|视频|语音|文件)[^\]]*\]/g, ' ');
}

function classify(entries, ctx) {
  const mine = (entries || []).filter((e) => !e?.self);
  const text = mine.map((e) => ownWords(e.text)).join('\n').trim();
  const botName = String(getConfig().persona?.botName || '');
  const calledMe = mine.some((e) => e.atMe) || (botName && text.includes(botName)) || ctx.kind === 'private';
  const ownerIds = String(getConfig().skills?.['owner-identity']?.ids || '').split(/[,，\s]+/).filter(Boolean);
  const fromOwner = mine.some((e) => ownerIds.includes(String(e.senderId)));
  const asks = /[?？]|吗|呢|啥|什么|怎么|如何|为什么/.test(text);

  let score = 0;
  const why = [];
  if (TECH.test(text)) { score += 2; why.push('技术/计算'); }
  if (DEEP.test(text)) { score += 1; why.push('深入提问'); }
  if (asks && text.length >= 25) { score += 1; why.push('长问题'); }
  if (text.length >= 80) { score += 1; why.push('长消息'); }

  // 主人提问：要像个问题（"在吗""？"这种招呼不算），免得一句招呼也走付费
  const realQuestion = asks && text.replace(/@\S+|\s/g, '').length >= 6;
  if (calledMe && fromOwner && realQuestion && settings().ownerAlwaysHard) return { hard: true, why: '主人提问' };
  if (calledMe && score >= 2) return { hard: true, why: why.join('+') };
  if (score >= 3) return { hard: true, why: why.join('+') };
  return { hard: false, why: why.join('+') || '日常' };
}

function hardBudgetOk(s) {
  const hourAgo = Date.now() - 3600000;
  G.hardCalls = G.hardCalls.filter((t) => t > hourAgo);
  return G.hardCalls.length < s.maxHardCallsPerHour;
}

export const hooks = {
  'before-context'(ctx) {
    const s = settings();
    if (!s.routerEnabled || !s.hardApiKey || !ctx?.sessionId) return;
    const d = classify(ctx.triggerEntries, ctx);
    G.decisions.set(ctx.sessionId, { ...d, at: Date.now() });
    // 只保留最近一小时的判定
    for (const [k, v] of G.decisions) if (Date.now() - v.at > 3600000) G.decisions.delete(k);
    if (d.hard) logger.info('zjsru-failover', `难题 → ${s.hardModel}（${d.why}）：${String(ctx.triggerEntries?.at(-1)?.text || '').slice(0, 40)}`);
  }
};

export const providers = {
  'llm.endpoint-pick': ({ model, messages, context } = {}) => {
    const s = settings();
    const baseUrl = String(getConfig().api?.baseUrl || '');
    if (!FREE_HOST.test(hostOf(baseUrl))) return null;

    // 难题 → DeepSeek 官方（带图的请求不走：看图模型在核心里按 visionModel 另行替换，和官方端点对不上）
    const sid = String(context?.sessionId || '');
    const d = G.decisions.get(sid);
    const image = hasImage(messages);
    if (s.routerEnabled && d?.hard && s.hardApiKey && Date.now() >= G.hardOpenUntil && !image && hardBudgetOk(s)) {
      G.hardCalls.push(Date.now());
      remember(sid, s.hardModel, `难题：${d.why}`);
      return { id: ID_HARD, baseUrl: s.hardBaseUrl, apiKey: s.hardApiKey, model: s.hardModel };
    }

    // 日常 → 免费主模型。主模型熔断期间：用户同意（2026-10-18）先走 DeepSeek 官方，
    // 和难题共用每小时上限；超限 / 官方也熔断 / 带图时退回另一个免费模型
    const current = String(model || '');
    const visionModel = String(getConfig().api?.visionModel || current);
    if (!current || current === s.fallbackModel) { remember(sid, image ? visionModel : current, image ? '看图' : '备用模型'); return null; }
    if (Date.now() < G.openUntil) {
      if (s.freeFailoverToHard && s.hardApiKey && Date.now() >= G.hardOpenUntil && !image && hardBudgetOk(s)) {
        G.hardCalls.push(Date.now());
        remember(sid, s.hardModel, `${current} 故障，临时切换`);
        return { id: ID_HARD, baseUrl: s.hardBaseUrl, apiKey: s.hardApiKey, model: s.hardModel };
      }
      remember(sid, s.fallbackModel, `${current} 故障，临时切换`);
      return { id: ID_FALLBACK, baseUrl, model: s.fallbackModel };
    }
    remember(sid, image ? visionModel : current, image ? '看图' : (d?.hard ? '难题（付费上限已满，走免费）' : '日常'));
    return { id: ID_PRIMARY, baseUrl, model: current };
  },

  'llm.endpoint-feedback': ({ accountId, ok, status, error } = {}) => {
    const s = settings();
    if (accountId === ID_HARD) {
      if (ok) return;
      // 401 Key 无效 / 402 余额不足：短时间内不会自己好，熔断一小时并说清楚
      const longStop = status === 401 || status === 402;
      if (!longStop && status >= 400 && status < 500 && status !== 429) return;
      const minutes = longStop ? 60 : s.cooldownMinutes;
      G.hardOpenUntil = Date.now() + minutes * 60000;
      logger.warn('zjsru-failover', `DeepSeek 官方请求失败（${status === 402 ? '余额不足' : status === 401 ? 'API Key 无效' : String(error || status).slice(0, 80)}），${minutes} 分钟内难题也改走免费路由`);
      return;
    }
    if (accountId !== ID_PRIMARY) return;
    if (ok) {
      if (G.openUntil) logger.info('zjsru-failover', '主模型已恢复，切回');
      G.openUntil = 0;
      return;
    }
    // 4xx（除 429）是请求本身的问题，换模型也没用，不熔断
    if (status >= 400 && status < 500 && status !== 429) return;
    G.openUntil = Date.now() + s.cooldownMinutes * 60000;
    G.lastError = String(error || status || '').slice(0, 120);
    const target = s.freeFailoverToHard && s.hardApiKey && Date.now() >= G.hardOpenUntil ? `${s.hardModel}（付费）` : s.fallbackModel;
    logger.warn('zjsru-failover', `主模型请求失败（${G.lastError}），${s.cooldownMinutes} 分钟内改走 ${target}`);
  }
};

// 顶栏实时状态（核心 /api/status 收集 status.* 里带 route 字段的结果）
providers['status.zjsru-failover'] = () => {
  const s = settings();
  const api = getConfig().api || {};
  const now = Date.now();
  const daily = String(api.model || '');
  const freeDown = now < G.openUntil;
  const hardDown = now < G.hardOpenUntil;
  const hardOn = s.routerEnabled && Boolean(s.hardApiKey);
  const mins = (t) => Math.max(1, Math.ceil((t - now) / 60000));
  const hourAgo = now - 3600000;
  const paidThisHour = G.hardCalls.filter((t) => t > hourAgo).length;
  const freeTarget = s.freeFailoverToHard && hardOn && !hardDown ? s.hardModel : s.fallbackModel;

  const text = [
    freeDown ? `⚠ ${daily} 故障 → ${freeTarget}（${mins(G.openUntil)} 分后重试）` : `日常 ${daily}`,
    hardOn ? (hardDown ? `难题 ${s.hardModel} 故障（${mins(G.hardOpenUntil)} 分）` : `难题 ${s.hardModel}`) : ''
  ].filter(Boolean).join(' · ');
  const lines = [
    `日常：${daily}${freeDown ? `（故障中，临时走 ${freeTarget}）` : ''}`,
    `看图：${api.visionModel || daily}`,
    hardOn ? `难题：${s.hardModel}${hardDown ? '（故障中，临时走免费路由）' : ''}，本小时付费调用 ${paidThisHour}/${s.maxHardCallsPerHour}` : '难题：未开启（全部走免费路由）',
    `免费备用：${s.fallbackModel}`
  ];
  const running = [...G.picks].filter(([, v]) => now - v.at < 15 * 60000).map(([sessionId, v]) => ({ sessionId, model: v.model, why: v.why }));
  return {
    icon: '🧭',
    title: '模型路由',
    priority: 60,
    lines: lines.map((l) => { const i = l.indexOf('：'); return [l.slice(0, i), l.slice(i + 1)]; }),
    route: { text, running, lines }
  };
};
