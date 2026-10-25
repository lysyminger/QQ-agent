// 查资料 / 听视频的两个工具（从 index.js 拆出来）：B 站专栏（bili_article）、听视频（video_listen）。
// 依赖 index.js 的 settings 由 bindMediaTools() 注入。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../src/config.js';
import { imgMime } from './refs.js';

const ID = 'codex-bridge';
const STATE_DIR = path.join(DATA_DIR, ID);
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const G = globalThis.__codexBridge ??= { running: new Map(), state: null };
let deps = { settings: () => ({}) };
export function bindMediaTools(d) { deps = { ...deps, ...d }; }

// ── B 站专栏：二次元角色 / 梗的资料和图，B 站专栏常常比百科全 ───────────────
const BILI_ARTICLE_TOOL = {
  id: 'bili_article',
  name: 'B站专栏',
  category: 'query',
  icon: '📰',
  requiresVision: true,
  description: '搜 / 读 B 站专栏。二次元的东西（动漫 / 游戏角色、声优、企划、圈内梗、同人设定）B 站专栏的资料和图往往比百科全，'
    + '查这类东西时除了联网搜索，也用它搜一下。填 keyword 搜专栏（返回标题、摘要、链接）；填 id（cv 号或专栏链接）读正文和配图。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜什么，比如「四宫宁月」「三角初华 设定」' },
      id: { type: 'string', description: '要读的专栏：cv 号（48747698）或链接' }
    }
  },
  async execute(ctx, args = {}) {
    try {
      const ws = await import('../../src/web-search.js');
      const { browseLockState, safeFetchBinary } = await import('../../src/safe-fetch.js');
      const browseLocked = browseLockState().enabled;
      if (String(args.id || '').trim()) {
        const a = await ws.biliArticleRead(args.id, { browseLocked });
        const parts = [];
        for (const u of a.images.slice(0, 4)) {
          try {
            const { buffer } = await safeFetchBinary(u, 4 * 1024 * 1024, { timeoutMs: 10000, browseLocked, headers: { referer: 'https://www.bilibili.com/' } });
            if (buffer?.length > 2000) parts.push({ type: 'image_url', image_url: { url: `data:${imgMime(buffer, u)};base64,${buffer.toString('base64')}` } });
          } catch { /* 这张下不了 */ }
        }
        const text = `专栏「${a.title}」（作者 ${a.author || '未知'}，${a.url}）\n${a.text || '（正文为空）'}`
          + `\n\n配图 ${a.images.length} 张${parts.length ? `，前 ${parts.length} 张附在后面` : ''}：${a.images.slice(0, 8).join(' ')}`
          + '\n专栏是网友写的，设定类内容可能是推测或二创，和官方资料对一下再当真。';
        return { content: [{ type: 'text', text }, ...parts] };
      }
      const kw = String(args.keyword || '').trim();
      if (!kw) return { content: '填 keyword 搜专栏，或者填 id 读一篇', isError: true };
      const list = await ws.biliArticleSearch(kw, { limit: 8, browseLocked });
      if (!list.length) return { content: `B 站专栏没搜到「${kw}」，换个关键词（全名 / 作品名）再试` };
      return { content: `B 站专栏搜「${kw}」：\n${list.map((a, i) => `${i + 1}. cv${a.id}「${a.title}」${a.images.length ? `（${a.images.length} 张图）` : ''}\n   ${a.desc}`).join('\n')}`
        + '\n要看哪篇的正文和图，用 id 填 cv 号再调一次。' };
    } catch (e) {
      return { content: `B 站专栏查询失败：${e?.message ?? e}`, isError: true };
    }
  }
};

