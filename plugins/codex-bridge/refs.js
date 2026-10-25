// 参考图 + 画图前的资料查找（从 index.js 拆出来）：
//   参考图库（ref_image_get / ref_image_save）、知识库别名、网图参考、每轮开始前的"画图请求预取"。
// 依赖 index.js 的 settings / ownerIds 由 bindRefs() 注入。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { logger } from '../../src/logger.js';

const ID = 'codex-bridge';
const KB_DIR = path.join(DATA_DIR, 'knowledge-base');
const G = globalThis.__codexBridge ??= { running: new Map(), state: null };
let deps = { settings: () => ({}), ownerIds: () => [] };
export function bindRefs(d) { deps = { ...deps, ...d }; }

// ── 参考图库：画具体角色 / 梗之前先看参考图 ─────────────────────────────
// 生图模型不认识"奶龙""奶蛙"这类国产 / 圈内形象，光靠文字描述会画成黄色小恐龙、真青蛙。
// 所以形象以图为准：data/knowledge-base/refs/index.json 记 词条 → 别名 / 外形要点 / 参考图文件，
// 画之前 ref_image_get 把图看进上下文（生图时就能照着画）；有人发图纠正时 ref_image_save 存下来。
const REF_DIR = path.join(KB_DIR, 'refs');
const REF_INDEX = path.join(REF_DIR, 'index.json');
const REF_MAX_FILES = 6;
const readRefs = () => { try { return JSON.parse(fs.readFileSync(REF_INDEX, 'utf8')) || {}; } catch { return {}; } };
const refKey = (s) => String(s || '').trim().toLowerCase();
function findRef(refs, term) {
  const t = refKey(term);
  if (!t) return null;
  const names = (k, v) => [k, ...(v.aliases || [])].map(refKey);
  for (const [k, v] of Object.entries(refs)) if (names(k, v).includes(t)) return k;
  // 模糊：「奶龙表情包」「画个奶蛙」也认
  for (const [k, v] of Object.entries(refs)) if (names(k, v).some((n) => n.length >= 2 && (t.includes(n) || n.includes(t)))) return k;
  return null;
}
const imgMime = (buf, file = '') => (buf[0] === 0x89 ? 'image/png' : buf.toString('ascii', 0, 3) === 'GIF' ? 'image/gif'
  : (buf.toString('ascii', 8, 12) === 'WEBP' || /\.webp$/i.test(file)) ? 'image/webp' : 'image/jpeg');

// 知识库 learned/*.md 里按词条名 / **别名** 精确找（"三角初音"是"三角初华"的别名这种）
function kbAliasHit(term) {
  const t = refKey(term).replace(/\s+/g, '');
  if (t.length < 2) return null;
  const dir = path.join(KB_DIR, 'learned');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return null; }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000); } catch { continue; }
    const name = (text.match(/^#\s+(.+)$/m)?.[1] || f.replace(/\.md$/, '')).trim();
    const aliases = (text.match(/\*\*别名\*\*[：:](.*)/)?.[1] || '').split(/[、,，]/).map((a) => a.replace(/[（(].*?[）)]/g, '').trim()).filter(Boolean);
    if (![name, ...aliases].some((a) => refKey(a).replace(/\s+/g, '') === t)) continue;
    return {
      name,
      aliases,
      file: path.join(dir, f),
      oneLine: (text.match(/\*\*一句话\*\*[：:](.*)/)?.[1] || '').trim(),
      topic: (text.match(/\*\*所属专题\*\*[：:](.*)/)?.[1] || '').replace(/企划|专题/g, '').trim()
    };
  }
  return null;
}

// 搜几张网图、下载成 data URL 给模型看；失败就返回空，不影响后面的提示。
// 来源页标题里提到 names（名字 / 别名）的排前面：同名的别的东西、蹭关键词的图，标题多半对不上
async function webRefImages(query, names = [], max = 3) {
  const out = [];
  try {
    const { searchImages } = await import('../../src/web-search.js');
    const { safeFetchBinary, browseLockState } = await import('../../src/safe-fetch.js');
    const browseLocked = browseLockState().enabled;
    const list = await searchImages(query, { limit: 12, browseLocked });
    const flat = (x) => refKey(x).replace(/\s+/g, '');
    const want = names.map(flat).filter((n) => n.length >= 2);
    const rel = (r) => Boolean(r.title) && want.some((n) => flat(r.title).includes(n));
    for (const r of [...list.filter(rel), ...list.filter((r) => !rel(r))]) {
      if (out.length >= max) break;
      try {
        const { buffer } = await safeFetchBinary(String(r.url), 4 * 1024 * 1024, { timeoutMs: 10000, browseLocked });
        // 只收真图片（JPEG / PNG / GIF / WEBP 文件头）：搜图结果里偶尔混着商品页、网页
        const isImg = buffer?.length > 2000 && (buffer[0] === 0xff && buffer[1] === 0xd8 || buffer[0] === 0x89
          || buffer.toString('ascii', 0, 3) === 'GIF' || buffer.toString('ascii', 8, 12) === 'WEBP');
        if (!isImg) continue;
        out.push({ url: String(r.url), title: String(r.title || '').slice(0, 50), page: r.page || '', matched: r.title ? rel(r) : null, dataUrl: `data:${imgMime(buffer, String(r.url))};base64,${buffer.toString('base64')}` });
      } catch { /* 这张下不了，换下一张 */ }
    }
  } catch (e) { logger.warn(ID, `参考图自动搜图失败：${e?.message ?? e}`); }
  return out;
}

