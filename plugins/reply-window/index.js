// 接话窗口 —— 确定性型插件（plugins/），提供 message.follow-up-v2 能力。
//
// ── 它解决什么 ────────────────────────────────────────────────────────────
//   原来的触发规则只有三种："被 @ 了"、"命中关键词"、"随机概率砸中"。
//   于是有个特别扎眼的断档：
//     机器人问「你早上吃了什么」→ 群友答「油条豆浆」→ 机器人**再也不吭声**。
//   对方这句话既没 @ 它、也不含关键词，核心判定为"未触发"，
//   消息被直接标已读、不建会话、不调模型 —— 对话就断在这里。
//
//   本插件给出的规则是**时间窗 + 对象**，不是关键词：
//     · 机器人刚刚说完话 → 给它刚才回应的那个（些）人开一个短窗口；
//     · 窗口内这个人再说的话，即使什么都不带，也判定为"在跟它说话"；
//     · 它每次回应窗口里的消息，窗口续期；接满 maxFollowUps 次后收回。
//
// ── 为什么必须是插件，不能写成技能（skills/）────────────────────────────
//   判据是**决定在什么时刻被做出**，不是"聪不聪明"：
//   "这条消息要不要响应"这个决定，是核心的 onIncoming 同步做出的
//   （src/orchestrator.js 的 #followUpHit → #capFirst('message.follow-up-v2')），
//   那时**还没有任何 LLM 回合在跑** —— 模型没有机会参与，也不可能有。
//   能插进这个时刻的只有"同步返回一个结果"的确定性模块，也就是插件。
//   反过来，把它注册成 skills/ 里的工具会**静默失效**：模型根本看不到
//   "要不要接这句话"这件事可做，功能表现为"不报错、就是没反应"。
//
//   ⚠️ 前车之鉴：plugins/short-followup 早就声明了 message.follow-up 能力，
//      而**核心从来没有取用过这个名字** —— 它一直在空转（装了跟没装一样）。
//      本插件配合的那次核心改动，就是补上这个缺失的取用点。
//
// ── 与核心的接口（唯一约定，改这里等于改契约）────────────────────────────
//   核心入参：{ chatKey, triggerEntries, selfId }
//     · chatKey       会话键（group:<群号> / private:<QQ号>）
//     · triggerEntries 本次要判定的消息数组（onIncoming 时长度为 1）
//     · selfId        机器人自己的 QQ 号（用户引用别人的话时用来排除误判）
//   返回值：{ shouldRespond: true, reason, senderId } → 该接这句话
//           null                                    → 不干预，按原规则走
//
//   ⚠️ 必须是**同步**返回值（核心不 await 它）；写成 async 等于返回 undefined。
//
// ── 不误伤的设计（这些案例都刻意不做）────────────────────────────────────
//   · 群友 @ 了它      → 本来就会触发，不重复计数（交给原规则，理由也该是"被艾特"）
//   · 群友引用别人的话 → 那是他跟第三方的对话，不抢话
//   · 别人插一句       → 没跟它说过话的人没有窗口，不会被接
//   · 机器人自己发的   → 跳过（entry.self），避免自己跟自己对话
//   · 窗口之前的旧消息 → 用**本地到达序号**（entry.id）挡掉，不把历史消息"翻新"成接话
//     （⚠️ 不能用 QQ 给的时间戳或消息 id 排序，两者实测都不可靠，见下方 #afterBoundary）
//
//   本模块不写任何磁盘文件，全部状态只在内存里（重启即清空）。

const CAP_PRIMARY = 'message.follow-up-v2';
const CAP_LEGACY = 'message.follow-up';       // 兼容只认旧名字的核心
const CAP_STATE = 'message.follow-up-state';

const MAX_WINDOWS = 2000;                     // 内存上限（超出按最早插入淘汰）

/** 引用块里的 QQ 号，形如 [引用 张三(QQ:123456)：原文]。 */
const QUOTE_QQ_RE = /\[引用[^\]]*?\(QQ:(\d+)\)/u;
/** 拍一拍（这类消息不算"接话"，没有实质内容）。 */
const POKE_RE = /^\[拍一拍\]/u;

/**
 * 一个"接话窗口"。
 *
 * 粒度是 (群, 人)：机器人在这群里回应了谁，就给谁开窗。
 * 故意不做成"整群开窗" —— 那会让群里任何一个陌生人的闲话都把机器人叫起来。
 */
