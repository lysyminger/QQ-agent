// 收件箱（qq-file-intake）纯逻辑：不碰 IO、不碰配置，测试直接驱动这些函数。
//
// 为什么单独成文件：下载/搬移/入库全是"做完就落盘"的动作，真机上一次跑错的代价
// 是「主人的文件被搬到别处」或「微信原件被删」—— 这种地方必须能离线把判定钉住。
// 所以凡是"看一眼就知道对不对"的判断（文件名清洗、类型分类、去重键、搬移时机、
// 收件箱清单解析）都写在这里，IO 那一层只负责把字节搬来搬去。

import crypto from 'node:crypto';

/* ══════════════════════════════════════════════════════════════════════
   一、从聊天文本里认出"这条消息带了文件"
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 核心把 file 段渲染成 `[文件xxx.pdf]`（src/onebot.js 的 segmentsToText），
 * 存进聊天存档的就是这串文本 —— 这也是插件唯一能"确定性"看到文件消息的地方
 * （消息里的 media[] 只收 image/video/face，file 段被丢掉）。
 */
export const FILE_MARKER_RE = /\[文件\s*([^\]]*?)\s*\]/g;

/**
 * 从一条消息的文本里取出所有文件名。
 * @returns {Array<{name:string}>} 无名占位（`[文件]`）会被丢掉，因为无从解析
 */
export function parseFileMarkers(text) {
  const src = String(text ?? '');
  const out = [];
  FILE_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = FILE_MARKER_RE.exec(src)) !== null) {
    const name = String(m[1] ?? '').trim();
    if (name) out.push({ name });
  }
  return out;
}

