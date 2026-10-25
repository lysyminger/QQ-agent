// 私聊认人（确定性型 / plugins/，纯 hooks）
//
// ── 要解决的问题（用户实测反馈）────────────────────────────────────────────
// 「我叫一心，跟它私聊了好久；另一个人私聊它问『一心是谁』，它不知道。」
// 原因：记忆是**按会话**存的（data/memory/<chatKey>/<uid>.json），一个人的昵称和
// 印象只挂在「private:<他的QQ>」这个目录下。换一个人来私聊，会话变了，机器人
// 就看不到「一心」这个名字 —— 它不是忘了，是那会儿根本没读。
//
// 已有的 plugins/cross-chat-link 解决的是另一半：**同一个人**在群和私聊之间的
// 认知割裂（谁这轮说话，就把他在别处的印象带上）。它按 uid 取，所以
// 「A 来问 B 是谁」这种**按名字反查**它接不住。
//
// ── 做法（两件事，都不经过模型判断）──────────────────────────────────────
//   ① 私聊里贴一小段「我认识的人」名单（昵称 + QQ 号 + 在哪聊过）。
//      名单是这句话能被答上来的前提：模型得先知道"一心"这个名字存在。
//   ② 本轮消息里**提到了**某个它认识的人，就把那个人的卡片展开：
//         【你认识他】幽冥一心（QQ:198549697）
//         · 你们在私聊 198549697 里聊过 4 次，最近一次是 3 天前
//         · 你记得：他让你叫他"一心"…｜爱开玩笑、发图玩梗…｜（最多 maxImpressions 条）
//         · 隐私：这些是私聊内容，**不要**跟现在说话的人复述…
//      并且点明"现在说话的是另一个人"，否则模型会把两个人当成同一个人。
//
// 为什么是 plugins/ 而不是 skills/：
//   需求是"它得知道/必须知道"，不是"它可以选择去查"。放 skills/ 要注册工具、由
//   模型决定何时调用 —— 用户问「一心是谁」时模型可能想不到去调，就是这次要修的
//   毛病本身。放 plugins/ 是每轮确定性注入，模型想忽略也忽略不掉。
//
// 不变量（重要）：
//   · 只读 data/memory 下的**小文件**（按人印象）和 data/messages 的**尾部**；
//     大文件（本机群记录 500KB+）不做整段解析，超限直接跳过。
//   · 一个人都没认出来 → 一个字都不加，绝不凭空编。
//   · 所有注入都追加在请求**末尾**（appendDynamicTail），不动 system 前缀，
//     否则系统提示词的前缀缓存会整段失效。
//   · 关掉插件 = 行为完全回到没装之前。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig } from '../../src/config.js';
import * as promptCore from '../../src/prompt.js';

/** 本插件目录的绝对路径（Windows 下必须走 fileURLToPath，别手撕 URL 字符串）。 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 排障用：把解析到的路径暴露出来，免得"认不出人"时只能猜。 */
export const __debug = { moduleDir: () => MODULE_DIR };

/**
 * 把卡片注入到请求**末尾**（保住 system 的缓存前缀）。
 *
 * 与 cross-chat-link 同一处理：`appendDynamicTail` 是较新的核心才有的函数，
 * 装到没有它的版本上时命名导入不报错，但调用那一刻会抛 "not a function"，
 * 整个插件静默失效。所以做存在性回退。
 */
const appendToMessages = typeof promptCore.appendDynamicTail === 'function'
  ? promptCore.appendDynamicTail
  : (messages, text) => {
    if (!Array.isArray(messages) || !text) return false;
    const block = `\n\n${String(text).trim()}`;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      if (typeof m.content === 'string') { m.content += block; return true; }
      if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
    }
    messages.push({ role: 'user', content: block.trim() });
    return true;
  };

/** 出厂默认值（与 plugin.json 的 settings 保持一致，改一处要改两处）。 */
const DEFAULTS = {
  enabled: true,
  maxPeople: 2,
  maxImpressions: 3,
  // ⚠️ 默认**不**贴名单（injectRoster: false）：名单是本插件唯一的固定成本，
  //    而"谁问了谁"这件事本身就能从消息里的名字判断出来 —— 用名字反查已经足够
  //    解决"另一个人问一心是谁"，贴名单只是给"没点名但想让人认出来"兜底。
  //    所以默认按需（点名才花钱），想更不容易漏的人把这两项打开即可。
  injectRoster: false,
  rosterOnQuestion: true,
  rosterMax: 8,
  // 群里认人：默认开（"把群里的人也记下来"就是这个）。成本只在有人被点名时产生，
  // 与"群聊每轮都注入"完全不是一回事。
  injectInGroup: true,
  // 群里的重名/短名误伤比私聊严重，所以后缀匹配要求至少 3 个字
  //（「一一」这种 2 字简称在群里不参与匹配，避免认错人）。
  groupMinNameLen: 3,
  groupPeopleMax: 2,
  privacyNote: true,
  // ⚠️ 默认**关**：这是本插件唯一"每轮都注入"的东西（群里每条约 76 token）。
  //    用户的诉求是"提到某个人名才调用插件；没这个人就不要有下一步" ——
  //    关掉它之后插件就纯粹是"先搜人名，搜到才注入"，闲聊一律 0 token。
  //    代价与补偿：没人被提到时不再有那句兜底；但只要提到了具体某人，
  //    卡片里就带着同一条硬规则（identityAndPrivacyLines），并不会漏。
  groupPrivacyGuard: false,
  // @ 的消息不认人（默认开）。@ 是明确的直接对话，认人没意义；
  // 判定在本地做，跳过的轮次 0 token。
  skipAtMentions: true,
  // 机器人自己的账号信息（白名单）：@ 到这些名字时**不跳过**，照常认人。
  //
  // 主路径其实是核心给的 atMe（@ 到自己就是 true），白名单是兜底：
  //   · atMe 拿不到时（老版本核心 / 别的协议端）靠它认出来；
  //   · 昵称改过、或有人用"妈妈/大肥鱼"这类叫法时，把别名补进来就认得出。
  // 已按本机实际情况预填：QQ 号取 SnowLuma 配置名（onebot_3331649402.json），
  // 昵称取 config.json 的 persona.botName / selfNickname。换号或改名时改这里即可。
  selfNames: '3331649402,小鲸鱼,大肥鱼',
  refreshMinutes: 5
};

/** 名单缓存最长的保鲜时间（设置项 refreshMinutes 是它的常规值）。 */
const MIN_REFRESH_MS = 60 * 1000;
/** 消息文件超过这个大小就只看元信息，不解析（避免每轮读 MB 级文件）。 */
const MESSAGES_MAX_BYTES = 2 * 1024 * 1024;
/** 名字最短 2 个字才参与**后缀/包含**匹配（1 个字误伤率太高）。 */
const MIN_NAME_LEN = 2;
/**
 * 完整昵称的最短长度。1 是刻意的：群里确实有人只叫「咲」「狐」一个字，
 * 而"@狐"这种完整昵称是可靠信号，不该因为短就丢掉 —— 放行条件交给
 * "此人最近真的活跃过"（见 findMentioned 的 requireRecentShort）。
 */
const MIN_EXACT_LEN = 1;

let api = null;

/** 本轮触发信息（before-context 收集，before-llm-messages 消费，用完即删）。 */
const pendingTrigger = new Map();

