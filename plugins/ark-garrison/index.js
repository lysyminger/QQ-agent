// plugins/ark-garrison/index.js
//
// 卫戍协议陪玩插件入口：给喵喵注册四个工具。
//   ark_start  开模拟器 + 开游戏 + 走到卫戍协议入口（只听主人）
//   ark_play   打一局：极速模拟，或标准独立模拟的某个规程等级（只听主人）
//   ark_stop   停下（只听主人）
//   ark_look   截一张现在的画面发到聊天（谁都能看）
// 同一时间只跑一件事；进度、截图和它想说的话发回下令的那个聊天。
// maa.js / eyes.js 按需动态加载：maa-node 带 ~90MB 原生 DLL，插件开着但没在玩时不该把它拉进主进程。

import { logger } from '../../src/logger.js';
import { getConfig } from '../../src/config.js';

const ID = 'ark-garrison';
let cfg = null;
let api = null;
const G = globalThis.__arkGarrison || (globalThis.__arkGarrison = { job: null, eyes: null });

const settings = () => ({ serial: '', ldDir: '', ldIndex: 0, ...(typeof cfg === 'function' ? cfg() : {}) });
const ownerIds = () => String(getConfig().skills?.['owner-identity']?.ids || '').split(/[,，\s]+/).filter(Boolean);

function isOwner(ctx) {
  const trig = Array.isArray(ctx.session?.trigger) ? ctx.session.trigger : [];
  const last = trig[trig.length - 1];
  return Boolean(last && !last.self && ownerIds().includes(String(last.senderId)));
}

async function eyes() {
  if (!G.eyes) {
    const { createEyes } = await import('./eyes.js');
    G.eyes = createEyes({ serial: settings().serial });
  }
  return G.eyes;
}

async function emulator() {
  const { findLdDir, createEmulator } = await import('./emulator.js');
  const s = settings();
  const ldDir = await findLdDir(s.ldDir);
  if (!ldDir) throw new Error('没找到雷电模拟器（ldconsole.exe），在插件设置里填一下目录');
  return createEmulator({ ldDir, index: Number(s.ldIndex) || 0 });
}

/** 发到下令的聊天：有截图就带上。发失败只记日志。 */
function reporter(ctx) {
  return async (text, file) => {
    try {
      if (text) await ctx.sender.sendTextBatch(ctx.chatKey, [text]);
      if (file) await ctx.sender.sendImage(ctx.chatKey, { file });
    } catch (e) {
      logger.warn(ID, `发进度失败：${e?.message ?? e}`);
    }
  };
}

const ask = (opts) => {
  const r = api?.capability('codex.run', opts);
  return r ? Promise.resolve(r) : Promise.resolve({ ok: false, error: '没有可用的 Codex（codex-bridge 插件没开？）' });
};

/** 后台跑一件事：开机 → （可选）走到入口 → （可选）打一局。 */
function startJob(ctx, { goal, extra = '', label }) {
  const report = reporter(ctx);
  const ac = new AbortController();
  const job = { label, startedAt: Date.now(), ac, chatKey: ctx.chatKey, step: '开模拟器' };
  G.job = job;
  (async () => {
    try {
      const emu = await emulator();
      const secs = await emu.ensureRunning(150000, () => report('模拟器开机中，稍等一下…'));
      job.step = '开游戏';
      const launched = await emu.ensureGame();
      if (secs > 3 || launched) report(`模拟器${secs > 3 ? `开好了（${secs} 秒）` : '已经开着'}，${launched ? '游戏也启动了' : '游戏在前台'}`);
      const e = await eyes();
      const { runGoal } = await import('./runner.js');
      for (const g of goal === 'enter' ? ['enter'] : ['enter', goal]) {
        job.step = g === 'enter' ? '走到卫戍协议入口' : label;
        const r = await runGoal(g, { eyes: e, ask, report, signal: ac.signal, extra: g === goal ? extra : '', log: (t) => logger.info(ID, t) });
        logger.info(ID, `${g} 结束：${JSON.stringify({ ...r, file: undefined })}`);
        if (!r.ok) {
          const why = r.status === 'stopped' ? '好的，停下了' : r.status === 'quota' ? `先不打了：${r.reason}` : `卡住了：${r.reason}`;
          await report(why, r.file);
          return;
        }
        if (g === 'enter') await report(goal === 'enter' ? '到卫戍协议入口了' : '到卫戍协议了，开打', r.file);
        else await report(`${label}打完了${r.learned ? `，顺便记下了 ${r.learned} 条新知识` : ''}`, r.file);
      }
    } catch (e) {
      logger.warn(ID, `出错：${e?.stack ?? e}`);
      await report(`出错了：${e?.message ?? e}`);
    } finally {
      if (G.job === job) G.job = null;
    }
  })();
  return job;
}