/**
 * 画「term」之前要看的参考一次查齐：参考图库 → 知识库别名 → 网图。
 * ref_image_get 工具和"画图请求预取"共用，返回 { text, images: [dataUrl] }。
 */
async function lookupDrawRef(term) {
  term = String(term || '').trim();
  const refs = readRefs();
  const key = findRef(refs, term);
  if (key) {
    const r = refs[key];
    const images = [];
    const paths = [];
    for (const rel of (r.files || []).slice(-3)) {
      const p = path.join(REF_DIR, rel);
      try {
        const buf = fs.readFileSync(p);
        images.push(`data:${imgMime(buf, p)};base64,${buf.toString('base64')}`);
        paths.push(p);
      } catch { /* 文件被删了：跳过 */ }
    }
    const text = `「${key}」的参考图 ${images.length} 张${r.aliases?.length ? `（别名：${r.aliases.join('、')}）` : ''}。外形要点：${r.note || '（没写，以图为准）'}`
      + `\n画的时候严格照这几张图的形象画（颜色、脸、身体比例、标志特征），只改动作 / 场景 / 表情；本地文件：${paths.join('；')}`;
    return { found: 'ref', text, images };
  }
  // 光提示"先联网查"它常常跳过、直接问群友要图——没参考图时自己往下挖一层：查知识库别名、搜几张网图给它看
  const kb = kbAliasHit(term);
  // 关键词别太长，图搜会跑偏：知识库有就用 词条名 + 所属专题
  const pics = await webRefImages(kb ? `${kb.name} ${kb.topic}`.trim() : term, kb ? [kb.name, term, ...kb.aliases] : [term]);
  const lines = [`参考图库里没有「${term}」。`];
  if (kb) lines.push(`本地知识库有这个：「${kb.name}」（${kb.file}）——${kb.oneLine.replace(/[。.]$/, "")}${kb.name !== term ? `。「${term}」是它的别名，别当成别的东西` : ''}`);
  if (pics.length) {
    lines.push(`按「${kb ? kb.name : term}」自动搜到 ${pics.length} 张网图，按顺序附在后面（网上搜的不一定准，先看来源标题）：`);
    pics.forEach((p, i) => lines.push(`  ${i + 1}. ${p.matched === null ? '没有来源标题，自己看图判断' : `来源标题「${p.title}」${p.matched ? '（提到了这个名字）' : '（没提到这个名字，可能是别的东西）'}`}${p.page ? ` ${p.page}` : ''}`));
    lines.push('先用联网搜索核实它是谁、长什么样，再对照这几张图；对得上就照图画。对不上就换关键词（全名 / 日文或英文名 / 作品名+角色名）用 search_images 再搜，自己搜两三轮都确认不了才问对方要图。');
  } else lines.push('自动搜图没搜到：先用联网搜索查清楚它是谁、长什么样，换关键词用 search_images 搜图；自己搜两三轮都确认不了才问对方要图。');
  lines.push('对方发了图、说"就是这个"之后，用 ref_image_save 存进来，下次就不会画错。');
  return { found: kb ? 'kb' : (pics.length ? 'web' : 'none'), text: lines.join('\n'), images: pics.map((p) => p.dataUrl) };
}