/** 名单缓存：{ at, people[], byName: Map }。 */
let rosterCache = { at: 0, people: [], byName: new Map() };

/** 当前设置（插件默认值 ← 用户在设置页改过的值）。 */
function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * 候选数据根目录（按优先级）。
 *
 * QQ Agent 的 DATA_DIR 在不同启动方式下会落到不同位置，同一个安装目录里**两处都
 * 可能有真实数据**（实测：核心配置与聊天记录在 <安装目录>/data，而图片缓存之类
 * 按 <app>/data 硬算的模块写在 resources/app/data）。插件只认一处的话，换一种
 * 启动方式就会「认不出任何人」而且不报错 —— 所以这里把三种可能都列出来，
 * 逐个探测，谁有数据用谁。
 */
function candidateRoots() {
  const out = [];
  const push = (p) => {
    const s = String(p || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  // 插件实际位置：<安装目录>/resources/app/plugins/<id>/index.js
  const appDir = path.resolve(MODULE_DIR, '..', '..');        // …\resources\app
  const installDir = path.resolve(MODULE_DIR, '..', '..', '..', '..');  // …\<安装目录>
  push(process.env.QQ_AGENT_DATA_DIR);                 // 显式覆盖（最高优先级）
  push(typeof DATA_DIR === 'string' ? DATA_DIR : '');  // 核心 config.js 的口径
  push(path.join(installDir, 'data'));                 // 打包版的常规位置（实测就是它）
  push(path.join(appDir, 'data'));                     // <app>/data（开发模式直起时在这）
  push(path.join(process.cwd ? process.cwd() : '', 'data'));  // 兜底：工作目录（.bat 直起的场景）
  return out;
}

/** 有 config.json 的那个根 = 正在用的数据根（探测不到就用第一个存在的）。 */
function dataRoot() {
  const roots = candidateRoots();
  for (const r of roots) {
    try { if (fs.existsSync(path.join(r, 'config.json'))) return r; } catch { /* 下一个 */ }
  }
  for (const r of roots) {
    try { if (fs.existsSync(path.join(r, 'memory')) || fs.existsSync(path.join(r, 'messages'))) return r; } catch { /* 下一个 */ }
  }
  return roots[0] || '';
}

/** 每个根下面的 memory/ 与 messages/ 目录（不存在的跳过）。 */
function dataDirs(name) {
  const out = [];
  for (const r of candidateRoots()) {
    const d = path.join(r, name);
    try { if (fs.existsSync(d)) out.push(d); } catch { /* 跳过 */ }
  }
  return out;
}

const memoryDirs = () => dataDirs('memory');
const messagesDirs = () => dataDirs('messages');
/** 会话文件目录（群名就存在里面，用来把「群 1091704415」显示成「群 渡川的模型屋」）。 */
const sessionsDirs = () => dataDirs('sessions');
/** 插件自己存的群名缓存（只写这一个文件，不碰核心的记忆文件）。 */
const groupNameCacheFile = () => path.join(dataRoot(), 'group-names.json');

/** 读一个小 JSON 文件（失败/超限当没有，绝不抛错影响主流程）。 */
function readJsonFile(file, maxBytes = MESSAGES_MAX_BYTES) {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ── 文本与名字处理 ────────────────────────────────────────────────────────

const isHan = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(ch);

/** 名字归一化：全角转半角、去空白、转小写（匹配时才不会因为空格/大小写漏）。 */
function normName(s) {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

/**
 * 从一段话里切出"可能的名字"：连续汉字切成 2~4 字片段，拉丁/数字串整段。
 * 用穷举片段而不是分词 —— 中文昵称没有词典，切片段反而更不容易漏。
 *
 * ⚠️ 短句必须也能切出 2 字片段（「一心是谁」→「一心」）：昵称常常是名字的简称
 *    （「幽冥一心」被叫成「一心」），漏了它等于这个功能只在念全名时可用。
 */
function extractCandidates(text, max = 400) {
  const out = [];
  const han = [];
  const flushHan = () => {
    const s = han.join('');
    han.length = 0;
    if (!s) return;
    for (let i = 0; i + 1 < s.length; i += 1) {
      for (let len = 2; len <= 4 && i + len <= s.length; len += 1) out.push(s.slice(i, i + len));
    }
  };
  const flushLatin = (s) => {
    if (s.length >= 2) out.push(s.toLowerCase());
  };
  let latin = '';
  for (const ch of String(text ?? '')) {
    if (isHan(ch)) {
      flushLatin(latin); latin = '';
      han.push(ch);
      continue;
    }
    flushHan();
    if (/[0-9a-zA-Z_]/.test(ch)) latin += ch;
    else { flushLatin(latin); latin = ''; }
    if (out.length > max) return out.slice(0, max);
  }
  flushHan();
  flushLatin(latin);
  return out.slice(0, max);
}

/**
 * memberNotes：{ [uid]: '别名' } 或 { [uid]: ['别名1','别名2'] } 两种历史形态。
 * 读全局配置（和 cross-chat-link 同一份），字段不存在就当没有 —— 别硬造。
 */
function memberNotes() {
  try {
    const direct = getConfig()?.memberNotes;
    if (direct && typeof direct === 'object') return direct;
  } catch { /* 继续去磁盘上找 */ }
  // 单独 import 本插件做测试时，核心可能读的不是"正在用的"那个 config.json：
  // 逐个候选根翻一遍，谁有 memberNotes 就用谁。
  for (const r of candidateRoots()) {
    const cfg = readJsonFile(path.join(r, 'config.json'), 8 * 1024 * 1024);
    const notes = cfg?.memberNotes;
    if (notes && typeof notes === 'object' && Object.keys(notes).length) return notes;
  }
  return null;
}

// ── 群名（把群号翻译成人话）────────────────────────────────────────────
//
// 问题：插件原来只写「群 1091704415」，而用户脑子里是「渡川的模型屋」——
// 机器人说得出群号、却听不懂群名，也认不出"你在哪个群说过什么"。
//
// 群名有三个来源，按可靠性排序：
//   ① 核心每轮直接把当前群名传进来（钩子载荷里的 chatName，最准）
//   ② data/sessions/*.json 里存着历史会话的 chatName（一次性扫描即可补齐）
//   ③ 插件自己的 data/group-names.json（把 ①② 攒下来，下次启动就有）
// 只写 ③ 这一个文件，不碰核心的 memory/ 目录。

let groupNames = new Map();
let groupNamesLoaded = false;

/** 读群名缓存（插件自己那个小文件）。 */
function loadGroupNames() {
  const map = new Map();
  try {
    const j = readJsonFile(groupNameCacheFile(), 512 * 1024);
    if (j && typeof j === 'object') {
      for (const [k, v] of Object.entries(j)) {
        const key = String(k || '').trim();
        const name = String(v ?? '').trim();
        if (key.startsWith('group:') && name) map.set(key, name);
      }
    }
  } catch { /* 没有缓存就靠 ①② */ }
  // sessions/*.json 补齐：会话文件里 chatName 就是群名
  for (const dir of sessionsDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const j = readJsonFile(path.join(dir, f), 256 * 1024);
      const chatKey = String(j?.chatKey || '').trim();
      const name = String(j?.chatName || '').trim();
      if (chatKey.startsWith('group:') && name) map.set(chatKey, name);
    }
  }
  return map;
}

function ensureGroupNames() {
  if (!groupNamesLoaded) {
    groupNames = loadGroupNames();
    groupNamesLoaded = true;
  }
  return groupNames;
}

/** 把当前会话的群名记下来（来自核心，最准），有变化就落盘。 */
function rememberGroupName(chatKey, name) {
  const key = String(chatKey || '').trim();
  const nm = String(name || '').trim();
  if (!key.startsWith('group:') || !nm) return;
  ensureGroupNames();
  if (groupNames.get(key) === nm) return;
  groupNames.set(key, nm);
  try {
    const obj = {};
    for (const [k, v] of groupNames) obj[k] = v;
    fs.writeFileSync(groupNameCacheFile(), JSON.stringify(obj, null, 1), 'utf8');
  } catch { /* 写不进去只影响显示，不影响认人 */ }
}

/**
 * 会话的显示名：`group:1091704415` → 「群 渡川的模型屋(1091704415)」。
 *
 * 为什么必须带群名：用户说的是群名，不是群号。原来只写群号时，机器人
 * 说得出"你在群 1091704415 里说过"，但用户说"渡川的模型屋"它却对不上号。
 * 群号仍然保留在括号里 —— 那是唯一不会变的标识，两边都给才既好懂又准确。
 */
const chatLabel = (chatKey) => {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group') {
    const name = ensureGroupNames().get(`group:${id}`);
    return name ? `群 ${name}(${id})` : `群 ${id}`;
  }
  if (kind === 'private') return `私聊 ${id}`;
  return String(chatKey || '?');
};

// ── 名单（它都认识谁）────────────────────────────────────────────────────

/** 印象数组：新形态 { content, createdAt } / 旧形态字符串，都吃。 */
function impressionsOf(data) {
  const list = Array.isArray(data?.impressions) ? data.impressions : [];
  return list
    .map((x) => ({
      text: String(x?.content ?? x ?? '').replace(/\s+/g, ' ').trim(),
      at: Number(x?.createdAt) || 0
    }))
    .filter((x) => x.text)
    .sort((a, b) => a.at - b.at);
}

/** data/memory 下有哪些会话目录（排掉 backups）。所有候选根一起扫。 */
function listMemoryChats() {
  const out = [];
  for (const dir of memoryDirs()) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === 'backups') continue;
        if (!/^(group|private)_\d+$/.test(e.name)) continue;
        const [kind, id] = e.name.split('_');
        out.push({ chatKey: `${kind}:${id}`, dir: path.join(dir, e.name) });
      }
    } catch { /* 这个根没有记忆目录 */ }
  }
  return out;
}

