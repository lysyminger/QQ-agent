// plugins/ark-garrison/turn.js
//
// 休整期「一回合问一次」：程序读好局面 → 模型只回一张操作清单 → 程序逐条执行、逐条核对。
//
// 所有和游戏打交道的事都走 io（见 makeRealIo）：真机时是模拟器（moves.js / screen.js），
// 本地模拟（sim.js）时是按规则写的假游戏。同一套回合逻辑两边都跑，bug 在本地就能抓出来。
//
// 每个休整期：
//   1. 展开商店，读回合 / 生命 / 资金 / 剩余可放置 / 商店；扫木板和棋盘上站的人，不认识的认一下名字；
//   2. 程序先做「不用想」的事：商店里出现手上已有两个的同名卡、买得起 → 直接买（三合一出精锐，送一张高一阶的三选一）；
//   3. 整备区有人：按住一个人拿到「能放的格子」，编号画在图上；
//   4. 把局面文字 + 图交给模型，要一张操作清单：
//        buy(卡位) / sell(人：木板或场上) / withdraw(场上的人撤回木板) / refresh / upgrade / deploy(人, 格子, 朝向) / ready
//   5. 逐条执行；失败或刷新改变了局面：带着新局面再问（每回合最多 3 次）；
//   6. 开战前兜底：空着的上场名额自动补人（木板有人就放，没人就买最便宜的干员）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readRest, scanBench, scanBoard, readCountdown } from './screen.js';
import { decodeRgb, findMarkers } from './tiles.js';
import * as M from './moves.js';
import { relevantLines } from './agent.js';
import { loadPool, loadEquipment, MONEY_ITEMS } from './sim.js';

// 装备名（02-盟约-策略-装备）：装备买来也站在木板上、头顶也有阶级角标，要和干员分开
let EQUIP = null;
export const isEquip = (name) => { EQUIP ||= new Set(loadEquipment().map((e) => e.name)); return EQUIP.has(name); };

// 名字 → 阶（从 03-干员特质表 读），换人时比强弱用
let TIER = null;
export const tierOf = (name) => { TIER ||= new Map(loadPool().map((p) => [p.name, p.tier])); return TIER.get(name) || 0; };
// 按真实属性估一个人的战力（06-干员数据.json，游戏数据清洗来的）：输出 × 能扛 开方，再按阶加成——和本地模拟器同一个口径。
// 换人只看阶会把能挡怪的重装换成医疗、把盟约人数拆掉；本地模拟里只看阶的换人反而撑得更短。
let STATS = null;
export const statsOf = (name) => { if (!STATS) { try { STATS = JSON.parse(fs.readFileSync(path.join(KB, '06-干员数据.json'), 'utf8')); } catch { STATS = {}; } } return STATS[name] || null; };
export const powerOf = (name) => {
  const d = statsOf(name); const t = tierOf(name) || 1;
  const base = d?.atk && d?.hp ? Math.sqrt((d.atk / (d.interval || 1)) * d.hp * (1 + (d.def || 0) / 600)) / 900 : t ** 1.6;
  return base * (1 + 0.35 * (t - 1));
};
const isBlocker = (name) => (statsOf(name)?.block ?? 0) >= 2;
// 这个人身上哪些盟约是本局路线里写到的（路线文字里出现的盟约名）
let TAGS = null;
export const routeTagsOf = (name, extra = '') => { TAGS ||= new Map(loadPool().map((p) => [p.name, p.tags || []])); return (TAGS.get(name) || []).filter((t) => extra.includes(t)); };
// 换人比的「留在场上值多少」：真实战力；精锐（三合一过的）×2.2；每个本局路线盟约 +30%（拆了盟约人数掉档，比单看属性亏）
export const swapValue = (name, { extra = '', elites } = {}) => powerOf(name) * (elites?.has(name) ? 2.2 : 1) * (1 + 0.3 * routeTagsOf(name, extra).length);
// 自动放人时站前排还是后排：重装 / 近卫 / 先锋挡怪站前排（靠近敌人来的右边），其余（狙击、术师、医疗、辅助、特种）站后排
let CLS = null;
// 医疗单独一种：紧挨着已经上场的人（挡怪的在集合点附近），奶得到前排
export const spotFor = (name) => { CLS ||= new Map(loadPool().map((p) => [p.name, p.cls])); const c = CLS.get(name) || '近卫'; return /重装|近卫|先锋/.test(c) ? 'auto-front' : /医疗/.test(c) ? 'auto-heal' : 'auto-back'; };

const KB = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'knowledge');
const readKb = (f) => { try { return fs.readFileSync(path.join(KB, f), 'utf8'); } catch { return ''; } };
const tail = (f, n) => readKb(f).split('\n').filter((l) => l.startsWith('- ')).slice(-n).join('\n');

export const OPS = ['buy', 'sell', 'withdraw', 'refresh', 'freeze', 'upgrade', 'deploy', 'equip', 'ready'];
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    think: { type: 'string' },
    memo: { type: 'string' },
    say: { type: 'string' },
    ops: {
      type: 'array',
      maxItems: 14,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', enum: OPS },
          slot: { type: 'integer' },
          unit: { type: 'string' },
          tile: { type: 'integer' },
          dir: { type: 'string', enum: ['right', 'left', 'up', 'down', 'none'] },
          to: { type: 'string' }
        },
        required: ['op', 'slot', 'unit', 'tile', 'dir', 'to']
      }
    }
  },
  required: ['think', 'memo', 'say', 'ops']
};

// 留在整备区（木板）上本身就有效果的干员，自动补位时不拉上场（knowledge/03 里标了「在整备区也生效」的）
export const STAY_ON_BENCH = /夏栎|星源|复奏|淬羽赫默|焰尾/;

