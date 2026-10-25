// 卡片内容还原（B站视频卡片 / QQ小程序卡片 / 网页卡片）—— 确定性型（plugins/）
//
// ── 这个插件解决什么 ───────────────────────────────────────────────────────
//   群友转发 B站视频、QQ小程序时，QQ 发来的是 **json 卡片段**，而核心
//   （src/onebot.js 的 segmentsToText）把它压成一个占位符：
//       case 'json': out.push('[卡片消息]'); break;
//   再加上 prompt.js 明确告诉模型「[卡片消息] 是占位符，无法查看内容」——
//   所以她对卡片是**真的瞎**：不知道是视频、不知道标题、更看不到画面。
//   而如果同一个视频是"复制链接发出来"，反而能看到【标题】+链接。
//   这就是用户说的"只能看链接的格式、看不了卡片"。
//
//   本插件把卡片还原成她"看得见"的东西：
//     ① 通过 OneBot get_msg 把原始 json/xml 卡片捞回来（卡片原文不落存档，
//        只能回协议端要；实测历史消息也能拿到）；
//     ② 解析出 来源/标题/UP主/时长/播放量/简介/真实链接；
//     ③ 对 B站 视频，再用 B站 自己的**视频快照**（videoshot 雪碧图，免登录）
//        取到**真实画面帧**，切成一帧一张，作为图片一起交给她 —— 她是真的在看画面，
//        不是只看标题；
//     ④ 把这些内容注入这一轮的模型消息（before-llm-messages），
//        原文占位符旁边就多了一段"这张卡片的真实内容"。
//
// ── 为什么是插件（plugins/）而不是技能（skills/）────────────────────────────
//   "卡片消息出现 → 还原内容"是**确定性**条件：不需要模型判断该不该还原，
//   等它判断就等于把"她能不能看见"交给运气。按 plugin-loader 的约定，
//   确定性行为放 plugins/，用 before-context（发现）+ before-llm-messages（注入）插进主流程。
//   插件同样可以 registerTool（同目录的 favor / token-ledger 都注册了），
//   所以这里另外挂了一个 card_open 工具，供她主动去看**旧消息**里的卡片/链接。
//
// ── 画面从哪来（关键取舍，写给以后的自己）──────────────────────────────────
//   本机**没有 ffmpeg**（全盘只有 Electron 的 ffmpeg.dll，无关），
//   所以"下载视频 → 抽帧"这条路是断的：image-compress / gif-to-video / video-reader
//   三处都是"探测到 ffmpeg 就用，没有就降级"，video.frames 能力当前也无提供者。
//   但 B站 自带 `api.bilibili.com/x/player/videoshot`：返回一张 10×10 的**真实画面
//   雪碧图**（进度条预览用的那种）+ 每一格的时间戳。免登录、几十 KB、不用下载视频、不用 ffmpeg。
//   于是：
//     · 切帧：用 Electron 主进程原生的 nativeImage（main.js 里就在用），
//       crop 出每一格 → JPEG data URL。**全程内存里完成，不写任何临时文件**；
//     · 拿不到 Electron 时降级：直接把整张雪碧图交给她（一样是真实画面，只是分辨率被压缩）；
//     · 所以磁盘上**零残留** —— 用户担心的"下载的视频要删掉"从根上不存在
//       （不下载视频，自然没有要删的东西）。另外仍留了 cleanupTemp()，
//       启动/停用时清理可能的历史临时文件，做到"绝不留垃圾"。
//
// ── 边界与安全 ─────────────────────────────────────────────────────────────
//   · 需要 permissions: ["web_fetch"]；
//   · 只在"本轮新出现的消息"里动手（triggerEntries），不翻旧账、不主动扫描全群；
//   · 一轮最多处理 maxCardsPerRun 张卡片（默认 2），并有 hookBudgetMs 硬预算
//     （钩子本身 5 秒超时，超了就只给已经拿到的部分，绝不拖垮这一轮对话）；
//   · 图片只有在"模型确实能看图"时才附（config.api.vision + 视觉探测结论），
//     否则只给文字，避免给纯文本模型塞图导致整轮 400；
//   · 设置项命名避开 key/token/secret/cookie —— 核心会把这类字段名当密文掩码成 ******，
//     用户就读不到自己的设置了。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig } from '../../src/config.js';

const ID = 'qq-card-reader';
/** 本插件所在目录（读自己的 plugin.json 用；不能靠 DATA_DIR 反推，两者不在同一棵树） */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com/';

const STATUS_FILE = path.join(DATA_DIR, 'skills', ID, 'status.json');
const TMP_PREFIX = 'qq-agent-card-';

/** 卡片占位符：核心把 json 段压成 [卡片消息]；xml / 未知段会变成 [xml] 之类。 */
const PLACEHOLDER_RE = /\[(卡片消息|xml|小程序|分享|share|链接|网页卡片)\]/i;
/** B站视频链接（长短链都认） */
const B23_RE = /(?:https?:\/\/)?b23\.tv\/[A-Za-z0-9]+/i;
const BILI_RE = /(?:https?:\/\/)?(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i;
const BV_RE = /\b(BV[0-9A-Za-z]{10})\b/;
const AV_RE = /\bav(\d+)\b/i;

/** 出厂默认值（与 plugin.json 的 settings 保持一致，改一处要改两处） */
const DEFAULTS = {
  enabled: true,
  attachFrames: true,        // 把视频真实画面附给她看
  maxFrames: 6,              // 附几张画面（1~12）
  maxCardsPerRun: 2,         // 一轮最多还原几张卡片
  enrichPlainLinks: true,    // 纯 B站 链接（不是卡片）也补画面
  frameStyle: 'auto',        // auto=能切帧就切帧 / sheet=整张快照图 / off=不要画面
  coverAsFallback: true,     // 拿不到画面时至少给封面图
  autoProbeVision: true,     // 自动探测当前模型收不收图
  selfTest: 'once',          // once=每个版本跑一次自检 / always / off
  writeStatus: true,         // 把自检与运行状态写到 data/skills/<id>/status.json
  hookBudgetMs: 4000,        // 单轮还原的总时间预算（钩子 5 秒超时）
  requestTimeoutMs: 8000,    // 单次网络请求超时
  maxSheetKB: 4096,          // 单张快照图体积上限
  debug: false
};

// ── 模块状态 ──────────────────────────────────────────────────────────────
// 热重载会重新 import，这些会归零；持久信息写在 status.json 与设置里。
let api = null;
let visionOk = null;                 // null=未知 / true=能看图 / false=明确不能
let visionProbed = false;
let nativeImageMod = null;           // Electron nativeImage（拿不到就一直是 null）
let lastError = '';
let stats = { decoded: 0, frames: 0, injected: 0, lastAt: 0, lastSummary: '' };

/** sessionId → { blocks:[], images:[], notes:[] }：before-context 发现、before-llm-messages 注入 */
const pending = new Map();
/** mid → { at, block, images }（同一张卡片在重试/多轮里不重复走网络） */
const cardCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 120;

// ══════════════════════════════════════════════════════════════════════════
// 一、通用小工具
// ══════════════════════════════════════════════════════════════════════════

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    lastError = `写状态失败：${error?.message ?? error}`;
    return false;
  }
}

