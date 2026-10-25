// 按字数控制回复速度 · send-pacing（确定性型：plugins/）
//
// ── 它做什么（时间轴）─────────────────────────────────────────────────────
// 机器人这一轮准备回几句话，就按**每一句自己的字数**排间隔：
//
//     等 6 字的时间  → 发第 1 句  ┐
//                                │ 发出第 1 句的同时开始计时
//     等 10 字的时间 → 发第 2 句  ┘
//     等 4 字的时间  → 发第 3 句
//     再等 3~5 秒    → 发配套的表情包 / 图片
//
//   每字耗时：**每个字各自**在「最短 700ms ~ 最长 1100ms」之间随机取一个，然后累加 ——
//             不是"字数 × 一个固定速率"。所以每条消息的总时间都不一样，不会死板。
//   字数    ：去掉空格换行后的字符数（汉字/标点/emoji 各 1 个，英文字母逐个算）
//   起手时间：默认 0 —— 你的时间轴里第一句就是纯按字数算；想留一点"看到消息先愣一下"
//             的感觉就填 200~400（会加到**每一条**上，不只第一条）
//
// ── 为此做了三件事（都包在协议层，不动核心代码）──────────────────────────
// ① OneBotClient.prototype.sendText —— 按这条消息自己的字数等待后再发
// ② SendQueue.prototype.sendTextBatch —— **拆开逐条发**。
//    为什么必须拆：核心的 sender 在同一个批次里会给每条之间再加 1~3 秒自己的"句间间隔"
//    （#gap），那是它的拟人化设计。不拆的话，实际间隔 = 3.5 秒(我的) + 1.5 秒(它的)，
//    就不是你要的时间轴了。拆成"每次只发一条"后，核心算出的间隔恒为 0，间隔完全由
//    本插件按字数决定 —— 而回复里的 @ / 引用仍然只挂在第一条上（和原来一致）。
// ③ OneBotClient.prototype.sendSticker / sendImage —— 从"上一条发出"起算，
//    凑够 3~5 秒再发（同一条链是串行的，所以这就是"最后一句之后 3~5 秒"）。
//
// 为什么只能包层：sender.js 里**没有任何扩展点**（既没有 capability 也没有 hook），
// 而这三处正好都在"按会话串行"的发送链里 —— 所以等待只卡住当前会话，不影响别的群。
//
// ── 安全边界 ──────────────────────────────────────────────────────────────
// · 包装层永远不抛错：算不出延迟、设置读不到、sleep 失败 —— 一律直接放行原调用。
// · 原方法用 rest 参数原样转发，返回值与错误照旧透传；拆条时"全失败"仍按原语义抛错。
// · 用 Symbol.for 在原型上做幂等标记：热重载时**复用同一层包装**，只更新配置读取器，
//   绝不会包两层导致每条等两遍；"上一条发出时间"也存在全局状态里，热重载不丢。
// · 提供 dispose()：插件卸载时把三个原型方法全部还原。
// · 关掉插件（enabled=false）时每次调用实时读配置 → 立刻恢复原速，不残留延迟。

import { OneBotClient } from '../../src/onebot.js';
import { SendQueue } from '../../src/sender.js';

// 全局共享状态：热重载会新建模块实例，但原型上的包装与"上次发送时间"必须跨实例沿用，
// 否则会出现"包两层"或"图片间隔算不出来"。
const STATE_KEY = Symbol.for('qq-agent.send-pacing.state');
const globalState = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = {
  read: () => resolveSettings({}),
  log: () => {},
  lastSendAt: new Map(),
  patches: null
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clampInt = (value, fallback, min, max) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function resolveSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const settings = {
    enabled: source.enabled !== false,
    minMsPerChar: clampInt(source.minMsPerChar, 700, 0, 60000),
    maxMsPerChar: clampInt(source.maxMsPerChar, 1100, 0, 60000),
    baseMs: clampInt(source.baseMs, 0, 0, 300000),
    minMs: clampInt(source.minMs, 300, 0, 300000),
    maxMs: clampInt(source.maxMs, 60000, 0, 900000),
    exactIntervals: source.exactIntervals !== false,
    mediaPacing: source.mediaPacing !== false,
    mediaMinMs: clampInt(source.mediaMinMs, 3000, 0, 600000),
    mediaMaxMs: clampInt(source.mediaMaxMs, 5000, 0, 600000),
    log: source.log !== false
  };
  if (settings.maxMsPerChar < settings.minMsPerChar) {
    const swap = settings.minMsPerChar;
    settings.minMsPerChar = settings.maxMsPerChar;
    settings.maxMsPerChar = swap;
  }
  if (settings.mediaMaxMs < settings.mediaMinMs) {
    const swap = settings.mediaMinMs;
    settings.mediaMinMs = settings.mediaMaxMs;
    settings.mediaMaxMs = swap;
  }
  return settings;
}

