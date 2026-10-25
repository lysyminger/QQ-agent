/**
 * knowledge-base —— 本地知识库（确定性型插件 / API v1）
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 用户把一个 txt 丢进 data/knowledge-base/，机器人就该学会它；回答问题时
 * **先翻本地、翻不到再上网**；网上搜到的有价值内容**存回本地**，下次直接命中。
 *
 * ── 为什么是插件，不是技能 ────────────────────────────────────────────────
 * 判据（src/skills/manifest.js 的 DIR_KIND）：
 *   plugins/ 确定性型 —— 条件满足**必然执行**，不经过 LLM
 *   skills/  LLM 型   —— 注册工具，用不用由模型判断
 *
 * "把目录里的文件变成可检索的索引"是纯机械动作：读文件、切段、建索引、监听变化。
 * 这件事**必须无条件发生**，不能等模型想起来。实测过的教训：光靠"模型自己每轮
 * 记得去读知识库"是不可靠的，它经常忘 —— 目录里有资料但它整轮都不查。
 * 所以索引与注入在这里（钩子必然执行）；"查到之后怎么用"则是本条目额外注册的
 * 四个工具（kb_search / kb_read / kb_remember / kb_status）。
 *
 * 命名不是随手起的：src/config.js 的 LEGACY_SKILL_MIGRATIONS 里有一条
 *   { from: ['tools','knowledgeEnabled'], skill: 'knowledge-base' }
 * 注释写着"知识库技能尚未移植，先留位" —— 本插件就是来补这个坑位的，
 * 老用户配置里的知识库开关能直接对上。
 *
 * ── 检索怎么做的（为什么不用"整库塞进提示词"）────────────────────────────
 * 整库塞进上下文有两头不讨好：库小了没用，库大了每轮都烧 token 且淹没聊天本身。
 * 这里的做法是「目录常驻 + 命中给详情」（与 plugins/meme-tracker 的 index 模式
 * 同构，是这套系统里已经被验证过的形态）：
 *   · 每轮只带一份极短的目录（有哪些资料，每条一行）
 *   · 本轮话题真的命中某条时，才把那条的正文给它
 *   · 需要更多细节，模型自己调 kb_search / kb_read
 *
 * ── 踩坑备忘（都是实际会咬人的）──────────────────────────────────────────
 *   · **编码**：Windows 上的中文 txt 大量是 GBK。按 UTF-8 硬读不报错，只是整篇
 *     变乱码 —— 然后所有检索都失效，且看不出为什么。所以先试 UTF-8（严格模式，
 *     非法字节会抛错），失败再退 GB18030（GBK 的超集）。
 *   · **BOM**：记事本存 UTF-8 会带 BOM，留在段落开头会污染第一个检索词。
 *   · **fs.watch 的重复事件**：往目录里复制一个文件会触发好几次事件，不防抖就会
 *     反复重建整库索引。
 *   · **中文分词**：中文没有空格，整句当词永远匹配不上。用**字符二元组**
 *     （「人工智」→ 人工/工智）—— 这是中文检索的常规做法，不需要词典。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { setSkillConfig } from '../../src/skills/config.js';
import { skillManager } from '../../src/skills/manager.js';

const BUILD_TAG = 'v1.0.0';
const ENTRY_ID = 'knowledge-base';

const KB_DIR = path.join(DATA_DIR, 'knowledge-base');
const LEARNED_DIR = path.join(KB_DIR, 'learned');
const INDEX_FILE = path.join(KB_DIR, '.index.json');
const README_FILE = path.join(KB_DIR, 'README.md');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown']);
const INDEX_VERSION = 1;
const MIN_SECTION_CHARS = 8;

const DEFAULTS = {
  enabled: true,
  maxFileKB: 1024,
  watchDebounceMs: 800,
  injectMode: 'index',
  indexMaxChars: 600,
  hitLimit: 3,
  hitMaxChars: 1200,
  snippetChars: 400,
  minScore: 0.12,
  stopWords: '',
  allowWrite: true,
  requireSource: true,
  defaultLimit: 5,
  maxLimit: 15,
  learnedMaxChars: 4000,
  learnedMaxFiles: 500
};

// ───────────────────────────── 运行态 ─────────────────────────────

const state = {
  docs: [],            // 索引后的文档（含分段与词频）
  sections: [],        // 扁平化后的分段列表（检索用）
  df: new Map(),       // token -> 出现在多少个分段里（算 IDF 用）
  avgLen: 1,
  builtAt: 0,
  building: false,
  skipped: [],         // [{ rel, reason }] 被跳过的文件（要让人看得见，不能静默）
  errors: [],
  watcher: null,
  watchTimer: null,
  dirty: false
};

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let pendingReads = [];   // 本次会话读过的（供 kb_status 显示"最近查过什么"）

// ───────────────────────────── 小工具 ─────────────────────────────

/** 工具入参容错：有些端点会把参数裹成 JSON 字符串传进来。 */
function parseArgs(args) {
  if (typeof args === 'string') {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return args || {};
}

function fail(message) {
  return { content: `错误：${message}`, isError: true };
}


function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return v !== false;
}

function str(v, dflt = '') {
  const s = String(v ?? '').trim();
  return s || dflt;
}

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const pick = (k) => (s[k] === undefined || s[k] === null || s[k] === '' ? DEFAULTS[k] : s[k]);
  const mode = String(pick('injectMode') || 'index').toLowerCase();
  return {
    enabled: bool(s.enabled, DEFAULTS.enabled),
    maxFileKB: Math.max(64, Math.min(16384, Math.round(num(pick('maxFileKB'), DEFAULTS.maxFileKB)))),
    watchDebounceMs: Math.max(200, Math.min(10000, Math.round(num(pick('watchDebounceMs'), DEFAULTS.watchDebounceMs)))),
    injectMode: ['index', 'hit', 'off'].includes(mode) ? mode : 'index',
    indexMaxChars: Math.max(100, Math.min(3000, Math.round(num(pick('indexMaxChars'), DEFAULTS.indexMaxChars)))),
    hitLimit: Math.max(1, Math.min(10, Math.round(num(pick('hitLimit'), DEFAULTS.hitLimit)))),
    hitMaxChars: Math.max(200, Math.min(6000, Math.round(num(pick('hitMaxChars'), DEFAULTS.hitMaxChars)))),
    snippetChars: Math.max(80, Math.min(2000, Math.round(num(pick('snippetChars'), DEFAULTS.snippetChars)))),
    minScore: Math.max(0, Math.min(1, num(pick('minScore'), DEFAULTS.minScore))),
    stopWords: Array.isArray(s.stopWords) ? s.stopWords.join(',') : str(s.stopWords, DEFAULTS.stopWords),
    allowWrite: bool(s.allowWrite, DEFAULTS.allowWrite),
    requireSource: bool(s.requireSource, DEFAULTS.requireSource),
    defaultLimit: Math.max(1, Math.min(15, Math.round(num(pick('defaultLimit'), DEFAULTS.defaultLimit)))),
    maxLimit: Math.max(1, Math.min(30, Math.round(num(pick('maxLimit'), DEFAULTS.maxLimit)))),
    learnedMaxChars: Math.max(200, Math.min(20000, Math.round(num(pick('learnedMaxChars'), DEFAULTS.learnedMaxChars)))),
    learnedMaxFiles: Math.max(10, Math.min(5000, Math.round(num(pick('learnedMaxFiles'), DEFAULTS.learnedMaxFiles))))
  };
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 相对 KB_DIR 的路径，统一正斜杠（Windows 反斜杠在提示词里很扎眼）。 */
function relOf(abs) {
  return path.relative(KB_DIR, abs).replace(/\\/g, '/');
}

