// plugins/ark-garrison/review.js
//
// 每局打完的复盘：把这局每一步的记录（runs/*.jsonl）交给 Codex，让它总结这局怎么输 / 怎么赢、以后该怎么打。
// 经验写进 knowledge/lessons.md，每条必须引用这局里真实存在的步骤号（代码检查），引用不上的不记——不许编。
// 每局的结果另记一行到 data/ark-garrison/stats.jsonl，以后能看出哪种打法更稳。
// 下一局的每一步都会带上最近的经验（agent.js）。

import fs from 'node:fs';
import path from 'node:path';
import { WORK_DIR } from './maa.js';

const KB_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'knowledge');
export const LESSONS = path.join(KB_DIR, 'lessons.md');
const STATS = path.join(WORK_DIR, 'stats.jsonl');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    result: { type: 'string', enum: ['win', 'lose', 'unfinished'] },
    rounds: { type: 'number' },
    build: { type: 'string' },
    summary: { type: 'string' },
    lessons: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { lesson: { type: 'string' }, steps: { type: 'array', items: { type: 'number' } } },
        required: ['lesson', 'steps']
      }
    }
  },
  required: ['result', 'rounds', 'build', 'summary', 'lessons']
};

export async function reviewRun(runFile, ask, { mode = '', outcome = {} } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(runFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return { ok: false, error: '没有这局的记录' }; }
  const steps = lines.filter((l) => l.step && !l.timing || l.turn || l.settle);
  if (steps.length < 3) return { ok: false, error: '这局记录太短' };
  // 休整期（turn）记的是局面和逐条操作结果；结算（settle）是程序在结算页读到的输赢
  const line = (s) => {
    if (s.settle) return `#${s.step} [结算] ${s.settle.result === 'win' ? '通关' : '模拟中断（输）'}，通过回合 ${s.settle.rounds ?? '?'}`;
    if (s.turn) {
      const st = s.turn.state || {};
      return `#${s.step} [休整期 回合${st.round ?? '?'} 生命${st.hp ?? '?'} 资金${st.funds ?? '?'}] 盟约：${(st.alliances || []).join('、')}；木板：${(st.bench || []).join('、')}；商店：${(st.shop || []).join('、')} → ${(s.turn.notes || []).join(' ')}${s.memo ? `（备忘：${s.memo}）` : ''}`;
    }
    return `#${s.step} [${s.screen || ''}] ${s.observe || ''} → ${(s.actions || []).map((a) => `${a.type}${a.why ? `(${a.why})` : ''}`).join('；')}${s.noEffect ? ' ⚠点了没反应' : ''}${s.error ? ` ✗${s.error}` : ''}`;
  };
  const brief = steps.map(line).join('\n').slice(-30000);
  let old = '';
  try { old = fs.readFileSync(LESSONS, 'utf8').split('\n').filter((l) => l.startsWith('- ')).slice(-40).join('\n'); } catch { /* 第一局 */ }
  const prompt = [
    '你刚用模拟器打完一局明日方舟「卫戍协议」（单人模拟）。下面是这局每一步的记录（#步骤号 [界面] 看到的情况 → 做的操作）。',
    `模式：${mode}。程序看到的结束状态：${JSON.stringify(outcome)}`,
    outcome.settle ? `【结算页上读到的结果，以这个为准】${outcome.settle.result === 'win' ? '通关' : '模拟中断（输）'}，通过回合 ${outcome.settle.rounds ?? '?'}` : '',
    outcome.route ? `【这局开局定的路线】${outcome.route}` : '',
    `【这局的记录】\n${brief}`,
    old ? `【之前已经总结过的经验（别重复）】\n${old}` : '',
    '请复盘：',
    '- result：win（打到最后通关）/ lose（目标生命归零或失败）/ unfinished（没打完就停了）；rounds：打到第几回合；build：这局主要玩的盟约和核心干员；summary：两三句话说这局为什么赢 / 输。',
    '- lessons：以后要照做或避免的具体经验，最多 5 条，每条一句话（比如「第 1 回合买完人一定要拖上场再点准备就绪」「乌萨斯开局买到折桠就继续凑对子」）。'
      + '每条必须在 steps 里写出支撑它的步骤号（记录里真实存在的 #号）。没有证据的不要写，和之前经验重复的不要写。'
  ].filter(Boolean).join('\n\n');
  const r = await ask({ prompt, schema: SCHEMA, effort: 'high', search: false, timeoutMinutes: 6 });
  if (!r?.ok) return { ok: false, error: r?.error || '复盘失败' };
  const d = r.json || {};
  const valid = new Set(steps.map((s) => s.step));
  const day = new Date().toISOString().slice(0, 10);
  const base = path.basename(runFile);
  const kept = [];
  for (const l of Array.isArray(d.lessons) ? d.lessons : []) {
    const text = String(l?.lesson || '').trim().slice(0, 160);
    const ev = (l?.steps || []).filter((n) => valid.has(n));
    if (text.length < 6 || !ev.length || old.includes(text)) continue;
    kept.push(`- [${day}] ${text}（证据：${base} #${ev.slice(0, 6).join(' #')}）`);
  }
  if (kept.length) {
    if (!fs.existsSync(LESSONS)) fs.writeFileSync(LESSONS, '# 每局复盘总结出来的经验（每条都引用了当局记录里的步骤，记录在 data/ark-garrison/runs/）\n\n', 'utf8');
    fs.appendFileSync(LESSONS, `${kept.join('\n')}\n`, 'utf8');
  }
  fs.mkdirSync(path.dirname(STATS), { recursive: true });
  fs.appendFileSync(STATS, `${JSON.stringify({ at: new Date().toISOString(), mode, run: base, result: outcome.settle?.result || d.result, rounds: outcome.settle?.rounds ?? d.rounds, settled: Boolean(outcome.settle), route: outcome.route || undefined, build: d.build, summary: d.summary, lessons: kept.length })}\n`, 'utf8');
  return { ok: true, ...d, kept: kept.length };
}
