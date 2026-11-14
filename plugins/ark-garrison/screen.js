// plugins/ark-garrison/screen.js
//
// 「识别层」：把一屏（全屏 OCR 结果 + 几个小区域的 OCR）读成结构化的局面，不问模型。
// 坐标一律 1280x720，2026-11-10 在雷电 9 上对「卫戍协议·规程」标准独立模拟校准（data/ark-garrison/probe/cal-*.png）。
//
// 休整期有两种镜头：商店展开（棋盘上移、底下一排 5 张卡）和商店收起（棋盘下移、木板更大）。
// 卡位、按钮在两种镜头下位置不同，所以先认镜头再取坐标。

export const SLOT_X = [366, 528, 690, 852, 1014];   // 商店 5 个卡位的中心 x（展开时）

/**
 * 需要单独按区域 OCR 的小数字 / 文字。[x, y, w, h]
 * NUM_REGIONS 是黄底小圆角标里的数字：文字检测模型找不到这么小的字，必须框紧数字本身、用 only_rec 直接认。
 */
export const NUM_REGIONS = {
  round: [482, 22, 34, 22],          // 顶部「回合 N」里的 N（放得下两位数）
  hp: [792, 22, 36, 22],             // 顶部城堡图标旁的目标生命（从 792 起，别框进图标，不然「8」会读成「18」；「14」的细「1」认不出，见 hpWidthFix）
  funds: [1180, 517, 40, 25],         // 右下商店收起按钮上的资金（两位数「11」原来 24 宽会切掉一半，第 8 回合起一直读不出，2026-11-11 放宽）
  remainOpen: [1252, 378, 18, 26],   // 商店展开时「剩余可放置角色：N」的 N
  remainClosed: [1252, 455, 18, 26], // 商店收起时
  upgradeCost: [215, 520, 20, 24],
  refreshCost: [1185, 420, 20, 24],
  slotCost: SLOT_X.map((x) => [x - 10, 520, 20, 24])
};
export const TEXT_REGIONS = {
  slotName: SLOT_X.map((x) => [x - 78, 664, 156, 40]),
  slotTags: SLOT_X.map((x) => [x - 78, 612, 156, 52])
};
export const REGIONS = { ...NUM_REGIONS, ...TEXT_REGIONS };

// ── 固定位置（商店展开镜头）────────────────────────────────────────────
export const POS = {
  ready: [1187, 113],           // 准备就绪
  readyConfirm: [970, 485],     // 「确认准备吗？」的确认
  refresh: [1192, 459],
  freeze: [1043, 459],
  upgrade: [225, 610],
  shopToggle: [1182, 673],      // 收起 / 展开
  buyConfirmY: 682,             // 选中卡片后「确认购买」在卡片下方
  cardY: 610,
  sell: [1185, 600],            // 按住干员时右下角出现「拖拽至此售出」
  blank: [1050, 380]            // 点空白处关掉干员详情
};
/** 整备区（木板）第 k 个位置（商店展开镜头）：买来的人从最右边往左排，间隔约 81 像素（5 个人时实测 915/834/753/672/591）。 */
export const benchPos = (k) => [915 - 81 * k, 465];
export const BENCH_MAX = 9;

// ── 认界面 ─────────────────────────────────────────────────────────────

const topCenter = (look, re) => look.items.some((i) => i.y < 48 && i.x > 560 && i.x < 720 && re.test(i.text));
const has = (look, re, box = null) => look.items.some((i) => re.test(i.text) && (!box || (i.x >= box[0] && i.y >= box[1] && i.x <= box[0] + box[2] && i.y <= box[1] + box[3])));

/**
 * 这一屏是什么：
 *   rest 休整期（shopOpen 表示商店是否展开）、readyConfirm 准备确认框、battle 作战中、
 *   roundBanner 回合开始的「获得 +N」横幅、select 有倒计时的选择界面（策略 / 盟约 / 补给）、other 其它（交给模型）。
 */