// ── 真机 io ────────────────────────────────────────────────────────────

/** 在格子中心画编号（ffmpeg drawtext），给模型看「几号格」。 */
function drawTileNumbers(src, tiles) {
  const out = src.replace(/\.png$/, '.tiles.png');
  const font = 'C\\:/Windows/Fonts/arial.ttf';
  const vf = tiles.map((t, i) => `drawtext=fontfile='${font}':text='${i}':x=${t.x - 9}:y=${t.y - 11}:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=3`).join(',');
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', vf || 'null', out], { windowsHide: true, timeout: 15000 }, (err) => resolve(err ? src : out));
  });
}

/** 左上详情面板里的名字（按住或点开一个人时出现，干员名在 (18～120, 185～210) 一带）。 */
async function panelName(eyes, file, known) {
  const buf = fs.readFileSync(file);
  const image = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const r = await eyes.readRegions(image, { name: [8, 178, 150, 40] });
  const t = String(r.name || '').replace(/[^一-龥A-Za-z0-9·]/g, '');
  return known.find((n) => n.length >= 2 && t.includes(n)) || t;
}

/** 真机的 io：模拟器上的截图、识别和操作。 */
export function makeRealIo(eyes, { known = [] } = {}) {
  return {
    open: () => M.ensureShop(eyes, true),
    read: (look) => readRest(eyes, look, { known }),
    scan: async (look) => { const rgb = await decodeRgb(look.file); return { bench: scanBench(rgb), board: scanBoard(rgb) }; },
    // 红框（出生点）/ 蓝框（守点）：归队算集合点用
    markers: async (look) => { try { return findMarkers(await decodeRgb(look.file)); } catch { return null; } },
    look: () => eyes.look(),
    // 联机休整期右上角的倒计时（秒）；单人没有，返回 null
    countdown: async (look) => { try { return readCountdown(await decodeRgb(look.file)); } catch { return null; } },
    pickUp: (x, y) => M.pickUp(eyes, x, y),
    cancel: (from) => eyes.cancelHold(...from).then(() => eyes.sleep(400)),
    nameOf: (file) => panelName(eyes, file, known),
    // 场上的人：点一下看左上详情面板的名字，再点空白处关掉（不按住，免得挪动它）
    nameAt: async (x, y) => {
      await eyes.tap(x, y);
      await eyes.sleep(700);
      const l = await eyes.look();
      const n = await panelName(eyes, l.file, known);
      await eyes.tap(1050, 380);
      await eyes.sleep(500);
      await M.closeUnitMenu(eyes);   // 镜头拉近后点的不一定是空白，菜单没关就按返回键关
      return n;
    },
    tilesImage: (file, tiles) => drawTileNumbers(file, tiles),
    buy: (slot) => M.buy(eyes, slot, { known }),
    sell: (x) => M.sell(eyes, x),
    sellBoard: (at) => M.sellBoard(eyes, at),
    withdraw: (at) => M.withdraw(eyes, at),
    // name：要放的人，自动站位时按他的攻击范围挑格子
    deploy: (x, target, dir, name = '') => M.deploy(eyes, x, target, dir, { range: statsOf(name)?.range?.cells || null }),
    // 装备：按住木板上 x 处的装备，拖到场上第 index 个人身上（场上的人按从上到下、从左到右排，共 count 个）
    equip: (x, at, where) => M.equip(eyes, x, at, where),
    refresh: () => M.refresh(eyes),
    freeze: () => M.freeze(eyes),
    upgrade: () => M.upgrade(eyes),
    ready: () => M.ready(eyes)
  };
}

// ── 给模型看的局面 ────────────────────────────────────────────────────

/** 同名干员数（木板 + 场上），给「凑对子 / 三合一」用。 */
export function ownedCounts(bench, board) {
  const c = new Map();
  for (const u of [...bench, ...board]) if (u.name) c.set(u.name, (c.get(u.name) || 0) + 1);
  return c;
}

export function describeState(st, bench, board) {
  const counts = ownedCounts(bench, board);
  const shop = st.shop.map((c) => {
    if (c.empty) return `${c.slot}号：空`;
    const have = counts.get(c.name) || 0;
    return `${c.slot}号：${c.name}（${c.cost ?? '?'}块${c.tags.length ? `，${c.tags.join('/')}` : '，装备'}${have ? `，已有 ${have} 个${have >= 2 ? '，买了就三合一' : ''}` : ''}）`;
  }).join('；');
  const list = (arr) => arr.map((u) => u.name || '没认出').join('、') || '空';
  const pairs = [...counts].filter(([k, n]) => n >= 2 && !isEquip(k)).map(([k, n]) => `${k}×${n}`).join('、');
  const units = bench.filter((b) => !isEquip(b.name));
  const items = bench.filter((b) => isEquip(b.name));
  return [
    `回合 ${st.round ?? '?'}，目标生命 ${st.hp ?? '?'}，资金 ${st.funds ?? '?'}，剩余可放置角色 ${st.remain ?? '?'}`,
    `升级调度中心要 ${st.upgradeCost ?? '?'} 块，刷新要 ${st.refreshCost ?? '?'} 块`,
    `商店：${shop}`,
    `场上（在打，按从上到下、从左到右）：${list(board)}`,
    `整备区（木板上，不参与作战）：${list(units)}`,
    items.length ? `木板上的装备（还没戴）：${list(items)}` : '',
    pairs ? `对子：${pairs}（再来一个就合精锐）` : '',
    st.alliances.length ? `已有盟约：${st.alliances.join('、')}` : ''
  ].filter(Boolean).join('\n');
}

