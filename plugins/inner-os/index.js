/**
 * inner-os —— 内心OS外放（确定性型 / plugins/）
 *
 * v1.0.0
 *
 * ── 这个插件在干什么（一句话）────────────────────────────────────────────
 *   AI 每次处理消息都会先"想"，想完觉得不值得说就直接安静结束（会话状态叫
 *   noreply）。这个插件就是：看到一次"想了但没说"，就把那轮思考里最像
 *   "想说的话"的那一句发出来 —— 但只对你名单里的人。
 *
 * ── 为什么放 plugins/ 而不是 skills/ ─────────────────────────────────────
 *   "有没有会话以 noreply 收尾"是机械判断（看一眼会话落盘文件就行），不需要
 *   模型先想起来；放 skills/ 只会注册成模型可选调用的工具，模型不调用就永远
 *   不发生。范式同 plugins/silence-ping。
 *
 * ── 工作原理 ─────────────────────────────────────────────────────────────
 *   1. `after-response` 钩子：每轮 LLM 返回后，把"思考内容"暂存在内存里
 *      （按 sessionId 存：reasoning 思考链优先，没有就用普通 content 文本输出）。
 *   2. 后台每 N 秒扫一遍 data/sessions/ 目录：发现"刚落盘、状态是 noreply、
 *      以前没处理过"的会话文件，就看它该不该外放。
 *   3. 只认 QQ 号：私聊取 chatKey 里的号；群聊取 trigger 里非 self 的说话人。
 *      命中 targets 名单 → 再过一遍群聊开关/冷却/上限/安静时段 → 挑句子 → 发。
 *   4. 挑句子：优先用第 1 步暂存的"最后一轮思考"；暂存里没有（插件重载、
 *      重启、错过钩子）就从会话文件 messages 里取最后一个 assistant 文本。
 *      工具调用伪代码、空串、纯标点一律不要；过长截断，首尾括号可去。
 *
 * ── 为什么不用 fs.watch 而用轮询 ─────────────────────────────────────────
 *   Windows 上 fs.watch 对"短时间内大量写入 JSON"目录的行为不稳定（事件合并、
 *   丢事件、rename/change 语义混乱），而 sessions 目录就是这种写入模式。
 *   轮询 + 高水位（只看 endedAt 比上次新的文件）简单可预测，多花的那点 IO
 *   相对一次 LLM 调用可以忽略。
 *
 * ── 安全闸（按检查顺序）──────────────────────────────────────────────────
 *   ① enabled 总开关；② dryRun 演练（只记日志不真发）；③ targets 留空 = 谁都不发；
 *   ④ 群聊要过 allowGroup；⑤ 冷却/每日上限/去重/安静时段。
 *   外放走 OneBot HTTP 直发 + 手动 appendSelf 留档（silence-ping 的成熟范式），
 *   不写 session.sent、不改变原会话的 noreply 结论 —— 它仍然是"一次没回的会话"。
 *
 * ── 踩坑备忘（照着 silence-ping 的实测经验）───────────────────────────────
 *   · DATA_DIR 自己推导，别直接信 config.js 导出的（环境变量没设时会指向错目录）。
 *   · 发送不用 api.fetch（本机实测是坏的），直接用全局 fetch。
 *   · OneBot 令牌不能只信程序配置（插件看到的是脱敏后的空令牌），自己去
 *     SnowLuma 配置目录找 onebot_<QQ>.json 里的 accessToken，找不到再逐个探活。
 *   · 热重载只"加载"不"激活"，所以钩子里也要拉起定时器（startLoop 幂等），
 *     否则界面显示"已启用"却永远没动静。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, DATA_DIR as DATA_DIR_FALLBACK } from '../../src/config.js';
import { escapeCqText } from '../../src/util.js';

/* ═══════════════════════════ 数据目录 ═══════════════════════════ */

