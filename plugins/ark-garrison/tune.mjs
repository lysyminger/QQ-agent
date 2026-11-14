// plugins/ark-garrison/tune.mjs —— 在本地假游戏（sim.js，S3 干员数据）上网格搜索 planner.js 的可调参数（KNOBS）。
//   node plugins/ark-garrison/tune.mjs [--games 60]
// 每组参数单独起一个 sim.mjs --brain planner（参数在模块加载时读 ARK_KNOBS），四种路线的平均撑到回合数当分数。
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const games = argv.includes('--games') ? argv[argv.indexOf('--games') + 1] : '60';
const sim = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'sim.mjs');
const grid = [
  ['默认', {}],
  ['木板囤5', { benchBuyCap: 5 }], ['木板囤9', { benchBuyCap: 9 }],
  ['留3', { benchKeep: 3 }], ['留6', { benchKeep: 6 }],
  ['刷新1', { maxRefresh: 1 }], ['刷新6', { maxRefresh: 6 }],
  ['升级晚1', { levelShift: 1 }], ['升级早1', { levelShift: -1 }],
];
for (const [name, knobs] of grid) {
  const out = execFileSync(process.execPath, [sim, '--brain', 'planner', '--games', games], { env: { ...process.env, ARK_KNOBS: JSON.stringify(knobs) }, encoding: 'utf8', maxBuffer: 1 << 26 });
  const rounds = [...out.matchAll(/平均撑到第 ([\d.]+) 回合/g)].map((m) => Number(m[1]));
  const wins = [...out.matchAll(/胜 (\d+)\//g)].map((m) => Number(m[1]));
  const avg = rounds.reduce((s, x) => s + x, 0) / (rounds.length || 1);
  console.log(`${name.padEnd(8)} 平均撑到 ${avg.toFixed(2)} 回合（各路线 ${rounds.join(' / ')}），胜 ${wins.reduce((s, x) => s + x, 0)}`);
}
