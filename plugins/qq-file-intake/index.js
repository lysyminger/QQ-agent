// 收件箱（qq-file-intake）：让机器人能读「别人通过 QQ / 微信发来的文件」。
//
// ══════════════════════════════════════════════════════════════════════
// 解决的原始问题
// ══════════════════════════════════════════════════════════════════════
// 以前有人在 QQ 里给机器人发一个 PDF / Word，机器人只能看到聊天存档里的一行
// `[文件综测文档说明.docx]` —— 正文在腾讯服务器上，直链过一阵就失效；
// 而「文档阅读」技能（skills/read-document）只翻本机文档文件夹，两边根本接不上：
// 用户说「读一下我刚发的文件」，机器人要么装傻，要么编。
//
// 本插件把这一环补上：**文件一到就立刻下载/搬进机器人能读的两个目录**
//   文档文件夹/qq/   ← QQ 里发来的（默认只认主人）
//   文档文件夹/wx/   ← 微信收到的（剪贴搬移）
// 落盘之后 doc_list / doc_read 直接可用，不需要模型做任何额外动作。
//
// ══════════════════════════════════════════════════════════════════════
// 关键设计（都是真机踩出来的，别改回去）
// ══════════════════════════════════════════════════════════════════════
// ① **只在文件到达的那一轮同步等一小会儿**（syncWaitMs=8s）：下完再回话，
//    机器人当场就能读；超时转后台继续下，绝不让一个大文件把回复卡成几十秒
//    （超时那份会在下一轮补上提示，见 ⑦）。
// ② **下载先落临时文件再改名**：失败时收件箱里不会留半截文件被当成"已下载"。
// ③ **微信文件必须等它"安静"够久**（wxMinAgeSec=20s）：微信边下边写，
//    抢在下到一半时剪贴搬走 = 搬走半截文件、原件也没了，不可逆。
// ④ **微信只搬文档类型**（默认白名单）：那个目录里还躺着网友发的 zip/exe/游戏包。
// ⑤ **微信只处理"装插件之后"的新文件**（state.wxArmedAt）：否则第一次跑就把
//    过去几个月的几百个文件全搬走 —— 那是灾难不是功能。
// ⑥ **入库是主人专属口令 + 剪贴**：默认文件只进文档文件夹（不污染知识库）；
//    主人 `\入库 文件名` 才抽正文写进 knowledge-base；原件从收件箱移进「已入库」，
//    收件箱里不留重复副本。
// ⑦ **提示只贴一次**（state.hinted）：提示走"追加到最后一条 user 消息尾部"，
//    每轮都贴会把前缀缓存废掉（这条经验来自 conversation-memory 的踩坑）。
//
// 成本：判定全在本地（钩子里没有任何模型调用），下载/搬移是纯 IO —— 0 token。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_DIR, getConfig } from '../../src/config.js';

const ID = 'qq-file-intake';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.join(HERE, 'lib');

/**
 * 加载同目录 lib/*.js。
 *
 * ⚠️ 必须给 import URL 带上**该文件自己的 mtime+size**：核心热重载只给入口
 * index.js 加时间戳（plugin-loader `import(entryUrl?t=Date.now())`），lib 会命中
 * 模块缓存 —— 改了 lib 不生效，还会出现"新入口 + 旧 lib"的幽灵组合。
 * （这条经验是 qzone-diary 踩出来的，这里照抄。）
 */
let libCache = new Map();
async function lib(name) {
  let tag = 'v0';
  try {
    const st = fs.statSync(path.join(LIB_DIR, name));
    tag = `v${Math.round(st.mtimeMs).toString(36)}x${st.size.toString(36)}`;
  } catch { /* 读不到就用 v0，import 自己会报错 */ }
  const key = `${name}?${tag}`;
  if (!libCache.has(key)) libCache.set(key, import(`./lib/${name}?${tag}`));
  return libCache.get(key);
}

