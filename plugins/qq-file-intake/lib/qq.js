// QQ 侧：把「某条消息里的那个文件」从腾讯服务器取到本地。
//
// ── 真机协议（SnowLuma 1.14.x，别照 OneBot 文档想当然）──────────────────
// 收到的文件消息里，file 段的 data 形如：
//   { file:'计费说明.txt', name:'计费说明.txt', file_id:'<uuid>_<uuid>',
//     file_size:9602, size:9602, id:'…', file_hash:'…', url:'http://…/qqdownloadftnv5?…' }
//   · `url` 是**当时**的直链，实测 2 天前的私聊文件仍然能下（不是图片那种 7 分钟）。
//     但不要指望它，`get_group_file_url` / `get_private_file_url` 才是标准换新链接的路。
//   · 私聊：get_private_file_url({ user_id, file_id, file_hash })
//     群聊：get_group_file_url({ group_id, file_id })
//   · get_msg 能取回**当时的消息副本**（SnowLuma 存着），所以文件链接过期了也还能
//     靠 message_id 重新解析 —— 这就是「\入库 文件名」能补捞几天前那个文件的原因。
//
// 本模块不自己 new OneBotClient：钩子/指令的 ctx 里就有核心那个连好的实例
// （ctx.onebot），用它的令牌与 httpUrl 最不容易出岔子。

import fs from 'node:fs';
import path from 'node:path';
import { parseFileMarkers, nameMatchScore, baseOf } from './logic.js';

/** 一条消息的所有 file 段（对象形态）。 */
export function fileSegmentsOf(getMsgData) {
  const msg = getMsgData?.message;
  const segs = Array.isArray(msg) ? msg : [];
  return segs.filter((s) => s && s.type === 'file' && s.data);
}

/** 把一个 file 段整理成我们要的形状。 */
export function normalizeFileSeg(seg) {
  const d = seg?.data ?? {};
  const name = String(d.name ?? d.file ?? d.filename ?? '').trim();
  const fileId = String(d.file_id ?? d.id ?? '').trim();
  const fileHash = String(d.file_hash ?? d.fileHash ?? '').trim();
  const url = String(d.url ?? '').trim();
  const size = Number(d.file_size ?? d.size ?? 0) || 0;
  return { name, fileId, fileHash, url, size };
}

/**
 * 从一条消息里挑出目标文件段。
 * @param {object} getMsgData get_msg 的返回
 * @param {string} wantName   聊天文本里那个 `[文件xxx]` 的名字（空 = 取第一个）
 */
export function pickFileSeg(getMsgData, wantName = '') {
  const all = fileSegmentsOf(getMsgData).map(normalizeFileSeg).filter((x) => x.fileId || x.url);
  if (!all.length) return null;
  const want = String(wantName || '').trim();
  if (!want) return all[0];
  let best = null;
  let bestScore = 0;
  for (const f of all) {
    const score = Math.max(nameMatchScore(want, f.name), nameMatchScore(baseOf(want), baseOf(f.name)));
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best || all[0];
}

/**
 * 换一个新直链。优先用段里自带的 url；没有（或明显失效）再去问 OneBot。
 * @returns {Promise<string>} 直链（拿不到返回 ''）
 */
export async function resolveFileUrl(o = {}) {
  const { onebot, kind, chatId, senderId, seg } = o;
  if (seg?.url) return seg.url;
  if (!onebot || typeof onebot.call !== 'function') return '';
  const fileId = String(seg?.fileId || '');
  if (!fileId) return '';
  try {
    if (kind === 'group') {
      const r = await onebot.call('get_group_file_url', { group_id: Number(chatId), file_id: fileId });
      return String(r?.url || '');
    }
    // 私聊：user_id 用**发文件那个人**（SnowLuma 的 getPrivateUrl 就是这么用的）
    const r = await onebot.call('get_private_file_url', {
      user_id: Number(senderId || 0),
      file_id: fileId,
      file_hash: String(seg?.fileHash || '')
    });
    return String(r?.url || '');
  } catch (error) {
    o.onWarn?.(`换直链失败：${error?.message ?? error}`);
    return '';
  }
}

/**
 * 下载到指定路径（走核心 safe-fetch：SSRF 校验 + 逐跳重定向 + 边收边写盘）。
 * fetchToFile 由调用方注入（核心的 safeFetchBinaryToFile），这样本模块能离线测。
 */
export async function downloadToFile(o = {}) {
  const { url, dest, maxBytes, timeoutMs = 30000, fetchToFile } = o;
  if (!url) return { ok: false, reason: '没有可用的下载地址' };
  if (typeof fetchToFile !== 'function') return { ok: false, reason: '下载器不可用（safe-fetch 没拿到）' };
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const r = await fetchToFile(url, dest, maxBytes, { timeoutMs });
    return { ok: true, bytes: Number(r?.bytes) || 0, contentType: String(r?.contentType || '') };
  } catch (error) {
    return { ok: false, reason: `下载失败：${error?.message ?? error}` };
  }
}

