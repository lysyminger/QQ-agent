// group-learner —— 群内学习·群文化记忆（确定性型插件，放 plugins/，控制台「插件」页签）
//
// ── 它解决什么 ────────────────────────────────────────────────────────────
//   宿主自带的记忆只记「对某个群友的印象」（他什么性格、爱玩什么梗、雷点是什么），
//   而且靠模型主动调 memory_append 才记 —— 实测模型几乎不主动调，等于长期空转。
//   缺少的是一层「这个群整体长什么样」的知识：群内黑话、烂梗、常聊话题、群氛围、
//   人物关系、称呼习惯。这层东西才是"越来越像本群真人"的关键，也最能跨人设复用。
//
//   本插件做的事：
//     ① 被动自动学习 —— 机器人每次被触发回复时，把近期群聊批量喂给"记忆整理模型"
//        （可配便宜模型，见设置），提炼/合并进这个群的「群文化」。攒得越久越像本群人。
//     ② 按人设隔离 —— 知识按"人设指纹"分槽存储。换人设 = 指针切到另一份文件，
//        秒切、零重新拉取、零 token 浪费；切回旧人设，那份知识原样还在。
//     ③ 每次回复只注入一小段（约百来字），不重读历史 → 省 token。
//
// ── 为什么是插件，不是技能 ────────────────────────────────────────────────
//   学习触发是"规则能写死"的（数消息、看冷却、到点整理），不经过 LLM 判断。
//   做成技能（等模型主动调）会重蹈 memory_append 的覆辙：忘了调 = 永不学习。
//
// ── 人设指纹与 archive-isolation 逐字一致 ─────────────────────────────────
//   两个插件用同一套 sha1（roleText/customRules/systemPromptOverride/participation），
//   所以本插件的槽位 id 与 archive-isolation 的槽位 id **天然对齐**：换人设那一刻，
//   存档、群友印象记忆、群文化三样东西一起切走、一起切回，不会各切各的。
//
// ── 踩坑备忘（都是这个项目反复验证过的）────────────────────────────────────
//   · 所有运行时数据写 DATA_DIR（plugins/ 之外），否则热重载递归监听会自激。
//   · 不用 fs.cpSync（本机实测会直接把进程杀掉，退出码 127）；这里只读写 JSON 文件，不涉及。
//   · api.log 前缀占掉 format 首位 → 日志必须拼成单个字符串，不能写 log('%s', v)。
//   · 钩子 5s 超时 + 错误隔离 → before-context 里只做便宜的计数/判断，
//     真正吃 token 的整理用 setImmediate 丢后台，绝不阻塞回复。
//   · 整理在后台跑、不 await：失败只记日志，绝不拖垮聊天主流程。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, personaForChat, getConfig } from '../../src/config.js';
import { chatCompletion } from '../../src/llm.js';
import { currentProviders } from '../../src/providers.js';
import { setSkillConfig } from '../../src/skills/config.js';

const PLUGIN_ID = 'group-learner';

/** 运行时数据根目录：DATA_DIR 下，避开 plugins/ 的热重载监听（见文件头）。 */
const ROOT = path.join(DATA_DIR, 'group-learner');

// ── 运行期句柄 ────────────────────────────────────────────────────────────

let cfg = () => ({});
let log = () => {};
let warn = () => {};

/** 内存态：{ [chatKey]: { currentSlot, label, newCount, lastDigestAt } }。落盘在 state.json。 */
let state = { chats: {} };

/** 正在整理的 chatKey（并发防抖）。 */
const digesting = new Set();

/** 上次消费掉的手动操作原文（防止 setSkillConfig 失败时重复执行）。 */
let lastActionRaw = '';

// ── 人设指纹（与 archive-isolation 逐字一致）───────────────────────────────

function personaSlot(persona) {
  const parts = [
    String(persona?.roleText || '').trim(),
    String(persona?.customRules || '').trim(),
    String(persona?.systemPromptOverride || '').trim(),
    String(persona?.participation || '').trim()
  ];
  return `p_${crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 10)}`;
}

