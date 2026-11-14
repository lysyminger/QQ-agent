// plugins/ark-garrison/train.mjs —— 自动连打 + 每局复盘：Codex 自己打很多局，每局打完总结经验写到本地，下一局带上。
//
//   node plugins/ark-garrison/train.mjs                 一直打标准独立模拟，从赢过的最高规程等级的下一级开始（stats.jsonl），共 100 局
//   node plugins/ark-garrison/train.mjs --games 30      共 30 局
//   node plugins/ark-garrison/train.mjs --mode coop     联合模拟标准，随机匹配陌生人（不进群友房间）
//   node plugins/ark-garrison/train.mjs --quota-wait 120  Codex 额度用完时最多等 120 分钟（默认 360）
//   额度用完：等 Cockpit Tools 自动换号（要在 Cockpit 里打开 Codex 自动切号），换好接着打；号都用完就等最早恢复的那个
//   停：Ctrl+C，或者建一个文件 data/ark-garrison/STOP（打完手上这一步就停）
//
// 产出（都在本地）：
//   knowledge/lessons.md      每局复盘的经验（每条引用当局步骤号作证据），之后每一步都会带上
//   knowledge/learned.md      打的时候在画面上读到的新规则 / 界面经验（有原文和截图）
//   knowledge/questions.md    没看懂、要以后查的
//   data/ark-garrison/stats.jsonl   每局结果：赢 / 输、打到第几回合、玩的什么
//   data/ark-garrison/runs/*.jsonl  每一步的决定
//   data/ark-garrison/train.log     这个脚本的日志

import fs from 'node:fs';
import path from 'node:path';
import { createEyes } from './eyes.js';
import { createLocalAsk } from './codex-local.js';
import { createFastAsk } from './codex-fast.js';
import { createClaudeAsk, withFallback } from './claude-ask.js';
import { runGoal } from './runner.js';
import { reviewRun } from './review.js';
import { makeRoute } from './route.js';
import { planRound } from './planner.js';
import { WORK_DIR } from './maa.js';
import { isQuotaError, waitForQuota } from './quota.js';

const argv = process.argv.slice(2);
const total = Number(argv[argv.indexOf('--games') + 1]) || 100;
// 额度用完时最多等多久（分钟）：Cockpit 会自动换号；三个号都用完就等最早恢复的那个，超过这个时间才停
const QUOTA_WAIT_MIN = Number(argv[argv.indexOf('--quota-wait') + 1]) || 360;
const STOP = path.join(WORK_DIR, 'STOP');
const LOG = path.join(WORK_DIR, 'train.log');
fs.mkdirSync(WORK_DIR, { recursive: true });
try { fs.rmSync(STOP, { force: true }); } catch { /* ignore */ }

