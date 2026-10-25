// plugins/typo-sim/index.js
//
// 打字错误模拟：让机器人**偶尔手滑打错字**，打错之后**大概率撤回、重新发正确的**。
//
// ── 为什么是插件（plugins/）而不是技能 ────────────────────────────────────
// 它不参与"理解人话"：只在外发文本上做一次概率性替换，规则完全写死 → 确定性型 → plugins/。
// **零 token**：不改提示词、不注册工具、不叫模型；模型怎么想就怎么发，只有发出去的那一下变了。
//
// ── 怎么改外发文本（本机唯一的扩展点）────────────────────────────────────
// 核心的 sender.js 没有给任何扩展点（send-pacing 的注释里也是这么说的），
// 所以只能"包一层"：把 OneBotClient.prototype.sendText 换掉，转发前改文本。
// 选这一层而不是 SendQueue.sendTextBatch，是因为这里**能拿到 message_id**（撤回要用），
// 而且不用重写核心那套"逐条发 + 引用挂第一条 + 落盘"的逻辑（重写迟早会漂移）。
//
// ── 撤回之后要把账补齐 ────────────────────────────────────────────────────
// 撤回掉的那条（错字）本来已经被核心记进"我自己的发言"里了。群友看到的最终是**正确的那条**，
// 所以撤回成功后我们要：把错字那条标成 recalled（提示词里就不会再出现它）+ 补记正确的那条。
// 这样机器人自己的聊天记录和群里实际发生的是一致的。
//
// ── 边界（防止"一眼假"和闯祸）────────────────────────────────────────────
//   · 只对**纯文本闲聊**下手：带数字/链接/@/#/换行/结构化标记（📒🏆🔔 这类）的一律不碰
//     —— 报时、榜单、股票代码、词云文案打错字是会误导人的
//   · 一轮（6 秒窗口内）最多错 1 条：连发 3 条全错，假得离谱
//   · 每小时封顶（默认 6 次）：既防群友嫌烦，也防被 QQ 风控盯上
//   · 撤回失败 → 就留着错字（跟真人打错没改一样），记日志，**不补发**（补发会变成错的和对的都在）
//   · 出错概率默认 6%：低了看不见，高了像个坏掉的输入法

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { OneBotClient } from '../../src/onebot.js';

const ID = 'typo-sim';
const STATE_DIR = path.join(DATA_DIR, ID);
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// ── 共享状态挂在 globalThis 上（**这是个真 bug 的修复**）─────────────────────
// 热重载会给插件开一个**新的模块实例**。如果"补丁装没装过""这小时错了几次""刚错过没"
// 这些状态存在模块作用域里，新实例看不见旧实例的补丁 → 再包一层 → 一条消息被改两次、
// 窗口限流也失效（一次连发三条全是错字）。离线自检里就是踩了这个（两个实例各记各的账）。
// 挂到 globalThis：无论多少个实例，补丁只装一次、账只有一份。
const G = (globalThis.__typoSimState = globalThis.__typoSimState || {
  installed: false,
  original: null,
  storeRef: null,
  cfgOf: null,
  log: null,
  warn: null,
  hourState: { hourKey: '', count: 0, total: 0, recalled: 0, kept: 0, lastAt: 0, lastText: '' },
  lastTypoAt: 0
});

let cfgOf = () => ({});   // setup 时接上 api.config（per 实例：谁装的补丁，就用谁的配置读取函数）
// 日志出口也走共享状态：**补丁是某个实例装的**，它闭包里引用的 log/warn 必须是所有实例都认的那一份，
// 否则热重载之后新实例的日志出口接不上，警告会被静默吞掉（离线自检里踩过）。
const log = (...a) => { try { (G.log || (() => {}))(...a); } catch { /* 日志不能反过来弄坏发送 */ } };
const warn = (...a) => { try { ((G.warn || G.log) || (() => {}))(...a); } catch { /* 同上 */ } };
const storeRef = () => G.storeRef;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const rnd = () => Math.random();