const REF_GET_TOOL = {
  id: 'ref_image_get',
  name: '看参考图',
  category: 'query',
  icon: '🖼️',
  requiresVision: true,
  description: '画具体的角色 / 梗 / 形象（奶龙、奶蛙、某个动漫角色、群里的某个梗图……）之前必须先调它，看参考图长什么样；'
    + '有参考图就照参考图画，形象以图为准，文字只是补充。没有参考图时会自动查知识库、搜几张网图给你看，你再联网核实，还拿不准才问对方要一张图，别凭名字瞎画。'
    + '不填 term 返回参考图库里有哪些词条。',
  parameters: {
    type: 'object',
    properties: { term: { type: 'string', description: '要画的东西的名字，比如「奶蛙」' } }
  },
  async execute(ctx, args = {}) {
    if (!String(args.term || '').trim()) {
      const all = Object.keys(readRefs());
      return { content: all.length ? `参考图库现有：${all.join('、')}` : '参考图库还是空的' };
    }
    const r = await lookupDrawRef(args.term);
    return { content: [{ type: 'text', text: r.text }, ...r.images.map((url) => ({ type: 'image_url', image_url: { url } }))] };
  }
};

// ── 画图请求预取：别指望它自觉先查 ─────────────────────────────────────────
// 规则写了"画之前先 ref_image_get / 联网查"，它还是常常凭名字直接画、或者张口问人要图。
// 所以这一轮开始前，程序自己从找它的消息里认出"画 X"，把 X 的参考（参考图库 → 知识库别名 → 网图）查好，
// 连图一起放进这一轮的输入：它一睁眼就看得到，绕不过去。
const DRAW_LEAD = /(?:^|给我|帮我|帮忙|麻烦|你|再|来|请|能不能|可以|能|会不会|去|快)\s*画/;
const DRAW_SUBJECT = /画(?:一下|一?[张个只幅副份]|点)?\s*(?:[张个只幅]?图)?\s*[把给]?\s*([^\s，。,.!！?？@\[\]（）()]{1,24})/;
const DRAW_NOT_SUBJECT = /^(?:风|面|质|师|家|册|展|廊|板|技|功|工|得|的|画|了|过|完|好|吗|呢|啊|吧)|头像|^(?:我|你|他|她|它|这|那)/;
const DRAW_PREFETCH_TTL = 20 * 60 * 1000;

function drawSubjects(text) {
  const t = String(text || '').replace(/\[引用[^\]]*\]/g, ' ').replace(/@\S+/g, ' ').trim();
  if (!DRAW_LEAD.test(t)) return [];
  const m = t.match(DRAW_SUBJECT);
  if (!m) return [];
  const subject = m[1].replace(/(?:的(?:图|样子|画|立绘)|吧|呗|呢|啊|呀|嘛|吗|么|不|好吗|给我|看看|出来)+$/, '').trim();
  if (subject.length < 2 || DRAW_NOT_SUBJECT.test(subject)) return [];
  return [subject];
}

async function drawPrefetch(sessionId, chatKey) {
  const orch = G.orch;
  const sess = orch?.sessions?.current?.get?.(sessionId);
  if (!sess) return null;
  const s = deps.settings();
  const selfId = String(orch.onebot?.selfId || '');
  const isPrivate = String(chatKey).startsWith('private:');
  const subjects = [];
  for (const e of sess.trigger || []) {
    if (!e || e.self) continue;
    // 只管正经找它的：私聊、@ 它、引用它
    if (!isPrivate && !e.atMe && !(selfId && String(e.text || '').includes(`(QQ:${selfId})`))) continue;
    // 群友不让画图时就别查了
    if (!deps.ownerIds().includes(String(e.senderId)) && !s.publicImageGen) continue;
    for (const sub of drawSubjects(e.text)) if (!subjects.some((x) => x.sub === sub)) subjects.push({ sub, e });
  }
  if (!subjects.length) return null;
  G.drawRefCache ||= new Map();
  const now = Date.now();
  const parts = await Promise.all(subjects.slice(0, 3).map(async ({ sub, e }) => {
    const hit = G.drawRefCache.get(sub);
    let r = hit && now - hit.at < DRAW_PREFETCH_TTL ? hit.r : null;
    if (!r) {
      r = await Promise.race([lookupDrawRef(sub), new Promise((res) => setTimeout(() => res(null), 25000))]);
      if (!r) return null;
      G.drawRefCache.set(sub, { at: now, r });
      if (G.drawRefCache.size > 50) G.drawRefCache.delete(G.drawRefCache.keys().next().value);
    }
    return { sub, e, r: { ...r, images: r.images.slice(0, subjects.length > 1 ? 2 : 3) } };
  }));
  const ok = parts.filter(Boolean);
  if (!ok.length) return null;
  const images = [];
  const lines = ['【画图请求 · 系统已经替你查好了参考】这一轮有人要你画图。下面每一项的参考图按顺序附在这条输入最后面（排在聊天里的图之后）：'];
  for (const { sub, e, r } of ok) {
    lines.push(`· ${e.senderName || e.senderId}（#${e.mid ?? '?'}）要画「${sub}」，附 ${r.images.length} 张参考图（第 ${images.length + 1}~${images.length + r.images.length} 张）：`);
    lines.push(r.text.split('\n').map((l) => `  ${l}`).join('\n'));
    images.push(...r.images);
  }
  lines.push('照这些参考画；参考来自网上搜的就先联网核实再动笔。开画前回一句"等我画一下"并引用点图的那条，几个人点图就一张一张来。');
  logger.info(ID, `${chatKey} 画图请求预取：${ok.map((x) => `「${x.sub}」${x.r.found}/${x.r.images.length}张`).join('、')}`);
  return { text: lines.join('\n'), images };
}