// ── 计算 ─────────────────────────────────────────────────────────────────

/** 这条消息有多少"字"：去掉空格/换行后的字符个数（emoji 算 1，标点算 1）。 */
function countChars(text) {
  return [...String(text == null ? '' : text).replace(/\s+/gu, '')].length;
}

/** 单条文本的等待毫秒数（纯函数，便于测试）。 */
function computeDelay(text, config) {
  if (!config || config.enabled === false) return 0;
  const chars = countChars(text);
  if (!chars) return 0;
  const min = Math.min(config.minMsPerChar, config.maxMsPerChar);
  const max = Math.max(config.minMsPerChar, config.maxMsPerChar);
  // 每个字各自随机取一个时间，再累加 —— 不是"字数 × 一个速率"。
  // 这样"这句等多久"每次都不一样（同一个字快慢也不同），敲出来才不死板。
  let typed = 0;
  for (let i = 0; i < chars; i += 1) typed += min + Math.random() * (max - min);
  const raw = config.baseMs + typed;
  const capped = config.maxMs > 0 ? Math.min(config.maxMs, raw) : raw;
  return Math.max(config.minMs, Math.round(capped));
}

/**
 * 表情包/图片还要等多久：目标是"距上一条发出 3~5 秒"。
 * 因为同一条发送链是串行的，这个函数被调用时上一条通常刚发完不久，
 * 所以返回的就是"最后一句之后还要等多久"。
 */
function computeMediaWait(chatKey, config) {
  if (!config || config.enabled === false || !config.mediaPacing) return 0;
  const last = globalState.lastSendAt.get(String(chatKey)) || 0;
  if (!last) return 0;                       // 这个会话还没有发送记录：不加人为间隔
  const min = Math.min(config.mediaMinMs, config.mediaMaxMs);
  const max = Math.max(config.mediaMinMs, config.mediaMaxMs);
  const target = min + Math.random() * (max - min);
  return Math.max(0, Math.round(target - (Date.now() - last)));
}

function noteSent(chatKey) {
  try {
    globalState.lastSendAt.set(String(chatKey), Date.now());
    if (globalState.lastSendAt.size > 200) {
      const keys = [...globalState.lastSendAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100).map((e) => e[0]);
      for (const key of keys) globalState.lastSendAt.delete(key);
    }
  } catch { /* ignore */ }
}

// ── 包装 ─────────────────────────────────────────────────────────────────

