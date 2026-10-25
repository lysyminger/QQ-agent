// 群友身份对照（QQ 号识别）—— 插件实现。
//
// ── 为什么要有这个插件 ────────────────────────────────────────────────────
// 用户的原话：「做一个记忆群友 QQ 号识别的插件，而不是依赖于群聊里的账号名字，
// 避免出现了群友修改名字之后就无法识别存档的问题，让记忆库里同 QQ 号的存档合并」。
//
// 现状（已实测）：
//   · 核心记忆库**本来就是按 QQ 号存**的（data/memory/group_xxx/<QQ>.json ✓），
//     所以"改名就丢存档"目前没发生在文件层面；问题在**语义层** ✗：
//     记忆正文里全是「他/她和『网络职工』互动…」这种**名字**，而"名字 ↔ QQ"
//     这个对照关系**没有任何地方持久化** ✗ —— 一旦有人改名，模型读到旧名字就
//     对不上人，等于认不出来 ✓。
//   · 另外核心在"只有名字、没有 QQ 号"时会退化成 `_n_<名字>.json` ✗（按名字建存档），
//     改名就会再生成一份，同一个人的记忆被拆成两份 ✓。
//
// 本插件做三件事：
//   ① 每次消息自动学习「名字 → QQ」（含曾用名、首次/最近出现时间、出现次数），
//      持久化到 data/qq-identity.json ✓ —— 名字会变，QQ 号不变 ✓。
//   ② 把当前群的对照表注入提示词：「小鱼(QQ 12345)、曾用名：小魚/鱼鱼」，
//      并明确告诉模型"记忆里看到任何名字，都用这张表核对 QQ 号" ✓。
//   ③ 提供工具：查名字/查 QQ、列成员、**把按名字存的存档合并到 QQ 号下** ✓
//      （合并前把原文件备份到 memory/backups/merged-<时间>/ ✓，可回溯 ✓）。
//
// 还给核心留了一个兜底钩子：`globalThis.__qqIdentity`（见 resolveUserId），
// 让 src/memory.js 在"只给了名字"时也能查到 QQ 号，从源头避免再生成 `_n_` 存档 ✓。

import fs from 'node:fs';
import path from 'node:path';

const BUILD_TAG = 'v1.0.0';
const DEFAULTS = { enabled: true, injectLimit: 40, aliasKeep: 6, announceRename: true };

let api = null;
let dataDirCache = '';
let state = null;          // { version, chats: { [chatKey]: { members: { [userId]: {...} } } } }
let saveTimer = null;
let dirty = false;

// ── 基础设施 ──────────────────────────────────────────────────────────────

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function log(...a) { try { api?.log?.(...a); } catch { /* ignore */ } }
function warn(...a) { try { api?.warn?.(...a); } catch { /* ignore */ } }

async function dataDir() {
  if (dataDirCache) return dataDirCache;
  const fromEnv = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (fromEnv) { dataDirCache = fromEnv; return dataDirCache; }
  try {
    const cfg = await import('../../src/config.js');
    dataDirCache = String(cfg.DATA_DIR || '');
  } catch { dataDirCache = ''; }
  return dataDirCache;
}

async function stateFile() {
  const dir = await dataDir();
  return dir ? path.join(dir, 'qq-identity.json') : '';
}

/** 群目录名与核心 src/memory.js 的 chatDirName 保持一致（否则找不到存档）。 */
function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

async function load() {
  if (state) return state;
  state = { version: 1, chats: {} };
  try {
    const f = await stateFile();
    if (f && fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && typeof j === 'object' && j.chats) state = { version: 1, chats: j.chats };
    }
  } catch (error) {
    warn(`读取对照表失败（将从空开始，旧文件不会被覆盖）：${error?.message ?? error}`);
  }
  return state;
}

/** 落盘：合并短时间内的多次观察，避免每条消息都写盘。 */
function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, 4000);
  saveTimer.unref?.();
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    const f = await stateFile();
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state, null, 1), 'utf8');
  } catch (error) { warn(`保存对照表失败：${error?.message ?? error}`); }
}

// ── 学习：从每条消息里记住「名字 → QQ」 ────────────────────────────────────

function ensureMember(chat, userId) {
  const members = chat.members || (chat.members = {});
  let m = members[userId];
  if (!m) m = members[userId] = { userId, names: {}, first: 0, last: 0, count: 0, current: '' };
  return m;
}

/**
 * 观察一条消息（含随手学到的别名）。
 * @returns {{renamed:boolean, from?:string, to?:string}|null}
 */
