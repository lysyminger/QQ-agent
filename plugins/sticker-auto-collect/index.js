// 表情包自动收集（sticker-auto-collect）：群友发的表情包，随机挑一些收进喵喵的 QQ 收藏。
//
// 为什么挂 Orchestrator.prototype.onIncoming（和 repeat-echo 一样）：
//   群里绝大多数消息不会触发模型会话，hooks 看不见它们；onIncoming 是每条入站消息的必经点。
//   原方法先跑、返回值原样透出，这里只旁路观察。
//
// 流程：
//   ① 只看群里别人发的表情包（media.summary 是 [动画表情] 这类标签，不是 [图片]）
//   ② 按图片 file（QQ 给的 MD5 文件名）去重；没见过的按 chance 抽签，
//      被 popularSenders 个不同的人发过的直接入选
//   ③ 入选后等 90 秒（让群友把后面的话说完），把这张图在群里最近几次出现的上下文连同图片
//      交给 GPT（codex-bridge 的 codex.run）：不合适就记成 rejected，合适就按群友的实际用法写 ≤20 字备注
//     （2026-11-13 主人纠正：光看画面会把「疑惑」写成「崩溃哀嚎」）
//   ④ 交给核心 StickerManager.collect()：本地转存 + 入 QQ 收藏 + 写备注（与 collect_sticker 工具同一条路）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../../src/orchestrator.js';
import { logger } from '../../src/logger.js';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { skillManager } from '../../src/skills/manager.js';
import { safeFetchBinary } from '../../src/safe-fetch.js';
import { detectImageExt } from '../../src/image-type.js';
import { isGifBuffer, gifFirstFrameDataUrl } from '../../src/gif-to-video.js';

const TAG = 'sticker-auto-collect';
const PATCH_KEY = Symbol.for('qq-agent.sticker-auto-collect.patch');
const STATE_FILE = path.join(DATA_DIR, 'sticker-auto-collect.json');
const MAX_SEEN = 3000;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_LOG = 60;

let api = null;
let state = null;
let busy = false;
/** 测试注入点：替换看图 / 取字节。 */
const deps = { judge: null, fetchBytes: null, random: Math.random, now: Date.now, wait: (ms) => new Promise((r) => setTimeout(r, ms)) };
/** 入选后等多久再取语境（让群友把后面的话说完）。 */
const CONTEXT_WAIT_MS = 90_000;

// ── 配置与状态 ──────────────────────────────────────────────────────────────

function opts() {
  const c = api?.config?.() || {};
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    enabled: c.enabled !== false,
    chance: num(c.chance, 0.15, 0, 1),
    popularSenders: Math.round(num(c.popularSenders, 2, 0, 50)),
    maxPerDay: Math.round(num(c.maxPerDay, 0, 0, 1000)),
    maxAuto: Math.round(num(c.maxAuto, 0, 0, 100000))
  };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadState() {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { s = null; }
  if (!s || typeof s !== 'object') s = {};
  return {
    seen: s.seen && typeof s.seen === 'object' ? s.seen : {},
    day: String(s.day || ''),
    todayCount: Number(s.todayCount) || 0,
    autoTotal: Number(s.autoTotal) || 0,
    log: Array.isArray(s.log) ? s.log.slice(-MAX_LOG) : []
  };
}

function saveState() {
  if (!state) return;
  const keys = Object.keys(state.seen);
  if (keys.length > MAX_SEEN) {
    // 淘汰最早见过、还没定论的；定过论的（收了/拒了）留着，免得反复看同一张
    keys.sort((a, b) => (state.seen[a].lastTs || 0) - (state.seen[b].lastTs || 0));
    for (const k of keys) {
      if (Object.keys(state.seen).length <= MAX_SEEN) break;
      if (!state.seen[k].decided) delete state.seen[k];
    }
  }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), 'utf8');
  } catch { /* 写不出状态不影响收集 */ }
}

function addLog(item) {
  state.log.push({ at: new Date(deps.now()).toLocaleString('zh-CN', { hour12: false }), ...item });
  if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG);
}

// ── 判定 ────────────────────────────────────────────────────────────────────