/** 网络取文本/JSON/二进制（带 UA 与 B站 Referer；超时用 AbortSignal） */
async function httpGet(url, { timeoutMs = 8000, json = false, binary = false, maxBytes = 0, referer = BILI_REFERER } = {}) {
  const t = clamp(timeoutMs, 300, 30000);
  const headers = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };
  if (referer) headers.Referer = referer;
  const res = await api.fetch(url, { redirect: 'follow', headers, signal: AbortSignal.timeout(t) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (binary) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buf.length > maxBytes) throw new Error(`体积 ${Math.round(buf.length / 1024)}KB 超过上限 ${Math.round(maxBytes / 1024)}KB`);
    return buf;
  }
  const text = await res.text();
  if (!json) return text;
  try { return JSON.parse(text); } catch { throw new Error('返回的不是合法 JSON'); }
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const absUrl = (u) => {
  const s = str(u);
  if (!s) return '';
  if (s.startsWith('//')) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(m\.q\.qq\.com|b23\.tv|bilibili\.com|www\.bilibili\.com)\//i.test(s)) return `https://${s}`;
  return '';
};
const unescapeXml = (s) => str(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .trim();
const stripTags = (s) => unescapeXml(str(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** 秒 → 3:21 / 1:02:03 */
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}
/** 秒 → 0:17（画面时间点用） */
const fmtClock = (sec) => fmtDuration(sec);
/** 123456 → 12.3万 */
function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}

/** 清理本插件可能留下的临时文件（本实现不写临时文件，这是保险） */
function cleanupTemp() {
  try {
    const dir = os.tmpdir();
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(TMP_PREFIX)) continue;
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* 单个失败无所谓 */ }
    }
  } catch { /* 读不到 temp 就算了 */ }
}

/** 当前要用的模型 Key：与 src/llm.js 的 resolveApiKey 同一套优先级（自包含实现） */
function resolveApiKey(cfg) {
  const pid = str(cfg?.api?.provider);
  if (pid) {
    const fromDsh = str(cfg?.dshProviderKeys?.[pid]);
    if (fromDsh && fromDsh !== '******') return fromDsh;
    const p = (cfg?.providers || []).find((x) => x.id === pid);
    const legacy = str(p?.apiKey);
    if (legacy && legacy !== '******') return legacy;
  }
  const direct = str(cfg?.api?.apiKey);
  return direct === '******' ? '' : direct;
}

// ══════════════════════════════════════════════════════════════════════════
// 二、OneBot：把卡片原文捞回来
// ══════════════════════════════════════════════════════════════════════════