// ───────────────────────────── 编码 ─────────────────────────────

/**
 * 读文本文件并**猜对编码**。
 *
 * 顺序：BOM 判断 → UTF-8 严格解码 → GB18030 兜底。
 * 为什么必须先严格 UTF-8 再 GB18030：GB18030 几乎能把任意字节序列解成"某些字"，
 * 所以如果先试它，UTF-8 文件也会"成功"解出乱码且不报错。反过来则安全。
 */
export function decodeTextBuffer(buf) {
  if (!buf || !buf.length) return { text: '', encoding: 'empty' };
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8 (BOM)' };
  }
  // UTF-16 BOM（记事本"Unicode"另存就会这样）
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    try {
      return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
    } catch { /* 下面继续 */ }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    try {
      return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
    } catch { /* 下面继续 */ }
  }
  // UTF-8 严格模式：非法字节直接抛错
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch { /* 不是合法 UTF-8，试中文编码 */ }
  // GB18030 是 GBK/GB2312 的超集，覆盖绝大多数中文 txt
  try {
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030' };
  } catch (error) {
    warn(`GB18030 解码也失败，按 UTF-8 有损解码：${error?.message ?? error}`);
    return { text: buf.toString('utf8'), encoding: 'utf-8 (有损)' };
  }
}

/** 二进制嗅探：有 NUL 字节的基本不是文本（防用户丢进来一个 exe/图片）。 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

// ───────────────────────────── 切段 ─────────────────────────────

/**
 * 把一个文件切成若干"知识段"。
 *
 * 优先按 Markdown 标题分，其次按空行分段。标题会拼成 `文件 › 大节 › 小节`
 * 这样检索结果里能看清出处，模型也更容易判断该不该用。
 */
export function splitSections(text, { fileTitle = '' } = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const out = [];

  // ① 按标题切（记录层级，用来拼完整路径）
  const lines = src.split('\n');
  const hasHeadings = lines.some((l) => /^#{1,6}\s+\S/.test(l));

  if (hasHeadings) {
    let crumbs = [];        // 标题层级栈
    let buf = [];
    const flush = () => {
      const body = buf.join('\n').trim();
      buf = [];
      if (!body) return;
      // 有标题时：这一节的标题栈就是它的出处
      const headingPath = crumbs.filter(Boolean);
      for (const piece of splitByBlankLine(body)) {
        if (piece.replace(/\s+/g, '').length < MIN_SECTION_CHARS) continue;
        out.push({
          heading: headingPath.join(' › ') || fileTitle,
          text: piece
        });
      }
    };
    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flush();
        const level = m[1].length;
        // ⚠️ 先截断到 level-1，再写这一层 —— 关键是**截断要去掉这一层原有的值**。
        //   原来只写 `crumbs = crumbs.slice(0, level - 1)` 看着没错，但对
        //   `level = 2` 它保留 index 0；紧接着的 `crumbs[1] = …` 是往一个**仍在**
        //   的数组尾巴上写，而 index 1 上可能还留着上一个 2 级标题的文字，
        //   slice(0,1) 并不会清掉它 —— 于是新标题会带上一层旧的父级。
        //   实测：一个 `# 标题` + `## 标题` 的文件被解析成「标题 › 标题 › 标题」，
        //   多级标题的文档整篇出处都会错位。
        crumbs = crumbs.slice(0, level - 1);
        crumbs[level - 1] = m[2].trim();
        continue;
      }
      buf.push(line);
    }
    flush();
    // 标题下直接有正文的情况已经被 flush 收走了；只剩"标题但完全没正文"的文件
    if (!out.length) {
      const body = src.replace(/^#{1,6}\s+.*$/gm, '').trim();
      if (body) {
        for (const piece of splitByBlankLine(body)) {
          if (piece.replace(/\s+/g, '').length < MIN_SECTION_CHARS) continue;
          out.push({ heading: fileTitle, text: piece });
        }
      }
    }
  } else {
    for (const piece of splitByBlankLine(src)) {
      if (piece.replace(/\s+/g, '').length < MIN_SECTION_CHARS) continue;
      out.push({ heading: fileTitle, text: piece });
    }
  }

  // 兜底：普通文本但整篇没有空行（很多人一个 txt 从头写到尾）
  if (!out.length && src.trim().length >= MIN_SECTION_CHARS) {
    for (const piece of chunkLong(src.trim(), 800)) {
      out.push({ heading: fileTitle, text: piece });
    }
  }
  return out;
}

function splitByBlankLine(text) {
  return String(text ?? '').split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
}

/** 超长且无分段时按字数硬切（带重叠，避免切断句子后检索不到）。 */
function chunkLong(text, size) {
  const out = [];
  const overlap = Math.floor(size * 0.15);
  for (let i = 0; i < text.length; i += size - overlap) {
    const piece = text.slice(i, i + size).trim();
    if (piece) out.push(piece);
    if (i + size >= text.length) break;
  }
  return out;
}

// ───────────────────────────── 分词与检索 ─────────────────────────────

/**
 * 分词。中文用字符二元组，拉丁字母/数字按词。
 *
 * 举例：「客服电话是 400-123」
 *   → 客服 / 服电 / 电话 / 400 / 123 / 400123
 * 二元组的好处是不需要词典就能覆盖绝大多数中文查询；代价是会有一些无意义组合，
 * 但它们在同库内部一致，靠 IDF 权重自然被压下去。
 */
export function tokenize(text, stopWords = new Set()) {
  const raw = String(text ?? '').toLowerCase();
  const tokens = [];

  // 拉丁词与数字
  for (const m of raw.matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    if (w.length >= 2 && !stopWords.has(w)) tokens.push(w);
  }

  // 连续 CJK 串 → 二元组
  for (const m of raw.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      if (!stopWords.has(run)) tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!stopWords.has(bigram)) tokens.push(bigram);
    }
  }
  return tokens;
}

function parseStopWords(s) {
  return new Set(
    String(s ?? '')
      .split(/[\s,，、;；\n]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length >= 1 && x.length <= 8)
  );
}