/** 群友发来的表情包图片（不是照片）。 */
export function stickerMediaOf(entry) {
  const out = [];
  for (const m of entry?.media || []) {
    if (!m || m.kind !== 'image') continue;
    const label = String(m.summary ?? '').trim();
    if (!label || /^\[?(图片|照片|截图)\]?$/.test(label)) continue;
    const key = String(m.file || '').replace(/\.[a-z0-9]+$/i, '').toUpperCase();
    if (!key || key === '0' || key.length < 8) continue;
    out.push({ key, file: String(m.file || ''), url: String(m.url || ''), label });
  }
  return out;
}

function inLibrary(stickers, media) {
  const list = Array.isArray(stickers?.entries) ? stickers.entries : [];
  return list.some((e) => String(e.qqFile || '') === media.file
    || String(e.id || '').toUpperCase().includes(media.key)
    || String(e.md5 || '').toUpperCase() === media.key);
}

// ── 取图 + 看图 ─────────────────────────────────────────────────────────────

async function fetchBytes(onebot, media) {
  if (deps.fetchBytes) return deps.fetchBytes(media);
  if (media.file) {
    try {
      const ret = await onebot.call('get_image', { file: media.file });
      const p = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
      if (p) { const b = fs.readFileSync(p); if (b.length) return b; }
      if (ret?.url) { const { buffer } = await safeFetchBinary(String(ret.url), MAX_BYTES); if (buffer?.length) return buffer; }
    } catch { /* 走直链 */ }
  }
  if (media.url) {
    const { buffer } = await safeFetchBinary(media.url, MAX_BYTES);
    if (buffer?.length) return buffer;
  }
  return null;
}

const JUDGE_PROMPT = [
  '这是 QQ 群友发的一张表情包。你在帮一个 QQ 机器人（猫娘性格，叫喵喵）决定要不要收藏它，以后聊天时拿来当表情回应。',
  '',
  '不收（ok=false）：色情或擦边、血腥恶心、政治敏感、低俗粗口文字、广告/二维码/水印推广、',
  '聊天记录或网页截图、普通生活照片、带真实人脸隐私或个人信息的、纯大段文字、看不出是什么情绪的。',
  '收（ok=true）：情绪或用途一眼能看出来的反应图（开心、无语、委屈、震惊、嘲笑、敷衍、赞同、问号……）。',
  '',
  '收的话写一句备注 desc，≤20 个字，格式是「画面 + 什么时候用」，例如：',
  '「粉猫嘤嘤 委屈撒娇」「白小人斜眼 不屑/无语」「啊对对对 敷衍附和」。图里有字就把关键字写进去。',
  '',
  '「什么时候用」别只凭画面猜，按这个顺序想：',
  '1) 先认一下它是不是网上流行的梗图（比如糊脸猫张嘴的「啊？」、doge、熊猫头……）。是的话，用它在网上的通用含义，',
  '   很多梗图画面看着像哀嚎/崩溃，实际是「啊？」「什么？」的疑惑。',
  '2) 再看下面给的几段群聊（标了【这张】的就是它）：接在什么话后面、发的人想表达什么、别人怎么接，用来确认或补充。',
  '3) 语境用法不一致就写最常见的那种；都看不出来再按画面本身的表情写。',
  '',
  '按给定 JSON 格式回答：收 → {"ok":true,"desc":"...","why":""}；不收 → {"ok":false,"desc":"","why":"一句话原因"}'
].join('\n');

/** 聊天记录里一条消息的单行文字（这张表情标成【这张】）。 */
function lineOf(e, key) {
  const name = String(e.senderName || e.senderId || (e.self ? '喵喵' : '?')).slice(0, 12);
  const mine = stickerMediaOf(e).some((m) => m.key === key);
  const text = mine ? '【这张】' : String(e.text || '').replace(/\s+/g, ' ').slice(0, 80);
  return `${name}：${text}`;
}

/**
 * 这张表情在聊天记录里最近几次出现的上下文（每次前 before 条、后 after 条），给 GPT 判断用法。
 * entries 是按时间排好的消息数组（store.recent 的结果）。
 */
export function usageContext(entries, key, { before = 6, after = 3, maxUses = 4 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const hits = [];
  for (let i = list.length - 1; i >= 0 && hits.length < maxUses; i--) {
    if (!list[i]?.self && stickerMediaOf(list[i]).some((m) => m.key === key)) hits.unshift(i);
  }
  return hits.map((i, n) => {
    const lines = list.slice(Math.max(0, i - before), i + after + 1).map((e) => lineOf(e, key));
    return `第 ${n + 1} 次：\n${lines.join('\n')}`;
  }).join('\n\n');
}

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'desc', 'why'],
  properties: { ok: { type: 'boolean' }, desc: { type: 'string' }, why: { type: 'string' } }
};