export function classify(look) {
  if (has(look, /确认准备吗|离开休整期时清空/)) return { kind: 'readyConfirm' };
  // 战术决策（三选一）被收起时：底部「正在决策…」、右边「回到决策」。不做完开不了战，先点回去再选
  const back = look.items.find((i) => /回到决策/.test(i.text));
  if (back) return { kind: 'decisionHidden', tap: [back.x, back.y] };
  if (has(look, /正在决策/)) return { kind: 'decisionHidden', tap: [1240, 360] };
  if (look.items.some((i) => i.y < 48 && i.x > 600 && i.x < 700 && /^\D?[\dOo]{1,3}\s*\/\s*\d{1,3}$/.test(i.text.trim()))) return { kind: 'battle' };
  const rest = topCenter(look, /休息/);
  if (rest && has(look, /^获得$/, [700, 280, 200, 80])) return { kind: 'roundBanner' };
  // 联机里点了准备就绪、在等队友：按钮变成「取消准备」，画面还是休整期。只等，别再规划，更别点它
  if (rest && has(look, /取消准备/)) return { kind: 'restWaiting' };
  if (rest) {
    const open = has(look, /收起/, [1100, 620, 180, 100]);
    const closed = has(look, /展开/, [1100, 620, 180, 100]);
    return { kind: 'rest', shopOpen: open || !closed };
  }
  // 顶上有「回合」但不是休整期、也没有击杀数：开战前后的过渡镜头
  if (has(look, /回合/, [420, 10, 120, 40]) && !has(look, /选择|确认|策略|盟约|补给/)) return { kind: 'battle', transition: true };
  if (has(look, /策略|盟约|补给|战术决策|编队/) && has(look, /确认|选择/)) return { kind: 'select' };
  return { kind: 'other' };
}

// ── 读数 ───────────────────────────────────────────────────────────────

/** OCR 读小数字时常见的错认：Z→7、O→0 之类。返回整数或 null。 */
/** 两个读数取位数多的（细的「1」常被读丢：31→3、10→0）；有一个是 null 就用另一个。 */
function pickLonger(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return String(b).length > String(a).length ? b : a;
}

/** 小框读不出时的兜底：整屏 OCR 结果里 (x±rx, y±ry) 内的纯数字。 */
function numNear(look, x, y, rx, ry) {
  const it = (look?.items || []).find((i) => Math.abs(i.x - x) <= rx && Math.abs(i.y - y) <= ry && toNum(i.text) != null);
  return it ? toNum(it.text) : null;
}

/** 资金小框读不出时的兜底：整屏 OCR 结果里找资金位置（右下 x 1160～1240、y 505～550）附近的纯数字。 */
function fundsFromItems(look) {
  const it = (look?.items || []).find((i) => i.x > 1160 && i.x < 1240 && i.y > 505 && i.y < 550 && toNum(i.text) != null);
  return it ? toNum(it.text) : null;
}

export function toNum(text) {
  const map = { T: '1', t: '1', Z: '7', z: '7', O: '0', o: '0', D: '0', l: '1', I: '1', i: '1', '|': '1', S: '5', s: '5', B: '8', g: '9', q: '9' };
  const t = String(text || '').replace(/[^\dTtZzOoDlIi|SsBgq]/g, '').replace(/./g, (c) => map[c] ?? c);
  return /^\d{1,3}$/.test(t) ? Number(t) : null;
}

/** 名字前面常多出一个被认成汉字的图标（「入陨星」「兆瑰盐」）：拿已知名字表去配，配不上就原样。 */
export function cleanName(text, known = []) {
  // 买不起的卡上盖着「无法购买」，OCR 会把它（或「法购买」）当名字读进来
  const t = String(text || '').replace(/无?法购买/g, '').replace(/[^一-龥A-Za-z0-9·]/g, '');
  if (!t) return '';
  let best = '';
  for (const n of known) if (n.length > best.length && t.includes(n)) best = n;
  return best || (t.length >= 3 ? t.slice(1) : t);
}

/**
 * 读休整期局面（商店展开时最全）。eyes 用来按区域 OCR；known 是已知名字表（干员 / 装备 / 盟约）。
 * 返回 { round, hp, funds, remain, refreshCost, upgradeCost, shop: [{ slot, name, cost, tags, empty }], alliances: [名字] }。
 */