export function observeMessage(chatKey, userId, senderName, at = Date.now()) {
  const id = String(userId ?? '').trim();
  if (!chatKey || !id) return null;
  const conf = settings();
  if (!conf.enabled) return null;
  const name = String(senderName ?? '').trim();
  const st = state || { version: 1, chats: {} };
  const chat = st.chats[chatKey] || (st.chats[chatKey] = { chatKey, members: {} });
  const m = ensureMember(chat, id);
  m.count += 1;
  m.last = at;
  if (!m.first) m.first = at;
  let renamed = null;
  if (name && name !== m.current) {
    if (m.current && conf.announceRename !== false) {
      renamed = { from: m.current, to: name };
      log(`群友 ${id} 改名为「${name}」（曾用名「${m.current}」）`);
    }
    m.current = name;
  }
  if (name) {
    const rec = m.names[name] || (m.names[name] = { name, first: at, last: at, count: 0 });
    rec.last = at;
    rec.count += 1;
    // 别名裁剪：按最近使用保留 N 个
    const keep = Math.max(1, Number(conf.aliasKeep) || 6);
    const list = Object.values(m.names).sort((a, b) => b.last - a.last);
    if (list.length > keep) {
      m.names = {};
      for (const r of list.slice(0, keep)) m.names[r.name] = r;
    }
    // ⚠️ 但"能不能靠老名字认出这个人"不能因为裁剪而丢失（2026-10-11 自测暴露）：
    //    曾用名被裁掉之后，记忆库里按老名字存的存档就再也合并不了 ✗。
    //    所以另存一份**不裁剪的索引**（名字 → QQ），只按容量上限淘汰最久未用的。
    const idx = chat.aliasIndex || (chat.aliasIndex = {});
    idx[name] = { id, last: at };
    const keys = Object.keys(idx);
    if (keys.length > 800) {
      const byLast = keys.sort((a, b) => (idx[b]?.last || 0) - (idx[a]?.last || 0));
      for (const k of byLast.slice(600)) delete idx[k];
    }
  }
  scheduleSave();
  return renamed;
}

/** 从钩子上下文里把这一轮所有消息都学一遍。 */
function observeContext(ctx) {
  try {
    const chatKey = String(ctx?.chatKey || '');
    if (!chatKey) return;
    const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
    for (const e of entries) {
      if (!e || e.self) continue;
      observeMessage(chatKey, e.senderId, e.senderName, Number(e.ts) || Date.now());
    }
  } catch (error) { warn(`学习失败（不影响聊天）：${error?.message ?? error}`); }
}

// ── 查询 ──────────────────────────────────────────────────────────────────

/** 按名字找 QQ（先精确、再去空白与大小写、最后模糊包含）。 */
export function resolveUserId(chatKey, name) {
  const st = state;
  if (!st || !chatKey) return '';
  const chat = st.chats[chatKey];
  if (!chat) return '';
  const want = String(name ?? '').trim();
  if (!want) return '';
  const members = Object.values(chat.members || {});
  const exact = members.find((m) => m.current === want || (m.names || {})[want]);
  if (exact) return exact.userId;
  const lower = want.toLowerCase();
  const ci = members.find((m) => Object.keys(m.names || {}).some((n) => n.toLowerCase() === lower));
  if (ci) return ci.userId;
  // 永久别名索引（不被裁剪）：老名字、曾用名都能认出同一个 QQ ✓
  const idx = chat.aliasIndex || {};
  if (idx[want]?.id) return String(idx[want].id);
  const idxCi = Object.keys(idx).find((n) => n.toLowerCase() === lower);
  if (idxCi) return String(idx[idxCi].id);
  const partial = members.find((m) => Object.keys(m.names || {}).some((n) => n.includes(want) || want.includes(n)));
  return partial ? partial.userId : '';
}

/** 按 QQ 找名字与人设标签。 */
export function describeMember(chatKey, userId) {
  const chat = state?.chats?.[chatKey];
  const m = chat?.members?.[String(userId ?? '').trim()];
  if (!m) return null;
  const aliases = Object.values(m.names || {}).sort((a, b) => b.last - a.last).map((x) => x.name);
  return {
    userId: m.userId,
    name: m.current || aliases[0] || '',
    aliases: aliases.filter((n, i) => n !== m.current && i > 0 || n !== m.current),
    count: m.count,
    first: m.first,
    last: m.last
  };
}

/** 最近活跃的成员列表。 */
export function listMembers(chatKey, limit = 40) {
  const chat = state?.chats?.[chatKey];
  if (!chat) return [];
  return Object.values(chat.members || {})
    .sort((a, b) => (b.last || 0) - (a.last || 0))
    .slice(0, Math.max(1, Number(limit) || 40))
    .map((m) => ({ userId: m.userId, name: m.current || '', count: m.count, last: m.last }));
}