/**
 * 看图把关走 GPT（codex-bridge 的 codex.run 能力）：主人定的（2026-11-13「后面都用GPT」）。
 * 学校的 DeepSeek 本来也看不了图（400 "not a multimodal model"）。
 * codex.run 只收本地 jpg/png/webp：先落临时文件，GIF 取第一帧转 PNG。
 */
async function judge(bytes, context = '') {
  if (deps.judge) return deps.judge(bytes, context);
  const run = skillManager.getCapabilityProviders('codex.run', {})[0]?.fn;
  if (!run) throw new Error('codex-bridge 没开，没有 GPT 可以看图');
  let buf = bytes;
  let ext = detectImageExt(bytes);
  if (isGifBuffer(bytes)) {
    const dataUrl = await gifFirstFrameDataUrl(bytes).catch(() => null);
    if (!dataUrl) throw new Error('GIF 取不出第一帧（没找到 ffmpeg）');
    buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    ext = '.png';
  }
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) throw new Error(`不支持的图片格式 ${ext}`);
  const tmp = path.join(os.tmpdir(), `qqa-sticker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
  fs.writeFileSync(tmp, buf);
  try {
    const prompt = `${JUDGE_PROMPT}\n\n这张图在群里出现过的聊天：\n${context || '（没有找到上下文，只能按画面判断）'}`;
    const r = await run({ prompt, images: [tmp], schema: JUDGE_SCHEMA, search: false, effort: 'low', timeoutMinutes: 3 });
    if (!r?.ok) throw new Error(`GPT 看图失败：${r?.error || '未知错误'}`);
    return parseJudge(JSON.stringify(r.json ?? {}));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

export function parseJudge(raw) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) throw new Error(`看图结果不是 JSON：${String(raw).slice(0, 80)}`);
  const j = JSON.parse(m[0]);
  if (j.ok === true) {
    const desc = String(j.desc || '').replace(/[「」"]/g, '').trim().slice(0, 20);
    if (!desc) throw new Error('看图说可以收，但没给备注');
    if (desc.startsWith('【别发】')) return { ok: false, why: '模型标了【别发】' };
    return { ok: true, desc };
  }
  return { ok: false, why: String(j.why || '不合适').slice(0, 60) };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/** 每条入站消息调一次。返回本次做了什么（测试用），不抛错。 */
export async function handle(orch, chatKey, entry) {
  if (!state || !entry || entry.self) return null;
  if (!String(chatKey || '').startsWith('group:')) return null;
  const o = opts();
  if (!o.enabled) return null;
  if (getConfig().sticker?.collectEnabled === false) return null;
  const list = stickerMediaOf(entry);
  if (!list.length) return null;

  const now = deps.now();
  const today = dayKey(now);
  if (state.day !== today) { state.day = today; state.todayCount = 0; }

  let pick = null;
  let changed = false;
  for (const media of list) {
    const sender = String(entry.senderId ?? '');
    let rec = state.seen[media.key];
    const firstSight = !rec;
    if (!rec) { rec = state.seen[media.key] = { senders: [], firstTs: now, lastTs: now }; }
    rec.lastTs = now;
    if (sender && !rec.senders.includes(sender)) { rec.senders.push(sender); if (rec.senders.length > 10) rec.senders.shift(); }
    changed = true;
    if (rec.decided || pick) continue;
    const popular = o.popularSenders > 0 && rec.senders.length >= o.popularSenders;
    const lucky = firstSight && deps.random() < o.chance;
    if (popular || lucky) pick = { media, rec, why: popular ? `${rec.senders.length} 人发过` : '随机' };
  }
  if (!pick) { if (changed) saveState(); return null; }

  if (busy) return null;
  // 0 = 不限（2026-11-13 主人：「收集上限也放开吧」）
  if ((o.maxPerDay > 0 && state.todayCount >= o.maxPerDay) || (o.maxAuto > 0 && state.autoTotal >= o.maxAuto)) { saveState(); return { skipped: 'quota' }; }
  const stickers = orch?.stickers;
  if (!stickers || typeof stickers.collect !== 'function') return null;
  if (inLibrary(stickers, pick.media)) { pick.rec.decided = 'in-library'; saveState(); return { skipped: 'in-library' }; }

  busy = true;
  const { media, rec } = pick;
  try {
    const bytes = await fetchBytes(orch.onebot, media);
    if (!bytes?.length) throw new Error('取不到图片');
    if (bytes.length > MAX_BYTES) throw new Error('图片太大');
    // 等一会儿再看语境：群友对这张图的反应（后面几条）要等他们说完才有
    await deps.wait(CONTEXT_WAIT_MS);
    let context = '';
    // 往回翻得深一点：同一张图一天可能只出现一两次，语境太少就会被个别用法带偏
    try { context = usageContext(orch.store?.recent?.(chatKey, { limit: 30000 }) || [], media.key, { maxUses: 6 }); } catch { context = ''; }
    const verdict = await judge(bytes, context);
    if (!verdict.ok) {
      rec.decided = 'rejected';
      rec.why = verdict.why;
      addLog({ chatKey, key: media.key, result: '没收', why: verdict.why });
      logger.info(TAG, `${chatKey} 跳过一张表情包（${pick.why}）：${verdict.why}`);
      return { rejected: verdict.why };
    }
    const saved = await stickers.collect(entry.mid ?? entry.id, { url: media.url, file: media.file, note: verdict.desc });
    rec.decided = 'collected';
    rec.stickerId = saved?.id || '';
    rec.desc = verdict.desc;
    state.todayCount += 1;
    state.autoTotal += 1;
    const warn = saved?.qqCollectError ? `（入 QQ 收藏失败：${saved.qqCollectError}）` : '';
    addLog({ chatKey, key: media.key, result: '收了', desc: verdict.desc, why: pick.why, ...(warn ? { warn } : {}) });
    logger.info(TAG, `${chatKey} 收藏表情包（${pick.why}）：${verdict.desc}${warn}`);
    return { collected: verdict.desc, id: saved?.id };
  } catch (error) {
    const msg = String(error?.message ?? error);
    rec.fails = (rec.fails || 0) + 1;
    if (rec.fails >= 2) { rec.decided = 'failed'; rec.why = msg.slice(0, 80); }
    logger.warn(TAG, `${chatKey} 收表情包失败：${msg}`);
    return { error: msg };
  } finally {
    busy = false;
    saveState();
  }
}

// ── 插件生命周期 ────────────────────────────────────────────────────────────

export async function setup(skillApi) {
  api = skillApi;
  state = loadState();
}

export function available() { return { ok: true }; }

export function activate() {
  if (!state) state = loadState();
  if (install()) logger.info(TAG, '表情包自动收集已挂载（onIncoming 旁路）');
}

export function deactivate() { uninstall(); }

export function dispose() { uninstall(); saveState(); }

export const providers = {
  [`${TAG}.status`]: () => (state ? {
    day: state.day, todayCount: state.todayCount, autoTotal: state.autoTotal,
    seen: Object.keys(state.seen).length, recent: state.log.slice(-10)
  } : null)
};

function install() {
  const proto = Orchestrator?.prototype;
  if (!proto || typeof proto.onIncoming !== 'function') {
    logger.warn(TAG, '拿不到 Orchestrator.prototype.onIncoming，未挂载');
    return false;
  }
  let rec = proto[PATCH_KEY];
  if (!rec) {
    const original = proto.onIncoming;
    const wrapped = function onIncoming(chatKey, entry = null) {
      const out = original.call(this, chatKey, entry);
      try {
        const cur = proto[PATCH_KEY];
        if (cur?.handle) Promise.resolve(cur.handle(this, chatKey, entry)).catch(() => {});
      } catch { /* 旁路观察失败不影响原流程 */ }
      return out;
    };
    rec = { original, wrapped, handle: null };
    proto[PATCH_KEY] = rec;
    proto.onIncoming = wrapped;
  }
  rec.handle = handle;
  return true;
}

function uninstall() {
  const proto = Orchestrator?.prototype;
  const rec = proto?.[PATCH_KEY];
  if (!rec) return;
  rec.handle = null;
  if (proto.onIncoming === rec.wrapped) proto.onIncoming = rec.original;
  delete proto[PATCH_KEY];
}

/** 自测用。 */
export const internals = {
  deps,
  judge,
  fetchBytes,
  get state() { return state; },
  reset(s = null) { state = s || { seen: {}, day: '', todayCount: 0, autoTotal: 0, log: [] }; busy = false; },
  setApi(a) { api = a; }
};