/** 建索引用：统计一个分段的词频。 */
function termFreq(text, stopWords) {
  const tf = new Map();
  for (const t of tokenize(text, stopWords)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

// ───────────────────────────── 索引构建 ─────────────────────────────

/**
 * 扫描并重建整个索引。
 * @param {{reason?:string}} opts
 */
export function buildIndex({ reason = 'manual' } = {}) {
  if (state.building) return { ok: false, error: '索引正在构建中' };
  state.building = true;
  const started = Date.now();
  const s = settings();
  const stopWords = parseStopWords(s.stopWords);
  const maxBytes = s.maxFileKB * 1024;

  const docs = [];
  const sections = [];
  const skipped = [];
  const errors = [];
  const df = new Map();

  try {
    if (!fs.existsSync(KB_DIR)) {
      fs.mkdirSync(LEARNED_DIR, { recursive: true });
      log(`已创建知识库目录：${KB_DIR}`);
    }

    const files = walkFiles(KB_DIR);
    for (const abs of files) {
      const rel = relOf(abs);
      const base = path.basename(abs);
      // 内部文件不当资料
      if (base.startsWith('.')) continue;
      if (abs === README_FILE) continue;

      const ext = path.extname(abs).toLowerCase();
      if (!TEXT_EXT.has(ext)) {
        skipped.push({ rel, reason: `不是 txt/md（${ext || '无扩展名'}）` });
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (error) {
        errors.push({ rel, reason: `读不到文件信息：${error?.message ?? error}` });
        continue;
      }
      if (stat.size > maxBytes) {
        skipped.push({ rel, reason: `超过 ${s.maxFileKB}KB（实际 ${Math.round(stat.size / 1024)}KB）` });
        continue;
      }
      if (stat.size === 0) {
        skipped.push({ rel, reason: '空文件' });
        continue;
      }

      let buf;
      try {
        buf = fs.readFileSync(abs);
      } catch (error) {
        errors.push({ rel, reason: `读取失败：${error?.message ?? error}` });
        continue;
      }
      if (looksBinary(buf)) {
        skipped.push({ rel, reason: '看起来是二进制文件（含 NUL 字节）' });
        continue;
      }

      const { text: rawText, encoding } = decodeTextBuffer(buf);
      // 索引前剥掉 HTML 注释：自动记录的文件里有「<!-- 由…自动记录 -->」这种
      // 说明行，它对检索毫无价值，却会在命中详情里占掉正文的位置。
      // 只影响**索引里的文本**，磁盘上的文件一个字都不动。
      const text = rawText.replace(/<!--[\s\S]*?-->/g, ' ');
      const fileTitle = base.replace(/\.(txt|md|markdown)$/i, '');
      // 切段时把**带扩展名的文件名**作为出处标题传给无标题文件：
      // 单纯一个 "测试_术语表" 在引用块里看不出是资料名还是正文里的标题。
      const pieces = splitSections(text, { fileTitle: base });

      // ⚠️ 必须把紧跟正文的「元数据块」并回上一段。
      //   记录格式是「正文 / 空行 / > 来源：… / > 记于 …」，按空行切的话
      //   那两行引用会各自变成一个独立"知识段" —— 检索时它们分数最高，
      //   于是模型拿到的命中详情全是「来源：xxx」「记于 yyy」这种噪音，
      //   真正的答案反而被挤掉。这一步把纯元数据段合并到前一段。
      const merged = [];
      for (const piece of pieces) {
        const lines = piece.text.split('\n').map((l) => l.trim()).filter(Boolean);
        const isMetaOnly = lines.length > 0 && lines.every((l) => /^>\s*(来源|标签|记于)/.test(l));
        if (isMetaOnly && merged.length) {
          merged[merged.length - 1].text += `\n\n${piece.text}`;
          continue;
        }
        merged.push(piece);
      }

      const docSections = [];
      for (let i = 0; i < merged.length; i += 1) {
        const piece = merged[i];
        // ⚠️ 索引**正文**，把记录元数据行（> 来源 / > 标签 / > 记于）剔出去。
        //   理由很实在：这些行里有日期和"来源""记于"这类高频词，
        //   留在正文里会参与 TF 打分、把检索分数抬高，让一条"只有元数据"的
        //   分段也能霸占命中结果（实测出现过整段只有「> 来源：人工整理
        //   > 记于 …」却排在正文前面的情况）。
        //   只影响索引文本；kb_read 读全文时仍给用户看到完整原文。
        const bodyForIndex = piece.text
          .split('\n')
          .filter((l) => !/^\s*>\s*(来源|标签|记于)/.test(l))
          .join('\n')
          .trim();
        // 整段都是元数据 → 不建索引段（它不含任何知识）
        if (!bodyForIndex || bodyForIndex.replace(/\s+/g, '').length < MIN_SECTION_CHARS) continue;

        const tf = termFreq(`${piece.heading}\n${bodyForIndex}`, stopWords);
        const len = [...tf.values()].reduce((a, b) => a + b, 0) || 1;
        const sec = {
          // id 用「已收录段的序号」而不是 i：跳过的元数据段不会在 ref 里留空号
          id: `${rel}#${docSections.length + 1}`,
          doc: rel,
          docTitle: fileTitle,
          heading: piece.heading || fileTitle,
          text: piece.text,
          tf,
          len,
          source: rel.startsWith('learned/') ? 'learned' : 'user'
        };
        docSections.push(sec);
        sections.push(sec);
        for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      }

      if (!docSections.length) {
        skipped.push({ rel, reason: '没有可用的正文内容（太短或全是标题/元数据）' });
        continue;
      }

      docs.push({
        rel,
        title: fileTitle,
        encoding,
        bytes: stat.size,
        mtime: stat.mtimeMs,
        sections: docSections.length,
        source: rel.startsWith('learned/') ? 'learned' : 'user'
      });
    }

    state.docs = docs;
    state.sections = sections;
    state.df = df;
    state.avgLen = sections.length ? sections.reduce((a, x) => a + x.len, 0) / sections.length : 1;
    state.builtAt = Date.now();
    state.skipped = skipped;
    state.errors = errors;
    state.dirty = false;

    saveIndex();
    log(`索引已重建（${reason}）：${docs.length} 个文件 / ${sections.length} 段 / ${df.size} 个词`
      + `${skipped.length ? `／跳过 ${skipped.length} 个文件` : ''}，耗时 ${Date.now() - started}ms`);
    return { ok: true, docs: docs.length, sections: sections.length, skipped, errors, ms: Date.now() - started };
  } catch (error) {
    const msg = error?.message ?? String(error);
    state.errors = [...errors, { rel: '(整体)', reason: msg }];
    warn(`重建索引失败：${msg}`);
    return { ok: false, error: msg, skipped, errors: state.errors };
  } finally {
    state.building = false;
  }
}

/** 递归列出目录下所有文件（跳过隐藏目录）。 */
function walkFiles(dir, depth = 0) {
  const out = [];
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      out.push(...walkFiles(abs, depth + 1));
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/** 索引落盘（只存元信息，正文每次从文件现读 —— 保证用户改了文件立刻生效）。 */
function saveIndex() {
  try {
    fs.mkdirSync(KB_DIR, { recursive: true });
    const payload = {
      version: INDEX_VERSION,
      builtAt: state.builtAt,
      docs: state.docs.map((d) => ({
        rel: d.rel, title: d.title, encoding: d.encoding, bytes: d.bytes,
        mtime: d.mtime, sections: d.sections, source: d.source
      })),
      sections: state.sections.length,
      skipped: state.skipped,
      errors: state.errors
    };
    const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8');
    fs.renameSync(tmp, INDEX_FILE);
  } catch (error) {
    warn(`索引落盘失败（不影响使用）：${error?.message ?? error}`);
  }
}

// ───────────────────────────── 检索 ─────────────────────────────

/**
 * BM25-lite 检索。
 *
 * 打分 = Σ_t IDF(t) × 归一化词频(t) ，最后按查询词数归一化到 0~1。
 * 用 IDF 是关键：中文二元组会产生大量无意义组合（如「的服」），
 * 它们几乎出现在所有分段里 → IDF 趋近 0 → 自然被压掉。
 * 归一化到 0~1 是为了让 minScore 这个门槛在不同长度的查询下都讲得通。
 */
export function search(query, { limit = 5, minScore = null, snippetChars = 400 } = {}) {
  const s = settings();
  const q = String(query ?? '').trim();
  if (!q) return { ok: true, query: '', hits: [], total: state.sections.length, empty: true };
  if (!state.sections.length) return { ok: true, query: q, hits: [], total: 0 };

  const threshold = minScore === null || minScore === undefined ? s.minScore : num(minScore, s.minScore);
  const stopWords = parseStopWords(s.stopWords);
  const qTokens = tokenize(q, stopWords);
  if (!qTokens.length) return { ok: true, query: q, hits: [], total: state.sections.length, reason: '查询词太短或全被过滤' };

  const qSet = [...new Set(qTokens)];
  const N = state.sections.length;
  const k1 = 1.2;
  const b = 0.6;
  const avg = state.avgLen || 1;
  // 归一化因子：按查询词数的**平方根**缩放，不是按词数本身。
  //
  // ⚠️ 这里踩过一个会直接毁掉「本地优先」的坑：最初用 `score / (词数 × 2.2)`，
  //   而中文二元组会把一句自然口语切出很多词 —— 「咱们的退款流程是啥」切出
  //   咱们/们的/的退/退款/款流/流程/程是/是啥 共 8 个，其中只有 3 个真命中，
  //   于是分数被线性稀释到 0.122，**刚好卡在 0.12 门槛上**；再长一点
  //   （「…是啥呢请问」）就直接归零，本地明明有资料却一条都给不出来。
  //   改成平方根后，词数从 3 涨到 9 只让分母涨约 1.7 倍，长句口语查询不再被误杀，
  //   而真正不相关的内容仍然过不了门槛（实测「毫不相关的话题xyz」依旧 0 命中）。
  const qNorm = Math.max(1, Math.sqrt(qSet.length)) * 2.2;
  const scored = [];

  for (const sec of state.sections) {
    let score = 0;
    for (const t of qSet) {
      const f = sec.tf.get(t);
      if (!f) continue;
      const dfv = state.df.get(t) || 1;
      const idf = Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5));
      if (idf <= 0) continue;
      const norm = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (sec.len / avg)));
      score += idf * norm;
    }
    if (score <= 0) continue;
    const normalized = score / qNorm;
    if (normalized < threshold) continue;
    scored.push({ sec, score: normalized });
  }

  scored.sort((a, b2) => b2.score - a.score);
  const top = scored.slice(0, Math.max(1, Math.min(30, Math.round(limit))));
  return {
    ok: true,
    query: q,
    total: state.sections.length,
    matched: scored.length,
    hits: top.map(({ sec, score }) => ({
      ref: sec.id,
      doc: sec.doc,
      docTitle: sec.docTitle,
      heading: sec.heading,
      source: sec.source,
      score: Math.round(score * 1000) / 1000,
      excerpt: excerptAround(sec.text, qTokens, snippetChars)
    }))
  };
}

