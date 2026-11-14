// plugins/ark-garrison/route.js
//
// 「开局布局」：每局开打前问一次模型，定下这局主玩什么——核心盟约、关键干员、开局选哪个策略、升级 / 刷新节奏、
// 什么情况下换路线。之后选策略 / 盟约的界面、每个休整期的买人清单都会带上这条路线（runner 的 route 参数）。
//
// 依据：knowledge/04-流派与打法.md（社区流派）、00-速查、之前每局的复盘经验（lessons.md），
// 以及最近几局的战绩（stats.jsonl：走的什么路线、撑到第几回合、输赢）——输过的路线换个思路，赢过的接着用。

import fs from 'node:fs';
import path from 'node:path';
import { WORK_DIR } from './maa.js';

const KB = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'knowledge');
const readKb = (f) => { try { return fs.readFileSync(path.join(KB, f), 'utf8'); } catch { return ''; } };
const STATS = path.join(WORK_DIR, 'stats.jsonl');

export const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    route: { type: 'string' },        // 流派名，比如「6 乌萨斯 + 冻河」
    core: { type: 'string' },         // 核心盟约（和凑到几人）
    keyUnits: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    strategy: { type: 'string' },     // 开局选哪个策略（分队），选不到时的备选
    economy: { type: 'string' },      // 升级调度中心 / 刷新 / 存钱的节奏
    pivot: { type: 'string' },        // 什么情况下换路线、换成什么
    why: { type: 'string' }
  },
  required: ['route', 'core', 'keyUnits', 'strategy', 'economy', 'pivot', 'why']
};

/** 最近几局的战绩，给模型参考（哪条路线撑得久）。 */
export function recentRecords(n = 8) {
  try {
    return fs.readFileSync(STATS, 'utf8').split('\n').filter((l) => l.trim()).slice(-n).map((l) => JSON.parse(l))
      .map((j) => `- ${j.mode}：${j.result === 'win' ? '通关' : j.result === 'lose' ? '输' : '没打完'}，到第 ${j.rounds ?? '?'} 回合；${j.route ? `路线「${j.route}」；` : ''}阵容：${String(j.build || '').slice(0, 80)}`)
      .join('\n');
  } catch { return ''; }
}

/**
 * 按路线汇总战绩：每条路线打了几局、平均撑到第几回合、通关几次。
 * 路线名各局写法不完全一样，按里面出现的核心盟约名归类（取第一个认得的盟约）。
 */
const ALLIANCES = ['乌萨斯', '莱塔尼亚', '阿戈尔', '伊比利亚', '叙拉古', '维多利亚', '卡西米尔', '炎', '萨尔贡', '谢拉格', '精准', '灵巧', '迅捷', '坚守', '奥术', '不屈', '聚合'];
export function routeTable() {
  const rows = new Map();
  try {
    for (const l of fs.readFileSync(STATS, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const j = JSON.parse(l);
      if (!j.route) continue;
      const key = ALLIANCES.find((a) => j.route.includes(a)) || j.route.slice(0, 10);
      const row = rows.get(key) || { key, games: 0, rounds: 0, wins: 0 };
      row.games++; row.rounds += Number(j.rounds) || 0; if (j.result === 'win') row.wins++;
      rows.set(key, row);
    }
  } catch { /* 还没有战绩 */ }
  return [...rows.values()].map((x) => ({ ...x, avg: x.games ? x.rounds / x.games : 0 })).sort((a, b) => b.wins - a.wins || b.avg - a.avg);
}

/** 把路线压成一段话，塞进之后每一步的提示里。 */
export function routeText(r) {
  if (!r) return '';
  return [
    `主玩「${r.route}」，核心盟约 ${r.core}`,
    r.keyUnits?.length ? `关键干员：${r.keyUnits.join('、')}（商店出现优先买、凑对子合精锐）` : '',
    `开局策略：${r.strategy}`,
    `节奏：${r.economy}`,
    `换路线：${r.pivot}`
  ].filter(Boolean).join('；');
}

/** 问一次模型定路线。返回 { ok, plan, text } 或 { ok:false, error }。 */
export async function makeRoute(ask, { level = 1, mode = '', exploreRate = 0.25, random = Math.random } = {}) {
  const table = routeTable();
  // 探索还是利用：大多数局走战绩最好的路线把它打磨好；约四分之一的局换一条最近少走的试试，免得一直守着次优解
  const explore = table.length >= 1 && random() < exploreRate;
  const tableText = table.map((x) => `- ${x.key}：${x.games} 局，平均撑到第 ${x.avg.toFixed(1)} 回合，通关 ${x.wins} 次`).join('\n');
  const prompt = [
    /联合/.test(mode)
      ? '你要替主人打一局明日方舟「卫戍协议·规程」的联合模拟·标准（和随机匹配的陌生人 4 人联机，强度 +8，有联防阶段，领袖轮合血一起打）。开打前先定好这局的路线，之后每回合都照着买人、摆人。别拖队友后腿：前期稳住不漏怪最要紧。'
      : `你要替主人打一局明日方舟「卫戍协议·规程」的标准独立模拟，规程等级 ${level}。开打前先定好这局的路线，之后每回合都照着买人、摆人。`,
    '目标：通关（熬过最后的领袖轮，目标生命不掉到 0）。前期别贪，掉血太多后面撑不住；目标生命 10 以下是斩杀线。',
    recentRecords() ? `【最近几局的战绩（每局都输了的路线，想想是哪里不够，必要时换思路）】\n${recentRecords()}` : '',
    tableText ? `【各路线汇总】\n${tableText}` : '',
    explore
      ? '【这局要探索】请选一条和上面汇总里打得最多的不同的核心盟约路线（社区认可的强势路线优先，比如乌萨斯、莱塔尼亚 + 奥术 + 精准、精准 + 灵巧散修），看看是不是更强。'
      : (table.length ? '【这局要利用】优先选汇总里撑得最久 / 通关最多的路线，结合复盘经验改进打法；那条路线局数太少（少于 2 局）也可以按社区推荐选。' : ''),
    '社区共识（2026-11 B 站攻略）：这一期公认最强的是乌萨斯（迅捷 + 奥术辅助、冻河）和莱塔尼亚（奥术 + 精准），小盟约「精准 + 灵巧 + 一名机械师抗线」最稳、不容易翻车。',
    readKb('lessons.md') ? `【之前复盘的经验】\n${readKb('lessons.md').split('\n').filter((l) => l.startsWith('- ')).slice(-20).join('\n')}` : '',
    `【规则和原则】\n${readKb('00-速查.md')}`,
    `【高手打法（分阶段）】\n${readKb('07-高手打法.md')}`,
    `【社区流派和打法】\n${readKb('04-流派与打法.md')}`,
    '【怎么回答】route：流派名；core：核心盟约和要凑到几人；keyUnits：这条路线的关键干员（最多 8 个，写游戏里的名字）；'
      + 'strategy：开局选哪个策略（分队），写一个首选和一个备选；economy：什么时候升级调度中心、什么时候刷新、哪些回合存钱；'
      + 'pivot：开局几回合商店都不出核心牌时换成什么；why：一句话说为什么选这条（结合战绩）。都要短，每项不超过 60 字。'
  ].filter(Boolean).join('\n\n');
  const r = await ask({ prompt, schema: ROUTE_SCHEMA, effort: 'medium', timeoutMinutes: 4 });
  if (!r?.ok) return { ok: false, error: r?.error || '定路线失败' };
  return { ok: true, plan: r.json, text: routeText(r.json), explore };
}
