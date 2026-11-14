// plugins/ark-garrison/opening.js —— 开局三步不问模型，程序直接走（每步问一次模型要 13～15 秒，选策略那步常常问三次，70 秒倒计时用掉大半）。
//
//   1/3 确认本局信息   直接点「准备就绪」
//   2/3 选择策略       一格格都是头像、没有名字：点一格，右边详情出名字（右侧中间），对上路线里的「首选 / 备选」就点「确认选择」。
//                      第一次见到的格子会把「第几格是谁」记进 data/ark-garrison/strategy-grid.json，下次直接点。
//   3/3 确定自选编队   直接点「准备就绪」（还没在主界面建过 5 / 6 阶自选编队，没东西可选）
//
// 坐标按 1280x720（实测 2026-11-11 规程等级 3）：
//   没选中时格子四列 x 717/857/997/1137，选中后整块左移到 453/593/733/873；行 y 245/385/525/665（只看第一屏 16 格）
//   选中后详情名字在 (985～1185, 368～404)，「确认选择」在 (1120, 662)

import fs from 'node:fs';
import path from 'node:path';
import { WORK_DIR } from './maa.js';
import { decodeRgb } from './tiles.js';
import { readCountdown } from './screen.js';

const CACHE = path.join(WORK_DIR, 'strategy-grid.json');
const COLS_OPEN = [717, 857, 997, 1137];
const COLS_PICKED = [453, 593, 733, 873];
const ROWS = [245, 385, 525, 665];
const NAME_ROI = [985, 368, 200, 36];

const has = (look, re) => look.items.some((i) => re.test(i.text));

/** 开局第几步：顶上中间「1/3 确认本局信息」「2/3 选择策略」「3/3 确定自选编队」。不是开局返回 0。 */
export function openingStep(look) {
  const top = look.items.filter((i) => i.y < 80 && i.x > 520 && i.x < 860);
  if (top.some((i) => /确认本局信息/.test(i.text))) return 1;
  if (top.some((i) => /选择策略/.test(i.text))) return 2;
  if (top.some((i) => /自选编队/.test(i.text))) return 3;
  return 0;
}

/** 路线文字里的「首选 X；备选 Y」→ [X, Y] */
export function wantedStrategies(route = '') {
  const pick = (re) => String(route).match(re)?.[1]?.replace(/[（(].*$/, '').trim() || '';
  return [pick(/首选\s*([^；;，,。\s]+)/), pick(/备选\s*([^；;，,。\s]+)/)].filter(Boolean);
}

const loadCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return { names: [] }; } };
const saveCache = (c) => { try { fs.writeFileSync(CACHE, JSON.stringify(c, null, 2)); } catch { /* ignore */ } };

/** 第 1、3 步：点「准备就绪」。点过了（按钮变「取消准备」/ 在等）就不点。 */
export async function readyStep(eyes, look) {
  if (has(look, /取消准备|等待其他/)) { await eyes.sleep(1500); return { ok: true, waited: true }; }
  const btn = look.items.find((i) => /准备就绪/.test(i.text) && i.x > 900);
  await eyes.tap(...(btn ? [btn.x, btn.y] : [1125, 655]));
  await eyes.sleep(1200);
  return { ok: true };
}

/**
 * 第 2 步：照路线选策略。want 按优先顺序；都找不到就保留默认（第 0 格，通常是阿米娅：3/4/5 种盟约激活时全体攻击 / 生命 +20/30/40%）。
 * 返回 { ok, picked, tried }
 */
export async function pickStrategy({ eyes, look, want = [], log = () => {} }) {
  const cache = loadCache();
  const names = cache.names || [];
  let picked = has(look, /确认选择/);   // 已经有一格选中了：格子在左移后的位置
  const at = (i) => [(picked ? COLS_PICKED : COLS_OPEN)[i % 4], ROWS[Math.floor(i / 4)]];
  let deadline = null;
  try { const cd = readCountdown(await decodeRgb(look.file)); if (cd != null) deadline = Date.now() + cd * 1000; } catch { /* 没读到倒计时 */ }
  const left = () => (deadline == null ? 60 : (deadline - Date.now()) / 1000);
  const tried = [];

  // 点第 i 格，读右边详情里的名字，顺手记进缓存
  const probe = async (i) => {
    await eyes.tap(...at(i));
    picked = true;
    await eyes.sleep(700);
    const l = await eyes.look();
    const r = await eyes.readRegions(l.image, { name: NAME_ROI });
    const n = String(r.name || '').replace(/[^一-龥A-Za-z0-9·]/g, '');
    if (n) { names[i] = n; cache.names = names; saveCache(cache); }
    tried.push(`${i}:${n || '?'}`);
    return n;
  };
  const confirm = async () => {
    const l = await eyes.look();
    const btn = l.items.find((i) => /确认选择/.test(i.text));
    await eyes.tap(...(btn ? [btn.x, btn.y] : [1120, 662]));
    await eyes.sleep(1200);
  };
  const match = (n, w) => n && w && (n.includes(w) || w.includes(n));

  for (const w of want) {
    // 记得在哪一格：直接点、核对名字
    const k = names.findIndex((n) => match(n, w));
    if (k >= 0 && left() > 8) {
      const n = await probe(k);
      if (match(n, w)) { await confirm(); log(`开局选策略：${n}（路线首选/备选，记住的第 ${k} 格）`); return { ok: true, picked: n, tried }; }
    }
  }
  // 不记得：没见过的格子一格格点开看，碰上首选就选；备选先记着，首选找遍了没有再回去选备选
  for (let i = 0; i < 16 && left() > 12; i++) {
    if (names[i]) continue;
    const n = await probe(i);
    if (want[0] && match(n, want[0])) { await confirm(); log(`开局选策略：${n}（路线首选，第 ${i} 格）`); return { ok: true, picked: n, tried }; }
  }
  for (const w of want.slice(1)) {
    const k = names.findIndex((n) => match(n, w));
    if (k >= 0 && left() > 6) {
      const n = await probe(k);
      if (match(n, w)) { await confirm(); log(`开局选策略：${n}（首选 ${want[0]} 没找到，用备选，第 ${k} 格）`); return { ok: true, picked: n, tried }; }
    }
  }
  // 都没有：选第 0 格（默认的阿米娅）
  const n = await probe(0);
  await confirm();
  log(`开局选策略：路线里的 ${want.join(' / ') || '（没写）'} 没找到，选了 ${n || '第 0 格'}`);
  return { ok: true, picked: n, tried };
}
