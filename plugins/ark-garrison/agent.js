// plugins/ark-garrison/agent.js
//
// 「脑子」：把当前画面（截图 + OCR）和相关资料交给 Codex，拿回一组要执行的操作。
//
// 资料不整份塞：每次只带 00-速查 + 画面上（或上一步备忘里）出现过名字的干员 / 盟约 / 策略 / 装备那几行，
// 再加最近学到的东西。整份四个文件近 6 万字，每步都带又慢又费额度。
//
// 「不能自己造」的落地：Codex 想记新知识时必须给出画面上的原文（quote），
// 代码检查原文确实出现在这一屏的 OCR 文字里才写进 learned.md；纯界面经验（比如关闭按钮在哪）
// 不要求原文，但会把当时的截图存进 evidence/ 作证据。

import fs from 'node:fs';
import path from 'node:path';
import { W, H } from './eyes.js';
import { WORK_DIR } from './maa.js';

const KB_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'knowledge');
const LEARNED = path.join(KB_DIR, 'learned.md');
const EVIDENCE_DIR = path.join(WORK_DIR, 'evidence');

// ── 资料索引 ───────────────────────────────────────────────────────────

let index = null;
/** 从 02 / 03 里按名字切出一行行资料：{ name -> [line, ...] }（同名的干员、策略、盟约都留着）。 */
function loadIndex() {
  if (index) return index;
  const map = new Map();
  const add = (name, line) => { const k = name.trim(); if (!map.has(k)) map.set(k, []); map.get(k).push(line.trim()); };
  const read = (f) => { try { return fs.readFileSync(path.join(KB_DIR, f), 'utf8'); } catch { return ''; } };
  // 03 是卫戍特质（叠层），06 是游戏数据里的范围 / 阻挡 / 技能（scripts/ark-build-data.mjs 生成），同名的两行都带上
  for (const f of ['03-干员特质表.md', '06-干员范围与技能.md']) {
    for (const line of read(f).split('\n')) {
      const m = line.match(/^- ([^(（｜]+?)\(/);
      if (m) add(m[1], line.slice(2, 320));
    }
  }
  for (const line of read('02-盟约-策略-装备.md').split('\n')) {
    let m = line.match(/^\| ([^|]+?) \|/);
    if (m && !/^(盟约|---)/.test(m[1])) { add(m[1], line); continue; }
    m = line.match(/^- ([^（(：:]+?)[（(：:]/);
    if (m && m[1].length <= 12) add(m[1], line.slice(2));
  }
  index = map;
  return map;
}

/** 文字里出现过的资料条目（名字一般至少 2 个字；单字的只有「炎」），按名字长的优先，最多 40 行。 */
export function relevantLines(text) {
  const t = String(text || '');
  const hits = [];
  for (const [name, lines] of loadIndex()) {
    if ((name.length >= 2 || name === '炎') && t.includes(name)) hits.push([name, lines]);
  }
  hits.sort((a, b) => b[0].length - a[0].length);
  return [...new Set(hits.flatMap((h) => h[1]))].slice(0, 40);
}

function baseKnowledge() {
  try { return fs.readFileSync(path.join(KB_DIR, '00-速查.md'), 'utf8'); } catch { return ''; }
}

function learnedTail(n = 40) {
  try {
    return fs.readFileSync(LEARNED, 'utf8').split('\n').filter((l) => l.startsWith('- ')).slice(-n).join('\n');
  } catch { return ''; }
}

/** 每局复盘出来的经验（review.js 写的 lessons.md）。 */
function lessonsTail(n = 40) {
  try {
    return fs.readFileSync(path.join(KB_DIR, 'lessons.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ')).slice(-n).join('\n');
  } catch { return ''; }
}

// ── 给 Codex 的输出格式 ─────────────────────────────────────────────────

const ACTION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['click', 'drag', 'back', 'wait'] },
    x: { type: 'number' }, y: { type: 'number' },
    x2: { type: 'number' }, y2: { type: 'number' },
    ms: { type: 'number' },
    dir: { type: 'string', enum: ['right', 'left', 'up', 'down', 'none'] },
    why: { type: 'string' }
  },
  required: ['type', 'x', 'y', 'x2', 'y2', 'ms', 'dir', 'why']
};

export const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    screen: { type: 'string' },
    observe: { type: 'string' },
    memo: { type: 'string' },
    actions: { type: 'array', items: ACTION, maxItems: 8 },
    status: { type: 'string', enum: ['continue', 'done', 'stuck'] },
    say: { type: 'string' },
    unknown: { type: 'string' },
    learned: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['rule', 'ui'] }, fact: { type: 'string' }, quote: { type: 'string' } },
        required: ['kind', 'fact', 'quote']
      }
    }
  },
  required: ['screen', 'observe', 'memo', 'actions', 'status', 'say', 'unknown', 'learned']
};