function personaLabel(persona) {
  const t = String(persona?.roleText || persona?.customRules || '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 24) : '（默认人设）';
}

// ── 路径与文件读写 ────────────────────────────────────────────────────────

/** chatKey → 目录名，与 store.js / memory.js 规则一致（':' → '_'）。 */
function safeKey(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function safeSlot(slot) {
  return String(slot).replace(/[^a-z0-9_-]/gi, '_');
}

function chatDir(chatKey) {
  return path.join(ROOT, safeKey(chatKey));
}

function stateFile(chatKey) {
  return path.join(chatDir(chatKey), 'state.json');
}

function slotFile(chatKey, slot) {
  return path.join(chatDir(chatKey), `${safeSlot(slot)}.json`);
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

// ── 状态（当前槽位 + 计数）─────────────────────────────────────────────────

function getState(chatKey) {
  let st = state.chats[chatKey];
  if (!st) {
    st = readJson(stateFile(chatKey), null) || {};
    st = {
      currentSlot: String(st.currentSlot || ''),
      label: String(st.label || ''),
      newCount: Number(st.newCount) || 0,
      lastDigestAt: Number(st.lastDigestAt) || 0
    };
    state.chats[chatKey] = st;
  }
  return st;
}

function saveState(chatKey) {
  try {
    const st = state.chats[chatKey];
    if (!st) return;
    writeJson(stateFile(chatKey), st);
  } catch (error) {
    warnLazy(`状态落盘失败（${chatKey}）：${describe(error)}`);
  }
}

// ── 群文化知识读写 ────────────────────────────────────────────────────────

const CULTURE_FIELDS = ['slang', 'topics', 'vibe', 'relations', 'catchphrases'];

function emptyCulture() {
  return { slang: [], topics: [], vibe: '', relations: [], catchphrases: [] };
}

/** 读某个人设槽位的群文化；不存在返回 null。 */
function loadKnowledge(chatKey, slot) {
  const raw = readJson(slotFile(chatKey, slot), null);
  if (!raw || !raw.culture) return null;
  return raw;
}

/** 写某个人设槽位的群文化（带元信息）。 */
function saveKnowledge(chatKey, slot, culture, label, digests) {
  writeJson(slotFile(chatKey, slot), {
    slot,
    label: String(label || ''),
    updatedAt: Date.now(),
    digests: Number(digests) || 0,
    culture
  });
}

/** 清洗模型返回的群文化：只保留白名单字段、掐长度、砍条数。 */
function sanitizeCulture(obj, maxItems) {
  const out = emptyCulture();
  for (const f of ['slang', 'topics', 'relations', 'catchphrases']) {
    const arr = Array.isArray(obj?.[f]) ? obj[f] : [];
    out[f] = arr
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, maxItems)
      .map((s) => s.slice(0, 30));
  }
  out.vibe = String(obj?.vibe ?? '').trim().slice(0, 80);
  return out;
}

function cultureIsEmpty(culture) {
  return !culture
    || (culture.slang.length + culture.topics.length + culture.relations.length + culture.catchphrases.length === 0
        && !String(culture.vibe || '').trim());
}

// ── 设置读取 ──────────────────────────────────────────────────────────────

function readSettings() {
  const c = cfg() || {};
  const num = (v, d, min) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) return d;
    return Math.round(n);
  };
  return {
    enabled: c.enabled !== false,
    onlyGroups: c.onlyGroups !== false,
    chatIds: splitIds(c.chatIds),
    protectKeys: splitIds(c.protectKeys),
    minNewMessages: num(c.minNewMessages, 12, 3),
    digestIntervalMs: num(c.digestIntervalMinutes, 180, 30) * 60 * 1000,
    windowMessages: num(c.windowMessages, 120, 20),
    maxCultureItems: num(c.maxCultureItems, 6, 3),
    injectCulture: c.injectCulture !== false,
    verbose: c.verbose === true
  };
}

function splitIds(raw) {
  const out = new Set();
  for (const piece of String(raw ?? '').split(/[,，、;；|\s]+/)) {
    const t = piece.trim();
    if (t) out.add(t);
  }
  return out;
}