const REF_SAVE_TOOL = {
  id: 'ref_image_save',
  name: '存参考图',
  category: 'memory',
  icon: '📌',
  description: '把聊天里某条消息的图存成某个词条的参考图（下次画它时 ref_image_get 就能看到）。'
    + '有人发图告诉你"这才是 X""X 长这样"、或者你画错被纠正并给了图时用。只存确实是这个形象的图，别存无关的图。'
    + 'messageId 用聊天记录里那条图片消息的 #数字；note 写一句外形要点（会覆盖原来的要点，没把握就不填）。',
  parameters: {
    type: 'object',
    properties: {
      term: { type: 'string', description: '词条名，比如「奶蛙」' },
      messageId: { type: ['integer', 'string'], description: '图片消息的 #数字' },
      aliases: { type: 'array', items: { type: 'string' }, description: '可选：别名' },
      note: { type: 'string', description: '可选：外形要点（一两句）' }
    },
    required: ['term', 'messageId']
  },
  async execute(ctx, args = {}) {
    const term = String(args.term || '').trim().slice(0, 30);
    if (!term) return { content: 'term 不能为空', isError: true };
    const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
    if (!entry) return { content: `找不到消息 ${args.messageId}`, isError: true };
    const imgs = (entry.media || []).filter((m) => m?.kind === 'image' && (m.url || (entry.self && m.file)));
    if (!imgs.length) return { content: `消息 ${args.messageId} 里没有图`, isError: true };
    const refs = readRefs();
    const key = findRef(refs, term) || term;
    const r = refs[key] || { aliases: [], note: '', files: [] };
    const dir = key.replace(/[\\/:*?"<>|]/g, '_');
    fs.mkdirSync(path.join(REF_DIR, dir), { recursive: true });
    const { safeFetchBinary } = await import('../../src/safe-fetch.js');
    let saved = 0;
    for (const m of imgs.slice(0, 3)) {
      try {
        const buf = entry.self && m.file && !/^https?:/i.test(m.file)
          ? fs.readFileSync(String(m.file).replace(/^file:\/\/\/?/i, ''))
          : (await safeFetchBinary(m.url, 10 * 1024 * 1024, { timeoutMs: 20000 })).buffer;
        if (!buf?.length) continue;
        const ext = imgMime(buf, m.file).split('/')[1].replace('jpeg', 'jpg');
        const rel = `${dir}/${Date.now()}-${saved}.${ext}`;
        fs.writeFileSync(path.join(REF_DIR, rel), buf);
        r.files.push(rel);
        saved += 1;
      } catch (e) { logger.warn(ID, `存参考图失败：${e?.message ?? e}`); }
    }
    if (!saved) return { content: '图没下载下来（链接可能过期了），让对方再发一次', isError: true };
    r.files = r.files.slice(-REF_MAX_FILES);
    for (const a of args.aliases || []) if (a && !r.aliases.includes(String(a))) r.aliases.push(String(a).slice(0, 30));
    if (args.note) r.note = String(args.note).slice(0, 300);
    r.updatedAt = Date.now();
    r.by = String(ctx.session?.trigger?.slice(-1)[0]?.senderId || '');
    refs[key] = r;
    fs.mkdirSync(REF_DIR, { recursive: true });
    fs.writeFileSync(REF_INDEX, JSON.stringify(refs, null, 1), 'utf8');
    logger.info(ID, `${ctx.chatKey} 参考图库「${key}」新增 ${saved} 张`);
    return { content: `已存为「${key}」的参考图（${saved} 张，现在共 ${r.files.length} 张）。下次画「${key}」先 ref_image_get 看图。` };
  }
};

export { REF_GET_TOOL, REF_SAVE_TOOL, drawPrefetch, drawSubjects, lookupDrawRef, kbAliasHit, imgMime };
