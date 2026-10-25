// 网易云搜歌 —— 输入歌名，输出网易云音乐的歌曲 ID（确定性型，放 plugins/）
//
// ── 它干什么 ──────────────────────────────────────────────────────────
// 群里发「\歌id Don't Be So Serious」，机器人直接查网易云，回一条
// 「歌名 — 歌手 ｜ ID 123456789」的列表。用途：把 ID 交给群里别的点歌机器人、
// 精确分享某一版（同名的翻唱/现场太多）。
//
// ── 为什么走「指令直达」而不是让模型查 ─────────────────────────────────
// 这是个纯确定性的查询：用户已经把歌名写死在消息里，没有任何需要模型
// 理解的地方。走直达（plugin.json 的 commandOnly + commandRoute）的好处：
//   · 0 token、0 次模型调用 —— 查歌这种事不该烧钱
//   · 不会被模型"顺手改需求"（比如它觉得该回一张卡片）
//   · 结果格式稳定可预期
// 代价：必须带反斜杠（项目约定），不带 \ 的说法不会触发。
//
// ── 为什么参数要自己从消息原文取（不用路由给的 args）────────────────────
// 路由的参数提取规则是"只取第一个词"（src/skills/command-router.js 的
// restAfterCommand，为「\服务器 生存服 顺便看下天气」设计）。而歌名带空格
// 是常态 ——「Don't Be So Serious」会被截成 "Don't"，搜出来是另一堆歌。
// 所以这里用 fullBodyFrom() 从触发消息原文里取「歌id」之后的**全文**。
// （同款坑与修法见 plugins/pc-control-l3/index.js，2026-09-29。）
//
// ── 接口 ──────────────────────────────────────────────────────────────
// 网易云的公开搜索接口，无需登录、无需密钥：
//   主：POST https://music.163.com/api/cloudsearch/pc   （字段 ar/al，较新）
//   备：GET  https://music.163.com/api/search/get/      （字段 artists/album，较老）
// 两个接口都必须带 Referer: https://music.163.com/，否则可能被拒。
// 主接口失败（网络/结构变化）自动降级到备用接口，避免单点失效。

const DEFAULTS = {
  enabled: true,
  limit: 5,
  timeoutMs: 8000,
  maxPerMinute: 10,
  showAlbum: true
};

// 网易云对无 UA / 无 Referer 的请求比较敏感，两个头都要带
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://music.163.com/';
const ENDPOINT_PC = 'https://music.163.com/api/cloudsearch/pc';
const ENDPOINT_GET = 'https://music.163.com/api/search/get/';

/** 指令词（与 plugin.json 的 commands / commandRoute 保持一致）。
 *  ⚠️ 用「歌id」而不是「点歌」：本机 `skills/music` 的显示名就叫「点歌」（发音乐卡片），
 *  指令词撞名会让用户和模型都分不清"这次是要 ID 还是要卡片"。见 plugin.json 的 description。 */
const COMMAND = '歌id';

let cfgFn = () => ({});

/** 日志出口（setup 时由 api.log 注入）。必须先声明 —— ESM 严格模式下
 *  隐式全局赋值会直接 ReferenceError。 */
let log = () => {};

/** 最近一次查询（只用于状态卡展示，内存态，不落盘）。 */
let lastQuery = null;

/** 限频用的时间戳滑动窗口（每分钟）。 */
const hits = [];