/** 该会话是否参与学习。 */
function inScope(chatKey, kind, s) {
  if (s.onlyGroups && kind !== 'group') return false;
  const [, id] = String(chatKey || '').split(':');
  if (s.protectKeys.size && (s.protectKeys.has(String(id)) || s.protectKeys.has(String(chatKey)))) return false;
  if (s.chatIds.size && !(s.chatIds.has(String(id)) || s.chatIds.has(String(chatKey)))) return false;
  return true;
}

// ── 消息格式化（给整理模型看）──────────────────────────────────────────────

function fmtMsg(m) {
  const text = String(m?.text ?? '').trim();
  if (!text) return null;                    // 纯图片/表情/系统事件跳过
  const who = m.self ? '我' : (String(m.senderName || '').trim() || String(m.senderId || '某人'));
  const d = new Date(Number(m.ts) || 0);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `[${hh}:${mm}] ${who}：${text.slice(0, 120)}`;
}

// ── 整理（LLM）─────────────────────────────────────────────────────────────

/**
 * 记忆整理模型调用，与 orchestrator 的 #memoryChat 逐字同构：
 * useChatModel 跟随聊天模型；否则用设置 → 记忆里的专用（便宜）模型。
 */
async function memoryChat(messages) {
  const cfgNow = getConfig();
  const mem = cfgNow.memory || {};
  if (mem.useChatModel !== false) {
    return chatCompletion({ messages, temperature: 0.2 });
  }
  const providers = currentProviders();
  const p = providers.find((x) => x.id === mem.provider);
  if (!p?.baseURL || !p?.apiKey || !mem.model) {
    throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
  }
  return chatCompletion({
    messages,
    temperature: 0.2,
    overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
  });
}

/** 稳健提取 JSON 对象（模型不一定只吐 JSON）。 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续 */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 继续 */ }
    try {
      const fixed = cand.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"');
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续 */ }
  }
  return null;
}

function buildMergePrompt(existing, lines) {
  const system = [
    '你是 QQ 群机器人的「群文化记忆」整理模块。机器人长期混在这个群里，',
    '你要帮它攒下这个群的「群文化」——黑话、梗、常聊话题、群氛围、人物关系、称呼习惯，',
    '让机器人越来越像这个群土生土长的成员。',
    '',
    '规则：',
    '1. 只依据给定的聊天记录，绝不编造。',
    '2. 新信息和已有群文化合并：保留仍准确的、增补新的、删掉明显过时或矛盾的。',
    '3. 每条尽量短（≤20 字），是"印象"不是"流水账"；一次性事件、临时话题不要记。',
    '4. 输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。',
    '5. 信息不足就少写，宁缺毋滥。'
  ].join('\n');

  const user = [
    '【这个群已有的群文化（可能为空）】',
    JSON.stringify(existing || emptyCulture()),
    '',
    '【机器人近期看到的聊天记录】',
    lines.join('\n') || '（暂时没有抓到聊天记录）',
    '',
    '请更新群文化，按这个结构输出 JSON：',
    '{"slang":["群内黑话/梗"],"topics":["常聊话题"],"vibe":"一句话描述群氛围与说话节奏","relations":["人物关系/称呼习惯"],"catchphrases":["群友常说的口头禅"]}',
    '每个数组最多 6 条、每条 ≤20 字；vibe 一句话。'
  ].join('\n');

  return { system, user };
}

/**
 * 执行一次整理：读近期消息 → 合并进群文化 → 落盘。
 * @returns {Promise<string>} 结果描述
 */
