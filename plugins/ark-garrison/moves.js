// plugins/ark-garrison/moves.js
//
// 「动作层」：卫戍协议里最常用的操作做成函数，模型只说「买 2 号」「把木板第 1 个放到 5 号格朝右」，
// 坐标、点几下、等多久、做完有没有成功，全由这里负责。
//
// 每个函数都：先确认在对的界面 → 做 → 再看一眼核对结果。返回 { ok, why, ...读到的新数字 }。
// 失败不重试太多次（最多一次），交回上层带着新画面重新规划，免得一错到底。
//
// 坐标见 screen.js（2026-11-10 在雷电 9 上校准）。

import { POS, classify, readRest, toNum, NUM_REGIONS, scanBench, scanBoard } from './screen.js';
import { decodeRgb, findGreenTiles, findWalkway, isHolding, findMarkers } from './tiles.js';

const BENCH_Y = 465;   // 商店展开时木板上的人身体中心高度

/**
 * 自动挑格子：敌人从右边来（实测红框在右）。'auto' / 'auto-front' = 最靠右的亮格（挡怪的近战放前排）；
 * 'auto-back' = 靠左四分之一处的亮格（远程、医疗放后排，又不至于离路太远）。
 */
export function autoTile(tiles, kind = 'auto') {
  const byX = [...tiles].sort((a, b) => b.x - a.x);
  if (kind === 'auto-back') return byX[Math.min(byX.length - 1, Math.floor(byX.length * 0.75))];
  return byX[0];
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// 点到线段的距离（线段 = 守点→出生点，近似敌人走的路）
function segDist(p, a, b) {
  const vx = b.x - a.x; const vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** 一格多少像素：亮格里同一行（dy<20）最近邻的横向距离、同一列（dx<25）最近邻的纵向距离，各取中位数；不够就用 75×70。 */
export function gridPitch(tiles) {
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const dxs = []; const dys = [];
  for (const t of tiles) {
    const h = tiles.filter((o) => o !== t && Math.abs(o.y - t.y) < 20).map((o) => Math.abs(o.x - t.x)).filter((d) => d > 40);
    const v = tiles.filter((o) => o !== t && Math.abs(o.x - t.x) < 25).map((o) => Math.abs(o.y - t.y)).filter((d) => d > 40);
    if (h.length) dxs.push(Math.min(...h));
    if (v.length) dys.push(Math.min(...v));
  }
  const px = med(dxs); const py = med(dys);
  return { px: px && px < 120 ? px : 75, py: py && py < 120 ? py : 70 };
}

/**
 * 站在 t、朝 dir 的人，攻击范围罩不罩得到点 p。cells 是 [行, 列]：列 = 朝面朝方向往前几格，行 = 左右偏几格。
 */
export function covers(t, dir, cells, { px, py }, p) {
  for (const [r, c] of cells) {
    let dx; let dy;
    if (dir === 'right') { dx = c * px; dy = r * py; } else if (dir === 'left') { dx = -c * px; dy = r * py; } else if (dir === 'down') { dx = r * px; dy = c * py; } else { dx = r * px; dy = -c * py; }
    if (Math.abs(p.x - (t.x + dx)) <= px / 2 && Math.abs(p.y - (t.y + dy)) <= py / 2) return true;
  }
  return false;
}

/** 朝向：朝着敌人出生点那边（出生点在左就朝左，不再一律朝右）。 */
export function faceToward(tile, spawn, fallback = 'right') {
  if (!spawn || !tile) return fallback;
  const dx = spawn.x - tile.x; const dy = spawn.y - tile.y;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
}

/**
 * 按路线站位（代替「近战放最右、远程放偏左」那种一字散开的放法）：
 *   敌人从红框（出生点）往蓝框（守点）走，几条路在守点附近汇合 → 集合点 = 守点往出生点方向三成处，大家围着它抱团。
 *   近战（auto-front）：贴着路线、离集合点近的格子，怪一路过来先撞上它；
 *   远程（auto-back）：离集合点近、挨着已经上场的自己人（抱团，射程罩住挡怪的那一段）。
 * 看不到蓝框（按住人时被左上详情面板挡住）就用离出生点最远的亮格当守点那头；红框也没有就退回老办法。
 * 格距约 70～80 像素。
 */
export function placeTile(tiles, kind = 'auto-front', { spawn = null, target = null, friends = [], range = null } = {}) {
  if (!tiles.length) return null;
  if (!spawn) return autoTile(tiles, kind);
  // 半块绿格（面积不到最大格的一半）多半是被旁边的人挡住了，中心算偏、放不上：打分加 80 像素的罚
  const maxA = Math.max(...tiles.map((t) => t.area || 0));
  const part = (t) => (maxA && t.area && t.area < 0.5 * maxA ? 80 : 0);
  const far = target || tiles.reduce((a, t) => (dist(t, spawn) > dist(a, spawn) ? t : a));
  const anchor = { x: far.x + 0.3 * (spawn.x - far.x), y: far.y + 0.3 * (spawn.y - far.y) };
  const near = (t) => (friends.length ? Math.min(...friends.map((f) => dist(t, f))) : 0);
  // 有攻击范围数据（06-干员数据.json 的 cells）：远程挑「范围罩住路线最多、尤其是挡怪那段」的格子，医疗挑「罩住自己人最多」的格子
  if (range?.length && kind !== 'auto-front') {
    const pitch = gridPitch(tiles);
    const reach = (t, p) => covers(t, faceToward(t, spawn), range, pitch, p);
    if (kind === 'auto-heal' && friends.length) {
      const sc = (t) => -10 * friends.filter((f) => reach(t, f)).length + 0.2 * dist(t, anchor) + part(t);
      const best = [...tiles].sort((a, b) => sc(a) - sc(b))[0];
      if (friends.some((f) => reach(best, f))) return best;
    } else if (kind === 'auto-back') {
      // 路线上每 30 像素取一个点，离集合点越近越值钱（挡怪的在那儿，敌人在那儿停下挨打）
      const pts = [];
      const len = dist(far, spawn);
      for (let s = 0; s <= len; s += 30) { const k = s / len; pts.push({ x: far.x + k * (spawn.x - far.x), y: far.y + k * (spawn.y - far.y) }); }
      const val = (t) => pts.reduce((v, p) => v + (reach(t, p) ? 1 / (1 + dist(p, anchor) / 150) : 0), 0);
      const sc = (t) => -10 * val(t) + 0.3 * near(t) + part(t);
      const best = [...tiles].sort((a, b) => sc(a) - sc(b))[0];
      if (val(best) > 0) return best;
    }
  }
  const score = kind === 'auto-heal'
    ? (t) => 1.5 * near(t) + 0.5 * dist(t, anchor) + part(t)   // 医疗：贴着自己人，奶得到
    : kind === 'auto-back'
      ? (t) => dist(t, anchor) + 0.5 * near(t) + 0.3 * segDist(t, far, spawn) + part(t)
      : (t) => dist(t, anchor) + 1.5 * segDist(t, far, spawn) + part(t);
  return [...tiles].sort((a, b) => score(a) - score(b))[0];
}

/**
 * 取消按住时放回哪里：按住时镜头切到收起视角，原坐标那里是棋盘格（松手就放上场了！）。
 * 在按住的截图里找亮青色的木板，取离「原位置换算到按住视角」最近的一点。
 * 换算是第一张图实测的：展开 915→按住 1040、840→945（约 1.27 倍）。找不到青色木板时就用换算值、y=600。
 */
function cancelSpot(rgb, x) {
  const guess = Math.round(1040 + (x - 915) * 1.27);
  return findWalkway(rgb, guess) || [guess, 600];
}

const pause = (eyes, ms) => eyes.sleep(ms);

async function readNum(eyes, region) {
  const { image } = await eyes.shot();
  const r = await eyes.readRegions(image, { v: region }, { onlyRec: true });
  return toNum(r.v);
}

/** 确保在休整期、商店是展开 / 收起状态。 */
export async function ensureShop(eyes, open = true) {
  for (let i = 0; i < 3; i++) {
    const look = await eyes.look();
    const c = classify(look);
    if (c.kind === 'roundBanner') { await pause(eyes, 1500); continue; }
    if (c.kind !== 'rest') return { ok: false, why: `不在休整期（${c.kind}）`, look };
    // 场上干员的圆盘菜单开着（镜头拉近，升级 / 准备都点不到）：先关掉再说
    if (look.items.some((it) => /^出售$/.test(it.text.trim())) && !look.items.some((it) => /拖拽至此售出/.test(it.text))) { await closeUnitMenu(eyes, look); continue; }
    if (c.shopOpen === open) return { ok: true, look };
    await eyes.tap(...POS.shopToggle);
    await pause(eyes, 900);
  }
  return { ok: false, why: '商店开关点了没反应' };
}

/** 买商店第 slot 张卡（1～5）。买得起才买；买完核对资金是否减少。 */
export async function buy(eyes, slot, { known = [] } = {}) {
  const sh = await ensureShop(eyes, true);
  if (!sh.ok) return sh;
  const st = await readRest(eyes, sh.look, { known });
  const card = st.shop[slot - 1];
  if (!card || card.empty) return { ok: false, why: `${slot} 号卡位是空的` };
  if (card.cost != null && st.funds != null && card.cost > st.funds) return { ok: false, why: `${card.name} 要 ${card.cost}，只有 ${st.funds}` };
  const x = card.x;   // 卡位是从画面上现找的（格数随调度中心等级变）
  await eyes.tap(x, POS.cardY);
  await pause(eyes, 500);
  await eyes.tap(x, POS.buyConfirmY);
  await pause(eyes, 800);
  // 免费的（三合一送的 0 块三选一）：资金本来就不变，看那张卡还在不在
  if (card.cost === 0) {
    const after = await readRest(eyes, await eyes.look(), { known });
    const same = after.shop.find((c) => !c.empty && c.name === card.name && Math.abs((c.x ?? 0) - x) < 40);
    const ok = !same;
    if (!ok) await eyes.tap(...POS.blank);
    return { ok, why: ok ? '' : '免费的那张还在，没拿成', name: card.name, cost: 0, funds: after.funds };
  }
  let funds = await readNum(eyes, NUM_REGIONS.funds);
  // 资金数字有动画，读早了会以为没买成：再等一下读一次
  if (funds != null && st.funds != null && funds >= st.funds) { await pause(eyes, 700); funds = await readNum(eyes, NUM_REGIONS.funds); }
  let ok;
  if (funds != null && st.funds != null) ok = funds < st.funds;
  else {
    // 资金读不出：数木板上的东西，多了才算买到（以前直接算成功，没钱时也报「买到了」，木板上凭空多出没有的人，后面放 / 卖全对不上）
    const benchBefore = scanBench(await decodeRgb(sh.look.file)).length;
    const l2 = await eyes.look();
    ok = scanBench(await decodeRgb(l2.file)).length > benchBefore;
  }
  if (!ok) await eyes.tap(...POS.blank);   // 没买成：多半停在「无法购买」，点空白处关掉
  return { ok, why: ok ? '' : '资金没变，没买成', name: card.name, cost: card.cost, funds };
}

/** 刷新商店。 */
export async function refresh(eyes) {
  const sh = await ensureShop(eyes, true);
  if (!sh.ok) return sh;
  const st = await readRest(eyes, sh.look, {});
  const names = (s) => s.shop.map((c) => c.name).join('|');
  await eyes.tap(...POS.refresh);
  await pause(eyes, 1000);
  const after = await readRest(eyes, await eyes.look(), {});
  // 有的策略 / 装备让刷新免费，资金不变也可能刷成了：资金少了或者商店的卡变了都算成功
  const ok = (st.funds != null && after.funds != null && after.funds < st.funds) || names(after) !== names(st);
  return { ok, why: ok ? '' : `资金没变（${st.funds}→${after.funds}）、商店也没变，没刷新成`, funds: after.funds };
}

/** 升级调度中心（多放一个人、商店出高阶卡）：点卡片会先选中 / 预览下一级，出现「确认升级」再点它。 */
export async function upgrade(eyes) {
  const sh = await ensureShop(eyes, true);
  if (!sh.ok) return sh;
  const st = await readRest(eyes, sh.look, {});
  if (st.upgradeCost != null && st.funds != null && st.upgradeCost > st.funds) return { ok: false, why: `升级要 ${st.upgradeCost}，只有 ${st.funds}` };
  let confirm = null;
  for (let i = 0; i < 3 && !confirm; i++) {
    await eyes.tap(st.upgradeX, POS.cardY);   // 升级卡位置随格数变，readRest 现找
    // 「确认升级」是动画出来的，多看两眼再决定要不要再点
    for (let j = 0; j < 2 && !confirm; j++) {
      await pause(eyes, 600);
      const look = await eyes.look();
      confirm = look.items.find((it) => /确认升级/.test(it.text));
    }
  }
  if (!confirm) { await eyes.tap(...POS.blank); return { ok: false, why: '点了升级卡没出现「确认升级」' }; }
  await eyes.tap(confirm.x, confirm.y);
  await pause(eyes, 900);
  const funds = await readNum(eyes, NUM_REGIONS.funds);
  const ok = st.funds == null || funds == null || funds < st.funds;
  return { ok, why: ok ? '' : `资金没变（${st.funds}→${funds}），没升级成`, funds };
}

/**
 * 按住木板上 x 处的人（x 来自 screen.scanBench，商店展开镜头，y≈465），返回能放的格子（截图上找绿格）。手指不松。
 * 没有格子亮 = 那里没人（或拿不起来），自动放回。from = 取消时放回去的位置（按住视角下的木板，见 cancelSpot）。
 */
export async function pickUp(eyes, x, y = BENCH_Y) {
  const sh = await ensureShop(eyes, true);
  if (!sh.ok) return sh;
  const { file } = await eyes.pickUp(x, y);
  const rgb = await decodeRgb(file);
  const from = cancelSpot(rgb, x);
  // 站着人的格子底下也是绿的：按住视角里扫一遍场上的人（角标），离人 52 像素以内的绿格当作被占了
  // （格距 70～80；实测机械师站的格子中心离他的估计位置 45 像素）
  const units = scanBoard(rgb, { y0: 120, y1: 470, x0: 300, x1: 1100 });
  const tiles = findGreenTiles(rgb).filter((t) => !units.some((u) => Math.hypot(u.x - t.x, u.y - t.y) < 52));
  // 场上站满时按住人只有站着人的格子是绿的（都被滤掉）：看右下角金色售出框判断确实拿起来了，照样能卖、能认名字，只是不能部署
  if (!tiles.length && !isHolding(rgb)) { await eyes.cancelHold(...from); return { ok: false, why: `(${x},${y}) 拿不起人（可能是空的）`, file }; }
  // 红框 / 蓝框和场上自己人的位置：自动站位（placeTile）用
  // 自己人：去掉顶上一排盟约图标（y≤200）和左上详情面板底下（x<440）的误认
  return { ok: true, tiles, file, from, full: !tiles.length, marks: { ...findMarkers(rgb), friends: units.filter((u) => u.y > 200 && u.x > 440) } };
}

/**
 * 部署：把木板上 x 处的人放到 target（格子中心坐标 {x,y}，或格子编号——tiles 列表的下标），朝 dir。
 * 按住时重新找一遍绿格，落点吸附到最近的亮格；核对「剩余可放置」减了 1。
 */
// 放过但没放上的格子（多半是被旁边的人挡住一半、算出来的中心偏了的「半块」绿格）：5 分钟内自动站位不再挑它
const BAD_TILES = [];
const isBadTile = (t) => BAD_TILES.some((b) => Date.now() - b.at < 300000 && Math.hypot(b.x - t.x, b.y - t.y) < 30);

/** 部署（自动站位放失败时，记下那格、换下一格再试一次）。 */
export async function deploy(eyes, x, target, dir = 'right', opts = {}) {
  const r = await deployOnce(eyes, x, target, dir, opts);
  if (r.ok || !r.tried || !(typeof target === 'string' && target.startsWith('auto'))) return r;
  BAD_TILES.push({ ...r.tried, at: Date.now() });
  const r2 = await deployOnce(eyes, x, target, dir, opts);
  if (!r2.ok && r2.tried) BAD_TILES.push({ ...r2.tried, at: Date.now() });
  return r2.ok ? { ...r2, moved: true } : r2;
}

async function deployOnce(eyes, x, target, dir = 'right', { tiles: planned = null, range = null } = {}) {
  const before = await readNum(eyes, NUM_REGIONS.remainOpen);
  const p = await pickUp(eyes, x);
  if (!p.ok) return p;
  // target='auto'：自动补位用，挑最靠右（离敌人来的方向最近）的亮格
  const auto = typeof target === 'string' && target.startsWith('auto');
  let want = auto ? placeTile(p.tiles.filter((t) => !isBadTile(t)), target, { ...p.marks, range }) : typeof target === 'number' ? (planned || p.tiles)[target] : target;
  if (!want) { await eyes.cancelHold(...p.from); return { ok: false, why: p.full ? "场上站满了，放不上去" : `没有 ${target} 号格子` }; }
  const near = p.tiles.map((t) => ({ t, d: Math.hypot(t.x - want.x, t.y - want.y) })).sort((a, b) => a.d - b.d)[0];
  // 规划时的格子图是按住另一个人拍的；不同职业能放的格子不一样。目标没亮就改放到附近最近的亮格（亮的对这个人一定能放）
  if (!near || near.d > 150) { await eyes.cancelHold(...p.from); return { ok: false, why: '目标格子和附近都不能放（没亮）' }; }
  const moved = near.d > 45;
  want = near.t;
  await eyes.dropAt(want.x, want.y);
  // 自动站位时朝向跟着出生点走（调用方传的 dir 多半是默认的 right）
  if (auto && p.marks?.spawn) dir = faceToward(want, p.marks.spawn, dir);
  await eyes.face(want.x, want.y, dir);
  await pause(eyes, 700);
  const sh = await ensureShop(eyes, true);
  const after = sh.ok ? await readNum(eyes, NUM_REGIONS.remainOpen) : null;
  // 刚卖掉 / 撤下场上的人后，「剩余可放置角色」的数字不马上刷新（实测卖完还显示 0，放上去之后 0 才是对的，人其实上场了）：
  // 按住时亮了空绿格就说明一定有空位，放之前至少算 1
  const was = before != null ? Math.max(before, p.tiles.length ? 1 : 0) : null;
  const ok = was != null && after != null ? after === was - 1 : true;
  return { ok, why: ok ? '' : `剩余可放置没减（${before}→${after}）`, at: want, remain: after, moved, tried: ok ? null : { x: want.x, y: want.y } };
}

/** 卖掉木板上 x 处的人（拖到右下「拖拽至此售出」）。 */
export async function sell(eyes, x) {
  const before = await readNum(eyes, NUM_REGIONS.funds);
  const p = await pickUp(eyes, x);
  if (!p.ok) return p;
  await eyes.dropAt(...POS.sell);
  await pause(eyes, 800);
  const funds = await readNum(eyes, NUM_REGIONS.funds);
  const ok = before == null || funds == null || funds > before;
  return { ok, why: ok ? '' : '资金没涨，没卖成', funds };
}

/** 准备就绪（有确认框就确认）。核对离开了休整期。 */
export async function ready(eyes) {
  await closeUnitMenu(eyes);   // 场上干员的菜单开着时准备就绪点不动
  await eyes.tap(...POS.ready);
  // 确认框、切镜头都有动画，点完马上看会误判成「还在休整期」：轮询几次
  let k = 'rest';
  for (let i = 0; i < 6; i++) {
    await pause(eyes, 700);
    const look = await eyes.look();
    k = classify(look).kind;
    if (k === 'readyConfirm') {
      const btn = look.items.find((it) => /^确认$/.test(it.text.trim()) && it.x > 800);
      await eyes.tap(...(btn ? [btn.x, btn.y] : POS.readyConfirm));
      continue;
    }
    if (k !== 'rest') break;   // restWaiting（联机等队友）也算准备好了
  }
  return { ok: k !== 'rest' && k !== 'readyConfirm', why: k === 'rest' ? '点了准备就绪还在休整期' : '', screen: k };
}

export const MOVES = { buy, refresh, upgrade, deploy, sell, ready };

/**
 * 场上的人（screen.scanBoard 给的位置）：按住拖到右下「拖拽至此售出」卖掉。核对资金涨了。
 * 用来腾位置换更好的人——场上满了时，好牌只能在木板上干等。
 */
export async function sellBoard(eyes, at) {
  const before = await readNum(eyes, NUM_REGIONS.funds);
  const p = await pickUp(eyes, at.x, at.y);
  if (!p.ok) return p;
  await eyes.dropAt(...POS.sell);
  await pause(eyes, 900);
  const funds = await readNum(eyes, NUM_REGIONS.funds);
  const ok = before == null || funds == null || funds > before;
  return { ok, why: ok ? '' : '资金没涨，没卖成', funds };
}

/** 场上的人撤回木板（拖到按住视角下的青色木板）。核对剩余可放置 +1。 */
export async function withdraw(eyes, at) {
  const before = await readNum(eyes, NUM_REGIONS.remainOpen);
  const p = await pickUp(eyes, at.x, at.y);
  if (!p.ok) return p;
  await eyes.dropAt(...p.from);
  await pause(eyes, 900);
  const sh = await ensureShop(eyes, true);
  const after = sh.ok ? await readNum(eyes, NUM_REGIONS.remainOpen) : null;
  // 只看「涨了」：剩余数偶尔把 1 认成 7（实测 0→7），要求正好 +1 会把撤成功判成失败
  const ok = before != null && after != null ? after > before : true;
  return { ok, why: ok ? '' : `剩余可放置没加（${before}→${after}）`, remain: after };
}

/**
 * 戴装备：按住木板上 x 处的装备，拖到场上第 index 个人身上（场上的人按从上到下、从左到右排，共 count 个）。
 * 按住时镜头切到收起视角，场上的人位置变了：在按住的截图里扫角标（按住视角的棋盘范围 y 120～470），按同样顺序找人。
 * 核对：木板上的东西少了一件（装备戴上了，换钱类的直接销毁）。
 */
export async function equip(eyes, x, _target, { index = 0, count = 1 } = {}) {
  const sh = await ensureShop(eyes, true);
  if (!sh.ok) return sh;
  const before = scanBench(await decodeRgb(sh.look.file)).length;
  const { file } = await eyes.pickUp(x, BENCH_Y);
  const rgb = await decodeRgb(file);
  const units = scanBoard(rgb, { y0: 120, y1: 470, x0: 300, x1: 1100 });
  const t = units.length === count ? units[index] : units[Math.min(index, units.length - 1)];
  if (!t) { await eyes.cancelHold(...cancelSpot(rgb, x)); return { ok: false, why: '按住装备时没找到场上的人' }; }
  await eyes.dropAt(t.x, t.y - 20);
  await pause(eyes, 900);
  const sh2 = await ensureShop(eyes, true);
  const after = sh2.ok ? scanBench(await decodeRgb(sh2.look.file)).length : before;
  const ok = after < before;
  return { ok, why: ok ? '' : '木板上的装备还在，没戴上', file };
}

/** 冻结商店：把没买的卡留到下回合（第三张差钱时用）。按钮变成「解冻」就算成功。 */
export async function freeze(eyes) {
  const sh = await ensureShop(eyes, true);
  if (!sh.ok) return sh;
  if (sh.look.items.some((i) => /解冻/.test(i.text))) return { ok: true, why: '已经冻着了' };
  await eyes.tap(...POS.freeze);
  await pause(eyes, 700);
  const look = await eyes.look();
  const ok = look.items.some((i) => /解冻/.test(i.text));
  return { ok, why: ok ? '' : '点了冻结没看到「解冻」' };
}

/**
 * 关掉场上干员的圆盘菜单（点了场上的人会弹「撤退 / 出售 +1 / 技能」，镜头还会拉近）。
 * 认名字时点了人、再点「空白处」想关掉，可镜头拉近后那里不一定是空白，菜单没关上，「准备就绪」就一直点不成（2026-11-11 第 5 回合）。
 * 看到「出售」就按返回键；万一弹出「退出模拟 / 离开」之类的确认框，点「取消」。
 */
export async function closeUnitMenu(eyes, look = null) {
  let l = look || await eyes.look();
  for (let k = 0; k < 2; k++) {
    const menu = l.items.some((i) => /^出售$/.test(i.text.trim())) && !l.items.some((i) => /拖拽至此售出/.test(i.text));
    if (!menu) return { ok: true, closed: k > 0 };
    await eyes.back();
    await pause(eyes, 600);
    l = await eyes.look();
    const cancel = l.items.find((i) => /^取消$/.test(i.text.trim()));
    if (cancel) { await eyes.tap(cancel.x, cancel.y); await pause(eyes, 500); l = await eyes.look(); }
  }
  return { ok: !l.items.some((i) => /^出售$/.test(i.text.trim())), closed: true };
}