export async function readRest(eyes, look, { known = [], shopOpen = true } = {}) {
  const lay = shopLayout(look);
  const nums = await eyes.readRegions(look.image, {
    round: NUM_REGIONS.round, hp: NUM_REGIONS.hp, funds: NUM_REGIONS.funds,
    remain: shopOpen ? NUM_REGIONS.remainOpen : NUM_REGIONS.remainClosed,
    ...(shopOpen ? {
      upgradeCost: [Math.round(lay.upgradeX) - 16, 518, 32, 26],   // 两位数（11、13）原来 20 宽会切掉一半 refreshCost: NUM_REGIONS.refreshCost,
      slotCost: lay.slots.map((x) => [x - 10, 520, 20, 24])
    } : {})
  }, { onlyRec: true });
  // 「剩余可放置角色:7」整句被全屏 OCR 读到时以它为准
  const remainLine = look.items.find((i) => /剩余可放置/.test(i.text));
  const remainFull = remainLine ? toNum(remainLine.text.split(/[:：]/).pop()) : null;
  const state = {
    // 细的「1」常被小框读丢（31→3、11→1、10→0）：都和整屏 OCR 在同一位置读到的比，取位数多的
    round: pickLonger(toNum(nums.round), numNear(look, 497, 33, 25, 14)),
    hp: pickLonger(await hpWidthFix(look.file, toNum(nums.hp)), numNear(look, 806, 33, 30, 14)),
    funds: pickLonger(toNum(nums.funds), fundsFromItems(look)),
    remain: remainFull ?? toNum(nums.remain),
    refreshCost: toNum(nums.refreshCost) ?? numNear(look, 1195, 432, 30, 20), upgradeCost: toNum(nums.upgradeCost) ?? (lay.upgradeX != null ? numNear(look, lay.upgradeX, 533, 30, 20) : null),
    shop: [],
    upgradeX: lay.upgradeX,
    alliances: look.items.filter((i) => i.y > 100 && i.y < 135 && i.x > 520 && i.x < 900).map((i) => cleanName(i.text, known) || i.text)
  };
  if (shopOpen) {
    // 卡位按现找的布局取（格数随调度中心等级变）
    const texts = await eyes.readRegions(look.image, {
      slotName: lay.slots.map((x) => [x - 78, 664, 156, 40]),
      slotTags: lay.slots.map((x) => [x - 78, 612, 156, 52])
    });
    for (let k = 0; k < lay.slots.length; k++) {
      const empty = look.items.some((i) => /NO\s*INFO/i.test(i.text) && Math.abs(i.x - lay.slots[k]) < 70);
      const name = empty ? '' : cleanName(texts.slotName[k], known);
      const tags = String(texts.slotTags[k] || '').match(/[一-龥]{2,5}/g) || [];
      state.shop.push({ slot: k + 1, x: lay.slots[k], name, cost: empty ? null : toNum(nums.slotCost[k]), tags: tags.map((t) => cleanName(t, known)), empty: empty || !name });
    }
  }
  return state;
}

/**
 * 整备区哪些位置有人（商店展开镜头）。每个人头顶有黑底的阶级角标，在人中心往左 23、y≈397；
 * 数这块 23x23 里的暗像素：有人 300～430，空位 0～22（2026-11-10 实测），阈值 150。
 * 位置是固定的：右边的人上场后，左边的人不会往右补。rgb 来自 tiles.js 的 decodeRgb。
 */
export function benchOccupied({ data, w }) {
  const out = [];
  for (let k = 0; k < BENCH_MAX; k++) {
    const cx = benchPos(k)[0] - 23;   // 角标在人中心左边一点（实测 892/811/730/649/568）
    const cy = 397;
    let dark = 0;
    for (let y = cy - 11; y <= cy + 11; y++) {
      for (let x = cx - 11; x <= cx + 11; x++) {
        const i = (y * w + x) * 3;
        if (data[i] < 70 && data[i + 1] < 70 && data[i + 2] < 70) dark++;
      }
    }
    out.push(dark > 150);
  }
  return out;
}
/** 按住干员时镜头会切到收起视角，整备区第 k 个位置在那个视角下的坐标（取消时拖回这里，别拖回原坐标——那里是棋盘格）。 */
export const benchHeldPos = (k) => [1040 - 95 * k, 600];

// ── 2026-11-10 第二轮校准：布局会变，改成从画面上现找 ──────────────────
// 商店卡片靠右对齐，最右一格中心固定 x=1014，格距 162；格数随调度中心等级变（LEVEL I 4 格、LEVEL II 5 格）。
// 升级卡紧挨在最左一格左边（中心 = 最左格 - 141）。所以找到「升级」两个字的位置就知道有几格。
export const SLOT_RIGHT = 1014;
export const SLOT_GAP = 162;
/** 从全屏 OCR 找商店布局：{ upgradeX, slots: [x...]（从左到右） }。找不到「升级」时按 5 格算。 */
export function shopLayout(look) {
  const up = look.items.find((i) => /^升级$|确认升级|^LEVE/.test(i.text.trim()) && i.y > 560 && i.y < 700 && i.x < 1080);
  const upgradeX = up ? up.x : null;
  let n = upgradeX != null ? Math.round((SLOT_RIGHT + 21 - upgradeX) / SLOT_GAP) : 5;
  n = Math.max(3, Math.min(6, n));
  const slots = Array.from({ length: n }, (_, j) => SLOT_RIGHT - SLOT_GAP * (n - 1 - j));
  return { upgradeX: upgradeX ?? slots[0] - 141, slots };
}