async function runDigest(chatKey, slot, label, store, windowMessages, maxItems) {
  if (digesting.has(chatKey)) return '（该群正在整理中，本次跳过）';
  digesting.add(chatKey);
  try {
    let list = [];
    try { list = store?.recent?.(chatKey, { limit: windowMessages }) || []; } catch { /* 拿不到就空 */ }
    const lines = list.map(fmtMsg).filter(Boolean).slice(-windowMessages);
    if (!lines.length) return '没有抓到可整理的聊天记录（可能还没有文字消息）';

    const existing = loadKnowledge(chatKey, slot);
    const prevDigests = Number(existing?.digests) || 0;
    const { system, user } = buildMergePrompt(existing?.culture || emptyCulture(), lines);

    const res = await memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);

    const parsed = extractJsonObject(res?.message?.content);
    if (!parsed) return '模型返回无法解析为 JSON，本次未更新（原群文化保留）';

    const culture = sanitizeCulture(parsed, maxItems);
    saveKnowledge(chatKey, slot, culture, label, prevDigests + 1);

    const total = culture.slang.length + culture.topics.length + culture.relations.length + culture.catchphrases.length;
    return `已整理 ${lines.length} 条聊天 → 群文化现有 ${total} 条（黑话${culture.slang.length} / 话题${culture.topics.length} / 关系${culture.relations.length} / 口头禅${culture.catchphrases.length}）${culture.vibe ? '，氛围：' + culture.vibe : ''}`;
  } finally {
    digesting.delete(chatKey);
  }
}

/** 后台触发整理（不 await，失败只记日志）。auto=true 时结果只进日志，否则写回 lastResult。 */
function scheduleDigest(chatKey, slot, label, store, s, { auto = true } = {}) {
  setImmediate(() => {
    runDigest(chatKey, slot, label, store, s.windowMessages, s.maxCultureItems)
      .then((note) => {
        logLazy(`${chatKey} 群文化整理：${note}`);
        if (!auto) writeManualResult(note);
      })
      .catch((error) => {
        warnLazy(`${chatKey} 群文化整理失败：${describe(error)}`);
        if (!auto) writeManualResult(`整理失败：${describe(error)}`);
      });
  });
}

// ── 每轮注入的群文化片段 ──────────────────────────────────────────────────

/** 当前会话 + 当前人设的群文化（可能是 null）。 */
function currentCulture(chatKey) {
  const st = getState(chatKey);
  let slot = st.currentSlot;
  if (!slot) {
    // 尚未登记：用当前人设指纹补一个（正常流程里 before-context 会先登记）
    slot = personaSlot(safePersona(chatKey));
    st.currentSlot = slot;
    st.label = personaLabel(safePersona(chatKey));
  }
  return loadKnowledge(chatKey, slot);
}

function formatCultureText(knowledge) {
  const c = knowledge?.culture;
  if (cultureIsEmpty(c)) return '';
  const parts = [];
  if (c.slang.length) parts.push(`- 黑话/梗：${c.slang.join('、')}`);
  if (c.topics.length) parts.push(`- 常聊话题：${c.topics.join('、')}`);
  if (c.vibe) parts.push(`- 群氛围：${c.vibe}`);
  if (c.relations.length) parts.push(`- 人物/称呼：${c.relations.join('、')}`);
  if (c.catchphrases.length) parts.push(`- 群友口头禅：${c.catchphrases.join('、')}`);
  if (!parts.length) return '';
  return parts.join('\n');
}

export function promptSections(context = {}) {
  try {
    if (cfg().enabled === false) return [];
    if (cfg().injectCulture === false) return [];
    const chatKey = context?.chatKey;
    if (!chatKey) return [];
    const knowledge = currentCulture(chatKey);
    const text = formatCultureText(knowledge);
    if (!text) return [];
    return [{
      id: 'group-learner-culture',
      title: '群文化记忆',
      priority: 42,
      content: `【群文化记忆（你在这个群长期攒下的感觉，说话时可自然带上，别当成清单念；这里没有的就别硬扯）】\n${text}`
    }];
  } catch {
    return [];
  }
}

// ── 手动操作（控制台「手动操作」框）────────────────────────────────────────

function parseActions(raw) {
  const out = [];
  for (const piece of String(raw ?? '').split(/[;\n]+/)) {
    const t = piece.trim();
    if (!t) continue;
    const m = /^([^:：]+)(?:[:：](.+))?$/.exec(t);
    if (!m) continue;
    out.push({ target: String(m[1] || '').trim(), act: String(m[2] || 'digest').trim().toLowerCase() });
  }
  return out;
}