// 推导逻辑同 silence-ping：显式环境变量 > 自己的推导 > config.js 的（最后的退路）。
// 另外多实例场景：QQ_AGENT_PROFILE=2 时数据目录是 data-2/，这里也一并处理。
const DATA_DIR = (() => {
  const fromEnv = String(process.env?.QQ_AGENT_DATA_DIR ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const suffix = /^\d+$/.test(String(process.env?.QQ_AGENT_PROFILE ?? '')) ? `-${process.env.QQ_AGENT_PROFILE}` : '';
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));   // …/plugins/inner-os
    // ① 程序根/data（打包后的标准布局）：插件目录往上 4 层
    const guess = path.resolve(here, '..', '..', '..', '..', `data${suffix}`);
    if (fs.existsSync(path.join(guess, 'config.json')) || fs.existsSync(path.join(guess, 'messages'))) return guess;
    // ② 有的部署把 app 直接放在程序根下（此时 data 与 plugins 同级的上两层）
    const guess2 = path.resolve(here, '..', '..', `data${suffix}`);
    if (fs.existsSync(path.join(guess2, 'config.json')) || fs.existsSync(path.join(guess2, 'messages'))) return guess2;
  } catch { /* 推导失败就往下走 */ }
  return DATA_DIR_FALLBACK;
})();

const BUILD_TAG = 'v1.0.0';
const STORE = path.join(DATA_DIR, 'inner-os.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const BJ_OFFSET_MS = 8 * 3600 * 1000;

/* ═══════════════════════════ 配置 ═══════════════════════════ */

const DEFAULTS = {
  enabled: true,
  dryRun: true,
  targets: '',
  allowGroup: true,
  prefix: '（心里话）',
  maxChars: 80,
  minChars: 2,
  cooldownMinutes: 10,
  maxPerDay: 30,
  quietRange: '',
  stripBrackets: true,
  skipRepeats: true,
  scanIntervalSec: 10
};

let api = null;

function settings() {
  const raw = (typeof api?.config === 'function' ? api.config() : null) || {};
  const s = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (k in DEFAULTS && typeof DEFAULTS[k] === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) s[k] = n;
    } else {
      s[k] = v;
    }
  }
  return s;
}

/* ═══════════════════════════ 小工具 ═══════════════════════════ */