// ── 设置 ──────────────────────────────────────────────────────────────────
function settings() {
  const c = cfgOf() || {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: c.enabled !== false,
    typoChance: Math.max(0, Math.min(50, n(c.typoChance, 6))),          // 百分比
    recallChance: Math.max(0, Math.min(100, n(c.recallChance, 80))),
    maxPerHour: Math.max(1, Math.min(60, Math.round(n(c.maxPerHour, 6)))),
    minChars: Math.max(2, Math.min(50, Math.round(n(c.minChars, 4)))),
    maxChars: Math.max(10, Math.min(400, Math.round(n(c.maxChars, 40)))),
    allowPrivate: c.allowPrivate !== false,
    skipChats: String(c.skipChats ?? '').trim(),
    quiet: c.quiet === true                                             // true = 不写运行日志
  };
}
const skipChatSet = () => new Set(String(settings().skipChats).split(/[,，、;；\s]+/).filter(Boolean));

// ── 状态（只写数据目录）───────────────────────────────────────────────────
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') G.hourState = { ...G.hourState, ...raw };
  } catch { /* 首次运行 */ }
}
function saveState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(G.hourState, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* 写不了就算了：这只是统计 */ }
}
const hourKeyOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}`;
function hourBudget() {
  const key = hourKeyOf();
  if (G.hourState.hourKey !== key) { G.hourState.hourKey = key; G.hourState.count = 0; saveState(); }
  return settings().maxPerHour - G.hourState.count;
}

// ── 改错字（通用错字，不用任何方言）───────────────────────────────────────
// 四类手滑，都是中文输入法下最常见的：
const HOMOPHONES = [
  ['在', '再'], ['再', '在'], ['的', '得'], ['得', '的'], ['做', '作'], ['作', '做'],
  ['已', '己'], ['己', '已'], ['应', '因'], ['因', '应'], ['那', '哪'], ['哪', '那'],
  ['是', '事'], ['事', '是'], ['候', '后'], ['后', '候'], ['象', '像'], ['像', '象'],
  ['己经', '已经'], ['因为', '应为'], ['应该', '因该'], ['什么', '什吗'], ['时候', '时后'],
  ['可以', '可已'], ['知道', '知到'], ['觉得', '决得'], ['还是', '还使'], ['真的', '真得']
];

/** 造一个错字版本。返回 {text, kind} 或 null（造不出来）。 */
function makeTypo(text) {
  const s = String(text ?? '');
  const arr = [...s];
  if (arr.length < 2) return null;
  const styles = ['swap', 'swap', 'homophone', 'drop', 'dup'];   // 交换最常见，其次同音
  const style = styles[Math.floor(rnd() * styles.length)];

  if (style === 'homophone') {
    // 从表里挑一个文本中真实存在的替换点
    const hits = HOMOPHONES.filter(([from]) => s.includes(from));
    if (hits.length) {
      const [from, to] = hits[Math.floor(rnd() * hits.length)];
      const at = s.indexOf(from);
      return { text: s.slice(0, at) + to + s.slice(at + from.length), kind: '同音字' };
    }
  }
  if (style === 'swap') {
    // 相邻两字打反（中文输入法下很常见）
    const i = Math.floor(rnd() * (arr.length - 1));
    if (arr[i] !== arr[i + 1] && !/\s/.test(arr[i]) && !/\s/.test(arr[i + 1])) {
      const out = [...arr];
      [out[i], out[i + 1]] = [out[i + 1], out[i]];
      return { text: out.join(''), kind: '两个字打反' };
    }
  }
  if (style === 'drop' && arr.length > 3) {
    // 漏打一个字（不删标点，免得看不出是手滑）
    const cands = arr.map((ch, i) => (/[\u4e00-\u9fa5]/.test(ch) ? i : -1)).filter((i) => i >= 0);
    if (cands.length) {
      const i = cands[Math.floor(rnd() * cands.length)];
      return { text: arr.filter((_, k) => k !== i).join(''), kind: '漏打一个字' };
    }
  }
  if (style === 'dup') {
    // 多打一个字（粘住了）
    const cands = arr.map((ch, i) => (/[\u4e00-\u9fa5]/.test(ch) ? i : -1)).filter((i) => i >= 0);
    if (cands.length) {
      const i = cands[Math.floor(rnd() * cands.length)];
      const out = [...arr];
      out.splice(i, 0, arr[i]);
      return { text: out.join(''), kind: '多打一个字' };
    }
  }
  // 兜底：再试一次交换
  if (arr.length >= 2) {
    const out = [...arr];
    [out[0], out[1]] = [out[1], out[0]];
    if (out.join('') !== s) return { text: out.join(''), kind: '两个字打反' };
  }
  return null;
}

/** 这条消息该不该被"手滑"？（结构化/重要内容一律放行不改） */
function eligible(chatKey, text) {
  const s = settings();
  if (!s.enabled) return { ok: false, why: '功能已关' };
  if (typeof text !== 'string') return { ok: false, why: '不是文本' };
  const t = text.trim();
  if (t.length < s.minChars) return { ok: false, why: '太短' };
  if (t.length > s.maxChars) return { ok: false, why: '太长（多半是结构化内容）' };
  if (!s.allowPrivate && String(chatKey).startsWith('private:')) return { ok: false, why: '私聊不改' };
  if (skipChatSet().has(String(chatKey))) return { ok: false, why: '在跳过名单里' };
  // 结构化 / 不能错的内容
  if (/[\d\n\r]/.test(t)) return { ok: false, why: '含数字或换行' };
  if (/https?:|www\.|\[CQ:|CQ:/.test(t)) return { ok: false, why: '含链接或CQ码' };
  if (/[@#]/.test(t)) return { ok: false, why: '含@或#' };
  if (/[📒🏆🔔🎵⭐✅🖼📂🎓🔍📝☁️]/.test(t)) return { ok: false, why: '带结构化标记' };
  if (/^(状态|报时|词云|榜|股票|token|Token)/.test(t)) return { ok: false, why: '疑似指令/数据类' };
  return { ok: true, why: '' };
}

// ── 打补丁 ────────────────────────────────────────────────────────────────
// 只装一次：靠 globalThis 上的 installed 标记（热重载/多实例都拦得住）。
function installPatches() {
  if (G.installed && G.original) return { original: G.original, reused: true };
  const proto = OneBotClient?.prototype;
  if (!proto || typeof proto.sendText !== 'function') return null;
  const original = proto.sendText;

  proto.sendText = async function sendTextWithTypo(kind, id, text, options = {}) {
    const args = [kind, id, text, options];
    const chatKey = `${kind}:${id}`;
    try {
      const s = settings();
      const gate = eligible(chatKey, text);
      if (!gate.ok) return original.apply(this, args);
      if (Date.now() - G.lastTypoAt < 6000) return original.apply(this, args);     // 一轮最多错一条
      if (hourBudget() <= 0) return original.apply(this, args);
      if (rnd() * 100 >= s.typoChance) return original.apply(this, args);

      const typo = makeTypo(text);
      if (!typo) return original.apply(this, args);

      // ① 先把错的那条发出去（走原实现，落盘/引用/日志都照旧）
      const res = await original.call(this, kind, id, typo.text, options);
      const typoMid = res?.data?.message_id ?? res?.message_id ?? null;
      G.lastTypoAt = Date.now();
      G.hourState.count += 1;
      G.hourState.total += 1;
      G.hourState.lastAt = Date.now();
      G.hourState.lastText = `${typo.text} → ${text}`;
      saveState();
      if (!s.quiet) log(`手滑打错了（${typo.kind}）：「${typo.text}」`);

      // ② 大概率撤回 + 重发正确的
      if (rnd() * 100 >= s.recallChance) {
        G.hourState.kept += 1;
        saveState();
        if (!s.quiet) log('这次不撤回了（就像真人打错懒得改）');
        return res;
      }
      if (!typoMid) {
        G.hourState.kept += 1;
        saveState();
        warn('拿不到 message_id，撤不回来（错字就留着了）');
        return res;
      }
      await sleep(800 + Math.floor(rnd() * 1200));                    // 装成"发现打错→撤回"
      let recalled = false;
      try {
        await this.call('delete_msg', { message_id: typoMid }, 8000);
        recalled = true;
      } catch (e) {
        warn(`撤回失败（错字就留着了）：${e?.message ?? e}`);
      }
      if (!recalled) { G.hourState.kept += 1; saveState(); return res; }

      G.hourState.recalled += 1;
      saveState();
      // ③ 账补齐：错字那条标 recalled（提示词里不再出现），再补记正确的那条
      try {
        if (storeRef()?.markRecalled) storeRef().markRecalled(chatKey, typoMid);
      } catch { /* 记不上就算了 */ }
      await sleep(300 + Math.floor(rnd() * 500));                     // 重打也要点时间
      let fixed = null;
      try {
        fixed = await original.call(this, kind, id, text, options);
        const correctMid = fixed?.data?.message_id ?? fixed?.message_id ?? null;
        if (storeRef()?.appendSelf) storeRef().appendSelf(chatKey, { text: String(text), ts: Date.now(), mid: correctMid });
      } catch (e) {
        warn(`重发正确的那条失败：${e?.message ?? e}`);
      }
      if (!s.quiet) log(`已撤回并重发：「${text}」`);
      return fixed || res;
    } catch (e) {
      // 补丁里出任何事都不能把消息弄丢：原样放行
      warn(`打字模拟出错，已按原样发送：${e?.message ?? e}`);
      return original.apply(this, args);
    }
  };
  G.original = original;
  G.installed = true;
  return { original };
}

// ── 生命周期 ──────────────────────────────────────────────────────────────
export function setup(api) {
  cfgOf = api.config;
  G.log = (...a) => api.log?.(...a);
  G.warn = (...a) => (api.warn ?? api.log)?.(...a);
  loadState();
  const p = installPatches();
  const s = settings();
  if (!p) warn('挂不上发送钩子（OneBotClient.prototype.sendText 不在），打字模拟不会生效');
  else log(`已加载：打错概率 ${s.typoChance}%、撤回概率 ${s.recallChance}%、每小时最多 ${s.maxPerHour} 次`
    + `；只改纯文本闲聊（${s.minChars}~${s.maxChars} 字），数据类消息不碰`
    + `${s.allowPrivate ? '；私聊也生效' : '；只改群聊'}`);
}

/** 从对话上下文里抓核心的 store（插件拿不到核心单例，只能这么接）。 */
export const hooks = {
  'before-context': (ctx) => {
    if (ctx?.store) G.storeRef = ctx.store;
  }
};

/** 状态上报（给 ai-status 面板用）：必须同步、零 IO。顺带让"确定性插件"有存在感。 */
export const providers = {
  [`status.${ID}`]: () => {
    const s = settings();
    if (!G.hourState.total) {
      return { icon: '⌨️', title: '打字模拟', lines: [['状态', s.enabled ? '还没手滑过' : '已关闭']], tips: [], priority: 62 };
    }
    return {
      icon: '⌨️',
      title: '打字模拟',
      lines: [
        ['累计手滑', `${G.hourState.total} 次`],
        ['撤回重发', `${G.hourState.recalled} 次`],
        ['留着没改', `${G.hourState.kept} 次`],
        ['本小时', `${G.hourState.count}/${s.maxPerHour} 次`]
      ],
      tips: s.enabled ? [] : ['打字模拟已关'],
      priority: 62
    };
  }
};

export function available() {
  const proto = OneBotClient?.prototype;
  if (!proto || typeof proto.sendText !== 'function') {
    return { ok: false, reason: '这个版本的核心没有 OneBotClient.prototype.sendText，挂不上发送钩子' };
  }
  return { ok: true };
}
export function activate() { loadState(); installPatches(); }
export function dispose() { /* 补丁保留：卸载插件时核心会重载，不需要手工还原 */ }

// 内部函数暴露给离线测试（不对外提供能力，别依赖）
export const internals = {
  settings, makeTypo, eligible, installPatches, hourBudget,
  getState: () => G.hourState,
  setState: (p) => { G.hourState = { ...G.hourState, ...(p || {}) }; },
  resetWindow: () => { G.lastTypoAt = 0; },
  setStore: (s) => { G.storeRef = s; },

  isPatched: () => !!G.installed,
  // 调试用：把当前所有闸门的取值摊开（离线自检里用来定位"为什么这次没打错"）
  debug: () => ({
    now: Date.now(), lastTypoAt: G.lastTypoAt, gapMs: Date.now() - G.lastTypoAt,
    hour: { ...G.hourState }, budget: hourBudget(),
    cfg: { enabled: settings().enabled, typoChance: settings().typoChance, recallChance: settings().recallChance, maxPerHour: settings().maxPerHour, minChars: settings().minChars, maxChars: settings().maxChars, allowPrivate: settings().allowPrivate, skipChats: settings().skipChats },
    gate: eligible('group:870817228', '俺觉得这个方案还是可以的'),
    installed: G.installed, hasStore: !!G.storeRef
  }),
  STATE_FILE, HOMOPHONES,
  // 离线自检专用：重新装一次补丁（先把原型还原成原始实现再调），保证补丁属于本实例
  reinstall: () => { G.installed = false; G.original = null; return installPatches(); }
};