/**
 * 取片段：优先取**包含查询词**的那一段，而不是永远取开头。
 * 永远给开头的话，长文里真正相关的部分根本看不到。
 */
function excerptAround(text, qTokens, maxChars) {
  const body = String(text ?? '');
  if (body.length <= maxChars) return body;

  // 中文按二元组定位：找到第一个查询词出现的位置
  let best = -1;
  for (const t of qTokens) {
    const i = body.toLowerCase().indexOf(t);
    if (i >= 0 && (best === -1 || i < best)) best = i;
  }
  if (best < 0) return `${body.slice(0, maxChars)}…`;
  const start = Math.max(0, best - Math.floor(maxChars * 0.3));
  const piece = body.slice(start, start + maxChars);
  return `${start > 0 ? '…' : ''}${piece}${start + maxChars < body.length ? '…' : ''}`;
}

/** 读某个分段的全文（按 kb_search 返回的 ref）。 */
export function readSection(ref) {
  const target = String(ref ?? '').trim();
  if (!target) return { ok: false, error: '需要 ref（kb_search 结果里的「出处」那一列）' };
  let sec = state.sections.find((x) => x.id === target);
  // 容错：允许只传 "文件名#序号"，也允许传文件路径
  if (!sec) sec = state.sections.find((x) => x.id.toLowerCase() === target.toLowerCase());
  if (!sec) {
    const byDoc = state.sections.filter((x) => x.doc === target || x.docTitle === target);
    if (byDoc.length) {
      return {
        ok: true,
        multi: true,
        doc: target,
        sections: byDoc.map((x) => ({ ref: x.id, heading: x.heading, chars: x.text.length })),
        note: '这个文件里有多个小节，请用具体的 ref 再读一次。'
      };
    }
    return { ok: false, error: `没有找到 ${target}（可能文件刚被改过，先用 kb_search 重新查一次）` };
  }
  pendingReads.push({ ref: sec.id, at: Date.now() });
  if (pendingReads.length > 50) pendingReads = pendingReads.slice(-50);
  return {
    ok: true,
    ref: sec.id,
    doc: sec.doc,
    heading: sec.heading,
    source: sec.source,
    chars: sec.text.length,
    text: sec.text
  };
}

// ───────────────────────────── 写入（搜到就存回来）─────────────────────────────

/** 文件名净化：去掉 Windows 非法字符，保留中文。 */
function safeFileName(title) {
  const s = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (s || '未命名').slice(0, 60);
}

/**
 * 记住一条知识：写进 learned/ 子目录的一个 md 文件。
 *
 * 放 learned/ 而不是知识库根目录，是为了让你一眼分得清
 * 「哪些是我放的」和「哪些是它自己记的」—— 后者可以放心批量删。
 * 同名文件（同一个话题）**追加小节**而不是覆盖，这样同一话题的多次查询会积累。
 */
export function remember({ title, content, source = '', tags = '' } = {}) {
  const s = settings();
  if (!s.allowWrite) {
    return { ok: false, error: '「允许机器人自己记东西」是关闭状态，不能写入。可以让用户在插件设置里打开。' };
  }
  const name = safeFileName(title);
  const body = String(content ?? '').trim();
  if (!body) return { ok: false, error: '内容为空' };
  if (body.length > s.learnedMaxChars) {
    return {
      ok: false,
      error: `内容太长（${body.length} 字，上限 ${s.learnedMaxChars} 字）。请摘出要点再记，不要把整篇搜索结果搬进来。`
    };
  }

  try {
    fs.mkdirSync(LEARNED_DIR, { recursive: true });
    const file = path.join(LEARNED_DIR, `${name}.md`);
    const exists = fs.existsSync(file);
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // 内容里已经有标题就用它当小节标题，否则用 name。
    // ⚠️ 这里必须避免"标题出现两次"：新文件本来就会写一行 `# 标题`，
    //   如果再无条件加一行同名的 `## 标题`，切段后出处会拼成
    //   「HTTP 404 是什么 › HTTP 404 是什么 › HTTP 404 是什么」这种复读机，
    //   既难看又白占 token。
    const bodyLines = body.split('\n');
    const firstMatch = bodyLines[0]?.match(/^\s*#{1,6}\s+(.*)$/);
    const bodyHeading = firstMatch ? firstMatch[1].trim() : '';
    const bodyRest = firstMatch ? bodyLines.slice(1).join('\n').trim() : body;
    // 追加的小节标题：内容自带的标题优先，否则用日期。
    // ⚠️ 不要退回用 name —— 那就和文件标题（h1）同名，一个文件里几条记录会
    //   全都显示成「退款政策 › 退款政策」，既分不清是哪条，看着也像复读。
    //   日期至少能区分"哪次记的"，和这种"按时间累积的笔记"文件形态也相符。
    const dayStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const sectionTitle = bodyHeading || dayStamp;
    // 新文件本来就写了 `# name` 这一行，再补 `## name` 就是同一个标题出现两次；
    // 追加进已有文件时才需要一个小节标题把新内容分出来。
    const needHeading = exists;

    const block = [
      '',
      needHeading ? `## ${sectionTitle}` : '',
      bodyRest,
      source ? `\n> 来源：${clip(source, 300)}` : '',
      tags ? `> 标签：${clip(tags, 120)}` : '',
      `> 记于 ${stamp}（机器人自动记录，可直接编辑或删除）`
    ].filter(Boolean).join('\n');

    let next;
    if (exists) {
      const old = fs.readFileSync(file, 'utf8');
      // 防重复：同样内容已经在里面就不再加
      if (old.includes(body.slice(0, Math.min(80, body.length)))) {
        return { ok: true, file: relOf(file), appended: false, note: '这段内容之前已经记过了，没有重复添加。' };
      }
      next = `${old.trimEnd()}\n${block}\n`;
    } else {
      next = `# ${name}\n\n<!-- 由「本地知识库」自动记录；你可以直接编辑、也可以整个删掉 -->\n${block}\n`;
    }

    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, file);        // 原子替换

    pruneLearned(s.learnedMaxFiles);

    // 同步重建索引，让这条**立刻**可检索。
    // ⚠️ 这里不能用 scheduleRebuild()：它走的是被 unref 的延迟定时器，
    //   平时没问题，但进程要退出时（用户正好在这几百毫秒内关掉 QQ Agent）
    //   定时器会被直接丢弃 —— 文件已经落盘、索引却没更新，表现是
    //   「明明记了却查不到」，而且下次启动才自愈。同步重建只要几毫秒。
    if (state.watchTimer) { clearTimeout(state.watchTimer); state.watchTimer = null; }
    const rebuilt = buildIndex({ reason: `remember:${name}` });

    const after = fs.statSync(file);
    log(`已记住「${name}」（${body.length} 字）→ ${relOf(file)}`);
    return {
      ok: true,
      file: relOf(file),
      appended: exists,
      chars: body.length,
      bytes: after.size,
      indexed: rebuilt.ok ? rebuilt.docs : null,
      note: '已存入本地知识库，之后遇到相关话题会直接命中，不用再联网搜。'
    };
  } catch (error) {
    const msg = error?.message ?? String(error);
    warn(`写入知识库失败：${msg}`);
    return { ok: false, error: `写入失败：${msg}` };
  }
}