/**
 * 木板上站的人：沿 y≈397 那一排扫黑底阶级角标（23x23 里暗像素 > 150），找到几个就是几个人。
 * 地图 / 镜头不同时位置会偏（实测同一套 UI 下有 915/834… 和 955/875… 两种），所以不写死。
 * 返回人中心的 x（角标 x + 23），从右到左排。rgb 来自 tiles.js 的 decodeRgb。
 */
export function scanBench({ data, w }, { y = 397, x0 = 140, x1 = 1000 } = {}) {
  const dark = (cx) => {
    let n = 0;
    for (let yy = y - 11; yy <= y + 11; yy++) {
      for (let xx = cx - 11; xx <= cx + 11; xx++) {
        const i = (yy * w + xx) * 3;
        if (data[i] < 70 && data[i + 1] < 70 && data[i + 2] < 70) n++;
      }
    }
    return n;
  };
  const scores = [];
  for (let x = x0; x <= x1; x += 3) scores.push([x, dark(x)]);
  const peaks = [];
  for (const [x, s] of scores.sort((a, b) => b[1] - a[1])) {
    if (s <= 150) break;
    if (peaks.every((p) => Math.abs(p - x) >= 45)) peaks.push(x);
  }
  return peaks.map((x) => x + 23).sort((a, b) => b - a);
}

/**
 * 目标生命「14」里那个细「1」OCR 怎么框都认不出，只读出「4」。数一下亮字有多宽来补：
 * 实测一位数约 10 像素宽，「14」14 像素，「25」20 像素。读出一位数但字宽 ≥ 12，就当成十几。
 * （「21」这种个位是 1 的会被当成 12，少见，先不管。）
 */
export async function hpWidthFix(file, v) {
  if (v == null || v >= 10 || !file) return v;
  try {
    const { decodeRgb } = await import('./tiles.js');
    const { data, w } = await decodeRgb(file);
    const cols = [];
    for (let x = 790; x < 840; x++) {
      let n = 0;
      for (let y = 24; y < 42; y++) {
        const i = (y * w + x) * 3;
        if (data[i] > 150 && data[i + 1] > 150 && data[i + 2] > 150 && Math.abs(data[i] - data[i + 2]) < 40) n++;
      }
      if (n >= 2) cols.push(x);
    }
    const width = cols.length ? cols.at(-1) - cols[0] + 1 : 0;
    return width >= 12 ? 10 + v : v;
  } catch { return v; }
}

/**
 * 结算页：右下「返回主页」+「模拟中断」/「通过回合 N」。实测到目前为止输的局都写「模拟中断」，
 * 通关时写什么还没见过——有「返回主页」、有结算字样但没有「中断」就先当通关。
 * 返回 { result: 'win'|'lose', rounds, text } 或 null。
 */
export function readSettle(look) {
  const t = look.text.replace(/\s+/g, '');
  if (!/返回主页/.test(t) || !/模拟中断|通过回合|模拟完成|模拟成功|通关|胜利/.test(t)) return null;
  const m = t.match(/通过回合[^\d]{0,3}(\d{1,2})/) || t.match(/回合[^\d]{0,3}(\d{1,2})/);
  return { result: /中断|失败/.test(t) ? 'lose' : 'win', rounds: m ? Number(m[1]) : null, text: look.text.slice(0, 160) };
}

/**
 * 场上（棋盘）站的人：和木板一样扫黑底阶级角标，范围是棋盘区域（商店展开镜头 y 120～380）。
 * 返回人身体中心的估计位置（角标往右下偏 (25, 62)，第一张图实测：角标 (710,155) ↔ 人 (740,215)），从上到下、从左到右。
 */