export const GOALS = {
  enter: '从当前画面走到「卫戍协议」的模式选择界面（能看到入门协议 / 个人模拟 / 联合模拟这类入口）就算完成，到了就 status=done。'
    + '路上会有登录、公告、每日签到、活动弹窗：关掉或确认。主界面一般从「终端」进去，终端底部或活动区有「卫戍协议」入口。',
  solo: '开一局单人（个人模拟）的极速模拟并把它打完。'
    + '选策略时新手优先：歌利亚（血多）或杰西卡（定向找人）。每个休整期按资料运营：花完钱、摆好站位、点「准备就绪」开战。'
    + '整局结算后回到卫戍协议界面就 status=done。',
  coop: '进入「联合模拟」，选「标准模拟」，用随机匹配（快速匹配 / 自动匹配之类的按钮，不要自己建房、不要输入房间号）和陌生人组队，匹配成功后确认准备，把这一局打完。'
    + '如果有没打完的单人模拟提示，先放弃或结算掉它再去联合模拟。匹配中、等待其他玩家时就 wait。'
    + '联机特有的：开局选策略时可以选给队友送钱的（三块钱那种）但不强求；联防阶段（帮漏怪的队友接怪）自动进行，只需要等；领袖轮所有人合血一起打。'
    + '有队友发来的表情 / 聊天不用理。整局结算后回到卫戍协议界面就 status=done。',
  indie: '进入「个人模拟」里的「标准独立模拟」，选【补充】里指定的规程等级开一局并把它打完；那一级还锁着（显示通关上一级后开放）就别来回找解锁办法，直接选能选的最高一级开打。'
    + '选策略时新手优先：歌利亚（血多）或杰西卡（定向找人）。每个休整期按资料运营：花完钱、摆好站位、点「准备就绪」开战。'
    + '如果有没打完的模拟（暂离保留的），先继续把它打完。整局结算后回到卫戍协议界面就 status=done。'
};

function buildPrompt({ goal, look, history, memo, extra }) {
  const ocr = look.items
    .filter((i) => i.text.trim().length >= 1)
    .map((i) => `「${i.text}」(${i.x},${i.y})`)
    .join(' ');
  const hist = history.slice(-6).map((h, i) => `${i + 1}. [${h.screen}] ${h.actions}${h.note ? `（${h.note}）` : ''}`).join('\n') || '（刚开始）';
  const related = relevantLines(`${look.text} ${memo || ''}`);
  return [
    '你在用模拟器替主人玩《明日方舟》的「卫戍协议」，是一个认真学习的新玩家。下面是当前画面（截图上叠了 80 像素的黄色网格，上边和左边标了坐标）。',
    `坐标系：宽 ${W}、高 ${H}，左上角是 (0,0)。点按钮时点它的中心。`,
    `【这次的目标】${GOALS[goal] || goal}`,
    extra ? `【补充】${extra}` : '',
    `【你上一步留给自己的备忘】${memo || '（无）'}`,
    `【最近几步】\n${hist}`,
    `【画面上识别到的文字和中心坐标】${ocr || '（没有识别到文字）'}`,
    `【规则和原则】\n${baseKnowledge()}`,
    related.length ? `【画面上出现的干员 / 盟约 / 装备的资料】\n${related.join('\n')}` : '',
    learnedTail() ? `【之前自己学到的（有截图证据）】\n${learnedTail()}` : '',
    lessonsTail() ? `【之前几局复盘出来的经验（照做）】\n${lessonsTail()}` : '',
    '【怎么回答】',
    '- screen：这是什么界面（简短，比如「主界面」「终端」「卫戍协议模式选择」「休整期-商店打开」「作战中」「结算」「公告弹窗」）。',
    '- observe：你看到的关键信息（回合、目标生命、资金、商店里有谁、场上有谁、盟约几层…），不超过 150 字。',
    '- memo：留给下一步的自己：这局打算玩什么、已经做了什么、接下来要做什么。不超过 150 字。',
    '- actions：这一步要做的操作，按顺序执行，最多 8 个；只写你在画面上确实看到的目标。'
      + 'click 用 x,y；drag 用 x,y → x2,y2，ms 给 1200；部署干员的 drag 还要给 dir（朝向：敌人从哪边来就朝哪边，right/left/up/down），其它操作 dir 填 none；back 是安卓返回键；wait 用 ms 表示等多久（作战中、加载中就 wait 3000～8000）。'
      + '用不到的数字字段填 0。商店买东西、拖人上场会改变画面，一次别安排太多依赖新画面的操作，宁可分几步。',
    '- status：continue 继续；目标完成 done；连续几步都没进展、不知道怎么办 stuck。',
    '- say：值得跟群友说的事才说一句（比如合成了精锐、凑齐盟约、翻车掉血、领袖打得很爽、通关），像群友聊天一样口语、短，平常留空字符串。',
    '- learned：只有在画面上读到了资料里没有的、以后用得上的事实才写，最多 3 条。kind=rule（游戏规则 / 数值）时 quote 必须是画面上原样出现的文字；kind=ui（界面怎么操作，比如某个弹窗的关闭键在哪）时 quote 可以留空。不确定的不要写，不要编。',
    '- 自己纠错：最近几步里标了「点完画面几乎没变」，说明那个办法不对——别再点同一个地方，换办法（点卡片本身 / 点按钮正中、先关挡住的弹窗或提示、改成拖动、按返回、等一下再看）。'
      + '换了办法成功以后，把「这个界面要怎么操作才行」写进 learned（kind=ui），以后就不会再犯。',
    '- unknown：这一屏有你看不懂、资料里也没有的东西（某个图标、按钮、机制是什么意思），用一句话写下来，留给以后查清楚；没有就留空字符串。不懂的地方先用最稳妥的办法过去，别卡着不动。',
    '- 绝对不要点花源石、充值、礼包、寻访招募、账号设置、退出登录相关的东西。'
  ].filter(Boolean).join('\n\n');
}

