// plugins/ark-garrison/play.mjs —— 命令行试玩：不经过 QQ，直接让 Codex 看着模拟器玩。
//
//   node plugins/ark-garrison/play.mjs enter                     走到卫戍协议入口
//   node plugins/ark-garrison/play.mjs indie 1                   个人模拟 · 标准独立模拟 · 规程等级 1，打完一局
//   node plugins/ark-garrison/play.mjs solo                      个人模拟 · 极速模拟，打完一局
//
// 每一步的决定在 data/ark-garrison/runs/ 里；「要跟群友说的话」在这里只打印出来。
// 环境变量：ARK_MODEL 指定模型（默认用 Codex 自己的配置），CODEX_JS 指定 codex.js 路径。

import { createEyes } from './eyes.js';
import { createLocalAsk } from './codex-local.js';
import { createFastAsk } from './codex-fast.js';
import { createClaudeAsk, withFallback } from './claude-ask.js';
import { isQuotaError } from './quota.js';
import { runGoal } from './runner.js';

const [goal = 'enter', level = ''] = process.argv.slice(2);
const extra = goal === 'indie' ? `规程等级 ${level || 1}` : '';
const eyes = createEyes();
// 决策用谁：ARK_BRAIN=claude 走主人的 Claude 订阅（Claude Agent SDK，默认 sonnet）；默认 Codex 常驻 app-server；ARK_ASK=exec 退回每步起一次 codex exec
const codexAsk = () => (process.env.ARK_ASK === 'exec' ? createLocalAsk() : createFastAsk());
// claude 额度用完或登录失效时 30 分钟内退回 Codex
const ask = process.env.ARK_BRAIN === 'claude'
  ? withFallback(createClaudeAsk(), codexAsk(), { isQuota: (e) => isQuotaError(e) || /没登录/.test(e), log: (t) => console.log(t) })
  : codexAsk();
const ac = new AbortController();
process.on('SIGINT', () => ac.abort());

const time = () => new Date().toTimeString().slice(0, 8);
const loggingAsk = async (opts) => {
  const r = await ask(opts);
  if (r.ok) {
    const d = r.json || {};
    console.log(`${time()} [Codex ${r.seconds}s] ${d.screen} | ${d.observe}\n          → ${(d.actions || []).map((a) => `${a.type}(${a.x},${a.y}${a.type === 'drag' ? `→${a.x2},${a.y2}` : ''}) ${a.why}`).join('；')}${d.say ? `\n          说：${d.say}` : ''}`);
  } else console.log(`${time()} [Codex 失败 ${r.seconds}s] ${r.error}`);
  return r;
};

const res = await runGoal(goal, {
  eyes,
  ask: loggingAsk,
  extra,
  signal: ac.signal,
  // 额度管够：商店（做决定）用 high，其余 medium
  effort: (look, shop) => (shop ? 'medium' : 'low'),   // high 每步多十几秒，商店 medium 够用
  report: async (text, file) => console.log(`${time()} [发群] ${text}${file ? `（截图 ${file}）` : ''}`),
  log: (t) => console.log(`${time()} ${t}`)
});
console.log(`${time()} 结束：${JSON.stringify(res)}`);
eyes.close();
ask.close?.();
