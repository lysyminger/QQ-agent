// plugins/ark-garrison/planner.js
//
// 规则规划器：一回合的操作清单由程序按规则算出来，不问模型。照搬复刻版 sganggs/Stronghold-Protocol 的 AI 队友
// （server/match/bot.js 的 botPrep，用真实模拟调过、对比实验验证过的打法）的经济和阵容规则，改成这一期能用的形式：
//
//   1. 主盟约 / 副盟约：开局路线（route.js）定的核心盟约优先；没有就挑手上已有成员最多的核心盟约，再挑一个副盟约。
//      上回合的主盟约不轻易换（不来回横跳）。
//   2. 先补满场：场上没站满就买人（按分数：合成进度 > 主 / 副盟约成员 > 角色缺口（挡怪、第 5 回合起要治疗）> 真实战力和阶）。
//   3. 先合成再升级：手上有两个、商店出了第三张，买得起就买；买不起就冻结商店留到下回合。
//   4. 升级照曲线：免费的立刻升；之后按回合目标（第 3 回合 2 级、第 5 回合 3 级、第 7 回合 4 级、第 9 回合 5 级、第 11 回合 6 级，
//      复刻版 legacy：R4 2 级 / R7 4 级 / R10 5 级 / R13 6 级，§35.63 起 R9 5 级、R11 6 级），并且升完还留得出补满场的钱。
//   5. 剩下的钱：场上满了，只买推进合成 / 主盟约成员 / 能替换场上最弱的；否则刷新（每回合最多刷 3 次），刷新后重新规划。
//   6. 木板别堵：不进阵容、也不在凑东西的（不成对、不是主副盟约、阶比当前等级低 2 以上）卖掉，木板上的人最多留 4 个。
//   7. 上场：木板上的人有空位就上（近战前排、远程后排，由 turn.js 自动找格子）；装备给场上的人。
// 模型（可选）只做「顾问」：每局开打前定路线（route.js），这里照路线走。

import { loadPool, loadEquipment, MONEY_ITEMS, CORE } from './sim.js';
import fs from 'node:fs';
import path from 'node:path';

const KB = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'knowledge');
let POOL = null; let EQUIP = null; let STATS = null;
const pool = () => (POOL ||= new Map(loadPool().map((p) => [p.name, p])));
const isEquip = (n) => (EQUIP ||= new Set(loadEquipment().map((e) => e.name))).has(n);
const stats = (n) => { if (!STATS) { try { STATS = JSON.parse(fs.readFileSync(path.join(KB, '06-干员数据.json'), 'utf8')); } catch { STATS = {}; } } return STATS[n] || null; };
const tagsOf = (n) => pool().get(n)?.tags || [];
const tierOf = (n) => pool().get(n)?.tier || 0;
const clsOf = (n) => pool().get(n)?.cls || stats(n)?.cls || '';
const isBlocker = (n) => (stats(n)?.block ?? 0) >= 2;
const isHealer = (n) => /医疗/.test(clsOf(n));
const isRangedDps = (n) => /狙击|术师/.test(clsOf(n));
const STAY = /夏栎|星源|复奏|淬羽赫默|焰尾/;
export function powerOf(n) {
  const d = stats(n); const t = tierOf(n) || 1;
  const base = d?.atk && d?.hp ? Math.sqrt((d.atk / (d.interval || 1)) * d.hp * (1 + (d.def || 0) / 600)) / 900 : t ** 1.6;
  return base * (1 + 0.35 * (t - 1));
}