// y0 从 120 调到 138：顶上一排盟约图标下沿的字（约 y 123）会被当成角标，真正站位的角标最高约 148
export function scanBoard({ data, w }, { y0 = 138, y1 = 370, x0 = 300, x1 = 1100 } = {}) {
  const darkAt = (cx, cy) => {
    let n = 0;
    for (let yy = cy - 11; yy <= cy + 11; yy++) {
      for (let xx = cx - 11; xx <= cx + 11; xx++) {
        const i = (yy * w + xx) * 3;
        if (data[i] < 70 && data[i + 1] < 70 && data[i + 2] < 70) n++;
      }
    }
    return n;
  };
  // 角标是「黑方块里有白字」：再要求中间有几个亮像素，避开阴影、深色箱子
  const hasWhite = (cx, cy) => {
    let n = 0;
    for (let yy = cy - 7; yy <= cy + 7; yy++) {
      for (let xx = cx - 7; xx <= cx + 7; xx++) {
        const i = (yy * w + xx) * 3;
        if (data[i] > 140 && data[i + 1] > 140 && data[i + 2] > 140 && Math.abs(data[i] - data[i + 2]) < 30) n++;
      }
    }
    return n >= 4;   // 罗马数字是浅灰色（实测约 160），不是纯白
  };
  const cand = [];
  for (let y = y0; y <= y1; y += 3) for (let x = x0; x <= x1; x += 3) { const s = darkAt(x, y); if (s > 300) cand.push([x, y, s]); }
  const peaks = [];
  for (const [x, y, s] of cand.sort((a, b) => b[2] - a[2])) {
    if (peaks.some((p) => Math.abs(p[0] - x) < 40 && Math.abs(p[1] - y) < 40)) continue;
    if (!hasWhite(x, y)) continue;
    peaks.push([x, y, s]);
  }
  return peaks.map(([x, y]) => ({ x: x + 25, y: y + 62 })).sort((a, b) => (Math.abs(a.y - b.y) > 30 ? a.y - b.y : a.x - b.x));
}

/**
 * 联机休整期右上角的「COUNTDOWN」倒计时：七段数码管字体，OCR 读不了，按像素解。
 * 数字右对齐（实测两位数：十位 x 1133～1158、个位 x 1165～1190；三位数百位在 1101～1126；y 25～71），青色笔画（G>150、B>120、R<140）。
 * 每位取 7 段各一个点，亮的组合查表。读不出返回 null（单人没有这个倒计时）。
 */
const SEG = { a: [0.5, 0.05], b: [0.9, 0.27], c: [0.9, 0.73], d: [0.5, 0.95], e: [0.1, 0.73], f: [0.1, 0.27], g: [0.5, 0.5] };
const DIGITS = { abcdef: 0, bc: 1, abdeg: 2, abcdg: 3, bcfg: 4, acdfg: 5, acdefg: 6, abc: 7, abcdefg: 8, abcdfg: 9 };
export function readCountdown({ data, w }, { x0 = 1095, x1 = 1195, y0 = 25, y1 = 71 } = {}) {
  const on = (x, y) => { const i = (y * w + x) * 3; return data[i + 1] > 150 && data[i + 2] > 120 && data[i] < 140; };
  // 联机后半段休整超过 99 秒，会变成三位数（百位格在 x 1101～1126）。不按固定格子读：
  // 先按列投影找出一个个数字的笔画块（右边 x≥1198 的青色刻度条不算），窄块（宽 < 14）就是「1」（只亮右边两竖），
  // 宽块按它自己的外框取 7 段。
  const cols = [];
  for (let x = x0; x <= x1; x++) { let n = 0; for (let y = y0; y <= y1; y++) if (on(x, y)) n++; cols.push(n); }
  const blobs = [];
  for (let i = 0; i < cols.length; i++) {
    if (cols[i] < 2) continue;
    const last = blobs.at(-1);
    if (last && i - last[1] <= 3) last[1] = i; else blobs.push([i, i]);
  }
  let out = '';
  for (const [s0, s1] of blobs) {
    const bx0 = x0 + s0; const bx1 = x0 + s1;
    if (bx1 - bx0 < 3) continue;   // 噪点
    if (bx1 - bx0 < 14) { out += '1'; continue; }
    let lit = '';
    for (const [sg, [fx, fy]] of Object.entries(SEG)) {
      const cx = Math.round(bx0 + (bx1 - bx0) * fx); const cy = Math.round(y0 + (y1 - y0) * fy);
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (on(cx + dx, cy + dy)) n++;
      if (n >= 4) lit += sg;
    }
    const d = DIGITS[lit];
    if (d == null) return null;
    out += d;
  }
  return out === '' || out.length > 3 ? null : Number(out);
}
