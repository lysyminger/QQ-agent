// plugins/ark-garrison/sim.js
//
// 本地「假游戏」：按 knowledge/ 里的规则模拟卫戍协议的休整期经济，给 turn.js 当 io 用，整局整局地跑。
// 用途：① 不开模拟器就能把回合流程跑通、抓 bug（卡死、问太多次、买了没放上场……）；
//       ② 比较打法（升级节奏、补满场、三合一）在粗略战力模型下谁撑得久。
// 作战结果没法真算：用粗略战力模型（人数、阶级、精锐、激活盟约）对比逐回合变强的敌人，漏怪扣血。结论最后要回真机验证。
//
// 规则来源（knowledge/00、01，实测补充）：
//   · 每回合发钱，回合结束清零；第 r 回合发 r+3（实测第 3 回合 +6、第 5 回合 +8），上限 12。
//   · 商店格数：调度中心 1 级 4 格，2 级 5 格，3 级起 6 格（实测）；卡价 = 阶 + 1（Ⅰ阶 2、Ⅱ阶 3，实测）。
//   · 升级费用每回合 -1，最低 0；升级后重置成下一级的基础价。刷新 1 块。出售 +1。
//   · 3 个同名同阶合成 1 个精锐，并免费三选一一张高一阶的。
//   · 上场上限 8；整备区（木板）10 格。漏怪每回合最多扣 10，生命 0 就输；打满 14 回合（最后是领袖轮）就通关。

import fs from 'node:fs';
import path from 'node:path';