// 第几回合该到几级（复刻版 legacy 的升级曲线，§35.63 起第 9 回合 5 级、第 11 回合 6 级）
// 可调参数（本地假游戏 sim.mjs --tune 网格搜索用；环境变量 ARK_KNOBS='{"benchKeep":4}' 覆盖，不设就是默认）
//   benchBuyCap 木板上（不算场上）买「有用的」最多囤到几个；benchKeep 卖闲人时木板至少留几个；maxRefresh 每回合最多刷新几次；levelShift 升级节奏整体推迟几回合；roleWeight 阵容缺一个前排 / 奶妈加多少分（远程减半）
export const KNOBS = { benchBuyCap: 7, benchKeep: 4, maxRefresh: 3, levelShift: 0, roleWeight: 12, ...(() => { try { return JSON.parse(globalThis.process?.env?.ARK_KNOBS || '{}'); } catch { return {}; } })() };
export const LEVEL_BY_ROUND = [[11, 6], [9, 5], [7, 4], [5, 3], [3, 2]];
export const targetLevel = (round) => (LEVEL_BY_ROUND.find(([r]) => round >= r + KNOBS.levelShift) || [0, 1])[1];

/** 从路线文字里找主盟约 / 副盟约（出现的盟约名，按出现顺序；核心盟约排前）。 */
export function routeBonds(extra = '') {
  const all = [...CORE, '精准', '灵巧', '迅捷', '坚守', '奥术', '不屈', '聚合', '助力', '突袭', '独行', '远见'];
  const found = all.filter((a) => extra.includes(a)).sort((a, b) => extra.indexOf(a) - extra.indexOf(b));
  const core = found.find((a) => CORE.includes(a)) || null;
  return { core, subs: found.filter((a) => a !== core).slice(0, 2) };
}

/**
 * 算这一回合的操作清单。
 * s: { st（readRest 的结果）, bench:[{name}], board:[{name}], round, extra（路线文字）, memo, notes, mem（跨回合记忆：{ level, focus, refreshes }）}
 * 返回和模型一样的 plan：{ think, memo, say, ops:[{op, slot, unit, tile, dir, to}] }。
 */