const log = (t) => {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${t}`;
  console.log(line);
  try { fs.appendFileSync(LOG, `${line}\n`, 'utf8'); } catch { /* ignore */ }
};

// 先按主人说的顺序打独立模拟 1、2、3，之后都打极速模拟
// 打哪一级：按战绩来（stats.jsonl 里赢过的最高等级 + 1，最高 20），中途重启也不会从等级 1 重新数。
// 复盘判的「赢」不一定准：真通关了游戏才会解锁下一级；没解锁时让它打能选的最高一级（见 agent.js 的 indie 目标）。
const STATS = path.join(WORK_DIR, 'stats.jsonl');
function nextLevel() {
  let best = 0;
  try {
    for (const l of fs.readFileSync(STATS, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const j = JSON.parse(l);
      const m = String(j.mode || '').match(/规程等级\s*(\d+)/);
      if (m && j.result === 'win') best = Math.max(best, Number(m[1]));
    }
  } catch { /* 还没有战绩 */ }
  // --level N：主人说能打到第几级了（战绩表可能没记到之前的通关），取两者大的
  const asked = argv.includes('--level') ? Number(argv[argv.indexOf('--level') + 1]) || 0 : 0;
  return Math.min(20, Math.max(asked, best + 1));
}
// --mode coop：联合模拟标准，随机匹配（不进群友房间）；默认单人独立模拟
const MODE = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'indie';
const plan = () => {
  if (MODE === 'coop') return { goal: 'coop', extra: '联合模拟·标准模拟（随机匹配）', label: '联合模拟标准' };
  const lv = nextLevel();
  return { goal: 'indie', extra: `规程等级 ${lv}`, label: `独立模拟规程等级${lv}` };
};

const eyes = createEyes();
// 决策用谁：ARK_BRAIN=claude 走主人的 Claude 订阅（Claude Agent SDK，默认 sonnet）；默认 Codex 常驻 app-server；ARK_ASK=exec 退回每步起一次 codex exec
const codexAsk = () => (process.env.ARK_ASK === 'exec' ? createLocalAsk() : createFastAsk());
// claude 额度用完或登录失效时 30 分钟内退回 Codex
const ask = process.env.ARK_BRAIN === 'claude'
  ? withFallback(createClaudeAsk(), codexAsk(), { isQuota: (e) => isQuotaError(e) || /没登录/.test(e), log: (t) => console.log(t) })
  : codexAsk();
const ac = new AbortController();
process.on('SIGINT', () => ac.abort());
const stopWatch = setInterval(() => { if (fs.existsSync(STOP)) ac.abort(); }, 3000);

let fails = 0;
// 面板「卫戍训练」卡片（trainctl.js）靠 pid 文件看训练在不在跑
const PID_FILE = path.join(WORK_DIR, 'train.pid');
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { if (fs.readFileSync(PID_FILE, 'utf8') === String(process.pid)) fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ } });
// 联机绝不能中途杀进程：休整期没点「准备就绪」连着几回合，游戏会弹「当前多回合无操作，即将离开模拟」，算违规退出，多了会禁止模拟。
// 所以「换新代码」和「暂停」都只在两局之间生效：
//   RESTART  打完手上这局，起一个新的自己（用新代码）接着打，旧的退出
//   PAUSE    打完手上这局就停在这里等，文件删掉（面板点「继续」）再接着打
const RESTART = path.join(WORK_DIR, 'RESTART');
const PAUSE = path.join(WORK_DIR, 'PAUSE');
for (let i = 0; i < total && !ac.signal.aborted; i++) {
  if (fs.existsSync(RESTART)) {
    fs.rmSync(RESTART, { force: true });
    log('有 RESTART 标记：这局打完了，换新代码重新起');
    clearInterval(stopWatch); eyes.close(); ask.close?.();
    const { spawn } = await import('node:child_process');
    spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
    process.exit(0);
  }
  if (fs.existsSync(PAUSE)) {
    log('暂停中：面板点「继续」（或删掉 data/ark-garrison/PAUSE）接着打');
    while (fs.existsSync(PAUSE) && !ac.signal.aborted) await eyes.sleep(3000);
    if (ac.signal.aborted) break;
    log('继续训练');
  }
  const p = plan(i);
  log(`第 ${i + 1}/${total} 局开始：${p.label}`);
  const runsBefore = new Set(fs.readdirSync(path.join(WORK_DIR, 'runs')).filter((f) => f.endsWith('.jsonl')));
  // 开局布局：先定这局的路线（流派、核心盟约、关键干员、开局策略、节奏），之后每一步都照着走
  const lv = Number(String(p.extra).match(/\d+/)?.[0]) || 1;
  const rt = await makeRoute(ask, { level: lv, mode: p.label });
  log(rt.ok ? `本局路线（${rt.explore ? '探索' : '利用'}）：${rt.text}（${rt.plan.why}）` : `定路线失败：${rt.error}，这局不带路线`);
  let res;
  try {
    res = await runGoal(p.goal, {
      eyes, ask, extra: p.extra, signal: ac.signal, route: rt.ok ? rt.text : '',
      effort: (look, shop) => (shop ? 'medium' : 'low'),   // high 每步多十几秒，商店 medium 够用
      quotaWaitMinutes: QUOTA_WAIT_MIN,
      // 休整期默认用规则规划器（planner.js，照搬复刻版 AI 的规则，不花额度）；ARK_PLANNER=0 改回每回合问模型
      planner: process.env.ARK_PLANNER === '0' ? null : planRound,
      report: async (text) => log(`[想说] ${text}`),
      log
    });
  } catch (e) {
    res = { ok: false, status: 'error', reason: e.message };
  }
  log(`第 ${i + 1} 局结束：${JSON.stringify({ ...res, file: undefined })}`);
  const runFile = fs.readdirSync(path.join(WORK_DIR, 'runs')).filter((f) => f.endsWith('.jsonl') && !runsBefore.has(f)).sort().pop();
  if (res.status === 'quota') { log(`${res.reason}，训练先停下`); break; }
  if (runFile) {
    // 实际打的是哪种：结算页上写着「规程等级 N」就是单人独立模拟（比如切到联机前接着打完的那局），否则按计划记
    const lvMatch = String(res.settle?.text || '').match(/规程等级\s*(\d+)/);
    const actualMode = lvMatch ? `独立模拟规程等级${lvMatch[1]}` : p.label;
    const review = () => reviewRun(path.join(WORK_DIR, 'runs', runFile), ask, { mode: actualMode, outcome: { status: res.status, steps: res.steps, reason: res.reason, settle: res.settle, route: rt.ok ? rt.plan.route : '' } });
    let rv = await review();
    // 复盘时碰上额度用完：等换号再复盘一次
    if (!rv.ok && isQuotaError(rv.error) && (await waitForQuota({ error: rv.error, signal: ac.signal, log, report: async (t) => log(t), maxMinutes: QUOTA_WAIT_MIN })).ok) rv = await review();
    log(rv.ok ? `复盘：${rv.result}，打到第 ${rv.rounds} 回合，${rv.build}。${rv.summary}（新记经验 ${rv.kept} 条）` : `复盘失败：${rv.error}`);
  }
  // 连续三局都是出错 / 卡住，说明遇到解决不了的东西，停下等人看
  fails = res.ok ? 0 : fails + 1;
  if (fails >= 3) { log('连续 3 局没打完，先停下，看 train.log 和 runs/ 里最后几局'); break; }
  if (!res.ok && res.status !== 'stopped') i--;   // 没打完的这局不算数，下一轮按同一个计划继续（会先接着打没完的局）
  await eyes.sleep(3000);
}
clearInterval(stopWatch);
eyes.close();
ask.close?.();
log('训练结束');