// ── 结果检查 ───────────────────────────────────────────────────────────

const inRange = (a) => a.x >= 0 && a.x <= W && a.y >= 0 && a.y <= H;

/** 把 Codex 给的操作清洗一遍：坐标越界的、类型不对的丢掉；drag 的终点也要在屏幕内。 */
export function cleanActions(actions) {
  const out = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || !['click', 'drag', 'back', 'wait'].includes(a.type)) continue;
    if (a.type === 'click' && !inRange(a)) continue;
    if (a.type === 'drag' && !(inRange(a) && inRange({ x: a.x2, y: a.y2 }))) continue;
    out.push({ ...a, ms: Math.max(0, Math.min(15000, Number(a.ms) || 0)) });
  }
  return out.slice(0, 8);
}

const squash = (s) => String(s || '').replace(/[\s，。,.:：;；!！?？「」"'“”【】\[\]（）()]/g, '');

/** 把有证据的新知识写进 learned.md；没证据的丢掉。返回实际写进去的条数。 */
export function recordLearned(learned, look) {
  let n = 0;
  const screenText = squash(look.items.map((i) => i.text).join(''));
  const existing = (() => { try { return fs.readFileSync(LEARNED, 'utf8'); } catch { return ''; } })();
  for (const l of Array.isArray(learned) ? learned : []) {
    const fact = String(l?.fact || '').trim().slice(0, 200);
    if (fact.length < 6 || existing.includes(fact)) continue;
    const quote = squash(l.quote);
    if (l.kind === 'rule' && (quote.length < 4 || !screenText.includes(quote))) continue;   // 规则类没原文就不记
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const ev = path.join(EVIDENCE_DIR, path.basename(look.file));
    try { fs.copyFileSync(look.file, ev); } catch { continue; }
    if (!fs.existsSync(LEARNED)) fs.writeFileSync(LEARNED, '# 玩的时候自己学到的（每条都有截图证据，在 data/ark-garrison/evidence/）\n\n', 'utf8');
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(LEARNED, `- [${day}] ${l.kind === 'rule' ? '规则' : '界面'}：${fact}${l.quote ? `（原文「${String(l.quote).slice(0, 60)}」）` : ''}（截图 ${path.basename(ev)}）\n`, 'utf8');
    n++;
  }
  return n;
}

const QUESTIONS = path.join(KB_DIR, 'questions.md');

/** 「没看懂的」记进 questions.md（附截图），以后查清楚了再挪进资料。重复的不记。返回是否写入。 */
export function recordQuestion(text, look) {
  const q = String(text || '').trim().slice(0, 200);
  if (q.length < 6) return false;
  const existing = (() => { try { return fs.readFileSync(QUESTIONS, 'utf8'); } catch { return ''; } })();
  if (existing.includes(q)) return false;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const ev = path.join(EVIDENCE_DIR, path.basename(look.file));
  try { fs.copyFileSync(look.file, ev); } catch { return false; }
  if (!fs.existsSync(QUESTIONS)) fs.writeFileSync(QUESTIONS, '# 玩的时候没看懂、要查清楚的（每条有截图，在 data/ark-garrison/evidence/）\n\n', 'utf8');
  fs.appendFileSync(QUESTIONS, `- [${new Date().toISOString().slice(0, 10)}] ${q}（截图 ${path.basename(ev)}）\n`, 'utf8');
  return true;
}

/**
 * 问一次 Codex。ask 是 codex.run 能力（runOnce）。
 * 返回 { ok, decision } 或 { ok:false, error }。
 */
export async function decide({ ask, goal, look, history, memo, extra = '', effort = 'low' }) {
  const prompt = buildPrompt({ goal, look, history, memo, extra });
  const images = [look.grid || look.file];
  const r = await ask({ prompt, images, schema: DECISION_SCHEMA, effort, search: false, timeoutMinutes: 4 });
  if (!r?.ok) return { ok: false, error: r?.error || 'Codex 没有回应' };
  const d = r.json || {};
  return { ok: true, decision: { ...d, actions: cleanActions(d.actions) } };
}

export const __internal = { buildPrompt, loadIndex, squash, LEARNED, QUESTIONS };