// ── 合并：把"按名字存的存档"并到同一个 QQ 号下 ──────────────────────────────

/**
 * 扫描某个会话的记忆目录，把 `_n_<名字>.json`（核心在"只有名字"时建的存档）
 * 合并进 `<QQ>.json`。合并前原文件备份到 memory/backups/merged-<时间>/ ✓。
 * @param {string} chatKey
 * @param {{apply?:boolean}} [opts] apply=false 时只报告不落盘（干跑）
 */
export async function mergeNameKeyed(chatKey, { apply = false } = {}) {
  const dir0 = await dataDir();
  if (!dir0) return { ok: false, reason: '拿不到数据目录' };
  const dir = path.join(dir0, 'memory', chatDirName(chatKey));
  if (!fs.existsSync(dir)) return { ok: true, scanned: 0, merged: [], skipped: [], backup: '' };
  const files = fs.readdirSync(dir).filter((f) => /^_n_.+\.json$/.test(f));
  const merged = [];
  const skipped = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dir0, 'memory', 'backups', `merged-${stamp}`);
  for (const f of files) {
    const full = path.join(dir, f);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { skipped.push({ file: f, why: '文件解析失败' }); continue; }
    const name = String(rec?.name || f.replace(/^_n_/, '').replace(/\.json$/, '')).trim();
    const uid = resolveUserId(chatKey, name);
    if (!uid) { skipped.push({ file: f, name, why: '对照表里还没有这个名字对应的 QQ 号（等他在群里说一次话就会学到）' }); continue; }
    const target = path.join(dir, `${uid}.json`);
    let dst = { userId: uid, name, impressions: [] };
    if (fs.existsSync(target)) {
      try { dst = JSON.parse(fs.readFileSync(target, 'utf8')) || dst; } catch { /* 目标坏了就用新的 */ }
    }
    const have = new Set((dst.impressions || []).map((x) => String(x?.content ?? '')));
    let added = 0;
    for (const it of (rec.impressions || [])) {
      const c = String(it?.content ?? '');
      if (!c || have.has(c)) continue;
      have.add(c);
      (dst.impressions || (dst.impressions = [])).push(it);
      added += 1;
    }
    dst.userId = uid;
    if (rec.name && !dst.name) dst.name = rec.name;
    merged.push({ file: f, name, userId: uid, added, total: (dst.impressions || []).length });
    if (apply) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(full, path.join(backupDir, f));
      fs.writeFileSync(target, JSON.stringify(dst, null, 1), 'utf8');
      fs.unlinkSync(full);
    }
  }
  if (apply && merged.length) log(`已合并 ${merged.length} 份按名字存的存档到 QQ 号下（原件备份在 ${path.relative(dir0, backupDir)}）`);
  return { ok: true, scanned: files.length, merged, skipped, backup: merged.length ? backupDir : '' };
}

// ── 插件导出 ──────────────────────────────────────────────────────────────

export const hooks = {
  // before-context 的返回值会被忽略（核心明确如此），这里只做**副作用**：学习对照表 ✓
  'before-context': (ctx) => { observeContext(ctx); return undefined; }
};

export function promptSections(ctx = {}) {
  try {
    if (!settings().enabled) return [];
    const chatKey = String(ctx?.chatKey || '');
    if (!chatKey) return [];
    const limit = Math.max(5, Number(settings().injectLimit) || 40);
    const list = listMembers(chatKey, limit);
    if (list.length < 1) return [];
    const lines = list.map((m) => {
      const d = describeMember(chatKey, m.userId);
      const old = (d?.aliases || []).filter((n) => n && n !== d.name);
      return `· ${d?.name || '(无名)'} → QQ ${m.userId}${old.length ? `（曾用名：${old.slice(0, 3).join('、')}）` : ''}`;
    });
    return [{
      id: 'qq-identity',
      title: '',
      content: '【群友身份对照（名字 → QQ 号）】名字会改，QQ 号不会。记忆里、聊天记录里'
        + '出现任何一个名字，都用这张表核对是**同一个人**；提到某人时优先用 QQ 号确认，'
        + '不要因为改名就当成新群友。\n' + lines.join('\n'),
      // 45：在核心安全规则（100）/工具协议之后、普通技能段（50）附近 ——
      // 这是"认人"的事实依据，不该盖住任何规则，也不该被风格类段落挤掉。
      priority: 45
    }];
  } catch (error) {
    warn(`生成对照表失败：${error?.message ?? error}`);
    return [];
  }
}