export function buildPrompt({ st, bench, board, tiles, memo, extra, notes }) {
  const names = [...st.shop.map((c) => c.name), ...bench.map((b) => b.name), ...board.map((b) => b.name), ...st.alliances].filter(Boolean).join(' ');
  return [
    '你在替主人玩《明日方舟》「卫戍协议」，现在是休整期。程序已经读好了局面，你只需要给一张操作清单，程序会按顺序执行并核对。目标是做个高手：每回合不漏怪、凑核心盟约、合精锐、把钱花在刀刃上。',
    extra ? `【这局的目标】${extra}` : '',
    `【现在的局面】\n${describeState(st, bench, board)}`,
    tiles.length ? `【能放人的格子】图上标了编号 0～${tiles.length - 1}（敌人从红框那边来）。` : '【能放人的格子】这次没有格子图（整备区没人或场上已满）。',
    `【上回合留的备忘】${memo || '（无）'}`,
    notes.length ? `【这回合已经做了 / 出的问题】\n${notes.join('\n')}` : '',
    `【规则和原则】\n${readKb('00-速查.md')}`,
    `【高手打法（分阶段）】\n${readKb('07-高手打法.md').replace(/^#.*\n+来源：.*\n.*\n/m, '')}`,
    relevantLines(names).length ? `【相关干员 / 盟约资料】\n${relevantLines(names).join('\n')}` : '',
    tail('lessons.md', 30) ? `【之前复盘的经验】\n${tail('lessons.md', 30)}` : '',
    '【操作清单怎么写】ops 按顺序执行，可用的操作：',
    '- buy：买商店第 slot 张（已经写「空」的卡位别买）。新买的人可以在同一张清单里接着 deploy（写它的名字），新买的装备可以接着 equip。装备值得买：攻击类（维式重锤、阿戈尔重刃、天马之枪…）给主输出，生命 / 阻挡类给前排；「人事部文档」让上场上限变 9，见到就买；「盟约之币」「见钱眼开玩偶」「精打细算玩偶」这类装上就换钱的，程序会自动用掉。',
    '- sell：卖掉名字是 unit 的人（木板上的或场上的都行，+1 资金）。场上满了、木板上有更好的人时，先 sell 场上最弱 / 不在路线里的那个，再 deploy 好的上去（同一张清单里写）。路线关键干员、对子别卖。',
    '- withdraw：把场上名字是 unit 的人撤回木板（不卖，留着凑对子 / 以后再上）。',
    '- refresh：刷新商店（花刷新钱）。刷新后程序会再问你一次，所以 refresh 之后别再写 buy。',
    '- upgrade：升级调度中心（商店出高阶卡、格数变多），花「升级要 N 块」那么多钱，买东西前先算好钱够不够。升级费用每回合自动 -1：降到 2 块以内程序会自动升；更贵时先保证场上人够、不漏怪，有余钱再升（社区说「三回合升本」，也说「没对子升本死路一条」——升级抢了买人的钱，场上空着更亏）。',
    '- deploy：把木板上名字是 unit 的人放到 tile 号格子，dir 是朝向（敌人从哪边来就朝哪边）。没有格子图、或者无所谓放哪时 tile 填 -1，程序自动找一个能放的格子（靠前排）。部署不花钱。一张清单写完买和上场，别分几次问。',
    '- equip：把木板上名字是 unit 的装备戴到场上名字是 to 的人身上（每人最多 2 件，戴上不能卸；两件同名初始装备自动合成进阶）。to 留空 = 程序挑场上第一个人（换钱类装备这样写就行）。',
    '- ready：准备就绪，开始作战。写在最后。程序开战前会自动把空着的上场名额补满。',
    '用不到的字段：slot 和 tile 填 -1，unit 和 to 填空字符串，dir 填 none。',
    'think 一句话说这回合打算（不超过 60 字）；memo 留给下回合的自己（流派、在凑什么，不超过 80 字）；say 只有值得跟群友说的事才写，平常空字符串。',
    '钱的用法：资金离开休整期会清空。优先级：保命（场上人够、够强）> 升级（便宜时）> 三合一 / 凑核心盟约人数 > 刷新找路线牌。场上满了、没有想买的、手里还有钱时 refresh 找牌，别留着钱就 ready。',
    '有【本局路线】时照路线买人和升级；连续几回合商店都不出路线的牌，就按路线写的换路线办法换，并在 memo 里写明「改路线：……」。'
  ].filter(Boolean).join('\n\n');
}

/** 校验一条操作，返回错误原因或空字符串。 */
export function checkOp(o, { tiles, bench, board = [], shopSize = 5, failed = new Set() }) {
  if (failed.has(o?.op)) return `这回合 ${o.op} 已经失败过，换别的做法`;
  const onBench = (n) => bench.includes(n);
  const onBoard = (n) => board.includes(n);
  switch (o?.op) {
    case 'buy': return o.slot >= 1 && o.slot <= shopSize ? '' : `卡位 ${o.slot} 不在 1～${shopSize}`;
    case 'sell': return onBench(o.unit) || onBoard(o.unit) ? '' : `木板和场上都没有「${o.unit}」`;
    case 'withdraw': return onBoard(o.unit) ? '' : `场上没有「${o.unit}」`;
    case 'deploy':
      if (!onBench(o.unit)) return `整备区没有「${o.unit}」`;
      if (!(o.tile === -1 || (o.tile >= 0 && o.tile < tiles.length))) return `没有 ${o.tile} 号格子`;
      return ['right', 'left', 'up', 'down'].includes(o.dir) ? '' : '没给朝向';
    case 'equip':
      if (!onBench(o.unit) || !isEquip(o.unit)) return `木板上没有装备「${o.unit}」`;
      if (!board.length) return '场上没人，装备戴不上';
      return !o.to || onBoard(o.to) ? '' : `场上没有「${o.to}」`;
    case 'refresh': case 'upgrade': case 'ready': case 'freeze': return '';
    default: return `不认识的操作 ${o?.op}`;
  }
}

