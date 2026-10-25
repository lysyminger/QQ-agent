// 表情包不解读（sticker-restraint）—— 确定性型插件
//
// ══════════════════════════════════════════════════════════════════════════
// 一、为什么是**插件**（plugins/，确定性型），不是技能（skills/）
// ══════════════════════════════════════════════════════════════════════════
// 按 skill-development.md §0 的三问判断法（README「扩展」一节同一口径：
// 「规则能写死 → 插件；要理解人话 → 技能」）：
//
//   第一问「触发时机能用 if 描述吗？」
//     if (模型正要调 get_message_images 去看一张表情包图 && 用户没明确让你看)  → ✅ 死条件
//     if (本轮有人发了表情包)                                                → ✅ 死条件
//     判定依据是媒体自带的字段（summary/url/kind），不依赖理解人话。
//   第二问「漏触发一次的代价是什么？」
//     漏一次 = 机器人又去解读表情包、冒出一句"这猫好可爱/这是什么梗"——
//     那正是本功能要禁止的行为，也就是说"漏一次"等于功能失效。→ 必须必然执行。
//   第三问「参数从哪来？」
//     会话、消息 id、媒体 summary/url/kind、本轮聊天文本 —— 全是系统给的。→ 插件
//
//   三问一致 → 插件。用 hooks 实现（钩子由核心在固定时机必然调用，
//   "要不要克制"不由模型决定）；提示词片段只负责把规矩讲清楚。
//
//   （为什么不声明 capabilities：plugin-development.md §5 —— 自建能力名核心不认识，
//     只有别的 Skill 会用 api.capability() 找它；本插件没有消费方，
//     声明了只会被审计报成"公开能力、暂无消费方"。所以只用 hooks。）
//
// ══════════════════════════════════════════════════════════════════════════
// 二、关键事实（读源码确认，决定了整个设计）
// ══════════════════════════════════════════════════════════════════════════
//   · 收消息时图片只渲染成 [图片] 占位（src/onebot.js segmentsToText），模型
//     **不会**自动看到图。唯一看图入口是核心工具 get_message_images
//     （tools.js:608，参数 messageId → store.findByMid → media[].url 下载成图片）。
//   · 所以"不主动评价表情包"最可靠的做法有两条腿：
//       ① 提示词：告诉它表情包只当语气（对"看图之后怎么写"生效）；
//       ② before-tool：它若想为了评论表情包而看图，直接把这次调用拦下
//          （返回 { block:true, reason }，orchestrator 把 reason 原样当工具结果回给模型）
//          —— 看不到图，就不可能描述图。
//   · 媒体判定只看系统给的字段：
//       kind === 'face'                     → QQ 表情
//       kind === 'sticker'                  → 表情
//       kind === 'image' 且 summary 是 [xxx] 且不是 [图片]  → 动图表情 / 带标签表情
//       url/file 命中 QQ 表情图床 / emoji / .gif            → 表情
//     summary 是 [图片] 的当成**照片/截图**，一律放行（不误伤正常看图）。
//   · 带语义标签的表情（[OK]/[好的]/[笑]）属于用户说的"有特殊含义"：拦下时把
//     标签原文喂给模型，让它按语气回应，而不是描述画面。
//
// ══════════════════════════════════════════════════════════════════════════
// 三、边界（任何情况都不会让对话出错）
// ══════════════════════════════════════════════════════════════════════════
//   · 所有 hook 全程 try/catch：本插件出问题只是"没生效"，绝不中断对话。
//   · 只读取上下文，不下载、不联网、不写任何文件、不碰别人的库
//     （permissions 为空；不认识图片字节，所以不需要网络）。
//   · 与插件 sticker-memory（表情包记忆库）互补不冲突：那张图若已有"已知含义"
//     （media.knownMeaning / 上下文里的[已知表情包：…]），说明它的含义已经明确，
//     本插件不拦（省得两套拦截互相打架）。
//   · 用户明确让你看 → 放行。识别方式：本轮文本里的"看图"类说法（见 ASK_PATTERNS）
//     + 可选的自定义关键词；另外"上一轮刚被拦下、这一轮用户说'看看/说说'"也算放行。
//   · 没有任何定时器/监听器：activate / deactivate 只清理会话缓存。

const PLUGIN_ID = 'sticker-restraint';

