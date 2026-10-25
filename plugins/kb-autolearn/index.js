// 自动学习新词：群里出现不认识的专有名词 → 联网查证 → 提炼结构化条目 → 写进本地知识库 learned/。
//
// 检索与注入交给「本地知识库」（knowledge-base）插件：它递归监听 data/knowledge-base/，
// 文件落盘即重建索引，每轮把目录清单带给模型、命中时带出详情。本插件只负责
// "发现 + 查证 + 提炼 + 整合 + 落盘"，两边只通过文件约定耦合（同一种 md 格式、同一个 learned/ 目录）。
//
// 结构化数据另存一份在 data/kb-autolearn/entries.json（类别 / 别名 / 要点 / 关系 / 来源…），
// md 是给知识库检索用的展示形态，JSON 是给程序用的。
//
// 整合（定时 + 手动）：合并重复条目、归纳专题（生成专题总览页）、给条目之间连关系、
// 深挖内容太少的条目、用更宽松的口径重试查不到的词。
//
// 钩子里只做入队（不联网、不调模型，满足 5 秒钩子上限）；联网和调模型都在后台定时器
// 或工具执行里做。所有模型调用走核心 chatCompletion，自然受 zjsru-no-think 的免费路由保护。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { chatCompletion } from '../../src/llm.js';
import { setSkillConfig } from '../../src/skills/config.js';
import { skillManager } from '../../src/skills/manager.js';
import { webSearch, webFetch, extractPageDigest } from '../../src/web-search.js';

const ID = 'kb-autolearn';
const KB_DIR = path.join(DATA_DIR, 'knowledge-base');
const LEARNED_DIR = path.join(KB_DIR, 'learned');
// 运行时数据放 plugins/ 之外，否则热重载的递归监听会自激
const STATE_DIR = path.join(DATA_DIR, ID);
const ENTRIES_FILE = path.join(STATE_DIR, 'entries.json');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const TOPIC_PREFIX = '专题 - ';
const POLL_MS = 15000;

const DEFAULTS = {
  enabled: true,
  autoScan: true,
  scanIntervalSec: 120,
  minMessages: 8,
  maxTermsPerScan: 2,
  maxTermsPerHour: 6,
  fetchPages: 4,
  maxFacts: 10,
  relearnDays: 30,
  notFoundRetryDays: 7,
  consolidateEnabled: true,
  consolidateIntervalHours: 12,
  enrichPerRun: 5,
  manualAction: '',
  lastResult: '',
  verbose: false
};

// "这是什么"类问题，百科站最靠谱；越靠前越优先打开
const PREFERRED_HOSTS = [
  /(^|\.)moegirl\.org(\.cn)?$/, /(^|\.)baike\.baidu\.com$/, /(^|\.)wikipedia\.org$/,
  /(^|\.)wiki\.biligame\.com$/, /(^|\.)huijiwiki\.com$/, /(^|\.)bilibili\.com$/,
  /(^|\.)zhihu\.com$/, /(^|\.)baike\.sogou\.com$/
];

// 跨热重载共享：定时器、待扫队列、限流账（热重载会 import 出新的模块实例）
const G = globalThis.__kbAutolearn ??= { timer: null, queue: new Map(), busy: false, spent: [], lastScanAt: 0, lastAction: '' };

let cfg = () => ({});
let log = () => {};

function settings() {
  const c = { ...DEFAULTS, ...(cfg() || {}) };
  const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
  return {
    enabled: c.enabled !== false,
    autoScan: c.autoScan !== false,
    scanIntervalSec: num(c.scanIntervalSec, 120, 30, 3600),
    minMessages: num(c.minMessages, 8, 1, 200),
    maxTermsPerScan: num(c.maxTermsPerScan, 2, 1, 5),
    maxTermsPerHour: num(c.maxTermsPerHour, 6, 0, 60),
    fetchPages: num(c.fetchPages, 4, 1, 6),
    maxFacts: num(c.maxFacts, 10, 3, 20),
    relearnDays: num(c.relearnDays, 30, 1, 3650),
    notFoundRetryDays: num(c.notFoundRetryDays, 7, 1, 365),
    consolidateEnabled: c.consolidateEnabled !== false,
    consolidateIntervalHours: num(c.consolidateIntervalHours, 12, 1, 168),
    enrichPerRun: num(c.enrichPerRun, 5, 0, 30),
    manualAction: String(c.manualAction || '').trim(),
    engine: c.engine === 'builtin' ? 'builtin' : 'codex',
    codexModel: String(c.codexModel ?? 'gpt-6-luna').trim(),
    codexEffort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.codexEffort) ? c.codexEffort : 'low',
    verbose: c.verbose === true
  };
}

function vlog(msg) {
  if (settings().verbose) log(msg);
}

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

// ── 存档（结构化数据 + 运行状态） ────────────────────────────────────────