function readSettings() {
  const c = cfgFn() || {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  return {
    enabled: c.enabled !== false,
    limit: num(c.limit, DEFAULTS.limit, 1, 10),
    timeoutMs: num(c.timeoutMs, DEFAULTS.timeoutMs, 1000, 60000),
    maxPerMinute: num(c.maxPerMinute, DEFAULTS.maxPerMinute, 1, 120),
    showAlbum: c.showAlbum !== false
  };
}

/**
 * 每分钟限频：返回 true = 放行（并记一次），false = 超限。
 * 用滑动窗口而不是固定桶 —— 固定桶在整点边界会让两倍流量挤进来。
 */
function takeRateSlot(now, maxPerMinute) {
  const win = 60_000;
  while (hits.length && now - hits[0] > win) hits.shift();
  if (hits.length >= maxPerMinute) return false;
  hits.push(now);
  return true;
}

// ── 测试/重置用 ────────────────────────────────────────────────────────
function resetRate() {
  hits.length = 0;
}

/**
 * 清洗用户输入的歌名。
 *
 * ⚠️ 剥首尾成对尖括号：提示文案里写的是 `\歌id <歌名>`（man page 风格），
 *    普通用户会把尖括号一起打进来 —— 于是搜的是 "<歌名>"，永远搜不到。
 *    pc-control-l3 就栽在这个坑上（2026-09-29 用户截图："无法将<识别为 cmdlet"）。
 *    只剭**首尾成对**的，不动歌名内部的括号（如 "We Are <Not> Alone"）。
 */
function cleanKeyword(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^[<\uFF1C\u300A\u300C\u3010]+/, '').replace(/[>\uFF1E\u300B\u300D\u3011]+$/, '');
  s = s.replace(/^[\s:\uFF1A,\uFF0C\u3001]+/, '').trim();
  return s.slice(0, 100);
}

/**
 * 从触发批里取「歌id」之后的**全文**（含空格），绕开路由的"只取第一个词"。
 * 取不到就返回空串，让调用方回用法提示。
 */
function fullBodyFrom(ctx) {
  const entries = ctx?.session?.trigger || ctx?.session?.triggerEntries || [];
  const list = (Array.isArray(entries) ? entries : []).filter((m) => m && !m.self);
  // ⚠️ 必须**从后往前找"含指令的那一条"**，不能取"批内最后一条"（2026-10-03 修）。
  //    群里消息是**成批**到达的：用户发完 `\歌id xxx`，别人紧跟着发一句话/一张图，
  //    最后一条就变成了那条 → 这里取不到指令 → raw 空 → **回一句用法提示**。
  //    现象极误导：门槛明明命中（批内确实有 \歌id）、finishReason 写着"指令直达"，
  //    用户却觉得"我明明下了指令，它却回了帮助"。
  //    同款坑与修法：plugins/agent-task（commandEntryFrom）、plugins/steam-query（1.1.5）。
  const src = [...list].reverse().find((m) => /[\\/\uFF0F\uFF3C]\s*\u6B4Cid/i.test(String(m?.text || '')));
  const text = String(src?.text || '');
  if (!text) return '';
  // 斜杠风格容错：半角 \ /、全角 ／、以及某些输入法打出的 ＼
  // ⚠️ 必须带 i 标志：指令门槛（command-router 的 normalize）会 toLowerCase，
  //    所以用户打「\歌ID」也能命中直达 —— 若这里不忽略大小写，就会出现
  //    "路由认了、但取不到歌名"的半残状态（表现为只回用法提示）。
  const m = /[\\/\uFF0F\uFF3C]\u6B4Cid/i.exec(text);
  if (!m) return '';
  return cleanKeyword(text.slice(m.index + m[0].length));
}

/**
 * 把两个接口的返回值归一成同一种形状。
 * 主接口（cloudsearch）用 ar / al，备用接口（search/get）用 artists / album ——
 * 必须都接住，否则降级之后解析全空，看起来像"没搜到"。
 */
function normalizeSongs(list) {
  if (!Array.isArray(list)) return [];
  return list.map((s) => {
    const ar = Array.isArray(s?.ar) ? s.ar : (Array.isArray(s?.artists) ? s.artists : []);
    return {
      id: String(s?.id ?? '').trim(),
      name: String(s?.name ?? '').trim(),
      artists: ar.map((a) => String(a?.name ?? '').trim()).filter(Boolean),
      album: String(s?.al?.name ?? s?.album?.name ?? '').trim()
    };
  }).filter((s) => s.id && s.name);
}