/**
 * 打一个休整期。
 * deps: { eyes 或 io, ask, known(名字表), memo, extra, log, report,
 *         bench([{x,name}]) / board([{x,y,name}])（跨回合记着谁站在哪）, effort, maxAsks }
 * 返回 { ok, readied, memo, asks, notes, state, why }。
 */
export async function playRest({ eyes, io = null, ask, known = [], memo = '', extra = '', log = () => {}, report = async () => {}, bench = [], board = [], effort = 'medium', maxAsks = 3, swaps = true, planner = null, mem = {} }) {
  io ||= makeRealIo(eyes, { known });
  // 记这回合有没有做过「真操作」：联机连着几回合只点「准备就绪」，游戏会弹「当前多回合无操作，即将离开模拟」，算违规退出
  let acted = false;
  {
    const raw = io;
    const wrap = (k) => async (...a) => { const r = await raw[k](...a); if (r?.ok) { acted = true; mem.actedRound = mem.maxRound; } return r; };
    io = { ...raw };
    for (const k of ['buy', 'sell', 'sellBoard', 'withdraw', 'deploy', 'equip', 'refresh', 'freeze', 'upgrade']) if (raw[k]) io[k] = wrap(k);
  }
  if (planner) maxAsks = Math.max(maxAsks, 5);   // 规则规划不花钱：刷新后多规划几次
  const notes = [];
  let state = null;           // 最后一次读到的局面，记进 runs 给复盘用
  const failed = new Set();   // 这回合失败过的操作类型：不让模型再撞同一堵墙
  let asks = 0;
  const note = (line) => { notes.push(line); log(line); };
  // 联机有倒计时（实测约 45 秒一回合）：记下截止时间，来不及就少问、先保证人上场。单人没有倒计时，不限时
  let deadline = null;
  const left = () => (deadline == null ? Infinity : (deadline - Date.now()) / 1000);
  const timeCheck = async (look) => {
    const cd = io.countdown ? await io.countdown(look) : null;
    if (cd != null) deadline = Date.now() + cd * 1000;
    return cd;
  };

  // 按这一屏扫到的位置重新对一遍谁在哪（人不会自己挪；位置变了就当不认识，重新认）
  const sync = async (look) => {
    const s = await io.scan(look);
    bench.splice(0, bench.length, ...s.bench.map((x) => ({ x, name: bench.find((b) => Math.abs(b.x - x) < 25)?.name || '' })));
    // 场上站的只会是干员：名字是装备名（点开详情时读错了）就当没认出来，下次重认
    board.splice(0, board.length, ...s.board.map((p) => { const old = board.find((b) => Math.hypot(b.x - p.x, b.y - p.y) < 30); const n = old?.name || ''; return { ...p, name: isEquip(n) ? '' : n, equips: old?.equips || 0 }; }));
  };
  const names = (arr) => arr.map((b) => b.name).filter(Boolean);
  const findBench = (n) => bench.find((b) => b.name === n);
  const findBoard = (n) => board.find((b) => b.name === n);

  // 买一张：买完重新扫一遍，木板上多出来的那个就是它
  const buyOne = async (slot, why = '') => {
    const before = bench.map((b) => b.x);
    const had = ownedCounts(bench, board);
    const r = await io.buy(slot);
    // 手上已有两个同名的又买到第三个：三合一成精锐，记下来（精锐的人换人时不卖、算两倍多战力）
    if (r.ok && r.name && (had.get(r.name) || 0) >= 2) (mem.elites ||= new Set()).add(r.name);
    if (r.ok) {
      const l = await io.look();
      await sync(l);
      const fresh = bench.find((b) => !b.name && !before.some((x) => Math.abs(x - b.x) < 25));
      if (fresh) fresh.name = r.name || '';
    }
    if (why) note(`- ${why}：买 ${r.name || `${slot} 号`}${r.ok ? '成功' : `失败（${r.why}）`}`);
    return r;
  };

  // 程序直接做：手上已有两个同名的，商店又出了、买得起 → 买（三合一）
  const autoMerge = async (st) => {
    const counts = ownedCounts(bench, board);
    let funds = st.funds;
    for (const c of st.shop) {
      if (c.empty || !c.name || !c.tags.length) continue;
      if ((counts.get(c.name) || 0) < 2) continue;
      if (c.cost != null && funds != null && c.cost > funds) continue;
      // 木板 10 格满了买不进来：先卖掉木板上最弱、又不成对的一个腾位置
      if (bench.length >= 10) {
        const junk = bench.filter((b) => (counts.get(b.name) || 0) < 2 && !STAY_ON_BENCH.test(b.name || '') && tierOf(b.name) > 0).sort((a, b) => tierOf(a.name) - tierOf(b.name))[0];
        if (!junk) continue;
        const s = await io.sell(junk.x);
        note(`- 木板满了，卖掉 ${junk.name || '一个人'} 腾位置${s.ok ? '成功' : `失败（${s.why}）`}`);
        if (!s.ok) continue;
        bench.splice(bench.indexOf(junk), 1);
        if (funds != null) funds += 1;
      }
      const r = await buyOne(c.slot, '自动三合一');
      if (!r.ok) return;
      funds = r.funds ?? (funds != null && c.cost != null ? funds - c.cost : funds);
      counts.set(c.name, 0);
    }
  };

  // 开战前兜底：空着的上场名额补满（木板有人就放，没人就买最便宜的干员）
  const autoFill = async () => {
    const skip = new Set();   // 放不上去的木板位置（多半是误认、装备或放不了的东西）：跳过它，接着放别人 / 买人补位
    for (let i = 0; i < 10 && left() > 4; i++) {
      const sh = await io.open();
      if (!sh.ok) return;
      const st = await io.read(sh.look);
      if (!(st.remain > 0)) return;
      await sync(sh.look);
      const b = bench.find((x) => !skip.has(Math.round(x.x / 30)) && !STAY_ON_BENCH.test(x.name || '') && !isEquip(x.name));
      if (!b) {
        // 资金读不出就当够（买不起游戏会拒绝，buyOne 会核对）
        const card = st.shop
          .filter((c) => !c.empty && c.cost != null && c.cost <= (st.funds ?? 99) && c.tags.length)   // 有盟约标签的才是干员
          .sort((x, y) => x.cost - y.cost)[0];
        if (!card) return;
        const r = await buyOne(card.slot, '自动补位');
        if (!r.ok) return;
        continue;
      }
      const r = await io.deploy(b.x, spotFor(b.name), 'right', b.name);
      note(`- 自动补位：${b.name || '木板上的人'} 上场${r.ok ? '成功' : `失败（${r.why}）`}`);
      if (!r.ok) { skip.add(Math.round(b.x / 30)); continue; }
      bench.splice(bench.indexOf(b), 1);
    }
  };

  // 开战前兜底二：场上满了、木板上有比场上最弱的人更高阶的 → 卖掉最弱的、换强的上去（每回合最多 3 次）。
  // 不卖有对子的（留着合精锐），木板上有整备区效果的不动。本地模拟里不换人的话，场上站满后战力就不再涨了。
  const autoSwap = async () => {
    if (!swaps || left() < 15) return;
    const skip = new Set();   // 这回合换不动的场上位置（卖 / 撤失败过的），不再试，换下一个比
    const spot = (u) => `${Math.round(u.x / 30)},${Math.round(u.y / 30)}`;
    for (let i = 0; i < 4 && left() > 10; i++) {
      const sh = await io.open();
      if (!sh.ok) return;
      const st = await io.read(sh.look);
      if (st.remain > 0) return;
      await sync(sh.look);
      const counts = ownedCounts(bench, board);
      // 比的是「留在场上值多少」：真实战力 × 精锐 × 本局路线盟约（swapValue）。木板上最值的 vs 场上最不值的。
      // 不动的：有对子的（留着合精锐）、精锐、场上只剩这两个能挡怪的（换上来的也能挡就可以换）
      const blockers = board.filter((u) => isBlocker(u.name)).length;
      const val = (n) => swapValue(n, { extra, elites: mem.elites });
      const cand = bench.filter((b) => b.name && !STAY_ON_BENCH.test(b.name) && !isEquip(b.name)).sort((a, b) => val(b.name) - val(a.name))[0];
      const weak = board.filter((u) => tierOf(u.name) > 0 && !skip.has(spot(u)) && (counts.get(u.name) || 0) < 2 && !mem.elites?.has(u.name)
        && !(isBlocker(u.name) && blockers <= 2 && !isBlocker(cand?.name)))
        .sort((a, b) => val(a.name) - val(b.name))[0];
      if (!cand || !weak || val(cand.name) < val(weak.name) * (mem.lowHp ? 1.1 : 1.25)) return;   // 拼命模式（planner 设的 mem.lowHp）强一成就换
      // 撤下还是卖：木板有空位、换下来的还有用（本局路线盟约里的，或 3 阶以上、以后凑对子）→ 撤回木板留着；否则卖掉换钱
      const keep = bench.length <= 8 && !!io.withdraw && (routeTagsOf(weak.name, extra).length > 0 || tierOf(weak.name) >= 3);
      const s = keep ? await io.withdraw(weak) : await io.sellBoard(weak);
      note(`- 自动换人：${keep ? '撤下' : '卖掉'}场上 ${weak.name}（${tierOf(weak.name)} 阶）${s.ok ? '成功' : `失败（${s.why}）`}`);
      if (!s.ok) { skip.add(spot(weak)); continue; }
      board.splice(board.indexOf(weak), 1);
      if (keep) { const l = await io.look(); await sync(l); const fresh = bench.find((b) => !b.name); if (fresh) fresh.name = weak.name; }
      const c2 = findBench(cand.name) || cand;
      const d = await io.deploy(c2.x, spotFor(cand.name), 'right', cand.name);
      note(`- 自动换人：${cand.name}（${tierOf(cand.name)} 阶）上场${d.ok ? '成功' : `失败（${d.why}）`}`);
      if (!d.ok) return;
      bench.splice(bench.indexOf(c2), 1);
      if (d.at) board.push({ x: d.at.x, y: d.at.y, name: cand.name });
    }
  };

  // 戴装备：场上的人按从上到下、从左到右排，告诉 io 是第几个（按住装备时镜头会变，io 在按住的截图里按同样顺序找人）
  const equipTo = async (item, target) => {
    const order = [...board].sort((a, b) => (Math.abs(a.y - b.y) > 30 ? a.y - b.y : a.x - b.x));
    // 没指定给谁：给戴得最少的人（每人最多 2 件），同样少就给阶高的
    const u = target || [...order].filter((x) => (x.equips || 0) < 2).sort((a, b) => (a.equips || 0) - (b.equips || 0) || tierOf(b.name) - tierOf(a.name))[0];
    if (!u) return { ok: false, why: '场上的人都戴满 2 件了' };
    const r = await io.equip(item.x, u, { index: order.indexOf(u), count: order.length });
    if (r.ok) { bench.splice(bench.indexOf(item), 1); if (!MONEY_ITEMS.test(item.name || '')) u.equips = (u.equips || 0) + 1; }
    return r;
  };
  // 程序直接做：三合一之后商店里临时出现的免费（0 块）高一阶干员，三选一、只能拿一张、不拿就没了 → 拿和现有盟约 / 路线最搭的
  const autoFree = async (st) => {
    const free = st.shop.filter((c) => !c.empty && c.cost === 0 && c.tags.length);
    if (!free.length) return;
    const have = new Set([...bench, ...board].flatMap((u) => loadPool().find((p) => p.name === u.name)?.tags || []));
    const pick = free.sort((a, b) => b.tags.filter((t) => have.has(t) || extra.includes(t)).length - a.tags.filter((t) => have.has(t) || extra.includes(t)).length)[0];
    await buyOne(pick.slot, '三合一送的免费三选一');
  };
  // 程序直接做：装上就换钱的（盟约之币、见钱眼开玩偶、精打细算玩偶…）一拿到就用掉
  const autoMoneyItems = async () => {
    for (const item of bench.filter((b) => MONEY_ITEMS.test(b.name || ''))) {
      if (!board.length) return;
      const r = await equipTo(item, null);
      note(`- 自动用掉 ${item.name}${r.ok ? '成功' : `失败（${r.why}）`}`);
      if (!r.ok) return;
    }
  };

  // 开战前兜底三：木板堵了就清。场上满了、木板上人 ≥6 → 卖掉不成对、不是路线关键干员、阶也不比场上最弱高的，留 4 个左右。
  // 木板 10 格满了连新卡都买不进来（旧版实测就这样堵死过）。卖一个 +1 资金。整备区有效果的（夏栎等）不卖。
  const autoClean = async () => {
    if (left() < 12) return;
    const sh = await io.open();
    if (!sh.ok) return;
    const st = await io.read(sh.look);
    if (st.remain > 0) return;
    await sync(sh.look);
    const counts = ownedCounts(bench, board);
    const units = bench.filter((b) => b.name && !isEquip(b.name));
    if (units.length < 6) return;
    const floor = Math.min(...board.map((u) => tierOf(u.name) || 1), 6);
    const junk = units
      .filter((b) => (counts.get(b.name) || 0) < 2 && !STAY_ON_BENCH.test(b.name) && !extra.includes(b.name) && tierOf(b.name) > 0 && tierOf(b.name) <= floor)   // tier 0 = 召唤物 / 认不出的，不卖
      .sort((a, b) => tierOf(a.name) - tierOf(b.name))
      .slice(0, units.length - 4);
    for (const j of junk) {
      if (left() < 8) return;
      const r = await io.sell(j.x);
      note(`- 木板堵了，卖掉 ${j.name}（${tierOf(j.name)} 阶，不成对、不在路线里）${r.ok ? '成功' : `失败（${r.why}）`}`);
      if (!r.ok) return;
      bench.splice(bench.indexOf(j), 1);
    }
  };
  // 开战前兜底四：木板上还没戴的装备（换钱类之外）给场上戴得最少、阶最高的人戴上，别占着木板
  const autoEquip = async () => {
    for (const item of bench.filter((b) => isEquip(b.name || '') && !MONEY_ITEMS.test(b.name))) {
      if (left() < 10 || !board.length) return;
      const r = await equipTo(item, null);
      note(`- 自动戴装备：${item.name}${r.ok ? '成功' : `失败（${r.why}）`}`);
      if (!r.ok) return;
    }
  };

  // 这回合一个真操作都没做（也没在之前的几次 playRest 里做过）：开战前补一个，免得被判挂机。
  // 先用不花钱的：把场上最弱的人撤回木板再放回去；不行再花 1 块刷新一次商店。
  const keepAlive = async () => {
    if (acted || (mem.maxRound != null && mem.actedRound === mem.maxRound) || left() < 8) return;
    const sh = await io.open();
    if (!sh.ok) return;
    const st = await io.read(sh.look);
    await sync(sh.look);
    const u = board.filter((b) => tierOf(b.name) > 0).sort((a, b) => powerOf(a.name) - powerOf(b.name))[0];
    if (u && bench.length < 10) {
      const w = await io.withdraw(u);
      note(`- 这回合还没动过（连着几回合不动会被判挂机）：撤下 ${u.name} 再放回去${w.ok ? '' : `，撤失败（${w.why}）`}`);
      if (w.ok) {
        board.splice(board.indexOf(u), 1);
        const l = await io.look(); await sync(l);
        const b = bench.find((x) => !x.name) || bench.at(-1);
        if (b) {
          b.name = u.name;
          const d = await io.deploy(b.x, spotFor(u.name), 'right', u.name);
          if (!d.ok) { note(`- 放回去失败（${d.why}），开战前再补位`); await autoFill(); }
          else bench.splice(bench.indexOf(b), 1);
        }
        return;
      }
    }
    if (st.funds != null && st.funds >= (st.refreshCost ?? 1)) {
      const r = await io.refresh();
      note(`- 这回合还没动过：刷新一次商店${r.ok ? '' : `失败（${r.why}）`}`);
    }
  };

  // 归队：之前按老规则放的人（近战贴出生点、远程丢角落）散在两头。开战前时间够就把离集合点最远的撤下、按新站位放回去，每回合最多 2 个。
  // 集合点 = 守点（蓝框）往出生点（红框）方向三成处，在没按住人的画面上算（蓝框没被详情面板挡住）。
  const regroup = async () => {
    if (!io.markers || left() < 40) return;
    for (let k = 0; k < 2 && left() > 30; k++) {
      const sh = await io.open();
      if (!sh.ok) return;
      const mk = await io.markers(sh.look);
      if (!mk?.spawn || !mk?.target) return;
      await sync(sh.look);
      const anchor = { x: mk.target.x + 0.3 * (mk.spawn.x - mk.target.x), y: mk.target.y + 0.3 * (mk.spawn.y - mk.target.y) };
      const far = board.filter((u) => tierOf(u.name) > 0 && !(mem.regrouped || []).includes(u.name))
        .map((u) => ({ u, d: Math.hypot(u.x - anchor.x, u.y - anchor.y) })).filter((x) => x.d > 230)   // 门槛比站位规则给远程挑的格子（约 190 像素）远一些，免得刚放好的又被挪.sort((a, b) => b.d - a.d)[0];
      if (!far || bench.length >= 10) return;
      const u = far.u;
      const w = await io.withdraw(u);
      if (!w.ok) { note(`- 归队：撤 ${u.name} 失败（${w.why}）`); return; }
      board.splice(board.indexOf(u), 1);
      const l = await io.look(); await sync(l);
      const b = bench.find((x) => !x.name) || bench.at(-1);
      if (!b) return;
      b.name = u.name;
      const d = await io.deploy(b.x, spotFor(u.name), 'right', u.name);
      note(`- 归队：${u.name} 离集合点太远（${Math.round(far.d)} 像素），撤下重放${d.ok ? '成功' : `失败（${d.why}）`}`);
      (mem.regrouped ||= []).push(u.name);   // 一局里每人只挪一次，免得来回挪
      if (!d.ok) { await autoFill(); return; }
      bench.splice(bench.indexOf(b), 1);
    }
  };

  const finishReady = async () => {
    await autoFill();
    await autoSwap();
    await autoClean();
    await autoEquip();
    await regroup();
    await keepAlive();
    return io.ready();
  };

  for (; asks < maxAsks;) {
    const sh = await io.open();
    if (!sh.ok) return { ok: false, why: sh.why, memo, asks, notes, state };
    let look = sh.look;
    const cd = await timeCheck(look);
    if (cd != null && !planner) maxAsks = 1;   // 联机：一回合只问一次模型（规则规划瞬间算完，不受限）
    let st = await io.read(look);
    // 回合数偶尔读丢一位（两位数「10」读成 0，或读不出）：回合只会涨，比读到过的最大值小就按最大值算
    if (mem.maxRound && st.round != null && st.round < mem.maxRound && st.round + 10 >= mem.maxRound && st.round + 10 <= mem.maxRound + 1) st = { ...st, round: st.round + 10 };   // 「1」丢了：0→10、1→11
    // 读不出：上回合之后打过一场（runner 看到作战画面会记 mem.sawBattle）就是上回合 +1，否则还是同一回合
    if (mem.maxRound && !(st.round >= mem.maxRound)) st = { ...st, round: mem.maxRound + (mem.sawBattle ? 1 : 0) };
    mem.sawBattle = false;
    if (st.round > 0 && st.round <= 20) mem.maxRound = Math.max(mem.maxRound || 0, st.round);
    await sync(look);
    // 不认识的：木板上的按住看名字（顺便拿格子图），场上的点一下看名字
    let tiles = [];
    let tileImg = '';
    let boardFull = false;   // 按住人时场上没有空绿格：格子图拿不到，认过名字的不用再按
    for (const b of bench) {
      if (b.name && (tiles.length || boardFull)) continue;
      if (tiles.length && left() < 35) break;   // 时间紧：拿到格子图就够了，不认人
      if (b.name && isEquip(b.name)) continue;   // 装备拿不到格子图
      const p = await io.pickUp(b.x);
      // 按住装备时不亮绿格（pickUp 判成失败、已经放回），但那张截图左上也有名字
      if (!p.ok) { if (!b.name && p.file) b.name = (await io.nameOf(p.file)) || ''; continue; }
      if (!b.name) b.name = (await io.nameOf(p.file)) || `无名${b.x}`;
      if (p.full) boardFull = true;
      if (!tiles.length && !isEquip(b.name) && p.tiles?.length) { tiles = p.tiles; tileImg = await io.tilesImage(p.file, tiles); }
      await io.cancel(p.from);
    }
    if (left() > 35) {
      for (const u of board) {
        if (u.name) continue;
        // 点身子读到装备名（详情面板显示的是它戴的装备）：往上点一下头再读一次，还是装备就先不认
        let n = (await io.nameAt(u.x, u.y)) || '';
        if (isEquip(n)) n = (await io.nameAt(u.x, u.y - 30)) || '';
        u.name = tierOf(n) > 0 ? n : '';   // 只认干员名（读到盟约名、装置名、装备名都不算，不认就不动它）
      }
    }
    // 不用想的事先做掉，做了就重读局面
    if (asks === 0) {
      const n = notes.length;
      // 升级费用降到 2 块以内、钱够：直接升（本地模拟里积极升级的打法撑得最久，社区也是「三回合升本」）
      if (st.upgradeCost != null && st.funds != null && st.upgradeCost <= 2 && st.upgradeCost <= st.funds) {
        const u = await io.upgrade();
        note(`- 自动升级（只要 ${st.upgradeCost} 块）${u.ok ? '成功' : `失败（${u.why}）`}`);
        if (u.ok) st = { ...st, funds: u.funds ?? st.funds - st.upgradeCost };
      }
      await autoMerge(st);
      { const s2 = await io.open(); if (s2.ok) await autoFree(await io.read(s2.look)); }
      await autoMoneyItems();
      if (notes.length > n) { const s2 = await io.open(); if (s2.ok) { look = s2.look; st = await io.read(look); await sync(look); } }
    }
    // 来不及再问模型（一次 15～20 秒）：直接补满场开打
    if (left() < 25 && !planner) {
      note(`- 倒计时只剩 ${Math.round(left())} 秒，不问了，直接补满场开打`);
      const res = await finishReady();
      return { ok: res.ok, readied: res.ok, memo, asks, notes, state };
    }
    state = { round: st.round, hp: st.hp, funds: st.funds, remain: st.remain, shop: st.shop.map((c) => c.name).filter(Boolean), alliances: st.alliances, bench: names(bench), board: names(board) };
    asks++;
    const t0 = Date.now();
    // 调度中心等级：按商店格数校正（干员 3 + 装备 1 = 4 格是 1 级，6 格是 6 级，5 格至少 2 级）
    if (st.shop.length === 4) mem.level = 1;
    else if (st.shop.length >= 6) mem.level = 6;
    else if (st.shop.length === 5 && (mem.level || 1) < 2) mem.level = 2;
    // 规则规划器（planner.js，照搬复刻版 AI 的经济和阵容规则）：不问模型，直接算清单
    const r = planner
      ? { ok: true, seconds: 0, json: planner({ st: { ...st, level: mem.level }, bench, board, round: st.round, extra, memo, notes, mem }) }
      : await ask({ prompt: deadline != null ? `${buildPrompt({ st, bench, board, tiles, memo, extra, notes })}

【联机倒计时】这回合只剩约 ${Math.round(left())} 秒，清单写短：最要紧的几步（买、上场）在前，ready 在最后。` : buildPrompt({ st, bench, board, tiles, memo, extra, notes }), images: [look.file, ...(tileImg ? [tileImg] : [])].filter(Boolean), schema: PLAN_SCHEMA, effort: deadline != null ? 'low' : effort, timeoutMinutes: 3 });
    log(`回合 ${st.round} 第 ${asks} 次规划：${r.ok ? `${r.seconds ?? Math.round((Date.now() - t0) / 1000)} 秒` : r.error}`);
    if (!r.ok) return { ok: false, why: r.error, error: r.error, memo, asks, notes, state };
    const plan = r.json || {};
    memo = plan.memo || memo;
    if (plan.say) await report(plan.say);
    log(`打算：${plan.think}｜${(plan.ops || []).map((o) => `${o.op}${o.slot > 0 ? o.slot : ''}${o.unit ? `:${o.unit}` : ''}${o.tile >= 0 && o.op === 'deploy' ? `→${o.tile}${o.dir}` : ''}`).join(' ')}`);

    let replan = false;
    let bought = false;
    for (const o of plan.ops || []) {
      // 时间快到了：剩下的清单不做了，先把人补上场再开打
      if (left() < 8) { note('- 倒计时快到了，跳过剩下的操作，先补满场开打'); const res = await finishReady(); return { ok: res.ok, readied: res.ok, memo, asks, notes, state }; }
      const bad = checkOp(o, { tiles, bench: names(bench), board: names(board), shopSize: st.shop.length || 5, failed });
      if (bad) { notes.push(`- 跳过了 ${o.op}：${bad}`); continue; }
      let res;
      if (o.op === 'buy') {
        res = await buyOne(o.slot);
        if (res.ok) bought = true;
      } else if (o.op === 'sell') {
        const b = findBench(o.unit);
        if (b) { res = await io.sell(b.x); if (res.ok) bench.splice(bench.indexOf(b), 1); }
        else { const u = findBoard(o.unit); res = await io.sellBoard(u); if (res.ok) board.splice(board.indexOf(u), 1); }
      } else if (o.op === 'equip') {
        res = await equipTo(findBench(o.unit), o.to ? findBoard(o.to) : null);
      } else if (o.op === 'withdraw') {
        const u = findBoard(o.unit);
        res = await io.withdraw(u);
        if (res.ok) { board.splice(board.indexOf(u), 1); const l = await io.look(); await sync(l); const fresh = bench.find((b) => !b.name); if (fresh) fresh.name = o.unit; }
      } else if (o.op === 'deploy') {
        const b = findBench(o.unit);
        res = await io.deploy(b.x, o.tile >= 0 ? tiles[o.tile] : spotFor(o.unit), o.dir, o.unit);
        if (res.ok) { bench.splice(bench.indexOf(b), 1); if (res.at) board.push({ x: res.at.x, y: res.at.y, name: o.unit, unsure: true }); }
        if (res.ok && res.moved) notes.push(`- ${o.unit} 不能放 ${o.tile} 号格，改放到了附近`);
      } else if (o.op === 'refresh') {
        res = await io.refresh();
        if (res.ok) { notes.push('- 刷新了商店'); replan = true; }
      } else if (o.op === 'upgrade') {
        res = await io.upgrade();
      } else if (o.op === 'freeze') {
        res = io.freeze ? await io.freeze() : { ok: false, why: '不支持冻结' };
      } else if (o.op === 'ready') {
        res = await finishReady();
        if (res.ok) return { ok: true, readied: true, memo, asks, notes, state };
      }
      note(`- ${o.op}${o.slot > 0 ? ` ${o.slot}号` : ''}${o.unit ? ` ${o.unit}` : ''}${o.op === 'deploy' ? ` → ${o.tile}号格朝${o.dir}` : ''}：${res?.ok ? '成功' : `失败（${res?.why}）`}`);
      // 钱不够买这张：跳过它接着做后面的（部署、准备就绪不花钱），不值得为这个再问一次
      if (!res?.ok && o.op === 'buy' && /只有/.test(res.why || '')) continue;
      if (!res?.ok) { if (!['buy', 'deploy', 'sell', 'withdraw'].includes(o.op)) failed.add(o.op); replan = true; break; }
      if (replan) break;
    }
    // 清单没写 ready 也没出错：补满场直接开打，不再为这个回合多问一次
    if (!replan) { const res = await finishReady(); return { ok: res.ok, readied: res.ok, memo, asks, notes, state }; }
  }
  // 问满了次数还没 ready：补满人再直接准备就绪，别让倒计时拖着
  const res = await finishReady();
  notes.push(`- 规划次数用完，直接准备就绪：${res.ok ? '成功' : res.why}`);
  return { ok: res.ok, readied: res.ok, memo, asks, notes, state };
}

export const __internal = { buildPrompt, describeState, drawTileNumbers, ownedCounts };