class ReplyWindow {
  constructor({ now = () => Date.now(), settings = () => ({}) } = {}) {
    this.now = now;
    this.settings = settings;
    this.windows = new Map();   // "<chatKey>|<senderId>" -> window
    this.senders = new Map();   // "<chatKey>|<sessionId>" -> [senderId]（本轮回应过的人）
  }

  #s() { try { return this.settings() || {}; } catch { return {}; } }

  #num(key, dflt, min, max) {
    const raw = Number(this.#s()[key]);
    const v = Number.isFinite(raw) ? raw : dflt;
    return Math.max(min, Math.min(max, v));
  }

  #ttlMs() { return this.#num('ttlMinutes', 3, 0.5, 120) * 60_000; }

  enabled() { return this.#s().enabled !== false; }

  key(chatKey, senderId) { return `${chatKey}|${senderId}`; }

  /** 清掉过期窗口。所有入口先调用它，退出即回收。 */
  prune() {
    const t = this.now();
    for (const [k, w] of this.windows) if (w.until <= t) this.windows.delete(k);
  }

  /**
   * 这条消息有没有"实质内容"。
   * 纯 @ / 纯引用块 / 拍一拍 / 空白都不算 —— 否则对方随手拍一下就会被接话。
   */
  meaningful(entry) {
    if (!entry || entry.self || !entry.senderId) return false;
    if (Array.isArray(entry.media) && entry.media.length) return true;   // 发图/表情也算说话
    let text = String(entry.text || '');
    text = text.replace(/\[CQ:at,[^\]]*\]/g, '');
    if (POKE_RE.test(text.trim())) return false;
    for (const name of (entry.atNames || [])) if (name) text = text.split(name).join('');
    // 剥掉开头的引用块（对方引别人/引机器人说话都算"有内容"，
    // 但引用块里的名字不能当正文 —— 名字里恰好有空格时会误判为空）
    text = text.replace(QUOTE_QQ_RE, '').replace(/^\[引用[^\]]*\]/u, '');
    const min = this.#num('minChars', 1, 1, 200);
    return text.replace(/\s+/g, '').length >= min;
  }

  /** 这条消息引用的对象是不是第三方（是的话就不该接）。 */
  #quotesOther(entry, selfId) {
    const m = QUOTE_QQ_RE.exec(String(entry.text || ''));
    if (!m) return false;
    return Boolean(selfId) && m[1] !== String(selfId);
  }

  /**
   * 核心的判定入口：这条消息算不算"在接机器人的话"。
   * @returns {{shouldRespond:true, reason:string, senderId:string}|null}
   */
  eligible(chatKey, entry, selfId = '') {
    if (!this.enabled()) return null;
    if (!String(chatKey).startsWith('group:')) return null;    // 私聊恒响应，用不着窗口
    this.prune();
    if (!this.meaningful(entry)) return null;
    if (entry.atMe === true) return null;                      // 被 @ 了，交给原规则并说明理由
    if (Array.isArray(entry.atNames) && entry.atNames.length) return null;
    if (this.#quotesOther(entry, selfId)) return null;          // 在跟别人说话

    const w = this.windows.get(this.key(chatKey, entry.senderId));
    if (!w) return null;
    if (w.until <= this.now()) { this.windows.delete(this.key(chatKey, entry.senderId)); return null; }
    // 只认窗口打开**之后**的消息。判据必须用 entry.id —— 见下方说明。
    if (!this.#afterBoundary(entry, w)) return null;
    return { shouldRespond: true, reason: w.reason || '接话窗口', senderId: String(entry.senderId) };
  }

  /**
   * 这条消息是不是"发生在窗口边界那条消息之后"。
   *
   * ⚠️ 这里踩过一个真实的坑（2026-10-10 实测故障），判据被换过两次，别再改回去：
   *
   *   1. 最早用 `entry.ts` 和窗口边界的时间戳比较（`ts <= fromTs` 判掉）。
   *      错。QQ 给的消息时间戳 `event.time` 来自**发送者的设备时钟**，
   *      机器人自己发出的消息时间戳来自**本机时钟**，两个时钟互相独立。
   *      实测那台机器上两者能差 3 分钟以上，且偏差方向还不固定：同一次测试里
   *      @机器人的那条偏早 3.6 分钟、机器人自己发的偏晚 3.5 分钟。
   *      于是"刚被回复过的人接着说话"会因为 ts 比边界小而被判掉 —— 静默失效。
   *
   *   2. 后来改用 `entry.mid` 和边界消息的 mid 比较（以为群内序号单调递增）。
   *      也错。实测该群的 mid 在 10 条消息里违反单调 4 次
   *      （从 -1357522930 到 -1937700580 毫无规律），根本不是递增序号。
   *
   *   3. 现在只用 `entry.id`：**本地到达序号**，由核心入库时递增分配。
   *      它是唯一 100% 可靠、且与任何外部时钟无关的顺序依据
   *      （同一存档内实测 10 条消息 0 次违反）。
   *      插件只可能在同一个群的条目之间比较（窗口按 (群, 人) 隔离），
   *      所以 "id 更大 = 来得更晚 = 是新的接话" 成立。
   *
   * 拿不到 id 时返回 null（不开窗），避免把历史消息翻新成接话。
   */
  #afterBoundary(entry, w) {
    const id = Number(entry?.id);
    const bound = Number(w.fromId);
    if (!Number.isFinite(id) || !Number.isFinite(bound)) return false;
    return id > bound;
  }

  /**
   * 记下"这一轮机器人回应了谁"（before-context 里调，会话开始时一次）。
   * 主动机会（冷场开话题等）默认不开窗 —— 那种话不是对某个人说的。
   */
  beginTurn({ chatKey, sessionId, triggerEntries = [], proactive = false } = {}) {
    if (!this.enabled() || !String(chatKey).startsWith('group:')) return;
    if (proactive && this.#s().openOnOwnInitiative !== true) return;
    const ids = [];
    for (const e of triggerEntries) {
      if (!e || e.self || !e.senderId) continue;
      const id = String(e.senderId);
      if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length) return;
    // fromEntry = 这一批里最后一条他人消息：窗口只认比它更晚的消息。
    let fromEntry = null;
    for (const e of triggerEntries) if (e && !e.self && e.senderId) fromEntry = e;
    this.senders.set(`${chatKey}|${sessionId}`, {
      chatKey, senderIds: ids, proactive: Boolean(proactive), fromEntry
    });
    while (this.senders.size > 512) this.senders.delete(this.senders.keys().next().value);
  }

  /**
   * 机器人真的发出话了 → 开窗 / 续期。
   * @param {object} turn beginTurn 记下的那一轮
   * @param {number} sentCount 这一轮实际发出的消息条数
   */
  opened(turn, sentCount, fromEntry = null) {
    if (!this.enabled() || !(sentCount > 0)) return;
    const now = this.now();
    const ttl = this.#ttlMs();
    const cap = this.#num('maxFollowUps', 2, 0, 20);
    // 窗口只认"比这条边界消息更晚"的消息，边界写成**本地到达序号 id**
    // （理由见 #afterBoundary：mid 和 ts 都实测不可靠）。
    // ⚠️ 这个边界必须写进窗口对象里 —— 少了它（undefined），边界检查会
    //    **静默失效**，几小时前的历史消息会被当成"正在接话"。
    // ⚠️ 基准是**边界消息自己的 id**，不是"现在"：触发消息和被接的那句话
    //    完全可能同秒到达，拿 now 当基准会把真正要接的那条判掉。
    const bId = Number.isFinite(Number(fromEntry?.id)) ? Number(fromEntry.id) : null;
    for (const senderId of turn.senderIds) {
      const k = this.key(turn.chatKey, senderId);
      const prev = this.windows.get(k);
      if (prev) {
        // cap = 0 表示不限次（靠 TTL 收口）；否则接满即收回
        if (cap > 0 && prev.followUps >= cap) { this.windows.delete(k); continue; }
        prev.until = now + ttl;
        prev.openedAt = now;
        prev.followUps += 1;
        if (bId !== null) prev.fromId = bId;
        prev.reason = `接话窗口（${turn.proactive ? '主动起话题后' : '刚回复过'}，第 ${prev.followUps + 1} 次）`;
        continue;
      }
      this.windows.set(k, {
        chatKey: turn.chatKey, senderId, until: now + ttl, openedAt: now, followUps: 0,
        fromId: bId,
        reason: turn.proactive ? '接话窗口（主动起话题后）' : '接话窗口（刚回复过你）'
      });
    }
    while (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value);
  }

  /** 这一轮记下的对象（after-response 用）。 */
  turn(chatKey, sessionId) { return this.senders.get(`${chatKey}|${sessionId}`) || null; }

  stats() {
    this.prune();
    return { enabled: this.enabled(), windows: this.windows.size, turns: this.senders.size };
  }

  clear() { this.windows.clear(); this.senders.clear(); }
}

// ── 核心与插件的接线 ───────────────────────────────────────────────────────
let api = null;
const wins = new Map();     // sessionId -> 每条已发消息的文本（用于"他名字被点到没"）
const replyWindow = new ReplyWindow({ settings: () => api?.config?.() || {} });

export function setup(a) { api = a; }
export function available() { return { ok: true }; }
export function dispose() { wins.clear(); replyWindow.clear(); }

export const providers = {
  // 主能力：核心在 onIncoming / 补判定 / 唤醒复算三处同步取用
  [CAP_PRIMARY]: ({ chatKey, triggerEntries = [], selfId = '' } = {}) => {
    for (const entry of triggerEntries) {
      const hit = replyWindow.eligible(chatKey, entry, selfId);
      if (hit) return hit;
    }
    return null;
  },
  // 状态能力：给"会话页/诊断"看窗口数用的，不参与判定
  [CAP_STATE]: () => replyWindow.stats()
};
// 旧名字只是别名：万一核心是只认 message.follow-up 的版本，也能用上。
providers[CAP_LEGACY] = providers[CAP_PRIMARY];

export const hooks = {
  /** 会话开始：记下"这一轮要回应谁"。 */
  'before-context'(ctx = {}) {
    try {
      if (!replyWindow.enabled()) return;
      if (!String(ctx.chatKey || '').startsWith('group:')) return;
      if (ctx.proactive && api?.config?.().openOnOwnInitiative !== true) return;
      replyWindow.beginTurn({
        chatKey: ctx.chatKey,
        sessionId: ctx.sessionId,
        triggerEntries: ctx.triggerEntries || [],
        proactive: Boolean(ctx.proactive)
      });
      wins.set(String(ctx.sessionId), []);
    } catch (error) { api?.warn?.('before-context 失败：%s', error?.message || error); }
  },

  /** 每轮请求前：如果这轮是"接话"，明确告诉模型它正在跟这个人连着聊。 */
  'before-llm-messages'(ctx = {}) {
    try {
      if (!replyWindow.enabled()) return;
      if (!Array.isArray(ctx.messages) || !ctx.messages.length) return;
      const sent = wins.get(String(ctx.sessionId));
      if (!sent || !sent.length) return;      // 还没说过话，不是接话（是第一轮）
      appendDynamicTail(ctx.messages,
        '【接话窗口】你刚在这个群里说过话，对方接着你的话又发了一条（没有 @ 你）。'
        + '这是你们正在进行的连续对话，直接自然地接下去；如果他明显是在跟别人说，也可以安静结束。');
    } catch (error) { api?.warn?.('before-llm-messages 失败：%s', error?.message || error); }
  },

  /**
   * 一轮结束：只有**真的发出了话**才开窗。
   * 用 session.sent 的长度增量判断，不信任工具返回值（发送可能被限频/去重拦掉）。
   */
  'after-response'(ctx = {}) {
    try {
      const sessionId = String(ctx.sessionId || ctx.session?.id || '');
      const sent = Array.isArray(ctx.session?.sent) ? ctx.session.sent : null;
      if (!sessionId || !sent) return;
      const seen = wins.get(sessionId) || [];
      const fresh = sent.slice(seen.length);
      if (!fresh.length) return;
      wins.set(sessionId, sent.map((s) => String(s?.text || '')));
      while (wins.size > 512) wins.delete(wins.keys().next().value);
      const entry = replyWindow.turn(ctx.chatKey, sessionId);
      if (!entry) return;
      replyWindow.opened(entry, fresh.length, entry.fromEntry);
      const s = api?.config?.() || {};
      api?.log?.('接话窗口已开：%s（%s）｜窗口 %s 分钟，本次最多再接 %s 句',
        entry.senderIds.join(','), entry.chatKey, s.ttlMinutes,
        Number(s.maxFollowUps) === 0 ? '不限' : s.maxFollowUps);
    } catch (error) { api?.warn?.('after-response 失败：%s', error?.message || error); }
  }
};

/** 把一段文本追加到最后一条 user 消息（核心没有提供 appendDynamicTail）。 */
function appendDynamicTail(messages, text) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') message.content += '\n\n' + text;
    else if (Array.isArray(message.content)) message.content.push({ type: 'text', text });
    else return false;
    return true;
  }
  return false;
}