function onebotEndpoint() {
  let cfg = null;
  try { cfg = getConfig(); } catch { /* 配置没就绪就用默认本地口 */ }
  const httpUrl = str(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = str(cfg?.snowluma?.httpAccessToken || cfg?.snowluma?.accessToken);
  return { httpUrl, token };
}

/**
 * 调 OneBot。优先用工具上下文里的 onebot 客户端（工具路径），
 * 没有就自己走 HTTP（钩子里拿不到 onebot 客户端，这是唯一通路）。
 */
async function onebotCall(action, params = {}, { timeoutMs = 8000, onebot = null } = {}) {
  if (onebot && typeof onebot.call === 'function') {
    return onebot.call(action, params, clamp(timeoutMs, 500, 30000));
  }
  const { httpUrl, token } = onebotEndpoint();
  const res = await api.fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(clamp(timeoutMs, 500, 30000))
  });
  if (!res.ok) throw new Error(`OneBot ${action} HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body.status !== 'ok' && body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败：retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
  }
  return body.data;
}

/** 取一条消息的原始段数组（get_msg）。返回 null 表示拿不到。 */
async function getMessageSegments(mid, { onebot = null, timeoutMs = 6000 } = {}) {
  try {
    const data = await onebotCall('get_msg', { message_id: Number(mid) }, { onebot, timeoutMs });
    const segs = data?.message ?? data?.message_array ?? null;
    if (Array.isArray(segs)) return segs;
    // 有些协议端回的是 CQ 码字符串：尝试把它当 json 段处理（下面 parse 会兜底）
    if (typeof segs === 'string' && /\[CQ:json/i.test(segs)) {
      const m = /\[CQ:json,data=([^\]]+)\]/i.exec(segs);
      if (m) {
        try { return [{ type: 'json', data: { data: decodeURIComponent(m[1].replace(/&#44;/g, ',')) } }]; } catch { /* 忽略 */ }
      }
    }
    return null;
  } catch (error) {
    lastError = `get_msg 失败：${error?.message ?? error}`;
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 三、卡片解析：json（QQ小程序/网页分享）与 xml（网页卡片）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 解析 QQ 小程序/网页分享的 json 卡片。
 *
 * 结构（实测）：
 *   { app: 'com.tencent.miniapp_01', prompt: '[QQ小程序]<视频标题>',
 *     meta: { detail_1: { title: '哔哩哔哩',        ← 这里是**应用名**
 *                        desc: '小孩闪身步，大表哥…', ← 这才是**内容标题**
 *                        preview: 'https://…',      ← 分享缩略图
 *                        url: 'm.q.qq.com/a/s/…',    ← 小程序页（打不开内容）
 *                        qqdocurl: 'https://b23.tv/a1Bln9y…', ← 真实地址
 *                        host: { uin: 1716218006, nick: 'Firefly.流萤' } } } }
 *
 * 注意 detail_1.title 是应用名不是标题 —— 用错就会把"哔哩哔哩"当成视频标题。
 */
function parseCardJson(raw) {
  let obj = null;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const out = { kind: 'json', app: str(obj.app), source: '', title: '', desc: '', url: '', cover: '', host: '' };
  const meta = (obj.meta && typeof obj.meta === 'object') ? obj.meta : {};
  const nodes = Object.entries(meta).filter(([, v]) => v && typeof v === 'object');

  for (const [k, v] of nodes) {
    const key = k.toLowerCase();
    const nodeUrl = absUrl(v.qqdocurl) || absUrl(v.jumpUrl) || absUrl(v.url) || absUrl(v.docUrl) || absUrl(v.sourceUrl);
    const nodeCover = absUrl(v.preview) || absUrl(v.cover) || absUrl(v.icon) || absUrl(v.thumb);
    if (!out.host && v.host) out.host = str(v.host.nick || v.host.nickname || v.host.name);

    if (key.startsWith('detail')) {
      // 小程序卡片：title=应用名，desc=内容标题
      out.source = out.source || str(v.title);
      out.title = out.title || str(v.desc) || str(v.title);
      out.desc = out.desc || str(v.summary) || '';
      out.cover = out.cover || nodeCover;
      out.url = out.url || nodeUrl;
    } else if (key === 'news') {
      out.source = out.source || '网页分享';
      out.title = out.title || str(v.title) || str(v.desc);
      out.desc = out.desc || str(v.desc) || str(v.summary) || '';
      out.cover = out.cover || nodeCover;
      out.url = out.url || nodeUrl;
    } else if (key === 'music') {
      out.source = out.source || '音乐分享';
      out.title = out.title || str(v.title);
      out.desc = out.desc || str(v.desc) || str(v.singer) || '';
      out.cover = out.cover || nodeCover;
      out.url = out.url || absUrl(v.musicUrl) || nodeUrl;
    } else if (key === 'video') {
      out.source = out.source || '视频分享';
      out.title = out.title || str(v.title) || str(v.desc);
      out.desc = out.desc || str(v.desc) || '';
      out.cover = out.cover || nodeCover;
      out.url = out.url || nodeUrl;
    } else {
      out.title = out.title || str(v.title) || str(v.desc);
      out.desc = out.desc || str(v.desc) || '';
      out.cover = out.cover || nodeCover;
      out.url = out.url || nodeUrl;
    }
  }

  // 兜底：prompt 形如 "[QQ小程序]真正的标题" —— 标题还能从这里捞
  const prompt = str(obj.prompt).replace(/^\[[^\]]{1,10}\]\s*/, '');
  if (prompt && !out.title) out.title = prompt;
  // 显示时不该露出 com.tencent.miniapp_01 这种内部 id
  if (/^com\.tencent\./i.test(out.app)) {
    if (!out.source) out.source = /miniapp/i.test(out.app) ? (prompt ? 'QQ小程序' : '小程序卡片') : 'QQ 卡片';
    out.app = '';
  } else if (!out.source && out.app.includes('miniapp')) {
    out.source = prompt ? 'QQ小程序' : '小程序卡片';
  }
  return out;
}

/** 解析 xml 卡片（<msg url=… brief=…><item><title>…</title><summary>…</summary>…） */
function parseCardXml(xml) {
  const s = str(xml);
  if (!s) return null;
  const attr = (n) => { const m = new RegExp(`${n}="([^"]*)"`, 'i').exec(s); return m ? unescapeXml(m[1]) : ''; };
  const tag = (n) => { const m = new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(s); return m ? stripTags(m[1]) : ''; };
  const coverAttr = (/<picture[^>]*cover="([^"]*)"/i.exec(s) || [])[1] || '';

  const out = {
    kind: 'xml',
    app: attr('appid') ? `appid=${attr('appid')}` : 'xml',
    source: '网页卡片',
    title: tag('title') || attr('brief').replace(/^\[分享\]\s*/, ''),
    desc: tag('summary') || tag('description'),
    url: absUrl(attr('url')) || absUrl(tag('url')),
    cover: absUrl(coverAttr),
    host: ''
  };
  if (!out.title && !out.url) return null;
  return out;
}

