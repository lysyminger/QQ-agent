// 群里问"吃什么"：从学校周边高分店单里随机挑一家发出去（从 index.js 拆出来的独立功能）。
//   店单：data/codex-bridge/food/shops.json，由 scripts/build-campus-guide.mjs 根据高德数据生成。
//   自动推荐：入站消息命中"吃什么 / 饿了 / 点外卖…"就发，不限次数；同一条只发一次，最近推过的不重复。
//   food_pick：大脑按口味 / 价钱 / 距离挑店（只返回店的信息，由大脑自己组织语言发）。
// 依赖 index.js 的 settings / ownerIds / messageText 由 bindFood() 注入。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { logger } from '../../src/logger.js';

const ID = 'codex-bridge';
const SHOPS_FILE = path.join(DATA_DIR, ID, 'food', 'shops.json');
// 最近推过的这么多家不再抽到
const FOOD_RECENT = 15;
const G = globalThis.__codexBridge ??= { running: new Map(), state: null };
let deps = { settings: () => ({}), ownerIds: () => [], messageText: (e) => String(e?.text || '') };
export function bindFood(d) { deps = { ...deps, ...d }; }

let cache = { mtime: 0, data: null };
function readShops() {
  try {
    const st = fs.statSync(SHOPS_FILE);
    if (st.mtimeMs !== cache.mtime) cache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(SHOPS_FILE, 'utf8')) };
    return Array.isArray(cache.data?.shops) ? cache.data.shops : [];
  } catch { return []; }
}

// "吃什么"类的问法；吃瓜、吃醋、吃药这类不是在问饭
const FOOD_ASK = /吃(什么|啥|点(什么|啥|啥好的)|哪家)|饿了|点外卖|外卖(吃|点)|(早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|宵夜)(吃|去哪|怎么解决)|去哪(吃|干饭)|有(什么|啥)好吃|干饭吃/;
const NOT_FOOD = /吃(什么|啥)(药|醋|亏|瓜|苦|屎|土|狗粮)|吃什么长大|饿了么(会员|红包|骑手)|在吃(什么|啥)/;
const FOOD_MAX_LEN = 60;

export function isFoodAsk(text) {
  const t = String(text || '').replace(/\s+/g, '');
  return t.length > 0 && t.length <= FOOD_MAX_LEN && FOOD_ASK.test(t) && !NOT_FOOD.test(t);
}

const foodMessageKey = (chatKey, entry) => `${chatKey}|${String(entry?.mid ?? entry?.id ?? entry?.ts ?? '')}`;

function groupAllowed(chatKey) {
  const s = deps.settings();
  if (s.foodAuto === false || !String(chatKey || '').startsWith('group:')) return false;
  const only = Array.isArray(s.foodGroups) ? s.foodGroups.map(String).filter(Boolean) : [];
  return !only.length || only.includes(String(chatKey).slice('group:'.length));
}

const fmtDist = (m) => (m < 995 ? `${Math.round(m / 10) * 10} 米` : `${(m / 1000).toFixed(1)} 公里`);

/** 一家店的一行说明（推荐消息和 food_pick 都用）。 */
export function shopLine(s) {
  return [
    `${s.category}`,
    s.rating ? `高德 ${s.rating} 分` : '',
    s.cost ? `人均 ¥${s.cost}` : '',
    `离学校约 ${fmtDist(s.distance)}`
  ].filter(Boolean).join(' · ');
}

// 群里发的推荐要像随口一句：店名里的"(拱宸店)"并进去，地址里"(xx地铁站步行xx米)"这类括注去掉
const plainName = (n) => String(n || '').replace(/[(（]([^)）]*)[)）]/g, '$1').trim();
const plainAddr = (a) => String(a || '').replace(/[(（][^)）]*[)）]/g, '').trim();
const casualDist = (m) => (m < 995 ? `${Math.round(m / 10) * 10}米` : `${(m / 1000).toFixed(1)}公里`);
// 高德的招牌里常混着食材 / 套餐名，说出来像机器拼的
const GENERIC_TAG = /^(鸡肉|牛肉|猪肉|羊肉|鱼肉|豆腐|白菜|丸子|鸡块|虾|肉片|金针菇|五花肉|馄饨皮|米粉|面食|家常菜|农家菜|特色菜|特色小吃|早午餐|单人餐|双人餐|绿豆汤|素菜|鸡腿|薯条)$/;
const OPENERS = ['要不吃{n}', '去吃{n}吧', '{n}怎么样', '试试{n}', '吃{n}呗'];