function normKey(term) {
  return String(term ?? '').toLowerCase().replace(/[\s·・._\-—"'“”‘’《》「」【】()（）!！?？]/g, '');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

const loadEntries = () => readJson(ENTRIES_FILE, {});
const saveEntries = (entries) => writeJson(ENTRIES_FILE, entries);
const loadState = () => readJson(STATE_FILE, { lastConsolidatedAt: 0, topics: {} });
const saveState = (state) => writeJson(STATE_FILE, state);

function namesOf(e) {
  return [e.term, ...(e.aliases || [])].map(normKey).filter(Boolean);
}

/** 按词条名或别名找已学会的记录，返回 [key, entry]。 */
function findLearned(entries, ...terms) {
  const wanted = new Set(terms.map(normKey).filter(Boolean));
  for (const [k, e] of Object.entries(entries)) {
    if (e.status !== 'learned') continue;
    if (namesOf(e).some((n) => wanted.has(n))) return [k, e];
  }
  return [null, null];
}

// 文件名规则与 knowledge-base 的 safeFileName 保持一致，同一个词两边落到同一个文件
function safeFileName(title) {
  const s = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (s || '未命名').slice(0, 60);
}

// 只要求知识库插件开着（它负责检索）；不看它的 allowWrite —— 那个开关管的是模型直接 kb_remember，
// 实测模型会把自己编的东西（如虚构的"uzuki shu"）当成知识记进去，所以那条路建议关掉，
// 新知识只走本插件：每条都联网查证、和资料核对过才落盘
function kbWritable() {
  const kb = getConfig().skills?.['knowledge-base'] || {};
  return kb.enabled !== false;
}

function listLearnedTitles() {
  try {
    return fs.readdirSync(LEARNED_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  } catch { return []; }
}

function removeFile(rel) {
  if (!rel) return;
  try { fs.rmSync(path.join(KB_DIR, rel), { force: true }); } catch { /* ignore */ }
}

// ── 限流 ────────────────────────────────────────────────────────────────

function budgetLeft(s) {
  const hourAgo = Date.now() - 3600000;
  G.spent = G.spent.filter((t) => t > hourAgo);
  return s.maxTermsPerHour - G.spent.length;
}

// ── 模型调用 ────────────────────────────────────────────────────────────

async function askJson(system, user, maxTokens) {
  const r = await chatCompletion({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    maxTokens,
    // 提炼类调用不需要思考（zjsru-no-think 看到 thinkingMode:'off' 会把 Qwen 的思考也关掉）
    skillContext: { thinkingMode: 'off', sessionId: '', source: ID }
  });
  const text = String(r?.message?.content ?? '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`模型没有返回 JSON：${text.slice(0, 80)}`);
  return JSON.parse(m[0]);
}

// ── 挑词 ────────────────────────────────────────────────────────────────

export async function pickTerms(batch, s, entries) {
  const known = Object.values(entries)
    .filter((e) => e.status === 'learned')
    .flatMap((e) => [e.term, ...(e.aliases || []).slice(0, 2)])
    .concat(listLearnedTitles())
    .slice(-200);
  const names = [...batch.names].slice(0, 40);
  const botName = String(getConfig().persona?.botName || '');
  const user = [
    `下面是一段 QQ 群聊。挑出最多 ${s.maxTermsPerScan} 个"值得联网查一下是什么"的专有名词：作品、游戏、角色、人物、乐队/组合、梗、黑话、事件、产品、专业术语等。`,
    `不要挑：普通词汇和口语；群友昵称（${names.join('、') || '无'}）；机器人自己（${botName}）；已经学过的词（${[...new Set(known)].join('、') || '无'}）；家喻户晓、不用查的常识。`,
    '宁可少挑：拿不准是不是专有名词的不要挑。没有值得查的就返回空数组。',
    '每个词给 hint（它在这段聊天里大概属于什么领域）和 query（给搜索引擎用的查询词，带上领域词以免同名歧义）。',
    '只输出 JSON：{"terms":[{"term":"","hint":"","query":""}]}',
    '',
    '群聊：',
    ...batch.msgs.slice(-40)
  ].join('\n');
  const j = await askJson('你帮一个 QQ 群聊机器人挑出值得查资料的词，只输出 JSON。', user, 400);
  const terms = Array.isArray(j?.terms) ? j.terms : [];
  return terms
    .map((t) => ({ term: String(t?.term ?? '').trim(), hint: String(t?.hint ?? '').trim(), query: String(t?.query ?? '').trim() }))
    .filter((t) => t.term && t.term.length <= 40 && !names.includes(t.term));
}

// ── 查证 ────────────────────────────────────────────────────────────────

function hostRank(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return 99; }
  const i = PREFERRED_HOSTS.findIndex((re) => re.test(host));
  return i < 0 ? 50 : i;
}

// 萌娘百科词条直开：ACG 词条最准的来源，且免费；词条不存在时站点返回 404
async function moegirlPage(term) {
  const url = `https://zh.moegirl.org.cn/${encodeURIComponent(term.replace(/\s+/g, '_'))}`;
  try {
    const page = await webFetch(url);
    if (page.statusCode !== 200) return null;
    const text = extractPageDigest(page.body, page.url, { maxChars: 3500 }).text;
    return text.length > 200 ? { title: `${term} - 萌娘百科`, url, text } : null;
  } catch {
    return null;
  }
}

async function gatherMaterials(term, hint, query, s) {
  // 词本身 → 萌百站内 → 模型写的查询 → 领域补充。实测 Bing 对"词 + 领域词"容易搜歪，所以领域词放后面
  const queries = [...new Set([term, `${term} site:moegirl.org.cn`, query, hint ? `${term} ${hint} 介绍` : ''].filter(Boolean))];
  const results = [];
  for (const q of queries) {
    try {
      // 搜索走核心「搜索服务」的配置（Bing / DeepSeek Search / 自定义…），和机器人平时的 web_search 同源
      for (const it of (await webSearch(q))?.results || []) {
        if (it?.url && !results.some((x) => x.url === it.url)) results.push(it);
      }
    } catch (e) {
      vlog(`搜索「${q}」失败：${e.message}`);
    }
    if (results.length >= 14) break;
  }
  const materials = [];
  const moe = await moegirlPage(term);
  if (moe) materials.push(moe);
  if (!results.length) return materials;
  // 稳定排序：百科站优先，同档保持搜索引擎原顺序
  const ranked = results
    .filter((r) => !moe || r.url.replace(/^https?:\/\/(m|mzh|zh)\./, '') !== moe.url.replace(/^https?:\/\/zh\./, ''))
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => hostRank(a.url) - hostRank(b.url) || a.i - b.i);
  let opened = moe ? 1 : 0;
  for (const r of ranked.slice(0, 10)) {
    // DeepSeek Search 的 summary 有 600~800 字，够模型提炼；Bing 摘要本来就短
    const m = { title: String(r.title || '').slice(0, 80), url: r.url, text: String(r.snippet || '').replace(/&[a-z#0-9]+;/gi, ' ').slice(0, 800) };
    if (opened < s.fetchPages) {
      try {
        const page = await webFetch(r.url);
        const digest = extractPageDigest(page.body, page.url, { maxChars: 3500 }).text;
        if (digest.length > 200) { m.text = digest; opened += 1; }
      } catch (e) {
        vlog(`打开 ${r.url} 失败：${e.message}`);
      }
    }
    materials.push(m);
  }
  return materials;
}

// ── 提炼 ────────────────────────────────────────────────────────────────

async function extractEntry(term, hint, materials, s) {
  const user = [
    `词条：「${term}」（在群聊里大概指：${hint || '未知'}）`,
    '根据下面的资料写一个尽量详细的词条。先判断资料是不是在讲这个词条：',
    '- 资料讲的是这个词最常见的含义、而群聊语境没有明确指向别的东西，算对得上；',
    '- 只是字面相同、明显是另一个东西，或资料不足以说清它是什么：只输出 {"match":false,"reason":"一句话原因"}',
    '- 对得上：只输出',
    `{"match":true,"term":"规范名称","aliases":["别名/简称/外号/其他语言写法"],"category":"作品|游戏|角色|人物|乐队|组织|梗|事件|产品|术语|其他","summary":"一句话说清它是什么（≤60字）","origin":"出处/来历（≤80字，没有就空）","facts":["要点，每条≤60字，最多${s.maxFacts}条，覆盖身份、特征、经历、作品、评价等不同方面"],"relations":[{"target":"相关的人/作品/组织/词","relation":"和它的关系，如 所属乐队/出自作品/成员/演唱者/前身"}],"timeSensitive":false,"sources":[1]}`,
    '只写资料里明确有的内容，不要补充自己的猜测；日期、数字和资料不一致的不要写。timeSensitive：内容很快会过时（比分、价格、进行中的新闻）填 true。sources 填你实际用到的资料编号。',
    '',
    '资料：',
    ...materials.map((m, i) => `[${i + 1}] ${m.title} | ${m.url}\n${m.text}`)
  ].join('\n');
  return askJson('你是资料整理员，只根据给定资料写词条，只输出 JSON。', user, 1600);
}

// ── 由 Codex 查证（engine = codex）─────────────────────────────────────
// Codex CLI 自带联网搜索（--search），一次就能"搜 + 读 + 提炼"，用 --output-schema 约束成和 extractEntry 同样的结构。
// 走 codex-bridge 插件提供的 codex.run 能力；拿不到或失败时退回内置的"搜索服务 + 模型提炼"。

const CODEX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['match', 'reason', 'term', 'aliases', 'category', 'summary', 'origin', 'facts', 'relations', 'timeSensitive', 'sources'],
  properties: {
    match: { type: 'boolean' },
    reason: { type: 'string' },
    term: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    category: { type: 'string' },
    summary: { type: 'string' },
    origin: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    relations: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['target', 'relation'], properties: { target: { type: 'string' }, relation: { type: 'string' } } }
    },
    timeSensitive: { type: 'boolean' },
    sources: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: { type: 'string' }, url: { type: 'string' } } }
    }
  }
};

