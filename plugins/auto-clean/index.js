// 自动清理与压缩 —— 确定性型插件（放 plugins/，显示在控制台「插件」页签）
//
// ── 为什么是插件，不是技能 ────────────────────────────────────────────────
// 判据（src/skills/manifest.js 的 DIR_KIND，与项目两型定义一致）：
//   plugins/ 确定性型 —— 条件满足**必然执行**，不经过 LLM
//   skills/  LLM 型   —— registerTool，用不用、什么时候用由模型自己判断
//
// 本插件要做的三件事全是"规则能写死"的：
//   ① 存档超过 N 天没人说话 → 清掉（定时扫描）
//   ② 连发的重复消息 → 合并（每次请求前，纯算术）
//   ③ 清理规则 → 配置项（白名单/保护名单/保留天数）
// 没有任何一步需要"理解人话"。做成技能（等模型主动调工具）的后果是：
// 模型忘了调 = 永远不清理、也不去重 —— 正是开发文档警告的"功能静默失效"。
// 所以类型判定：**插件 / plugins/**。
//
// ── 本项目里它靠什么生效（源码核对，不是猜的）────────────────────────────
//   · hooks['before-context']（orchestrator.js:776）
//       上下文里带 `store: this.store`（**活的 ChatStore 实例**）与 chatKey/kind。
//       这是本插件唯一能拿到内存中存档实例的地方 —— 存档有缓存，直接删磁盘文件
//       会被内存缓存"复活"，所以"按规则清当前会话"必须走 store.clearChat()。
//   · hooks['before-llm-messages']（orchestrator.js:876）
//       messages 是同一个数组引用，允许原地修改，返回值忽略。
//       重复消息去重在这里做：只做减法，不新增语义、不调模型。
//   · capability 'cleanup.brief'：把清理状态交给别处（例如以后想让模型能回答
//       "你为什么忘了"），软依赖，不注册工具 —— 插件不该往模型工具表里塞东西。
//   · context-chime 的现成用法证明：capabilities 声明的名字会进能力表。
//
// ── 安全底线（四条，硬保证）──────────────────────────────────────────────
//   1. 只清"机器人自己的记忆"：动的是 data/messages/*.json 与（可选）data/sessions/*.json，
//      **绝不**通过 OneBot 撤回/删除任何 QQ 消息，也绝不代替机器人发言（除可选的一行提示）。
//   2. 只减不加：去重只合并完全/近乎相同的内容，不生成新语义。
//   3. 异常全吞：任何一步出错都当没这个插件，绝不影响正常对话。
//   4. 清理前默认备份到 data/messages-purged/（可用配置关掉）。
//
// ── 踩坑备忘 ─────────────────────────────────────────────────────────────
//   · 存档文件名把 chatKey 里的 ':' 换成 '_'（store.js 的 chatFile）：
//     group:123 → group_123.json。反向还原用正则 ^(group|private)_(\d+)\.json$。
//   · 判断"多久没人说话"不能只看文件 mtime：任何一次写入都会刷新它。
//     这里读文件**尾部**（只读末尾 8KB）取最后一条消息的 ts，更准且不读整文件。
//   · api.log 是 `(...args) => console.log(前缀, format(...args))`，前缀占掉 format
//     的第一位参数 —— 所以日志必须自己拼成单个字符串，不能写 log('%s', v)（会打印字面 %s）。
//   · 禁用插件一定走 deactivate：定时器必须清掉，否则热重载/关闭后会累积幽灵清理。
//   · 删文件前必须确认它真的"没人用"：本插件只在两种情况动手 ——
//     扫描时该文件超过保留期且静默足够久（此时内存里几乎不可能有它的活动实例），
//     或者在某一轮对话里对**当前会话**用 store.clearChat()（内存与磁盘同时清，不会复活）。

import fs from 'node:fs';
import path from 'node:path';
import { getSkillConfig } from '../../src/skills/config.js';
import { DATA_DIR } from '../../src/config.js';

const ID = 'auto-clean';
const VERSION = '1.0.0';
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const BACKUP_DIR = path.join(DATA_DIR, 'messages-purged');
const LEDGER_FILE = path.join(DATA_DIR, `${ID}-state.json`);
const CHAT_FILE_RE = /^(group|private)_(\d+)\.json$/;

const DEFAULTS = {
  enabled: true,
  retainDays: 7,
  minIdleHours: 2,
  maxPerRun: 20,
  intervalMin: 30,
  onlyGroups: false,
  onlyPrivate: false,
  groupIds: '',
  privateIds: '',
  protectKeys: '',
  notifyOnPurge: false,
  notifyPrefix: '【自动清理】',
  backupBeforePurge: true,
  purgeSessions: false,
  compressRepeats: true,
  repeatWindowMin: 10,
  safeMode: false,
  trimEarlyMessages: false,
  maxCharsPerRequest: 24000,
  maxKeepMessages: 12,
  verbose: false
};