export function planRound({ st, bench, board, round, extra = '', mem = {} }) {
  const R = round || st.round || 1;
  const level = mem.level || 1;
  const ops = [];
  const op = (o) => ops.push({ slot: -1, unit: '', tile: -1, dir: 'right', to: '', ...o });
  // 资金读不出（OCR 偶尔整个漏掉）：按本回合收入估（3 + 回合，最多 12）。买不起游戏会拒绝、程序会核对，猜多了只是白点一下；
  // 当成 0 的话一张都不买，每回合十几块全被清空（2026-11-11 第 8～11 回合就是这样）
  let funds = st.funds ?? Math.min(3 + (R || 1), 12);
  const units = [...bench.filter((b) => b.name && !isEquip(b.name)), ...board.filter((b) => b.name)];
  const owned = new Map();
  for (const u of units) owned.set(u.name, (owned.get(u.name) || 0) + 1);

  // 1. 主盟约 / 副盟约
  const route = routeBonds(extra);
  const countIn = (tag) => new Set(units.filter((u) => tagsOf(u.name).includes(tag)).map((u) => u.name)).size;
  let focus = mem.focus || route.core;
  if (!focus) focus = CORE.map((c) => [c, countIn(c)]).sort((a, b) => b[1] - a[1])[0]?.[1] > 0 ? CORE.map((c) => [c, countIn(c)]).sort((a, b) => b[1] - a[1])[0][0] : null;
  const second = route.subs[0] || [...new Set(units.flatMap((u) => tagsOf(u.name)))].filter((t) => t !== focus).map((t) => [t, countIn(t)]).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  mem.focus = focus;

  const deployed = board.filter((b) => b.name).length;
  const remain = st.remain ?? Math.max(0, 8 - deployed);
  const benchUnits = bench.filter((b) => b.name && !isEquip(b.name));
  const blockers = units.filter((u) => isBlocker(u.name)).length;
  const healers = units.filter((u) => isHealer(u.name)).length;
  const ranged = units.filter((u) => isRangedDps(u.name)).length;
  // 阵容缺口（近战挡、远程打、奶妈奶）：前排 2 个，第 7 回合起 3 个；医疗第 4 回合起 1 个、第 9 回合起 2 个；远程输出至少 2 个
  const needBlock = Math.max(0, (R >= 7 ? 3 : 2) - blockers);
  const needHeal = Math.max(0, (R >= 9 ? 2 : R >= 4 ? 1 : 0) - healers);
  const needRanged = Math.max(0, 2 - ranged);
  const weakest = board.filter((b) => b.name).map((b) => powerOf(b.name)).sort((a, b) => a - b)[0] ?? 0;

  // 2. 给商店里每张干员卡打分（复刻版的购买优先级：合成进度 > 盟约门槛 > 角色缺口 > 阶和战力）
  const score = (c) => {
    const have = owned.get(c.name) || 0;
    const tags = c.tags.length ? c.tags : tagsOf(c.name);
    let s = 0;
    if (have >= 2) s += 30;                       // 买了就三合一
    else if (have === 1) s += 8;                  // 凑对子
    if (focus && tags.includes(focus)) s += 10;
    if (second && tags.includes(second)) s += 5;
    if (needBlock && isBlocker(c.name)) s += KNOBS.roleWeight * needBlock;
    if (needHeal && isHealer(c.name)) s += KNOBS.roleWeight * needHeal;
    if (needRanged && isRangedDps(c.name)) s += (KNOBS.roleWeight / 2) * needRanged;
    s += powerOf(c.name) * 2 + (tierOf(c.name) || 1);
    return s;
  };
  const cards = st.shop.filter((c) => !c.empty && c.name && c.cost != null && c.tags.length).map((c) => ({ ...c, score: score(c) })).sort((a, b) => b.score - a.score);
  const bought = new Set();
  const buy = (c, why) => { (mem.recent ||= {})[c.name] = R; op({ op: 'buy', slot: c.slot }); funds -= c.cost; bought.add(c.slot); owned.set(c.name, (owned.get(c.name) || 0) + 1); notes.push(`${why}：${c.name}`); };
  const notes = [];
  const cheapest = Math.min(...cards.map((c) => c.cost), 99);

  // 3. 先合成（买得起就买；买不起记下来冻结商店）
  let freezeFor = null;
  for (const c of cards) {
    if ((owned.get(c.name) || 0) >= 2) {
      if (c.cost <= funds) buy(c, '三合一');
      else freezeFor = c;
    }
  }
  // 4. 补满场：木板上的人不够填空位，就买人
  let need = Math.max(0, remain - benchUnits.filter((b) => !STAY.test(b.name)).length);
  for (const c of cards) {
    if (need <= 0) break;
    if (bought.has(c.slot) || c.cost > funds) continue;
    buy(c, '补满场'); need--;
  }
  // 5. 升级照曲线（免费的立刻升；到了该升的回合、升完还留得出补位的钱才升）
  const up = st.upgradeCost;
  // 升级费读不出、但等级落后于节奏：照样点一下（买不起游戏会拒绝，upgrade 会核对「确认升级」有没有出现）
  if (up == null && level < 6 && level < targetLevel(R)) { op({ op: 'upgrade' }); notes.push(`升级（费用没读出来，等级落后于第 ${R} 回合该有的 ${targetLevel(R)} 级）`); }
  if (up != null && level < 6) {
    const reserve = need > 0 ? cheapest : 0;
    if (up === 0 || (level < targetLevel(R) && funds - up >= reserve)) {
      op({ op: 'upgrade' }); funds -= up; mem.level = level + 1; notes.push(`升级到 ${level + 1} 级`);
    }
  }
  // 拼命模式：血 ≤12，或上回合一下掉了 8 血以上 → 只要比场上最弱的强一成就买、刷新次数翻倍（autoSwap 也放宽到强一成就换）
  const lowHp = st.hp != null && (st.hp <= 12 || (mem.lastHp != null && mem.lastHp - st.hp >= 8));
  if (mem.round !== R) mem.lastHp = mem.hpNow ?? mem.lastHp;
  mem.hpNow = st.hp ?? mem.hpNow;
  mem.lowHp = lowHp;
  if (lowHp) notes.push(`血量告急（${st.hp}），拼命换战力`);
  // 6. 剩下的钱：只买推进合成 / 主副盟约成员 / 能替换场上最弱的
  for (const c of cards) {
    if (bought.has(c.slot) || c.cost > funds) continue;
    const have = owned.get(c.name) || 0;
    const tags = c.tags.length ? c.tags : tagsOf(c.name);
    const useful = have >= 1 || (focus && tags.includes(focus)) || (second && tags.includes(second) && tierOf(c.name) >= level - 1) || powerOf(c.name) > weakest * (lowHp ? 1.1 : 1.25);
    if (useful && benchUnits.length + [...bought].length < KNOBS.benchBuyCap + (lowHp ? 2 : 0)) buy(c, '有用');
  }
  // 7. 木板别堵：卖掉不进阵容也不在凑东西的（每回合最多 3 个），木板上最多留 4 个人
  // 这回合和上回合刚买的不卖（以前「有用就买、没用就卖」两条规则打架：买 3 块卖 1 块，白亏）
  const fresh = (n) => mem.recent?.[n] != null && R - mem.recent[n] <= 1;
  const keep = (b) => fresh(b.name) || (owned.get(b.name) || 0) >= 2 || STAY.test(b.name) || (focus && tagsOf(b.name).includes(focus)) || (second && tagsOf(b.name).includes(second)) || tierOf(b.name) >= level;
  // 名字不在干员表里的（渡桥的「樱桃三号」这类召唤物）不卖：卖了等于把那个干员的技能拆了
  const spare = benchUnits.filter((b) => !keep(b) && tierOf(b.name) > 0).sort((a, b) => powerOf(a.name) - powerOf(b.name));
  const over = benchUnits.length + bought.size - Math.max(KNOBS.benchKeep, remain);
  for (const b of spare.slice(0, Math.min(3, Math.max(0, over)))) { op({ op: 'sell', unit: b.name }); funds += 1; notes.push(`卖掉没用的 ${b.name}`); }
  // 8. 上场：木板上的（和刚买的）人有空位就上，tile=-1 让程序按近战前排 / 远程后排找格子
  let slots = remain;
  const toDeploy = [...benchUnits.filter((b) => !STAY.test(b.name) && !ops.some((o) => o.op === 'sell' && o.unit === b.name)).map((b) => b.name),
    ...cards.filter((c) => bought.has(c.slot) && !STAY.test(c.name)).map((c) => c.name)]
    .sort((a, b) => powerOf(b) - powerOf(a));
  for (const n of toDeploy) { if (slots <= 0) break; op({ op: 'deploy', unit: n, tile: -1, dir: 'right' }); slots--; }
  // 9. 装备：木板上的装备戴给场上的人（换钱类 turn.js 会自动用掉）
  for (const b of bench.filter((x) => x.name && isEquip(x.name) && !MONEY_ITEMS.test(x.name))) op({ op: 'equip', unit: b.name, to: '' });
  // 10. 钱还剩：第三张差钱 → 冻结；否则刷新（每回合最多 3 次，刷完程序会再规划一次）
  mem.refreshes = mem.round === R ? mem.refreshes || 0 : 0; mem.round = R;
  if (freezeFor && funds < freezeFor.cost) { op({ op: 'freeze' }); notes.push(`冻结商店，留着下回合买第三张 ${freezeFor.name}`); }
  else if (funds >= (st.refreshCost ?? 1) && mem.refreshes < KNOBS.maxRefresh * (lowHp ? 2 : 1)) { op({ op: 'refresh' }); mem.refreshes++; notes.push('有余钱，刷新找牌'); }
  op({ op: 'ready' });

  const think = `主 ${focus || '未定'}${second ? `、副 ${second}` : ''}；${notes.join('，') || '没什么可做的'}`;
  return { think: think.slice(0, 120), memo: `主盟约 ${focus || '未定'}，副 ${second || '无'}，${mem.level || level} 级`, say: '', ops };
}
