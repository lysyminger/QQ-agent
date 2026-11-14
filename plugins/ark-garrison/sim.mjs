// plugins/ark-garrison/sim.mjs —— 不开模拟器，用本地假游戏（sim.js）把 turn.js 的回合流程整局整局地跑。
//
//   node plugins/ark-garrison/sim.mjs                     规则脑（不花额度）跑 20 局，看流程有没有卡死 / 操作失败
//   node plugins/ark-garrison/sim.mjs --games 50 --compare  比较几种打法参数（升级节奏、刷新）
//   node plugins/ark-garrison/sim.mjs --brain luna --games 2  用 luna（Codex）当脑子打假游戏，检查它的清单在流程里走不走得通
//
// 输出：胜场、平均撑到第几回合、每回合问几次、开战时空着几个上场名额、失败 / 跳过的操作。

import { FakeGame, makeFakeIo, makeRuleBrain, loadPool } from './sim.js';
import { playRest } from './turn.js';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const games = Number(arg('--games', 20));
const brainKind = arg('--brain', 'rule');
const pool = loadPool();

async function playGame(seed, { brainOpts = {}, ask: llm = null, verbose = false, swaps = true, planner = null, extra = '' } = {}) {
  const mem = {};
  const g = new FakeGame({ seed, pool });
  const io = makeFakeIo(g);
  const ask = llm || makeRuleBrain(g, brainOpts);
  const bench = []; const board = [];
  let memo = '';
  const stat = { asks: 0, rests: 0, emptyAtReady: 0, fails: [], skipped: 0, auto: 0, stuck: 0 };
  while (!g.over) {
    g.readied = false;
    const roundBefore = g.round;
    let tries = 0;
    while (!g.readied && !g.over && tries < 4) {
      const empty = g.remain();
      const r = await playRest({ io, ask, bench, board, memo, swaps, planner, mem, extra, log: verbose ? console.log : () => {}, known: pool.map((p) => p.name) });
      tries++;
      stat.asks += r.asks || 0;
      memo = r.memo || memo;
      for (const n of r.notes || []) {
        if (/失败/.test(n)) stat.fails.push(n);
        if (/跳过/.test(n)) stat.skipped++;
        if (/自动/.test(n)) stat.auto++;
      }
      if (r.readied) stat.emptyAtReady += Math.min(empty, g.board.length < 8 ? 8 - g.board.length : 0);
      if (!r.ok && !r.readied && !g.readied) { stat.stuck++; break; }
    }
    if (!g.readied && !g.over) { g.ready(); stat.stuck++; }   // 流程没走到 ready：记一笔，替它开战
    stat.rests++;
    if (g.round === roundBefore && !g.over) break;
  }
  return { won: g.won, round: g.round, hp: g.hp, log: g.log, ...stat };
}

function summary(name, res) {
  const n = res.length;
  const avg = (f) => (res.reduce((s, r) => s + f(r), 0) / n).toFixed(2);
  const fails = res.flatMap((r) => r.fails);
  const kinds = new Map();
  for (const f of fails) { const k = f.replace(/[：:].*$/, '').replace(/\d+号|\s[一-龥A-Za-z]+$/g, '').trim(); kinds.set(k, (kinds.get(k) || 0) + 1); }
  console.log(`${name.padEnd(22)} 胜 ${res.filter((r) => r.won).length}/${n}，平均撑到第 ${avg((r) => r.round)} 回合，剩血 ${avg((r) => Math.max(0, r.hp))}，每回合问 ${(res.reduce((s, r) => s + r.asks, 0) / res.reduce((s, r) => s + r.rests, 0)).toFixed(2)} 次，开战时空位 ${avg((r) => r.emptyAtReady / r.rests)}，卡住 ${res.reduce((s, r) => s + r.stuck, 0)} 次，自动操作 ${avg((r) => r.auto)} 次/局，跳过 ${avg((r) => r.skipped)} 次/局`);
  if (kinds.size) console.log('   失败的操作：', [...kinds].map(([k, v]) => `${k}×${v}`).join('，'));
}

if (brainKind === 'luna' || brainKind === 'claude') {
  const { createFastAsk } = await import('./codex-fast.js');
  const { createClaudeAsk } = await import('./claude-ask.js');
  const ask = brainKind === 'luna' ? createFastAsk() : createClaudeAsk();
  const res = [];
  for (let i = 0; i < games; i++) {
    const r = await playGame(1000 + i, { ask, verbose: argv.includes('-v') });
    console.log(`第 ${i + 1} 局：${r.won ? '通关' : `输在第 ${r.round} 回合`}；${r.log.slice(-3).join(' | ')}`);
    res.push(r);
  }
  summary(brainKind, res);
  ask.close?.();
  process.exit(0);
}

const variants = argv.includes('--compare')
  ? [
    ['不自动换人', { upgradeAt: 2, refresh: true }, false],
    ['升级≤2 刷新', { upgradeAt: 2, refresh: true }],
    ['升级≤0 刷新', { upgradeAt: 0, refresh: true }],
    ['升级≤4 刷新', { upgradeAt: 4, refresh: true }],
    ['升级≤2 不刷新', { upgradeAt: 2, refresh: false }],
    ['升级≤2 刷新 主乌萨斯', { upgradeAt: 2, refresh: true, focus: ['乌萨斯'] }],
    ['升级≤2 刷新 主精准灵巧', { upgradeAt: 2, refresh: true, focus: ['精准', '灵巧'] }]
  ]
  : [['规则脑', {}]];
// 规则规划器（planner.js，照搬复刻版 AI 的规则）：不带路线 / 带三种路线各跑一组
const { planRound } = await import('./planner.js');
if (argv.includes('--compare') || brainKind === 'planner') {
  variants.push(['规划器 不带路线', null, true, planRound, ''], ['规划器 主乌萨斯', null, true, planRound, '【本局路线】主玩「乌萨斯」，核心盟约 乌萨斯'],
    ['规划器 主莱塔尼亚', null, true, planRound, '【本局路线】主玩「莱塔尼亚」，核心盟约 莱塔尼亚，副 奥术 精准'], ['规划器 精准灵巧', null, true, planRound, '【本局路线】散修 精准 灵巧']);
  if (brainKind === 'planner') variants.splice(0, variants.length - 4);
}
for (const [name, opts, swaps = true, planner = null, extra = ''] of variants) {
  const res = [];
  for (let i = 0; i < games; i++) res.push(await playGame(1 + i, { brainOpts: opts || {}, swaps, planner, extra, verbose: argv.includes('-v') && i === 0 }));
  summary(name, res);
  if (argv.includes('-v')) console.log(res[0].log.join('\n'));
}
