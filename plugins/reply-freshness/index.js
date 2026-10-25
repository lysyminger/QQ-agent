// 回复时机与引用（晚回 / 冷场）—— 确定性型插件（plugins/）
//
// 为什么是插件而不是技能：这件事必须**每轮都发生**，判据完全能写死
// （最新一条是几秒前、本批最早的一条是几分前、群里是不是安静了），
// 不需要模型理解人话，也不需要给它新工具。与 unread-recheck / cache-stability 同一接缝。
//
// ── 它解决的观感问题 ────────────────────────────────────────────────────
// 群聊刷得快 → 机器人思考期间群里又刷了一屏 → 它终于开口时，那句回复在时间上已经"脱节"。
// 真人遇到这种情况有两种自然处理，本插件就是把这两种做法明确告诉模型：
//   ① 晚回就引用："我特意回你刚才那句"（replyToMessageId），必要时补一句「刚看到」；
//   ② 冷场就闭嘴：群里没人说话了，别再把没读的旧消息一条条回完（自说自话，最像 AI）。
//
// ⚠️ 只做加法：不改核心提示词、不拦发言、不改人设；关掉本插件行为与从前完全一致。
// ⚠️ 注入位置：追加在最后一条 user 消息**末尾**（最易变区），不碰系统提示，
//    保证前缀缓存不受影响（与 unread-recheck / cache-stability 的约定一致）。

const DEFAULTS = {
  enabled: true,
  quietSeconds: 90,
  lateReplySeconds: 45,
  coldAdvice: true,
  announce: true,
  scanLimit: 40
};

let apiRef = null;

export function setup(api) {
  apiRef = api;
}

function cfg() {
  const raw = (apiRef && typeof apiRef.config === 'function' ? apiRef.config() : null) || {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    enabled: raw.enabled !== false,
    quietSeconds: num(raw.quietSeconds, DEFAULTS.quietSeconds, 20, 3600),
    lateReplySeconds: num(raw.lateReplySeconds, DEFAULTS.lateReplySeconds, 5, 1800),
    coldAdvice: raw.coldAdvice !== false,
    announce: raw.announce !== false,
    scanLimit: Math.round(num(raw.scanLimit, DEFAULTS.scanLimit, 5, 200))
  };
}

// ── 时序计算 ────────────────────────────────────────────────────────

const secsAgo = (now, ts) => Math.max(0, Math.round((now - (Number(ts) || now)) / 1000));

/** 人话时长：8 秒 / 3 分 12 秒 / 1 小时 5 分 */
export function agoText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  }
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