export function foodText(s, rnd = Math.random) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const parts = [pick(OPENERS).replace('{n}', plainName(s.name))];
  const facts = [s.rating ? `${s.rating}分` : '', s.cost ? `人均${s.cost}` : '', `离学校${casualDist(s.distance)}`].filter(Boolean);
  parts.push(facts.join('，'));
  const tags = (s.tags || []).map(plainAddr).filter((t) => t && !GENERIC_TAG.test(t) && !s.name.includes(t)).slice(0, 2);
  if (tags.length) parts.push(pick(['招牌是{t}', '可以点{t}', '{t}挺多人点']).replace('{t}', tags.join('和')));
  const addr = plainAddr(s.address);
  if (addr) parts.push(`在${addr}`);
  return parts.join('，');
}

/** 按条件挑店：keyword 匹配店名 / 类别 / 招牌，maxCost / maxDistance 过滤，避开 exclude 里的 id。 */
export function pickShops({ keyword = '', maxCost = 0, maxDistance = 0, exclude = [], count = 1 } = {}, shops = readShops(), rnd = Math.random) {
  const kws = String(keyword || '').split(/[\s,，、/]+/).filter(Boolean);
  let list = shops.filter((s) => (!maxCost || !s.cost || s.cost <= maxCost) && (!maxDistance || s.distance <= maxDistance)
    && (!kws.length || kws.some((k) => `${s.name}${s.category}${(s.tags || []).join('')}`.includes(k))));
  const fresh = list.filter((s) => !exclude.includes(s.id));
  if (fresh.length) list = fresh;
  const out = [];
  const pool = [...list];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

function recentOf(chatKey) {
  G.foodRecent ||= new Map();
  if (!G.foodRecent.has(chatKey)) G.foodRecent.set(chatKey, []);
  return G.foodRecent.get(chatKey);
}

function remember(chatKey, shop) {
  const r = recentOf(chatKey);
  r.push(shop.id);
  while (r.length > FOOD_RECENT) r.shift();
}

/** 这条群消息该不该自动推荐（不发，只判断）：返回 { ok, reason }。 */
export function foodAutoCheck(chatKey, entry) {
  if (!entry || entry.self || !groupAllowed(chatKey)) return { ok: false, reason: 'off' };
  if (!isFoodAsk(deps.messageText(entry))) return { ok: false, reason: 'nomatch' };
  G.foodAuto ||= new Map();
  if (G.foodAuto.has(foodMessageKey(chatKey, entry))) return { ok: false, reason: 'done' };
  if (!readShops().length) return { ok: false, reason: 'empty' };
  return { ok: true, reason: '' };
}

/**
 * 入站消息规则：命中就先把选中的店记下来（大脑这一轮的提示、复读机都看得到），再引用那条消息发一句推荐。
 * 返回选中的店，没发返回 null。
 */
export async function sendFoodPick(orch, chatKey, entry) {
  const check = foodAutoCheck(chatKey, entry);
  if (!check.ok) return null;
  const [shop] = pickShops({ exclude: recentOf(chatKey) });
  if (!shop) return null;
  const key = foodMessageKey(chatKey, entry);
  G.foodAuto.set(key, { shop, at: Date.now() });
  while (G.foodAuto.size > 300) G.foodAuto.delete(G.foodAuto.keys().next().value);
  remember(chatKey, shop);
  if (!orch?.sender?.sendTextBatch) { logger.warn(ID, '吃什么推荐：发送端未就绪'); return null; }
  const replyToMessageId = entry.mid ?? null;
  try {
    try {
      await orch.sender.sendTextBatch(chatKey, [foodText(shop)], { replyToMessageId });
    } catch (e) {
      // 引用的消息找不到（撤回了）就不引用再发一次
      if (!replyToMessageId) throw e;
      await orch.sender.sendTextBatch(chatKey, [foodText(shop)]);
    }
    logger.info(ID, `${chatKey} 有人问吃什么，推荐了「${shop.name}」`);
  } catch (e) {
    logger.warn(ID, `${chatKey} 吃什么推荐发送失败：${e?.message ?? e}`);
    G.foodAuto.delete(key);
    return null;
  }
  // 不再补发店铺照片：图要单独一条、晚二三十秒才到，夹在别人的聊天中间看不出是哪条的
  return shop;
}

/** 给大脑的提示：这一轮叫它的消息里有人问吃什么，程序推荐了哪家 / 为什么没推荐。 */
export function foodHint(sessionId, chatKey) {
  if (!String(chatKey || '').startsWith('group:')) return '';
  const sess = G.orch?.sessions?.current?.get?.(sessionId);
  const lines = [];
  for (const e of sess?.trigger || []) {
    if (!e || e.self || !isFoodAsk(deps.messageText(e))) continue;
    const done = G.foodAuto?.get(foodMessageKey(chatKey, e));
    const tag = `#${e.mid ?? e.id}`;
    if (done) lines.push(`→ 本轮 ${tag} 问吃什么，程序已经自动推荐了「${done.shop.name}」（${shopLine(done.shop)}），别再重复推荐这家；对方想换口味、要便宜点或近一点，再用 food_pick 按条件挑。`);
    else if (groupAllowed(chatKey)) lines.push(`→ 本轮 ${tag} 像在问吃什么，自动推荐没发出去；要是在问你，可以用 food_pick 挑一家告诉他。`);
  }
  return lines.join('\n');
}

export const FOOD_PICK_TOOL = {
  id: 'food_pick',
  name: '学校周边吃什么',
  category: 'utility',
  icon: '🍜',
  description: '从浙江树人学院拱宸桥校区周边 1.5 公里的高分店单（高德 4.5 分以上、人均 60 以内）里挑店，返回店名、类别、评分、人均、距离、招牌、地址。'
    + '群友问吃什么、想吃某类东西（面、火锅、烧烤、汉堡…）、要便宜或近的时候用；拿到结果后用自己的话推荐，别整段照抄。'
    + '店单之外的情况（聚餐请客、奶茶咖啡、校内食堂、周边超市快递等）看知识库 learned/树人周边吃什么.md 和 learned/浙江树人学院拱宸桥校区周边.md。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '口味 / 类别 / 菜名关键词，多个用空格隔开，如「面 米线」「火锅」「鸡」；不填 = 随便挑' },
      maxCost: { type: 'number', description: '人均上限（元），不填不限' },
      maxDistance: { type: 'number', description: '离学校最远多少米，不填不限' },
      count: { type: 'number', description: '挑几家，1～5，默认 1' }
    }
  },
  async execute(ctx, args = {}) {
    const shops = readShops();
    if (!shops.length) return { content: '店单是空的（data/codex-bridge/food/shops.json 不存在），先让主人跑 scripts/build-campus-guide.mjs', isError: true };
    const count = Math.min(5, Math.max(1, Number(args.count) || 1));
    const chatKey = String(ctx?.chatKey || '');
    const picks = pickShops({ keyword: args.keyword, maxCost: Number(args.maxCost) || 0, maxDistance: Number(args.maxDistance) || 0, exclude: chatKey ? recentOf(chatKey) : [], count }, shops);
    if (!picks.length) return { content: `店单里没有符合条件的店（共 ${shops.length} 家）。可以放宽条件，或者去知识库 learned/树人周边吃什么.md 里找 4.5 分以下 / 人均更高的。` };
    if (chatKey) for (const s of picks) remember(chatKey, s);
    const lines = picks.map((s) => `· ${s.name}：${shopLine(s)}${s.tags?.length ? `；招牌 ${s.tags.join('、')}` : ''}${s.address ? `；${s.address}` : ''}`);
    return { content: `${lines.join('\n')}\n（评分是高德到店评分，不是外卖评分；送不送外卖要在外卖 App 里搜店名确认）` };
  }
};