/** 从 get_msg 的段数组里找卡片段并解析；返回 {card, raw} 或 null */
function parseCardFromSegments(segs) {
  for (const seg of segs || []) {
    const type = str(seg?.type).toLowerCase();
    const d = seg?.data ?? {};
    const rawPayload = typeof d === 'string' ? d : (d.data ?? d.content ?? d.json ?? '');
    if (type === 'json') {
      const card = parseCardJson(rawPayload);
      if (card) return { card, raw: str(rawPayload).slice(0, 800) };
    } else if (type === 'xml') {
      const card = parseCardXml(rawPayload);
      if (card) return { card, raw: str(rawPayload).slice(0, 800) };
    } else if (type === 'share') {
      // OneBot v11 的 share 段：直接带 url/title
      const card = {
        kind: 'share',
        app: 'share',
        source: '分享卡片',
        title: str(d.title),
        desc: str(d.content),
        url: absUrl(d.url),
        cover: absUrl(d.image),
        host: ''
      };
      if (card.title || card.url) return { card, raw: JSON.stringify(d).slice(0, 800) };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// 四、B站：链接解析 + 视频信息 + 真实画面快照
// ══════════════════════════════════════════════════════════════════════════

/** 从任意文本里找 B站 视频标识：{ bvid } / { aid } */
function pickBiliRef(text) {
  const s = str(text);
  const bv = BV_RE.exec(s);
  if (bv) return { bvid: bv[1] };
  const av = AV_RE.exec(s);
  if (av) return { aid: av[1] };
  return null;
}

/** b23.tv 短链 → 真实地址（跟随重定向） */
async function expandShortLink(url, timeoutMs) {
  const s = absUrl(url) || str(url);
  if (!s) return '';
  if (!/b23\.tv/i.test(s)) return s;
  const res = await api.fetch(s, { redirect: 'follow', headers: { 'User-Agent': UA, Referer: BILI_REFERER }, signal: AbortSignal.timeout(clamp(timeoutMs, 500, 20000)) });
  return res.url || s;
}

/** B站视频公开信息（免 key、免登录） */
async function biliView(ref, timeoutMs) {
  const q = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(ref.aid)}`;
  const j = await httpGet(`https://api.bilibili.com/x/web-interface/view?${q}`, { timeoutMs, json: true });
  if (!j || j.code !== 0 || !j.data) throw new Error(`B站接口返回 code=${j?.code ?? '?'} ${j?.message ?? ''}`);
  const d = j.data;
  return {
    bvid: str(d.bvid),
    aid: d.aid,
    title: str(d.title),
    desc: str(d.desc),
    cover: absUrl(d.pic),
    durationSec: Number(d.duration) || 0,
    up: str(d.owner?.name),
    views: Number(d.stat?.view) || 0,
    danmaku: Number(d.stat?.danmaku) || 0,
    likes: Number(d.stat?.like) || 0,
    pages: Array.isArray(d.pages) ? d.pages.length : 1,
    pubdate: Number(d.pubdate) || 0
  };
}

/**
 * B站官方视频快照：10×10 雪碧图，每格一帧真实画面，带时间戳。
 * 免登录（实测 code=0）。格子尺寸随视频质量不同（160×90 或 480×270）。
 */
async function biliVideoshot(ref, timeoutMs) {
  const q = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(ref.aid)}`;
  const j = await httpGet(`https://api.bilibili.com/x/player/videoshot?${q}&index=1`, { timeoutMs, json: true });
  if (!j || j.code !== 0 || !j.data) throw new Error(`快照接口 code=${j?.code ?? '?'}`);
  const d = j.data;
  const sheets = (Array.isArray(d.image) ? d.image : []).map(absUrl).filter(Boolean);
  const times = Array.isArray(d.index) ? d.index.map((x) => Number(x) || 0) : [];
  const cols = clamp(Number(d.img_x_len) || 10, 1, 20);
  const rows = clamp(Number(d.img_y_len) || 10, 1, 20);
  const cellW = clamp(Number(d.img_x_size) || 160, 16, 2000);
  const cellH = clamp(Number(d.img_y_size) || 90, 16, 2000);
  if (!sheets.length || !times.length) throw new Error('这个视频没有快照数据（可能是直播回放或很新的视频）');
  return { sheets, times, cols, rows, cellW, cellH, perSheet: cols * rows };
}

/** 用 Electron 原生 nativeImage 把雪碧图切成单帧（全内存，不落盘） */
async function getNativeImage() {
  if (nativeImageMod !== null) return nativeImageMod;
  try {
    const mod = await import('electron');
    nativeImageMod = (mod && typeof mod.nativeImage?.createFromBuffer === 'function') ? mod.nativeImage : false;
  } catch {
    nativeImageMod = false;   // 非 Electron 环境（测试/headless）：降级到整张雪碧图
  }
  return nativeImageMod;
}

/**
 * 切帧：从下好的雪碧图里裁出选中的格子 → JPEG data URL 数组。
 * 拿不到 nativeImage / 裁剪失败时返回 null，调用方降级为"整张雪碧图"。
 */
async function sliceFrames(sheetBuffers, shot, count) {
  const nativeImage = await getNativeImage();
  if (!nativeImage) return null;
  const total = Math.min(shot.times.length, shot.perSheet * shot.sheets.length);
  if (total < 1) return null;
  const n = clamp(count, 1, 12);

  // 均匀取 n 帧（覆盖开头到结尾）；重复时间点去重
  const wanted = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : Math.round((i * (total - 1)) / (n - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    wanted.push(idx);
  }

  const out = [];
  for (const idx of wanted) {
    const sheetIdx = Math.floor(idx / shot.perSheet);
    const buf = sheetBuffers[sheetIdx];
    if (!buf) continue;
    let img = null;
    try { img = nativeImage.createFromBuffer(buf); } catch { img = null; }
    if (!img || img.isEmpty?.()) continue;
    const size = img.getSize?.() || { width: 0, height: 0 };
    // 用真实尺寸算网格（末张雪碧图可能不满格），避免裁到画布外
    const cols = Math.max(1, Math.floor(size.width / shot.cellW) || shot.cols);
    const cell = idx % shot.perSheet;
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    const x = col * shot.cellW;
    const y = row * shot.cellH;
    if (x + shot.cellW > size.width || y + shot.cellH > size.height) continue;
    try {
      const cropped = img.crop({ x, y, width: shot.cellW, height: shot.cellH });
      const jpeg = cropped.toJPEG(88);
      if (!jpeg || !jpeg.length) continue;
      out.push({ dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, at: shot.times[idx], bytes: jpeg.length });
    } catch { /* 单帧失败就少一帧，不影响其它 */ }
  }
  return out.length ? out : null;
}

/** 图片 → data URL（整张雪碧图 / 封面图降级路径用） */
function bufToDataUrl(buf, mime = 'image/jpeg') {
  return `data:${mime},${buf.toString('base64')}`;
}

// ══════════════════════════════════════════════════════════════════════════
// 五、还原一张卡片/链接（核心流程）
// ══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} entry  { mid, text, senderName, senderId, self }
 * @param {object} opts   { s, deadline, onebot, frames? }
 * @returns {Promise<{block:string, images:string[], note:string, cached?:boolean}>}
 */
async function decodeEntry(entry, { s = settings(), deadline = Date.now() + 4000, onebot = null, forceFrames = 0 } = {}) {
  const mid = str(entry?.mid);
  const cached = mid ? cardCache.get(mid) : null;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { block: cached.block, images: cached.images, note: cached.note, cached: true };
  }

  const left = () => Math.max(400, deadline - Date.now());
  const timeout = () => Math.min(clamp(Number(s.requestTimeoutMs) || 8000, 1000, 20000), left());

  let card = null;
  let rawSnippet = '';
  if (mid) {
    const segs = await getMessageSegments(mid, { onebot, timeoutMs: timeout() });
    if (segs) {
      const parsed = parseCardFromSegments(segs);
      if (parsed) { card = parsed.card; rawSnippet = parsed.raw; }
    }
  }
  // 卡片原文拿不到时，至少用消息文本里的链接（[卡片消息] 之外的纯链接情况）
  if (!card) {
    const ref = pickBiliRef(entry?.text);
    const link = B23_RE.exec(str(entry?.text))?.[0] || BILI_RE.exec(str(entry?.text))?.[0] || '';
    if (ref || link) card = { kind: 'link', app: 'link', source: '链接', title: '', desc: '', url: absUrl(link) || '', cover: '', host: '' };
  }
  if (!card) return { block: '', images: [], note: '卡片原文没取到（get_msg 失败或不是卡片段）' };

  // ── 找 B站 视频标识 ──
  let ref = pickBiliRef(card.url) || pickBiliRef(rawSnippet) || pickBiliRef(entry?.text);
  // b23 短链要展开才拿得到 BV 号
  if (!ref && card.url && /b23\.tv/i.test(card.url)) {
    try {
      const real = await expandShortLink(card.url, timeout());
      ref = pickBiliRef(real);
      if (!card.url || /b23\.tv/i.test(card.url)) card.url = real || card.url;
    } catch (error) { lastError = `短链展开失败：${error?.message ?? error}`; }
  }
  if (!ref && card.url && /b23\.tv/i.test(card.url)) {
    // 退一步：直接抓短链页面，正文里一般有 BV 号和 <title>
    try {
      const html = await httpGet(card.url, { timeoutMs: timeout(), referer: BILI_REFERER });
      ref = pickBiliRef(html);
      const t = /<title>([\s\S]*?)<\/title>/i.exec(str(html));
      if (!card.title && t) card.title = unescapeXml(t[1]).replace(/[_\-|]\s*哔哩哔哩.*$/i, '').trim();
    } catch (error) { lastError = `短链页面抓取失败：${error?.message ?? error}`; }
  }

  // ── 非 B站：只给卡片自身信息 ──
  if (!ref) {
    const lines = [];
    lines.push(`【卡片内容还原】${entry?.senderName ? `${entry.senderName} ` : ''}发的是一张卡片（消息里只有一个 [卡片消息] 占位符，看不到原文），它的真实内容是：`);
    if (card.source) lines.push(`· 来源：${card.source}${card.app ? `（${card.app}）` : ''}`);
    if (card.title) lines.push(`· 标题：${card.title}`);
    if (card.desc && card.desc !== card.title) lines.push(`· 简介：${card.desc.slice(0, 300)}`);
    if (card.url) lines.push(`· 链接：${card.url}`);
    lines.push('（这些信息来自卡片原文；如果还想知道里面的具体内容，看情况用 web_fetch / 让对方直接说。）');
    const block = lines.join('\n');
    const images = [];
    // 非 B站 卡片也把缩略图给她看一眼（能看图时）
    if (s.coverAsFallback !== false && card.cover && canSeeImages(s)) {
      try {
        const buf = await httpGet(card.cover, { timeoutMs: timeout(), binary: true, maxBytes: clamp(Number(s.maxSheetKB) || 4096, 64, 8192) * 1024, referer: '' });
        images.push(bufToDataUrl(buf, bufferMime(buf)));
      } catch { /* 图拿不到就算了 */ }
    }
    if (mid) cardCache.set(mid, { at: Date.now(), block, images, note: '非B站卡片' });
    return { block, images, note: '非B站卡片' };
  }

  // ── B站：补全信息 ──
  let info = null;
  try { info = await biliView(ref, timeout()); } catch (error) { lastError = `B站视频信息失败：${error?.message ?? error}`; }

  // ── 真实画面 ──
  const wantFrames = (forceFrames > 0 ? forceFrames : (s.attachFrames !== false ? clamp(Number(s.maxFrames) || 6, 1, 12) : 0));
  const style = wantFrames > 0 ? str(s.frameStyle || 'auto').toLowerCase() : 'off';
  const images = [];
  let frameNote = '';
  let frameTimes = [];

  if (style !== 'off' && wantFrames > 0) {
    try {
      const shot = await biliVideoshot(ref, timeout());
      const total = Math.min(shot.times.length, shot.perSheet * shot.sheets.length);
      const needSheets = Math.min(shot.sheets.length, Math.ceil(total / shot.perSheet));
      const bufs = [];
      for (let i = 0; i < needSheets; i++) {
        if (left() < 800) break;
        // 雪碧图偶发抓失败（CDN 抖动/限速）时重试一次 —— 实测真的会遇到，
        // 丢一张画面比丢整轮体验糟
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            bufs.push(await httpGet(shot.sheets[i], { timeoutMs: timeout(), binary: true, maxBytes: clamp(Number(s.maxSheetKB) || 4096, 256, 16384) * 1024 }));
            break;
          } catch (error) {
            lastError = `快照图下载失败：${error?.message ?? error}`;
            if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
          }
        }
      }
      if (style !== 'sheet') {
        const sliced = await sliceFrames(bufs, shot, wantFrames);
        if (sliced) {
          frameTimes = sliced.map((f) => f.at);
          for (const f of sliced) images.push(f.dataUrl);
          frameNote = `附了 ${images.length} 张**视频真实画面**（时间点：${frameTimes.map(fmtClock).join(' / ')}），不是封面；切帧用的是 Electron 原生图像能力，全程内存处理、不落盘。`;
        }
      }
      if (!images.length && bufs.length) {
        // 降级：整张快照网格图（一样是真实画面，只是被压得小一点）
        for (const b of bufs.slice(0, 2)) images.push(bufToDataUrl(b, bufferMime(b)));
        frameTimes = shot.times.slice(0, Math.min(total, shot.perSheet * images.length));
        frameNote = `附了 ${images.length} 张**视频快照网格图**：每格一帧真实画面，按行从左到右、时间递增`
          + `（单格 ${shot.cellW}×${shot.cellH}，共 ${total} 帧，时间点 ${fmtClock(shot.times[0])} ~ ${fmtClock(shot.times[total - 1])}）。`
          + '这是 B站 官方进度条预览图，不是封面。';
      }
      if (!images.length) frameNote = '（这次没取到视频画面，只有下面的文字信息。）';
    } catch (error) {
      frameNote = `（没取到视频画面：${error?.message ?? error}）`;
    }
  } else if (style === 'off' && s.attachFrames !== false) {
    frameNote = '（设置里关掉了画面。）';
  }

  // ── 画面都没有时，退而给封面 ──
  if (!images.length && s.coverAsFallback !== false && canSeeImages(s)) {
    const cover = info?.cover || card.cover;
    if (cover) {
      try {
        const buf = await httpGet(cover, { timeoutMs: timeout(), binary: true, maxBytes: clamp(Number(s.maxSheetKB) || 4096, 64, 8192) * 1024, referer: '' });
        images.push(bufToDataUrl(buf, bufferMime(buf)));
        // ⚠️ 不要把上面那句"为什么没拿到画面"的解释覆盖掉：
        //    否则只剩"给了封面"，排查时完全不知道是接口变了还是网络抖了。
        const why = frameNote ? frameNote.replace(/^（|）$/g, '') : '';
        frameNote = `附了 1 张**视频封面图**（真实画面这次没取到${why ? `：${why}` : ''}）。`;
      } catch { /* 封面也拿不到就算了 */ }
    }
  }

  // ── 组装文字 ──
  const L = [];
  L.push(`【卡片内容还原】${entry?.senderName ? `${entry.senderName} ` : ''}发的是一张卡片（消息里只有一个 [卡片消息] 占位符），它的真实内容是：`);
  L.push(`· 来源：${card.source || '哔哩哔哩'}${card.app ? `（${card.app}）` : ''}｜B站视频`);
  if (info?.title || card.title) L.push(`· 标题：${info?.title || card.title}`);
  if (info?.up) {
    const bits = [`UP主：${info.up}`];
    if (info.durationSec) bits.push(`时长 ${fmtDuration(info.durationSec)}`);
    if (info.views) bits.push(`播放 ${fmtCount(info.views)}`);
    if (info.danmaku) bits.push(`弹幕 ${fmtCount(info.danmaku)}`);
    if (info.pages > 1) bits.push(`${info.pages}P`);
    L.push(`· ${bits.join(' ｜ ')}`);
  }
  if (info?.desc) L.push(`· 简介：${String(info.desc).slice(0, 400).replace(/\s*\n\s*/g, ' / ')}`);
  L.push(`· 链接：${info?.bvid ? `https://www.bilibili.com/video/${info.bvid}` : (card.url || '（无）')}`);
  if (frameNote) L.push(`· 画面：${frameNote}`);
  L.push('注意：上面是卡片/接口给出的信息 + 附带的画面截图，只代表这些内容；不要声称看完了整段视频，也不要凭标题编造视频里的情节。');
  const block = L.join('\n');

  stats.decoded += 1;
  stats.frames += images.length;
  stats.lastAt = Date.now();
  stats.lastSummary = `${info?.title || card.title || card.url || mid}`.slice(0, 80);
  if (mid) {
    cardCache.set(mid, { at: Date.now(), block, images, note: frameNote || 'ok' });
    if (cardCache.size > CACHE_MAX) {
      const oldest = [...cardCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cardCache.size - CACHE_MAX);
      for (const [k] of oldest) cardCache.delete(k);
    }
  }
  if (s.debug) api?.log?.(`还原卡片 mid=${mid}：${info?.title || card.title || ''}｜画面 ${images.length} 张`);
  return { block, images, note: frameNote || 'ok' };
}

