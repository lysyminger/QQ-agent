// 收件箱的文件搬运（真机 IO）。
//
// 目录布局（都在「文档文件夹」下，和 skills/read-document 的默认目录一致）：
//   <文档文件夹>/qq/        QQ 里发来的文件（从腾讯服务器下载下来的落在这一层，
//                           文件名的模糊匹配 / doc_list 都能直接看到它们）
//   <文档文件夹>/wx/        微信收到的文件（**剪切**搬过来）
//   <文档文件夹>/已入库/    已经抽进知识库的原件（从收件箱移走，保留原件备查）
//
// 为什么 QQ 的文件不按日期分子目录：doc_read(name="xxx.pdf") 是**在文档文件夹里
// 按名字找**的，套一层日期目录会变成"用户说了文件名也找不到"。收件箱里文件名撞车
// 由 uniqueNameIn 加 (2) 后缀解决。

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeFileName, uniqueNameIn, extOf, classifyFile, relPosix, renderKbMarkdown } from './logic.js';

export const SUBDIR_QQ = 'qq';
export const SUBDIR_WX = 'wx';
export const SUBDIR_ARCHIVED = '已入库';

export function ensureInbox(documentsDir) {
  const root = path.resolve(String(documentsDir || '.'));
  const dirs = {
    root,
    qq: path.join(root, SUBDIR_QQ),
    wx: path.join(root, SUBDIR_WX),
    archived: path.join(root, SUBDIR_ARCHIVED)
  };
  for (const d of [dirs.qq, dirs.wx, dirs.archived]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  }
  return dirs;
}