/**
 * 消息记录里每个人的「最后说话时间 + 昵称」，**按会话分开记**。
 *
 * 用途有两个：
 *   ① 印象是**定时巩固**出来的（默认 10 分钟一次），刚私聊完还没印象文件，
 *      这时靠消息记录兜底，否则最常遇到的那个场景（刚聊完就有人来问）反而漏掉。
 *   ② 群成员是谁：群消息里每条都带 senderName，攒起来就是这个群"发过言的人"名单。
 *      群人数可能几百，只看有印象的那几个（核心每次整理上限 15 人）远远不够。
 */
function lastSeenFromMessages() {
  const map = new Map();
  for (const dir of messagesDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = /^(group|private)_(\d+)\.json$/.exec(f);
      if (!m) continue;
      const data = readJsonFile(path.join(dir, f));
      const list = Array.isArray(data?.messages) ? data.messages : [];
      const chatKey = `${m[1]}:${m[2]}`;
      for (const msg of list) {
        const uid = String(msg?.senderId ?? '').trim();
        if (!uid || uid === 'self') continue;
        const ts = Number(msg?.ts) || 0;
        const nm = String(msg?.senderName ?? '').trim();
        const cur = map.get(uid) || { uids: new Map(), lastAt: 0, chatKey, name: '' };
        const prev = cur.uids.get(chatKey) || { lastAt: 0, name: '' };
        cur.uids.set(chatKey, {
          lastAt: Math.max(prev.lastAt, ts),
          // 名字取"最近一次说话时用的昵称"（改过昵称的以最新为准）
          name: (ts >= prev.lastAt && nm) ? nm : prev.name
        });
        if (ts >= cur.lastAt) {
          cur.lastAt = ts;
          cur.chatKey = chatKey;
          if (nm) cur.name = nm;
        }
        map.set(uid, cur);
      }
    }
  }
  return map;
}

/**
 * 构建名单：扫描 data/memory/<chatKey>/<uid>.json + data/messages/*.json。
 * 纯本地小文件读；失败只会让名单小一点，不会报错。
 */
function buildRoster() {
  const byUid = new Map();
  const seen = lastSeenFromMessages();

  for (const chat of listMemoryChats()) {
    let files = [];
    try { files = fs.readdirSync(chat.dir); } catch { continue; }
    for (const f of files) {
      const m = /^(\d+)\.json$/.exec(f);
      if (!m) continue;
      const uid = m[1];
      const data = readJsonFile(path.join(chat.dir, f), 512 * 1024);
      if (!data) continue;
      const cur = byUid.get(uid) || { uid, name: '', aliases: [], impressions: [], chats: new Map(), lastAt: 0 };
      const nm = String(data?.name ?? '').trim();
      if (nm) cur.name = nm;
      for (const imp of impressionsOf(data)) {
        cur.impressions.push(imp);
        if (imp.at > cur.lastAt) cur.lastAt = imp.at;
      }
      const t = Number(data?.updatedAt) || 0;
      if (t > cur.lastAt) cur.lastAt = t;
      const prev = cur.chats.get(chat.chatKey) || { lastAt: 0, impressions: 0, name: '' };
      cur.chats.set(chat.chatKey, {
        lastAt: Math.max(prev.lastAt, t || 0),
        impressions: prev.impressions + impressionsOf(data).length,
        name: nm || prev.name
      });
      byUid.set(uid, cur);
    }
  }

  // 消息记录兜底：没印象文件、但聊过的人也要进名单；
  // 同时把「每个群有哪些人」记下来（uids 的键就是这个人的会话集合）。
  for (const [uid, info] of seen) {
    const cur = byUid.get(uid) || { uid, name: '', aliases: [], impressions: [], chats: new Map(), lastAt: 0 };
    if (!cur.name && info.name) cur.name = info.name;
    if (info.lastAt > cur.lastAt) cur.lastAt = info.lastAt;
    for (const [chatKey, rec] of info.uids) {
      const prev = cur.chats.get(chatKey) || { lastAt: 0, impressions: 0, name: '' };
      cur.chats.set(chatKey, {
        lastAt: Math.max(prev.lastAt, rec.lastAt),
        impressions: prev.impressions,
        name: rec.name || prev.name
      });
    }
    byUid.set(uid, cur);
  }

  // 别名（memberNotes）合并进来
  const notes = memberNotes();
  if (notes && typeof notes === 'object') {
    for (const [uid, val] of Object.entries(notes)) {
      const cur = byUid.get(String(uid));
      if (!cur) continue;
      const arr = Array.isArray(val) ? val : [val];
      cur.aliases = arr.map((x) => String(x ?? '').trim()).filter(Boolean);
    }
  }

  // 排序 + 去重印象
  const people = [...byUid.values()]
    .filter((p) => p.chats.size > 0 || p.impressions.length > 0)
    .map((p) => {
      const imps = [];
      const seenText = new Set();
      for (const imp of p.impressions.slice().sort((a, b) => b.at - a.at)) {
        const key = imp.text.slice(0, 40);
        if (seenText.has(key)) continue;
        seenText.add(key);
        imps.push(imp);
      }
      const chats = [...p.chats.entries()]
        .map(([chatKey, info]) => ({ chatKey, ...info }))
        .sort((a, b) => b.lastAt - a.lastAt);
      return { ...p, impressions: imps, chats, lastNameAt: chats[0]?.lastAt || 0 };
    })
    .sort((a, b) => b.lastNameAt - a.lastNameAt);

  // ⚠️ 匹配**不**依赖任何索引表：直接在 people 上比名字。
  //    早先这里维护了一张 name → person 的表，实践证明显式索引比"就地比一遍"更容易
  //    出静默不一致（表里少了某个名字，表现就是"认得出全名却认不出简称"，
  //    而且不报错）。40 来个人，就地比一遍的成本可以忽略。
  const byName = new Map();
  for (const p of people) {
    for (const n of new Set([p.name, ...(p.aliases || [])].map(normName).filter((x) => x.length >= MIN_NAME_LEN))) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(p);
    }
  }

  // 「这个会话里有哪些人」——群聊按名字认人时必须限定在**本群**范围内，
  // 否则拿全名单（三个群 + 私聊混在一起）去匹配，重名会认错、短路名会误伤。
  const byChat = new Map();
  for (const p of people) {
    for (const c of p.chats) {
      if (!byChat.has(c.chatKey)) byChat.set(c.chatKey, []);
      byChat.get(c.chatKey).push(p);
    }
  }
  return { people, byName, byChat };
}

