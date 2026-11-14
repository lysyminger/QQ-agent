// plugins/ark-garrison/runner.js
//
// 玩游戏的主循环：看一眼 → 能直接处理的界面直接处理 → 作战中只等不问 → 其余交给 Codex 决定 → 执行 → 再看。
//
// 几道保险：
//   · 花钱类确认框（充值、源石、寻访、退出登录…）出现时，只允许按返回键或点「取消 / 关闭 / 返回」；
//   · 每局有步数上限，Codex 连续出错或连续说卡住就停下，截图告诉主人；
//   · 每一步的决定写进 data/ark-garrison/runs/<时间>.jsonl，事后可以复盘。

import fs from 'node:fs';
import path from 'node:path';
import { decide, recordLearned, recordQuestion, __internal as agentInternal } from './agent.js';
import { classify, readSettle } from './screen.js';
import { openingStep, wantedStrategies, pickStrategy, readyStep } from './opening.js';
import { decodeRgb, isDark } from './tiles.js';
import { playRest } from './turn.js';

// 已知名字表（干员 / 盟约 / 策略 / 装备），给 OCR 读出来的名字纠错用
let KNOWN = null;
const knownNames = () => (KNOWN ||= [...agentInternal.loadIndex().keys()].filter((n) => n.length >= 2));
import { WORK_DIR } from './maa.js';
import { isQuotaError, waitForQuota } from './quota.js';

const RUN_DIR = path.join(WORK_DIR, 'runs');
// 卫戍商店里选中卡片也会出现「确认购买」（花的是局内资金），所以「购买」只有和源石 / 合成玉 / 钱一起出现才算危险
const DANGER_RE = /充值|支付|是否(花费|消耗|使用)源石|源石不足|购买礼包|寻访一次|寻访十次|开始招募|退出登录|切换账号|注销/;
const BUY_RE = /确认购买|购买/;
// 「源石溶剂」是卫戍里的一件装备，不算花源石
const MONEY_RE = /源石(?!溶剂)|合成玉|¥|￥|\d+元/;
const isDanger = (text) => DANGER_RE.test(text) || (BUY_RE.test(text) && MONEY_RE.test(text));
const SAFE_TARGET_RE = /取消|关闭|返回|放弃|稍后/;

/** 能直接处理、不用问 Codex 的界面。返回 { screen, actions } 或 null。 */
export function quickRule(look) {
  const t = look.text;
  // 每日配给：点下面的对勾
  if (/今日配给/.test(t)) return { screen: '今日配给', actions: [{ type: 'click', x: 640, y: 640, why: '领每日配给' }] };
  // 作战中：顶部正中是「击杀数/总数」，只需要等（OCR 常把 0 认成 O）
  const battle = look.items.some((i) => i.y < 45 && i.x > 570 && i.x < 710 && /^\D?[\dOo]{1,3}\s*\/\s*\d{1,3}$/.test(i.text.trim()));
  if (battle) return { screen: '作战中', actions: [{ type: 'wait', ms: 5000, why: '作战自动进行' }] };
  // 加载中
  // 关卡开场标题卡（OPERATION AC-SP-3 规程等级3）也只是过场
  if (!look.items.length || /加载中|正在连接|Loading|连接中|OPERATION|AC-SP-\d/.test(t)) return { screen: "加载中", actions: [{ type: "wait", ms: 3000, why: "等加载" }] };
  return null;
}

/** 危险界面上只放行返回键和「取消 / 关闭」类按钮。 */
export function guardActions(look, actions) {
  if (!isDanger(look.text)) return { actions, blocked: 0 };
  const near = (a) => look.items
    .map((i) => ({ i, d: Math.hypot(i.x - a.x, i.y - a.y) }))
    .sort((p, q) => p.d - q.d)[0];
  const ok = actions.filter((a) => {
    if (a.type === 'back' || a.type === 'wait') return true;
    if (a.type !== 'click') return false;
    const n = near(a);
    return n && n.d < 60 && SAFE_TARGET_RE.test(n.i.text);
  });
  return { actions: ok.length ? ok : [{ type: 'back', why: '花钱类确认框，按返回' }], blocked: actions.length - ok.length };
}