async function fetchJson(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 主接口：POST cloudsearch/pc。 */
async function searchPc(keyword, limit, timeoutMs) {
  const body = new URLSearchParams({ s: keyword, type: '1', limit: String(limit), offset: '0' });
  const json = await fetchJson(ENDPOINT_PC, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: REFERER,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  }, timeoutMs);
  return normalizeSongs(json?.result?.songs);
}

/** 备用接口：GET search/get。 */
async function searchGet(keyword, limit, timeoutMs) {
  const url = `${ENDPOINT_GET}?s=${encodeURIComponent(keyword)}&type=1&limit=${limit}&offset=0`;
  const json = await fetchJson(url, { headers: { 'User-Agent': UA, Referer: REFERER } }, timeoutMs);
  return normalizeSongs(json?.result?.songs);
}

/**
 * 搜歌：主接口优先，抛错才降级到备用接口。
 * 主接口"成功但 0 条"不降级 —— 那是真的没有，换接口也一样。
 */
async function searchNetease(keyword, { limit = DEFAULTS.limit, timeoutMs = DEFAULTS.timeoutMs, log = () => {} } = {}) {
  try {
    return await searchPc(keyword, limit, timeoutMs);
  } catch (error) {
    log(`主接口失败，降级备用接口：${String(error?.message ?? error)}`);
  }
  return searchGet(keyword, limit, timeoutMs);
}

/** 把搜索结果排成人能读的一段话（这就是最终发到群里的正文）。 */
function formatResult(keyword, songs, showAlbum) {
  const who = (s) => s.artists.join('/') || '未知歌手';

  if (!songs.length) {
    return `🔍 网易云没搜到「${keyword}」。换个写法试试 ——`
      + `\n· 歌名带上歌手：\\${COMMAND} 晴天 周杰伦`
      + `\n· 或者少写几个字，别带副标题`;
  }

  if (songs.length === 1) {
    const s = songs[0];
    const lines = [`🎵 ${s.name} — ${who(s)}`, `网易云 ID：${s.id}`];
    if (showAlbum && s.album) lines.push(`专辑：《${s.album}》`);
    return lines.join('\n');
  }

  const lines = [`🎵 「${keyword}」匹配到 ${songs.length} 首（按网易云相关度）：`];
  songs.forEach((s, i) => {
    const alb = showAlbum && s.album ? ` ｜ 《${s.album}》` : '';
    lines.push(`${i + 1}. ${s.name} — ${who(s)}${alb} ｜ ID ${s.id}`);
  });
  return lines.join('\n');
}

/** 错误信息压缩：网络类错误给一句人话，其余截断（不把内部栈/URL 漏到群里）。 */
function shortError(error) {
  const msg = String(error?.message ?? error);
  if (/abort|timeout/i.test(msg)) return '请求超时，网易云没响应，稍后再试';
  if (/HTTP 4\d\d/.test(msg)) return '网易云拒绝了这次查询（接口可能变了）';
  if (/HTTP 5\d\d/.test(msg)) return '网易云服务端出错，稍后再试';
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(msg)) return '连不上网易云（网络或 DNS 问题）';
  return msg.slice(0, 80);
}

/**
 * 工具主流程（直达链路与模型调用共用）。
 * 返回 { _directText } 时，直达链路会把这段原样发回聊天（带引用）。
 */