// 会话态缓存：sessionId/chatKey → { byMid, stickers, asked, blocked }
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export function available() {
  return true;
}

export function activate() {
  pruneSessions();
}

export function deactivate() {
  sessions.clear();
}

export function dispose() {
  sessions.clear();
}

// ── 钩子 ────────────────────────────────────────────────────────────────────

export const hooks = {
  /**
   * 组装提示词之前：认清本轮消息里哪些是表情包、用户有没有明确让看。
   * 只记录，不改任何消息内容（改文本会干扰核心的档位/关键词判定）。
   */
  'before-context': async ({ triggerEntries, store: chatStore, chatKey, sessionId }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      pruneSessions();

      const st = sessionState(sessionId, chatKey);
      if (chatStore && typeof chatStore.findByMid === 'function') st.store = chatStore;
      st.chatKey = String(chatKey || '');
      st.stickers.clear();

      const entries = Array.isArray(triggerEntries) ? triggerEntries : [];
      const texts = [];

      for (const entry of entries) {
        const mid = String(entry?.mid ?? '').trim();
        if (mid) st.byMid.set(mid, String(entry?.id ?? ''));
        const media = Array.isArray(entry?.media) ? entry.media : [];
        for (const m of media) {
          if (!isStickerMedia(m)) continue;
          st.stickers.set(mid || String(entry?.id ?? ''), {
            mid,
            localId: String(entry?.id ?? ''),
            label: labelOf(m),
            kind: String(m?.kind ?? 'image')
          });
        }
        if (entry?.text) texts.push(String(entry.text));
      }

      // 用户明确让你看？两种口径：本轮说了"看图"类的话，或上一轮刚被拦、这轮说"看看/说说"
      const asked = looksLikeExplicitAsk(texts.join('\n'), c);
      const followUp = st.blockedAt > 0 && (nowMs() - st.blockedAt < SESSION_TTL_MS) && looksLikeFollowUp(texts.join('\n'));
      st.asked = Boolean(asked || followUp);
    } catch (error) {
      warn(`before-context 判定失败（不影响对话）：${error?.message ?? error}`);
    }
  },

  /**
   * 发给模型之前：本轮确实有表情包时，附一句提醒（比常驻规则更贴身）。
   * 只改最后一条 user 消息，不动 system 里的核心规则。
   */
  'before-llm-messages': async ({ messages, chatKey, sessionId, triggerEntries }) => {
    try {
      const c = conf();
      if (!c.enabled || c.noteInPrompt === false) return;
      const st = sessionState(sessionId, chatKey);
      if (st.noted) return;                      // 每轮只附一次
      const stickers = [...st.stickers.values()];
      if (!stickers.length) return;

      const idx = lastUserIndex(messages);
      if (idx < 0) return;
      st.noted = true;
      st.stickers.clear();                       // 提醒已经写进提示词，后面看工具拦截即可

      const lines = ['【本轮表情包】本轮有人发了表情包：'];
      for (const s of stickers.slice(0, 6)) {
        const head = s.mid ? `消息 #${s.mid}` : '一条消息';
        const label = c.treatLabeledAsMeaning !== false && s.label ? `（${s.label}）` : '';
        lines.push(`- ${head}：${stickerKindText(s)}${label}`);
      }
      lines.push('按规矩只当作语气/态度来读，不要描述画面、不要解释梗；');
      lines.push(c.treatLabeledAsMeaning !== false
        ? '带标签的（如 [OK]、[好的]、[笑]）按标签理解，顺着这个语气回应就行。'
        : '不要主动谈论它。');
      if (st.asked) lines.push('（用户这轮似乎确实要你看图，那可以正常查看。）');
      appendToMessage(messages[idx], `\n\n${lines.join('\n')}`);
    } catch (error) {
      warn(`before-llm-messages 注入失败（不影响对话）：${error?.message ?? error}`);
    }
  },

  /**
   * 工具执行之前：真正的"不主动解读"在这里落地 ——
   * 模型若为了评论表情包而调 get_message_images，直接拦下，并把"这只是语气"
   * 连同标签一起当工具结果给它（它没看到图，自然就不会描述图）。
   */
  'before-tool': async ({ toolName, argsRaw, chatKey, sessionId }) => {
    try {
      const c = conf();
      if (!c.enabled || c.blockViewOnSticker === false) return;
      if (shortToolName(toolName) !== 'get_message_images') return;

      const st = sessionState(sessionId, chatKey);
      const args = safeParse(argsRaw) || {};
      const mid = String(args.messageId ?? args.message_id ?? '').trim();
      if (!mid) return;

      const record = findChatEntry(st, mid);
      const media = (Array.isArray(record?.media) ? record.media : [])
        .filter((m) => m && (m.kind === 'image' || m.kind === 'sticker' || m.kind === 'face'));
      if (!media.length) return;

      // 有"已知含义"（表情包记忆库给的）或普通照片 → 不拦，交给它们自己处理
      const hasKnown = media.some((m) => String(m?.knownMeaning ?? '').trim());
      const photos = media.filter((m) => !isStickerMedia(m));
      if (hasKnown || photos.length) return;

      const stickers = media.map((m) => ({ label: labelOf(m), kind: String(m.kind ?? 'image') }));
      if (st.asked) {
        // 用户明确让看 → 放行，但记一下"用户点名了"，供后续判断
        st.namedView = mid;
        return;
      }

      st.blockedAt = nowMs();
      const list = stickers.slice(0, 4).map((s) => {
        const label = c.treatLabeledAsMeaning !== false && s.label ? `（标签：${s.label}）` : '';
        return `${stickerKindText(s)}${label}`;
      }).join('、');

      return {
        block: true,
        reason: `系统：这次不用看图 —— 消息 #${mid} 里是表情包（${list}）。`
          + '表情包只当作语气/态度来读：请直接顺着它的语气回一句，'
          + '不要描述画面内容、不要解释梗、不要点评它像什么。'
          + (c.treatLabeledAsMeaning !== false && stickers.some((s) => s.label)
            ? '带标签的直接按标签理解即可。'
            : '')
          + '如果用户确实明确要你看这张图（例如说“看看这张图”“这表情什么意思”），下一轮再调用即可。'
      };
    } catch (error) {
      warn(`before-tool 拦截判定失败（放行，不影响对话）：${error?.message ?? error}`);
      return;
    }
  }
};