const isShop = (look) => /刷新/.test(look.text) && /(冻结|准备就绪|升级)/.test(look.text);

// 两屏文字的重合度：只比两个字以上的识别结果（图标乱码会随动画抖）
const textSet = (look) => new Set(look.items.map((i) => i.text.trim()).filter((t) => t.length >= 2));
export function sameScreen(a, b) {
  const A = textSet(a);
  const B = textSet(b);
  if (!A.size && !B.size) return true;
  let same = 0;
  for (const t of A) if (B.has(t)) same++;
  return same / Math.max(A.size, B.size) >= 0.92;
}

/**
 * 跑一个目标（enter / solo）。
 * deps: { eyes, ask(codex.run), report(text, file?), log, signal }
 * 返回 { ok, status, steps, reason }。
 */
export async function runGoal(goal, { eyes, ask, report, log = () => {}, signal, maxSteps = goal === 'enter' ? 40 : 400, extra = '', effort = null, quotaWaitMinutes = 20, quotaWait = waitForQuota, turns = true, route = '', planner = null }) {
  // 规则规划器跨回合的记忆（调度中心等级、主盟约、精锐、最大回合、这回合刷了几次）。
  // 存到 data/ark-garrison/planmem.json：换新代码重启后接着打同一局时读回来（20 分钟内写过的才算同一局），不然会忘了谁是精锐、把精锐当最弱的卖掉
  const MEM_FILE = path.join(WORK_DIR, 'planmem.json');
  const planMem = (() => {
    try {
      const st = fs.statSync(MEM_FILE);
      if (Date.now() - st.mtimeMs > 20 * 60 * 1000) return {};
      const j = JSON.parse(fs.readFileSync(MEM_FILE, 'utf8'));
      if (Array.isArray(j.elites)) j.elites = new Set(j.elites);
      return j;
    } catch { return {}; }
  })();
  const saveMem = () => { try { fs.writeFileSync(MEM_FILE, JSON.stringify({ ...planMem, elites: [...(planMem.elites || [])] })); } catch { /* ignore */ } };
  const openingSeen = {};   // 开局三步各看到几次（点过一次就先等）
  let pickConfirms = 0;      // 选择界面连着程序点了几次「确认」
  // 开局定下的路线（route.js）：选策略 / 盟约、每回合买人都照它走
  if (route) extra = `${extra}${extra ? '\n' : ''}【本局路线】${route}`;
  let settle = null;  // 结算页上读到的输赢（不靠复盘去猜）
  const bench = [];   // 木板上谁站在哪：[{ x, name }]（跨回合记着；人不会自己挪，换地图时位置变了会重新认）
  const board = [];   // 场上谁站在哪：[{ x, y, name }]
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const runFile = path.join(RUN_DIR, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${goal}.jsonl`);
  const history = [];
  let memo = '';
  let fails = 0;
  let stuck = 0;
  let lastScreen = '';
  let lastShotAt = 0;
  let lastSayAt = 0;
  let learnedCount = 0;
  let prevLook = null;      // 上一步操作前的画面
  let prevActed = false;    // 上一步有没有点 / 拖
  let noEffect = 0;         // 连续几步点了画面都没变

  const note =(obj) => { try { fs.appendFileSync(runFile, `${JSON.stringify({ at: Date.now(), ...obj })}\n`, 'utf8'); } catch { /* ignore */ } };

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) return { ok: false, status: 'stopped', steps: step - 1, reason: '主人叫停了' };
    let look;
    const t0 = Date.now();
    const ms = { look: 0, grid: 0, think: 0, act: 0 };   // 这一步各段耗时，记进 runs/*.jsonl 好找慢在哪
    try {
      look = await eyes.look({ withGrid: false });
      ms.look = Date.now() - t0;
    } catch (e) {
      fails++;
      log(`截图失败：${e.message}`);
      if (fails >= 3) return { ok: false, status: 'error', steps: step, reason: `截图连续失败：${e.message}` };
      await eyes.sleep(3000);
      continue;
    }

    // 上一步点了 / 拖了，画面却几乎没变：多半没点中或者点法不对，告诉 Codex 换办法
    if (prevActed && prevLook && sameScreen(prevLook, look) && history.length) {
      noEffect++;
      history[history.length - 1].note = `点完画面几乎没变（连续 ${noEffect} 次），可能没点中、点错了位置，或者这里要拖动 / 先关弹窗；换个办法`;
    } else noEffect = 0;

    // ── 结算页：直接读输赢，点「返回主页」，这局就算打完 ──
    const sv = goal !== 'enter' ? readSettle(look) : null;
    if (sv) {
      settle = sv;
      try { fs.rmSync(MEM_FILE, { force: true }); } catch { /* ignore */ }   // 这局完了，记忆别带到下一局
      note({ step, settle: sv, screen: '结算' });
      log(`结算：${sv.result === 'win' ? '通关' : '模拟中断（输）'}，通过回合 ${sv.rounds ?? '?'}`);
      await report(sv.result === 'win' ? `通关了！打了 ${sv.rounds ?? '?'} 回合` : `这把没守住，撑到第 ${sv.rounds ?? '?'} 回合`, look.file);
      const home = look.items.find((i) => /返回主页/.test(i.text));
      if (home) { await eyes.tap(home.x, home.y); await eyes.sleep(2500); }
      return { ok: true, status: 'done', steps: step, learned: learnedCount, file: look.file, screen: '结算', settle };
    }

    // ── 黑屏（加载 / 转场）：不问模型，等一下再看 ──
    if (goal !== 'enter' && !look.items.some((i) => i.text.trim().length >= 2)) {
      try { if (isDark(await decodeRgb(look.file))) { await eyes.sleep(2500); step--; continue; } } catch { /* 解不了图就照常 */ }
    }

    // ── 三选一的选择界面（道具补给、战术决策、机变）：选好了、「确认」按钮露出来了就程序直接点，不再问模型 ──
    // 模型常常「点选项 + 盲点确认 + 收起」一口气做完，确认没点上，界面弹回来；这里接住。连着最多点 2 次，点不动就交还给模型
    if (goal !== 'enter' && /补给|战术决策|机变|悬赏/.test(look.text)) {
      const btn = look.items.find((i) => /^确认(选择)?$/.test(i.text.trim()) && i.x > 640 && i.y > 420);
      if (btn && (pickConfirms = pickConfirms + 1) <= 2) {
        await eyes.tap(btn.x, btn.y);
        await eyes.sleep(1200);
        note({ step, screen: '选择界面：点确认', quick: true });
        step--;
        continue;
      }
    } else pickConfirms = 0;

    // ── 开局三步程序直接走（opening.js）：确认本局信息 / 选策略（照路线的首选、备选）/ 自选编队 ──
    // 同一步点过了就先等（联机要等队友都确认），隔几眼还在才再点一次
    const ostep = turns && goal !== 'enter' ? openingStep(look) : 0;
    if (ostep) {
      // 新的一局开局：上一局的规划记忆清掉
      if (ostep === 1 && !openingSeen[1]) { for (const k of Object.keys(planMem)) delete planMem[k]; try { fs.rmSync(MEM_FILE, { force: true }); } catch { /* ignore */ } }
      const seen = (openingSeen[ostep] = (openingSeen[ostep] || 0) + 1);
      if (seen === 1 || seen % 4 === 0) {
        if (ostep === 2) {
          const r = await pickStrategy({ eyes, look, want: wantedStrategies(route), log });
          note({ step, screen: '开局选策略', quick: true, opening: r });
        } else {
          await readyStep(eyes, look);
          note({ step, screen: ostep === 1 ? '开局确认本局信息' : '开局确定自选编队', quick: true });
        }
      } else await eyes.sleep(1500);
      step--;
      continue;
    }

    // ── 认识的界面走程序：休整期「一回合问一次」，作战 / 横幅 / 准备确认框不问模型 ──
    const kind = turns && goal !== 'enter' && !noEffect ? classify(look) : null;
    if (kind?.kind === 'battle' || kind?.kind === 'roundBanner' || kind?.kind === 'restWaiting') {
      if (kind.kind === 'battle') planMem.sawBattle = true;   // 下个休整期回合数读不出时按 +1 算
      note({ step, timing: { ...ms, act: 0 }, quick: true, screen: kind.kind });
      await eyes.sleep(kind.kind === 'battle' ? 4000 : 1500);
      step--;            // 等待不占步数
      continue;
    }
    if (kind?.kind === 'decisionHidden') {
      // 收起来的战术决策：点「回到决策」，下一眼就是选项界面，交给看图模式去选
      await eyes.tap(...kind.tap);
      await eyes.sleep(1200);
      note({ step, screen: '回到决策', timing: ms, quick: true });
      continue;
    }
    if (kind?.kind === 'readyConfirm') {
      const btn = look.items.find((i) => /^确认$/.test(i.text.trim()) && i.x > 800);
      await eyes.tap(...(btn ? [btn.x, btn.y] : [970, 485]));
      await eyes.sleep(1200);
      continue;
    }
    if (kind?.kind === 'rest') {
      const tr = await playRest({ eyes, ask, known: knownNames(), memo, extra, log, report, bench, board, planner, mem: planMem, effort: effort?.(look, true) || 'medium' });
      saveMem();
      ms.think = Date.now() - t0 - ms.look;
      note({ step, turn: { ok: tr.ok, readied: tr.readied, asks: tr.asks, notes: tr.notes, why: tr.why, state: tr.state }, memo: tr.memo, timing: ms, screen: `休整期 回合${tr.state?.round ?? '?'} 生命${tr.state?.hp ?? '?'}` });
      if (!tr.ok && isQuotaError(tr.error)) {
        const w = await quotaWait({ error: tr.error, signal, report, log, maxMinutes: quotaWaitMinutes });
        if (!w.ok) return { ok: false, status: w.status, steps: step, reason: w.reason, file: look.file };
        step--;
        continue;
      }
      memo = tr.memo || memo;
      if (!tr.ok) {
        fails++;
        log(`休整期没走通：${tr.why}`);
        if (fails >= 3) return { ok: false, status: 'error', steps: step, reason: `休整期连续出问题：${tr.why}`, file: look.file };
      } else fails = 0;
      prevLook = null;
      prevActed = false;
      continue;
    }

    let screen;
    let actions;
    let say = '';
    const quick = noEffect ? null : quickRule(look);
    if (quick) {
      ({ screen, actions } = quick);
    } else {
      // 只有要问 Codex 时才画网格（省一次 ffmpeg）
      const tg = Date.now();
      try { look = { ...look, grid: await eyes.gridFor(look.file) }; } catch { /* 没网格就用原图 */ }
      ms.grid = Date.now() - tg;
      const tt = Date.now();
      const r = await decide({ ask, goal, look, history, memo, extra, effort: effort?.(look, isShop(look)) || (isShop(look) ? 'medium' : 'low') });
      ms.think = Date.now() - tt;
      if (!r.ok && isQuotaError(r.error)) {
        // 额度用完不算出错：等 Cockpit 换号（或额度恢复）再重来这一步，这一步也不占步数
        note({ step, quota: r.error });
        const w = await quotaWait({ error: r.error, signal, report, log, maxMinutes: quotaWaitMinutes });
        if (!w.ok) return { ok: false, status: w.status, steps: step, reason: w.reason, file: look.file };
        step--;
        continue;
      }
      if (!r.ok) {
        fails++;
        note({ step, error: r.error });
        log(`Codex 出错：${r.error}`);
        if (fails >= 3) return { ok: false, status: 'error', steps: step, reason: `Codex 连续出错：${r.error}`, file: look.file };
        continue;
      }
      fails = 0;
      const d = r.decision;
      screen = d.screen || '?';
      // OCR 没认出结算页、但模型看图说这是「模拟中断 / 结算」：也按结算处理（截图另存一份，好以后校准 OCR 规则）
      if (goal !== 'enter' && /模拟中断|结算/.test(screen) && /返回主页|通过回合|模拟中断/.test(`${screen}${d.observe || ''}`)) {
        const m = `${d.observe || ''}`.match(/通过回合[^d]{0,3}(d{1,2})/);
        settle = { result: /中断|失败/.test(`${screen}${d.observe || ''}`) ? 'lose' : 'win', rounds: m ? Number(m[1]) : null, text: look.text.slice(0, 160), by: 'vision' };
        try { fs.copyFileSync(look.file, path.join(WORK_DIR, 'probe', `settle-${Date.now()}.png`)); } catch { /* ignore */ }
        note({ step, settle, screen: '结算', observe: d.observe });
        log(`结算（看图认出）：${settle.result === 'win' ? '通关' : '模拟中断（输）'}，通过回合 ${settle.rounds ?? '?'}；OCR 原文：${look.text.slice(0, 120)}`);
        await report(settle.result === 'win' ? `通关了！打了 ${settle.rounds ?? '?'} 回合` : `这把没守住，撑到第 ${settle.rounds ?? '?'} 回合`, look.file);
        const home = look.items.find((i) => /返回主页/.test(i.text));
        if (home) await eyes.tap(home.x, home.y); else for (const a of d.actions || []) if (a.type === 'click') { await eyes.tap(a.x, a.y); break; }
        await eyes.sleep(2500);
        return { ok: true, status: 'done', steps: step, learned: learnedCount, file: look.file, screen: '结算', settle };
      }
      actions = d.actions;
      memo = d.memo || memo;
      say = String(d.say || '').trim();
      learnedCount += recordLearned(d.learned, look);
      recordQuestion(d.unknown, look);
      // Codex 认成作战中：快速规则漏了。把顶部的识别文字存下来，好补规则
      const ocrTop = /作战/.test(screen) ? look.items.filter((i) => i.y < 80).map((i) => `${i.text}@${i.x},${i.y}`) : undefined;
      note({ step, screen, observe: d.observe, memo: d.memo, actions, status: d.status, say, learned: d.learned, unknown: d.unknown, noEffect, ocrTop });
      if (d.status === 'done') {
        if (say) await report(say, look.file);
        return { ok: true, status: 'done', steps: step, learned: learnedCount, file: look.file, screen, settle };
      }
      if (d.status === 'stuck' || !actions.length) {
        stuck++;
        if (stuck >= 3) return { ok: false, status: 'stuck', steps: step, reason: d.observe || '不知道下一步该做什么', file: look.file, screen };
      } else stuck = 0;
    }

    // 进度：换了界面就（最多 20 秒一次）截图说一声；作战中、加载中不刷屏
    if (screen !== lastScreen && !/作战中|加载中/.test(screen) && Date.now() - lastShotAt > 20000 && goal === 'enter') {
      lastShotAt = Date.now();
      await report(`现在到：${screen}`, look.file);
    }
    if (say && Date.now() - lastSayAt > 45000) {
      lastSayAt = Date.now();
      await report(say, look.file);
    }
    lastScreen = screen;

    const guarded = guardActions(look, actions);
    if (guarded.blocked) log(`拦下了 ${guarded.blocked} 个危险操作（${screen}）`);
    const ta = Date.now();
    for (const a of guarded.actions) {
      if (signal?.aborted) break;
      if (a.type === 'click') await eyes.tap(a.x, a.y);
      else if (a.type === 'drag') await eyes.drag(a.x, a.y, a.x2, a.y2, a.ms || 1200, a.dir === 'none' ? '' : a.dir);
      else if (a.type === 'back') await eyes.back();
      await eyes.sleep(a.type === 'wait' ? Math.max(500, a.ms || 2000) : 900);
    }
    ms.act = Date.now() - ta;
    note({ step, timing: ms, quick: Boolean(quick), screen });
    history.push({ screen, actions: guarded.actions.map(describe).join('；'), note: guarded.blocked ? '有操作被安全规则拦下' : '' });
    if (history.length > 12) history.shift();
    prevLook = look;
    prevActed = guarded.actions.some((a) => a.type === 'click' || a.type === 'drag');
  }
  return { ok: false, status: 'limit', steps: maxSteps, reason: `走了 ${maxSteps} 步还没完成` };
}

function describe(a) {
  if (a.type === 'click') return `点(${a.x},${a.y})${a.why ? ` ${a.why}` : ''}`;
  if (a.type === 'drag') return `拖(${a.x},${a.y})→(${a.x2},${a.y2})${a.dir && a.dir !== 'none' ? ` 朝${a.dir}` : ''}${a.why ? ` ${a.why}` : ''}`;
  if (a.type === 'back') return '返回键';
  return `等${Math.round((a.ms || 0) / 1000)}秒`;
}