const clock = (ts) => {
  try {
    return new Date(Number(ts) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
};

/** 与核心 formatEntry 同口径的短标识：#mid 谁(QQ:xxx) */
function whoOf(entry) {
  const id = String(entry?.senderId ?? '');
  const name = entry?.senderName || id || '某人';
  return id && !String(name).includes(id) ? `${name}(QQ:${id})` : String(name);
}

/**
 * 采集本轮要做判断需要的事实。全部来自内存里的最近消息，不发请求。
 * @returns {null|object} 拿不到 store 时返回 null（不注入）
 */
export function timingOf({ store, chatKey, triggerEntries, selfNickname, now = Date.now(), scanLimit = 40 }) {
  if (!store || typeof store.recent !== 'function' || !chatKey) return null;
  let recent = [];
  try {
    recent = store.recent(chatKey, { limit: scanLimit }) || [];
  } catch {
    return null;
  }
  if (!recent.length) return null;

  const last = recent[recent.length - 1] || null;                       // 群里最新一条（可能是机器人自己）
  const lastOther = [...recent].reverse().find((m) => m && !m.self) || null;
  const batch = (Array.isArray(triggerEntries) ? triggerEntries : []).filter((m) => m && !m.self);
  const newestBatch = batch.length ? batch[batch.length - 1] : null;
  const oldestBatch = batch.length ? batch[0] : null;

  const nick = String(selfNickname || '').trim();
  const mentionsBot = Boolean(nick) && batch.some((m) => {
    const text = String(m?.text || '');
    return text.includes(nick) || (m?.reply?.sender && String(m.reply.sender).includes(nick));
  });
  const botSpokeLast = Boolean(last?.self);

  const sinceOther = lastOther ? secsAgo(now, lastOther.ts) : null;
  const sinceLast = last ? secsAgo(now, last.ts) : null;
  const isLatest = Boolean(newestBatch && last && String(newestBatch.mid) === String(last.mid)
    && String(newestBatch.senderId || '') === String(last.senderId || ''));
  const newestBatchAge = newestBatch ? secsAgo(now, newestBatch.ts) : null;
  const oldestBatchAge = oldestBatch ? secsAgo(now, oldestBatch.ts) : null;
  // 本批之后又来了多少条（这些通常由 unread-recheck 补进上下文）
  const newerCount = last ? recent.filter((m) => Number(m.ts) > Number(newestBatch?.ts || 0)).length : 0;

  return { recent, last, lastOther, batch, newestBatch, oldestBatch, mentionsBot, botSpokeLast, sinceOther, sinceLast, newestBatchAge, oldestBatchAge, newerCount, isLatest };
}

/** 组装给模型看的一小段时序提示。 */
export function buildBlock(t, { lateReplySeconds, coldAdvice, isPrivate = false, now = Date.now() } = {}) {
  if (!t || !t.newestBatch) return '';
  const L = [];
  L.push(`【本轮时序】现在 ${clock(now)}`);
  if (t.last) {
    L.push(`- 群里最新一条：#${t.last.mid ?? '?'} ${whoOf(t.last)}（${agoText(t.sinceLast)}前）`);
  }
  const head = `- 你要看的是 #${t.newestBatch.mid ?? '?'} ${whoOf(t.newestBatch)}（${agoText(t.newestBatchAge)}前）`;
  L.push(t.isLatest ? `${head} —— 它就是最新的` : `${head} —— 它之后群里又来了 ${t.newerCount} 条`);
  if (t.oldestBatchAge !== null && t.oldestBatchAge - t.newestBatchAge >= 30) {
    L.push(`- 这一批里最早的一条已经是 ${agoText(t.oldestBatchAge)}前的事了`);
  }

  const cold = !isPrivate && t.sinceOther !== null && t.sinceOther >= (t.quietSec ?? 0) && (t.botSpokeLast || !t.mentionsBot);
  const late = t.newestBatchAge !== null && t.newestBatchAge >= lateReplySeconds;
  if (cold) {
    L.push(`- 群里上一条别人的消息在 ${agoText(t.sinceOther)}前${t.botSpokeLast ? '，之后只有你说过话' : ''} —— 现在没人等你`);
  }
  if (t.mentionsBot) L.push('- 这一批里有人点名/直接问你');

  const actions = [];
  if (cold && coldAdvice) {
    // 冷场优先说"别回"；真要回也得带引用 —— 两条规则写在一句里，避免读成"快回它"
    actions.push('已经安静下来了：默认直接 finish（summary 写「群里已安静」），别为了清空未读继续回旧消息；确实有话要说才开口，那种情况也要带 replyToMessageId 引用你要回的那条');
  } else if (!t.isLatest) {
    actions.push(late
      ? `你要回的不是最新那条：send_message 带 replyToMessageId 引用它，并自然补一句衔接（「刚看到」「回一下上面」），别装作即时回应`
      : '你要回的不是最新那条：send_message 带 replyToMessageId 引用它');
  } else if (late) {
    actions.push(`这条已经过去 ${agoText(t.newestBatchAge)}：可以自然带一句「刚看到」，但不用刻意解释`);
  }
  if (actions.length) L.push(`→ ${actions.join('；')}。`);
  return L.join('\n');
}

// ── 钩子 ────────────────────────────────────────────────────────────

export const hooks = {
  /**
   * 核心把 messages 交给我们时，最后一条 user 消息就是提示词本体。
   * 只往它末尾追加一段时序提示，绝不删改任何已有内容（安全规则、工具协议都在里面）。
   */
  'before-llm-messages': (ctx = {}) => {
    const c = cfg();
    if (!c.enabled) return;
    const { messages, store, chatKey, triggerEntries, selfNickname, kind, proactive } = ctx;
    if (!Array.isArray(messages) || !messages.length) return;
    // 主动开口那一轮核心会明确邀请它说话，这里不要唱反调
    if (proactive) return;

    const now = Date.now();
    const isPrivate = String(kind || '').startsWith('private') || String(chatKey || '').startsWith('private:');
    const t = timingOf({ store, chatKey, triggerEntries, selfNickname, now, scanLimit: c.scanLimit });
    if (!t) return;
    const cold = !isPrivate && t.sinceOther !== null && t.sinceOther >= c.quietSeconds && (t.botSpokeLast || !t.mentionsBot);
    const t2 = { ...t, quietSec: c.quietSeconds };

    const block = c.announce ? buildBlock(t2, { lateReplySeconds: c.lateReplySeconds, coldAdvice: c.coldAdvice, isPrivate, now }) : '';
    // 即使不注入时序，冷场也该给一句刹车 —— 否则"安静时别硬接"这条纪律没有落点
    const brake = (!c.announce || isPrivate) && cold && c.coldAdvice
      ? `【本轮时序】群里已经安静 ${agoText(t.sinceOther)}，没人等你。默认别继续回旧消息，直接 finish（summary 写「群里已安静」）；除非有人点名或有非说不可的事。`
      : '';
    const text = [block, brake].filter(Boolean).join('\n');
    if (!text) return;

    const lastIdx = messages.length - 1;
    const m = messages[lastIdx];
    if (!m || typeof m.content !== 'string') return;
    m.content = `${m.content}\n\n${text}`;

    apiRef?.log?.(
      `回复时机：${chatKey} 最新=${t.last ? `#${t.last.mid}` : '?'}(${agoText(t.sinceLast)}前) `
      + `本批最新=${t.newestBatch ? `#${t.newestBatch.mid}` : '?'}(${agoText(t.newestBatchAge)}前) `
      + `${t.isLatest ? '就是最新' : `其后新增${t.newerCount}条`} ${cold ? '【安静→已给刹车】' : ''}`
    );
  }
};

export function available() {
  return { ok: true };
}

export function dispose() {
  apiRef = null;
}

/** 给测试用。 */
export const __internals = { timingOf, buildBlock, agoText, DEFAULTS };