async function researchWithCodex(term, hint, s) {
  const run = skillManager.getCapabilityProviders('codex.run', {})[0]?.fn;
  if (!run) return null;
  const prompt = [
    `用联网搜索查证词条「${term}」（它在 QQ 群聊里出现，大概指：${hint || '未知'}）。优先看萌娘百科、百度百科、维基百科、官方网站、B站 wiki。`,
    '先判断能不能确认它是什么：',
    '- 搜到的是这个词最常见的含义、而群聊语境没有明确指向别的东西，算对得上；',
    '- 只是字面相同、明显是另一个东西，或查不到可靠资料：match=false，reason 写一句原因，其余字段给空值。',
    `对得上时：term 写规范名称；aliases 写别名/简称/外号/其他语言写法；category 从 作品/游戏/角色/人物/乐队/组织/梗/事件/产品/术语/其他 里选；summary 一句话（≤60字）；origin 出处/来历（≤80字，没有就空）；`,
    `facts 写要点（每条≤60字，最多 ${s.maxFacts} 条，覆盖身份、特征、经历、作品、评价等不同方面）；relations 写和其他人/作品/组织的关系（如 所属乐队 / 出自作品 / 成员 / 演唱者）；`,
    'timeSensitive：内容很快会过时（比分、价格、进行中的新闻）填 true；sources 写实际用到的网页标题和网址。',
    '只写查证过的内容，日期、数字以官方或百科为准，不确定的不写。全部用中文。'
  ].join('\n');
  const r = await run({ prompt, model: s.codexModel, effort: s.codexEffort, sandbox: 'read-only', search: true, schema: CODEX_SCHEMA, timeoutMinutes: 5 });
  if (!r?.ok || !r.json) {
    log(`Codex 查证「${term}」失败（${r?.error || '没有结果'}），改用内置搜索`);
    return null;
  }
  vlog(`Codex 查证「${term}」用时 ${r.seconds} 秒`);
  // 转成和内置流程一样的形状：materials = 来源列表，sources = 编号
  const materials = (r.json.sources || []).filter((x) => /^https?:\/\//.test(String(x?.url || ''))).map((x) => ({ title: String(x.title || x.url), url: x.url, text: '' }));
  return { j: { ...r.json, sources: materials.map((_, i) => i + 1) }, materials };
}

function normalizeExtracted(j, name, materials, s, meta) {
  const used = (Array.isArray(j.sources) ? j.sources : []).map((n) => materials[Number(n) - 1]).filter(Boolean);
  const term = clip(j.term || name, 40);
  return {
    term,
    status: 'learned',
    category: clip(j.category, 10) || '其他',
    aliases: uniq([name, ...(Array.isArray(j.aliases) ? j.aliases : [])].map((a) => clip(a, 30))).filter((a) => normKey(a) !== normKey(term)),
    summary: clip(j.summary, 120),
    origin: clip(j.origin, 160),
    facts: uniqText((Array.isArray(j.facts) ? j.facts : []).map((f) => clip(f, 120))).slice(0, s.maxFacts),
    relations: uniqRelations((Array.isArray(j.relations) ? j.relations : [])
      .map((r) => ({ target: clip(r?.target, 40), relation: clip(r?.relation, 20) }))
      .filter((r) => r.target && normKey(r.target) !== normKey(term))).slice(0, 12),
    timeSensitive: j.timeSensitive === true,
    sources: (used.length ? used : materials.slice(0, 2)).slice(0, 6).map((m) => ({ title: m.title.slice(0, 40), url: m.url })),
    topics: [],
    ...meta,
    learnedAt: Date.now(),
    updatedAt: Date.now()
  };
}

function uniq(arr) {
  const seen = new Set();
  return arr.filter((x) => { const k = normKey(x); if (!x || seen.has(k)) return false; seen.add(k); return true; });
}

/** 要点去重：完全相同、或一条包含另一条的只留较长的那条。 */
function uniqText(arr) {
  const out = [];
  for (const t of arr.filter(Boolean)) {
    const k = normKey(t);
    const i = out.findIndex((o) => { const ok = normKey(o); return ok.includes(k) || k.includes(ok); });
    if (i < 0) out.push(t);
    else if (t.length > out[i].length) out[i] = t;
  }
  return out;
}

function uniqRelations(arr) {
  const seen = new Set();
  return arr.filter((r) => { const k = `${normKey(r.target)}|${r.relation}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 两条描述同一个东西的记录合并成一条（a 为保留方）。 */
function mergeEntry(a, b, s) {
  const term = a.term || b.term;
  return {
    ...a,
    term,
    category: a.category && a.category !== '其他' ? a.category : (b.category || a.category),
    aliases: uniq([...(a.aliases || []), ...(b.aliases || []), b.term]).filter((x) => normKey(x) !== normKey(term)),
    summary: a.summary || b.summary,
    origin: a.origin || b.origin || '',
    facts: uniqText([...(a.facts || []), ...(b.facts || [])]).slice(0, s.maxFacts + 4),
    relations: uniqRelations([...(a.relations || []), ...(b.relations || [])]).slice(0, 16),
    related: uniq([...(a.related || []), ...(b.related || [])]).slice(0, 10),
    timeSensitive: Boolean(a.timeSensitive || b.timeSensitive),
    sources: [...(a.sources || []), ...(b.sources || [])].filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i).slice(0, 8),
    topics: uniq([...(a.topics || []), ...(b.topics || [])]),
    updatedAt: Date.now()
  };
}

// ── 落盘 ────────────────────────────────────────────────────────────────

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderMarkdown(e, entries) {
  const inKb = (t) => (findLearned(entries, t)[1] ? '（知识库有）' : '');
  const lines = [
    `# ${e.term}`,
    '',
    '<!-- 由「自动学习新词」（kb-autolearn）联网查证后生成；可以直接编辑或删除 -->',
    `**类别**：${e.category || '其他'}`
  ];
  if (e.aliases?.length) lines.push(`**别名**：${e.aliases.join('、')}`);
  lines.push(`**一句话**：${e.summary}`);
  if (e.origin) lines.push(`**来历**：${e.origin}`);
  if (e.topics?.length) lines.push(`**所属专题**：${e.topics.join('、')}`);
  lines.push('');
  if (e.facts?.length) lines.push('## 要点', ...e.facts.map((f) => `- ${f}`), '');
  const rels = e.relations || [];
  const related = (e.related || []).filter((r) => !rels.some((x) => normKey(x.target) === normKey(r)));
  if (rels.length || related.length) {
    lines.push('## 关联');
    for (const r of rels) lines.push(`- ${r.relation || '相关'}：${r.target}${inKb(r.target)}`);
    if (related.length) lines.push(`- 相关：${related.map((t) => `${t}${inKb(t)}`).join('、')}`);
    lines.push('');
  }
  lines.push(`> 来源：${(e.sources || []).map((x) => `${x.title} ${x.url}`).join('；') || '（无）'}`);
  if (e.timeSensitive) lines.push('> 时效：内容可能很快过时，引用前注意核实');
  lines.push(`> 记于 ${stamp(new Date(e.learnedAt || Date.now()))}，最近整理 ${stamp(new Date(e.updatedAt || Date.now()))}（机器人自动记录，可直接编辑或删除）`);
  return `${lines.join('\n')}\n`;
}

function writeMd(relName, content) {
  fs.mkdirSync(LEARNED_DIR, { recursive: true });
  const file = path.join(LEARNED_DIR, `${safeFileName(relName)}.md`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return path.relative(KB_DIR, file).replace(/\\/g, '/');
}

function writeEntryFile(entry, entries) {
  const rel = writeMd(entry.term, renderMarkdown(entry, entries));
  if (entry.file && entry.file !== rel) removeFile(entry.file);
  entry.file = rel;
  return rel;
}

// ── 学习一个词 ──────────────────────────────────────────────────────────

/**
 * 学一个词。返回 { status, entry?, reason? }：
 *   learned   新学到（或合并进已有条目）并写进知识库
 *   known     之前学过（或知识库里本来就有同名文件），没有重复去查
 *   notfound  资料对不上 / 查不到（进入冷却）
 *   skipped   限流 / 冷却 / 开关关闭 / 临时故障
 */
export async function learnTerm(term, { hint = '', query = '', origin = 'auto', chatKey = '', force = false, ignoreBudget = false } = {}) {
  const s = settings();
  const name = clip(term, 40);
  if (!s.enabled) return { status: 'skipped', reason: '「自动学习新词」已关闭' };
  if (!kbWritable()) return { status: 'skipped', reason: '本地知识库关闭或不允许写入' };
  if (!name) return { status: 'skipped', reason: '词条为空' };

  let entries = loadEntries();
  const [, known] = findLearned(entries, name);
  const failed = entries[normKey(name)]?.status === 'notfound' ? entries[normKey(name)] : null;
  const ageDays = (e) => (Date.now() - Number(e.updatedAt || e.learnedAt || e.checkedAt || 0)) / 86400000;
  if (!force && known && ageDays(known) < s.relearnDays) return { status: 'known', entry: known };
  if (!force && failed && ageDays(failed) < s.notFoundRetryDays) {
    return { status: 'skipped', reason: `「${name}」${Math.ceil(ageDays(failed))} 天前查过但没找到可靠资料：${failed.reason || ''}` };
  }
  if (!force && !known && listLearnedTitles().includes(safeFileName(name))) {
    return { status: 'known', reason: '知识库里已经有同名条目，直接用 kb_search 查' };
  }
  if (!ignoreBudget) {
    if (budgetLeft(s) <= 0) return { status: 'skipped', reason: `本小时学习次数已用完（上限 ${s.maxTermsPerHour}）` };
    G.spent.push(Date.now());
  }

  vlog(`开始学习「${name}」（${origin}，提示：${hint || '无'}，${s.engine === 'codex' ? 'Codex 查证' : '内置搜索'}）`);
  const miss = (reason) => {
    entries = loadEntries();
    if (!findLearned(entries, name)[1]) {
      entries[normKey(name)] = { term: name, status: 'notfound', reason, hint, checkedAt: Date.now(), learnedVia: origin, chatKey };
      saveEntries(entries);
    }
    log(`「${name}」${reason}，${s.notFoundRetryDays} 天后再试`);
    return { status: 'notfound', reason };
  };
  let j;
  let materials = [];
  const viaCodex = s.engine === 'codex' ? await researchWithCodex(name, hint, s).catch(() => null) : null;
  if (viaCodex) {
    ({ j, materials } = viaCodex);
  } else {
    materials = await gatherMaterials(name, hint, query, s);
    if (!materials.length) return miss('搜索没有结果');
    try {
      j = await extractEntry(name, hint, materials, s);
    } catch (e) {
      // 模型超时 / 返回空：属于临时故障，不记成"查不到"，下次还能再试
      log(`「${name}」提炼失败（${e.message}），这次先跳过`);
      return { status: 'skipped', reason: `提炼失败：${e.message}` };
    }
  }
  if (!j?.match) return miss(`资料对不上，不存（${clip(j?.reason || '资料对不上这个词', 120)}）`);

  // 注意：learnedVia 是"怎么学来的"（auto/tool/enrich…），origin 是条目内容里的"来历"，两者不能同名
  let entry = normalizeExtracted(j, name, materials, s, { hint, learnedVia: origin, chatKey });
  if (!entry.summary) return { status: 'skipped', reason: '提炼结果缺少一句话解释' };

  // 同一个东西换了个叫法又学了一次（如"马西洛"→仓田真白）：合并进已有条目，而不是覆盖
  entries = loadEntries();
  const [oldKey, old] = findLearned(entries, entry.term, ...entry.aliases);
  if (old) {
    entry = mergeEntry(old, entry, s);
    delete entries[oldKey];
  }
  delete entries[normKey(name)];   // 清掉同名的"查不到"记录
  entries[normKey(entry.term)] = entry;
  writeEntryFile(entry, entries);
  saveEntries(entries);
  log(`${old ? '补充了' : '学会了'}「${entry.term}」（${entry.category}，${entry.facts.length} 条要点，${entry.relations.length} 条关系）：${entry.summary}`);
  return { status: 'learned', entry };
}

// ── 整合 ────────────────────────────────────────────────────────────────

/** 别名有交集的条目合并成一条，返回合并次数。 */
function mergeDuplicates(entries, s) {
  let merged = 0;
  // 每合并一组就从头再扫：合并后的条目别名变多，可能又和别的条目撞上（条目数很小，不在乎复杂度）
  for (let found = true; found;) {
    found = false;
    const list = Object.entries(entries).filter(([, e]) => e.status === 'learned');
    for (let i = 0; i < list.length && !found; i += 1) {
      for (let j = i + 1; j < list.length && !found; j += 1) {
        const [ka, a] = list[i];
        const [kb, b] = list[j];
        const an = new Set(namesOf(a));
        if (!namesOf(b).some((n) => an.has(n))) continue;
        // 要点多的一方当保留方
        const [keep, drop] = (a.facts?.length || 0) >= (b.facts?.length || 0) ? [a, b] : [b, a];
        const next = mergeEntry(keep, drop, s);
        if (drop.file && drop.file !== keep.file) removeFile(drop.file);
        delete entries[ka];
        delete entries[kb];
        entries[normKey(next.term)] = next;
        merged += 1;
        found = true;
      }
    }
  }
  return merged;
}

/** 让模型把条目归成专题、并在条目之间连关系。 */
async function linkAndCluster(entries) {
  const list = Object.values(entries).filter((e) => e.status === 'learned');
  const topics = new Map();
  let links = 0;
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    const user = [
      '下面是知识库里的词条（名称｜类别｜一句话）。请做两件事：',
      '1. 把它们归成若干专题（同一作品/企划/游戏/圈子的放一起），每个专题给一句话概述；只有一个成员的不用成专题。',
      '2. 找出词条之间明确的关系（只在下面列出的词条之间连），例如 成员/所属乐队/出自作品/演唱/前身/同一作品角色。',
      '只根据词条内容判断，不确定的不要连。只输出 JSON：',
      '{"topics":[{"name":"专题名","summary":"一句话概述","members":["词条名"]}],"links":[{"from":"词条名","to":"词条名","relation":"from 对 to 的关系"}]}',
      '',
      ...chunk.map((e) => `${e.term}｜${e.category}｜${e.summary}`)
    ].join('\n');
    let j;
    try {
      j = await askJson('你在整理一个知识库的条目关系，只输出 JSON。', user, 2000);
    } catch (e) {
      log(`归纳专题失败：${e.message}`);
      continue;
    }
    for (const t of Array.isArray(j?.topics) ? j.topics : []) {
      const name = clip(t?.name, 30);
      const members = (Array.isArray(t?.members) ? t.members : []).map((m) => findLearned(entries, m)[1]).filter(Boolean);
      if (!name || members.length < 2) continue;
      const cur = topics.get(name) ?? { name, summary: clip(t.summary, 120), members: new Set() };
      for (const m of members) cur.members.add(m.term);
      topics.set(name, cur);
    }
    for (const l of Array.isArray(j?.links) ? j.links : []) {
      const [, from] = findLearned(entries, l?.from);
      const [, to] = findLearned(entries, l?.to);
      if (!from || !to || from === to) continue;
      const before = (from.relations || []).length;
      from.relations = uniqRelations([...(from.relations || []), { target: to.term, relation: clip(l.relation, 20) || '相关' }]);
      to.related = uniq([...(to.related || []), from.term]).slice(0, 10);
      if (from.relations.length > before) links += 1;
    }
  }
  return { topics, links };
}

function writeTopicFiles(topics, entries, state) {
  for (const e of Object.values(entries)) if (e.status === 'learned') e.topics = [];
  const next = {};
  for (const t of topics.values()) {
    const members = [...t.members].map((m) => findLearned(entries, m)[1]).filter(Boolean);
    for (const m of members) m.topics = uniq([...(m.topics || []), t.name]);
    const lines = [
      `# ${TOPIC_PREFIX}${t.name}`,
      '',
      '<!-- 由「自动学习新词」整合时生成的专题总览；会在下次整合时重写 -->',
      `**概述**：${t.summary || '（无）'}`,
      `**收录**：${members.length} 个词条`,
      '',
      '## 词条',
      ...members.map((m) => `- **${m.term}**（${m.category}）：${m.summary}`),
      ''
    ];
    const rels = members.flatMap((m) => (m.relations || [])
      .filter((r) => members.some((x) => namesOf(x).includes(normKey(r.target))))
      .map((r) => `- ${m.term} —${r.relation}→ ${r.target}`));
    if (rels.length) lines.push('## 关系', ...uniq(rels), '');
    lines.push(`> 整理于 ${stamp()}（机器人自动整理）`);
    next[t.name] = { file: writeMd(`${TOPIC_PREFIX}${t.name}`, `${lines.join('\n')}\n`), members: members.map((m) => m.term), summary: t.summary };
  }
  // 这次没再归出来的旧专题页删掉
  for (const [name, old] of Object.entries(state.topics || {})) {
    if (!next[name] && old.file && old.file !== next[name]?.file) removeFile(old.file);
  }
  state.topics = next;
}

/** 整合一次。返回给人看的结果摘要。 */
export async function consolidate({ reason = 'auto' } = {}) {
  const s = settings();
  const started = Date.now();
  let entries = loadEntries();
  const state = loadState();
  const report = [];

  const merged = mergeDuplicates(entries, s);
  saveEntries(entries);
  report.push(`合并重复 ${merged} 组`);

  // 深挖：要点太少的条目重新查一遍（合并进原条目）；再用宽松口径重试冷却期已过的"查不到"
  const thin = Object.values(entries)
    .filter((e) => e.status === 'learned' && ((e.facts || []).length < 5 || (e.sources || []).length < 2 || !e.relations?.length))
    .sort((a, b) => (a.facts?.length || 0) - (b.facts?.length || 0))
    .slice(0, s.enrichPerRun);
  let enriched = 0;
  for (const e of thin) {
    try {
      const r = await learnTerm(e.term, { hint: e.hint || e.category, force: true, origin: 'enrich', ignoreBudget: true });
      if (r.status === 'learned') enriched += 1;
    } catch (err) {
      log(`深挖「${e.term}」出错：${err.message}`);
    }
  }
  report.push(`深挖 ${enriched}/${thin.length} 个内容少的条目`);

  entries = loadEntries();
  // 定时整合只重试查过至少一天的；手动整合是用户明确要求，立刻重试
  const minAgeDays = reason === '手动' ? 0 : Math.min(1, s.notFoundRetryDays);
  const retry = Object.values(entries)
    .filter((e) => e.status === 'notfound' && (Date.now() - Number(e.checkedAt || 0)) / 86400000 >= minAgeDays)
    .slice(0, Math.max(0, s.enrichPerRun - thin.length));
  let rescued = 0;
  for (const e of retry) {
    try {
      // 不带领域提示：之前很多"对不上"是挑词时给的提示把它带偏了（如安慕希其实就是那个酸奶）
      const r = await learnTerm(e.term, { hint: '', force: true, origin: 'retry', ignoreBudget: true });
      if (r.status === 'learned') rescued += 1;
    } catch (err) {
      log(`重试「${e.term}」出错：${err.message}`);
    }
  }
  if (retry.length) report.push(`重试查不到的词 ${rescued}/${retry.length} 个成功`);

  entries = loadEntries();
  const { topics, links } = await linkAndCluster(entries);
  writeTopicFiles(topics, entries, state);
  for (const e of Object.values(entries)) if (e.status === 'learned') writeEntryFile(e, entries);
  saveEntries(entries);
  state.lastConsolidatedAt = Date.now();
  saveState(state);

  const learnedCount = Object.values(entries).filter((e) => e.status === 'learned').length;
  report.push(`新连关系 ${links} 条`, `专题 ${topics.size} 个（${[...topics.keys()].join('、') || '无'}）`, `现有词条 ${learnedCount} 个`);
  const text = `${stamp()} 整合完成（${reason}，用时 ${Math.round((Date.now() - started) / 1000)} 秒）：${report.join('；')}`;
  log(text);
  return text;
}

// ── 手动操作 ────────────────────────────────────────────────────────────

/**
 * 设置页「手动操作」框：填了保存即执行一次，执行完清空并把结果写进「上次操作结果」。
 * 支持（多条用分号或换行隔开）：整合 ｜ 学:词 ｜ 重学:词 ｜ 删:词
 */
async function runManualActions(raw) {
  const out = [];
  for (const part of raw.split(/[;；\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(整合|学|重学|删)\s*[:：]?\s*(.*)$/);
    if (!m) { out.push(`看不懂「${part}」：支持 整合 / 学:词 / 重学:词 / 删:词`); continue; }
    const [, op, arg] = m;
    if (op === '整合') { out.push(await consolidate({ reason: '手动' })); continue; }
    if (!arg) { out.push(`「${op}」后面要写词条名`); continue; }
    if (op === '删') {
      const entries = loadEntries();
      const [k, e] = findLearned(entries, arg);
      if (!e) { out.push(`没有「${arg}」这个词条`); continue; }
      removeFile(e.file);
      delete entries[k];
      saveEntries(entries);
      out.push(`已删除「${e.term}」`);
      continue;
    }
    const r = await learnTerm(arg, { force: op === '重学', origin: 'manual', ignoreBudget: true });
    out.push(r.entry ? `「${arg}」→ ${r.entry.term}：${r.entry.summary}` : `「${arg}」${r.status}：${r.reason || ''}`);
  }
  return out.join('\n');
}

// ── 后台调度 ────────────────────────────────────────────────────────────

async function scanQueue(s) {
  for (const [chatKey, batch] of [...G.queue.entries()]) {
    if (batch.msgs.length < s.minMessages) continue;
    if (budgetLeft(s) <= 0) break;
    G.queue.delete(chatKey);
    let terms = [];
    try {
      terms = await pickTerms(batch, s, loadEntries());
    } catch (e) {
      log(`挑词失败（${chatKey}）：${e.message}`);
      continue;
    }
    vlog(`${chatKey} 挑出：${terms.map((t) => t.term).join('、') || '（无）'}`);
    for (const t of terms.slice(0, s.maxTermsPerScan)) {
      if (budgetLeft(s) <= 0) break;
      try {
        await learnTerm(t.term, { hint: t.hint, query: t.query, origin: 'auto', chatKey });
      } catch (e) {
        log(`学习「${t.term}」出错：${e.message}`);
      }
    }
  }
}

async function tick() {
  const s = settings();
  if (G.busy || !s.enabled) return;
  G.busy = true;
  try {
    if (s.manualAction && s.manualAction !== G.lastAction) {
      G.lastAction = s.manualAction;
      let result;
      try {
        result = await runManualActions(s.manualAction);
      } catch (e) {
        result = `执行失败：${e.message}`;
      }
      try {
        setSkillConfig(ID, { manualAction: '', lastResult: clip(result, 2000) });
      } catch (e) {
        log(`写回操作结果失败（请手动清空「手动操作」框）：${e.message}`);
      }
      G.lastAction = '';
      return;
    }
    if (s.consolidateEnabled && Date.now() - Number(loadState().lastConsolidatedAt || 0) >= s.consolidateIntervalHours * 3600000) {
      const result = await consolidate({ reason: '定时' });
      try { setSkillConfig(ID, { lastResult: clip(result, 2000) }); } catch { /* ignore */ }
      return;
    }
    if (s.autoScan && Date.now() - G.lastScanAt >= s.scanIntervalSec * 1000) {
      G.lastScanAt = Date.now();
      await scanQueue(s);
    }
  } finally {
    G.busy = false;
  }
}

function startTimer() {
  if (G.timer) clearInterval(G.timer);
  G.timer = setInterval(() => { tick().catch((e) => log(`后台任务出错：${e.message}`)); }, POLL_MS);
  G.timer.unref?.();
}

function stopTimer() {
  if (G.timer) { clearInterval(G.timer); G.timer = null; }
}

function cleanText(text) {
  return String(text ?? '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/\[(图片|表情|语音|视频|文件|卡片消息|拍一拍)[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ── 生命周期 / 钩子 / 工具 ──────────────────────────────────────────────

/**
 * 一次性修复：1.2.0 之前"怎么学来的"和"来历"共用 origin 字段，来历被 auto/bulk 之类覆盖。
 * 把这类值挪到 learnedVia、清空来历，并重写受影响条目的 md。可重复执行（没有要修的就什么都不做）。
 */
function migrateOriginField() {
  const VIA = new Set(['auto', 'bulk', 'enrich', 'retry', 'manual', 'tool', 'test']);
  const entries = loadEntries();
  const fixed = [];
  for (const e of Object.values(entries)) {
    if (!VIA.has(e.origin)) continue;
    e.learnedVia = e.origin;
    e.origin = '';
    fixed.push(e);
  }
  if (!fixed.length) return;
  for (const e of fixed) if (e.status === 'learned') writeEntryFile(e, entries);
  saveEntries(entries);
  log(`修复了 ${fixed.length} 个条目的「来历」字段`);
}

export function setup(api) {
  cfg = api.config;
  log = (msg) => api.log?.(msg);
  try { migrateOriginField(); } catch (e) { log(`修复来历字段失败：${e.message}`); }

  api.registerTool({
    id: 'learn',
    name: '学习新词',
    description: '群友提到你不认识或拿不准的名词、梗、作品、角色、人物、事件时用：先用 knowledge-base__kb_search 查本地知识库，'
      + '查不到再调用本工具 —— 它会联网查证、提炼成结构化条目存进知识库，并把条目返回给你，以后再遇到就能直接查到。'
      + '资料对不上会如实返回"没找到"，这时不要编。不要用来查天气、比分、股价这类实时信息（那些用 web_search）。'
      + '耗时约 10~40 秒。',
    category: 'knowledge',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: '要学的词（原样照抄群友说的写法）' },
        hint: { type: 'string', description: '它在聊天里大概属于什么领域，例如「BanG Dream 乐队」「明日方舟角色」「B站梗」，用来避免同名歧义' }
      },
      required: ['term']
    },
    async execute(ctx, args) {
      const a = typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : (args || {});
      try {
        const r = await learnTerm(a.term, { hint: clip(a.hint, 60), origin: 'tool', chatKey: ctx?.chatKey || '' });
        if (r.entry) {
          const e = r.entry;
          return {
            content: JSON.stringify({
              status: r.status === 'learned' ? '刚学会，已存进知识库' : '之前学过',
              term: e.term, category: e.category, aliases: e.aliases, summary: e.summary, origin: e.origin,
              facts: e.facts, relations: e.relations, topics: e.topics, timeSensitive: e.timeSensitive,
              sources: (e.sources || []).map((x) => x.url),
              note: '自然地用这些信息回话，不要跟群友汇报你去学习/记录了。'
            })
          };
        }
        return { content: `没有学到：${r.reason || r.status}。不要编造，可以老实说不太清楚。`, isError: r.status !== 'known' };
      } catch (error) {
        return { content: `学习失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  startTimer();
  const s = settings();
  log(`自动学习新词已启用：${s.autoScan ? `每 ${s.scanIntervalSec} 秒扫一次，攒够 ${s.minMessages} 条消息才挑词` : '后台扫描已关，只在模型调用工具时学'}；`
    + `每小时最多 ${s.maxTermsPerHour} 个词；${s.consolidateEnabled ? `每 ${s.consolidateIntervalHours} 小时整合一次` : '定时整合已关'}`);
}

export function activate() { startTimer(); }

export function deactivate() { stopTimer(); }

export function dispose() { stopTimer(); }

export const hooks = {
  'before-context'(ctx) {
    const s = settings();
    if (!s.enabled || !s.autoScan || ctx.proactive) return;
    if (!['group', 'private'].includes(ctx.kind) || !ctx.chatKey) return;
    const batch = G.queue.get(ctx.chatKey) ?? { msgs: [], names: new Set() };
    for (const e of ctx.triggerEntries || []) {
      if (e?.self) continue;
      const text = cleanText(e.text);
      if (text.length < 2) continue;
      batch.msgs.push(`${e.senderName || e.senderId}：${text}`);
      if (e.senderName) batch.names.add(String(e.senderName));
    }
    if (batch.msgs.length > 60) batch.msgs.splice(0, batch.msgs.length - 60);
    G.queue.set(ctx.chatKey, batch);
  }
};

export function promptSections() {
  if (!settings().enabled) return [];
  return [{
    id: 'kb-autolearn',
    title: '遇到不认识的词',
    priority: 40,
    content: '群友提到你不认识或拿不准的名词、梗、作品、人物时，别瞎猜也别直接说不知道：先 knowledge-base__kb_search 查本地知识库，'
      + '查不到再调用 kb-autolearn__learn 学一下再回。学到的东西自然地用，不要跟群友说"我去查了/我记住了"。'
  }];
}

export const providers = {
  'status.kb-autolearn': () => {
    const s = settings();
    if (!s.enabled) return null;
    const entries = Object.values(loadEntries());
    const state = loadState();
    return {
      icon: '🔎',
      title: '自动学习新词',
      priority: 50,
      lines: [
        ['已学会', `${entries.filter((e) => e.status === 'learned').length} 个词，${Object.keys(state.topics || {}).length} 个专题`],
        ['没查到', `${entries.filter((e) => e.status === 'notfound').length} 个词`],
        ['上次整合', state.lastConsolidatedAt ? stamp(new Date(state.lastConsolidatedAt)) : '还没整合过'],
        ['本小时剩余', `${Math.max(0, budgetLeft(s))} / ${s.maxTermsPerHour}`]
      ]
    };
  }
};
