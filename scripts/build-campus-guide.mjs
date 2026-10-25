// 整理浙江树人学院拱宸桥校区周边：高德周边搜索 → 外卖推荐店单 + 知识库两份词条。
//
//   node scripts/build-campus-guide.mjs            调高德重新拉（约 70 次调用，个人 Key 免费额度内）
//   node scripts/build-campus-guide.mjs --offline  只用上次拉下来的原始数据重新生成，不调接口
//
// Key 放在 data/codex-bridge/food/amap.json 的 amapKey（data/ 不进 git）。
// 产物：
//   data/codex-bridge/food/amap-food-raw.json / amap-around-raw.json   原始数据
//   data/codex-bridge/food/shops.json                                  群里"吃什么"自动推荐用的店单
//   data/knowledge-base/learned/浙江树人学院拱宸桥校区周边.md          周边总览
//   data/knowledge-base/learned/树人周边吃什么.md                      吃饭专题
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');
const FOOD_DIR = path.join(DATA_DIR, 'codex-bridge', 'food');
const LEARNED_DIR = path.join(DATA_DIR, 'knowledge-base', 'learned');
const FOOD_RAW = path.join(FOOD_DIR, 'amap-food-raw.json');
const AROUND_RAW = path.join(FOOD_DIR, 'amap-around-raw.json');
const SHOPS = path.join(FOOD_DIR, 'shops.json');

// 拱宸桥校区（树人街 8 号）在高德的坐标
const CENTER = [120.157632, 30.318750];
const FOOD_RADIUS = 1500;
const MEAL_TYPES = '050100|050200|050300|050400';
// 外卖候选：高分、人均不离谱（宴请酒楼不算外卖）、没标停业
const PICK_MIN_RATING = 4.5;
const PICK_MAX_COST = 60;
const CLOSED = /暂停|装修|歇业|停业|关闭|已关/;