/** learned 目录限量：超了删最旧的。 */
function pruneLearned(maxFiles) {
  try {
    const files = fs.readdirSync(LEARNED_DIR)
      .filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const abs = path.join(LEARNED_DIR, f);
        return { abs, f, mtime: fs.statSync(abs).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    if (files.length <= maxFiles) return 0;
    const doomed = files.slice(0, files.length - maxFiles);
    for (const d of doomed) {
      try {
        fs.unlinkSync(d.abs);
        log(`learned/ 超出 ${maxFiles} 个，已删除最旧的：${d.f}`);
      } catch { /* 删不掉就算了 */ }
    }
    return doomed.length;
  } catch {
    return 0;
  }
}

// ───────────────────────────── 文件监听 ─────────────────────────────

/** 防抖重建：fs.watch 对一次复制会触发多次事件。 */
function scheduleRebuild(reason, delayMs = null) {
  const s = settings();
  const delay = delayMs === null ? s.watchDebounceMs : delayMs;
  if (state.watchTimer) clearTimeout(state.watchTimer);
  state.watchTimer = setTimeout(() => {
    state.watchTimer = null;
    try {
      buildIndex({ reason });
    } catch (error) {
      warn(`自动重建索引失败：${error?.message ?? error}`);
    }
  }, delay);
  state.watchTimer.unref?.();   // 空闲等待型定时器：不阻止进程退出
}

function startWatch() {
  stopWatch();
  try {
    fs.mkdirSync(LEARNED_DIR, { recursive: true });
    // recursive 在 Windows 上可用（本项目就是 Windows 桌面版）
    state.watcher = fs.watch(KB_DIR, { recursive: true }, (_event, filename) => {
      const name = String(filename || '');
      // 自己写索引 / 临时文件不触发重建，否则会自己触发自己
      if (!name || name.startsWith('.') || name.endsWith('.tmp')) return;
      scheduleRebuild(`检测到变化：${name}`);
    });
    state.watcher.on?.('error', (e) => warn(`文件监听出错（知识库仍可用，只是不会自动更新）：${e?.message ?? e}`));
    log(`文件监听已启动：${KB_DIR}`);
  } catch (error) {
    // 监听失败不影响检索：只是需要重启或手动刷新才会看到新文件
    warn(`无法监听知识库目录（不影响已索引的内容，新文件需要重启才会生效）：${error?.message ?? error}`);
  }
}

function stopWatch() {
  if (state.watcher) {
    try { state.watcher.close(); } catch { /* ignore */ }
    state.watcher = null;
  }
  if (state.watchTimer) {
    clearTimeout(state.watchTimer);
    state.watchTimer = null;
  }
}

// ───────────────────────────── 注入 ─────────────────────────────

/**
 * 检索结果渲染给模型看。
 *
 * 关键：**必须把"本地没有"和"本地没在工作"区分开**。
 * 前者可以放心去联网搜；后者要说清楚是配置问题，否则模型会以为用户没放资料。
 * 还要把「用 kb_read 读全文」这条路径明确写出来，不然它会拿截断片段硬编。
 */
function renderHits(res, s) {
  const L = [];
  if (!state.sections.length) {
    return `本地知识库是空的（目录：${KB_DIR}）。让用户把 txt / md 文件丢进那个目录即可，不用重启。`
      + '\n现在请直接用 web_search 联网搜；搜到有长期价值的内容可以用 kb_remember 记回本地库。';
  }
  if (res.empty || !res.query) {
    return `本地知识库有 ${state.docs.length} 个文件 / ${res.total} 段，但没有给查询词。请带上 query 再查。`;
  }
  if (!res.hits?.length) {
    return `【本地知识库】用「${clip(res.query, 60)}」没查到（全库 ${res.total} 段已检索）。`
      + '\n这一步的结论是**本地没有**，可以放心去 web_search 联网搜；'
      + '搜到有长期价值的内容，用 kb_remember 记回本地库，下次就不用再搜了。\n'
      + '（注意：不要因为查不到就编，也不要跟群友说你在查知识库。）';
  }
  L.push(`【本地知识库命中 ${res.hits.length} 条／全库 ${res.total} 段】（用「${clip(res.query, 60)}」检索）`);
  for (const h of res.hits) {
    L.push(`· ${headingLabel(h)}　出处：${h.ref}　相关度 ${h.score}`);
    L.push(`  ${h.excerpt}`);
  }
  L.push(`需要完整内容就用 kb_read 读对应出处（${res.hits[0].ref} 这样传），不要凭上面的截断片段猜后半句。`);
  L.push(res.matched > res.hits.length
    ? `（共命中 ${res.matched} 段，只显示了前 ${res.hits.length} 段；不够就换关键词再查。）`
    : '（以上是全部命中。）');
  L.push('这些是本地资料（可能是用户特意放进去的文件，也可能是以前从网上查证后记下的），'
    + '可信度高于网上泛泛的文章；但如果和事实冲突，以事实为准。');
  return L.join('\n');
}

/**
 * 出处的显示形式：文件 › 小节。
 * 小节名和文件名相同时只显示一次 —— 否则会出现
 * 「HTTP 404 是什么 › HTTP 404 是什么」这种复读，纯粹是噪音。
 * 自动记录的文件 h1 就是主题名，所以这一步能消掉绝大多数重复。
 */
function headingLabel(sec) {
  const docTitle = String(sec.docTitle || '');
  const heading = String(sec.heading || '');
  // 标题路径形如「项目术语表 › 摸鱼模式」。逐段去掉与文件名同义的段，
  // 否则会渲染成「HTTP 404 是什么 › HTTP 404 是什么」。
  // 同义判定：空、等于文件名、等于去掉扩展名的文件名。
  const bare = docTitle.replace(/\.(txt|md|markdown)$/i, '');
  const same = (x) => !x || x === docTitle || x === bare;
  const parts = heading.split('›').map((x) => x.trim()).filter((x) => x && !same(x));
  if (!parts.length) return docTitle;
  return `${docTitle} › ${parts.join(' › ')}`;
}

/** 目录清单：每轮都带，所以必须极短 —— 只给文件名。 */
function buildIndexBlock(s) {
  if (!state.docs.length) return '';
  const userDocs = state.docs.filter((d) => d.source === 'user');
  const learnedDocs = state.docs.filter((d) => d.source === 'learned');
  const head = `【本地知识库：${state.docs.length} 个文件 / ${state.sections.length} 段（回答前先查这里，比联网可信）】`;
  const lines = [head];
  let used = head.length;
  let shown = 0;

  // 用户自己放的资料优先列出（那是他特意要机器人学会的东西）
  const pushLine = (line) => {
    if (used + line.length + 1 > s.indexMaxChars) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  for (const d of userDocs) {
    if (!pushLine(`· ${d.title}（${d.sections} 段）`)) break;
    shown += 1;
  }
  // 机器人自己记的只报一个总数：那些是碎片，逐条列会挤掉用户资料的位置
  if (learnedDocs.length) {
    const line = `· 另有 ${learnedDocs.length} 条自己记下的知识（learned/）`;
    if (pushLine(line)) shown += 1;
  }
  const notShown = state.docs.length - shown;
  if (notShown > 0) {
    // 这一行即使略超上限也要带上：否则模型会以为知识库只有列出来的这些
    lines.push(`（还有 ${notShown} 个文件没列出来，用 kb_search 就能找到）`);
  }
  lines.push('要具体内容时调 kb_search（可带 query）；本地查不到再去联网搜。');
  return lines.join('\n');
}

/** 命中块：只把真正相关的那几段正文给它。 */
function buildHitBlock(hits, s) {
  if (!hits.length) return '';
  const lines = [`【本地知识库命中 ${hits.length} 条（优先用这里的内容回答，不必再联网）】`];
  let used = lines[0].length;
  for (const h of hits) {
    const head = `· ${headingLabel(h)}｜${h.ref}`;
    const room = s.hitMaxChars - used - head.length - 10;
    if (room < 60) break;
    const body = h.excerpt.length > room ? `${h.excerpt.slice(0, room)}…` : h.excerpt;
    lines.push(head);
    lines.push(body);
    used += head.length + body.length + 2;
  }
  lines.push('这些是用户自己放的资料，可信度高于网上搜索；但如果和你的判断冲突，以事实为准。');
  return lines.join('\n');
}

/**
 * 把片段追加到最后一条 user 消息末尾。
 *
 * 为什么不插进 system 中间：prompt.js 明确写了系统提示的缓存前缀占 token 大头，
 * 中间插动态内容会让后面所有核心规则位移、缓存前缀归零。动态内容一律殿后。
 * （本机这份 src/prompt.js 没有 appendDynamicTail，所以自己实现，不依赖它存在。）
 */
function appendToTail(messages, text) {
  const block = `\n\n${String(text).trim()}`;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') { m.content += block; return true; }
    if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
  }
  messages.push({ role: 'user', content: block.trim() });
  return true;
}

/** 取最后一条 user 消息的文本。 */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join(' ');
    }
  }
  return '';
}