/** 某个会话里的成员（群聊 = 这个群发过言的人）。 */
function membersOf(chatKey) {
  const r = roster();
  return r.byChat?.get(String(chatKey)) || [];
}

/** 取名单（带缓存）。force = true 时强制重扫（activate / 诊断用）。 */
function roster({ force = false } = {}) {
  const everyMs = Math.max(MIN_REFRESH_MS, (Number(settings().refreshMinutes) || 5) * 60 * 1000);
  const now = Date.now();
  const fresh = rosterCache.people.length > 0
    && now - rosterCache.at < everyMs
    // 缓存里必须已经有"带名字的人"，否则一律重扫：空名单会让功能静默失效
    && rosterCache.people.some((p) => normName(p.name).length >= MIN_NAME_LEN);
  if (!force && fresh) return rosterCache;
  const built = buildRoster();
  rosterCache = { at: now, ...built };
  return rosterCache;
}

// ── 匹配与卡片 ────────────────────────────────────────────────────────────

/**
 * 昵称里的分隔符：`心之恒晶-过去现在` 这种名字，后半段整块不该被当成独立的称呼。
 * 实测教训：不加这道闸时，「你猜猜现在多少钱」会把"过去现在"的后缀"现在"命中，
 * 认成另一个人 —— 这是真实群聊里跑出来的误伤，不是假想。
 */
const NAME_SEPARATOR_RE = /[-_·•—|/\\.、,，。!！?？~～\s]/;
/** 过于泛用的词，永远不当作"在叫某个人"。 */
const NAME_STOPWORD_RE = /^(现在|过去|今天|明天|昨天|早上|中午|晚上|半夜|什么|怎么|这个|那个|哪个|我们|你们|他们|她们|自己|知道|时候|一个|可以|不是|就是|真的|有点|感觉|觉得|应该|可能|这样|那样|一样|以后|以前|最近|已经|还是|或者|但是|因为|所以|如果|然后|其实|一定|必须|大家|朋友|老师|老板|兄弟|姐妹|哥哥|姐姐|弟弟|妹妹|老公|老婆|宝贝|亲爱的)$/;

/**
 * 从一个完整昵称里取"可能被用来称呼他"的后缀。
 * 返回 `{ tail, short }`；被分隔符挡住（如 `过去现在`）或撞上泛用词则返回 null。
 * `short` = 短于 minLen 的后缀，由调用方决定要不要放行（例如要求此人最近活跃）。
 */
function suffixOf(full, i, minLen) {
  if (i > 0 && NAME_SEPARATOR_RE.test(full[i - 1])) return null;
  const tail = full.slice(i);
  if (tail.length < 2 || NAME_STOPWORD_RE.test(tail)) return null;
  return { tail, short: tail.length < minLen };
}

/**
 * 本轮消息里提到了哪个**群**（按群名匹配，不是群号）。
 *
 * 用户说"渡川的模型屋"时，机器人得知道那是指 group:1091704415 —— 否则它对不上号。
 * 只在真有群名被提到时才加一行（约 40 token），没提到就 0。
 */