/** 目标目录里挑个不撞车的名字（exists 给 trace 用，测试可注入）。 */
export function pickFreeName(dir, name) {
  return uniqueNameIn(dir, name, (p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

/** 把一段字节写进收件目录（自动改名避让）。 */
export function writeIntoInbox(dir, rawName, buffer) {
  const name = pickFreeName(dir, sanitizeFileName(rawName));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return { file, name, bytes: buffer.length };
}

/** 把一个本地文件**剪切**进去（先复制、校验大小、再删源）。 */
export function moveIntoInbox(dir, srcFile, rawName = '') {
  const src = path.resolve(String(srcFile));
  const stat = fs.statSync(src);
  const name = pickFreeName(dir, sanitizeFileName(rawName || path.basename(src)));
  const dest = path.join(dir, name);
  fs.copyFileSync(src, dest);
  const copied = fs.statSync(dest);
  if (copied.size !== stat.size) {
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    throw new Error(`复制后大小不一致（源 ${stat.size} / 目标 ${copied.size}），已放弃搬移`);
  }
  removeSource(src);
  return { file: dest, name, bytes: copied.size };
}

/**
 * 删源文件。微信的接收文件带**只读属性**（实测 -ar---），直接 unlink 会失败
 * （EPERM），必须先清掉只读位 —— 这是"剪贴搬移"能不能真的搬走的关键一步。
 */
export function removeSource(src) {
  try {
    fs.chmodSync(src, 0o666);
  } catch { /* 清不掉就照 old 试删 */ }
  fs.rmSync(src, { force: true });
}

/** 收件箱里的文件（qq + wx 两层，不含「已入库」）。 */
export function listInboxFiles(documentsDir, { limit = 200 } = {}) {
  const dirs = ensureInbox(documentsDir);
  const out = [];
  for (const [source, dir] of [['qq', dirs.qq], ['wx', dirs.wx]]) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      let st;
      try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
      out.push({
        source,
        name: e.name,
        file: path.join(dir, e.name),
        rel: relPosix(dirs.root, path.join(dir, e.name)),
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind: classifyFile(e.name).kind
      });
    }
  }
  out.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return out.slice(0, Math.max(1, limit));
}

/** 把文件从收件区移进「已入库」（同一磁盘内的 rename，失败再退回复制+删源）。 */
export function archiveOriginal(file, documentsDir) {
  const dirs = ensureInbox(documentsDir);
  const name = pickFreeName(dirs.archived, sanitizeFileName(path.basename(file)));
  const dest = path.join(dirs.archived, name);
  try {
    fs.renameSync(file, dest);
  } catch {
    fs.copyFileSync(file, dest);
    removeSource(file);
  }
  return dest;
}

/**
 * 入库：把一份文件变成"知识库能检索的 md（或原样 txt/md）"。
 *
 * 两条款式（都由调用方确认过类型）：
 *   · txt / md / markdown —— **剪切**原件到知识库根目录，沿用原文件名。
 *     知识库自己只认 .txt/.md/.markdown，所以这类不需要包一层 md（也就不会多一份副本）。
 *   · pdf / docx / pptx 以及 csv/json/log 这类纯文本 —— 调 extract() 抽正文，
 *     写成 `<原名>.md` 放进知识库；**原件不进知识库**，而是从收件箱移进「已入库」。
 *
 * 为什么原件不留在收件箱：主人点名要"移动采用剪贴"，即入库后收件箱里不留重复副本；
 * 原件仍完整保留在「已入库」，只是为了"知识库里不该躺着二进制文件"才另放一层。
 *
 * @param {object} o
 *   file        要入库的文件绝对路径
 *   name        文件名（默认取 basename）
 *   source      'QQ' | '微信' 之类，写进 md 头部
 *   documentsDir 文档文件夹（收件箱根）
 *   kbDir       知识库根目录
 *   extract     async (file) => ({ text, note } | null) —— 抽取正文（doc/docx/pdf 用）
 *   nowText     入库时间文案
 *   keepOriginalFile  true = 只复制进知识库、原件留在原地（默认 false = 剪切）
 * @returns {Promise<{ok:boolean, target?:string, chars?:number, removedSource?:boolean, reason?:string}>}
 */
export async function ingestFile(o = {}) {
  const file = path.resolve(String(o.file || ''));
  const name = String(o.name || path.basename(file));
  const documentsDir = o.documentsDir;
  const kbDir = path.resolve(String(o.kbDir || ''));
  if (!file || !fs.existsSync(file)) return { ok: false, reason: `找不到文件：${file}` };

  const cls = classifyFile(name);
  if (!cls.ingestible) {
    const why = cls.kind === 'legacy'
      ? '旧版 .doc/.ppt 是二进制老格式，抽不出正文，请在 Office 里另存为 .docx/.pptx 再入库'
      : `这个类型（${cls.ext || '无扩展名'}）知识库读不了，只有文本 / PDF / Word / PPT 能入库`;
    return { ok: false, reason: why };
  }

  fs.mkdirSync(kbDir, { recursive: true });

  // ── 一、原样就是知识库认识的文本：剪切过去 ────────────────────────────
  if (cls.kind === 'text' && /^\.(txt|md|markdown)$/.test(cls.ext)) {
    const target = path.join(kbDir, pickFreeName(kbDir, name));
    try {
      fs.renameSync(file, target);
    } catch {
      fs.copyFileSync(file, target);
      removeSource(file);
    }
    return { ok: true, target, chars: null, removedSource: true, mode: 'moved' };
  }

  // ── 二、其余：抽正文 → 写成 md ────────────────────────────────────────
  let text = '';
  let note = '';
  try {
    const got = await o.extract?.(file);
    if (typeof got === 'string') text = got;
    else if (got && typeof got === 'object') { text = String(got.text || ''); note = String(got.note || ''); }
  } catch (error) {
    return { ok: false, reason: `抽正文失败：${error?.message ?? error}` };
  }
  text = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!text) {
    return {
      ok: false,
      reason: cls.ext === '.pdf'
        ? '这份 PDF 里没有可提取的文字（很可能是扫描件/图片型），本机不带 OCR，没法入库'
        : '这份文件里没找到正文文字，没入库'
    };
  }

  const mdName = pickFreeName(kbDir, `${name.replace(extOf(name), '') || name}.md`);
  const target = path.join(kbDir, mdName);
  fs.writeFileSync(target, renderKbMarkdown({
    name, source: o.source || 'QQ', atText: o.nowText || '', text, note
  }), 'utf8');

  let removedSource = false;
  try {
    if (o.keepOriginalFile === true) {
      removedSource = false;
    } else {
      archiveOriginal(file, documentsDir);
      removedSource = true;
    }
  } catch { /* 原件没搬走不影响入库本身 */ }

  return { ok: true, target, chars: text.length, removedSource, mode: 'extracted', note };
}