const num = (v, dflt, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

const dayKeyOf = (ts = Date.now()) => new Date(ts + BJ_OFFSET_MS).toISOString().slice(0, 10);

const hhmm = (ts) => new Date(Number(ts) + BJ_OFFSET_MS).toISOString().slice(11, 16);

/** 私有存档（本插件私有，原子写）：记高水位、已处理、冷却、每日计数。 */
function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch { /* 没有或坏了就重建 */ }
  return { version: 1, highWater: 0, handled: [], perChat: {}, dayKey: dayKeyOf(), dayCount: 0 };
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    const tmp = `${STORE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STORE);
  } catch (e) {
    api?.warn?.(`内心OS外放：存档写入失败：${e?.message ?? e}`);
  }
}

/* ═══════════════════════════ 第 1 步：钩子暂存思考 ═══════════════════════════ */

// sessionId → [{ round, reasoning, content }]。只留最近 50 个会话，每会话最多 12 轮。
const thoughtCache = new Map();
const MAX_CACHED_SESSIONS = 50;
const MAX_ROUNDS_PER_SESSION = 12;

function cacheThought(sessionId, response) {
  if (!sessionId) return;
  const msg = response?.message || {};
  const reasoning = cleanThought(response?.reasoning);
  const content = cleanThought(msg?.content);
  if (!reasoning && !content) return;
  let arr = thoughtCache.get(sessionId);
  if (!arr) { arr = []; thoughtCache.set(sessionId, arr); }
  arr.push({ reasoning, content });
  if (arr.length > MAX_ROUNDS_PER_SESSION) arr.splice(0, arr.length - MAX_ROUNDS_PER_SESSION);
  if (thoughtCache.size > MAX_CACHED_SESSIONS) {
    const oldest = thoughtCache.keys().next().value;
    thoughtCache.delete(oldest);
  }
}

function takeThought(sessionId) {
  const arr = thoughtCache.get(sessionId);
  thoughtCache.delete(sessionId);
  if (!arr || !arr.length) return '';
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = arr[i];
    if (t.content) return t.content;
    if (t.reasoning) return t.reasoning;
  }
  return '';
}

function cleanThought(raw) {
  if (!raw) return '';
  const text = Array.isArray(raw)
    ? raw.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('')
    : String(raw);
  return text.replace(/\r/g, '').trim();
}

/* ═══════════════════════════ 第 2 步：挑一句人话 ═══════════════════════════ */

/** 工具调用伪代码长这样，不要当成心里话：
 *  <tool_call><function=send_message>…、{"messages": […]}、```json … */
const TOOL_CALL_RE = /<tool_call|<function=|```|^\s*\{[\s\S]*"(messages|function|tool_calls)"[\s\S]*\}\s*$/;

/** 句子切分：按换行和中英文句末标点切，保留每句尽量完整。 */
function splitSentences(text) {
  return String(text ?? '')
    .split(/\r?\n+/)
    .flatMap((line) => String(line).split(/(?<=[。！？!?…~～])\s*/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "我调用 xx 获取数据"这类伪代码内心戏不要；括号纯标注也不要。 */
const META_RE = /调用.{0,12}(工具|函数|tool|send_message|get_|memory_|web_)|我(刚|已经)?(发了|发送了|调用了)|tool_calls|function call/i;

/** 从一段思考里挑一句最适合外放的话。返回 '' 表示挑不出、这次跳过。 */
function pickLine(thought, s) {
  if (!thought) return '';
  const maxChars = num(s.maxChars, 80, 10, 500);
  const minChars = num(s.minChars, 2, 0, 50);
  const strip = s.stripBrackets !== false;

  for (const raw of splitSentences(thought).reverse()) {
    let line = raw.trim();
    if (!line || line.length < minChars) continue;
    if (line.length > 600) continue;                    // 超长段直接扔，不截半句
    if (TOOL_CALL_RE.test(line)) continue;
    if (META_RE.test(line)) continue;
    if (/^[\s，。！？、；：…~～!?,.]+$/.test(line)) continue;  // 纯标点
    if (strip) {
      // 去掉首尾成对的括号（半角全角都认，可多层）
      for (;;) {
        const m = /^[\(\[（【「『]([\s\S]*)[\)\]）】」』]$/.exec(line.trim());
        if (!m) break;
        line = m[1].trim();
        if (!line) break;
      }
      if (!line || line.length < minChars) continue;
    }
    if (line.length > maxChars) line = `${line.slice(0, maxChars)}…`;
    return line;
  }
  return '';
}

/* ═══════════════════════════ 第 3 步：读会话文件 ═══════════════════════════ */

/** 会话文件里最后一个 assistant 文本（钩子没暂存到时的兜底来源）。 */
function lastAssistantText(sessionJson) {
  const msgs = Array.isArray(sessionJson?.messages) ? sessionJson.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant') continue;
    const t = cleanThought(m.content);
    if (t) return t;
  }
  return '';
}

/**
 * 只认 QQ 号（名字/自称一律不参与 —— 昵称会改、会撞名，行首号码才是真的）。
 * 私聊：chatKey `private:<QQ>`；群聊：trigger 里第一个非 self 的 senderId。
 * 返回 '' 表示拿不到可信身份，这次跳过。
 */
function targetQQOf(sessionJson) {
  const chatKey = String(sessionJson?.chatKey ?? '');
  let m = /^private:(\d+)$/.exec(chatKey);
  if (m) return m[1];
  if (/^group:\d+$/.test(chatKey)) {
    const triggers = Array.isArray(sessionJson?.trigger) ? sessionJson.trigger : [];
    for (const t of triggers) {
      if (t && t.self !== true && /^\d{4,12}$/.test(String(t.senderId ?? ''))) return String(t.senderId);
    }
  }
  return '';
}

/** sessions 目录里"本轮新落盘且 noreply"的会话。 */
function scanNewNoreply(highWater) {
  const out = [];
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return { out, highWater };
  }
  let hw = highWater;
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch { continue; }                              // 正在写一半的文件，下一轮再看
    const endedAt = Number(j?.endedAt) || 0;
    if (endedAt > hw) hw = endedAt;
    if (!endedAt || endedAt <= highWater) continue;    // 只看"比上次新的"
    if (j?.status !== 'noreply') continue;
    if (Array.isArray(j?.sent) && j.sent.length) continue;  // 账面有发送就不算"没说"
    out.push({ file: f, json: j });
  }
  // 按结束时间从旧到新处理，保证同一会话的先后顺序
  out.sort((a, b) => (Number(a.json.endedAt) || 0) - (Number(b.json.endedAt) || 0));
  return { out, highWater: hw };
}

/* ═══════════════════════════ 名单 / 时段 ═══════════════════════════ */

function parseTargets(spec) {
  const set = new Set();
  for (const p of String(spec ?? '').split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean)) {
    if (/^\d{4,12}$/.test(p)) set.add(p);
  }
  return set;
}

/**
 * "9:00" / "09:00" / "0900" / "9" → 分钟数；看不懂返回 null。
 * 照搬 silence-ping 的实测版本：紧凑写法必须**先**按 HHMM 切分再校验，
 * 否则 '0900' 会被当成"小时数 900"判非法，整个时段静默变成"不设"。
 */
function toMinutes(str) {
  const t = String(str ?? '').trim();
  if (!t) return null;
  let h, mm;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (m) {
    h = Number(m[1]);
    mm = Number(m[2]);
  } else if (/^\d{3,4}$/.test(t)) {
    h = Number(t.slice(0, t.length - 2));      // '0900' → 09
    mm = Number(t.slice(-2));
  } else if (/^\d{1,2}$/.test(t)) {
    h = Number(t);
    mm = 0;
  } else {
    return null;
  }
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function inQuietNow(quietRange, now = Date.now()) {
  const text = String(quietRange ?? '').trim().replace(/[~～—–至]/g, '-').replace(/\s+/g, '');
  if (!text) return false;
  const m = /^(\d{3,4}|\d{1,2}(?::\d{1,2})?)-(?:次日)?(\d{3,4}|\d{1,2}(?::\d{1,2})?)$/.exec(text);
  if (!m) return false;
  const start = toMinutes(m[1]);
  const end = toMinutes(m[2]);
  if (start === null || end === null || start === end) return false;
  const mins = new Date(now + BJ_OFFSET_MS).getUTCHours() * 60
    + new Date(now + BJ_OFFSET_MS).getUTCMinutes();
  return start < end ? (mins >= start && mins < end) : (mins >= start || mins < end);
}

/* ═══════════════════════════ 第 4 步：发送 ═══════════════════════════ */

// 发送范式照搬 silence-ping（已经本机实测跑通）：
//   · 不用 api.fetch（坏的），直接用全局 fetch；
//   · OneBot 令牌去 SnowLuma 配置目录自探，程序配置里的通常是脱敏空值；
//   · 发完手动 appendSelf 留档，否则模型下轮看不到自己说过这句。

function doFetch(url, init) {
  const f = globalThis.fetch;
  if (typeof f !== 'function') throw new Error('运行环境没有可用的 fetch');
  return f.call(globalThis, url, init);
}

let snowCache = { at: 0, list: [] };

function snowlumaCandidates() {
  if (Date.now() - snowCache.at < 30000) return snowCache.list;
  const list = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(here, '..', '..');
    const dirs = [
      path.join(appRoot, 'snowluma', 'config'),
      path.join(appRoot, 'resources', 'snowluma', 'config'),
      path.join(appRoot, '..', 'snowluma', 'config')
    ];
    for (const dir of dirs) {
      try {
        if (!dir || !fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!/^onebot_.*\.json$/i.test(f)) continue;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const hs = (j?.networks?.httpServers) || [];
            const ws = (j?.networks?.wsServers) || [];
            const port = Number(hs[0]?.port || 3000);
            const tk = String(hs[0]?.accessToken || ws[0]?.accessToken || '');
            if (tk) list.push({ base: `http://${hs[0]?.host || '127.0.0.1'}:${port}`, token: tk });
          } catch { /* 跳过坏文件 */ }
        }
        if (list.length) break;
      } catch { /* 试下一个目录 */ }
    }
  } catch { /* 忽略 */ }
  snowCache = { at: Date.now(), list };
  return list;
}