/** 文本里是否出现过"没带文件名的文件段"（`[文件]`）—— 有的话只能给一句解释。 */
export function hasNamelessFileMarker(text) {
  const src = String(text ?? '');
  FILE_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = FILE_MARKER_RE.exec(src)) !== null) {
    if (!String(m[1] ?? '').trim()) return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════
   二、文件名清洗与分类
   ══════════════════════════════════════════════════════════════════════ */

/** Windows 非法字符 + 控制字符 + 路径分隔符，一律换成下划线。 */
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Windows 保留设备名（不带扩展名时不能当文件名）。 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/** 只留路径的最后一段（`a/b/c.txt` → `c.txt`；正反斜杠都算分隔符）。 */
export function lastSegment(name) {
  const parts = String(name ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * 把 QQ/微信给的文件名洗成能安全落盘的名字。
 *
 * ⚠️ 两件必须做的事（顺序都不能换）：
 *   ① **先**取路径的最后一段，**再**洗非法字符 —— 反了的话 `..\..\启动项.bat` 里的
 *      反斜杠会先被换成下划线，于是整串变成一个"合法"文件名 `.._.._启动项.bat`，
 *      路径穿越没挡住，反而多出一个怪名字（离线自测就是照这个抓出来的）。
 *   ② 掐长度 —— 中文名 + 长标题很容易超过 255 字符的路径上限，写入直接失败；
 *      这里按 110 字符截断并保留扩展名。
 */
export function sanitizeFileName(raw, fallback = '文件') {
  let s = lastSegment(raw);
  s = s.replace(ILLEGAL_CHARS, '_');
  // 末尾的点和空格在 Windows 上会被静默吃掉，先处理掉免得下游对不上名字
  s = s.replace(/[\s.]+$/g, '').replace(/^\s+/g, '');
  if (!s) s = fallback;
  const ext = extOf(s);
  const baseRaw = ext ? s.slice(0, s.length - ext.length) : s;
  let base = baseRaw.slice(0, 110) || fallback;
  // Windows 的保留设备名（con/nul/com1…）**带扩展名也算**：`NUL.txt` 同样建不出来
  if (RESERVED.has(base.toLowerCase())) base = `_${base}`;
  const out = `${base}${ext}`;
  return out || fallback;
}

/** 扩展名（小写、带点）；没有扩展名返回 ''。 */
export function extOf(name) {
  const s = String(name ?? '');
  const i = s.lastIndexOf('.');
  if (i <= 0 || i === s.length - 1) return '';
  const ext = s.slice(i);
  return /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '';
}

/** 去掉扩展名的主体（先用最后一段，带路径的输入也不会把目录名算进主体）。 */
export function baseOf(name) {
  const s = lastSegment(name);
  const ext = extOf(s);
  return ext ? s.slice(0, s.length - ext.length) : s;
}

/** 原样就能当纯文本读的（知识库里直接索引这些后缀）。 */
export const TEXT_AS_IS = new Set(['.txt', '.md', '.markdown']);
/** 需要读成文本再包一层 md 的（本身是文本，但知识库不认这些后缀）。 */
export const TEXT_EXTRACT = new Set([
  '.csv', '.tsv', '.json', '.log', '.xml', '.yml', '.yaml', '.ini', '.conf',
  '.srt', '.vtt', '.html', '.htm', '.py', '.js', '.mjs', '.cjs', '.ts', '.tex',
  '.sql', '.rst', '.java', '.c', '.cpp', '.h', '.go', '.rs'
]);
/** 需要真解析器（技能 read-document 里那套）的文档。 */
export const DOC_EXTRACT = new Set(['.pdf', '.docx', '.pptx']);
/** 老二进制格式：抽不出正文，只能让用户另存为。 */
export const LEGACY_DOC = new Set(['.doc', '.ppt']);

/**
 * 文件分类：documents 技能能不能读、能不能进知识库。
 * @returns {{kind:'text'|'doc'|'legacy'|'other', ext:string, readable:boolean, ingestible:boolean}}
 */
export function classifyFile(name) {
  const ext = extOf(name);
  if (TEXT_AS_IS.has(ext) || TEXT_EXTRACT.has(ext)) {
    return { kind: 'text', ext, readable: true, ingestible: true };
  }
  if (DOC_EXTRACT.has(ext)) {
    return { kind: 'doc', ext, readable: true, ingestible: true };
  }
  if (LEGACY_DOC.has(ext)) {
    return { kind: 'legacy', ext, readable: false, ingestible: false };
  }
  return { kind: 'other', ext, readable: false, ingestible: false };
}

/** 收件箱（尤其是微信那一路）要不要接这个文件。 */
export function wxExtAllowed(name, exts) {
  const raw = String(exts ?? '').trim();
  if (!raw || raw === '*') return true;
  const list = raw.split(/[,，;；\s]+/).map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  if (!list.length) return true;
  const ext = extOf(name).replace(/^\./, '');
  if (!ext) return false;
  return list.includes(ext);
}

/* ══════════════════════════════════════════════════════════════════════
   三、去重键 / 唯一名 / 展示小工具
   ══════════════════════════════════════════════════════════════════════ */

/** QQ 侧去重键：一个会话里一条消息只会处理一次（同一条消息刷几轮都算同一件事）。 */
export function qqStateKey(chatKey, mid) {
  return `${String(chatKey ?? '')}|${String(mid ?? '')}`;
}

/** 微信侧去重键：源路径 + 大小 + mtime —— 内容没变就不会重复搬。 */
export function wxStateKey(srcPath, size, mtimeMs) {
  return crypto.createHash('sha1')
    .update(`${srcPath}|${Number(size) || 0}|${Math.round(Number(mtimeMs) || 0)}`)
    .digest('hex').slice(0, 20);
}

/**
 * 目标目录里挑一个不撞车的文件名：`报告.pdf` → `报告 (2).pdf` → `报告 (3).pdf`。
 * exists 由调用方注入（测试里给假函数，真机给 fs.existsSync）。
 */
export function uniqueNameIn(dir, name, exists = () => false, maxTry = 200) {
  const safe = sanitizeFileName(name);
  const sep = dir && !/[\\/]$/.test(String(dir)) ? (String(dir).includes('\\') ? '\\' : '/') : '';
  const join = (n) => `${dir}${sep}${n}`;
  if (!exists(join(safe))) return safe;
  const ext = extOf(safe);
  const base = ext ? safe.slice(0, safe.length - ext.length) : safe;
  for (let i = 2; i <= maxTry; i += 1) {
    const cand = `${base} (${i})${ext}`;
    if (!exists(join(cand))) return cand;
  }
  return `${base} (${Date.now()})${ext}`;
}

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function clip(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 相对路径统一成 `qq/xxx.pdf` 这种正斜杠写法（提示词与回执里都用它）。 */
export function relPosix(from, to) {
  const a = String(from ?? '').replace(/[\\/]+$/, '');
  const b = String(to ?? '');
  if (!a) return String(b).replace(/\\/g, '/');
  const rel = b.startsWith(a) ? b.slice(a.length).replace(/^[\\/]+/, '') : b;
  return rel.replace(/\\/g, '/');
}

/* ══════════════════════════════════════════════════════════════════════
   四、微信目录扫描的判定
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 这个微信目录项现在能不能搬？
 *
 * @param {{name:string,size:number,mtimeMs:number}} entry
 * @param {object} o
 *   now        当前时间
 *   minAgeMs   文件至少"安静"这么久（下载中的文件大小还在变）
 *   since      只搬这个时间之后改动的文件（0 = 不限）
 *   exts       允许的扩展名串
 *   known      已处理过的去重键集合（Set）
 *   srcPath    源文件绝对路径（算去重键用）
 * @returns {{ok:boolean, key?:string, reason?:string}}
 */
export function wxCandidateVerdict(entry, o = {}) {
  const name = String(entry?.name ?? '');
  const size = Number(entry?.size) || 0;
  const mtimeMs = Number(entry?.mtimeMs) || 0;
  const now = Number(o.now) || Date.now();
  const minAgeMs = Math.max(0, Number(o.minAgeMs) || 0);
  const since = Number(o.since) || 0;

  if (!name || name.startsWith('.')) return { ok: false, reason: '隐藏/无名文件' };
  if (size <= 0) return { ok: false, reason: '空文件' };
  if (minAgeMs && now - mtimeMs < minAgeMs) return { ok: false, reason: '文件还在写（太新）' };
  if (since && mtimeMs <= since) return { ok: false, reason: '早于本次关注的时间点' };
  if (!wxExtAllowed(name, o.exts)) return { ok: false, reason: '不在允许的类型里' };

  const key = wxStateKey(String(o.srcPath ?? entry?.file ?? ''), size, mtimeMs);
  if (o.known && typeof o.known.has === 'function' && o.known.has(key)) {
    return { ok: false, reason: '已经处理过' };
  }
  return { ok: true, key };
}

/**
 * 微信目录结构：`<root>/<wxid>/msg/file/<YYYY-MM>/xxx.docx`。
 * 从一个候选路径里认出"账号目录 + 月份"——排障时要能看懂文件是哪一年的存档。
 */
export function parseWxPath(absPath) {
  const parts = String(absPath ?? '').split(/[\\/]+/).filter(Boolean);
  const i = parts.lastIndexOf('file');
  const out = { account: '', month: '', name: parts[parts.length - 1] || '' };
  if (i >= 2 && parts[i - 1] === 'msg') out.account = parts[i - 2];
  if (i >= 1 && /^\d{4}-\d{2}$/.test(parts[i + 1] || '')) out.month = parts[i + 1];
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
   五、知识库落地文本
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 生成进知识库的 md：头部写清"从哪来、什么时候、原文件名"，正文是抽出来的文本。
 *
 * 头部的必要性：知识库检索命中的是"段落"，模型看到正文却不知道这是谁给的东西 ——
 * 写上来源它能说出"你 10 月 3 号发的那份材料里说…"，而不是含糊地"资料显示"。
 */
export function renderKbMarkdown({ name, source = 'QQ', atText = '', text = '', note = '' } = {}) {
  const head = [
    `# ${baseOf(name) || name}`,
    '',
    `> 来源：${source}｜原文件名：${name}｜入库时间：${atText}${note ? `｜备注：${note}` : ''}`,
    ''
  ].join('\n');
  return `${head}\n${String(text ?? '').trim()}\n`;
}

/* ══════════════════════════════════════════════════════════════════════
   六、口令参数解析
   ══════════════════════════════════════════════════════════════════════ */

/**
 * `\入库 综测文档说明.docx` → { raw:'综测文档说明.docx', all:false, list:false }
 * `\入库`（不给名字）→ { raw:'', list:true }
 * `\入库 全部` → { raw:'', all:true }
 */
export function parseIngestArgs(args) {
  const raw = String(args ?? '').trim();
  if (!raw) return { raw: '', all: false, list: true };
  if (/^(全部|所有|all)$/i.test(raw)) return { raw: '', all: true, list: false };
  return { raw, all: false, list: false };
}

/** 用户给的名字与文件名是否算匹配（精确 > 去扩展名 > 包含）。 */
export function nameMatchScore(needle, candidate) {
  const a = String(needle ?? '').trim().toLowerCase();
  const b = String(candidate ?? '').trim().toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (baseOf(a) === baseOf(b)) return 90;
  if (b.includes(a)) return 60 + Math.min(20, a.length);
  if (a.includes(baseOf(b))) return 40;
  return 0;
}

/**
 * 从一堆候选里挑最匹配的那个；并列时给上层"说不清"的信号。
 * @returns {{pick:any|null, ties:any[]}}
 */
export function pickBestByName(needle, candidates, nameOf = (x) => x?.name) {
  const scored = (candidates || [])
    .map((c) => ({ c, score: nameMatchScore(needle, nameOf(c)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { pick: null, ties: [] };
  const top = scored[0].score;
  const ties = scored.filter((x) => x.score === top).map((x) => x.c);
  return { pick: ties.length === 1 ? ties[0] : null, ties };
}