// ───────────────────────────── 状态 ─────────────────────────────

export function status() {
  const s = settings();
  const bySource = { user: 0, learned: 0 };
  for (const d of state.docs) bySource[d.source] = (bySource[d.source] || 0) + 1;
  let indexBytes = 0;
  try { indexBytes = fs.statSync(INDEX_FILE).size; } catch { /* 还没有 */ }
  const recent = pendingReads.slice(-5).reverse().map((r) => {
    const sec = state.sections.find((x) => x.id === r.ref);
    return { ref: r.ref, heading: sec?.heading ?? '', doc: sec?.doc ?? '' };
  });
  return {
    ok: true,
    buildTag: BUILD_TAG,
    enabled: s.enabled,
    dir: KB_DIR,
    learnedDir: LEARNED_DIR,
    readmePath: README_FILE,
    mode: s.injectMode,
    watching: Boolean(state.watcher),
    builtAt: state.builtAt,
    builtAtText: state.builtAt ? clock(state.builtAt) : '从未',
    docs: state.docs.length,
    docsUser: bySource.user || 0,
    docsLearned: bySource.learned || 0,
    sections: state.sections.length,
    vocab: state.df.size,
    avgSectionLen: Math.round(state.avgLen),
    indexBytes,
    allowWrite: s.allowWrite,
    minScore: s.minScore,
    skipped: state.skipped,
    errors: state.errors,
    recentReads: recent,
    docsList: state.docs.map((d) => ({
      rel: d.rel, title: d.title, sections: d.sections,
      kb: Math.round(d.bytes / 1024), encoding: d.encoding, source: d.source
    }))
  };
}

function clock(ts) {
  try {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ''; }
}

// ───────────────────────────── 生命周期 / 扩展点 ─────────────────────────────

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;

  // 目录与说明文件：只在缺失时创建，绝不覆盖用户自己改过的 README
  try {
    fs.mkdirSync(LEARNED_DIR, { recursive: true });
  } catch (error) {
    warn(`创建知识库目录失败：${error?.message ?? error}`);
  }

  registerTools(api);
  // 注意：这里**不能**调用 exposePathsInSettings() —— setup 跑在"新实例注册"之前，
  // 此刻 registry 里还是旧实例（或什么都没有），改它的 manifest 会被随后的
  // register 覆盖掉。真正的注入时机见 available()。
  log(`本地知识库已就绪（${BUILD_TAG}）｜目录：${KB_DIR}`);
}

/**
 * 把知识库目录的**完整真实路径**显示到插件设置界面上。
 *
 * 需求是"一键打开目录的按钮"，但技能设置弹窗只认 boolean/number/enum/string
 * 四种控件（见 ui/app/06-settings-render.js 的 renderSkillSettingsModal），
 * 加按钮就必须改 app 自带的那个文件 —— 而它会在 QQ Agent 升级时被覆盖。
 * 所以这里改用项目**自带**的 internal 类型：它不渲染成输入框，只在弹窗底部的
 * 「以下设置不在这里改」区块里把内容显示出来。用户看到完整路径就能直接粘贴到
 * 资源管理器打开，而且一个 app 文件都不用碰、升级也不会丢。
 *
 * 为什么在运行时改写、而不是写死在 plugin.json 里：
 *   真实路径随安装位置与 QQ_AGENT_DATA_DIR 而变，写死就会显示一个不存在的路径
 *   （显示 C:\a\… 而实际在 D:\b\…，比不显示更糟）。
 *
 * 改的是**活的 manifest 对象**：settingsView() 每次都读 skill.manifest.settings，
 * 而 GET /api/skills 走的就是它，所以界面立刻拿到真实路径，不需要重启。
 */
function exposePathsInSettings() {
  try {
    const manifest = skillManager.registry.get(ENTRY_ID)?.manifest;
    if (!manifest) {
      warn('拿不到本条目已注册的清单，目录路径这次没能显示在设置界面里（不影响功能）');
      return false;
    }
    if (!manifest.configSchema || typeof manifest.configSchema !== 'object') manifest.configSchema = {};
    if (!manifest.settings || typeof manifest.settings !== 'object') manifest.settings = {};
    // ⚠️ 两处都必须写，少一个界面就是空白：
    //   configSchema → 决定"渲染成什么控件、标签和说明写什么"
    //   settings     → 提供**值**（settingsView 是 getSkillConfig(id, manifest.settings)，
    //                  弹窗里取的是 values[key] ?? d.default ?? ''）
    //   只写 configSchema 时字段确实出现在"不在这里改"区块里，但值是空的 ——
    //   实测踩过：schema 里有 knowledgeDir，settingsView 里却是 undefined。
    manifest.configSchema.knowledgeDir = {
      type: 'internal',
      label: '知识库目录（所有资料放这里）',
      description: '把 txt / md 文件复制到这个文件夹，机器人就会自动学会，不用重启。'
        + '在资源管理器的地址栏粘贴下面这行就能打开。'
    };
    manifest.configSchema.learnedDir = {
      type: 'internal',
      label: '自动记录目录（learned）',
      description: '机器人从网上搜到并记下来的知识放这里，可以放心批量删 —— 删了就忘了，下次搜到会重新记。'
    };
    // 值：真实路径（随安装位置/QQ_AGENT_DATA_DIR 变化，所以运行时取，不写死在清单里）
    manifest.settings.knowledgeDir = KB_DIR;
    manifest.settings.learnedDir = LEARNED_DIR;
    return true;
  } catch (error) {
    warn(`显示目录路径失败（不影响功能）：${error?.message ?? error}`);
    return false;
  }
}

