// [省token]戳一戳概率回应
//
// 被戳一戳时按概率决定怎么反应：回一句 / 回戳一下 / 装作没看见；
// 可选连戳管制：短时间被戳太多次 → 提示一句（或直接屏蔽）→ 进入冷却，
// 冷却结束前一律不回应；冷却填 0 就是永久屏蔽，直到有人发一句恢复指令。
//
// 两套闸门，按核心是否支持自动切换：
//   ① 运行前闸门（首选，零 token）：能力 message.poke-gate / message.gate。
//      核心在"戳一戳事件进来时"先问本插件，判定不理/回戳/提示就根本不建会话、不调模型；
//      message.gate 让它能可靠接住恢复指令（不受响应档位影响，也不为一条指令烧调用）。
//   ② 兼容闸门：核心没有这两个扩展点时，用 before-context + tool.guard/before-tool
//      拦下发送工具 —— 判定"不理"也不会说话，但那一次会话已经建立、模型已经被调用。
//      连戳管制与恢复指令依赖运行前闸门，兼容模式下不生效。
// 切换不用猜：message.poke-gate 被核心调用过一次就说明闸门可用，随即切到零 token 模式。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const POKE_AT_ME = /拍了拍\s*我/;                       // 与核心识别"机器人在被戳"的口径一致
const SEND_TOOLS = ['send_message', 'send_sticker', 'send_image', 'send_poke', 'send_to'];
const DECISION_TTL_MS = 10 * 60 * 1000;                 // 兼容模式的决策只在本次运行内有意义
const PLACEHOLDER_NAMES = new Set(['count', 'seconds', 'minutes', 'cd']);

let cfg = () => ({});
let log = () => {};
let warn = () => {};

let gateSeen = false;                                   // 运行前闸门是否已被核心调用过
const decisions = new Map();                            // 兼容模式：sessionId -> { action, at, peerId }
const windows = new Map();                              // 连戳窗口：chatKey -> [{ ts, op }]
const blocks = new Map();                               // 屏蔽：chatKey -> 0（永久）或到期时间戳