async function runSearch(ctx, args = {}) {
  const s = readSettings();
  if (!s.enabled) {
    return { content: '网易云搜歌已停用', isError: true };
  }

  // 优先用路由/模型给的 keyword，取不到再从消息原文取全文
  const keyword = cleanKeyword(args?.keyword) || fullBodyFrom(ctx);
  if (!keyword) {
    return {
      _directText: `用法：\\${COMMAND} 歌名\n`
        + `例：\\${COMMAND} Don't Be So Serious\n`
        + `也可以带上歌手（更准）：\\${COMMAND} 晴天 周杰伦\n`
        + `（不要带尖括号，直接写歌名就行）`
    };
  }

  const now = Date.now();
  if (!takeRateSlot(now, s.maxPerMinute)) {
    return { _directText: `⏳ 查得太快了，每分钟最多 ${s.maxPerMinute} 次，缓一下再试。` };
  }

  try {
    const songs = await searchNetease(keyword, { limit: s.limit, timeoutMs: s.timeoutMs, log });
    lastQuery = { keyword, count: songs.length, at: now };
    log(`[搜歌]「${keyword}」→ ${songs.length} 条${songs[0] ? `（首位 ID ${songs[0].id}）` : ''}`);
    return { _directText: formatResult(keyword, songs, s.showAlbum) };
  } catch (error) {
    lastQuery = { keyword, count: 0, at: now, error: true };
    log(`[搜歌]「${keyword}」失败：${String(error?.message ?? error)}`);
    return { _directText: `❌ 搜索失败：${shortError(error)}`, isError: true };
  }
}

export function setup(api) {
  cfgFn = api.config;
  log = (...a) => api.log?.(...a);

  api.registerTool({
    id: 'song_id',
    name: '搜网易云歌曲ID',
    description: '按歌名搜索网易云音乐，返回匹配歌曲的 ID / 歌名 / 歌手 / 专辑。'
      + '由指令直达链路调用（用户发 @机器人 \\歌id 歌名），模型一般不会见到它。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要搜的歌名，可带上歌手名。留空则从触发原文里取。' }
      }
    },
    async execute(ctx, args) {
      const r = await runSearch(ctx, args);
      // 本地修补：当前核心没有"指令直达"链路，不认 _directText，模型调用时只读 content，
      // 不补的话模型拿到的是 "undefined"，会反复重试直到轮数上限
      if (r && r.content === undefined && r._directText) return { content: r._directText, isError: !!r.isError };
      return r;
    }
  });

  const s = readSettings();
  log(s.enabled
    ? `已加载（指令直达：@机器人 \\${COMMAND} 歌名；默认回前 ${s.limit} 首）`
    : '已加载：当前未启用');
}

export function deactivate() {
  resetRate();
  lastQuery = null;
}

export const providers = {
  /**
   * 状态卡「插件状态」区的一行。
   * 协议名固定为 status.<本插件目录名>，ai-status 按名字探测；返回 null = 本次不上报。
   */
  'status.netease-song-id': () => {
    const s = readSettings();
    if (!s.enabled) return null;
    return {
      icon: '🎵',
      title: '网易云搜歌',
      priority: 55,
      lines: [
        ['指令', `@机器人 \\${COMMAND} 歌名`],
        ['最近查询', lastQuery
          ? `${lastQuery.keyword}（${lastQuery.error ? '失败' : `${lastQuery.count} 首`}）`
          : '无']
      ]
    };
  }
};

// 内部函数暴露给离线测试（不对外提供能力，别依赖）
export const internals = {
  readSettings,
  cleanKeyword,
  fullBodyFrom,
  normalizeSongs,
  formatResult,
  searchNetease,
  takeRateSlot,
  resetRate,
  runSearch,
  get lastQuery() { return lastQuery; },
  COMMAND,
  DEFAULTS
};

// ── 老框架兼容兜底（hooks.onMessage）────────────────────────────────────
// 背景（2026-09-30 用户指出）：插件是要**分发**的，别人的 QQ-agent 未必有
// 「反斜杠指令接收（commandOnly）」和「指令直达（commandRoute）」。两者都失效时
// `\歌id` 没人接 —— 表现为"插件装了但指令没反应"，且不报任何错。
// 这里用最早就存在的 onMessage 钩子手动接管。
//
// ⚠️ 判断条件不能写成 `getConfig().commandDirect !== false`：老框架 config 里
//    **根本没这个键**，`undefined !== false` 为真 → 钩子以为"直达可用"而退位 →
//    恰恰在最需要兜底的地方不兜底。必须"键存在且为 true"。
let getConfigFn = null;
try {
  const m = await import('../../src/config.js');
  getConfigFn = typeof m.getConfig === 'function' ? m.getConfig : null;
} catch { /* 更老的框架：按"直达不可用"处理，走兜底 */ }