/** 应用根目录（含 src/ 与 skills/ 的那一层）。 */
function appRoot() {
  const candidates = [];
  try { if (globalThis.__qqAgentRoot) candidates.push(globalThis.__qqAgentRoot); } catch { /* ignore */ }
  try { candidates.push(path.resolve(HERE, '..', '..')); } catch { /* ignore */ }
  try { candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app')); } catch { /* ignore */ }
  for (const c of candidates) {
    try { if (c && fs.existsSync(path.join(c, 'src', 'config.js'))) return c; } catch { /* ignore */ }
  }
  return '';
}

/** 给绝对路径的模块拼一个"文件改了 URL 就变"的标签（防模块缓存）。 */
function fileTag(file) {
  try {
    const st = fs.statSync(file);
    return `v${Math.round(st.mtimeMs).toString(36)}x${st.size.toString(36)}`;
  } catch {
    return 'v0';
  }
}

// ── 日志（插件 stdout 在真机上看不见，所以自己也落一份盘）──────────────
let apiRef = null;
function logLine(kind, msg) {
  const line = `[${kind}] ${msg}`;
  try { apiRef?.log?.(line); } catch { /* ignore */ }
  try {
    const dir = path.join(DATA_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${ID}.log`);
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch { /* 没有就新建 */ }
    fs.appendFileSync(file, `${new Date().toLocaleString('zh-CN', { hour12: false })} ${line}\n`, 'utf8');
  } catch { /* 日志失败不影响功能 */ }
}
const log = (m) => logLine('收件箱', m);
const warn = (m) => logLine('收件箱⚠️', m);

const DEFAULTS = {
  enabled: true,
  takeQQ: true,
  takeWx: true,
  onlyOwner: true,
  documentsDir: '',
  maxFileMB: 60,
  syncWaitMs: 8000,
  maxFilesPerRun: 3,
  hintInPrompt: true,
  autoIngestOwner: false,
  wxRoots: '',
  // 白名单里的 zip：主人 2026-10-04 明确要求「允许搬走 zip」。
  // ⚠️ 仍然不含 exe / 图片 / 视频 —— 那个目录里躺着网友发的安装包。
  wxExts: 'pdf,doc,docx,ppt,pptx,xls,xlsx,txt,md,csv,json,rtf,odt,wps,zip',
  wxReceipt: true,
  receiptTo: '',
  wxMoveMode: 'cut',
  wxScanMinutes: 3,
  wxMinAgeSec: 20,
  wxBackfillDays: 0,
  logKeepDays: 14,
  ingestMaxPerCall: 10
};

let cfgFn = () => ({});
function settings() {
  let raw = {};
  try { raw = cfgFn?.() || {}; } catch { raw = {}; }
  const s = { ...DEFAULTS, ...raw };
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.max(lo, Math.min(hi, n));
  };
  s.maxFileMB = num(s.maxFileMB, DEFAULTS.maxFileMB, 1, 1024);
  s.syncWaitMs = num(s.syncWaitMs, DEFAULTS.syncWaitMs, 0, 60000);
  s.maxFilesPerRun = num(s.maxFilesPerRun, DEFAULTS.maxFilesPerRun, 1, 20);
  s.wxScanMinutes = num(s.wxScanMinutes, DEFAULTS.wxScanMinutes, 1, 240);
  s.wxMinAgeSec = num(s.wxMinAgeSec, DEFAULTS.wxMinAgeSec, 0, 600);
  s.wxBackfillDays = num(s.wxBackfillDays, DEFAULTS.wxBackfillDays, 0, 365);
  s.logKeepDays = num(s.logKeepDays, DEFAULTS.logKeepDays, 1, 365);
  s.ingestMaxPerCall = DEFAULTS.ingestMaxPerCall;
  s.wxMoveMode = String(s.wxMoveMode || 'cut') === 'copy' ? 'copy' : 'cut';
  // 回执单：只有显式 false 才关（设置页里默认是开的）
  s.wxReceipt = raw.wxReceipt !== false;
  s.receiptTo = String(s.receiptTo ?? '').trim();
  return s;
}

function documentsDirOf(s = settings()) {
  const raw = String(s.documentsDir || '').trim();
  return raw ? path.resolve(raw) : path.join(DATA_DIR, 'documents');
}
const kbDirOf = () => path.join(DATA_DIR, 'knowledge-base');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════════════
   装载：lib 模块 + 状态
   ══════════════════════════════════════════════════════════════════════ */

let mods = null;
let st = null;
let bootPromise = null;
/** chatKey -> 待贴给模型的提示条目 */
const hintQueue = new Map();
/** 正在处理的 QQ 文件（key），避免同一轮重复排队 */
const inflight = new Set();

async function boot() {
  if (!mods) {
    if (!bootPromise) {
      bootPromise = (async () => {
        const [logic, stateMod, files, qq, wx] = await Promise.all([
          lib('logic.js'), lib('state.js'), lib('files.js'), lib('qq.js'), lib('wx.js')
        ]);
        return { logic, state: stateMod, files, qq, wx };
      })().finally(() => { bootPromise = null; });
    }
    mods = await bootPromise;
  }
  if (!st) st = mods.state.createState(path.join(DATA_DIR, ID, 'state.json'));
  return mods;
}

/* ══════════════════════════════════════════════════════════════════════
   主人判定（能力 message.owner-check，只按 QQ 号说话）
   ══════════════════════════════════════════════════════════════════════ */

export function isOwnerId(userId) {
  const id = String(userId ?? '').trim();
  if (!id) return false;
  try {
    return apiRef?.capability?.('message.owner-check', { userId: id })?.isOwner === true;
  } catch {
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   QQ 侧：文件一到就下载
   ══════════════════════════════════════════════════════════════════════ */

/** 核心 safe-fetch 的流式落盘下载器（大文件不占内存）。 */
async function loadFetchToFile() {
  const root = appRoot();
  if (!root) return null;
  try {
    const file = path.join(root, 'src', 'safe-fetch.js');
    const mod = await import(`${pathToFileURL(file).href}?${fileTag(file)}`);
    return typeof mod.safeFetchBinaryToFile === 'function' ? mod.safeFetchBinaryToFile : null;
  } catch (error) {
    warn(`拿不到下载器：${error?.message ?? error}`);
    return null;
  }
}

/** 「文档阅读」技能模块（复用它的 PDF / docx / pptx 解析器）。 */
async function loadReadDocument() {
  const root = appRoot();
  if (!root) return null;
  try {
    const file = path.join(root, 'skills', 'read-document', 'index.js');
    if (!fs.existsSync(file)) return null;
    return await import(`${pathToFileURL(file).href}?${fileTag(file)}`);
  } catch (error) {
    warn(`拿不到文档解析器：${error?.message ?? error}`);
    return null;
  }
}

/** 纯文本读取（BOM / UTF-16 / GB18030 兜底 —— 国内老文件常见 GBK）。 */
export function readTextFile(file) {
  const buf = fs.readFileSync(file);
  if (!buf.length) return '';
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gb18030').decode(buf); } catch { return buf.toString('utf8'); }
  }
}

/** 入库用的正文抽取：文档走 read-document 的解析器，其余当纯文本读。 */
async function extractTextForIngest(file, cls) {
  if (cls.kind === 'doc') {
    const skill = await loadReadDocument();
    if (!skill || typeof skill.parseDocumentText !== 'function') {
      throw new Error('文档解析器不可用（skills/read-document 没加载？）');
    }
    const r = await skill.parseDocumentText(file, { maxPages: 120 });
    return { text: String(r?.text || ''), note: String(r?.note || '') };
  }
  return { text: readTextFile(file), note: '' };
}

/** 把一个文件送进知识库（剪贴：原件从收件箱移进「已入库」）。 */
async function ingestPath(file, o = {}) {
  await boot();
  const s = settings();
  const name = String(o.name || path.basename(file));
  const cls = mods.logic.classifyFile(name);
  try {
    return await mods.files.ingestFile({
      file,
      name,
      source: o.source || 'QQ',
      documentsDir: documentsDirOf(s),
      kbDir: kbDirOf(),
      extract: (f) => extractTextForIngest(f, cls),
      nowText: new Date().toLocaleString('zh-CN', { hour12: false })
    });
  } catch (error) {
    return { ok: false, reason: `入库出错：${error?.message ?? error}` };
  }
}

/**
 * 下载一条消息里的文件并落进收件箱。
 * 任何一步失败都只记日志 —— 绝不能因为"文件没下下来"打断机器人回话。
 */
async function takeQqFile({ ctx, chatKey, kind, chatId, entry, name, reason = 'arrival' }) {
  await boot();
  const s = settings();
  const { logic, files, qq } = mods;
  const key = logic.qqStateKey(chatKey, entry?.mid);
  if (inflight.has(key)) return { ok: false, reason: '同一文件已在处理中' };

  let onebot = null;
  try {
    if (ctx?.onebot && typeof ctx.onebot.call === 'function') onebot = ctx.onebot;
  } catch { /* ignore */ }
  if (!onebot) {
    log(`没有 OneBot 通道，跳过：${name}`);
    return { ok: false, reason: '没有 OneBot 通道' };
  }

  inflight.add(key);
  try {
    const dirs = files.ensureInbox(documentsDirOf(s));
    const r = await qq.downloadMessageFile({
      onebot,
      kind,
      chatId,
      senderId: entry.senderId,
      mid: entry.mid,
      wantName: name,
      dir: dirs.qq,
      maxBytes: Math.round(s.maxFileMB * 1024 * 1024),
      timeoutMs: 45000,
      fetchToFile: await loadFetchToFile(),
      writeIntoInbox: files.writeIntoInbox,
      onWarn: (m) => warn(`QQ「${name}」：${m}`)
    });

    if (!r.ok) {
      st.qq[key] = {
        name, at: Date.now(), status: r.tooBig ? 'too-big' : 'failed',
        reason: String(r.reason || '').slice(0, 200)
      };
      st.touch(0);
      log(`QQ 文件未取到（${reason}）：${name} —— ${r.reason}`);
      return r;
    }

    const cls = logic.classifyFile(r.name);
    st.qq[key] = {
      name: r.name, path: r.file, bytes: r.bytes, at: Date.now(), status: 'ok',
      senderId: String(entry?.senderId || ''), chatKey, readable: cls.readable
    };
    st.touch(0);
    log(`QQ 文件已收：${r.name}（${Math.round(r.bytes / 1024)}KB）→ ${r.file}`);
    queueHint(chatKey, {
      key, name: r.name, rel: logic.relPosix(dirs.root, r.file),
      size: r.bytes, readable: cls.readable, kind: cls.kind
    });

    if (s.autoIngestOwner && isOwnerId(entry?.senderId)) {
      const got = await ingestPath(r.file, { source: 'QQ', name: r.name, ctx });
      log(`自动入库：${r.name} → ${got.ok ? got.target : `未入库（${got.reason}）`}`);
      if (got.ok) markHintIngested(key);
    }
    return r;
  } catch (error) {
    warn(`下载出错：${name} —— ${error?.message ?? error}`);
    return { ok: false, reason: String(error?.message ?? error) };
  } finally {
    inflight.delete(key);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   给模型的提示（追加到最后一条 user 消息尾部，只贴一次）
   ══════════════════════════════════════════════════════════════════════ */

function queueHint(chatKey, item) {
  const list = hintQueue.get(chatKey) || [];
  if (!list.some((x) => x.key === item.key)) list.push(item);
  hintQueue.set(chatKey, list.slice(-5));
}

function markHintIngested(key) {
  for (const [ck, list] of hintQueue) {
    const rest = list.filter((x) => x.key !== key);
    if (rest.length) hintQueue.set(ck, rest);
    else hintQueue.delete(ck);
  }
}

/** 入库之后，同一个文件的"刚收到"提示就不该再贴了。 */
function markHintByName(name) {
  const target = String(name || '').trim();
  if (!target) return;
  for (const [ck, list] of hintQueue) {
    const rest = list.filter((x) => x.name !== target);
    if (rest.length) hintQueue.set(ck, rest);
    else hintQueue.delete(ck);
  }
}

export function buildHintText(items) {
  const list = (items || []).slice(0, 5);
  if (!list.length) return '';
  const parts = list.map((h) => {
    const sizeText = h.size ? `，${mods ? mods.logic.humanSize(h.size) : `${h.size}B`}` : '';
    const tail = h.readable === false ? '，读不了正文（压缩包之类的二进制）' : '';
    return `${h.rel}${sizeText}${tail}`;
  });
  return `[收件箱] 刚收到 ${list.length} 个文件，已经存好：${parts.join('；')}。`
    + '要看内容就用 doc_read(name="文件名")（不确定叫什么就先 doc_list）。'
    + '扫描件 / 旧版 .doc/.ppt 读不出来时，把工具给的原因如实说明，不要猜内容。';
}

function appendToTail(message, text) {
  if (!message) return false;
  const block = `\n\n${String(text).trim()}`;
  if (typeof message.content === 'string') {
    if (message.content.includes('[收件箱]')) return false;
    message.content += block;
    return true;
  }
  if (Array.isArray(message.content)) {
    const has = message.content.some((c) => typeof c?.text === 'string' && c.text.includes('[收件箱]'));
    if (has) return false;
    message.content.push({ type: 'text', text: block });
    return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════
   微信侧：目录监听 + 定时扫描 + 剪贴搬移
   ══════════════════════════════════════════════════════════════════════ */

let wxTimer = null;
let wxHandles = [];
let wxScanning = false;
let wxDebounce = null;
let wxMetaTimer = null;
let wxKickTimer = null;
let wxDirCache = { at: 0, dirs: [] };

async function wxDirs(force = false) {
  const s = settings();
  const now = Date.now();
  if (!force && wxDirCache.dirs.length && now - wxDirCache.at < 5 * 60000) return wxDirCache.dirs;
  wxDirCache = { at: now, dirs: mods.wx.discoverWxFileDirs(mods.wx.wxRootsFromSetting(s.wxRoots)) };
  return wxDirCache.dirs;
}

function armWxWatchers(dirs) {
  mods.wx.stopWxWatchers(wxHandles);
  wxHandles = mods.wx.startWxWatchers(dirs, () => scheduleWxScan('watch'));
}

/** 监听触发后的防抖：微信一次下载会连发好几个事件。 */
function scheduleWxScan(why) {
  if (wxDebounce) return;
  wxDebounce = setTimeout(() => {
    wxDebounce = null;
    wxScan(why).catch(() => {});
  }, 2500);
  wxDebounce.unref?.();
}

/** 扫一遍微信收件目录，把到齐的文件搬进收件箱。 */
async function wxScan(why = 'timer') {
  await boot();
  const s = settings();
  if (!s.enabled || !s.takeWx) return { moved: 0, skipped: 'disabled' };
  if (wxScanning) return { moved: 0, skipped: 'busy' };
  wxScanning = true;
  try {
    const { files, wx } = mods;
    const now = Date.now();
    if (!st.data.wxArmedAt) {
      st.data.wxArmedAt = now;
      st.touch(0);
      log('微信侧武装完成：只搬"此刻之后"收到的文件（想补历史把「微信往回补多少天」调大）');
    }
    const since = s.wxBackfillDays > 0 ? now - s.wxBackfillDays * 86400000 : (Number(st.data.wxArmedAt) || now);
    const dirs = await wxDirs();
    const out = files.ensureInbox(documentsDirOf(s));
    const known = new Set(Object.keys(st.wx));
    let moved = 0;
    /** 本轮搬走的文件 —— 攒完整轮再发**一张**回执单（一个文件一条消息会打爆主人私聊）。 */
    const movedItems = [];
    for (const d of dirs) {
      const entries = wx.scanWxFileDir(d.dir, { exts: s.wxExts });
      const movable = wx.pickWxMovable(entries, {
        now, minAgeMs: s.wxMinAgeSec * 1000, since, exts: s.wxExts, known
      });
      for (const c of movable) {
        try {
          const saved = s.wxMoveMode === 'copy'
            ? files.writeIntoInbox(out.wx, c.name, fs.readFileSync(c.file))
            : files.moveIntoInbox(out.wx, c.file, c.name);
          st.wx[c.key] = {
            name: saved.name, path: saved.file, bytes: saved.bytes, at: Date.now(),
            account: c.account, month: c.month, mode: s.wxMoveMode, src: c.file
          };
          known.add(c.key);
          moved += 1;
          movedItems.push({
            name: saved.name, bytes: saved.bytes, account: c.account, month: c.month, src: c.file
          });
          log(`微信文件已${s.wxMoveMode === 'copy' ? '复制' : '剪贴'}进收件箱：${saved.name}`
            + `（${Math.round(saved.bytes / 1024)}KB）← ${c.file}`);
          // ⚠️ 刻意**不自动入库**：微信那个目录里分不出"谁发的"，只有主人亲口
          //    `\入库 文件名` 才进知识库（见文件头 ⑥）。
        } catch (error) {
          warn(`微信文件搬移失败：${c.file} —— ${error?.message ?? error}`);
        }
      }
    }
    st.data.lastWxScanAt = now;
    st.touch();
    if (moved) log(`微信本轮搬了 ${moved} 个文件（触发：${why}）`);
    // 回执单：私聊主人一张。⚠️ 不 await、失败只记日志 —— 和「文件没下下来不能打断
    // 机器人回话」同一个取舍：回执是附赠品，绝不能因为它失败拖住扫描定时器。
    if (movedItems.length && s.wxReceipt) {
      sendWxReceipt(movedItems, { mode: s.wxMoveMode, why }).catch(() => {});
    }
    return { moved, dirs: dirs.length };
  } catch (error) {
    warn(`微信扫描出错：${error?.message ?? error}`);
    return { moved: 0, error: String(error?.message ?? error) };
  } finally {
    wxScanning = false;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   回执单：微信搬完私聊主人一张
   ══════════════════════════════════════════════════════════════════════
   为什么直接打 OneBot 的 HTTP 口，而不是拿 ctx.onebot：
   微信扫描是**定时器/文件监听**触发的，那一刻根本没有消息上下文（没有 ctx），
   所以拿不到 onebot 客户端。group-reports 的日报走的也是这条口（同一台机器上
   已经被验证可用），照抄它：连 api.fetch 都要"是真 fetch 才用"——没声明
   web_fetch 权限时 api.fetch 是个直接 reject 的桩，用它会让回执静默全灭。 */

/** 主人 QQ 名单解析：与 owner-identity / private-receipt 同口径，只认 5~12 位数字。 */
function parseOwnerIds(raw) {
  return [...new Set(
    String(raw ?? '')
      .split(/[,，、;；|\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{5,12}$/.test(s))
  )];
}

/** 主人显示名（owner-identity 技能里配置的显示名）。 */
function ownerDisplayName() {
  try { return String(getConfig()?.skills?.['owner-identity']?.displayName || '').trim(); }
  catch { return ''; }
}

/**
 * 回执发给谁：插件设置「回执发给谁」优先 → owner-identity 名单 → group-reports 的 ownerQq。
 * 三处都空就只写日志（出厂默认不把任何真实 QQ 写死进插件）。
 */
function receiptTarget() {
  const s = settings();
  const explicit = parseOwnerIds(s.receiptTo);
  if (explicit.length) return { id: explicit[0], from: '插件设置', name: ownerDisplayName() };
  let cfg = null;
  try { cfg = getConfig(); } catch { /* 读不到就走兜底 */ }
  const ids = parseOwnerIds(cfg?.skills?.['owner-identity']?.ids);
  if (ids.length) return { id: ids[0], from: 'owner-identity', name: ownerDisplayName() };
  const fb = parseOwnerIds(cfg?.skills?.['group-reports']?.ownerQq);
  if (fb.length) return { id: fb[0], from: 'group-reports', name: '' };
  return { id: '', from: '', name: '' };
}

function onebotEndpoint() {
  let cfg = null;
  try { cfg = getConfig(); } catch { /* 读不到就用默认本地口 */ }
  const httpUrl = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg?.snowluma?.httpAccessToken || cfg?.snowluma?.accessToken || '');
  return { httpUrl, token };
}

async function onebotCall(action, params = {}, timeoutMs = 10000) {
  const { httpUrl, token } = onebotEndpoint();
  const doFetch = (apiRef && typeof apiRef.fetch === 'function' && apiRef.fetch !== globalThis.fetch)
    ? apiRef.fetch : globalThis.fetch;
  const res = await doFetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`OneBot ${action} HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body.status !== 'ok' && body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败：retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
  }
  return body.data;
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  if (b >= 1024) return `${Math.round(b / 1024)}KB`;
  return `${b}B`;
}

/** 回执单正文（纯文本，列表最多列 MAX 条，多的折成一行）。 */
function buildWxReceipt(items, { mode = 'cut' } = {}) {
  const MAX = 8;
  const when = new Date().toLocaleString('zh-CN', { hour12: false });
  const cut = mode !== 'copy';
  const L = [];
  L.push('📥 微信收件箱 · 回执单');
  L.push('────────────────');
  L.push(`时间：${when}`);
  L.push(`模式：${cut ? '剪贴搬移（微信原件已移走）' : '复制（微信原件保留）'}`);
  L.push(`落点：文档文件夹/wx/`);
  L.push('');
  items.slice(0, MAX).forEach((it, i) => {
    L.push(`${i + 1}. ${it.name}`);
    L.push(`   ${fmtBytes(it.bytes)} · 来源 ${it.month || '?'}${it.account ? ` · 账号尾号 ${String(it.account).slice(-4)}` : ''}`);
  });
  if (items.length > MAX) L.push(`……另有 ${items.length - MAX} 个未列出（回 \\收件箱 看全部）`);
  L.push('');
  L.push(`要写进知识库就回我一句：\\入库 文件名`);
  return L.join('\n');
}

/** 私聊主人一张微信搬移回执单。任何失败都只记日志，绝不抛出。 */
async function sendWxReceipt(items, o = {}) {
  const target = receiptTarget();
  const text = buildWxReceipt(items, o);
  if (!target.id) {
    warn(`没有可用的主人 QQ（插件设置「回执发给谁」/ owner-identity / group-reports 三处都空），回执只记日志：\n${text}`);
    return { ok: false, skipped: 'no-owner' };
  }
  try {
    await onebotCall('send_private_msg', {
      user_id: Number(target.id),
      message: [{ type: 'text', data: { text } }]
    });
    log(`已私聊回执单给${target.name || '主人'}（${target.id}，来自 ${target.from}）：本轮 ${items.length} 个文件`);
    return { ok: true, to: target.id };
  } catch (error) {
    warn(`私聊回执单失败（主人 ${target.id}）：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   收件箱清单 / 入库 / 帮助（主人专属口令）
   ══════════════════════════════════════════════════════════════════════ */

function fmtDate(ms) {
  try {
    return new Date(Number(ms) || Date.now()).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

async function renderInboxList({ limit = 15 } = {}) {
  await boot();
  const s = settings();
  const { logic, files } = mods;
  const list = files.listInboxFiles(documentsDirOf(s), { limit });
  if (!list.length) {
    return '收件箱现在是空的。\n'
      + `（QQ 里发来的文件会落到 文档文件夹/${files.SUBDIR_QQ}/，微信收到的落到 文档文件夹/${files.SUBDIR_WX}/；`
      + `目录：${documentsDirOf(s)}）`;
  }
  const lines = list.map((f) => {
    const cls = logic.classifyFile(f.name);
    const srcText = f.source === 'qq' ? 'QQ' : '微信';
    const tail = cls.kind === 'legacy' ? '（旧版 .doc/.ppt，抽不出正文）'
      : (cls.readable ? '' : '（二进制，读不了正文）');
    return `· ${f.rel}（${srcText}，${logic.humanSize(f.size)}，${fmtDate(f.mtimeMs)}）${tail}`;
  });
  const head = `收件箱里最近 ${list.length} 个文件：`;
  const tail = '\n要看内容直接说「读一下 xxx」；要让某个文件进本地知识库：\\入库 文件名（\\入库 全部 把能读的都入库）。';
  return `${head}\n${lines.join('\n')}${tail}`;
}

function renderHelpText() {
  return [
    '收件箱（主人专属口令）：',
    '\\收件箱　　　　　看最近收到的文件（QQ 与微信两路）',
    '\\入库 文件名　　 把那个文件抽正文写进本地知识库（原件移进「已入库」，收件箱不留副本）',
    '\\入库 全部　　　 把收件箱里能读的都入库（一次最多 10 个）',
    '\\收件帮助　　　　这条说明',
    '',
    '自动的部分：',
    '· 主人（你）在 QQ 里发的文件会立刻下载到「文档文件夹/qq/」，群里别人发的不会被下载；',
    '· 微信收到的文档会被**剪贴**搬进「文档文件夹/wx/」（原件不再留副本，改「只复制」在插件设置里）；',
    '· 文件落盘后机器人当场就能用文档阅读技能读它 —— 说「读一下我刚发的文件」就行，不用记路径。'
  ].join('\n');
}

/** 在收件箱 / 微信目录 / 聊天存档里找一个文件。 */
async function findFileAnywhere(needle, ctx) {
  await boot();
  const s = settings();
  const { logic, files, wx, qq } = mods;
  const inbox = files.listInboxFiles(documentsDirOf(s), { limit: 500 });
  let { pick, ties } = logic.pickBestByName(needle, inbox);
  if (pick) return { file: pick.file, name: pick.name, from: pick.source === 'qq' ? '收件箱·QQ' : '收件箱·微信' };
  if (ties.length > 1) return { ambiguous: ties.map((t) => t.rel) };

  // 二、微信接受目录里还没搬的（历史文件，可指名入库）
  if (s.takeWx) {
    const dirs = await wxDirs(true);
    const all = [];
    for (const d of dirs) {
      for (const e of wx.scanWxFileDir(d.dir, { exts: s.wxExts })) {
        all.push({ file: e.file, name: e.name, month: e.month, account: e.account });
      }
    }
    const r2 = logic.pickBestByName(needle, all);
    if (r2.pick) return { file: r2.pick.file, name: r2.pick.name, from: `微信存档${r2.pick.month ? `（${r2.pick.month}）` : ''}` };
    if (r2.ties.length > 1) return { ambiguous: r2.ties.map((t) => `${t.account}/${t.name}`).slice(0, 8) };
  }

  // 三、QQ 补捞：凭 message_id 重新换直链（几天前的文件也能捞回来）
  if (s.takeQQ && ctx?.chatKey) {
    const [kind, chatId] = String(ctx.chatKey).split(':');
    let entries = [];
    try { entries = ctx?.store?.recent?.(ctx.chatKey, { limit: 400 }) || []; } catch { entries = []; }
    if (!entries.length) {
      entries = qq.loadChatMessages(path.join(DATA_DIR, 'messages'), ctx.chatKey, { limit: 400 });
    }
    const hits = qq.findFileMessages(entries, { needle, limit: 400 });
    for (const hit of hits.slice(0, 4)) {
      if (s.onlyOwner && !isOwnerId(hit.senderId)) continue;
      const prevKey = logic.qqStateKey(ctx.chatKey, hit.mid);
      const prev = st.qq[prevKey];
      if (prev?.status === 'ok' && prev.path && fs.existsSync(prev.path)) {
        return { file: prev.path, name: prev.name, from: 'QQ（先前已收）' };
      }
      const r = await takeQqFile({ ctx, chatKey: ctx.chatKey, kind, chatId, entry: hit, name: hit.name, reason: '补捞' });
      if (r.ok) return { file: r.file, name: r.name, from: 'QQ（补捞）' };
    }
    if (hits.length) {
      return { reason: `在最近聊天里找到了「${hits[0].name}」这条文件消息，但重新下载失败（QQ 那边可能已经过期/被删除）` };
    }
  }
  return { reason: `没找到「${needle}」。可以先用 \\收件箱 看看有什么。` };
}

async function ingestOne(target, ctx) {
  const got = await ingestPath(target.file, { source: target.from || 'QQ', name: target.name, ctx });
  if (!got.ok) return { text: `「${target.name}」没入库：${got.reason}` };
  if (got.mode === 'moved') {
    return { text: `「${target.name}」已剪贴进本地知识库：${got.target}\n（原文就是 txt/md，可以直接被检索到。）` };
  }
  return {
    text: `「${target.name}」已入库：抽了 ${got.chars} 字写成 ${path.basename(got.target)}`
      + `\n· 知识库文件：${got.target}`
      + `\n· 原件已从收件箱移进「已入库」${got.removedSource ? '' : '（这次没动原件）'}`
  };
}

/* ══════════════════════════════════════════════════════════════════════
   工具（全部走指令直达：hidden + ownerOnly，0 token，不进模型的工具表）
   ══════════════════════════════════════════════════════════════════════ */

function registerTools(api) {
  api.registerTool({
    id: 'intake_list',
    name: '收件箱清单',
    description: '列出 QQ / 微信收到并已落盘的文件（主人口令：\\收件箱）。',
    category: 'utility',
    icon: '📥',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(ctx, args) {
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 15));
      const text = await renderInboxList({ limit });
      return { content: text, _directText: text };
    }
  });

  api.registerTool({
    id: 'intake_ingest',
    name: '文件入库',
    description: '把某个文件抽正文写进本地知识库（主人口令：\\入库 文件名）。',
    category: 'utility',
    icon: '📚',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(ctx) {
      await boot();
      const { logic } = mods;
      const rawArgs = String(ctx?.commandRoute?.args ?? '').trim();
      const parsed = logic.parseIngestArgs(rawArgs);

      if (parsed.list) {
        const text = `${await renderInboxList({ limit: 15 })}\n\n要对哪个说：\\入库 文件名`;
        return { content: text, _directText: text };
      }

      const s = settings();
      if (parsed.all) {
        const { files } = mods;
        const list = files.listInboxFiles(documentsDirOf(s), { limit: 200 })
          .filter((f) => logic.classifyFile(f.name).ingestible)
          .slice(0, s.ingestMaxPerCall);
        if (!list.length) {
          const text = '收件箱里没有能入库的文件（只有文本 / PDF / Word / PPT 能进知识库）。';
          return { content: text, _directText: text };
        }
        const out = [];
        for (const f of list) {
          const one = await ingestOne({ file: f.file, name: f.name, from: f.source === 'qq' ? 'QQ' : '微信' }, ctx);
          out.push(one.text.split('\n')[0]);
        }
        const text = [`一次入库 ${list.length} 个文件：`, ...out.map((x) => `· ${x}`)].join('\n');
        return { content: text, _directText: text };
      }

      const found = await findFileAnywhere(parsed.raw, ctx);
      if (found.ambiguous) {
        const text = `有 ${found.ambiguous.length} 个文件都像「${parsed.raw}」：\n`
          + found.ambiguous.slice(0, 8).map((x) => `· ${x}`).join('\n')
          + '\n请说得更准一点（带扩展名最稳）。';
        return { content: text, _directText: text };
      }
      if (found.reason) return { content: found.reason, _directText: found.reason };

      const one = await ingestOne(found, ctx);
      log(`入库：${found.name}（来源 ${found.from}）`);
      markHintByName(found.name);
      return { content: one.text, _directText: one.text };
    }
  });

  api.registerTool({
    id: 'intake_help',
    name: '收件箱帮助',
    description: '收件箱的用法说明（主人口令：\\收件帮助）。',
    category: 'utility',
    icon: '❓',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const text = renderHelpText();
      return { content: text, _directText: text };
    }
  });
}

/* ══════════════════════════════════════════════════════════════════════
   钩子
   ══════════════════════════════════════════════════════════════════════ */

/** before-context：把这一批新消息里的 QQ 文件下下来（限量、限时）。 */
async function onBeforeContext(ctx = {}) {
  await boot();
  const s = settings();
  if (!s.enabled || !s.takeQQ) return;
  const chatKey = String(ctx?.chatKey || '');
  if (!chatKey) return;
  const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
  if (!entries.length) return;

  const { logic } = mods;
  const [kind, chatId] = chatKey.split(':');
  const jobs = [];
  for (const m of entries) {
    if (!m || m.self) continue;
    const markers = logic.parseFileMarkers(m.text);
    if (!markers.length) continue;
    const owner = isOwnerId(m.senderId);
    if (s.onlyOwner && !owner) {
      log(`忽略非主人发来的文件（${m.senderId || '?'}）：${markers[0].name}`);
      continue;
    }
    if (m.mid == null || String(m.mid) === '') {
      log(`这条文件消息没有 message_id，取不到：${markers[0].name}`);
      continue;
    }
    const key = logic.qqStateKey(chatKey, m.mid);
    const prev = st.qq[key];
    if (prev && (prev.status === 'ok' || prev.status === 'too-big')) continue;
    if (prev && prev.status === 'failed' && Date.now() - (Number(prev.at) || 0) < 10 * 60000) continue;
    if (inflight.has(key)) continue;
    if (jobs.length >= s.maxFilesPerRun) break;
    jobs.push(takeQqFile({ ctx, chatKey, kind, chatId, entry: m, name: markers[0].name }));
  }
  if (!jobs.length) return;

  if (s.syncWaitMs <= 0) {
    Promise.allSettled(jobs).catch(() => {});
    return;
  }
  await Promise.race([Promise.allSettled(jobs), sleep(s.syncWaitMs)]);
}

/** before-llm-messages：把"刚收到文件"追加到最后一条 user 消息尾部（只贴一次）。 */
function onBeforeLlmMessages(ctx = {}) {
  try {
    const s = settings();
    if (!s.enabled || !s.hintInPrompt || !st) return;
    const chatKey = String(ctx?.chatKey || '');
    const queued = hintQueue.get(chatKey) || [];
    if (!queued.length) return;
    const fresh = queued.filter((h) => !st.hinted[h.key]);
    if (!fresh.length) return;
    const msgs = ctx?.messages;
    if (!Array.isArray(msgs) || !msgs.length) return;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') return;
    if (!appendToTail(last, buildHintText(fresh))) return;
    for (const h of fresh) st.hinted[h.key] = Date.now();
    st.touch(0);
    log(`已提示模型：${fresh.map((h) => h.rel).join('、')}`);
  } catch (error) {
    warn(`提示注入出错：${error?.message ?? error}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   生命周期 / 能力
   ══════════════════════════════════════════════════════════════════════ */

export async function setup(api) {
  apiRef = api;
  cfgFn = api.config;
  await boot();
  registerTools(api);
  log('收件箱已装载：QQ 文件下载 + 微信目录搬移 + 主人口令入库（0 token）');
}

export function available() {
  return { ok: true };
}

export async function activate() {
  try {
    await boot();
    const s = settings();
    if (!s.enabled) return;
    if (s.takeWx) {
      const dirs = await wxDirs(true);
      armWxWatchers(dirs);
      log(dirs.length
        ? `微信侧已接管：${dirs.length} 个账号目录（${dirs.map((d) => d.account).join('、')}），监听 + 每 ${s.wxScanMinutes} 分钟兜底扫描`
        : '微信侧：没找到接受文件的目录（在插件设置里填「微信数据目录」）');
      // 激活后先扫一遍（延迟 5 秒：让 watcher 先挂上，且别和启动时的其它 IO 抢）
      if (wxKickTimer) clearTimeout(wxKickTimer);
      wxKickTimer = setTimeout(() => {
        wxKickTimer = null;
        wxScan('activate').catch(() => {});
      }, 5000);
      wxKickTimer.unref?.();    }
    startTimer();
  } catch (error) {
    warn(`启动出错：${error?.message ?? error}`);
  }
}

function startTimer() {
  if (wxTimer) return;
  wxTimer = setInterval(() => {
    try {
      const s = settings();
      if (s.enabled && s.takeWx) {
        const last = Number(st?.data?.lastWxScanAt) || 0;
        if (Date.now() - last >= s.wxScanMinutes * 60000) wxScan('timer').catch(() => {});
      }
    } catch { /* ignore */ }
  }, 30000);
  wxTimer.unref?.();

  if (!wxMetaTimer) {
    wxMetaTimer = setInterval(() => {
      try {
        const s = settings();
        const n = st?.pruneOlderThan?.(s.logKeepDays) || 0;
        if (n) log(`清理过期状态记录 ${n} 条（保留 ${s.logKeepDays} 天）`);
        if (s.enabled && s.takeWx) {
          // 账号目录可能被换过（多开/换机）；顺手刷新一次监听
          wxDirs(true).then((dirs) => { if (dirs.length) armWxWatchers(dirs); }).catch(() => {});
        }
      } catch { /* ignore */ }
    }, 30 * 60000);
    wxMetaTimer.unref?.();
  }
}

export function deactivate(reason) {
  try {
    if (wxTimer) { clearInterval(wxTimer); wxTimer = null; }
    if (wxMetaTimer) { clearInterval(wxMetaTimer); wxMetaTimer = null; }
    if (wxKickTimer) { clearTimeout(wxKickTimer); wxKickTimer = null; }
    if (wxDebounce) { clearTimeout(wxDebounce); wxDebounce = null; }
    if (mods) mods.wx.stopWxWatchers(wxHandles);
    wxHandles = [];
    try { st?.flush?.(); } catch { /* ignore */ }
    // ⚠️ 核心热重载调的是 `deactivate({ reason: 'reload' })`（**对象**，不是字符串）；
    //    这里兼容两种形态，否则改了 lib 之后热重载永远拿旧模块（幽灵实例）。
    const why = typeof reason === 'string' ? reason : String(reason?.reason || '');
    if (why === 'reload' || why === 'dispose') {
      mods = null;
      libCache = new Map();
      st = null;
    }
  } catch { /* ignore */ }
}

export function dispose() {
  deactivate('dispose');
}

/** 对外能力：别的插件/控制台可以用它查状态或触发入库。 */
export const providers = {
  'file-intake.status': () => {
    try {
      return {
        enabled: settings().enabled,
        documentsDir: documentsDirOf(),
        inbox: mods ? mods.files.listInboxFiles(documentsDirOf(), { limit: 5 }).length : 0,
        ...(st?.snapshot?.() || {})
      };
    } catch {
      return null;
    }
  },
  'file-intake.list': (args = {}) => {
    try {
      return { files: mods ? mods.files.listInboxFiles(documentsDirOf(), { limit: Number(args.limit) || 20 }) : [] };
    } catch {
      return { files: [] };
    }
  },
  'file-intake.ingest': async (args = {}) => {
    await boot();
    const needle = String(args.name || '').trim();
    if (!needle) return { ok: false, reason: '缺少 name' };
    const found = await findFileAnywhere(needle, args.ctx || {});
    if (!found.file) return { ok: false, reason: found.reason || '匹配不唯一' };
    return ingestPath(found.file, { source: found.from || 'QQ', name: found.name, ctx: args.ctx || {} });
  },
  'file-intake.scan-wx': async () => wxScan('capability')
};

export const hooks = {
  'before-context': (ctx) => onBeforeContext(ctx).catch((error) => warn(`before-context 出错：${error?.message ?? error}`)),
  'before-llm-messages': (ctx) => onBeforeLlmMessages(ctx)
};

/** 排障/测试入口。 */
export const internals = {
  settings,
  documentsDirOf,
  kbDirOf,
  buildHintText,
  appendToTail,
  readTextFile,
  isOwnerId,
  onBeforeContext,
  onBeforeLlmMessages,
  wxScan,
  takeQqFile,
  ingestPath,
  renderInboxList,
  renderHelpText,
  findFileAnywhere,
  boot,
  get state() { return st; },
  get mods() { return mods; }
};