export const providers = {
  /** 给核心/其它插件用的身份能力。 */
  'message.identity': () => ({
    resolveUserId: (chatKey, name) => resolveUserId(chatKey, name),
    describeMember: (chatKey, userId) => describeMember(chatKey, userId),
    listMembers: (chatKey, limit) => listMembers(chatKey, limit)
  })
};

export async function setup(a) {
  api = a;
  await load();       // 先把对照表读进来，钩子和提示词段才能用
  // 给核心 src/memory.js 留的兜底钩子：只有名字时也能查到 QQ 号，
  // 从源头避免再生成 `_n_<名字>.json` 这种"按名字存的存档" ✓
  globalThis.__qqIdentity = {
    resolveUserId: (chatKey, name) => resolveUserId(chatKey, name),
    describeMember: (chatKey, userId) => describeMember(chatKey, userId)
  };
}

export function activate() {
  const conf = settings();
  if (!conf.enabled) return;
  api?.registerTool?.({
    id: 'lookup',
    name: '查群友 QQ 号',
    category: 'utility',
    icon: '🪪',
    description: '按名字查 QQ 号，或按 QQ 号查名字与曾用名。群里有人改名后用它确认是不是同一个人。',
    parameters: {
      type: 'object',
      properties: {
        chatKey: { type: 'string', description: '会话，如 group:123456；不填默认当前会话' },
        name: { type: 'string', description: '群里的名字（支持曾用名）' },
        userId: { type: 'string', description: 'QQ 号' }
      }
    },
    execute: async (args = {}, ctx = {}) => {
      await load();
      const chatKey = String(args.chatKey || ctx?.chatKey || '').trim();
      if (!chatKey) return { isError: true, content: '缺少会话信息' };
      if (args.userId) {
        const d = describeMember(chatKey, args.userId);
        if (!d) return { content: `对照表中没有 QQ ${args.userId}（等他在群里说一次话就会学到）` };
        return { content: `QQ ${d.userId} = 「${d.name}」${d.aliases.length ? `，曾用名：${d.aliases.join('、')}` : ''}（说过 ${d.count} 次话）` };
      }
      if (args.name) {
        const uid = resolveUserId(chatKey, args.name);
        if (!uid) return { content: `对照表里没有「${args.name}」对应的 QQ 号（可能是新群友，或还没在这个群说过话）` };
        const d = describeMember(chatKey, uid);
        return { content: `「${args.name}」= QQ ${uid}（当前名字「${d?.name || ''}」${d?.aliases?.length ? `，曾用名：${d.aliases.join('、')}` : ''}）` };
      }
      const list = listMembers(chatKey, 20);
      return { content: `最近活跃 ${list.length} 位：\n` + list.map((m) => `· ${m.name} → QQ ${m.userId}`).join('\n') };
    }
  });
  api?.registerTool?.({
    id: 'merge',
    name: '合并同一 QQ 的存档',
    category: 'utility',
    icon: '🧩',
    description: '把记忆库里按「名字」存的存档合并到对应 QQ 号名下（同一 QQ 只保留一份）。默认干跑只报告，apply=true 才真的合并（原件会先备份）。',
    parameters: {
      type: 'object',
      properties: {
        chatKey: { type: 'string', description: '会话，如 group:123456；不填默认当前会话' },
        apply: { type: 'boolean', description: 'true = 真的合并并备份原件；默认 false 只报告' }
      }
    },
    execute: async (args = {}, ctx = {}) => {
      await load();
      const chatKey = String(args.chatKey || ctx?.chatKey || '').trim();
      if (!chatKey) return { isError: true, content: '缺少会话信息' };
      const r = await mergeNameKeyed(chatKey, { apply: args.apply === true });
      if (!r.ok) return { isError: true, content: r.reason };
      const head = args.apply === true ? '合并完成' : '干跑（未改动任何文件）';
      const lines = [`${head}：扫到 ${r.scanned} 份按名字存的存档`];
      for (const m of r.merged) lines.push(`· ${m.file} → QQ ${m.userId}（「${m.name}」）：新增 ${m.added} 条印象，合并后共 ${m.total} 条`);
      for (const s of r.skipped) lines.push(`· 跳过 ${s.file}：${s.why}`);
      if (r.backup) lines.push(`原件备份：${path.basename(r.backup)}`);
      if (!r.scanned) lines.push('这个会话目前没有按名字存的存档，无需合并。');
      return { content: lines.join('\n') };
    }
  });
  log(`群友身份对照已启用（${BUILD_TAG}）：名字 ↔ QQ 号，改名也能认出同一个人。`);
}

export function deactivate() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  void flush();
  try { delete globalThis.__qqIdentity; } catch { /* ignore */ }
}