// ───────────────────────────── 运行期状态 ─────────────────────────────

let log = () => {};
let warn = () => {};

/** 待插入的"清理提示"（内存态，不落盘）：chatKey → { text, at }。 */
const pendingNotice = new Map();

/** 内存统计（进程生命周期内），与 diskStats 合并展示。 */
const memStats = { trimmedRepeats: 0, trimmedChars: 0, requests: 0 };

/** 定时器与重入保护。 */
let timer = null;
let running = false;
let lastSweep = null;      // { at, scanned, purged, chars, errors }
let initialized = false;

// ───────────────────────────── 配置 ─────────────────────────────

function cfg() {
  let raw = {};
  try {
    raw = getSkillConfig(ID, DEFAULTS) || {};
  } catch {
    raw = {};
  }
  const pick = (k) => (raw[k] === undefined || raw[k] === null || raw[k] === '' ? DEFAULTS[k] : raw[k]);
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.trunc(n)));
  };
  return {
    enabled: pick('enabled') !== false,
    retainDays: num(pick('retainDays'), 1, 3650, DEFAULTS.retainDays),
    minIdleHours: num(pick('minIdleHours'), 1, 8760, DEFAULTS.minIdleHours),
    maxPerRun: num(pick('maxPerRun'), 1, 200, DEFAULTS.maxPerRun),
    intervalMin: num(pick('intervalMin'), 1, 1440, DEFAULTS.intervalMin),
    onlyGroups: pick('onlyGroups') === true,
    onlyPrivate: pick('onlyPrivate') === true,
    groupIds: String(pick('groupIds') ?? ''),
    privateIds: String(pick('privateIds') ?? ''),
    protectKeys: String(pick('protectKeys') ?? ''),
    notifyOnPurge: pick('notifyOnPurge') === true,
    notifyPrefix: String(pick('notifyPrefix') ?? DEFAULTS.notifyPrefix).trim() || DEFAULTS.notifyPrefix,
    backupBeforePurge: pick('backupBeforePurge') !== false,
    purgeSessions: pick('purgeSessions') === true,
    compressRepeats: pick('compressRepeats') !== false,
    repeatWindowMin: num(pick('repeatWindowMin'), 1, 1440, DEFAULTS.repeatWindowMin),
    safeMode: pick('safeMode') === true,
    trimEarlyMessages: pick('trimEarlyMessages') === true,
    maxCharsPerRequest: num(pick('maxCharsPerRequest'), 2000, 200000, DEFAULTS.maxCharsPerRequest),
    maxKeepMessages: num(pick('maxKeepMessages'), 4, 200, DEFAULTS.maxKeepMessages),
    verbose: pick('verbose') === true
  };
}

// ───────────────────────────── 小工具 ─────────────────────────────

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

const nowMs = () => Date.now();

function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text).join('\n');
  }
  return '';
}

function totalChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) n += textOf(m).length;
  return n;
}

