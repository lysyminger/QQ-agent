// scripts/ark-build-data.mjs —— 把公开游戏数据（ArknightsGameData，zh_CN/gamedata/excel）清洗成卫戍陪玩能直接用的资料。
//
//   node scripts/ark-build-data.mjs <放 character_table / skill_table / range_table / activity_table 的目录>
//
// 产出（plugins/ark-garrison/knowledge/）：
//   05-模式与回合.md        每种模式（规程等级 1～20、联机标准 / 绝境 / 终极、极速）几回合、每回合休整多久、哪几回合是 Boss
//   06-干员范围与技能.md     卡池里每个干员：职业分支、阻挡、攻击范围（小格子图）、技能和效果；技能自动释放的条件
//   06-干员数据.json         同样的数据给代码用（站位、模拟器）
// 只读数据、不执行下载来的任何东西。卡池名单取自 03-干员特质表（PRTS 整理的规程卡池）。

import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) { console.log('用法：node scripts/ark-build-data.mjs <数据目录>'); process.exit(1); }
const KB = path.resolve('plugins/ark-garrison/knowledge');
const load = (f) => JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
const chars = load('character_table.json');
const skills = load('skill_table.json');
const ranges = load('range_table.json');
const ac = load('activity_table.json').autoChessData;

const PROF = { WARRIOR: '近卫', TANK: '重装', PIONEER: '先锋', SNIPER: '狙击', CASTER: '术师', MEDIC: '医疗', SUPPORT: '辅助', SPECIAL: '特种', TOKEN: '召唤物', TRAP: '装置' };
const strip = (s) => String(s || '').replace(/<[@$][^>]*>|<\/>/g, '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();

// ── 卡池名单（03-干员特质表）──
const ROMAN = { 'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6 };
const pool = [];
{
  let tier = 0;
  for (const line of fs.readFileSync(path.join(KB, '03-干员特质表.md'), 'utf8').split('\n')) {
    const h = line.match(/^## ([ⅠⅡⅢⅣⅤⅥ])阶/);
    if (h) { tier = ROMAN[h[1]]; continue; }
    const m = line.match(/^- ([^(（]+)\(([^)]+)\)｜([^｜]+)｜/);
    if (m && tier) pool.push({ name: m[1].trim(), cls: m[2], tier, tags: m[3].trim().split(/\s+/) });
  }
}

// ── 攻击范围：画成小格子图（自己 = ●，打得到 = ■，朝右看）──
function drawRange(id) {
  const r = ranges[id];
  if (!r?.grids?.length) return { id, text: '（无 / 只打自己）', cells: [] };
  const cells = r.grids.map((g) => [g.row, g.col]);
  const rows = cells.map((c) => c[0]); const cols = cells.map((c) => c[1]);
  const r0 = Math.min(0, ...rows); const r1 = Math.max(0, ...rows);
  const c0 = Math.min(0, ...cols); const c1 = Math.max(0, ...cols);
  const set = new Set(cells.map((c) => c.join(',')));
  const lines = [];
  for (let y = r1; y >= r0; y--) {
    let s = '';
    for (let x = c0; x <= c1; x++) s += x === 0 && y === 0 ? '●' : set.has(`${y},${x}`) ? '■' : '·';
    lines.push(s);
  }
  return { id, text: lines.join('/'), cells, forward: c1, width: r1 - r0 + 1 };
}

// ── 技能描述：把 {atk:0%} 这类占位换成数值 ──
function skillText(id, lvl = 6) {
  const s = skills[id];
  if (!s) return null;
  const L = s.levels[Math.min(lvl, s.levels.length - 1)];
  const bb = new Map((L.blackboard || []).map((b) => [b.key.toLowerCase(), b.value]));
  const desc = strip(String(L.description || '').replace(/\{(-?)([^}:]+)(?::([^}]+))?\}/g, (_, neg, key, fmt) => {
    let v = bb.get(key.toLowerCase());
    if (v == null) return key;
    if (neg) v = -v;
    if (fmt && fmt.includes('%')) return `${Math.round(v * 100)}%`;
    return String(Math.round(v * 100) / 100);
  }));
  return { id, name: L.name, sp: L.spData?.spCost, initSp: L.spData?.initSp, duration: L.duration, desc };
}

// ── 卡池干员 ↔ 角色表 ──
const byName = new Map();
for (const [id, c] of Object.entries(chars)) if (c?.name && !id.startsWith('token_') && !id.startsWith('trap_')) { if (!byName.has(c.name)) byName.set(c.name, []); byName.get(c.name).push([id, c]); }
const out = {};
const miss = [];
for (const p of pool) {
  const hit = (byName.get(p.name) || []).find(([id]) => id.startsWith('char_')) || (byName.get(p.name) || [])[0];
  if (!hit) { miss.push(p.name); continue; }
  const [id, c] = hit;
  // 卫戍里干员 55 级：有精一就按精一（phases[1]），没有就按最高阶段
  const ph = c.phases[1] || c.phases.at(-1);
  const attr = ph.attributesKeyFrames?.at(-1)?.data || {};
  out[p.name] = {
    id, tier: p.tier, cls: PROF[c.profession] || c.profession, sub: c.subProfessionId, tags: p.tags,
    block: attr.blockCnt ?? null, cost: attr.cost ?? null, redeploy: attr.respawnTime ?? null,
    hp: attr.maxHp ?? null, atk: attr.atk ?? null, def: attr.def ?? null, res: attr.magicResistance ?? null, interval: attr.baseAttackTime ?? null,
    range: drawRange(ph.rangeId),
    skills: (c.skills || []).map((s) => skillText(s.skillId)).filter(Boolean),
    trait: strip(c.description)
  };
}

// ── 模式与回合 ──
const modeName = (k) => {
  let m = k.match(/^mode_single_(\d+)$/); if (m) return `规程等级 ${m[1]}（标准独立模拟）`;
  return { mode_multi_normal: '联合模拟·标准', mode_multi_hard: '联合模拟·绝境', mode_multi_abyss: '联合模拟·终极', mode_single_funny: '极速模拟（单人）', mode_multi_funny: '极速模拟（联机）', mode_training_1: '训练 1', mode_training_2: '训练 2' }[k] || k;
};
const modeLines = [];
for (const [k, v] of Object.entries(ac.turnInfoDataDict)) {
  const r = Object.values(v);
  const times = r.map((x) => x.normalPhaseTime);
  const sameTime = new Set(times).size === 1;
  modeLines.push(`| ${modeName(k)} | ${r.length} | ${sameTime ? times[0] : r.map((x) => `${x.round}:${x.normalPhaseTime}`).join(' ')} | ${r.filter((x) => x.isBossTurn).map((x) => x.round).join('、') || '—'} |`);
}
const steps = ac.enterStepList.map((s) => `${s.title} ${s.time} 秒`).join(' → ');
const tips = ac.gameTipsList.map((t) => `- ${strip(t.tip)}`).join('\n');
fs.writeFileSync(path.join(KB, '05-模式与回合.md'), [
  '# 卫戍协议·规程：模式与回合（游戏数据 activity_table.autoChessData 整理）',
  '',
  `来源：ArknightsGameData zh_CN（${new Date().toISOString().slice(0, 10)} 下载）。休整时长单位秒（单人 300 秒基本用不完；联机每回合不同）。`,
  '',
  `开局流程：${steps}。`,
  '',
  '| 模式 | 回合数 | 休整时长（秒，回合:秒） | Boss 回合 |',
  '|---|---|---|---|',
  ...modeLines,
  '',
  '## 游戏内提示（加载界面的小贴士）',
  tips,
  ''
].join('\n'), 'utf8');

// ── 技能自动释放条件 ──
const TRIG = { ALWAYS: '好了就放', ON_TAKE_DAMAGE: '挨打时', SKILL_RANGE_ENEMY: '技能范围内有敌人', ATTACK_RANGE_ENEMY: '攻击范围内有敌人', ON_ATTACK: '要攻击时', ON_HEAL: '要治疗时', HAS_HEAL_TARGET: '有人要治疗时', ON_DEPLOY: '部署时' };
const trig = ac.skillTriggerDataList.map((t) => `- ${t.charId || (t.subProfessionId ? `分支 ${t.subProfessionId}` : PROF[t.profession] || t.profession)} 技能${t.skillIndex + 1}：${t.skillTriggerTypes.map((x) => TRIG[x] || x).join(' / ')}`).join('\n');

const lines = Object.entries(out).sort((a, b) => a[1].tier - b[1].tier).map(([n, d]) => {
  const sk = d.skills.map((s, i) => `技${i + 1}「${s.name}」${s.sp != null ? `(${s.initSp}/${s.sp}技力${s.duration > 0 ? `，${s.duration}秒` : ''})` : ''}：${s.desc.slice(0, 90)}`).join('；');
  return `- ${n}(${d.cls}·${d.sub})｜${'Ⅰ Ⅱ Ⅲ Ⅳ Ⅴ Ⅵ'.split(' ')[d.tier - 1]}阶｜阻挡 ${d.block ?? '?'}｜范围 ${d.range.text}｜${sk}`;
});
fs.writeFileSync(path.join(KB, '06-干员范围与技能.md'), [
  '# 卫戍协议·规程：卡池干员的攻击范围和技能（游戏数据 character / skill / range_table 整理）',
  '',
  '读法：范围是朝右看的小格子图，● 是自己、■ 是打得到的格子，/ 分行（从上到下）。阻挡 = 能同时挡几个地面敌人（0 = 不挡，远程站高台）。',
  '技能写的是满级描述和技力消耗（初始/总共）；作战中按下面的「自动释放条件」自己放。卫戍里干员 55 级，按精英一的范围和数值。',
  `没在角色表里找到的（卫戍专用原型干员等）：${miss.join('、') || '无'}。`,
  '',
  ...lines,
  '',
  '## 技能自动释放条件（autoChessData.skillTriggerDataList）',
  trig,
  ''
].join('\n'), 'utf8');
fs.writeFileSync(path.join(KB, '06-干员数据.json'), JSON.stringify(out, null, 1), 'utf8');
console.log(`干员 ${Object.keys(out).length}/${pool.length}，没找到：${miss.join('、') || '无'}；模式 ${modeLines.length} 种；技能触发规则 ${ac.skillTriggerDataList.length} 条`);