async function snowlumaPick() {
  const appCfg = getConfig()?.snowluma || {};
  const appBase = String(appCfg.httpUrl || '').replace(/\/+$/, '');
  const appToken = String(appCfg.httpAccessToken || appCfg.accessToken || '');
  const tries = [];
  if (appBase && appToken) tries.push({ base: appBase, token: appToken });
  for (const c of snowlumaCandidates()) {
    const base = appBase || c.base;
    if (tries.some((t) => t.token === c.token && t.base === base)) continue;
    tries.push({ base, token: c.token });
  }
  if (!tries.length) tries.push({ base: appBase || 'http://127.0.0.1:3000', token: appToken });
  for (const t of tries) {
    if (!t.token) continue;
    try {
      const res = await doFetch(`${t.base}/get_status`, {
        headers: { authorization: `Bearer ${t.token}` },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) return t;
    } catch { /* 试下一个 */ }
  }
  return tries[0];
}

async function onebotSend(chatKey, text) {
  const m = /^(private|group):(\d+)$/.exec(String(chatKey || ''));
  if (!m) throw new Error(`会话键不合法：${chatKey}`);
  const { base, token } = await snowlumaPick();
  const res = await doFetch(`${base}/${m[1] === 'private' ? 'send_private_msg' : 'send_group_msg'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(m[1] === 'private'
      ? { user_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] }
      : { group_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`OneBot HTTP ${res.status}`);
}

/** 手动留档：发出去的话写进聊天记录，模型下轮能看到自己说过这句。 */
function appendSelf(chatKey, text) {
  const m = /^(private|group):(\d+)$/.exec(String(chatKey || ''));
  if (!m) return;
  const file = path.join(MESSAGES_DIR, `${m[1]}_${m[2]}.json`);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = Number(j.nextLocalId) || (j.messages.length + 1);
    // 字段对齐核心 store.appendSelf 的条目形状，缺字段的旧文件也能读
    j.messages.push({
      id, mid: null, ts: Date.now(), senderId: 'self', senderName: '我',
      text: String(text ?? ''), self: true, read: true, reply: null, media: []
    });
    j.nextLocalId = id + 1;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j));
    fs.renameSync(tmp, file);
  } catch { /* 留档失败不致命 */ }
}

/* ═══════════════════════════ 一整轮 ═══════════════════════════ */

async function runCycle() {
  const s = settings();
  if (s.enabled === false) return;
  const state = readState();

  // 每日计数跨天重置
  const today = dayKeyOf();
  if (state.dayKey !== today) { state.dayKey = today; state.dayCount = 0; }

  const targets = parseTargets(s.targets);
  const { out, highWater } = scanNewNoreply(Number(state.highWater) || 0);
  state.highWater = highWater;
  const handled = new Set(Array.isArray(state.handled) ? state.handled : []);

  const maxPerDay = num(s.maxPerDay, 30, 1, 1000);
  const coolMs = num(s.cooldownMinutes, 10, 0, 24 * 60) * 60000;
  const quiet = inQuietNow(s.quietRange);
  const dryRun = s.dryRun === true;

  for (const { json } of out) {
    const sid = String(json?.id ?? '');
    if (!sid || handled.has(sid)) continue;
    handled.add(sid);
    // handled 只留最近 500 个，防止存档无限膨胀
    while (handled.size > 500) handled.delete(handled.values().next().value);

    const chatKey = String(json?.chatKey ?? '');
    const qq = targetQQOf(json);
    const triggerText = String(json?.triggerText ?? json?.triggerSummary ?? '').slice(0, 60);
    const tag = `${sid} ${chatKey} 触发人QQ=${qq || '未知'}「${triggerText}」`;
    const skip = (reason) => api?.log?.(`内心OS外放：跳过 ${tag} —— ${reason}`);

    if (!qq) { skip('拿不到可信 QQ 号'); continue; }
    if (!targets.size) { skip('名单为空（targets 留空 = 谁都不发）'); continue; }
    if (!targets.has(qq)) { skip('不在名单里'); continue; }
    if (/^group:/.test(chatKey) && s.allowGroup === false) { skip('群聊且 allowGroup 关闭'); continue; }
    if (quiet) { skip('安静时段'); continue; }
    if (Number(state.dayCount) >= maxPerDay) { skip(`今日已发 ${state.dayCount} 条，到上限`); continue; }

    const per = state.perChat[chatKey] || {};
    if (coolMs > 0 && Date.now() - Number(per.lastAt || 0) < coolMs) {
      skip(`冷却中（上次 ${hhmm(per.lastAt)}）`);
      continue;
    }

    // 挑句子：内存暂存优先，会话文件兜底
    const thought = takeThought(sid) || lastAssistantText(json);
    const line = pickLine(thought, s);
    if (!line) { skip('挑不出一句能发的话'); continue; }
    if (s.skipRepeats !== false && per.lastText === line) { skip('跟上次外放重复'); continue; }

    const text = `${String(s.prefix ?? '')}${line}`;
    if (dryRun) {
      api?.log?.(`内心OS外放【演练】${tag} —— 本来想发：「${text}」`);
      // 演练也记冷却/去重账（但不计每日额度），这样演练时看到的就是
      // "正式跑起来"的真实节奏，而不是每轮都对同一句"本来想发"
      state.perChat[chatKey] = { lastAt: Date.now(), lastText: line };
      continue;
    }
    try {
      await onebotSend(chatKey, text);
      appendSelf(chatKey, text);
      state.dayCount = Number(state.dayCount) || 0;
      state.dayCount += 1;
      state.perChat[chatKey] = { lastAt: Date.now(), lastText: line };
      api?.log?.(`内心OS外放：已发 ${tag} —— 「${text}」`);
    } catch (e) {
      api?.warn?.(`内心OS外放：发送失败 ${tag}：${e?.message ?? e}`);
    }
  }

  state.handled = [...handled];
  writeState(state);
}

/* ═══════════════════════════ 叫醒节奏 ═══════════════════════════ */

let timer = null;

function startLoop() {
  if (timer) return false;
  if (settings().enabled === false) return false;
  const interval = Math.max(3, num(settings().scanIntervalSec, 10, 3, 300)) * 1000;
  const tick = async () => {
    try {
      await runCycle();
    } catch (e) {
      api?.warn?.(`内心OS外放这一轮出错（不影响下一轮）：${e?.message ?? e}`);
    }
    timer = setTimeout(tick, Math.max(3, num(settings().scanIntervalSec, 10, 3, 300)) * 1000);
    timer.unref?.();
  };
  timer = setTimeout(tick, 5000);   // 启动 5 秒后先扫一轮
  timer.unref?.();
  api?.log?.(`内心OS外放已启动（${BUILD_TAG}）：每 ${interval / 1000} 秒扫一次新会话`);
  return true;
}

function stopLoop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

/* ═══════════════════════════ 生命周期 / 钩子 / 状态 ═══════════════════════════ */

export function setup(a) {
  api = a;
  a.log(`内心OS外放已加载（${BUILD_TAG}）｜sessions ${SESSIONS_DIR}｜存档 ${STORE}`);
}

export function available() {
  return settings().enabled !== false;
}

export function activate() {
  startLoop();
}

export function deactivate() {
  stopLoop();
}

export const hooks = {
  'after-response'(ctx = {}) {
    // 拉起定时器：热重载只"加载"不"激活"，不这么做会"显示已启用却没动静"
    startLoop();
    try {
      const sid = ctx.sessionId || ctx.session?.id;
      if (sid && ctx.response) cacheThought(sid, ctx.response);
    } catch { /* 暂存失败不影响主流程 */ }
  },
  'before-context'() {
    // 同上：任意会话被唤醒都确保定时器在跑（纯自愈，与业务无关）
    startLoop();
  }
};

/** 状态面板：一眼看到它开着没、盯着谁、今天发了几条。 */
export const providers = {
  'status.inner-os': () => {
    const s = settings();
    const state = readState();
    const targets = [...parseTargets(s.targets)];
    const perChat = Object.entries(state.perChat || {});
    return {
      icon: '💭',
      title: '内心OS外放',
      priority: 57,
      lines: [
        ['状态', s.enabled === false ? '已关闭' : (s.dryRun === true ? '演练中（只记日志，不真发）' : '运行中')],
        ['盯着谁', targets.length ? targets.join('、') : '⚠️ 名单为空，谁都不发'],
        ['群聊', s.allowGroup === false ? '不外放' : '触发人在名单里就外放'],
        ['今日已发', `${Number(state.dayCount) || 0} / ${num(s.maxPerDay, 30, 1, 1000)}`],
        ['格式', `${s.stripBrackets !== false ? '去括号' : '原样'}｜前缀「${String(s.prefix ?? '')}」｜${num(s.minChars, 2, 0, 50)}~${num(s.maxChars, 80, 10, 500)}字`],
        ...(perChat.length
          ? [['最近外放', perChat.slice(-3).map(([k, v]) => `${k} ${hhmm(v.lastAt)}「${String(v.lastText || '').slice(0, 20)}」`).join('；')]]
          : []),
        ...(s.quietRange ? [['安静时段', `${s.quietRange}${inQuietNow(s.quietRange) ? '（现在正安静）' : ''}`]] : [])
      ]
    };
  }
};