function resolveTarget(target) {
  const t = String(target || '').trim();
  if (!t) return '';
  if (t.includes(':')) return t;
  if (/^\d+$/.test(t)) return `group:${t}`;
  return t;
}

function runManualActions(raw, ctx, s) {
  const actions = parseActions(raw);
  if (!actions.length) return '';
  const lines = [];
  for (const a of actions) {
    try {
      if (a.target.toLowerCase() === 'all') {
        lines.push(...runOnAll(a.act, ctx, s));
      } else {
        const chatKey = resolveTarget(a.target);
        if (!chatKey) { lines.push(`认不出目标：${a.target}`); continue; }
        lines.push(runOne(chatKey, a.act, ctx, s));
      }
    } catch (error) {
      lines.push(`${a.target}：执行出错 —— ${describe(error)}`);
    }
  }
  return lines.join('\n');
}

function runOnAll(act, ctx, s) {
  const keys = knownChatKeys(ctx?.store);
  if (!keys.length) return ['没有找到任何会话存档'];
  return keys.map((k) => runOne(k, act, ctx, s));
}

function knownChatKeys(store) {
  const keys = new Set();
  try {
    for (const k of store?.listChats?.() || []) if (k) keys.add(String(k));
  } catch { /* ignore */ }
  try {
    const files = fs.readdirSync(path.join(DATA_DIR, 'messages')).filter((f) => /^(group|private)_\d+\.json$/.test(f));
    for (const f of files) {
      const m = /^(group|private)_(\d+)\.json$/.exec(f);
      if (m) keys.add(`${m[1]}:${m[2]}`);
    }
  } catch { /* 目录不存在 */ }
  return [...keys];
}

function runOne(chatKey, act, ctx, s) {
  if (act === 'view') return viewCulture(chatKey);
  if (act === 'reset') return resetCulture(chatKey);
  if (act === 'digest' || act === 'learn' || act === '整理') {
    const st = getState(chatKey);
    const slot = st.currentSlot || personaSlot(safePersona(chatKey));
    const label = st.label || personaLabel(safePersona(chatKey));
    scheduleDigest(chatKey, slot, label, ctx?.store, s, { auto: false });
    return `${chatKey}：已触发群文化整理，稍后完成（结果会写进「上次操作结果」）`;
  }
  return `${chatKey}：认不出动作「${act}」（可用：digest=立即整理 / view=查看 / reset=清空）`;
}