function directRouteAvailable() {
  let c = null;
  try { c = getConfigFn ? getConfigFn() : null; } catch { return false; }
  if (!c) return false;
  return typeof c.commandDirect === 'boolean' ? c.commandDirect === true : false;
}

function extractText(ev) {
  if (Array.isArray(ev?.message)) {
    return ev.message.map((s) => (s?.type === 'text' ? String(s?.data?.text ?? '') : '')).join('');
  }
  return String(ev?.raw_message ?? '');
}

export const hooks = {
  // ── 老框架兜底（基础 0.4 走这条）──────────────────────────────────────
  // ⚠️ 基础 0.4 **没有 `onMessage` 钩子**（2026-10-01 真机实测），只挂它的兜底是死的。
  //    改挂 before-context（基础包一直有），并把结果改写进命中消息的文本让模型转述
  //    —— 因为 before-context 拿不到 sender，不能主动发消息。
  'before-context': (ctx) => {
    try {
      if (directRouteAvailable()) return;      // 直达可用 → 退位
      const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
      const hit = entries.filter((m) => m && !m.self).slice(-1)[0];
      if (!hit) return;
      const text = String(hit.text || '');
      if (!/[\\/\uFF0F\uFF3C]\s*\u6B4Cid/i.test(text)) return;   // \歌id
      const senderId = String(hit.senderId ?? hit.userId ?? '').trim();
      const fakeCtx = { chatKey: ctx.chatKey, kind: ctx.kind, session: { trigger: entries } };
      Promise.resolve()
        .then(() => runSearch(fakeCtx, {}))
        .then((r) => {
          const out = r?._directText || (r?.isError ? r?.content : '');
          if (out) {
            hit.text = `${text}\n（系统提示：用户刚查询了歌曲ID，结果是——\n${out}\n`
              + '请把上面这段结果原样转述给用户，不要解释机制，不要提"插件/钩子"这类词。）';
          }
        })
        .catch((e) => log('（老框架兜底）搜歌出错：' + (e?.message ?? e)));
      void senderId;
    } catch (error) {
      log('（老框架兜底）before-context 出错：' + (error?.message ?? error));
    }
  },

  // ── 新版优先 ──────────────────────────────────────────────────────────
  'onMessage': (ctx = {}) => {
    try {
      if (directRouteAvailable()) return;      // 直达可用 → 退位，避免双重回复
      const ev = ctx?.event || {};
      if (ev.post_type && ev.post_type !== 'message') return;
      const kind = ev.message_type === 'group' && ev.group_id != null ? 'group'
        : ev.message_type === 'private' && ev.user_id != null ? 'private' : '';
      if (!kind) return;
      const chatKey = kind === 'private' ? `private:${ev.user_id}` : `group:${ev.group_id}`;
      const text = extractText(ev).trim();
      if (!/[\\/\uFF0F\uFF3C]\s*\u6B4Cid/i.test(text)) return;    // \歌id（大小写不敏感）
      const senderId = String(ev.sender?.user_id ?? ev.user_id ?? '').trim();
      // 钩子在回复链路上**绝不能 await**：即发即走。伪造一个最小 ctx 供 runSearch 取参。
      const fakeCtx = { chatKey, kind, session: { trigger: [{ self: false, senderId, text }] } };
      Promise.resolve()
        .then(() => runSearch(fakeCtx, {}))
        .then((r) => {
          const t = r?._directText || (r?.isError ? r?.content : '');
          if (t) ctx.sender?.sendTextBatch?.(chatKey, [t], {});
        })
        .catch((e) => log('onMessage 兜底出错：' + (e?.message ?? e)));
    } catch (error) {
      log('onMessage 兜底出错：' + (error?.message ?? error));
    }
  }
};