/**
 * ── 为什么工具注册在插件里（这个决定要留个说明）────────────────────────────
 * 按项目的目录语义（src/skills/manifest.js 的 DIR_KIND），"用不用由模型判断"
 * 的工具本该放 skills/。这里没有另开一个技能，原因是一个**实测到的硬约束**：
 *
 *   SkillRegistry.register() 对重复 id 是直接覆盖，而 loadPlugins 是
 *   "先扫 skills/ 再扫 plugins/"。所以技能和插件一旦同名，后加载的插件会把
 *   技能整个顶掉，并连带注销它注册的所有工具 —— 现场表现是
 *   「插件页有它、但它提供的工具一个都不存在」，属于最难查的那类静默失效。
 *   （本机实测：两个目录都用 knowledge-base 时，加载结果只剩插件那一条，
 *     kb_* 工具全部消失，且加载器还额外报了一个失败条目。）
 *
 * 而两者都不改名也是有正当理由的：src/config.js 的 LEGACY_SKILL_MIGRATIONS 里
 *   { from: ['tools','knowledgeEnabled'], skill: 'knowledge-base' }
 * 指明了这个功能就叫 knowledge-base（注释写着"知识库技能尚未移植，先留位"）。
 * 名字被核心配置锚定了，所以这里合并成一个条目，让那个坑位真正被填上。
 *
 * 语义上这仍然是合规的：插件提供 providers（knowledge.search / knowledge.write）
 * + hooks（必然执行的索引与注入），工具只是额外附带的接口，不是它存在的唯一理由
 * —— 不会触发 lintKindPlacement 的"提供了插件却没有任何代码会调用它"告警。
 */
function registerTools(api) {
  if (typeof api?.registerTool !== 'function') return;
  const s = () => settings();

  api.registerTool({
    id: 'kb_search',
    name: '查本地知识库',
    description: '检索本地知识库（用户在 data/knowledge-base/ 放的资料 + 机器人自己记下的知识）。'
      + '**回答事实性问题时先用它，本地查不到再去 web_search** —— 本地资料比网上搜到的可信，而且不花钱、不花时间。'
      + '什么时候用：① 问某个名词/工具/概念是什么；② 问群里或某个项目的约定、规则、背景；'
      + '③ 你打算联网搜之前先探一下（很可能用户已经放好资料了）；④ 以前查过、现在记不清的东西。'
      + '返回的是**截断片段**，需要完整内容就用 kb_read 读那一段（传 ref），不要凭片段猜后半句。'
      + '查不到就老实说本地没有，然后去联网搜 —— 不要编。',
    category: 'knowledge',
    icon: '📚',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的内容，用关键词或一句话都行。留空则只返回库的概况，不检索。' },
        limit: { type: 'number', description: '最多返回几条，默认 5。' }
      }
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const cfgNow = s();
      if (!cfgNow.enabled) {
        return { content: '本地知识库处于**关闭**状态（插件设置里关了），现在查不到任何本地资料。'
          + '请直接用 web_search 联网搜；如果希望用本地资料，让用户去插件页把「本地知识库」打开。' };
      }
      const query = str(raw.query);
      if (!query) {
        const st = status();
        if (!st.docs) {
          return { content: `本地知识库是空的（目录：${st.dir}）。让用户把 txt 文件丢进那个目录即可，不用重启。`
            + '现在请直接联网搜。' };
        }
        return { content: `本地知识库现有 ${st.docs} 个文件 / ${st.sections} 段：\n`
          + st.docsList.slice(0, 30).map((d) => `· ${d.title}（${d.sections} 段，${d.kb}KB）`).join('\n')
          + '\n要内容就再用 kb_search 带上 query。' };
      }
      const limit = Math.max(1, Math.min(cfgNow.maxLimit, Math.round(num(raw.limit, cfgNow.defaultLimit))));
      const res = search(query, { limit, snippetChars: cfgNow.snippetChars });
      return { content: renderHits(res, cfgNow) };
    }
  });

  api.registerTool({
    id: 'kb_read',
    name: '读知识库某一段',
    description: '按 ref 读取本地知识库里**某一段的完整正文**。kb_search 给的是截断片段（还带省略号），'
      + '当你要引用细节、数字、步骤、完整定义时，用这个读全文，不要靠截断的片段拼凑。'
      + 'ref 就是 kb_search 结果里每条后面那个「出处」（形如 文件名.md#3）。'
      + '如果传的是文件名而不是 ref，会返回那个文件的所有小节列表，让你挑一个再读。',
    category: 'knowledge',
    icon: '📖',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'kb_search 返回的「出处」，形如 资料.md#3；也可以直接传文件名。' }
      },
      required: ['ref']
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const ref = str(raw.ref);
      if (!ref) return fail('需要 ref（kb_search 结果里的「出处」）');
      const r = readSection(ref);
      if (!r.ok) return fail(r.error);
      if (r.multi) {
        return { content: `「${r.doc}」里有 ${r.sections.length} 个小节：\n`
          + r.sections.map((x) => `· ${x.ref}　${x.heading}（${x.chars} 字）`).join('\n')
          + '\n挑一个把它的 ref 传进来就能读全文。' };
      }
      return { content: `【${headingLabel(r)}】（${r.chars} 字）\n\n${r.text}` };
    }
  });

  api.registerTool({
    id: 'kb_remember',
    name: '记进本地知识库',
    description: '把**有长期价值**的内容记进本地知识库，下次遇到就不用重新联网搜了 —— 这是「搜到了就存回本地」的实现。'
      + '什么时候该记：查到了名词/概念的定义、某个事件的来龙去脉、某个工具的用法、某个群的约定规则，'
      + '而且**以后还会再用到**。'
      + '什么时候**不要记**（很重要）：今天天气、正在变的股价、新闻的最新进展、一次性的闲聊结论 —— '
      + '这些记下去过几天就是错的，比不记更糟。'
      + '内容要摘成要点（别整篇搬运，超长会被拒绝），并写上来源。'
      + '记完会立刻可检索，不需要重启。',
    category: 'knowledge',
    icon: '📝',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '这条知识的主题名（会成为文件名和小节标题），例如「XX 是什么」或「XX 群规」。' },
        content: { type: 'string', description: '要记住的内容，摘成要点写清楚。不要整篇复制搜索结果。' },
        source: { type: 'string', description: '来源（网址或搜索结果标题），方便事后核对。' },
        tags: { type: 'string', description: '可选标签，逗号分隔。' }
      },
      required: ['title', 'content']
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const cfgNow = s();
      if (!cfgNow.enabled) return fail('本地知识库处于关闭状态，无法写入。请让用户在插件页打开「本地知识库」。');
      if (!cfgNow.allowWrite) {
        return fail('「允许机器人自己记东西」是关闭状态。可以把这条内容直接说给用户，或让他在插件设置里打开该开关。');
      }
      const title = str(raw.title);
      const content = String(raw.content ?? '').trim();
      const source = str(raw.source);
      if (!title) return fail('需要 title（这条知识的主题名）');
      if (!content) return fail('需要 content（要记住的内容）');
      if (cfgNow.requireSource && !source) {
        return fail('这条记录没有写来源。请补上 source（网址或搜索结果标题）再记 —— '
          + '没有来源的自动记录很容易把模型自己编的内容也存进去。');
      }
      const r = remember({ title, content, source, tags: str(raw.tags) });
      if (!r.ok) return fail(r.error);
      return {
        content: `已记入本地知识库：${r.file}（${r.chars} 字${r.appended ? '，追加到已有文件' : ''}）。`
          + `${r.note || ''}不要跟群友汇报这个动作，继续正常回话就行。`
      };
    }
  });

  api.registerTool({
    id: 'kb_status',
    name: '知识库状态与维护',
    description: '查看本地知识库的健康状况：有几个文件、多少段、目录在哪、有没有文件被跳过或读错、'
      + '最近查过什么，以及手动维护动作。'
      + '什么时候用：① 有人问「你学了我放的东西没」「知识库里有什么」；'
      + '② 查知识库总是查不到，怀疑文件没被读到（比如文件太大、编码不对、格式不支持）；'
      + '③ 有人刚放了文件想立刻生效；④ 有人问为什么知识库是空的。'
      + 'action 可选：status（默认，只看状态）、list（列出所有文件）、rebuild（立刻重新扫描目录，'
      + '放完新文件想马上生效时用）。',
    category: 'knowledge',
    icon: '🗂️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'list', 'rebuild'], description: '要做的动作，默认 status。' }
      }
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const action = str(raw.action, 'status').toLowerCase();
      if (action === 'rebuild') {
        const r = buildIndex({ reason: 'tool' });
        if (!r.ok) return fail(`重建索引失败：${r.error}`);
        return {
          content: `已重新扫描知识库目录：${r.docs} 个文件 / ${r.sections} 段，耗时 ${r.ms}ms。`
            + `${r.skipped.length ? `\n跳过 ${r.skipped.length} 个文件：` + r.skipped.slice(0, 8).map((x) => `${x.rel}（${x.reason}）`).join('；') : ''}`
        };
      }
      const st = status();
      if (action === 'list') {
        if (!st.docsList.length) return { content: `知识库是空的。目录：${st.dir}` };
        return {
          content: `知识库共 ${st.docsList.length} 个文件：\n`
            + st.docsList.map((d) => `· ${d.rel}（${d.sections} 段，${d.kb}KB，${d.encoding}${d.source === 'learned' ? '，机器人自己记的' : ''}）`).join('\n')
        };
      }
      const L = [];
      L.push('【本地知识库 · 状态】');
      L.push(`· ${st.enabled ? '已启用' : '⚠️ 已关闭'}｜注入模式 ${st.mode}｜目录监听 ${st.watching ? '在跑' : '没在跑'}`);
      L.push(`· 目录：${st.dir}`);
      L.push(`· 内容：${st.docs} 个文件（用户放的 ${st.docsUser} + 自己记的 ${st.docsLearned}）／${st.sections} 段／词表 ${st.vocab} 个`);
      L.push(`· 索引建于 ${st.builtAtText}（${Math.round(st.indexBytes / 1024)}KB），平均每段 ${st.avgSectionLen} 词`);
      L.push(`· 写入：${st.allowWrite ? '允许（搜到会记回 learned/）' : '已禁止'}｜命中门槛 ${st.minScore}`);
      if (st.skipped.length) {
        L.push(`· ⚠️ 跳过了 ${st.skipped.length} 个文件（**这些内容机器人学不到**）：`);
        for (const x of st.skipped.slice(0, 10)) L.push(`   - ${x.rel}：${x.reason}`);
      }
      if (st.errors.length) {
        L.push(`· ⚠️ 读取出错 ${st.errors.length} 个：`);
        for (const x of st.errors.slice(0, 10)) L.push(`   - ${x.rel}：${x.reason}`);
      }
      if (st.recentReads.length) {
        L.push(`· 最近查过：${st.recentReads.map((r) => r.heading || r.ref).join('、')}`);
      }
      return { content: L.join('\n') };
    }
  });
}