// ── 听视频：视频的声音转成文字（read_video 只能看画面）────────────────────────
// QQ 里发的视频直接下；B 站视频 / 卡片用 media-download 的 bili.js 拿音轨。截前 VIDEO_ASR_MAX_SEC 秒，
// 本地 whisper（CPU）转写，结果按来源缓存，同一个视频不重复转。
const VIDEO_ASR_MAX_SEC = 180;
const VIDEO_ASR_DIR = path.join(STATE_DIR, 'video-asr');
const VIDEO_LISTEN_TOOL = {
  id: 'video_listen',
  name: '听视频',
  category: 'query',
  icon: '👂',
  description: '把视频里的声音（台词、旁白、歌词、说话）转成带时间的文字。read_video 只能看画面、听不到声音，'
    + '有人问"视频里说了什么""这是什么歌 / 哪一集""他在说啥"，或者看画面判断不了内容时，用它听一下。'
    + `支持群里发的视频消息、B 站视频卡片、B 站链接 / BV 号；只转前 ${VIDEO_ASR_MAX_SEC / 60} 分钟，要等几十秒，开听前可以先回一句"我听听"。`,
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: '视频消息或 B 站卡片消息的 id（聊天记录里的 #数字）' },
      url: { type: 'string', description: '或者直接给 B 站链接 / BV 号' }
    }
  },
  async execute(ctx, args = {}) {
    const orch = G.orch;
    try {
      const bili = await import('../media-download/bili.js');
      const ffmpeg = await bili.findFfmpeg();
      if (!ffmpeg) return { content: '没找到 ffmpeg，听不了视频', isError: true };
      fs.mkdirSync(VIDEO_ASR_DIR, { recursive: true });
      // 来源：消息里的视频 → 直接下；否则当 B 站视频解析 BV 号
      const entry = args.messageId ? ctx.store?.findByMid?.(ctx.chatKey, args.messageId) : null;
      const video = (entry?.media || []).find((m) => m?.kind === 'video' && /^https?:\/\//.test(String(m.url || '')));
      let key = '';
      let label = '';
      let bvid = '';
      if (video) {
        key = `qq-${createHash('md5').update(String(video.file || video.url)).digest('hex').slice(0, 16)}`;
        label = '群里发的视频';
      } else {
        bvid = await bili.resolveBvid({ messageId: args.messageId, url: args.url }, { onebot: orch?.onebot }).catch(() => null);
        if (!bvid) return { content: '这条消息里没找到视频，也认不出 B 站视频（要视频消息、B 站卡片、链接或 BV 号）', isError: true };
        key = `bili-${bvid}`;
      }
      const cacheFile = path.join(VIDEO_ASR_DIR, `${key}.json`);
      let r = null;
      try { r = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* 没缓存 */ }
      if (!r) {
        const src = path.join(VIDEO_ASR_DIR, `${key}.src`);
        const wav = path.join(VIDEO_ASR_DIR, `${key}.wav`);
        try {
          if (video) {
            const { safeFetchBinaryToFile } = await import('../../src/safe-fetch.js');
            await safeFetchBinaryToFile(video.url, src, MAX_VIDEO_BYTES, { timeoutMs: 90000 });
          } else {
            const info = await bili.getVideoInfo(bvid, '');
            label = `B 站 ${bvid}「${info.title}」`;
            const play = await bili.getPlayUrl(bvid, info.cid, 16, '');
            const a = bili.pickAudioStream(play?.dash?.audio);
            if (!a) return { content: `${label} 拿不到音轨`, isError: true };
            await bili.downloadStreamToFile(bili.streamCandidates(a.baseUrl || a.base_url, a.backupUrl || a.backup_url), src, 80 * 1024 * 1024, bvid, '');
          }
          await runProc(ffmpeg, ['-y', '-t', String(VIDEO_ASR_MAX_SEC), '-i', src, '-vn', '-ac', '1', '-ar', '16000', wav], 120000);
          const out = await runProc(deps.settings().pythonPath || 'python', ['-I', fileURLToPath(new URL('./asr.py', import.meta.url)), wav], 300000);
          r = { label, ...JSON.parse(out.trim().split('\n').pop()) };
          fs.writeFileSync(cacheFile, JSON.stringify(r), 'utf8');
        } finally {
          fs.rmSync(src, { force: true });
          fs.rmSync(wav, { force: true });
        }
      }
      const segs = (r.segments || []).filter((s) => s.t);
      if (!segs.length) return { content: `${r.label || label}：前 ${VIDEO_ASR_MAX_SEC / 60} 分钟没听出人声（可能是纯音乐 / 音效）。` };
      const lines = segs.map((s) => `[${Math.floor(s.s / 60)}:${String(Math.floor(s.s % 60)).padStart(2, '0')}] ${s.t}`);
      return { content: `${r.label || label} 的声音转文字（语种 ${r.language}，只含前 ${VIDEO_ASR_MAX_SEC / 60} 分钟；机器识别，同音字、歌词、鬼畜会有错，别逐字当真）：\n${lines.join('\n').slice(0, 5000)}` };
    } catch (e) {
      return { content: `听视频失败：${e?.message ?? e}`, isError: true };
    }
  }
};

// 跑一个子进程，返回 stdout；超时或非 0 退出就抛错
function runProc(bin, argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv, { windowsHide: true });
    let out = '';
    let errText = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`${path.basename(bin)} 超时`)); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { errText = (errText + d).slice(-600); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(bin)} 退出码 ${code}：${errText.trim().split('\n').pop() || ''}`));
    });
  });
}

export { BILI_ARTICLE_TOOL, VIDEO_LISTEN_TOOL };