// ── 判定：什么算表情包 ──────────────────────────────────────────────────────

/** 表情包/表情图判定。只看系统给我们的字段，不做任何下载。 */
function isStickerMedia(m) {
  if (!m || typeof m !== 'object') return false;
  const kind = String(m.kind ?? '');
  if (kind === 'face' || kind === 'sticker') return true;
  if (kind !== 'image') return false;

  // ① 最强信号：OneBot 对表情/动图表情给的 summary 标记（[动画表情] 等），
  //    而照片是 [图片] —— 这一条就区分开了绝大多数情况
  const label = labelOf(m);
  if (label && !/^图片$|^照片$|^截图$|^image$/i.test(label)) return true;

  // ② QQ 表情图床 / 表情字样 / 动图
  const src = `${m.url ?? ''} ${m.file ?? ''}`;
  if (/qq_expression|gxh\.vip\.qq\.com|[/_-]emoji|表情/i.test(src)) return true;
  if (/\.gif\b/i.test(src)) return true;   // 注意用 \b：src 是 url 与 file 拼接的，末尾常有空格

  return false;
}

/** 取 summary 标签（去掉方括号）；没有就返回空串。 */
function labelOf(m) {
  const raw = String(m?.summary ?? '').trim();
  const mm = /^\[([^\]]+)\]$/.exec(raw);
  return mm ? mm[1].trim() : '';
}

function stickerKindText(s) {
  if (String(s?.kind) === 'face') return '一个 QQ 表情';
  if (s?.label === '动画表情') return '一个动图表情';
  return '一个表情包';
}

// ── 判定：用户有没有明确让你看 ──────────────────────────────────────────────