function findMentionedGroups(text, { limit = 2 } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const norm = normName(raw);
  const out = [];
  // 长名字优先：同时命中"渡川的模型屋"和"渡川的模型屋2群"时要取更具体的那个
  const entries = [...ensureGroupNames()].sort((a, b) => normName(b[1]).length - normName(a[1]).length);
  for (const [chatKey, name] of entries) {
    const n = normName(name);
    if (n.length < 2) continue;
    // 双向包含：
    //   消息更长 → "渡川的模型屋**2群**里都有谁" 里含群名 ✓
    //   群名更长 → 消息只写简称"模型屋"时也能对上 ✓
    if (!norm.includes(n) && !n.includes(norm)) continue;
    out.push({ chatKey, name });
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

/** 提到群时给模型的一行提示：这个群叫什么、你和谁在这个群里认识。 */
function buildGroupNote(group, { currentChatKey, s }) {
  const id = String(group.chatKey).split(':')[1] || '';
  const lines = [`【群】${group.name}（${id}）`];
  if (group.chatKey === currentChatKey) {
    lines.push('· 就是你现在所在的这个群。');
    return lines.join('\n');
  }
  const members = membersOf(group.chatKey);
  const known = members.slice(0, 5).map((p) => p.name || p.uid).filter(Boolean);
  if (known.length) lines.push(`· 你在这个群里认识：${known.join('、')}${members.length > known.length ? ` 等 ${members.length} 人` : ''}`);
  else lines.push('· 这个群你还没什么印象。');
  lines.push(`· 你在这个群里的记忆和这里的记忆是分开的；私聊内容**不要**在群里提起（硬规则）。`);
  return lines.join('\n');
}

/**
 * 本轮消息提到了谁。
 *
 * 命中条件（两种，分开对待 —— 因为它们出错率不同）：
 *   ① **完整昵称**出现在消息里（群里 @ 人就是完整昵称）：直接认，但短昵称要
 *      "此人最近活跃过"才放行（见下面注释）。
 *   ② **昵称的后缀简称**（"一心" 来自 "幽冥一心"）：误伤率高，所以：
 *        · 不能被昵称里的分隔符挡住（`心之恒晶-过去现在` ≠ 可以说"现在"）；
 *        · 不能是泛用词（现在/今天/知道…）；
 *        · 最短 3 字；或 2 字但这个人**最近真的活跃**过（刚在本群说过话 / 跟机器人私聊过）。
 *      只写"≥3 字"时群里「一心最近咋样」认不出来 —— 而群友平时就是这么叫的；
 *      放开到 2 字又不加条件时，「你猜猜现在多少钱」会被误认。两条一起才是对的。
 *
 * @param {object}   opt
 * @param {string}   opt.excludeUid  排掉谁（说话的人不需要自己的卡）
 * @param {number}   opt.limit       最多出几张卡
 * @param {object[]} opt.members     限定候选人（群聊传本群成员，避免跨群/跨私聊认错人）
 * @param {number}   opt.minLen      后缀匹配的最短长度（群聊调高可少误伤）
 * @param {number}   opt.recentMs    短昵称放行所需的"最近活跃"时间窗
 * @param {boolean}  opt.requireRecentShort  短昵称是否需要"最近活跃"（群聊开，私聊关）
 */
function findMentioned(text, {
  excludeUid = '', limit = 2, members = null,
  minLen = MIN_NAME_LEN, recentMs = 0, requireRecentShort = false
} = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const norm = normName(raw);
  const cands = new Set(extractCandidates(raw));
  const inText = (n) => cands.has(n) || norm.includes(n);
  const pool = Array.isArray(members) ? members : roster().people;
  const floor = Math.max(2, Number(minLen) || MIN_NAME_LEN);
  const now = Date.now();

  const isRecent = (p) => {
    if (!recentMs) return false;
    return (p.chats || []).some((c) => (now - (c.lastAt || 0)) <= recentMs);
  };

  const hits = [];
  for (const p of pool) {
    // 后缀匹配用 ≥2 字；完整昵称允许 1 字（「咲」「狐」这种群里真实存在）
    const names = new Set([p.name, ...(p.aliases || [])]
      .map(normName)
      .filter((n) => n.length >= MIN_EXACT_LEN));
    const recent = requireRecentShort ? isRecent(p) : true;
    let best = '';
    for (const full of names) {
        // ① 完整昵称：群里 @ 人就是完整昵称，最可靠。但**短昵称**在群里太常见
        //    （「猫娘」既是昵称也是别人引用里的词，单字更是），所以要求此人最近活跃 ——
        //    不然一句话里随便出现一两个字就可能认错人。
        //    注意 requireRecentShort 只在群聊为真：私聊没有"群里最近发过言"这种信号，
        //    放行单字会把「一心是谁」里的"心"也认成另一个人（实测踩过）。
        if (inText(full)) {
          // 群聊有"最近活跃"这个信号可兜底，所以 1 字也认；
          // 私聊没有这个信号，低于 floor 的字数（含单字）一律不认 ——
          // 否则「一心是谁」里的"心"会被认成另一个人（实测踩过）。
          const allowed = requireRecentShort
            ? (full.length >= MIN_EXACT_LEN || recent)
            : (full.length >= floor);
          if (allowed) { if (full.length > best.length) best = full; continue; }
        }
      // ② 后缀简称：长度够就直接认；不够则要求此人最近活跃
      for (let i = 1; i + 2 <= full.length; i += 1) {
        const s = suffixOf(full, i, floor);
        if (!s || !inText(s.tail)) continue;
        if (s.short && !recent) continue;
        if (s.tail.length > best.length) best = s.tail;
      }
    }
    if (best) hits.push({ person: p, hit: best });
  }

  hits.sort((a, b) => (b.hit.length - a.hit.length) || (b.person.lastNameAt - a.person.lastNameAt));
  const out = [];
  for (const h of hits) {
    if (String(h.person.uid) === String(excludeUid)) continue;   // 本人的卡对他自己没意义
    if (out.some((o) => o.uid === h.person.uid)) continue;
    out.push({ ...h.person, __hitName: h.hit });
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

/**
 * 粗略 token 估算，只用于**在日志里量给自己看**（不参与任何请求）。
 * 中文按 1 字≈0.9 token、英文数字按 4 字符≈1 token —— 误差 ±20%，
 * 足够回答"这功能每轮加多少钱"这种量级问题。
 */
function estimateTokens(text) {
  const t = String(text ?? '');
  const han = (t.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  return Math.round(han * 0.9 + (t.length - han) / 4);
}

/** 「3 天前 / 今天 03:12」这种人话时间，比时间戳省 token 也好懂。 */
function humanWhen(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const days = Math.floor((now.getTime() - t) / 86400000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days <= 0) return `今天 ${hhmm}`;
  if (days === 1) return `昨天 ${hhmm}`;
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

/**
 * 同一个人的身份在两种场景里必须**一致**：QQ 号相同就是同一个人。
 *
 * 用户要求：
 *   ① 私聊内容**绝不**转发到群里（硬规则，不是"建议"）；
 *   ② 群里的人 = 私聊过的人（同一个 QQ），认得出、态度一致；
 *   ③ 群聊内容可以转发/复述（群里本来就公开）。
 *
 * 为什么两处都要写：cards 只在"有人被点名"时注入，而机器人完全可能在**没提到任何人**
 * 时顺手把别人私聊说的事讲出来。所以群聊里还要有一条无条件生效的短规则（见 hook）。
 */
function identityAndPrivacyLines(person, { currentChatKey, s, kind }) {
  const isGroup = kind === 'group';
  const groups = (person.chats || []).filter((c) => String(c.chatKey).startsWith('group:'));
  const privates = (person.chats || []).filter((c) => String(c.chatKey).startsWith('private:'));
  const lines = [];

  // ① 同一个人：把"他在哪些地方认识"一次说清，避免机器人当成两个人
  if (isGroup && privates.length) {
    lines.push(`· ${person.name || person.uid} 的 QQ 号和你私聊过的那个是同一个：**就是同一个人**，`
      + '你对他的了解、说话习惯照旧用，别当成两个陌生人。');
  } else if (!isGroup && groups.length) {
    lines.push(`· 他也是你所在的${groups.slice(0, 2).map((c) => chatLabel(c.chatKey)).join('、')}里的人 —— `
      + '同一个 QQ 号就是同一个人，认人和称呼要一致。');
  }

  if (s.privacyNote === false) return lines;   // 用户把隐私段关了就不加（但见 hook 里的兜底规则）

  // ②③ 私聊不许外传 / 群聊可以复述
  if (isGroup) {
    lines.push('· 【隐私·硬规则】私聊里说过的任何内容，**都不能**在这个群里提起、复述、暗示或转发 —— '
      + '哪怕被点名问到也不说，也不要透露"你跟他私聊过"或"他找过你"。'
      + '这个群里能聊的只有群聊内容和公开信息；群聊记录可以正常复述和转发。'
      + (privates.length ? '' : '（如果以后他私聊你，同样受这条约束。）'));
  } else {
    lines.push('· 【隐私·硬规则】私聊的内容绝不外传：不转发、不复述给任何人（群里的、别的私聊的都不行），'
      + '也不告诉别人"他来找过我/我们聊过什么"。群聊里的内容则可以正常说。');
  }
  return lines;
}

/**
 * 一个人的卡片。
 *
 * 两种口径必须分开写，混用会让机器人在群里说错话：
 *   kind='private' 现在说话的是**另一个人**（不是他），所以要点明"别当成同一个人"。
 *   kind='group'   群里提到的是**同群的另一个人**；若他也跟机器人私聊过，则必须
 *                  点明"同一个 QQ = 同一个人"，同时把私聊内容锁死不外传。
 */
function buildPersonCard(person, { currentChatKey, s, kind = 'private' }) {
  const name = person.name || `QQ:${person.uid}`;
  const inGroup = kind === 'group' || String(currentChatKey).startsWith('group:');
  const sameChat = (person.chats || []).find((c) => c.chatKey === currentChatKey) || null;
  const imps = (person.impressions || []).slice(0, Math.max(1, Number(s.maxImpressions) || 3));

  if (inGroup) {
    const lines = [`【本群的人】${name}（QQ:${person.uid}）`];
    if (sameChat) lines.push(`· 他是${chatLabel(currentChatKey)}的成员，最近在群里说过话${humanWhen(sameChat.lastAt) ? `（${humanWhen(sameChat.lastAt)}）` : ''}`);
    const otherChats = (person.chats || []).filter((c) => c.chatKey !== currentChatKey).slice(0, 2);
    if (otherChats.length) {
      // 只说"在哪见过"，不说"私聊跟我说过什么" —— 后者属于不能外传的内容
      const other = otherChats.map((c) => chatLabel(c.chatKey));
      const hasPrivate = otherChats.some((c) => String(c.chatKey).startsWith('private:'));
      lines.push(hasPrivate
        ? `· 你私下也认识他（${other.join('、')}），所以在群里遇到不算陌生人`
        : `· 你们在 ${other.join('、')} 也见过`);
    }
    if (imps.length) lines.push(`· 你记得他：${imps.map((x) => x.text.slice(0, 80)).join('｜')}`);
    else lines.push('· （还没有关于他的印象，只知道他在这个群里）');
    lines.push(...identityAndPrivacyLines(person, { currentChatKey, s, kind: 'group' }));
    lines.push('· 说话时按平常在群里那样称呼他就行，别把他当陌生人，也别把"本群的人"这句说出来。');
    return lines.join('\n');
  }

  const lines = [`【你认识他】${name}（QQ:${person.uid}）`];
  const chats = (person.chats || []).filter((c) => c.chatKey !== currentChatKey);
  const where = chats.slice(0, 2).map((c) => {
    const when = humanWhen(c.lastAt);
    return `${chatLabel(c.chatKey)}${when ? `（最近 ${when}）` : ''}`;
  });
  if (where.length) lines.push(`· 你们在 ${where.join('、')} 聊过`);
  if (imps.length) lines.push(`· 你记得他：${imps.map((x) => x.text.slice(0, 80)).join('｜')}`);
  if (!where.length && !imps.length) pointsOfInterestFallback(lines, person);

  lines.push('· 注意：现在跟你说话的是**另一个人**，不是他。可以承认你认识他、他是什么样的人，'
    + '但**别**说"他最近找过我""我们刚聊过"这类他没主动说过的近况。');
  lines.push(...identityAndPrivacyLines(person, { currentChatKey, s, kind: 'private' }));
  return lines.join('\n');
}

function pointsOfInterestFallback(lines, person) {
  const chats = (person.chats || []).slice(0, 1);
  if (chats.length) lines.push(`· 你们在 ${chatLabel(chats[0].chatKey)} 聊过`);
}

/**
 * 这句话像不像"在问某个人是谁"。
 *
 * 只有这类话才需要贴名单（"我认识谁"）；普通闲聊一句都不该花 token。
 * 判据是**问句结构**，不是关键词命中 —— 第一版写成"有问号或有身份词就触发"，
 * 实测「知道了」「我朋友问你叫什么」这类陈述句也被触发，等于没省。
 *
 * 注意：这里只决定"要不要贴名单"。**人名命中（findMentioned）不受本函数管**，
 * 所以"一心最近咋样"这种没有问号的陈述句照样能认出人来。
 */
const IDENTITY_QUESTION_RE = new RegExp(
  '(你是谁|你是谁啊|是谁|是谁啊|谁啊|那个人|哪个人|哪位|叫什么|叫什么名|名字叫|'
  + '认识吗|认识不|认识谁|认得|见过吗|记得吗|记得不|知道吗|知道不|'
  + '有人问|朋友问|他问|她问|问我|问你|提到过|说过我|有我这个人|什么来头|什么背景)'
);

/**
 * 这条消息 @ 的是不是**机器人自己**。
 *
 * ⚠️ 实测过的坑：原来只要文本里有 @ 就整轮跳过，结果「@小鲸鱼 你觉得一心是什么样的人」
 *    这种**直接问机器人**的话也被屏蔽了 —— 而那恰恰是最该认人的场景。
 *    真实数据里 681 条群消息有 63 条是 @ 机器人的，全部被误伤。
 *
 * 判断顺序（可靠 → 兜底）：
 *   ① `atMe`：核心解析好的布尔标记，@ 到自己就是 true。最可靠，且不受昵称改动影响。
 *   ② `atNames` + 白名单：被 @ 到的显示名（真实数据形如 ["@小鲸鱼"]）与用户填的
 *      「机器人自己的账号信息」比对 —— 用于 atMe 缺失时兜底，也能补充别名。
 */
function isAtSelf(entry, selfNames = []) {
  if (entry?.atMe === true) return true;
  const named = new Set();
  for (const n of Array.isArray(entry?.atNames) ? entry.atNames : []) {
    const s = normName(String(n ?? '').replace(/^@+/, ''));
    if (s) named.add(s);
  }
  if (!named.size) return false;
  for (const raw of selfNames) {
    const s = normName(String(raw ?? '').replace(/^@+/, ''));
    if (s && named.has(s)) return true;
  }
  return false;
}

/** 设置里的白名单字符串 → 数组（中英文逗号/分号/空白都能分隔）。 */
function parseSelfNames(raw) {
  return String(raw ?? '')
    .split(/[,，;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 这句话是不是"在 @ 某人"。
 *
 * 用户要求：带 @ 的消息不要走这个插件（@ 是明确的直接对话，认人没意义）——
 * **但 @ 机器人自己除外**：那是在直接问它，正是它最该认人的时候。
 *
 * 三种写法都要认：
 *   · 半角 `@`、全角 `＠`
 *   · 平台替换过的 `[at]` / `[AT]`（真实消息里见过这种形态）
 *   · OneBot 的 CQ 码 `[CQ:at,qq=123]`
 * 判断在本地字符串上做，不产生任何 token。
 */
const AT_RE = /@|＠|\[at\]|\[AT\]|\[CQ:at[,:]/i;
function looksLikeAtMention(text) {
  return AT_RE.test(String(text ?? ''));
}
function looksLikeIdentityQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 40) return false;   // 长句多半是在聊事，不是在问"这是谁"
  if (!/[\u4e00-\u9fff]/.test(t)) return false;
  // 例：「那猫娘呢」「一心呢」这类省略句也算问人
  if (/^[^?？]{1,12}[呢吗吧呀？?]$/.test(t) && /[\u4e00-\u9fff]/.test(t)) return true;
  return IDENTITY_QUESTION_RE.test(t);
}

/** 私聊里的「我认识的人」清单：只说昵称和 QQ 号，不带任何内容。 */
function buildRosterLine(s) {
  const r = roster();
  // ⚠️ 0 是"一个人都别列"，不能当成"没设置"回退默认值：
  //    Falsy 回退会让"把名单调成 0"反而变成默认 8 人（更贵）——
  //    用户调小本来是为省钱，结果越调越贵，还完全不报错。
  const limit = Number.isFinite(Number(s.rosterMax)) ? Math.max(0, Math.trunc(Number(s.rosterMax))) : 8;
  if (!limit || !r.people.length) return '';
  const list = r.people.slice(0, limit).map((p) => {
    const name = p.name || `QQ:${p.uid}`;
    const where = p.chats?.[0] ? chatLabel(p.chats[0].chatKey) : '';
    return where ? `${name}(QQ:${p.uid}，${where})` : `${name}(QQ:${p.uid})`;
  });
  const more = r.people.length > limit ? `，另外还有 ${r.people.length - limit} 位没列` : '';
  return [
    `【你私聊过的人】共 ${r.people.length} 位：${list.join('；')}${more}。`,
    '· 名单只是"你认识谁"。有人问起名单里的人，你已经认识他，不要反问"这是谁"。',
    '· 名单里的人的私聊内容属于隐私：可以认人，不要转述他们说过的话。'
  ].join('\n');
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
}

/** 生效：先把名单扫出来（顺带把"每轮要花多少"写进日志，省得以后靠猜）。 */
export function activate() {
  const s = settings();
  if (s.enabled === false) return;

  // 群聊整个关掉时：连本地名单都不扫 —— 不进群聊就不需要群成员名单，
  // 省掉启动时的磁盘扫描，也让"关掉群聊 = 真的什么都不做"这句话成立。
  if (s.injectInGroup !== true) {
    api?.log?.('私聊认人已启用：群聊已关（群聊内 0 token、不扫描群成员），只在私聊里认人');
    return;
  }

  try {
    const r = roster({ force: true });
    // 每轮固定成本写进日志，让"它到底贵不贵"可核对 —— 而不是等用户自己发现账单变高。
    // 必须走 fixedCostTokens()（它认 injectRoster 开关）：名单关着时这里就该是 0，
    // 直接 buildRosterLine() 会报出一个根本没发生的开销。
    const cost = fixedCostTokens();
    api?.log?.(`私聊认人已启用：名单里 ${r.people.length} 人（数据根 ${dataRoot()}）`
      + `；私聊每轮固定成本约 ${cost.tokens} token（${cost.reason}）`);
  } catch (error) {
    api?.warn?.('名单初始化失败：', error?.message ?? error);
  }
}

/** 关闭：只清缓存，磁盘上的记忆一个字都不动。 */
export function deactivate() {
  pendingTrigger.clear();
  rosterCache = { at: 0, people: [], byName: new Map() };
}

/**
 * 当前的固定成本（私聊每轮都会注入的那部分）。
 * 默认设置下名单是关的，所以这里必须是 0 —— 报错一个数比不报更糟，
 * 用户会以为自己每轮都在花钱。
 */
function fixedCostTokens() {
  const s = settings();
  if (s.injectRoster === false) return { chars: 0, tokens: 0, reason: '名单已关：只在提到认识的人时才注入' };
  const line = buildRosterLine(s);
  const tokens = line ? estimateTokens(line) : 0;
  return {
    chars: line.length,
    tokens,
    reason: s.rosterOnQuestion === false ? '私聊每轮都贴名单' : '名单只在该贴时才贴（像在问人 / 提到某人）'
  };
}

/** 开关（技能页的启用/停用走这里，不是自己维护一个 enabled 影子开关）。 */
export function available() {
  return settings().enabled !== false;
}

// ── 钩子 ──────────────────────────────────────────────────────────────────

export const hooks = {
  /** 记下这轮说了什么、谁在说、在哪个群（before-llm-messages 拿不到这三个）。 */
  async 'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const texts = [];
      const speakers = [];
      // @ 的信息要在这一轮带下去：before-llm-messages 的载荷里没有 triggerEntries。
      // atMe = 核心解析好的"@ 的是不是机器人自己"；atNames = 被 @ 到的显示名。
      let atMe = false;
      const atNames = [];
      for (const e of entries) {
        const t = String(e?.text ?? '').trim();
        if (t) texts.push(t);
        if (e?.atMe === true) atMe = true;
        for (const n of Array.isArray(e?.atNames) ? e.atNames : []) {
          const s = String(n ?? '').trim();
          if (s && !atNames.includes(s)) atNames.push(s);
        }
        const uid = String(e?.senderId ?? '').trim();
        if (uid && uid !== 'self' && !speakers.includes(uid)) speakers.push(uid);
      }
      // 当前会话的群名（核心已解析好）—— 顺手记下来，用来把群号翻译成群名
      rememberGroupName(String(ctx.chatKey || ''), ctx.chatName);
      pendingTrigger.set(String(ctx.sessionId || ctx.chatKey || ''), {
        chatKey: String(ctx.chatKey || ''),
        kind: String(ctx.kind || ''),
        chatName: String(ctx.chatName || ''),
        speakerId: speakers[speakers.length - 1] || '',
        atMe,
        atNames,
        text: texts.join('\n').slice(0, 1200)
      });
      if (pendingTrigger.size > 50) pendingTrigger.delete(pendingTrigger.keys().next().value);
    } catch { /* 收集失败只是这轮不带卡片 */ }
  },

  /** 注入：私聊名单（可关）+ 被提到的人的卡片（私聊 / 群聊各自的口径）。 */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;

    const key = String(ctx.sessionId || ctx.chatKey || '');
    const info = pendingTrigger.get(key) || null;
    pendingTrigger.delete(key);

    const chatKey = String(ctx.chatKey || info?.chatKey || '');
    const kind = String(ctx.kind || info?.kind || (chatKey.startsWith('group:') ? 'group' : 'private'));
    const isPrivate = kind === 'private' || chatKey.startsWith('private:');
    const isGroup = !isPrivate;

    // 核心每轮已经把当前会话名（群名）准备好了，顺手记下来：
    // 这是最可靠的来源，比事后去 sessions/*.json 里翻更准。
    rememberGroupName(chatKey, ctx.chatName);

    const blocks = [];
    const text = info?.text || '';

    // ⚠️ 群名说明要**在群聊早退之前**处理：私聊里也常提到群名
    //    （"渡川的模型屋里谁最活跃"），不能因为"群聊功能关了"就把这条路一起堵死。
    for (const g of findMentionedGroups(text)) {
      blocks.push(buildGroupNote(g, { currentChatKey: chatKey, s }));
    }

    // 群聊整个关掉时：群聊里一条指令都不注入、连本地名单都不用扫（真 0 token）。
    // 但上面已经处理好的"群名说明"照常生效（那是私聊/别的群里在提群名）。
    if (isGroup && s.injectInGroup !== true) {
      if (blocks.length) appendToMessages(ctx.messages, blocks.join('\n\n'));
      return;
    }

    // @ 的消息跳过（用户要求：@ 是明确的直接对话）——**但 @ 机器人自己除外**。
    //   原因（实测 bug）：原来只要有 @ 就整轮跳过，「@小鲸鱼 你觉得一心是什么样的人」
    //   这种直接问机器人的话被一起屏蔽了，正是最该认人的场景。
    //   是不是 @ 自己用核心的 atMe（最可靠）+ 设置里的白名单兜底判断。
    const selfNames = parseSelfNames(s.selfNames);
    const atSelf = isAtSelf({ atMe: info?.atMe, atNames: info?.atNames }, selfNames);
    if (s.skipAtMentions !== false && !atSelf && looksLikeAtMention(text)) return;

    // 群聊：**在本群成员范围里**认人（不拿三个群 + 私聊混在一起的名单去比，
    // 否则重名会认错）。私聊：全名单。
    // 群静默成员不进候选（只在名单里有名字、从没发过言的人，进不了 messages 统计）。
    const members = isGroup ? membersOf(chatKey) : null;
    const mentioned = text
      ? findMentioned(text, {
        // 群里说话的人自己不需要自己的卡；私聊同理
        excludeUid: info?.speakerId || '',
        limit: Math.max(1, Number(isGroup ? s.groupPeopleMax : s.maxPeople) || 2),
        members,
        minLen: isGroup ? Math.max(2, Number(s.groupMinNameLen) || 3) : MIN_NAME_LEN,
        // 群里：短简称只在"这个人最近真的在活动"时才认（少误伤）
        recentMs: isGroup ? 7 * 24 * 60 * 60 * 1000 : 0,
        requireRecentShort: isGroup
      })
      : [];

    // 名单（"我认识谁"）什么时候贴 —— 这是本插件唯一的固定成本，所以按需给：
    //   · 提到了具体某人 → 给（要认人，名单是前提）
    //   · 像在问人（"我朋友问你叫什么""昨天那人是谁"）→ 给（没有名单就答不上来）
    //   · 普通闲聊 → 不给（默认，省 token）
    //   · 群聊默认完全不给名单（群动辄上百人，贴不起；靠上面按本群成员匹配就够）
    // rosterOnQuestion = false 时退回"私聊每轮都贴"（最不容易漏，但每轮都花钱）。
    const wantRoster = isPrivate && s.injectRoster !== false
      && (mentioned.length > 0 || s.rosterOnQuestion === false || looksLikeIdentityQuestion(text));
    if (wantRoster) {
      const line = buildRosterLine(s);
      if (line) blocks.push(line);
    }

    for (const person of mentioned) {
      blocks.push(buildPersonCard(person, { currentChatKey: chatKey, s, kind: isGroup ? 'group' : 'private' }));
    }

    // 群聊兜底硬规则（**无条件**注入，和上面"有没有认到人"无关）。
    // 为什么必须有：卡片只在有人被点名时出现，而机器人完全可能在**没人被提到**的时候
    // 顺手把某人私聊说的事当谈资讲出来 —— 那正是"私聊内容绝不转发"要拦的场景。
    // 用户明确要求的是硬规则，所以这条不放在"按需"里。
    if (isGroup && s.privacyNote !== false && s.groupPrivacyGuard !== false) {
      blocks.unshift('【隐私·硬规则】这个群里绝不出现任何私聊内容：不转发、不复述、不暗示"某人私聊跟我说过什么"，'
        + '也不说"他找过我"。私聊归私聊，群里只聊群里的事（群聊记录可以正常复述和转发）。');
    }

    if (!blocks.length) return;   // 没认出来就不加字
    appendToMessages(ctx.messages, blocks.join('\n\n'));
  }
};

// ── 能力：排查用（不参与正常对话）────────────────────────────────────────

export const providers = {
  /**
   * 问「它到底认识谁 / 认得某某吗」。
   * args: { uid?, query?, refresh? }
   *   uid     —— 直接看某个 QQ 号的资料
   *   query   —— 用一句模拟的话走一遍真实匹配逻辑
   *   refresh —— 强制重扫名单
   */
  'memory.known-people': (args = {}) => {
    try {
      const r = roster({ force: args?.refresh === true });
      const uid = String(args?.uid ?? '').trim();
      const query = String(args?.query ?? '').trim();
      if (uid) {
        const person = r.people.find((p) => String(p.uid) === uid) || null;
        const rec = person ? {
          uid: person.uid,
          name: person.name,
          chats: person.chats.map((c) => c.chatKey),
          lastAt: person.lastNameAt,
          hoursAgo: person.lastNameAt ? Math.round((Date.now() - person.lastNameAt) / 3600000) : null,
          recentWithin7d: (person.chats || []).some((c) => Date.now() - (c.lastAt || 0) <= 7 * 86400000),
          shortNameEligible: (person.chats || []).some((c) => Date.now() - (c.lastAt || 0) <= 7 * 86400000),
          impressions: person.impressions.length
        } : null;
        return { ok: true, count: r.people.length, found: Boolean(person), uid, person, diagnostic: rec };
      }
      if (query) {
        // 传了 chatKey 就按那个会话的成员范围匹配（群里认人就是这么做的），
        // 否则按全名单匹配。排查"群里为什么认不出某人"时靠它。
        const scope = String(args?.chatKey ?? '').trim();
        const isGroupScope = scope.startsWith('group:');
        // 诊断接口只有一句文本、没有 atMe，所以用白名单里的名字判断"这条 @ 的是不是自己"
        const selfNames = parseSelfNames(settings().selfNames);
        const atSelfInQuery = selfNames.some((n) => {
          const s = normName(n).replace(/^@+/, '');
          return s.length >= 1 && normName(query).includes(s);
        });
        const skippedAt = settings().skipAtMentions !== false && !atSelfInQuery && looksLikeAtMention(query);
        if (skippedAt) {
          return {
            ok: true, count: r.people.length, query, scope: scope || '(全名单)', matched: [],
            skipped: '含 @（且不是 @ 自己），按设置跳过'
          };
        }
        const matched = findMentioned(query, {
          limit: 5,
          members: scope ? membersOf(scope) : null,
          minLen: isGroupScope ? Math.max(2, Number(settings().groupMinNameLen) || 3) : MIN_NAME_LEN,
          recentMs: isGroupScope ? 7 * 24 * 60 * 60 * 1000 : 0,
          requireRecentShort: isGroupScope
        });
        return {
          ok: true,
          count: r.people.length,
          query,
          scope: scope || '(全名单)',
          scopeMembers: scope ? membersOf(scope).length : r.people.length,
          matched: matched.map((p) => ({ uid: p.uid, name: p.name, hit: p.__hitName })),
          // 排障用：切出来的候选片段 + 名单里的名字（"认得全名却认不出简称"时靠它定位）
          debug: {
            candidates: extractCandidates(query).slice(0, 40),
            names: r.people.map((p) => p.name).filter(Boolean).slice(0, 60)
          }
        };
      }
      return {
        ok: true,
        count: r.people.length,
        dataRoot: dataRoot(),
        candidates: candidateRoots(),
        // 每轮固定成本（私聊那段名单），方便回答"这功能每轮花多少 token"
        fixedCost: fixedCostTokens(),
        // 每个会话有多少人在名单里（群聊 = 这个群发过言、机器人认得出的人）
        chats: [...(r.byChat || new Map()).entries()]
          .map(([chatKey, list]) => ({ chatKey, name: ensureGroupNames().get(chatKey) || '', members: list.length }))
          .sort((a, b) => b.members - a.members),
        // 已知的群名（群号 → 群名），排查"为什么它不知道我说的群"时看这里
        groupNames: [...ensureGroupNames()].map(([chatKey, name]) => ({ chatKey, name })),
        people: r.people.map((p) => ({
          uid: p.uid,
          name: p.name,
          aliases: p.aliases,
          chats: p.chats.map((c) => c.chatKey),
          impressions: p.impressions.length,
          lastAt: p.lastNameAt
        }))
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
};