function viewCulture(chatKey) {
  const knowledge = currentCulture(chatKey);
  if (cultureIsEmpty(knowledge?.culture)) return `${chatKey}：还没有攒下群文化（等它多聊几句、或手动 digest 一次）`;
  const c = knowledge.culture;
  const when = knowledge.updatedAt ? new Date(knowledge.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '';
  return `${chatKey} 的群文化（${knowledge.label || '（无名）'}，已整理 ${knowledge.digests || 0} 次，${when}）：\n`
    + (c.slang.length ? `- 黑话/梗：${c.slang.join('、')}\n` : '')
    + (c.topics.length ? `- 常聊话题：${c.topics.join('、')}\n` : '')
    + (c.vibe ? `- 群氛围：${c.vibe}\n` : '')
    + (c.relations.length ? `- 人物/称呼：${c.relations.join('、')}\n` : '')
    + (c.catchphrases.length ? `- 群友口头禅：${c.catchphrases.join('、')}\n` : '');
}

function resetCulture(chatKey) {
  try {
    fs.rmSync(chatDir(chatKey), { recursive: true, force: true });
    delete state.chats[chatKey];
    return `${chatKey}：已删除全部人设的群文化记忆（当前生效的不变，下次会重新攒）`;
  } catch (error) {
    return `${chatKey}：删除失败 —— ${describe(error)}`;
  }
}

function writeManualResult(text) {
  try {
    setSkillConfig(PLUGIN_ID, { manualAction: '', lastResult: String(text || '') });
  } catch (error) {
    warnLazy(`写回操作结果失败（请手动清空「手动操作」框）：${describe(error)}`);
  }
}

function safePersona(chatKey) {
  try { return personaForChat(chatKey) || {}; } catch { return {}; }
}

// ── 生命周期与扩展点 ──────────────────────────────────────────────────────

export function setup(api) {
  cfg = typeof api.config === 'function' ? api.config : () => ({});
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch { /* 建不了目录也不影响加载 */ }
  log('群内学习已加载：被动攒群文化、按人设隔离（数据目录 ' + ROOT + '）');
}

export function available() {
  return { ok: true };
}

export const hooks = {
  /**
   * 每次运行前：① 消费「手动操作」框；② 登记/切换人设槽位；③ 数消息、到点后台整理。
   * 这里只做便宜的事，吃 token 的整理丢后台，绝不阻塞回复。
   */
  'before-context': async (ctx) => {
    try {
      const chatKey = ctx?.chatKey;
      if (!chatKey || !ctx?.store) return;

      const s = readSettings();

      // 手动操作不看重范围开关：用户明确点了，就该执行
      const raw = String(cfg()?.manualAction ?? '').trim();
      if (raw && raw !== lastActionRaw) {
        lastActionRaw = raw;
        const result = runManualActions(raw, ctx, s);
        try {
          setSkillConfig(PLUGIN_ID, { manualAction: '', lastResult: result || '（没有可执行的操作）' });
        } catch (error) {
          warnLazy(`写回操作结果失败（请手动清空「手动操作」框，避免重复执行）：${describe(error)}`);
        }
        logLazy(`手动操作已执行：\n${result}`);
      }

      if (!s.enabled) return;
      if (!inScope(chatKey, ctx?.kind, s)) return;

      const persona = safePersona(chatKey);
      const slot = personaSlot(persona);
      const label = personaLabel(persona);
      const st = getState(chatKey);

      // 首次见到：登记当前人设，什么也不动
      if (!st.currentSlot) {
        st.currentSlot = slot;
        st.label = label;
        saveState(chatKey);
        return;
      }

      // 人设变了：只切指针（知识各自独立存在文件里，无需复制），并跳过本轮整理
      if (st.currentSlot !== slot) {
        st.currentSlot = slot;
        st.label = label;
        st.newCount = 0;
        st.lastDigestAt = Date.now();
        saveState(chatKey);
        if (s.verbose) logLazy(`${chatKey}：人设已切到 ${slot}（${label}），群文化随之切换`);
        return;
      }

      // 数新消息（triggerEntries 是这轮刚读到的未读消息）
      const n = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries.length : 0;
      st.newCount += n;

      const due = st.newCount >= s.minNewMessages
        && (Date.now() - (st.lastDigestAt || 0)) >= s.digestIntervalMs;
      if (due) {
        st.newCount = 0;
        st.lastDigestAt = Date.now();
        saveState(chatKey);
        scheduleDigest(chatKey, slot, label, ctx.store, s, { auto: true });
      }
    } catch (error) {
      warnLazy(`群内学习检查出错（本次跳过）：${describe(error)}`);
    }
  }
};

/** 对外能力：别的扩展可以问"这个会话当前人设的群文化长什么样"。 */
export const providers = {
  'group.culture.v1': ({ chatKey } = {}) => {
    const knowledge = currentCulture(String(chatKey || ''));
    if (!knowledge) return null;
    return {
      slot: knowledge.slot,
      label: knowledge.label,
      digests: knowledge.digests,
      culture: knowledge.culture
    };
  }
};

/** 排障用：把内部状态暴露出来（仿 archive-isolation 的 internals 约定）。 */
export const internals = {
  personaSlot,
  personaLabel,
  parseActions,
  resolveTarget,
  state: () => state.chats,
  digesting: () => [...digesting]
};

// ── 小工具 ────────────────────────────────────────────────────────────────

function logLazy(text) {
  try { log(String(text)); } catch { /* 日志失败不影响主流程 */ }
}

function warnLazy(text) {
  try { warn(String(text)); } catch { /* ignore */ }
}

function describe(error) {
  if (!error) return '未知错误';
  return String(error?.message || error);
}