export function activate() {
  const s = settings();
  if (!s.enabled) {
    state.docs = [];
    state.sections = [];
    stopWatch();
    log('本地知识库当前是关闭状态（不索引、不注入、工具会告诉模型去联网搜）');
    return;
  }
  buildIndex({ reason: 'activate' });
  startWatch();
}

export function deactivate() {
  stopWatch();
  log('已停止监听知识库目录（禁用/重载时调用，不会留下幽灵监听）');
}

/**
 * 同步返回：没有资料也算"可用"，只是查不到东西（工具会如实说明）。
 *
 * 另外顺手把目录路径注入设置界面 —— 时机是这里而不是 setup()：
 *   · setup 跑在"新实例注册"**之前**，此刻 registry 里是旧实例（热重载时）
 *     或空（首次加载），改它的 manifest 会被随后的 register 覆盖掉；
 *   · available() 是生命周期函数，由 isActive() 在 status / getPromptSections
 *     等路径上调用，那时本实例**已经注册**，改的就是界面真正读的那个对象。
 * 注入是幂等的（每次写同样的两个键），所以反复调用没有副作用。
 */
export function available() {
  exposePathsInSettings();
  return true;
}

/** 能力接口：技能通过 api.capability(...) 取用。 */
export const providers = {
  /** 检索本地知识库。 */
  'knowledge.search': (args = {}) => {
    const s = settings();
    const action = str(args.action, 'search').toLowerCase();
    if (action === 'status') return status();
    if (action === 'read') return readSection(args.ref || args.query);
    if (action === 'rebuild') return buildIndex({ reason: 'manual' });
    return search(args.query || args.q || '', {
      limit: num(args.limit, 5),
      minScore: args.minScore === undefined ? null : num(args.minScore, s.minScore),
      snippetChars: num(args.snippetChars, s.snippetChars)
    });
  },
  /** 把搜到的知识存回本地库。 */
  'knowledge.write': (args = {}) => remember({
    title: args.title,
    content: args.content,
    source: args.source,
    tags: args.tags
  })
};

/**
 * 钩子：本轮对话带上知识库。
 *
 * index 模式 = 目录常驻 + 命中给详情（推荐）：目录只有十几行，命中才花大钱。
 * hit   模式 = 只给命中，最省，但模型可能想不起来用户有资料。
 * off   模式 = 什么都不给，全靠它自己调工具。
 */
export const hooks = {
  async 'before-llm-messages'(ctx = {}) {
    try {
      const s = settings();
      if (!s.enabled || s.injectMode === 'off') return;
      if (!state.sections.length) return;
      const messages = ctx.messages;
      if (!Array.isArray(messages) || !messages.length) return;

      const text = lastUserText(messages);
      const parts = [];

      if (s.injectMode === 'index') {
        const idx = buildIndexBlock(s);
        if (idx) parts.push(idx);
      }

      if (text) {
        const res = search(text, { limit: s.hitLimit, snippetChars: s.hitMaxChars });
        if (res.hits?.length) {
          const block = buildHitBlock(res.hits, s);
          if (block) parts.push(block);
        }
      }

      if (!parts.length) return;
      appendToTail(messages, parts.join('\n\n'));
    } catch (error) {
      // 注入失败绝不影响正常回话
      warn(`知识库注入失败（不影响回话）：${error?.message ?? error}`);
    }
  }
};

/** 测试/排障用导出。 */
export const __internals = {
  state, settings, KB_DIR, LEARNED_DIR, INDEX_FILE,
  decodeTextBuffer, splitSections, tokenize, search, readSection, remember,
  buildIndex, scheduleRebuild, excerptAround, safeFileName, walkFiles
};