const KB = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'knowledge');
const ROMAN = { 'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6 };
export const CORE = ['乌萨斯', '莱塔尼亚', '阿戈尔', '伊比利亚', '叙拉古', '维多利亚', '卡西米尔', '炎', '萨尔贡', '谢拉格'];

/** 从 03-干员特质表 读卡池：{ name, cls, tier, tags, text }。 */
export function loadPool(file = path.join(KB, '03-干员特质表.md')) {
  const pool = [];
  let tier = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const h = line.match(/^## ([ⅠⅡⅢⅣⅤⅥ])阶/);
    if (h) { tier = ROMAN[h[1]]; continue; }
    const m = line.match(/^- ([^(（]+)\(([^)]+)\)｜([^｜]+)｜(.*)$/);
    if (m && tier) pool.push({ name: m[1].trim(), cls: m[2], tier, tags: m[3].trim().split(/\s+/), text: m[4] });
  }
  return pool;
}

/**
 * 从 02-盟约-策略-装备 读装备表：{ name, tier, cost, money（装上就销毁换钱 / 资源的）, text }。
 * Ⅰ阶都是 1 资金；其余写在名字后的括号里。
 */
export const MONEY_ITEMS = /盟约之币|见钱眼开玩偶|精打细算玩偶|驮兽储蓄罐|定期存折/;
export function loadEquipment(file = path.join(KB, '02-盟约-策略-装备.md')) {
  const out = [];
  let on = false; let tier = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^## 装备/.test(line)) { on = true; continue; }
    if (on && /^## /.test(line)) break;
    if (!on) continue;
    const h = line.match(/^\*\*([ⅠⅡⅢⅣⅤⅥ])阶/);
    if (h) { tier = ROMAN[h[1]]; continue; }
    const m = line.match(/^- ([^（(：:]+)(?:[（(](\d+)[）)])?[：:](.*)$/);
    if (m && tier) out.push({ name: m[1].trim(), tier, cost: m[2] ? Number(m[2]) : 1, money: MONEY_ITEMS.test(m[1]), text: m[3].trim() });
  }
  return out;
}

/** 可复现的随机数（同一个种子同一局）。 */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
}

// 游戏数据清洗出来的干员属性（scripts/ark-build-data.mjs 生成）；没有就按阶粗估
let STATS = null;
try { STATS = JSON.parse(fs.readFileSync(path.join(KB, '06-干员数据.json'), 'utf8')); } catch { /* 没生成过 */ }

// 经济参数（复刻版 sganggs/Stronghold-Protocol data/config.json，照官方数据核对过；第二期数值，第三期实测吻合的部分）
const PRICE = [0, 2, 3, 3, 3, 4, 4];               // 各阶干员价
const UPGRADE = { 1: 5, 2: 8, 3: 11, 4: 12, 5: 13 }; // 从 L 级升到 L+1 级的基础价
const COPIES = [0, 12, 14, 18, 16, 8, 5];           // 各阶每个干员的卡池份数（单人）

const SLOT_X = (n) => Array.from({ length: n }, (_, j) => 1014 - 162 * (n - 1 - j));
const BENCH_X = (k) => 915 - 81 * k;
// 16 个棋盘格（按住时视角的坐标随便定，只要稳定）
const TILES = Array.from({ length: 16 }, (_, i) => ({ x: 480 + (i % 6) * 80, y: 230 + Math.floor(i / 6) * 70 }));

export class FakeGame {
  constructor({ seed = 1, pool = loadPool(), hp = 25, mode = 1, rounds = mode >= 5 ? 15 : 14, level = 1, enemyBase = 4, enemyGrowth = 1.27 } = {}) {
    this.bossRounds = mode >= 5 ? [rounds - 1, rounds] : [rounds];
    this.enemyBase = enemyBase; this.enemyGrowth = enemyGrowth;
    this.r = rng(seed);
    this.pool = pool;
    this.items = loadEquipment();
    this.round = 1; this.rounds = rounds; this.hp = hp;
    // 升级费用：升到 2～6 级分别 5/8/11/12/13（复刻版 data/config.json；这一期实测第 2 回合 1→2 级要 4 块，倒推第 1 回合 5 块，吻合），每回合 -1
    this.level = level; this.upBase = (l) => UPGRADE[l] ?? 99; this.upgradeCost = this.upBase(level);
    // 卡池份数（单人）：Ⅰ～Ⅵ阶每个干员 12/14/18/16/8/5 份（复刻版 poolCopies）
    this.copies = new Map(pool.map((p) => [p.name, COPIES[p.tier] || 8]));
    this.funds = this.income(); this.cap = 8;
    this.bench = Array(10).fill(null);      // 木板 10 格：{ name, tier, tags, elite }
    this.board = [];                         // 场上：{ name, tier, tags, elite, tile }
    this.shop = []; this.roll();
    this.log = [];
    this.over = false; this.won = false;
    this.freePick = null;                    // 三合一送的三选一（自动拿最搭的）
  }
  income() { return Math.min(12, this.round + 3); }
  // 商店：干员格 1 级 3 张、2～5 级 4 张、6 级 5 张，最后再加 1 格装备（复刻版 data/config.json 单人标准，和这一期实测 4/5/6 格一致）
  chessSlots() { return this.level <= 1 ? 3 : this.level <= 5 ? 4 : 5; }
  shopSize() { return this.chessSlots() + 1; }
  /** 干员卡：从剩余份数里按份数抽（阶 ≤ 调度中心等级），买走的越来越难刷到（复刻版 shopOdds: copyWeighted）。 */
  rollChess() {
    let total = 0;
    for (const p of this.pool) if (p.tier <= this.level) total += this.copies.get(p.name) || 0;
    let x = this.r() * total;
    for (const p of this.pool) {
      if (p.tier > this.level) continue;
      x -= this.copies.get(p.name) || 0;
      if (x <= 0) return { ...p, cost: PRICE[p.tier] };
    }
    const p = this.pool.find((q) => q.tier === 1);
    return { ...p, cost: PRICE[p.tier] };
  }
  rollItem() {
    const cand = this.items.filter((e) => e.tier <= this.level && !/合成品/.test(e.name));
    const e = cand[Math.floor(this.r() * cand.length)];
    return e ? { name: e.name, tier: e.tier, tags: [], cost: e.cost, equip: true, money: e.money } : null;
  }
  rollCard() { return this.r() < 0.2 ? this.rollItem() || this.rollChess() : this.rollChess(); }
  roll() {
    // 没买走的卡放回池子，再抽新的
    for (const c of this.shop) if (c && !c.equip) this.copies.set(c.name, (this.copies.get(c.name) || 0) + 1);
    this.shop = [...Array.from({ length: this.chessSlots() }, () => this.takeCopy(this.rollChess())), this.rollItem()];
  }
  takeCopy(c) { this.copies.set(c.name, Math.max(0, (this.copies.get(c.name) || 0) - 1)); return c; }
  remain() { return this.cap - this.board.length; }
  alliances() {
    const by = new Map();
    for (const u of this.board) for (const t of u.tags) { if (!by.has(t)) by.set(t, new Set()); by.get(t).add(u.name); }
    return [...by].filter(([t, s]) => s.size >= (CORE.includes(t) ? 3 : 2)).map(([t, s]) => ({ tag: t, n: s.size, core: CORE.includes(t) }));
  }
  /** 粗略战力：每人 阶^1.6（精锐 ×2.3），激活盟约加成（核心 3 人 +15%、6 人 +45%；附加 2 人 +8%、3 人 +15%）。 */
  /**
   * 战力：有游戏数据（06-干员数据.json）时按真实属性算每个人「输出 × 能扛」开方——输出 = 攻击 ÷ 攻击间隔，能扛 = 生命 × (1 + 防御/600)；
   * 没数据退回按阶粗估。精锐 ×2.3、每件装备 +12%。阵容：没有能挡怪的（阻挡 ≥2）大打折扣，前后排齐了 +10%。盟约加成同前。
   */
  unitPower(u) {
    const d = STATS?.[u.name];
    const base = d && d.atk && d.hp ? Math.sqrt((d.atk / (d.interval || 1)) * d.hp * (1 + (d.def || 0) / 600)) / 900 : u.tier ** 1.6;
    return base * (1 + 0.35 * (u.tier - 1)) * (u.elite ? 2.3 : 1) * (1 + 0.12 * (u.equips?.length || 0));
  }
  power() {
    const base = this.board.reduce((s, u) => s + this.unitPower(u), 0);
    const bonus = this.alliances().reduce((s, a) => s + (a.core ? (a.n >= 6 ? 0.45 : 0.15) : (a.n >= 3 ? 0.15 : 0.08)), 0);
    const blockers = this.board.filter((u) => (STATS?.[u.name]?.block ?? (u.tier ? 2 : 0)) >= 2).length;
    const ranged = this.board.filter((u) => (STATS?.[u.name]?.block ?? 2) <= 1).length;
    const comp = !this.board.length ? 0 : blockers === 0 ? 0.6 : blockers >= 2 && ranged >= 2 ? 1.1 : 1;
    return base * (1 + bonus) * comp;
  }
  // 敌人逐回合变强；Boss 回合（规程 1～4 级最后 1 回合、5 级起最后 2 回合，见 05-模式与回合）再强一截
  enemy() { const e = this.enemyBase * this.enemyGrowth ** (this.round - 1); return this.bossRounds.includes(this.round) ? e * 1.6 : e; }
  // 三合一：同名同阶非精锐凑满 3 个 → 1 个精锐留在原位，送一张高一阶（自动拿和现有盟约最搭的）
  merge() {
    const all = [...this.bench.filter(Boolean).map((u) => ({ u, where: 'bench' })), ...this.board.map((u) => ({ u, where: 'board' }))];
    const groups = new Map();
    for (const e of all) if (!e.u.elite && !e.u.equip) { const k = `${e.u.name}|${e.u.tier}`; (groups.get(k) || groups.set(k, []).get(k)).push(e); }
    for (const [, g] of groups) {
      if (g.length < 3) continue;
      const keep = g.find((e) => e.where === 'board') || g[0];
      keep.u.elite = true;
      for (const e of g.filter((x) => x !== keep).slice(0, 2)) {
        if (e.where === 'bench') this.bench[this.bench.indexOf(e.u)] = null;
        else this.board.splice(this.board.indexOf(e.u), 1);
      }
      const t = Math.min(6, keep.u.tier + 1);
      const opts = this.pool.filter((p) => p.tier === t);
      const tagsNow = new Set(this.board.flatMap((u) => u.tags));
      const pick = [...opts].sort((a, b) => b.tags.filter((x) => tagsNow.has(x)).length - a.tags.filter((x) => tagsNow.has(x)).length)[0];
      const k = this.bench.indexOf(null);
      if (pick && k >= 0) this.bench[k] = { ...pick, elite: false };
      this.log.push(`三合一：${keep.u.name} 精锐，送 ${pick?.name || '（木板满了没拿到）'}`);
      return true;
    }
    return false;
  }
  // ── 操作（和 io 一一对应）──
  buy(slot) {
    const c = this.shop[slot - 1];
    if (!c) return { ok: false, why: `${slot} 号卡位是空的` };
    if (c.cost > this.funds) return { ok: false, why: `${c.name} 要 ${c.cost}，只有 ${this.funds}` };
    const k = this.bench.indexOf(null);
    if (k < 0) return { ok: false, why: '木板满了' };
    this.funds -= c.cost;
    this.bench[k] = c.equip ? { name: c.name, tier: c.tier, tags: [], equip: true, money: c.money } : { name: c.name, tier: c.tier, tags: c.tags, elite: false };
    this.shop[slot - 1] = null;
    while (this.merge());
    return { ok: true, name: c.name, cost: c.cost, funds: this.funds };
  }
  // 卖掉的放回卡池（精锐算 3 份），卖价一律 1 块
  giveBack(u) { if (u && !u.equip) this.copies.set(u.name, (this.copies.get(u.name) || 0) + (u.elite ? 3 : 1)); }
  sellBench(k) { if (!this.bench[k]) return { ok: false, why: '那里没人' }; this.giveBack(this.bench[k]); this.bench[k] = null; this.funds += 1; return { ok: true, funds: this.funds }; }
  sellBoardAt(i) { if (!this.board[i]) return { ok: false, why: '那里没人' }; this.giveBack(this.board[i]); this.board.splice(i, 1); this.funds += 1; return { ok: true, funds: this.funds }; }
  withdrawAt(i) { const u = this.board[i]; const k = this.bench.indexOf(null); if (!u || k < 0) return { ok: false, why: '撤不回来' }; this.board.splice(i, 1); this.bench[k] = u; return { ok: true, remain: this.remain() }; }
  deploy(k, tile) {
    const u = this.bench[k];
    if (!u) return { ok: false, why: '木板那里没人' };
    if (u.equip) return { ok: false, why: '剩余可放置没减（装备不能上场）' };
    if (this.remain() <= 0) return { ok: false, why: '剩余可放置没减（0→0）' };
    if (this.board.some((b) => b.tile === tile)) return { ok: false, why: '格子有人了' };
    this.bench[k] = null; this.board.push({ ...u, tile });
    while (this.merge());
    return { ok: true, remain: this.remain() };
  }
  /** 把木板第 k 格的装备戴到场上第 i 个人身上：换钱类直接给钱，人事部文档上场上限 +1，其余每人最多 2 件。 */
  equipAt(k, i) {
    const e = this.bench[k]; const u = this.board[i];
    if (!e?.equip) return { ok: false, why: '那里不是装备' };
    if (!u) return { ok: false, why: '场上没这个人' };
    if (e.money) { this.funds += /精打细算|定期/.test(e.name) ? 1 : /储蓄罐/.test(e.name) ? 3 : 2; }
    else if (/人事部文档/.test(e.name)) this.cap = 9;
    else { u.equips ||= []; if (u.equips.length >= 2) return { ok: false, why: '这个人已经戴满 2 件' }; u.equips.push(e.name); }
    this.bench[k] = null;
    return { ok: true, funds: this.funds };
  }
  freeze() { this.frozen = true; return { ok: true }; }
  refresh() { if (this.funds < 1) return { ok: false, why: '没钱刷新' }; this.funds -= 1; this.roll(); return { ok: true, funds: this.funds }; }
  upgrade() {
    if (this.level >= 6) return { ok: false, why: '满级了' };
    if (this.upgradeCost > this.funds) return { ok: false, why: `升级要 ${this.upgradeCost}，只有 ${this.funds}` };
    this.funds -= this.upgradeCost; this.level++; this.upgradeCost = this.upBase(this.level);
    return { ok: true, funds: this.funds };
  }
  ready() {
    const p = this.power(); const e = this.enemy();
    const leak = p >= e ? 0 : Math.min(10, Math.ceil(((e - p) / e) * 12));
    this.hp -= leak;
    this.log.push(`回合 ${this.round}：战力 ${p.toFixed(1)} 对敌 ${e.toFixed(1)}，场上 ${this.board.length} 人，等级 ${this.level}，漏 ${leak}，剩 ${this.hp}`);
    if (this.hp <= 0) { this.over = true; return { ok: true, screen: 'battle' }; }
    if (this.round >= this.rounds) { this.over = true; this.won = true; return { ok: true, screen: 'battle' }; }
    // 冻结了：没买的卡留到这回合（买走的空位不补）；没冻结就重新抽
    this.round++; this.funds = this.income(); this.upgradeCost = Math.max(0, this.upgradeCost - 1);
    if (this.frozen) this.frozen = false; else this.roll();
    this.readied = true;
    return { ok: true, screen: 'battle' };
  }
}

/** 把假游戏包成 turn.js 要的 io。坐标和真机一致（木板 915-81k，卡位右对齐），所以 turn.js 的「按位置认人」也一起测到。 */
export function makeFakeIo(g) {
  const benchIndex = (x) => [...Array(10).keys()].find((k) => Math.abs(BENCH_X(k) - x) < 25);
  const boardIndex = (at) => g.board.findIndex((u) => Math.hypot(TILES[u.tile].x - at.x, TILES[u.tile].y - at.y) < 30);
  const look = () => ({ file: '', items: [], text: '', image: null });
  return {
    open: async () => (g.over || g.readied ? { ok: false, why: '不在休整期（battle）' } : { ok: true, look: look() }),
    read: async () => ({
      round: g.round, hp: g.hp, funds: g.funds, remain: g.remain(), refreshCost: 1, upgradeCost: g.upgradeCost,
      shop: g.shop.map((c, i) => (c ? { slot: i + 1, x: SLOT_X(g.shop.length)[i], name: c.name, cost: c.cost, tags: c.tags, empty: false } : { slot: i + 1, name: '', cost: null, tags: [], empty: true })),
      alliances: g.alliances().map((a) => a.tag), upgradeX: 200
    }),
    scan: async () => ({
      bench: g.bench.map((u, k) => (u ? BENCH_X(k) : null)).filter((x) => x != null),
      board: g.board.map((u) => ({ x: TILES[u.tile].x, y: TILES[u.tile].y }))
    }),
    look: async () => look(),
    pickUp: async (x) => {
      const k = benchIndex(x);
      if (k == null || !g.bench[k]) return { ok: false, why: '拿不起人' };
      return { ok: true, tiles: TILES.filter((_, i) => !g.board.some((u) => u.tile === i)), file: `bench:${k}`, from: [0, 0] };
    },
    cancel: async () => {},
    nameOf: async (file) => g.bench[Number(String(file).split(':')[1])]?.name || '',
    nameAt: async (x, y) => g.board[boardIndex({ x, y })]?.name || '',
    tilesImage: async () => '',
    buy: async (slot) => g.buy(slot),
    sell: async (x) => g.sellBench(benchIndex(x)),
    sellBoard: async (at) => g.sellBoardAt(boardIndex(at)),
    withdraw: async (at) => g.withdrawAt(boardIndex(at)),
    deploy: async (x, target, dir) => {
      const k = benchIndex(x);
      const free = TILES.map((t, i) => ({ ...t, i })).filter((t) => !g.board.some((u) => u.tile === t.i));
      const t = typeof target === 'string' && target.startsWith('auto') ? (target === 'auto-back' ? free.sort((a, b) => b.x - a.x)[Math.min(free.length - 1, Math.floor(free.length * 0.75))] : free.sort((a, b) => b.x - a.x)[0]) : free.find((f) => Math.hypot(f.x - target?.x, f.y - target?.y) < 45);
      if (!t) return { ok: false, why: '目标格子和附近都不能放（没亮）' };
      const r = g.deploy(k, t.i);
      return r.ok ? { ...r, at: { x: t.x, y: t.y } } : r;
    },
    equip: async (x, at) => g.equipAt(benchIndex(x), boardIndex(at)),
    refresh: async () => g.refresh(),
    freeze: async () => g.freeze(),
    upgrade: async () => g.upgrade(),
    ready: async () => g.ready()
  };
}

/**
 * 规则脑（不花额度）：给 turn.js 当 ask 用，读 prompt 里的局面文字做决定。也用来和 LLM 对比。
 * 打法参数 opts 可调，用来比较：upgradeAt（费用 ≤ 几就升）、refresh（有余钱就刷）、focus（优先买这些盟约）。
 */
export function makeRuleBrain(g, { upgradeAt = 2, refresh = true, focus = [] } = {}) {
  return async () => {
    const ops = [];
    let funds = g.funds;
    const owned = new Map();
    for (const u of [...g.bench.filter(Boolean), ...g.board]) owned.set(u.name, (owned.get(u.name) || 0) + 1);
    if (g.upgradeCost <= upgradeAt && g.upgradeCost <= funds && g.level < 6) { ops.push({ op: 'upgrade' }); funds -= g.upgradeCost; }
    const tagsNow = new Set([...g.board, ...g.bench.filter(Boolean)].flatMap((u) => u.tags));
    // 先买人，装备排在后面（换钱类除外）
    const score = (c) => (c.equip ? (c.money ? 6 : -5) : 0) + (owned.get(c.name) || 0) * 5 + c.tier * 2 + c.tags.filter((t) => focus.includes(t)).length * 4 + c.tags.filter((t) => tagsNow.has(t)).length;
    const cards = g.shop.map((c, i) => (c ? { ...c, slot: i + 1 } : null)).filter(Boolean).sort((a, b) => score(b) - score(a));
    let room = g.bench.filter((x) => !x).length;
    for (const c of cards) { if (c.cost <= funds && room > 0) { ops.push({ op: 'buy', slot: c.slot }); funds -= c.cost; room--; } }
    // 木板上的（非换钱）装备戴给场上的人
    for (const e of g.bench.filter((u) => u?.equip && !u.money)) if (g.board.length) ops.push({ op: 'equip', unit: e.name, to: '' });
    if (refresh && funds >= 1 && !ops.some((o) => o.op === 'buy')) ops.push({ op: 'refresh' });
    else ops.push({ op: 'ready' });
    return { ok: true, seconds: 0, json: { think: '', memo: '', say: '', ops: ops.map((o) => ({ slot: -1, unit: '', tile: -1, dir: 'none', to: '', ...o })) } };
  };
}