// ── 屏蔽状态落盘：插件重启/热重载/机器重启都不该让屏蔽失效 ──
const stateFile = () => path.join(DATA_DIR, 'plugins', 'probability-reply', 'state.json');

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    for (const [key, value] of Object.entries(raw?.blocks && typeof raw.blocks === 'object' ? raw.blocks : {})) {
      const until = Number(value);
      if (Number.isFinite(until) && until >= 0) blocks.set(String(key), until);
    }
    if (blocks.size) log(`已恢复 ${blocks.size} 个会话的戳一戳屏蔽状态`);
  } catch { /* 首次运行 / 文件损坏：从空状态开始 */ }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    const tmp = `${stateFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ blocks: Object.fromEntries(blocks) }, null, 2), 'utf8');
    fs.renameSync(tmp, stateFile());                    // 原子写，避免崩溃留半截 JSON
  } catch (error) {
    warn('屏蔽状态写入失败：%s', error?.message ?? error);
  }
}

export function setup(api) {
  cfg = api.config;                                     // 记住取值函数：执行时再读，设置改了立刻生效
  log = api.log;
  warn = api.warn;
  gateSeen = false;
  decisions.clear();
  windows.clear();
  blocks.clear();
  loadState();
  log('戳一戳概率回应已加载');
}

export function deactivate() { decisions.clear(); windows.clear(); }
export function dispose() { decisions.clear(); windows.clear(); gateSeen = false; }

// ── 小工具 ──

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clampPercent = (value, fallback) => Math.min(100, Math.max(0, num(value, fallback)));
const splitList = (raw) => String(raw ?? '').split(/[\s,，、|;；·]+/).map((s) => s.trim()).filter(Boolean);

/** 去掉把整条包起来的 {} 外壳（占位符名字本身除外，如 {count}）。 */
function unwrapBraces(text) {
  const s = String(text ?? '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        if (i !== s.length - 1) return s;
        const inner = s.slice(1, -1).trim();
        return inner && !PLACEHOLDER_NAMES.has(inner) ? inner : s;
      }
    }
  }
  return s;
}

/**
 * 解析多条文案，三种写法都支持（可混用）：换行 / 中点 · / {第一条}·{第二条}。
 * 分隔只在最外层生效，所以条目里的占位符（今天第{count}次了）不会被切断。
 */
function parseTexts(raw) {
  const text = String(raw ?? '');
  const parts = [];
  let depth = 0;
  let buf = '';
  for (const ch of text) {
    if (ch === '{') { depth += 1; buf += ch; continue; }
    if (ch === '}') { if (depth > 0) depth -= 1; buf += ch; continue; }
    if (depth === 0 && (ch === '·' || ch === '\n' || ch === '\r')) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((s) => unwrapBraces(s.trim())).filter(Boolean);
}

/** 替换 {count} 这类占位符（没给的占位符原样保留）。 */
const renderText = (template, vars) => String(template ?? '')
  .replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m)).trim();

/** 掷一次骰子：reply / poke-back / silent。 */
function roll(peerId = '') {
  const c = cfg();
  const replyP = clampPercent(c.replyPercent, 60);
  const pokeBackP = Math.min(clampPercent(c.pokeBackPercent, 30), 100 - replyP);   // 文字回应优先保住额度
  const r = Math.random() * 100;
  const action = r < replyP ? 'reply' : (r < replyP + pokeBackP ? 'poke-back' : 'silent');
  if (c.debugLog) log(`掷骰：回应 ${replyP}% / 回戳 ${pokeBackP}% / 不理 ${100 - replyP - pokeBackP}% → ${action}`);
  return { action, peerId };
}

const isPokeEntry = (entry) => Boolean(entry)
  && (entry.isPoke === true || /拍了拍/.test(String(entry.text || '')));

function pruneDecisions(now = Date.now()) {
  for (const [id, d] of decisions) if (!d || now - d.at > DECISION_TTL_MS) decisions.delete(id);
}

const decisionOf = (sessionId) => (sessionId === undefined || sessionId === null
  ? null
  : decisions.get(String(sessionId)) || null);

const blockReason = (d) => (d.action === 'poke-back'
  ? '本次戳一戳的概率判定是「回戳一下」：只能用 send_poke 回敬对方，不要发文字、表情或图片。'
  : '本次戳一戳的概率判定是「不理」：这一次保持沉默，不要发消息、不要回戳。');

// ── 屏蔽（冷却 / 永久）──

/** 'permanent'（等指令）| 'until'（冷却中）| null（正常）。 */
function blockState(chatKey, now = Date.now()) {
  if (!blocks.has(chatKey)) return null;
  const until = Number(blocks.get(chatKey)) || 0;
  if (until === 0) return 'permanent';
  if (until > now) return 'until';
  blocks.delete(chatKey);                               // 冷却到期自动解除
  saveState();
  if (cfg().debugLog) log(`${chatKey} 的冷却已到期，恢复正常`);
  return null;
}

function setBlock(chatKey, until) { blocks.set(String(chatKey), Number(until) || 0); saveState(); }
function clearBlock(chatKey) { if (blocks.delete(String(chatKey))) saveState(); }

// ── 连戳计数 ──

function pushWindow(chatKey, op, winMs, now) {
  const arr = windows.get(chatKey) || [];
  arr.push({ ts: now, op });
  const cut = now - winMs;
  while (arr.length && arr[0].ts < cut) arr.shift();
  windows.set(chatKey, arr);
  return arr;
}

/** 命中阈值：进入冷却（或永久屏蔽）并返回本次动作；未命中返回 null。 */
function burstCheck(info) {
  const c = cfg();
  if (c.burstEnabled !== true) return null;

  const chatKey = String(info.chatKey || '');
  const op = String(info.operatorId || '');
  const now = Date.now();
  const winSec = Math.max(1, num(c.burstWindowSec, 30));
  const threshold = Math.max(1, Math.round(num(c.burstCount, 5)));
  const samePersonOnly = String(c.burstScope || '') === '同一个人';

  const arr = pushWindow(chatKey, op, winSec * 1000, now);
  const count = samePersonOnly ? arr.filter((e) => e.op === op).length : arr.length;
  if (count < threshold) return null;

  const cdSec = Math.max(0, num(c.cooldownSec, 600));
  setBlock(chatKey, cdSec > 0 ? now + cdSec * 1000 : 0);
  windows.delete(chatKey);                              // 进冷却后重新计数
  log(`连戳触发（${chatKey}，${winSec} 秒内 ${count} 次${samePersonOnly ? '同一人' : ''}）→ `
    + (cdSec > 0 ? `冷却 ${cdSec} 秒` : '永久屏蔽，直到发恢复指令'));

  if (String(c.burstAction || '') === '直接屏蔽不回复') return { action: 'silent' };
  const texts = parseTexts(c.burstText);
  const template = texts.length ? texts[Math.floor(Math.random() * texts.length)] : '';
  const text = renderText(template, {
    count, seconds: cdSec, minutes: Math.round(cdSec / 60), cd: cdSec > 0 ? `${cdSec} 秒` : '直到有人发指令'
  });
  return text ? { action: 'say', text } : { action: 'silent' };
}

/** 发恢复指令的人有没有资格。 */
async function canResume(info) {
  const c = cfg();
  const mode = String(c.resumeWho || '任何人');
  const sender = String(info.senderId || '');
  if (!sender) return false;
  if (mode === '任何人' || mode === 'anyone') return true;

  const listed = splitList(c.resumeUserIds);
  if (mode === '仅指定QQ号' || mode === 'listed') return listed.includes(sender);

  if (info.kind !== 'group') return true;               // 私聊里没有管理员概念 → 视为允许
  const api = info.onebot;
  if (!api || typeof api.call !== 'function') {
    warn('拿不到 onebot 接口，无法校验群管理员身份');
    return false;
  }
  try {
    const r = await api.call('get_group_member_info', { group_id: Number(info.chatId), user_id: Number(sender) });
    return ['owner', 'admin'].includes(String(r?.role || ''));
  } catch (error) {
    warn('查群成员身份失败：%s', error?.message ?? error);
    return false;
  }
}

// ── ① 运行前闸门 + 恢复指令 ──

export const providers = {
  'message.poke-gate': (info = {}) => {
    if (!gateSeen) {
      gateSeen = true;
      decisions.clear();                                // 切到零 token 模式，兼容模式的遗留决策作废
      log('核心支持运行前闸门：不理 / 回戳 / 连戳提示都不会调用模型（零 token）');
    }
    const c = cfg();
    const chatKey = String(info.chatKey || '');

    // ① 插件总开关：关掉就完全不接管。⚠️ 私聊戳一戳的死循环修复属于核心修复，不受它影响，常态生效。
    if (c.masterEnabled === false) {
      if (blocks.has(chatKey)) { clearBlock(chatKey); log(`${chatKey} 插件总开关已关闭，屏蔽状态一并解除`); }
      return null;
    }

    if (c.onlyWhenPoked !== false && !info.onMe) return null;   // 别人之间互戳不归本插件管

    // ② 无视戳一戳：不看概率、不看连戳，直接不理
    if (c.ignorePokes === true) {
      if (blocks.has(chatKey)) { clearBlock(chatKey); log(`${chatKey} 已开启「无视戳一戳」，屏蔽状态一并解除`); }
      if (c.debugLog) log(`${chatKey} 无视戳一戳 → 不理`);
      return { action: 'silent' };
    }

    // 连戳管制关掉时，屏蔽状态一并失效（否则永久屏蔽会变成解不开的死结）
    if (c.burstEnabled !== true) {
      if (blocks.has(chatKey)) { clearBlock(chatKey); log(`${chatKey} 连戳管制已关闭，屏蔽状态一并解除`); }
    } else {
      if (blockState(chatKey)) {
        if (c.debugLog) log(`${chatKey} 处于屏蔽/冷却中 → 不理`);
        return { action: 'silent' };
      }
      const burst = burstCheck(info);
      if (burst) return burst;
    }

    return { action: roll(String(info.operatorId || '')).action };
  },

  /** 接住恢复指令：整条消息等于指令才生效（避免闲聊里带这两个字被误解除）。 */
  'message.gate': async (info = {}) => {
    const c = cfg();
    if (c.masterEnabled === false || c.burstEnabled !== true) return null;
    const commands = splitList(c.resumeCommand);
    const text = String(info.text || '').trim();
    if (!commands.length || !text) return null;
    const hit = commands.find((cmd) => text === cmd || text.toLowerCase() === cmd.toLowerCase());
    if (!hit) return null;

    const chatKey = String(info.chatKey || '');
    if (!blocks.has(chatKey)) return null;              // 本来就没屏蔽 → 不接管，正常聊天
    if (!(await canResume(info))) {
      if (c.debugLog) log(`收到恢复指令「${hit}」但没有权限：${info.senderName || info.senderId}`);
      return null;
    }

    clearBlock(chatKey);
    windows.delete(chatKey);
    log(`${chatKey} 收到恢复指令「${hit}」（来自 ${info.senderName || info.senderId}）：戳一戳已恢复`);
    return { handled: true, say: unwrapBraces(c.resumeText) };
  },

  // ② 兼容闸门：按决策否决发送类工具（零 token 模式下无需干预）
  'tool.guard': ({ toolId, context } = {}) => {
    if (gateSeen) return true;
    const d = decisionOf(context?.sessionId);
    if (!d || d.action === 'reply') return true;
    if (!SEND_TOOLS.includes(String(toolId))) return true;
    if (d.action === 'poke-back' && toolId === 'send_poke') return true;
    return { ok: false, reason: blockReason(d) };
  }
};

// ── ② 兼容闸门：掷骰与执行前保险（零 token 模式下自动停用）──

export const hooks = {
  'before-context': ({ triggerEntries, sessionId, chatKey } = {}) => {
    if (gateSeen || !sessionId) return;
    const c = cfg();
    if (c.masterEnabled === false) return;
    pruneDecisions();

    const entries = Array.isArray(triggerEntries) ? triggerEntries : [];
    const pokes = entries.filter(isPokeEntry);
    if (!pokes.length || pokes.length !== entries.length) return;   // 不是纯戳一戳触发的就不插手
    if (c.onlyWhenPoked !== false && !pokes.some((e) => POKE_AT_ME.test(String(e?.text || '')))) return;

    const peerId = String(pokes.map((e) => e?.senderId).find(Boolean) || '');
    const { action } = c.ignorePokes === true ? { action: 'silent' } : roll(peerId);
    decisions.set(String(sessionId), { action, at: Date.now(), peerId });
    if (c.debugLog) log(`兼容模式（本次会话已建立，模型会被调用一次）：${chatKey || '?'}`);
  },

  'before-tool': ({ toolName, sessionId } = {}) => {
    if (gateSeen || cfg().masterEnabled === false) return;
    const d = decisionOf(sessionId);
    if (!d || d.action === 'reply') return;
    if (!SEND_TOOLS.includes(String(toolName))) return;
    if (d.action === 'poke-back' && toolName === 'send_poke') return;
    return { block: true, reason: blockReason(d) };
  }
};

/** 兼容模式配套：只在「回戳」的那一次运行里注入说明（priority 压低，少动提示词前缀缓存）。 */
export function promptSections(ctx = {}) {
  if (gateSeen || cfg().masterEnabled === false) return [];
  const d = decisionOf(ctx?.sessionId);
  if (!d || d.action !== 'poke-back') return [];
  const who = d.peerId ? `（对方 QQ：${d.peerId}）` : '';
  return [{
    id: 'poke-reply-poke-back',
    title: '戳一戳',
    priority: 20,
    content: `刚才这批消息是戳一戳事件${who}，规则判定的结果是「回戳一下」：`
      + '只调用 send_poke 回敬对方（群聊要传 targetUserId = 对方 QQ 号），不要发文字、表情或图片。'
      + '如果不想回，就什么都不调用。'
  }];
}