const busy = () => (G.job ? `正在${G.job.label}（${G.job.step}，已经 ${Math.round((Date.now() - G.job.startedAt) / 60000)} 分钟）` : '');

const OWNER_ONLY = { content: '这个只听主人的，用你自己的口吻婉拒就好。', isError: true };

const START_TOOL = {
  id: 'ark_start',
  name: '开方舟',
  category: 'action',
  icon: '🎮',
  description: '【只限主人】打开雷电模拟器和明日方舟，走到「卫戍协议」入口，路上的进度会截图发到聊天里。主人说「开方舟」「开游戏」「准备打卫戍」时用。',
  parameters: { type: 'object', properties: {} },
  async execute(ctx) {
    if (!isOwner(ctx)) return OWNER_ONLY;
    if (G.job) return { content: busy() };
    startJob(ctx, { goal: 'enter', label: '开游戏' });
    return { content: '开始了：开模拟器 → 开游戏 → 走到卫戍协议，进度会自动截图发出来。回一句「好，我去开」之类的就行。' };
  }
};

const PLAY_TOOL = {
  id: 'ark_play',
  name: '打卫戍协议',
  category: 'action',
  icon: '🛡️',
  description: '【只限主人】自己打一局卫戍协议单人模拟（会先开模拟器和游戏）。mode=quick 是极速模拟；mode=indie 是标准独立模拟，level 填规程等级（1～20）。'
    + '整局要几十分钟，过程中有意思的事会发到聊天里。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['quick', 'indie'], description: 'quick = 极速模拟；indie = 标准独立模拟' },
      level: { type: 'integer', description: 'indie 时的规程等级，默认 1' }
    }
  },
  async execute(ctx, args = {}) {
    if (!isOwner(ctx)) return OWNER_ONLY;
    if (G.job) return { content: busy() };
    const indie = args.mode === 'indie';
    const level = Math.min(20, Math.max(1, Number(args.level) || 1));
    const label = indie ? `独立模拟规程等级 ${level}` : '极速模拟';
    startJob(ctx, { goal: indie ? 'indie' : 'solo', extra: indie ? `规程等级 ${level}` : '', label });
    return { content: `开始打${label}了，过程会发到聊天里。回一句「我去打了」之类的就行。` };
  }
};

const STOP_TOOL = {
  id: 'ark_stop',
  name: '别打了',
  category: 'action',
  icon: '⏹️',
  description: '【只限主人】让正在进行的开游戏 / 打卫戍停下来（游戏本身不会关，局内进度会保留）。',
  parameters: { type: 'object', properties: {} },
  async execute(ctx) {
    if (!isOwner(ctx)) return OWNER_ONLY;
    if (!G.job) return { content: '现在没在玩' };
    G.job.ac.abort();
    return { content: '好，马上停（做完手上这一步）' };
  }
};

const LOOK_TOOL = {
  id: 'ark_look',
  name: '看看游戏',
  category: 'query',
  icon: '👀',
  description: '把模拟器里明日方舟现在的画面截图发到聊天，并说明现在在干什么。有人问「打到哪了」「让我看看」时用。',
  parameters: { type: 'object', properties: {} },
  async execute(ctx) {
    try {
      const emu = await emulator();
      if (!(await emu.status()).running) return { content: '模拟器没开着' };
      const look = await (await eyes()).look();
      await ctx.sender.sendImage(ctx.chatKey, { file: look.file });
      return { content: `截图已经发了。${busy() || '现在没在自动玩。'}画面上的字：${look.text.slice(0, 200)}` };
    } catch (e) {
      return { content: `看不了：${e?.message ?? e}`, isError: true };
    }
  }
};

/** 连一次模拟器，截一张图 + 全屏 OCR，返回各步耗时（给控制台 / 其他插件排查用）。 */
async function bench() {
  const maa = await import('./maa.js');
  const session = await maa.connect({ serial: settings().serial });
  try {
    const cap = await maa.screencap(session.ctrl);
    const r = await maa.ocr(session.tasker, cap.image);
    return {
      ok: true,
      device: session.device,
      timings: { ...session.timings, screencapMs: cap.ms, ocrMs: r.ms },
      texts: r.items.map((x) => x.text)
    };
  } finally {
    maa.close(session);
  }
}

export function setup(a) {
  api = a;
  cfg = a.config;
  for (const t of [START_TOOL, PLAY_TOOL, STOP_TOOL, LOOK_TOOL]) {
    try { a.registerTool(t); } catch (e) { logger.warn(ID, `注册「${t.name}」失败：${e.message}`); }
  }
  logger.info(ID, '已加载：开方舟 / 打卫戍协议 / 别打了 / 看看游戏');
}

export function teardown() {
  G.job?.ac.abort();
  try { G.eyes?.close(); } catch { /* ignore */ }
  G.eyes = null;
}

export const providers = {
  'ark.bench': () => bench().catch((e) => ({ ok: false, error: e.message }))
};