function installPatches() {
  if (globalState.patches) {
    globalState.patches.originalText = globalState.patches.originalText;   // 幂等：什么都不用换
    return globalState.patches;
  }
  const onebot = OneBotClient.prototype;
  const senderProto = SendQueue.prototype;
  if (typeof onebot.sendText !== 'function' || typeof senderProto.sendTextBatch !== 'function') return null;

  const patches = {
    originalText: onebot.sendText,
    originalBatch: senderProto.sendTextBatch,
    originalSticker: onebot.sendSticker,
    originalImage: onebot.sendImage
  };

  // ① 文本：按这条自己的字数等
  onebot.sendText = async function sendTextPaced(...args) {
    const [kind, id, text] = args;
    try {
      const config = globalState.read();
      const delay = computeDelay(text, config);
      if (delay > 0) {
        if (config.log) {
          try { globalState.log(`「${String(text ?? '').slice(0, 20)}」共 ${countChars(text)} 个字 → 等 ${delay}ms 再发`); } catch { /* 日志可选 */ }
        }
        await sleep(delay);
      }
    } catch { /* 计算失败就放行：慢一点事小，发不出去事大 */ }
    const result = await patches.originalText.apply(this, args);
    noteSent(`${kind}:${id}`);
    return result;
  };

  // ② 批次：拆开逐条发，绕开核心自己的"句间间隔"（详见文件头 ②）
  senderProto.sendTextBatch = async function sendTextBatchPaced(chatKey, messages, options = {}) {
    let config;
    try { config = globalState.read(); } catch { config = null; }
    if (!config || !config.enabled || !config.exactIntervals) {
      return patches.originalBatch.call(this, chatKey, messages, options);
    }
    const list = (Array.isArray(messages) ? messages : [messages])
      .map((m) => (typeof m === 'string' ? m : String(m ?? '')))
      .filter((m) => m.trim());
    if (list.length <= 1) return patches.originalBatch.call(this, chatKey, messages, options);

    const sent = [];
    const failed = [];
    let lastError = null;
    for (let i = 0; i < list.length; i += 1) {
      // @ / 引用只挂在第一条上（与核心原本的行为一致）
      const opts = i === 0 ? options : { ...options, replyToMessageId: null, atUserId: null };
      try {
        const r = await patches.originalBatch.call(this, chatKey, [list[i]], opts);
        if (r && Array.isArray(r.sent)) sent.push(...r.sent);
        if (r && Array.isArray(r.failed)) for (const f of r.failed) failed.push({ ...f, index: i });
      } catch (error) {
        lastError = error;
        failed.push({ index: i, text: list[i], error: String((error && error.message) || error) });
      }
    }
    if (!sent.length && failed.length) throw lastError || new Error(failed[0].error);
    if (failed.length) {
      try { globalState.log(`[send-pacing] 拆条发送有 ${failed.length} 条失败（成功的不用重发）`); } catch { /* ignore */ }
    }
    return { sent, failed };
  };

  // ③ 表情包 / 图片：从"上一条发出"起算，凑够 3~5 秒
  const wrapMedia = (original) => async function mediaPaced(...args) {
    const [kind, id] = args;
    let wait = 0;
    try { wait = computeMediaWait(`${kind}:${id}`, globalState.read()); } catch { wait = 0; }
    if (wait > 0) {
      try { globalState.log(`配套表情/图片：距上一条发出不足 3~5 秒，再等 ${wait}ms`); } catch { /* ignore */ }
      await sleep(wait);
    }
    const result = await original.apply(this, args);
    noteSent(`${kind}:${id}`);
    return result;
  };
  onebot.sendSticker = wrapMedia(patches.originalSticker);
  onebot.sendImage = wrapMedia(patches.originalImage);

  globalState.patches = patches;
  return patches;
}

function uninstallPatches() {
  const patches = globalState.patches;
  if (!patches) return false;
  const onebot = OneBotClient.prototype;
  const senderProto = SendQueue.prototype;
  if (onebot.sendText !== patches.originalText) onebot.sendText = patches.originalText;
  if (senderProto.sendTextBatch !== patches.originalBatch) senderProto.sendTextBatch = patches.originalBatch;
  if (onebot.sendSticker !== patches.originalSticker) onebot.sendSticker = patches.originalSticker;
  if (onebot.sendImage !== patches.originalImage) onebot.sendImage = patches.originalImage;
  globalState.patches = null;
  return true;
}

export function setup(api) {
  globalState.read = () => {
    try {
      return resolveSettings(api && typeof api.config === 'function' ? api.config() : {});
    } catch {
      return resolveSettings({});
    }
  };
  globalState.log = (...args) => { try { if (api && api.log) api.log(...args); } catch { /* 日志可选 */ } };

  installPatches();
  const config = globalState.read();
  if (!config.enabled) globalState.log('已禁用：消息按原来的速度发出');
  else {
    globalState.log(
      `已启用：每句话等「${config.baseMs}ms + 每个字各自随机 ${config.minMsPerChar}~${config.maxMsPerChar}ms 后累加」`
      + `${config.exactIntervals ? '，并把一批消息拆开逐条发（间隔完全按上一条的字数算，不再叠加核心的句间间隔）' : '，保留核心的句间间隔'}`
      + `；表情包/图片在上一句之后 ${config.mediaMinMs}~${config.mediaMaxMs}ms 发出`
      + `${config.maxMs > 0 ? `（单条上限 ${config.maxMs}ms）` : '（不设上限）'}`
    );
  }
}

/** 插件被卸载时把三个原型方法还原（loader 支持 dispose）。 */
export function dispose() {
  return uninstallPatches();
}

export const __internals = {
  computeDelay, computeMediaWait, countChars, resolveSettings,
  installPatches, uninstallPatches, globalState
};