const AROUND = [
  ['地铁站', { types: '150500', radius: 2000, n: 25 }],
  ['超市', { types: '060400', radius: 1500, n: 25 }],
  ['便利店', { types: '060200', radius: 800, n: 25 }],
  ['商场', { types: '060100|060101|060102', radius: 2500, n: 25 }],
  ['快递驿站', { keywords: '快递|驿站|菜鸟', radius: 1200, n: 25 }],
  ['打印复印', { keywords: '打印|复印|图文', radius: 1200, n: 25 }],
  ['医院诊所', { types: '090100|090200', radius: 3000, n: 25 }],
  ['药店', { types: '090300|090601|090602', radius: 1200, n: 25 }],
  ['银行', { types: '160100', radius: 1200, n: 25 }],
  ['网吧KTV酒吧', { types: '080302|080308|080305|080304', radius: 2000, n: 25 }],
  ['电影院', { types: '080601', radius: 3000, n: 15 }],
  ['运动健身', { types: '080100|080111|080112', radius: 1500, n: 25 }],
  ['景点公园', { types: '110000', radius: 3000, n: 40 }],
  ['酒店', { types: '100100|100200', radius: 1200, n: 25 }],
  ['奶茶', { types: '050700', radius: 1200, n: 40 }],
  ['咖啡', { types: '050500', radius: 1200, n: 40 }],
  ['甜品面包', { types: '050800|050900', radius: 1200, n: 40 }],
  ['校门口吃的', { keywords: '食堂|美食城|餐厅', types: '050000', radius: 700, n: 40 }],
  ['周边高校', { types: '141201', radius: 3000, n: 25 }],
  ['理发', { types: '071100', radius: 1000, n: 25 }],
  ['维修', { types: '071200|070800', radius: 1000, n: 15 }]
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const val = (v) => (Array.isArray(v) ? '' : String(v ?? ''));
const num = (v) => { const x = Number(val(v)); return Number.isFinite(x) && x > 0 ? x : 0; };
const rad = (d) => d * Math.PI / 180;
function distance(loc) {
  const [x, y] = String(loc).split(',').map(Number);
  const a = Math.sin(rad(y - CENTER[1]) / 2) ** 2 + Math.cos(rad(CENTER[1])) * Math.cos(rad(y)) * Math.sin(rad(x - CENTER[0]) / 2) ** 2;
  return Math.round(12742000 * Math.asin(Math.sqrt(a)));
}

let calls = 0;
async function amap(endpoint, params, key) {
  const qs = new URLSearchParams({ key, offset: '25', extensions: 'all', ...params });
  const j = await (await fetch(`https://restapi.amap.com/v3/place/${endpoint}?${qs}`)).json();
  calls++;
  await sleep(400);   // 个人 Key 并发很低，慢一点
  if (j.status !== '1') throw new Error(`高德返回 ${j.info}（${j.infocode}）`);
  return j;
}

// 周边搜索单次最多给 200 条，中餐就有五六百家：把 3km×3km 切成小格搜，超过 200 的格再四分
async function fetchFood(key) {
  const dLng = 0.0156, dLat = 0.01349, N = 4;   // 约 1.5km
  const all = new Map();
  async function cell(x0, y0, x1, y1, depth) {
    const polygon = `${x0.toFixed(6)},${y1.toFixed(6)}|${x1.toFixed(6)},${y0.toFixed(6)}`;
    const first = await amap('polygon', { polygon, types: MEAL_TYPES, page: '1' }, key);
    const count = Number(first.count);
    if (count >= 200 && depth < 2) {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      for (const [a, b, c, d] of [[x0, y0, mx, my], [mx, y0, x1, my], [x0, my, mx, y1], [mx, my, x1, y1]]) await cell(a, b, c, d, depth + 1);
      return;
    }
    for (const p of first.pois || []) all.set(p.id, p);
    for (let page = 2; page <= Math.ceil(count / 25); page++) {
      for (const p of (await amap('polygon', { polygon, types: MEAL_TYPES, page: String(page) }, key)).pois || []) all.set(p.id, p);
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x0 = CENTER[0] - dLng + (2 * dLng / N) * i, y0 = CENTER[1] - dLat + (2 * dLat / N) * j;
    await cell(x0, y0, x0 + 2 * dLng / N, y0 + 2 * dLat / N, 0);
  }
  return [...all.values()].map((p) => ({ ...p, distance: distance(p.location) })).filter((p) => p.distance <= FOOD_RADIUS);
}

async function fetchAround(key) {
  const out = {};
  for (const [name, q] of AROUND) {
    out[name] = [];
    for (let page = 1; out[name].length < q.n && page <= 2; page++) {
      const params = { location: CENTER.join(','), radius: String(q.radius), sortrule: 'distance', page: String(page) };
      if (q.types) params.types = q.types;
      if (q.keywords) params.keywords = q.keywords;
      const j = await amap('around', params, key);
      out[name].push(...(j.pois || []));
      if (Number(j.count) <= page * 25) break;
    }
    out[name] = out[name].slice(0, q.n);
  }
  return out;
}

// ── 整理 ──────────────────────────────────────────────────────────────

function category(p) {
  // 只看店名和类型：招牌菜里顺带一个"鸡排""烤鱼"不代表是那类店
  const t = `${p.name}${p.type}`;
  if (/火锅|涮|串串|冒菜|打边炉/.test(t)) return '火锅';
  if (/烧烤|烤串|烤肉|烧鸟|撸串|烤鱼/.test(t)) return '烧烤烤鱼';
  if (/麦当劳|肯德基|汉堡|披萨|赛百味|塔斯汀|炸鸡|鸡排/.test(t)) return '汉堡炸鸡';
  if (/外国|日本|韩国|意式|西餐|料理/.test(p.type)) return '西餐日料';
  if (/面|粉|米线|馄饨|饺|锅贴|煎包|烧饼|油条/.test(p.name + val(p.tag))) return '面馆粉店小吃';
  if (/快餐/.test(t)) return '快餐盖饭';
  return '中餐小炒';
}

const tagsOf = (p) => [...new Set(val(p.tag).split(/[,，]/).map((s) => s.trim()).filter((s) => s && !/^(单人餐|双人餐|特色菜)$/.test(s)))].slice(0, 4);
const short = (p) => ({
  id: p.id,
  name: p.name,
  category: category(p),
  rating: num(p.biz_ext?.rating),
  cost: num(p.biz_ext?.cost),
  distance: p.distance ?? distance(p.location),
  address: val(p.address),
  tags: tagsOf(p),
  photo: (p.photos || []).map((x) => val(x.url)).find(Boolean) || '',
  location: p.location
});

const fmtDist = (m) => (m < 995 ? `${Math.round(m / 10) * 10}米` : `${(m / 1000).toFixed(1)}公里`);
const fmtShop = (s, { addr = true } = {}) => [
  `**${s.name}**`,
  s.rating ? `${s.rating}分` : '',
  s.cost ? `人均${s.cost}` : '',
  fmtDist(s.distance),
  s.tags.length ? `招牌：${s.tags.join('、')}` : '',
  addr && s.address ? `（${s.address}）` : ''
].filter(Boolean).join(' · ');

function buildShops(food) {
  return food.map(short)
    .filter((s) => s.rating >= PICK_MIN_RATING && (!s.cost || s.cost <= PICK_MAX_COST) && !CLOSED.test(s.name))
    .sort((a, b) => b.rating - a.rating || a.distance - b.distance);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function foodMd(food, around, shops, fetchedAt) {
  const all = food.map(short).filter((s) => !CLOSED.test(s.name));
  const near = all.filter((s) => s.distance <= 400 && s.rating >= 4).sort((a, b) => a.distance - b.distance);
  const group = (list) => {
    const by = new Map();
    for (const s of list) { if (!by.has(s.category)) by.set(s.category, []); by.get(s.category).push(s); }
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  };
  const party = all.filter((s) => s.rating >= PICK_MIN_RATING && s.cost > PICK_MAX_COST && s.cost <= 160).sort((a, b) => b.rating - a.rating || a.distance - b.distance);
  const drinks = (name, min) => (around[name] || []).map(short).filter((s) => s.rating >= min && !CLOSED.test(s.name)).sort((a, b) => a.distance - b.distance);
  const L = [
    '# 树人周边吃什么',
    '',
    '<!-- 由 scripts/build-campus-guide.mjs 根据高德地图数据生成；重新运行脚本会覆盖本文件，想补充群友推荐请写进别的词条 -->',
    '**类别**：生活指南',
    '**别名**：树人吃什么、树大吃什么、树人附近好吃的、拱宸桥校区周边美食、树人外卖',
    `**一句话**：浙江树人学院拱宸桥校区（树人街8号）周边 1.5 公里内有 ${all.length} 家餐饮店，其中高德 ${PICK_MIN_RATING} 分以上、人均 ${PICK_MAX_COST} 元以内的 ${shops.length} 家收进了"吃什么"推荐店单。`,
    '',
    '## 要点',
    `- 数据是高德地图 ${fetchedAt.slice(0, 10)} 的周边搜索结果；评分是高德的到店评分（满分 5），不是美团/饿了么的外卖评分，送不送外卖要在外卖 App 里搜店名确认。`,
    '- 高德评分整体偏低，4.5 分以上已经算前 15% 左右；评分只反映写评价的人，店可能已经换了老板或关门，推荐时别说得太绝对。',
    '- 校内吃饭：南校区有杭儿厨美食广场（3号综合楼3层）、正大食堂；北边舟山东路66号有舟东美食城；隔壁浙大城市学院南校区也有餐厅和小吃（学苑餐厅等）。',
    '- 外卖柜：南校区西门外卖柜（东教路与舟山东路交叉口东南40米）、浙大城市学院南校区南门外卖柜（台州路与科园路交叉口北20米）。',
    '- 群里有人问"吃什么"，喵喵会从推荐店单里随机挑一家发出来；想按口味、价钱挑可以直接问喵喵。',
    ''
  ];
  L.push('## 校门口 400 米内（4 分以上，按距离）');
  for (const s of near) L.push(`- ${fmtShop(s)}`);
  L.push('');
  L.push(`## 高分平价（${PICK_MIN_RATING} 分以上、人均 ${PICK_MAX_COST} 以内，按类）`);
  for (const [cat, list] of group(shops)) {
    L.push(`### ${cat}`);
    for (const s of list) L.push(`- ${fmtShop(s)}`);
  }
  L.push('');
  L.push(`## 聚餐请客（${PICK_MIN_RATING} 分以上、人均 ${PICK_MAX_COST + 1}～160）`);
  for (const s of party) L.push(`- ${fmtShop(s)}`);
  L.push('');
  L.push('## 奶茶、咖啡、甜品（4 分以上，按距离）');
  for (const [name, min] of [['奶茶', 4], ['咖啡', 4], ['甜品面包', 4]]) {
    const list = drinks(name, min);
    if (list.length) L.push(`- ${name}：${list.map((s) => `${s.name}（${[s.rating && `${s.rating}分`, s.cost && `人均${s.cost}`, fmtDist(s.distance)].filter(Boolean).join('，')}）`).join('；')}`);
  }
  L.push('');
  L.push('## 关联');
  L.push('- 所在地：浙江树人学院拱宸桥校区周边（知识库有）');
  L.push('');
  L.push(`> 来源：高德地图开放平台周边搜索（${fetchedAt.slice(0, 10)}，中心 树人街8号，半径 1.5 公里）；原始数据 data/codex-bridge/food/amap-food-raw.json`);
  L.push('> 时效：店铺开关、评分变化快，引用前注意核实');
  L.push(`> 生成于 ${stamp()}（脚本生成，可直接编辑，但重新生成会覆盖）`);
  return `${L.join('\n')}\n`;
}

function aroundMd(around, fetchedAt) {
  const S = (name, filter = () => true, max = 12) => (around[name] || []).map(short).filter((s) => !CLOSED.test(s.name)).filter(filter).slice(0, max);
  const line = (s, extra = '') => `${s.name}（${[fmtDist(s.distance), s.rating && s.rating >= 4 ? `${s.rating}分` : '', extra].filter(Boolean).join('，')}）`;
  const join = (list, extra) => list.map((s) => line(s, extra?.(s))).join('；');

  // 地铁：只列站，不列出入口
  const stations = (around['地铁站'] || []).filter((p) => /地铁站\)$|\(地铁站\)/.test(p.name))
    .map((p) => `${p.name.replace(/\(地铁站\)/, '站')}（${val(p.address).replace(/;/g, '、')}，约${fmtDist(p.distance)}）`);
  const nearExit = (around['地铁站'] || []).filter((p) => /善贤地铁站/.test(p.name) && !/\(地铁站\)/.test(p.name))
    .map((p) => `${p.name.replace('善贤地铁站', '')}（${val(p.address)}，${fmtDist(p.distance)}）`);

  const L = [
    '# 浙江树人学院拱宸桥校区周边',
    '',
    '<!-- 由 scripts/build-campus-guide.mjs 根据高德地图数据生成；重新运行脚本会覆盖本文件 -->',
    '**类别**：地点',
    '**别名**：树人拱宸桥校区、树人大学拱宸桥校区、树大、树人街8号、树人南校区、树人北校区',
    '**一句话**：浙江树人学院拱宸桥校区在杭州市拱墅区上塘街道，南校区在树人街8号、北校区在舟山东路36号，紧挨浙大城市学院南校区，最近的地铁是善贤站（3号线、5号线）。',
    '',
    '## 要点',
    '- 校区分南北两块：南校区（树人街8号，有行政中心、查济民大厦、图信楼、杭儿厨美食广场、卫生所在18号楼）和北校区（舟山东路36号，有体育馆、田径场、足球场、篮球场）。很多地图点位还叫"浙江树人大学"。',
    '- 学生公寓区：清乐园（舟山东路一带）、致和园（七古路85号一带，东区、西区）。',
    '- 隔壁是浙大城市学院南校区（湖州街51号），往东北是城院北校区；国际关系学院杭州校区在七古路88号，约450米。',
    `- 地铁：${stations.join('；')}。`,
    `- 善贤站离南校区最近的出口：${nearExit.slice(0, 4).join('；')}。`,
    `- 超市：${join(S('超市', (s) => s.distance <= 1100, 8))}。`,
    `- 便利店（800米内）：${join(S('便利店', () => true, 10))}。`,
    `- 快递：${join(S('快递驿站', (s) => /菜鸟|驿站|快递超市|中邮/.test(s.name) && s.distance <= 1000, 10))}。`,
    `- 打印复印：${join(S('打印复印', () => true, 8))}。`,
    `- 看病：浙江树人大学卫生所（南校区18号楼）；${join(S('医院诊所', (s) => /卫生|急救|综合医院/.test(s.name + s.category), 6))}。`,
    `- 药店：${join(S('药店', (s) => /药房|大药房/.test(s.name), 6))}。`,
    `- 银行：${join(S('银行', (s) => !/信息中心|办公点|科技部/.test(s.name), 6))}。`,
    `- 商场：${join(S('商场', (s) => s.rating >= 4.3 && !/北门|[A-D]区$|东区$|西区$/.test(s.name), 10))}。`,
    `- 电影院：${join(S('电影院', (s) => s.rating >= 4, 8), (s) => (s.cost ? `人均${s.cost}` : ''))}。`,
    `- 网吧、KTV、酒吧：${join(S('网吧KTV酒吧', (s) => s.rating >= 4, 14), (s) => (s.cost ? `人均${s.cost}` : ''))}。`,
    `- 运动：${join(S('运动健身', (s) => s.rating >= 4.4 || /树人/.test(s.name), 12))}。`,
    `- 散步、景点：${join(S('景点公园', (s) => s.rating >= 4, 10))}。`,
    `- 家长来住（1.2公里内酒店）：${join(S('酒店', (s) => s.rating >= 4.3 && !/大堂/.test(s.name), 10))}。`,
    `- 理发：${join(S('理发', (s) => /理发|造型|发型/.test(s.name), 8), (s) => (s.cost ? `人均${s.cost}` : ''))}。`,
    `- 手机电脑维修：${join(S('维修', (s) => /手机|电脑/.test(s.name), 5))}。`,
    '- 吃饭另见「树人周边吃什么」。',
    '',
    '## 关联',
    '- 相关：树人周边吃什么（知识库有）、浙江树人学院2026—2027学年校历（知识库有）',
    '',
    `> 来源：高德地图开放平台周边搜索（${fetchedAt.slice(0, 10)}，中心 树人街8号 ${CENTER.join(',')}）；原始数据 data/codex-bridge/food/amap-around-raw.json`,
    '> 时效：店铺开关变化快，距离是直线距离，引用前注意核实',
    `> 生成于 ${stamp()}（脚本生成，可直接编辑，但重新生成会覆盖）`
  ];
  return `${L.join('\n')}\n`;
}

// ── 入口 ──────────────────────────────────────────────────────────────

const offline = process.argv.includes('--offline');
let food, around, fetchedAt;
if (offline) {
  const f = JSON.parse(fs.readFileSync(FOOD_RAW, 'utf8'));
  const a = JSON.parse(fs.readFileSync(AROUND_RAW, 'utf8'));
  food = f.pois; around = a.groups; fetchedAt = f.fetchedAt;
} else {
  const key = JSON.parse(fs.readFileSync(path.join(FOOD_DIR, 'amap.json'), 'utf8')).amapKey;
  if (!key) throw new Error('data/codex-bridge/food/amap.json 里没有 amapKey');
  fetchedAt = new Date().toISOString();
  food = await fetchFood(key);
  around = await fetchAround(key);
  fs.mkdirSync(FOOD_DIR, { recursive: true });
  fs.writeFileSync(FOOD_RAW, JSON.stringify({ fetchedAt, center: CENTER, radius: FOOD_RADIUS, pois: food }, null, 1));
  fs.writeFileSync(AROUND_RAW, JSON.stringify({ fetchedAt, center: CENTER, groups: around }, null, 1));
}

const shops = buildShops(food);
fs.writeFileSync(SHOPS, JSON.stringify({ fetchedAt, source: '高德地图周边搜索', center: CENTER, rule: `评分≥${PICK_MIN_RATING}，人均≤${PICK_MAX_COST}（无人均也收），${FOOD_RADIUS}米内，去掉停业/装修`, shops }, null, 1));
fs.mkdirSync(LEARNED_DIR, { recursive: true });
fs.writeFileSync(path.join(LEARNED_DIR, '树人周边吃什么.md'), foodMd(food, around, shops, fetchedAt));
fs.writeFileSync(path.join(LEARNED_DIR, '浙江树人学院拱宸桥校区周边.md'), aroundMd(around, fetchedAt));
console.log(`餐饮 ${food.length} 家，推荐店单 ${shops.length} 家${offline ? '（离线重建）' : `，本次调用高德 ${calls} 次`}`);