/**
 * 把一条消息里的文件下载到 dir。
 *
 * @returns {Promise<{ok:boolean, name?:string, file?:string, bytes?:number, reason?:string, tooBig?:boolean}>}
 */
export async function downloadMessageFile(o = {}) {
  const {
    onebot, kind, chatId, senderId, mid, wantName, dir,
    maxBytes, timeoutMs = 30000, fetchToFile, writeIntoInbox, onWarn
  } = o;
  if (!onebot || typeof onebot.call !== 'function') return { ok: false, reason: 'OneBot 通道不可用' };
  if (mid == null || String(mid) === '') return { ok: false, reason: '这条消息没有可用 id（拿不到文件信息）' };

  let data;
  try {
    data = await onebot.call('get_msg', { message_id: Number(mid) });
  } catch (error) {
    return { ok: false, reason: `取消息失败：${error?.message ?? error}` };
  }

  const seg = pickFileSeg(data, wantName);
  if (!seg) return { ok: false, reason: '这条消息里没有文件段（可能是转发文件或已被撤回）' };

  const name = seg.name || String(wantName || '') || '文件';
  if (seg.size > 0 && seg.size > maxBytes) {
    return { ok: false, tooBig: true, name, bytes: seg.size, reason: `文件 ${Math.round(seg.size / 1048576)}MB，超过上限 ${Math.round(maxBytes / 1048576)}MB` };
  }

  const url = await resolveFileUrl({ onebot, kind, chatId, senderId, seg, onWarn });
  if (!url) return { ok: false, name, reason: '拿不到下载链接（QQ 那边可能已经过期或文件被删除）' };

  // 先落到临时文件再改名：中途失败时不会在收件箱里留半截文件被当成"已下载"
  const tmp = path.join(dir, `.downloading-${Date.now()}-${process.pid}`);
  const dl = await downloadToFile({ url, dest: tmp, maxBytes, timeoutMs, fetchToFile });
  if (!dl.ok) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, name, reason: dl.reason };
  }
  if (seg.size > 0 && Math.abs(dl.bytes - seg.size) > 8) {
    onWarn?.(`下载字节数与文件大小不一致（${dl.bytes} vs ${seg.size}），仍然保留`);
  }
  let saved;
  try {
    saved = writeIntoInbox(dir, name, fs.readFileSync(tmp));
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, name, reason: `落盘失败：${error?.message ?? error}` };
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  return { ok: true, name: saved.name, file: saved.file, bytes: saved.bytes };
}

/**
 * 在聊天存档里找"文件名像 needle 的文件消息"（补捞用）。
 *
 * 用途：文件到的时候插件没在跑（或插件是后装的），图床/直链早失效了 —— 但 QQ 那边
 * 文件还在，凭 message_id 重新换链接就能补下来。命令 `\入库 文件名` 走这条路。
 *
 * @param {Array} entries 消息条目数组（store.recent 或存档 JSON 里的 messages）
 */
export function findFileMessages(entries, { needle = '', limit = 300 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const from = Math.max(0, list.length - Math.max(1, limit));
  const hits = [];
  for (let i = list.length - 1; i >= from; i -= 1) {
    const m = list[i];
    if (!m || m.self) continue;
    const markers = parseFileMarkers(m.text);
    if (!markers.length) continue;
    for (const mk of markers) {
      const score = needle ? nameMatchScore(needle, mk.name) : 1;
      if (!score) continue;
      hits.push({ mid: m.mid ?? null, name: mk.name, ts: Number(m.ts) || 0, senderId: String(m.senderId ?? ''), score });
    }
  }
  hits.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
  return hits;
}

/** 直接读某个会话的存档文件（拿不到 ctx.store 时的兜底）。 */
export function loadChatMessages(messagesDir, chatKey, { limit = 400 } = {}) {
  const safe = String(chatKey ?? '').replace(/[^a-z0-9_]/gi, '_');
  const file = path.join(messagesDir, `${safe}.json`);
  try {
    const text = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    const msgs = Array.isArray(j?.messages) ? j.messages : [];
    return msgs.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}