/** 本地时间文本（后台日志/提醒用，不用 toLocaleString 以免受系统 locale 影响格式）。 */
function stamp(ms = nowMs()) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function humanAge(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '未知';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

// ───────────────────────────── 台账（磁盘状态）─────────────────────────────

function emptyState() {
  return {
    version: 1,
    stats: { runs: 0, purgedChats: 0, purgedMessages: 0, freedChars: 0, errors: 0 },
    purges: {},          // chatKey → { at, messages, chars }
    history: [],         // 最近若干条（UI/排障用）
    updatedAt: 0
  };
}

function loadState() {
  try {
    let text = fs.readFileSync(LEDGER_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return {
        ...emptyState(),
        ...parsed,
        stats: { ...emptyState().stats, ...(parsed.stats || {}) },
        purges: (parsed.purges && typeof parsed.purges === 'object') ? parsed.purges : {},
        history: Array.isArray(parsed.history) ? parsed.history : []
      };
    }
  } catch { /* 首次运行 / 文件损坏：从空开始 */ }
  return emptyState();
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    state.updatedAt = nowMs();
    const tmp = `${LEDGER_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, LEDGER_FILE);
  } catch (error) {
    try { warn(`台账写入失败（不影响清理）：${error?.message ?? error}`); } catch { /* ignore */ }
  }
}

/** 记一次清理：更新统计、每会话节流时间、历史。 */
function recordPurge(state, chatKey, { messages = 0, chars = 0, reason = '' } = {}) {
  state.stats.purgedChats += 1;
  state.stats.purgedMessages += messages;
  state.stats.freedChars += chars;
  state.purges[chatKey] = { at: nowMs(), messages, chars };
  state.history.unshift({ at: nowMs(), chatKey, messages, chars, reason });
  if (state.history.length > 40) state.history.length = 40;
}

// ───────────────────────────── 会话名单解析 ─────────────────────────────

/** 把一个配置里的群号/QQ号列表解析成 chatKey 集合；支持英文/中文逗号、分号、空白、换行。 */
function parseIds(text, kind) {
  const out = new Set();
  for (const part of String(text ?? '').split(/[,，;；\s]+/)) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(?:(group|private)[:_])?(\d+)$/i.exec(s);
    if (!m) continue;
    const k = (m[1] || kind).toLowerCase();
    out.add(`${k}:${m[2]}`);
  }
  return out;
}

/** 保护名单：允许 group:123 / group_123 / 123（按目录推断类型）。 */
function parseKeys(text) {
  const out = new Set();
  for (const part of String(text ?? '').split(/[,，;；\s]+/)) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(group|private)[:_](\d+)$/i.exec(s);
    if (m) out.add(`${m[1].toLowerCase()}:${m[2]}`);
  }
  return out;
}

function chatKeyOfFile(name) {
  const m = CHAT_FILE_RE.exec(String(name || ''));
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * 范围过滤（唯一口径，扫描与"清当前会话"共用同一份判断 —— 两处各写一份必然跑偏）。
 *
 *   只清群聊 / 只清私聊：先按类型砍。
 *   填了 groupIds  → 群必须命中名单；**私聊此时不再默认全清**（除非另填 privateIds）。
 *   填了 privateIds → 私聊必须命中名单；群同理。
 *   两份名单都空   → 群和私聊都参与（默认）。
 *
 * @returns {{ passed: boolean, why: string }}
 */
function scopeCheck(conf, chatKey, kind, caches = {}) {
  const k = String(kind || String(chatKey || '').split(':')[0] || '');
  if (conf.onlyGroups && k !== 'group') return { passed: false, why: 'filtered' };
  if (conf.onlyPrivate && k !== 'private') return { passed: false, why: 'filtered' };

  const onlyGroup = caches.onlyGroup || parseIds(conf.groupIds, 'group');
  const onlyPrivate = caches.onlyPrivate || parseIds(conf.privateIds, 'private');
  if (onlyGroup.size) {
    if (k === 'group' ? !onlyGroup.has(chatKey) : !onlyPrivate.has(chatKey)) return { passed: false, why: 'filtered' };
  } else if (onlyPrivate.size) {
    if (k === 'private' ? !onlyPrivate.has(chatKey) : !onlyGroup.has(chatKey)) return { passed: false, why: 'filtered' };
  }

  const protect = caches.protect || parseKeys(conf.protectKeys);
  if (protect.has(chatKey)) return { passed: false, why: 'protected' };
  return { passed: true, why: '' };
}

// ───────────────────────────── 存档扫描 ─────────────────────────────

/**
 * 读存档文件**尾部**，取出最后一条消息的时间。
 * 只读末尾 8KB：存档会越长越大，全量 JSON.parse 一次几百 KB 得不偿失。
 * 拿不到（文件为空/损坏）就回落到文件 mtime —— 宁可少清，不可错清。
 */
function lastActivityOf(file) {
  const full = path.join(MESSAGES_DIR, file);
  let mtime = 0;
  try { mtime = fs.statSync(full).mtimeMs || 0; } catch { mtime = 0; }
  try {
    const size = fs.statSync(full).size;
    if (!size) return { lastTs: mtime, count: 0 };
    const readBytes = Math.min(size, 8192);
    const fd = fs.openSync(full, 'r');
    let tail = '';
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, size - readBytes);
      tail = buf.toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    // 取最后一个 "ts": <数字>
    const matches = [...tail.matchAll(/"ts"\s*:\s*(\d{10,})/g)];
    if (!matches.length) return { lastTs: mtime, count: null };
    const lastTs = Number(matches[matches.length - 1][1]);
    const countMatches = [...tail.matchAll(/"id"\s*:\s*(\d+)/g)];
    const count = countMatches.length ? Number(countMatches[countMatches.length - 1][1]) : null;
    return { lastTs: Number.isFinite(lastTs) && lastTs > 0 ? lastTs : mtime, count };
  } catch {
    return { lastTs: mtime, count: null };
  }
}

/**
 * 扫描存档目录，挑出"该清"的会话。
 * @param {object} conf
 * @param {{ ignoreThrottle?: boolean, limit?: number }} opts
 */
function collectTargets(conf, opts = {}) {
  const retainMs = conf.retainDays * 86400000;
  const idleMs = conf.minIdleHours * 3600000;
  const protect = parseKeys(conf.protectKeys);
  const onlyGroup = parseIds(conf.groupIds, 'group');
  const onlyPrivate = parseIds(conf.privateIds, 'private');
  const state = loadState();
  const limit = clampInt(opts.limit ?? conf.maxPerRun, 1, 200, conf.maxPerRun);
  const now = nowMs();

  let files = [];
  try {
    files = fs.readdirSync(MESSAGES_DIR).filter((f) => CHAT_FILE_RE.test(f));
  } catch { return { targets: [], scanned: 0, skipped: {} }; }

  const targets = [];
  const skipped = { young: 0, busy: 0, protected: 0, filtered: 0, throttled: 0, empty: 0 };
  let scanned = 0;

  for (const f of files) {
    const chatKey = chatKeyOfFile(f);
    if (!chatKey) continue;
    const [kind] = chatKey.split(':');
    scanned += 1;

    const scope = scopeCheck(conf, chatKey, kind, { onlyGroup, onlyPrivate, protect });
    if (!scope.passed) { skipped[scope.why] += 1; continue; }

    const info = lastActivityOf(f);
    const last = info.lastTs || 0;
    if (!last) { skipped.empty += 1; continue; }
    const age = now - last;
    // ⚠️ 两个门槛的关系（别误读）：
    //   age ≥ retainMs 且 age ≥ idleMs 才动手。
    //   retainDays 最小 1 天，所以 age ≥ 1 天必然 > idleMs（≤ 2 小时）——
    //   也就是说 busy 这一档在当前配置下**不可达**，静默门槛实际是冗余保险。
    //   保留它是因为语义正确（"超期 + 仍然活跃就不碰"），且将来若允许
    //   retainDays < 1 天，它会立刻变成真正的安全闸。
    if (age < retainMs) { skipped.young += 1; continue; }
    if (age < idleMs) { skipped.busy += 1; continue; }

    // 每会话节流：一次清理后短期内不重复清（避免"空了还反复记一笔"）
    const prev = state.purges[chatKey];
    if (!opts.ignoreThrottle && prev && now - Number(prev.at || 0) < retainMs / 2) {
      skipped.throttled += 1;
      continue;
    }

    targets.push({
      chatKey,
      file: f,
      lastTs: last,
      ageMs: age,
      messages: info.count,
      bytes: (() => { try { return fs.statSync(path.join(MESSAGES_DIR, f)).size; } catch { return 0; } })()
    });
  }

  // 最旧的先清（列表按最后活跃升序）
  targets.sort((a, b) => a.lastTs - b.lastTs);
  return { targets: targets.slice(0, limit), scanned, skipped, state };
}

/** 清理前备份（默认开）。返回备份成败，仅用于日志。 */
function backup(fileOrPath, isAbs = false) {
  try {
    const src = isAbs ? fileOrPath : path.join(MESSAGES_DIR, fileOrPath);
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const base = path.basename(src).replace(/\.json$/i, '');
    const stampStr = stamp().replace(/[: ]/g, '-');
    fs.copyFileSync(src, path.join(BACKUP_DIR, `${base}.${stampStr}.json`));
    return true;
  } catch (error) {
    try { warn(`备份失败（仍然继续清理，可在配置里关掉备份消除此警告）：${error?.message ?? error}`); } catch { /* ignore */ }
    return false;
  }
}

/** 删除一个会话的存档文件（先备份）。返回删掉的字符数（估算）。 */
function purgeChatFile(target, conf) {
  const full = path.join(MESSAGES_DIR, target.file);
  let chars = 0;
  try { chars = fs.statSync(full).size; } catch { chars = 0; }
  if (conf.backupBeforePurge) backup(full, true);
  try {
    fs.rmSync(full, { force: true });
    return { ok: true, chars };
  } catch (error) {
    return { ok: false, chars: 0, error: String(error?.message ?? error) };
  }
}

/** 可选的：把该会话在控制台「会话」页的调试留档一起删掉。 */
function purgeSessionFiles(conf, chats) {
  if (!conf.purgeSessions) return 0;
  let removed = 0;
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => /\.json$/.test(f));
    for (const f of files) {
      let data = null;
      try {
        let text = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        data = JSON.parse(text);
      } catch { continue; }
      const key = String(data?.chatKey || '');
      if (!key || !chats.has(key)) continue;
      try {
        if (conf.backupBeforePurge) backup(path.join(SESSIONS_DIR, f), true);
        fs.rmSync(path.join(SESSIONS_DIR, f), { force: true });
        removed += 1;
      } catch { /* 单个文件失败不影响其它 */ }
    }
  } catch { /* 目录不存在/不可读：跳过 */ }
  return removed;
}

/**
 * 跑一轮清理。**不调用模型、不花 token**，纯粹删文件。
 * 任何异常都被吞掉并计入 errors —— 清理失败绝不能影响正常对话。
 */
function runSweep({ reason = 'timer' } = {}) {
  const conf = cfg();
  if (!conf.enabled) return { skipped: '已停用' };
  const started = nowMs();
  try {
    const { targets, scanned, skipped, state } = collectTargets(conf);
    let purged = 0;
    let chars = 0;
    let errors = 0;
    const doneKeys = new Set();

    for (const t of targets) {
      const r = purgeChatFile(t, conf);
      if (!r.ok) { errors += 1; state.stats.errors += 1; continue; }
      // messages 未知（尾部没读到 id）时记 0，不编数字
      recordPurge(state, t.chatKey, {
        messages: Number.isFinite(t.messages) ? t.messages : 0,
        chars: r.chars,
        reason
      });
      purged += 1;
      chars += r.chars;
      doneKeys.add(t.chatKey);
      // 清理提示：只给"当前正在对话的会话"排队，下次它发言时提醒一句
      if (conf.notifyOnPurge && conf.onlyGroups === false) {
        pendingNotice.set(t.chatKey, {
          text: `${conf.notifyPrefix}这个会话的早期聊天记录（大约 ${Number.isFinite(t.messages) ? t.messages : '若干'} 条）已被自动清理，` +
            '原因是超出了保留期（配置里可调）。长期记忆不受影响。如果这句话需要接话，' +
            '就用一句自然的话提一下（比如"我这边旧记录清掉了，你再说一遍？"），不要生硬播报，也不需要专门为它发言。',
          at: nowMs()
        });
      }
    }

    const sessionRemoved = purgeSessionFiles(conf, doneKeys);

    state.stats.runs += 1;
    saveState(state);

    // 清理内存里过期的提示（超 2 天没轮到该会话发言就丢掉）
    for (const [k, v] of pendingNotice) {
      if (nowMs() - Number(v.at || 0) > 2 * 86400000) pendingNotice.delete(k);
    }

    lastSweep = {
      at: nowMs(),
      ms: nowMs() - started,
      scanned,
      purged,
      chars,
      sessionRemoved,
      errors,
      skipped
    };
    if (conf.verbose) {
      log(`清理完成：扫描 ${scanned} 个存档，清理 ${purged} 个会话（约 ${chars} 字符），`
        + `会话留档删除 ${sessionRemoved} 个，跳过：未到期 ${skipped.young} / 仍在活跃 ${skipped.busy} / `
        + `保护名单 ${skipped.protected} / 不在名单 ${skipped.filtered} / 已清过 ${skipped.throttled}`);
    }
    return lastSweep;
  } catch (error) {
    try { warn(`清理轮次异常（已忽略）：${error?.message ?? error}`); } catch { /* ignore */ }
    try {
      const st = loadState();
      st.stats.errors += 1;
      saveState(st);
    } catch { /* ignore */ }
    lastSweep = { at: nowMs(), purged: 0, chars: 0, errors: 1, error: String(error?.message ?? error) };
    return lastSweep;
  }
}

// ───────────────────────────── 重复消息去重（省 token）─────────────────────────────

/** 归一化：去掉多余空白与标点/emoji 尾巴，用于判断"连发同一句"。 */
function normText(s) {
  return String(s ?? '')
    .replace(/\s+/g, '')
    .replace(/[。，、！？!?.,~～…]+$/g, '')
    .toLowerCase();
}

/** 消息是否可安全合并（不能碰带 tool_calls / tool 结果 / 多模态 parts 的消息）。 */
function canMerge(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.role !== 'user' && msg.role !== 'assistant') return false;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return false;
  if (msg.tool_call_id) return false;
  if (Array.isArray(msg.content)) return false;          // 图片/视频 parts：结构不能动
  if (typeof msg.content !== 'string') return false;
  const t = msg.content.trim();
  if (!t) return false;
  if (/^【较早对话/.test(t)) return false;                // 不压缩摘要本身
  return true;
}

/**
 * 把"同一个人短时间内连发的重复内容"合并成一条。
 *
 * 这是纯减法：不生成任何新语义，只把第 2..N 条折叠进第 1 条并标注次数。
 * 收益方向明确：群里"哈哈哈哈"发三遍、"在吗"发两遍是常态，每一条都要跟着
 * 上下文重发一次。
 *
 * @returns {{ removed: number, savedChars: number }}
 */
function dedupeRepeats(messages, conf) {
  if (!Array.isArray(messages) || messages.length < 3) return { removed: 0, savedChars: 0 };
  const windowMs = conf.repeatWindowMin * 60000;
  const removeIdx = new Set();
  const extra = new Map();      // 保留条的 index → 折叠次数

  let anchor = -1;
  let anchorTs = 0;
  let anchorText = '';
  let anchorSig = '';

  const chainOf = (m) => {
    const any = m?.name ?? m?.role ?? '';
    return String(any);
  };

  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    // 遇到不可合并的消息就断开链条（保证"连续性"判断不会被工具消息穿插干扰）
    if (!canMerge(m)) { anchor = -1; anchorText = ''; anchorSig = ''; continue; }

    const ts = Number(m?.ts ?? m?._ts ?? NaN);
    const t = String(m.content).trim();
    const sig = `${chainOf(m)}|${normText(t)}`;

    if (anchor >= 0) {
      const sameChain = chainOf(m) === chainOf(messages[anchor]);
      // 归一化之后的文本相等 = 同一句（只差空白/标点/emoji 尾巴）
      const sameSig = sig === anchorSig;
      const withinWindow = !Number.isFinite(ts) || !Number.isFinite(anchorTs) || (ts - anchorTs) <= windowMs;
      if (sameChain && sameSig && withinWindow) {
        removeIdx.add(i);
        extra.set(anchor, (extra.get(anchor) || 0) + 1);
        continue;
      }
    }

    // 本条成为新锚点
    anchor = i;
    anchorTs = Number.isFinite(ts) ? ts : anchorTs;
    anchorText = t;
    anchorSig = sig;
  }

  let savedChars = 0;
  for (const idx of removeIdx) savedChars += textOf(messages[idx]).length;
  if (!removeIdx.size) return { removed: 0, savedChars: 0 };

  // 先给保留条打标注（原地改，保持数组引用不变），再整体过滤
  for (const [idx, n] of extra) {
    const m = messages[idx];
    if (typeof m?.content === 'string') {
      m.content = `${m.content}\n（上面这句在群里连发了 ${n + 1} 次，已合并）`;
    }
  }
  const kept = messages.filter((_, i) => !removeIdx.has(i));
  messages.length = 0;
  messages.push(...kept);
  return { removed: removeIdx.size, savedChars };
}

/**
 * 可选的额外压缩（默认关）：与「Token 节流」插件功能重叠。
 *
 * 策略刻意比 token-saver 更保守：**从尾部往前**保留一个连续块（绝不跨过块内的
 * tool 消息去删），被清掉的早期内容只留一行"统计式摘要"（不摘抄原文，省得更彻底）。
 * 任何一步不满足就原样返回。
 */
function trimEarly(messages, conf) {
  if (!Array.isArray(messages) || messages.length < 4) return { removed: 0, savedChars: 0 };
  const before = totalChars(messages);
  if (before <= conf.maxCharsPerRequest) return { removed: 0, savedChars: 0 };

  const keep = clampInt(conf.maxKeepMessages, 4, 200, 12);
  if (messages.length <= keep + 1) return { removed: 0, savedChars: 0 };

  let start = messages.length;
  let chars = 0;
  while (start > 0 && messages.length - start < keep) {
    start -= 1;
    chars += textOf(messages[start]).length;
    if (chars >= conf.maxCharsPerRequest) break;
  }
  if (start <= 0) return { removed: 0, savedChars: 0 };
  // 从 start 往后不允许出现孤立 tool 消息：如果 start 处是 tool，说明它的
  // assistant(tool_calls) 被留在了删除区 —— 往前退到那条 assistant 之前。
  while (start > 0 && messages[start]?.role === 'tool') start -= 1;
  if (start <= 0) return { removed: 0, savedChars: 0 };

  const removedMsgs = messages.slice(0, start);
  const removed = removedMsgs.length;
  if (!removed) return { removed: 0, savedChars: 0 };

  const digest = {
    role: 'user',
    content: `【较早对话已压缩】出于成本考虑省略了更早的 ${removed} 条消息`
      + `（含工具调用与查询结果）。需要更早的细节时问群友，不要凭空推测。`
  };
  const kept = [digest, ...messages.slice(start)];
  const after = totalChars(kept);
  const saved = before - after;
  // 省不下来就不动（宁可少省，也不要白丢上下文）
  if (saved <= 0) return { removed: 0, savedChars: 0 };

  messages.length = 0;
  messages.push(...kept);
  return { removed, savedChars: saved };
}

// ───────────────────────────── 对外状态（能力）─────────────────────────────

/** 给别处（UI/调试/其它技能）看的一份状态快照，纯只读。 */
function brief() {
  const conf = cfg();
  const st = loadState();
  const lines = [];
  lines.push(`【自动清理与压缩 · 状态】v${VERSION}`);
  lines.push(`· 规则：保留 ${conf.retainDays} 天、静默 ${conf.minIdleHours} 小时以上才清；`
    + `每轮最多 ${conf.maxPerRun} 个；扫查间隔 ${conf.intervalMin} 分钟`);
  lines.push(`· 范围：${conf.onlyGroups ? '只清群聊' : (conf.onlyPrivate ? '只清私聊' : '群聊 + 私聊')}`
    + `；保护名单 ${parseKeys(conf.protectKeys).size} 项；`
    + `清理前备份：${conf.backupBeforePurge ? '开' : '关'}；会话留档：${conf.purgeSessions ? '一起删' : '不动'}`);
  lines.push(`· 累计：清理 ${st.stats.purgedChats} 个会话 / ${st.stats.purgedMessages} 条消息、`
    + `释放约 ${Math.round(st.stats.freedChars / 1024)}KB；异常 ${st.stats.errors} 次`);
  lines.push(`· 本次进程去重：合并 ${memStats.trimmedRepeats} 条、省约 ${memStats.trimmedChars} 字符（${memStats.requests} 次请求）`);
  if (lastSweep) {
    lines.push(`· 最近一轮清理：${stamp(lastSweep.at)}（${lastSweep.ms}ms）清理 ${lastSweep.purged || 0} 个会话、`
      + `扫描 ${lastSweep.scanned || 0} 个存档`
      + `${lastSweep.sessionRemoved ? `、会话留档 ${lastSweep.sessionRemoved} 个` : ''}`
      + `${lastSweep.errors ? `、失败 ${lastSweep.errors} 次` : ''}`);
    const sk = lastSweep.skipped || {};
    if (Object.keys(sk).length) {
      lines.push(`   跳过：未到期 ${sk.young || 0}、仍在活跃 ${sk.busy || 0}、保护名单 ${sk.protected || 0}、`
        + `不在名单 ${sk.filtered || 0}、本轮已清过 ${sk.throttled || 0}`);
    }
  } else {
    lines.push('· 最近一轮清理：还没跑过（插件启动后按间隔自动跑）');
  }
  const recent = (st.history || []).slice(0, 5);
  if (recent.length) {
    lines.push('· 最近清理记录：');
    for (const h of recent) {
      lines.push(`   - ${stamp(h.at)} ${h.chatKey}：${h.messages || 0} 条、约 ${Math.round((h.chars || 0) / 1024)}KB`);
    }
  }
  lines.push(`· 备份目录：${conf.backupBeforePurge ? BACKUP_DIR : '（已关闭备份）'}`);
  return lines.join('\n');
}

// ───────────────────────────── 生命周期 ─────────────────────────────

function startTimer() {
  stopTimer();
  const conf = cfg();
  const ms = Math.max(60000, conf.intervalMin * 60000);
  timer = setInterval(() => {
    if (running) return;                 // 重入保护：上一轮没跑完就跳过
    running = true;
    try { runSweep({ reason: 'timer' }); }
    catch (error) { try { warn(`定时清理异常：${error?.message ?? error}`); } catch { /* ignore */ } }
    finally { running = false; }
  }, ms);
  // ⚠️ 必须 unref：清理定时器不该阻止进程退出（关窗/退出时能干净结束）
  if (typeof timer.unref === 'function') timer.unref();
  if (conf.verbose) log(`定时清理已启动：每 ${conf.intervalMin} 分钟扫一次`);
}

function stopTimer() {
  if (timer) {
    try { clearInterval(timer); } catch { /* ignore */ }
    timer = null;
  }
}

export function setup(api) {
  log = typeof api?.log === 'function' ? api.log : () => {};
  warn = typeof api?.warn === 'function' ? api.warn : () => {};

  const conf = cfg();
  initialized = true;

  // 启动先跑一轮：用户装完插件就想看到效果，不用等一个间隔
  try { runSweep({ reason: 'startup' }); }
  catch (error) { try { warn(`启动清理失败：${error?.message ?? error}`); } catch { /* ignore */ } }

  log(`自动清理与压缩已加载（v${VERSION}）：保留 ${conf.retainDays} 天 / 静默 ${conf.minIdleHours} 小时，`
    + `每 ${conf.intervalMin} 分钟检查一次；去重=${conf.compressRepeats ? '开' : '关'}`
    + `${conf.safeMode ? '（安全模式）' : ''}；额外压缩=${conf.trimEarlyMessages ? '开' : '关'}；`
    + `备份=${conf.backupBeforePurge ? '开' : '关'}`);
}

export function activate() {
  // 只提供能力/钩子，不需要额外激活动作；这里保证定时器与该状态一致
  const conf = cfg();
  if (conf.enabled) startTimer();
  else stopTimer();
}

export function deactivate() {
  // ⚠️ 禁用/热重载时必须清定时器，否则会累积幽灵清理（manager 的注释专门警告过）
  stopTimer();
}

export function dispose() {
  stopTimer();
  pendingNotice.clear();
}

/**
 * 可用性：无外部依赖，永远可用。
 * 配置里关掉 `enabled` 时返回不可用原因 —— 这样控制台插件页会明确写
 * "已启用但没在工作：配置里关掉了"，而不是让人对着一堆徽章猜。
 */
export function available() {
  const conf = cfg();
  if (!conf.enabled) return { ok: false, reason: '配置里的「启用自动清理与压缩」被关掉了' };
  return { ok: true };
}

// ───────────────────────────── 扩展点 ─────────────────────────────

export const capabilities = {
  /** 只读状态快照（字符串）。软依赖调用，失败返回 undefined。 */
  'cleanup.brief': () => {
    try { return brief(); } catch { return undefined; }
  }
};

export const providers = {
  /**
   * 清理状态作为一条能力（与 manifest.capabilities 同名，供别处查询）。
   * 用能力而不是注册工具：本插件不给模型加工具，避免工具表膨胀。
   */
  'cleanup.brief': (args = {}) => {
    try {
      if (args && args.action === 'sweep') return runSweep({ reason: 'manual' });
      return brief();
    } catch { return undefined; }
  }
};

export const hooks = {
  /**
   * 每轮对话开始（提示词组装之前）。
   *
   * 这里能拿到**活的 store 实例**（orchestrator.js:776 传的 `store: this.store`），
   * 这是"按规则清当前会话"唯一安全的姿势：存档有内存缓存，直接删磁盘文件会被
   * 下一次写入复活；走 store.clearChat() 则内存与磁盘同时清空。
   *
   * 注意：本 hook 在上下文组装**之前**跑，所以清掉的旧消息不会影响本轮的正常回复；
   * 这一轮该看到的历史由 store.recent() 之后自己拼（本 hook 不做任何消息加工）。
   */
  'before-context': ({ chatKey, store, kind }) => {
    try {
      const conf = cfg();
      if (!conf.enabled || !chatKey || !store || typeof store.clearChat !== 'function') return;

      // 只在足够久没人说话时动手（正在热聊的会话绝不截断）
      const meta = typeof store.getChatMeta === 'function' ? store.getChatMeta(chatKey) : null;
      const lastTs = Number(meta?.lastTs || 0);
      const age = lastTs ? nowMs() - lastTs : 0;
      if (!lastTs || age < conf.minIdleHours * 3600000) return;
      if (age < conf.retainDays * 86400000) return;

      // 与定时扫描**同一份**范围判定（唯一口径，见 scopeCheck）
      if (!scopeCheck(conf, chatKey, kind).passed) return;

      const state = loadState();
      const prev = state.purges[chatKey];
      if (prev && nowMs() - Number(prev.at || 0) < (conf.retainDays * 86400000) / 2) return;

      const chars = (() => {
        try {
          const f = path.join(MESSAGES_DIR, `${String(chatKey).replace(/[^a-z0-9_]/gi, '_')}.json`);
          return fs.statSync(f).size;
        } catch { return 0; }
      })();

      {
        const removed = store.clearChat(chatKey);
        if (!removed) return;
        recordPurge(state, chatKey, { messages: removed, chars, reason: 'idle' });
        saveState(state);
        if (conf.notifyOnPurge) {
          pendingNotice.set(chatKey, {
            text: `${conf.notifyPrefix}这个会话的早期聊天记录（${removed} 条）已被自动清理，`
              + '原因是超出了保留期。如果这句话需要接话，用一句自然的话带过即可，不要生硬播报、也不要专门为它发言。',
            at: nowMs()
          });
        }
        if (conf.verbose) {
          log(`已清理当前会话 ${chatKey}：${removed} 条（约 ${Math.round(chars / 1024)}KB），静默 ${humanAge(age)}`);
        }
      }
    } catch (error) {
      try { warn(`按规则清当前会话失败，本轮跳过：${error?.message ?? error}`); } catch { /* ignore */ }
    }
  },

  /**
   * 即将发给模型的消息数组（同一个引用，允许原地修改）。
   *
   * 这里只做两件"不可能出错"的事：
   *   ①（可选）把清理提示插进去，让机器人知道自己的旧记忆被清了，别装记得；
   *   ② 重复消息去重 +（可选）额外早期压缩 —— 纯减法。
   * 全程 try/catch：省 token 失败绝不能导致回复发不出去。
   */
  'before-llm-messages': ({ messages, chatKey }) => {
    try {
      const conf = cfg();
      if (!Array.isArray(messages) || !messages.length) return;

      // ① 清理提示（只对"刚才被清过的会话"排队过一次）
      const notice = chatKey ? pendingNotice.get(chatKey) : null;
      if (notice) {
        pendingNotice.delete(chatKey);
        // 插在**倒数第一条之前**：最后一条通常是本次要回应的触发消息，
        // 插在它后面会让它变成"最后一条"，改变模型的注意力落点。
        const idx = Math.max(0, messages.length - 1);
        messages.splice(idx, 0, { role: 'user', content: `（系统提示，不必直接回应）${notice.text}` });
      }

      if (!conf.enabled) return;
      memStats.requests += 1;

      // ② 去重
      if (conf.compressRepeats) {
        const r = dedupeRepeats(messages, conf);
        if (r.removed > 0) {
          memStats.trimmedRepeats += r.removed;
          memStats.trimmedChars += r.savedChars;
          if (conf.verbose) log(`重复消息去重：合并 ${r.removed} 条，省约 ${r.savedChars} 字符`);
        }
      }

      // ③ 额外压缩（默认关，与「Token 节流」插件重叠）
      if (conf.trimEarlyMessages) {
        const r = trimEarly(messages, conf);
        if (r.removed > 0) {
          memStats.trimmedChars += r.savedChars;
          if (conf.verbose) log(`早期上下文压缩：省略 ${r.removed} 条，省约 ${r.savedChars} 字符`);
        }
      }
    } catch (error) {
      try { warn(`消息压缩失败，本次跳过：${error?.message ?? error}`); } catch { /* ignore */ }
    }
  }
};

/** 测试/排障用导出（与 hot-trends 的 __internals 同风格）。 */
export const __internals = {
  cfg, brief, dedupeRepeats, trimEarly, collectTargets, runSweep,
  parseIds, parseKeys, lastActivityOf, textOf, totalChars,
  DEFAULTS, MESSAGES_DIR, BACKUP_DIR, LEDGER_FILE
};