// 注意：宁可放宽（放行），也不要漏判 —— 用户明确要求看图却被拦才是真打扰。
const ASK_PATTERNS = [
  /(看|瞧|瞅|读|认|描述|解释|讲讲|说说|分析|识别|评价|翻译)[^。！？\n]{0,8}(图|图片|照片|截图|表情包|表情|动图|gif)/i,
  // 语序反过来的也要认（"这张图描述一下""表情包解释解释"）
  /(图|图片|照片|截图|表情包|表情|动图)[^。！？\n]{0,6}(描述|解释|讲讲|说说|分析|翻译|认认|看一下|看看|看下)/i,
  /(这|那)(张|个|条)?\s*(图|图片|照片|截图|表情包|表情|动图)[^。！？\n]{0,6}(什么|啥|咋|怎么)/i,
  /(图|图片|照片|截图|表情包|表情|动图)[^。！？\n]{0,6}(什么意思|啥意思|什么梗|什么含义|啥梗|是什么|画的是|里面是)/i,
  /(图里|图中|图片里|图上|表情包里|表情里|画的是)/i
];

/** 本轮文本里有没有"明确让你看图"的说法。 */
function looksLikeExplicitAsk(text, c) {
  const s = String(text ?? '');
  if (!s) return false;
  if (ASK_PATTERNS.some((re) => re.test(s))) return true;
  const extra = String(c?.extraAskKeywords ?? '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  return extra.some((k) => s.includes(k));
}

/** 上一轮刚被拦下、这一轮用户补一句"看看/说说"——也算明确让你看。 */
function looksLikeFollowUp(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 30) return false;
  return /^(好|嗯|对|是|行|可以)?[\s，,]*(看|看看|看下|看一下|读|读一下|说说|讲讲|解释|描述|评价|认认)/.test(s);
}

// ── 会话态 ──────────────────────────────────────────────────────────────────

function sessionState(sessionId, chatKey) {
  const key = `${sessionId || ''}::${chatKey || ''}`;
  let st = sessions.get(key);
  if (!st) {
    st = {
      at: nowMs(), chatKey: String(chatKey || ''), store: null,
      byMid: new Map(), stickers: new Map(), asked: false,
      blockedAt: 0, namedView: '', noted: false
    };
    sessions.set(key, st);
  }
  st.at = nowMs();
  return st;
}

function pruneSessions() {
  const cut = nowMs() - SESSION_TTL_MS;
  for (const [k, st] of sessions) {
    if (!st || st.at < cut) sessions.delete(k);
  }
  if (sessions.size > 200) {
    const keys = [...sessions.keys()].slice(0, sessions.size - 200);
    for (const k of keys) sessions.delete(k);
  }
}

/** 按消息 id 找到存档条目（本插件不导入核心模块，全靠钩子给的 store）。 */
function findChatEntry(st, mid) {
  const key = String(mid ?? '').trim();
  if (!key) return null;
  const storeApi = st?.store;
  if (!storeApi?.findByMid) return null;
  try {
    const localId = st.byMid.get(key);
    if (localId && typeof storeApi.findByLocalId === 'function') {
      const byLocal = storeApi.findByLocalId(st.chatKey, localId);
      if (byLocal) return byLocal;
    }
  } catch { /* 落到按 mid 查 */ }
  try {
    return storeApi.findByMid(st.chatKey, key) || null;
  } catch {
    return null;
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function shortToolName(toolName) {
  const s = String(toolName || '');
  const idx = s.lastIndexOf('__');
  return idx >= 0 ? s.slice(idx + 2) : s;
}

function safeParse(text) {
  try {
    const v = JSON.parse(String(text ?? '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/** 往一条消息追加文本（content 可能是字符串或 parts 数组，两种都要照顾）。 */
function appendToMessage(message, text) {
  if (!message) return;
  if (typeof message.content === 'string') { message.content += text; return; }
  if (Array.isArray(message.content)) {
    const last = message.content[message.content.length - 1];
    if (last && last.type === 'text') last.text = `${last.text ?? ''}${text}`;
    else message.content.push({ type: 'text', text: String(text).trim() });
  }
}

function conf() {
  try { return cfg() || {}; } catch { return {}; }
}

function nowMs() {
  return Date.now();
}

function warn(msg) {
  try { log(`[${PLUGIN_ID}] ${msg}`); } catch { /* 日志失败不影响对话 */ }
}

/** 排障/测试用。**故意不放进 providers**（plugin-development.md §5：无消费方不声明能力）。 */
export const internals = {
  isStickerMedia,
  labelOf,
  looksLikeExplicitAsk,
  looksLikeFollowUp,
  stickerKindText,
  findChatEntry,
  sessionState,
  sessions,
  ASK_PATTERNS
};