function bufferMime(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF') return 'image/webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

/** 能不能给她看图：全局视觉开关 + 视觉探测结论 */
function canSeeImages(s = settings()) {
  let cfg = null;
  try { cfg = getConfig(); } catch { return false; }
  if (cfg?.api?.vision === false) return false;
  if (!s.attachFrames && !s.coverAsFallback) return false;
  return visionOk !== false;
}

// ══════════════════════════════════════════════════════════════════════════
// 六、视觉探测（决定敢不敢自动附图）+ 自检
// ══════════════════════════════════════════════════════════════════════════

/**
 * 探测当前模型收不收图片。
 * 已有结论（UI 的"视觉扫描"或内置资料表）直接用；否则自己发一条 1×1 图的极小请求，
 * 结果缓存到 status.json（7 天，模型换了就重测）。
 * 为什么值得花这一次请求：结论错了的代价是**每张卡片都让整轮对话 400 失败**。
 */
async function ensureVision(s = settings()) {
  if (visionProbed) return visionOk;
  visionProbed = true;
  let cfg = null;
  try { cfg = getConfig(); } catch { return null; }
  const provider = str(cfg?.api?.provider);
  const model = str(cfg?.api?.model);

  // 1) UI 的扫描结论 / 内置资料表
  try {
    const { modelImageVerdict } = await import('../../src/vision-scan.js');
    const known = modelImageVerdict(provider, model);
    if (known === 'vision' || known === 'no-vision') {
      visionOk = known === 'vision';
      // 明确说出来：否则"为什么不给她附图"在日志里毫无线索
      api?.log?.(`视觉结论：${model} ${visionOk ? '支持图片输入 —— 画面会附给她看' : '不支持图片输入 —— 只给文字，不附图'}（结论来自设置页扫描/内置资料表）`);
      if (s.writeStatus !== false) {
        writeJsonAtomic(STATUS_FILE, {
          ...(readJson(STATUS_FILE, {}) || {}),
          vision: { key: `${provider}|||${model}`, value: visionOk, verdict: known, note: 'settings-scan/docs', at: Date.now() }
        });
      }
      return visionOk;
    }
  } catch { /* 模块拿不到就自己探 */ }

  // 2) status.json 里的缓存（同一模型 7 天内不重复探）
  const st = readJson(STATUS_FILE, {}) || {};
  const cacheKey = `${provider}|||${model}`;
  if (st.vision?.key === cacheKey && Date.now() - (Number(st.vision.at) || 0) < 7 * 86400000) {
    visionOk = st.vision.value === true ? true : (st.vision.value === false ? false : null);
    return visionOk;
  }
  if (s.autoProbeVision === false) { visionOk = null; return visionOk; }

  // 3) 自己发一条最小请求
  try {
    const { detectModelVision } = await import('../../src/vision-scan.js');
    const r = await detectModelVision({ baseUrl: str(cfg?.api?.baseUrl), apiKey: resolveApiKey(cfg), model }, 15000);
    visionOk = r.verdict === 'vision' ? true : (r.verdict === 'no-vision' ? false : null);
    const next = { ...st, vision: { key: cacheKey, value: visionOk, verdict: r.verdict, note: String(r.note || '').slice(0, 200), at: Date.now() } };
    if (s.writeStatus !== false) writeJsonAtomic(STATUS_FILE, next);
    api?.log?.(`视觉探测：${model} → ${r.verdict}${r.note ? `（${String(r.note).slice(0, 60)}）` : ''}`);
  } catch (error) {
    lastError = `视觉探测失败：${error?.message ?? error}`;
    visionOk = null;
  }
  return visionOk;
}

/** 自检：Electron 原生裁图能不能用（每个版本跑一次就够） */
async function selfTest(s = settings()) {
  if (s.selfTest === 'off') return null;
  const st = readJson(STATUS_FILE, {}) || {};
  const version = readJson(path.join(HERE, 'plugin.json'), {})?.version || '0';
  if (s.selfTest === 'once' && st.selfTest?.version === version && st.selfTest?.cropOk !== undefined) {
    // 结论复用即可，**不要**在这里改 nativeImageMod：
    // 它用 null 表示"还没 import"，写成 undefined 会让后续 getNativeImage() 误判为不可用，
    // 于是真机上"切帧"会静默降级成整张快照图（正是最难查的那类问题）。
    return st.selfTest;
  }
  const out = { version, at: Date.now(), electron: false, cropOk: false, reason: '' };
  const nativeImage = await getNativeImage();
  if (!nativeImage) {
    out.reason = '拿不到 Electron nativeImage（非 Electron 环境或版本不支持）→ 降级为整张快照图';
  } else {
    out.electron = true;
    try {
      // ① 1×1 PNG（与 src/vision-scan.js 同一张）→ createFromBuffer → crop → toJPEG
      const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      const small = nativeImage.createFromBuffer(tiny);
      const c1 = small.crop({ x: 0, y: 0, width: 1, height: 1 });
      const j1 = c1.toJPEG(80);
      out.cropOk = Boolean(j1 && j1.length);

      // ② 放大到 320×180 再按 160×90 切一格 —— 与真实"雪碧图切帧"同一套动作
      const big = small.resize({ width: 320, height: 180 });
      const bigSize = big.getSize?.() || {};
      const cell = big.crop({ x: 0, y: 0, width: 160, height: 90 });
      const j2 = cell.toJPEG(88);

      // ③ 闭环：把切出来的 JPEG 再解码一次 —— 证明"JPEG 解码"这一环也没问题
      const back = (j2 && j2.length) ? nativeImage.createFromBuffer(j2) : null;
      const backSize = back?.getSize?.() || {};
      out.sliceOk = Boolean(j2 && j2.length && back && backSize.width === 160 && backSize.height === 90);
      out.sizes = { resized: `${bigSize.width}x${bigSize.height}`, frame: `${backSize.width}x${backSize.height}`, frameBytes: j2?.length || 0 };
      out.reason = (out.cropOk && out.sliceOk)
        ? `原生切帧可用（${out.sizes.resized} → 单帧 ${out.sizes.frame}，${out.sizes.frameBytes} 字节）`
        : `切帧自检异常：cropOk=${out.cropOk} sliceOk=${out.sliceOk}`;
    } catch (error) {
      out.reason = `切帧自检异常：${error?.message ?? error}`;
    }
  }
  if (s.writeStatus !== false) {
    writeJsonAtomic(STATUS_FILE, {
      ...st,
      version,
      at: Date.now(),
      model: `${str(getConfig()?.api?.provider)}|||${str(getConfig()?.api?.model)}`,
      selfTest: out,
      vision: st.vision || null
    });
  }
  api?.log?.(`自检：${out.reason}`);
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 七、钩子：发现（before-context）→ 注入（before-llm-messages）
// ══════════════════════════════════════════════════════════════════════════

/** 这条消息值不值得还原？返回 'card' | 'link' | null */
function classify(text, s = settings()) {
  const t = str(text);
  if (!t) return null;
  if (PLACEHOLDER_RE.test(t)) return 'card';
  if (s.enrichPlainLinks !== false && (B23_RE.test(t) || BILI_RE.test(t))) return 'link';
  return null;
}

export const hooks = {
  /**
   * 发现：本轮新消息里出现卡片（或 B站 链接）就去还原。
   * ⚠️ 钩子有 5 秒超时，所以这里全程按 hookBudgetMs 预算走，
   *    超时也把"已经拿到的部分"交给下一棒（文字优先，画面其次）。
   */
  async 'before-context'(ctx = {}) {
    try {
      const s = settings();
      if (s.enabled === false) return;
      const sessionId = str(ctx.sessionId);
      if (!sessionId) return;
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const picked = [];
      for (const e of entries) {
        if (!e || e.self) continue;
        if (classify(e.text, s)) picked.push(e);
        if (picked.length >= clamp(Number(s.maxCardsPerRun) || 2, 1, 6)) break;
      }
      if (!picked.length) return;

      const budget = clamp(Number(s.hookBudgetMs) || 4000, 800, 4500);
      const deadline = Date.now() + budget;
      const slot = { blocks: [], images: [], notes: [] };
      pending.set(sessionId, slot);   // 先登记：即使下面超时，也已注入的部分也能用

      const work = (async () => {
        for (const e of picked) {
          if (Date.now() > deadline - 300) { slot.notes.push('时间预算用完，剩下的卡片下一轮再说'); break; }
          try {
            const r = await decodeEntry(e, { s, deadline, onebot: ctx.onebot || null });
            if (r.block) slot.blocks.push(r.block);
            if (r.images?.length) slot.images.push(...r.images);
            if (!r.block) slot.notes.push(r.note || '卡片没解析出内容');
          } catch (error) {
            lastError = `还原失败：${error?.message ?? error}`;
            slot.notes.push(lastError);
          }
        }
      })();

      await Promise.race([work, new Promise((r) => setTimeout(r, budget + 150))]);
      const n = slot.blocks.length;
      if (n) api?.log?.(`已还原 ${n} 张卡片（画面 ${slot.images.length} 张），随本轮对话交给她`);
      else if (slot.notes.length) api?.warn?.(`卡片还原没成功：${slot.notes.join('；')}`);
    } catch (error) {
      lastError = `before-context 异常：${error?.message ?? error}`;
      api?.warn?.(lastError);
    }
  },

  /**
   * 注入：把还原结果接在这一轮 user 消息的末尾。
   * 画面以 image_url 部件随同发送（llm.js 会把 messages 原样发给模型，
   * 并因检测到图片部件而切到"图片输入专用模型"）。
   */
  async 'before-llm-messages'(ctx = {}) {
    try {
      const s = settings();
      if (s.enabled === false) return;
      const sessionId = str(ctx.sessionId);
      const slot = sessionId ? pending.get(sessionId) : null;
      if (!slot) return;
      pending.delete(sessionId);
      if (!slot.blocks.length) return;
      const messages = Array.isArray(ctx.messages) ? ctx.messages : null;
      if (!messages || !messages.length) return;

      const text = slot.blocks.join('\n\n');
      const last = messages[messages.length - 1];
      if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
      if (!Array.isArray(last.content)) last.content = [{ type: 'text', text: String(last.content ?? '') }];
      last.content.push({ type: 'text', text });

      const useImages = canSeeImages(s) && slot.images.length;
      const images = useImages ? slot.images.slice(0, 12) : [];
      if (images.length) {
        for (const url of images) last.content.push({ type: 'image_url', image_url: { url } });
        api?.log?.(`本轮附了 ${images.length} 张画面给她看`);
      } else if (slot.images.length) {
        last.content.push({ type: 'text', text: '（这次拿到了画面，但当前模型看不了图，所以只给文字。）' });
      }
      stats.injected += 1;
    } catch (error) {
      lastError = `before-llm-messages 异常：${error?.message ?? error}`;
      api?.warn?.(lastError);
    }
  }
};

// ══════════════════════════════════════════════════════════════════════════
// 八、生命周期
// ══════════════════════════════════════════════════════════════════════════

export function setup(a) {
  api = a;
  // 工具必须在 setup 里注册（加载器只收集这一步注册的工具；manifest.tools[] 只是元数据）
  try { registerCardTool(a); } catch (error) { lastError = `注册工具失败：${error?.message ?? error}`; }
}

export async function activate() {
  try {
    cleanupTemp();                                   // 不留任何临时文件（本实现本就不写，这是保险）
    const s = settings();
    if (s.enabled === false) {
      api?.log?.('卡片还原：设置里是关闭状态');
      return;
    }
    const cfg = (() => { try { return getConfig(); } catch { return null; } })();
    api?.log?.(`已启用：卡片还原（B站视频卡片 / 小程序卡片 / 网页卡片）`
      + ` · 画面 ${s.attachFrames !== false ? `最多 ${clamp(Number(s.maxFrames) || 6, 1, 12)} 张` : '关闭'}`
      + ` · 一轮最多 ${clamp(Number(s.maxCardsPerRun) || 2, 1, 6)} 张 · 预算 ${clamp(Number(s.hookBudgetMs) || 4000, 800, 4500)}ms`
      + ` · 纯链接补全 ${s.enrichPlainLinks !== false ? '开' : '关'}`
      + ` · 模型 ${str(cfg?.api?.model)}`);
    // 自检 + 视觉探测都放到后台，不拖慢启动
    setTimeout(() => { selfTest(s).catch(() => {}); }, 1500)?.unref?.();
    setTimeout(() => { ensureVision(s).catch(() => {}); }, 2600)?.unref?.();
  } catch (error) {
    lastError = `activate 异常：${error?.message ?? error}`;
    api?.warn?.(lastError);
  }
}

export function deactivate() {
  pending.clear();
  cleanupTemp();
}

export function available() {
  if (settings().enabled === false) return { ok: false, reason: '在插件设置里被关闭了' };
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// 九、能力与工具
// ══════════════════════════════════════════════════════════════════════════

export const providers = {
  /** 手动还原一条消息里的卡片/链接（排障、UI、其它技能都可以用） */
  'card.decode': async (args = {}) => {
    const s = settings();
    const mid = str(args.messageId ?? args.mid ?? '');
    if (!mid) return { ok: false, error: '需要 messageId' };
    try {
      const r = await decodeEntry(
        { mid, text: str(args.text), senderName: str(args.senderName) },
        { s, deadline: Date.now() + 15000, onebot: args.onebot || null, forceFrames: Number(args.frames) || 0 }
      );
      return { ok: Boolean(r.block), block: r.block, images: r.images.length, note: r.note, cached: Boolean(r.cached) };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  },

  /** 状态：设置、视觉结论、原生裁图自检、缓存与统计 */
  'card.status': async () => {
    const s = settings();
    const st = readJson(STATUS_FILE, {}) || {};
    return {
      ok: true,
      settings: s,
      model: (() => { try { const c = getConfig(); return `${str(c?.api?.provider)}|||${str(c?.api?.model)}`; } catch { return ''; } })(),
      vision: { verdict: visionOk === true ? 'vision' : (visionOk === false ? 'no-vision' : 'unknown'), cached: st.vision || null },
      selfTest: st.selfTest || null,
      nativeImage: (await getNativeImage()) ? 'available' : 'unavailable',
      cache: { cards: cardCache.size, pending: pending.size },
      stats,
      lastError
    };
  }
};

/** 工具：让她主动去看旧消息里的卡片/链接（自动注入只覆盖"本轮新消息"） */
function registerCardTool(a) {
  a.registerTool({
      id: 'card_open',
      name: '打开卡片内容',
      category: 'query',
      icon: '🃏',
      description: '把群友转发的卡片读出来：B站视频卡片 / QQ小程序卡片 / 网页卡片，或消息里的 B站 链接。'
        + '返回标题、UP主、时长、播放量、简介、真实链接，并把**视频的真实画面截图**一起给你看。'
        + '当消息里出现 [卡片消息] 而你想知道它到底是个什么视频、或有人发了 B站 链接让你看看内容、'
        + '或需要确认较早的一条卡片消息时使用。参数 messageId 用聊天记录里那条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条卡片/链接消息的 QQ 消息 id（聊天记录里的 #数字）' },
          frames: { type: ['integer', 'string'], description: '可选：这次要几张画面（1~12），不传用插件设置里的默认值' }
        },
        required: ['messageId']
      },
      async execute(ctx, args = {}) {
        const s = settings();
        if (s.enabled === false) return { content: '卡片还原功能已关闭。', isError: true };
        const entry = ctx?.store?.findByMid?.(ctx.chatKey, args.messageId) || null;
        const text = entry ? String(entry.text || '') : '';
        try {
          const r = await decodeEntry(
            { mid: str(args.messageId), text, senderName: str(entry?.senderName) },
            { s, deadline: Date.now() + 15000, onebot: ctx?.onebot || null, forceFrames: Number(args.frames) || 0 }
          );
          if (!r.block) return { content: `没读出这条消息的卡片内容（${r.note || '未知原因'}）。`, isError: true };
          const useImages = canSeeImages(s) && r.images.length;
          if (!r.images.length || !useImages) {
            return { content: r.block + (r.images.length && !useImages ? '\n（拿到了画面，但当前模型看不了图。）' : '') };
          }
          return {
            content: [
              { type: 'text', text: r.block },
              ...r.images.slice(0, 12).map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
          };
        } catch (error) {
          return { content: `读卡片失败：${error?.message ?? error}`, isError: true };
        }
      }
  });
}

// 导出给测试/排障用（核心不消费）
export const __internal = {
  parseCardJson, parseCardXml, parseCardFromSegments, pickBiliRef, biliView, biliVideoshot,
  decodeEntry, classify, canSeeImages, sliceFrames, cleanupTemp, STATUS_FILE, DEFAULTS
};
