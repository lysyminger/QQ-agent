// 卫戍协议陪玩（plugins/ark-garrison）的纯逻辑：快速规则、危险操作拦截、学到的知识要有原文证据。
// 不连模拟器、不调 Codex。
//   node test/ark-garrison-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ark-'));
const { quickRule, guardActions } = await import('../plugins/ark-garrison/runner.js');
const { cleanActions, recordLearned, relevantLines, __internal } = await import('../plugins/ark-garrison/agent.js');

const item = (text, x, y) => ({ text, x, y, box: [x - 10, y - 5, 20, 10] });
const look = (items, file = '') => ({ items, text: items.map((i) => i.text).join(' '), file });

// ── 联机倒计时：两位数、三位数（后半段休整超过 99 秒） ──
{
  const shot = path.resolve('data/ark-garrison/probe/cal-b1.png');
  if (fs.existsSync(shot)) {
    const { decodeRgb } = await import('../plugins/ark-garrison/tiles.js');
    const { readCountdown } = await import('../plugins/ark-garrison/screen.js');
    const rgb = await decodeRgb(shot);
    assert.equal(readCountdown(rgb), 36);
    // 百位格（x 1101～1126）照十位（1133～1158）抄一份 → 336
    const d = Buffer.from(rgb.data);
    for (let y = 20; y < 76; y++) for (let x = 0; x < 26; x++) for (let k = 0; k < 3; k++) d[(y * rgb.w + 1101 + x) * 3 + k] = rgb.data[(y * rgb.w + 1133 + x) * 3 + k];
    assert.equal(readCountdown({ ...rgb, data: d }), 336, '三位数倒计时');
  }
}

// ── 开局三步：认步骤、从路线里取首选 / 备选策略 ──
{
  const { openingStep, wantedStrategies } = await import('../plugins/ark-garrison/opening.js');
  assert.equal(openingStep(look([item('确认本局信息', 690, 44)])), 1);
  assert.equal(openingStep(look([item('选择策略', 680, 44), item('泛用型策略', 790, 150)])), 2);
  assert.equal(openingStep(look([item('确定自选编队', 700, 44)])), 3);
  assert.equal(openingStep(look([item('选择策略', 680, 400)])), 0, '不在顶上的不算');
  assert.deepEqual(wantedStrategies('开局策略：首选阿米娅；备选歌利亚，40生命容错更高；节奏'), ['阿米娅', '歌利亚']);
  assert.deepEqual(wantedStrategies('开局策略：首选杰西卡（定向找人）；备选歌利亚'), ['杰西卡', '歌利亚']);
  assert.deepEqual(wantedStrategies(''), []);
}

// ── 自动站位：围着「守点往出生点三成处」抱团，不再近战贴出生点、远程丢角落 ──
{
  const { placeTile, autoTile } = await import('../plugins/ark-garrison/moves.js');
  // 一排格子从 x=400 到 1100（y=360），再加两块偏离路线的（y=200）
  const tiles = [400, 475, 550, 625, 700, 775, 850, 925, 1000, 1075].map((x) => ({ x, y: 360 })).concat([{ x: 550, y: 200 }, { x: 1000, y: 200 }]);
  const marks = { spawn: { x: 1150, y: 360 }, target: { x: 350, y: 360 }, friends: [] };
  const front = placeTile(tiles, 'auto-front', marks);
  assert.equal(front.y, 360, '近战站在路上');
  assert.ok(front.x >= 550 && front.x <= 700, `近战在守点往前三成附近，不是贴着出生点：${front.x}`);
  assert.equal(autoTile(tiles, 'auto-front').x, 1075, '老规则是最右');
  const back = placeTile(tiles.filter((t) => t !== front), 'auto-back', { ...marks, friends: [front] });
  assert.ok(Math.hypot(back.x - front.x, back.y - front.y) < 160, `远程挨着挡怪的：${JSON.stringify(back)}`);
  // 没有红框：退回老规则
  assert.equal(placeTile(tiles, 'auto-front', {}).x, 1075);
  // 医疗贴着自己人
  const heal = placeTile(tiles.filter((t) => t !== front), 'auto-heal', { ...marks, friends: [front] });
  assert.ok(Math.hypot(heal.x - front.x, heal.y - front.y) <= 80, `医疗挨着前排：${JSON.stringify(heal)}`);
  // 朝向朝出生点
  const { faceToward } = await import('../plugins/ark-garrison/moves.js');
  assert.equal(faceToward({ x: 600, y: 360 }, { x: 1150, y: 360 }), 'right');
  assert.equal(faceToward({ x: 600, y: 360 }, { x: 100, y: 380 }), 'left');
  assert.equal(faceToward({ x: 600, y: 200 }, { x: 650, y: 500 }), 'down');
  const { spotFor } = await import('../plugins/ark-garrison/turn.js');
  const { loadPool: lp } = await import('../plugins/ark-garrison/sim.js');
  const medic = lp().find((p) => /医疗/.test(p.cls));
  if (medic) assert.equal(spotFor(medic.name), 'auto-heal');
}

// ── 快速规则 ──
{
  assert.equal(quickRule(look([item('今日配给', 640, 150)])).actions[0].x, 640, '每日配给点对勾');
  assert.equal(quickRule(look([item('入门协议', 180, 30), item('0/2', 640, 30)])).screen, '作战中', '顶部正中「击杀/总数」= 作战中');
  assert.equal(quickRule(look([item('O/2', 650, 25)])).screen, '作战中', 'OCR 把 0 认成 O 也算');
  assert.equal(quickRule(look([])).screen, '加载中', '一个字都没有 = 加载中');
  assert.equal(quickRule(look([item('回合', 460, 30), item('刷新', 1200, 450)])), null, '休整期交给 Codex');
  assert.equal(quickRule(look([item('3/9', 640, 300)])), null, '不在顶部正中的分数不算作战');
}

// ── 危险确认框只放行取消 / 返回 ──
{
  const pay = look([item('是否花费源石', 640, 300), item('确认', 760, 500), item('取消', 520, 500)]);
  const g = guardActions(pay, [{ type: 'click', x: 760, y: 500 }, { type: 'click', x: 522, y: 498 }]);
  assert.equal(g.blocked, 1);
  assert.deepEqual(g.actions.map((a) => a.x), [522], '只留下点取消');
  const g2 = guardActions(pay, [{ type: 'click', x: 760, y: 500 }]);
  assert.equal(g2.actions[0].type, 'back', '全被拦下就按返回');
  const shop = look([item('夏栎', 690, 670), item('确认购买', 690, 560), item('源石溶剂', 370, 670), item('刷新', 1200, 450)]);
  assert.equal(guardActions(shop, [{ type: 'click', x: 690, y: 560 }]).blocked, 0, '卫戍商店的「确认购买」花的是局内资金，放行');
  const store = look([item('确认购买', 640, 500), item('源石', 600, 300)]);
  assert.equal(guardActions(store, [{ type: 'click', x: 640, y: 500 }]).blocked, 1, '花源石的「确认购买」要拦');
  const safe = look([item('公开招募', 900, 400), item('终端', 1000, 200)]);
  assert.equal(guardActions(safe, [{ type: 'click', x: 1000, y: 200 }]).blocked, 0, '主界面上有「公开招募」字样不算危险');
}

// ── 操作清洗 ──
{
  const out = cleanActions([
    { type: 'click', x: 100, y: 100 },
    { type: 'click', x: 2000, y: 100 },
    { type: 'drag', x: 100, y: 600, x2: 500, y2: 900 },
    { type: 'tap', x: 1, y: 1 },
    { type: 'wait', x: 0, y: 0, ms: 999999 }
  ]);
  assert.deepEqual(out.map((a) => a.type), ['click', 'wait'], '越界的点击 / 拖动和未知类型丢掉');
  assert.equal(out[1].ms, 15000, '等待最多 15 秒');
}

// ── 资料匹配 ──
{
  const lines = relevantLines('商店：渡桥 慕斯 维多利亚');
  assert.ok(lines.some((l) => l.startsWith('渡桥(先锋)')), '干员特质');
  assert.ok(lines.some((l) => l.startsWith('渡桥（30）')), '同名策略也带上');
  assert.ok(lines.some((l) => l.startsWith('| 维多利亚 |')), '核心盟约公式');
}

// ── 学到的知识要有原文 ──
{
  const learned = __internal.LEARNED;
  const backup = fs.existsSync(learned) ? fs.readFileSync(learned, 'utf8') : null;
  const shot = path.join(process.env.QQ_AGENT_DATA_DIR, 'shot.png');
  fs.writeFileSync(shot, 'x');
  try {
    if (fs.existsSync(learned)) fs.rmSync(learned);
    const l = look([item('核心盟约组选择倒计时49秒', 640, 100)], shot);
    const n = recordLearned([
      { kind: 'rule', fact: '开局要在倒计时内选核心盟约组', quote: '核心盟约组选择' },
      { kind: 'rule', fact: '这是我编的规则不在画面上', quote: '每回合送十资金' },
      { kind: 'ui', fact: '核心盟约选择界面左右两组点卡片本身选', quote: '' }
    ], l);
    assert.equal(n, 2, '编的那条（原文不在画面上）不记');
    const text = fs.readFileSync(learned, 'utf8');
    assert.match(text, /开局要在倒计时内选核心盟约组/);
    assert.doesNotMatch(text, /我编的/);
    assert.equal(recordLearned([{ kind: 'rule', fact: '开局要在倒计时内选核心盟约组', quote: '核心盟约组选择' }], l), 0, '重复的不再记');
  } finally {
    if (backup === null) fs.rmSync(learned, { force: true });
    else fs.writeFileSync(learned, backup, 'utf8');
  }
}

// ── 点了没反应的判断 ──
{
  const { sameScreen } = await import('../plugins/ark-garrison/runner.js');
  const a = look([item('回合', 460, 30), item('刷新', 1200, 450), item('夏栎', 690, 670)]);
  const b = look([item('回合', 460, 30), item('刷新', 1200, 450), item('夏栎', 690, 670), item('x', 5, 5)]);
  const c = look([item('回合', 460, 30), item('刷新', 1200, 450), item('确认购买', 690, 560)]);
  assert.equal(sameScreen(a, b), true, '只多了个单字乱码，算没变');
  assert.equal(sameScreen(a, c), false, '出现了新按钮，算变了');
}

// ── 没看懂的记进 questions.md ──
{
  const { recordQuestion } = await import('../plugins/ark-garrison/agent.js');
  const q = __internal.QUESTIONS;
  const backup = fs.existsSync(q) ? fs.readFileSync(q, 'utf8') : null;
  const shot = path.join(process.env.QQ_AGENT_DATA_DIR, 'shot2.png');
  fs.writeFileSync(shot, 'x');
  try {
    if (fs.existsSync(q)) fs.rmSync(q);
    assert.equal(recordQuestion('右上角那个沙漏图标是什么意思', look([], shot)), true);
    assert.equal(recordQuestion('右上角那个沙漏图标是什么意思', look([], shot)), false, '重复的不记');
    assert.equal(recordQuestion('', look([], shot)), false, '空的不记');
    assert.match(fs.readFileSync(q, 'utf8'), /沙漏图标/);
  } finally {
    if (backup === null) fs.rmSync(q, { force: true });
    else fs.writeFileSync(q, backup, 'utf8');
  }
}

// ── 额度用完：等 Cockpit 换号 ──
{
  const Q = await import('../plugins/ark-garrison/quota.js');
  const { runGoal } = await import('../plugins/ark-garrison/runner.js');
  assert.ok(Q.isQuotaError("You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM."));
  assert.ok(Q.isQuotaError('unexpected status 429 Too Many Requests'));
  assert.ok(!Q.isQuotaError('没有输出'));
  assert.ok(!Q.isQuotaError('超过 4 分钟'));

  const base = new Date(2026, 10, 10, 14, 0, 0).getTime();
  assert.equal(Q.parseRetryAt('try again in 2 hours 5 minutes.', base), base + 125 * 60000);
  assert.equal(Q.parseRetryAt('try again at 3:05 PM.', base), new Date(2026, 10, 10, 15, 5).getTime());
  assert.equal(Q.parseRetryAt('try again at 1:00 PM.', base), new Date(2026, 10, 11, 13, 0).getTime(), '已经过了的钟点算明天');
  assert.equal(Q.parseRetryAt('try again at Nov 12th, 2026 9:30 AM.', base), new Date(2026, 10, 12, 9, 30).getTime());
  assert.equal(Q.parseRetryAt('usage limit reached', base), null);

  // 从 id_token 认号，不需要验签
  const jwt = (p) => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`;
  const authFile = path.join(process.env.QQ_AGENT_DATA_DIR, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { account_id: 'acc', id_token: jwt({ email: 'B@x.com', 'https://api.openai.com/auth': { chatgpt_user_id: 'u2', chatgpt_account_id: 'acc', chatgpt_plan_type: 'plus' } }) } }));
  const me = Q.readCurrentAccount(authFile);
  assert.equal(me.key, 'u2:acc');
  assert.equal(me.email, 'b@x.com');
  const cockpitDir = path.join(process.env.QQ_AGENT_DATA_DIR, 'cockpit');
  fs.mkdirSync(cockpitDir, { recursive: true });
  fs.writeFileSync(path.join(cockpitDir, 'codex_accounts.json'), JSON.stringify({ accounts: [{ id: 'c1', email: 'a@x.com', plan_type: 'team' }, { id: 'c2', email: 'b@x.com', plan_type: 'plus' }, { id: 'c3', email: 'c@x.com', plan_type: 'team' }], current_account_id: 'c2' }));
  fs.writeFileSync(path.join(cockpitDir, 'config.json'), JSON.stringify({ codex_auto_switch_enabled: true, codex_auto_refresh_minutes: 10 }));
  const cp = Q.readCockpit([path.join(process.env.QQ_AGENT_DATA_DIR, 'nope'), cockpitDir]);
  assert.equal(cp.accounts.length, 3);
  assert.equal(cp.autoSwitch, true);
  assert.equal(Q.accountLabel(me, cp), '2 号（plus）', '群里只说第几号，不说邮箱');

  // 假时钟 + 假账号：模拟 Cockpit 在第 3 次轮询时换了号
  const A = { key: 'a', email: 'a@x.com', plan: 'team' };
  const B = { key: 'b', email: 'b@x.com', plan: 'plus' };
  const C = { key: 'c', email: 'c@x.com', plan: 'team' };
  const fake = (seq) => {
    let t = base;
    let i = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; i++; }, readAccount: () => seq(i), readCockpitState: () => cp, said: [] };
  };
  Q.resetQuotaState();
  let f = fake((i) => (i >= 3 ? B : A));
  let w = await Q.waitForQuota({ error: 'usage limit, try again in 3 hours', ...f, report: async (t) => f.said.push(t) });
  assert.deepEqual([w.ok, w.how], [true, 'switched']);
  assert.match(f.said[0], /1 号（team）的 Codex 额度用完了.*等 Cockpit 自动换号/);
  assert.match(f.said[1], /换到2 号（plus）了/);

  // 换到的号也用完了 → 再进来时不能又换回 1 号（1 号还没恢复）
  f = fake((i) => (i >= 2 ? A : B));
  w = await Q.waitForQuota({ error: 'usage limit', ...f, maxMinutes: 3, probeMinutes: 60, report: async (t) => f.said.push(t) });
  assert.equal(w.ok, false, '只换回一个没恢复的号，不算换好');
  assert.equal(w.status, 'quota');

  // 三个号都用完、看不出恢复时间：过一会儿放它再试；同一个号第二次进来不重复说
  Q.resetQuotaState();
  for (const acc of [A, B]) { f = fake(() => acc); await Q.waitForQuota({ error: 'usage limit, try again in 5 hours', ...f, maxMinutes: 0.01 }); }
  Q.resetQuotaState();
  f = fake(() => C);
  w = await Q.waitForQuota({ error: '429 rate limit', ...f, maxMinutes: 60, probeMinutes: 5, report: async (t) => f.said.push(t) });
  assert.deepEqual([w.ok, w.how], [true, 'retry']);
  assert.equal(f.said.length, 1);
  w = await Q.waitForQuota({ error: '429 rate limit', ...f, maxMinutes: 60, probeMinutes: 5, report: async (t) => f.said.push(t) });
  assert.equal(f.said.length, 1, '同一个号还在等，不重复刷屏');

  // 有恢复时间：到点就接着打
  Q.resetQuotaState();
  f = fake(() => A);
  w = await Q.waitForQuota({ error: 'usage limit, try again in 30 minutes', ...f, maxMinutes: 60, report: async (t) => f.said.push(t) });
  assert.deepEqual([w.ok, w.how], [true, 'recovered']);

  // 叫停要马上停
  Q.resetQuotaState();
  const ac = new AbortController();
  f = fake(() => A);
  const slow = { ...f, sleep: async (ms) => { ac.abort(); await f.sleep(ms); } };
  w = await Q.waitForQuota({ error: 'usage limit', ...slow, signal: ac.signal });
  assert.equal(w.status, 'stopped');

  // runner：额度报错不算 Codex 出错，等完换号后同一步重来
  Q.resetQuotaState();
  let calls = 0;
  let waited = 0;
  const shot = path.join(process.env.QQ_AGENT_DATA_DIR, 'shot-q.png');
  fs.writeFileSync(shot, 'x');
  const screen = look([item('卫戍协议', 300, 300), item('个人模拟', 600, 400)], shot);
  const eyes = { look: async () => screen, gridFor: async () => shot, sleep: async () => {}, tap: async () => {}, drag: async () => {}, back: async () => {} };
  const ask = async () => {
    calls++;
    if (calls <= 4) return { ok: false, error: "You've hit your usage limit." };
    return { ok: true, json: { screen: '卫戍协议模式选择', observe: '', memo: '', actions: [], status: 'done', say: '', unknown: '', learned: [] } };
  };
  const res = await runGoal('enter', { eyes, ask, report: async () => {}, quotaWait: async () => { waited++; return { ok: true, how: 'switched' }; } });
  assert.equal(res.ok, true, '连着 4 次额度报错也不会因为「Codex 连续出错」停掉');
  assert.equal(waited, 4);
  assert.equal(res.steps, 1, '等额度的那几次不占步数');
  const res2 = await runGoal('enter', { eyes, ask: async () => ({ ok: false, error: 'usage limit' }), report: async () => {}, quotaWait: async () => ({ ok: false, status: 'quota', reason: '都用完了' }) });
  assert.deepEqual([res2.ok, res2.status, res2.reason], [false, 'quota', '都用完了']);
}

// ── 识别层 / 回合清单校验（不连模拟器）──
{
  const S = await import('../plugins/ark-garrison/screen.js');
  const { checkOp } = await import('../plugins/ark-garrison/turn.js');
  assert.equal(S.toNum('Z'), 7, 'Z 是 7');
  assert.equal(S.toNum(':7'), 7);
  assert.equal(S.toNum('29'), 29);
  assert.equal(S.toNum('@'), null, '认不出就是 null');
  assert.equal(S.cleanName('入陨星', ['陨星', '星源']), '陨星', '前面多出来的图标字去掉');
  assert.equal(S.cleanName('兆瑰盐', []), '瑰盐', '名字表里没有：去掉第一个字');
  assert.equal(S.cleanName('慕斯', []), '慕斯');
  const rest = look([item('休息', 645, 30), item('回合', 460, 33), item('收起×', 1190, 673)]);
  assert.deepEqual(S.classify(rest), { kind: 'rest', shopOpen: true });
  assert.equal(S.classify(look([item('休息', 645, 30), item('<展开', 1182, 673)])).shopOpen, false);
  assert.equal(S.classify(look([item('休息', 645, 30), item('回合', 676, 335), item('获得', 808, 333)])).kind, 'roundBanner');
  assert.equal(S.classify(look([item('确认准备吗?', 640, 292), item('确认', 970, 484)])).kind, 'readyConfirm');
  assert.equal(S.classify(look([item('回合', 460, 33), item('3/6', 656, 29)])).kind, 'battle');
  assert.equal(S.classify(look([item('回合', 460, 33), item('开始作战', 650, 30)])).kind, 'battle', '开战过渡镜头也算作战');
  assert.equal(S.classify(look([item('终端', 100, 670)])).kind, 'other');
  assert.deepEqual(S.classify(look([item('休息', 645, 30), item('回到决策', 1240, 381), item('正在决策…', 640, 649)])), { kind: 'decisionHidden', tap: [1240, 381] }, '收起的战术决策要先点回去');
  assert.deepEqual(S.benchPos(0), [915, 465]);
  assert.deepEqual(S.benchPos(1), [834, 465]);
  assert.equal(S.toNum('IO'), 10, '两位数 10 读成 IO');
  assert.equal(S.toNum('T'), 1);

  const ctx = { tiles: [{ x: 1, y: 1 }, { x: 2, y: 2 }], bench: ['陨星', null, '慕斯'] };
  assert.equal(checkOp({ op: 'buy', slot: 3 }, ctx), '');
  assert.match(checkOp({ op: 'buy', slot: 6 }, ctx), /不在 1～5/);
  assert.equal(checkOp({ op: 'deploy', unit: '慕斯', tile: 1, dir: 'right' }, ctx), '');
  assert.match(checkOp({ op: 'deploy', unit: '夏栎', tile: 1, dir: 'right' }, ctx), /整备区没有/);
  assert.match(checkOp({ op: 'deploy', unit: '慕斯', tile: 5, dir: 'right' }, ctx), /没有 5 号格子/);
  assert.equal(checkOp({ op: 'deploy', unit: '慕斯', tile: -1, dir: 'right' }, ctx), '', 'tile=-1 让程序自动找格子');
  assert.match(checkOp({ op: 'deploy', unit: '慕斯', tile: 0, dir: 'none' }, ctx), /朝向/);
  assert.match(checkOp({ op: 'click', x: 1 }, ctx), /不认识/);
}

{
  const S = await import('../plugins/ark-garrison/screen.js');
  assert.deepEqual(S.readSettle(look([item('规程等级1', 140, 30), item('模拟中断', 640, 200), item('通过回合', 600, 300), item('12', 680, 300), item('返回主页', 1180, 660)])).result, 'lose');
  assert.equal(S.readSettle(look([item('模拟中断', 640, 200), item('通过回合 7', 600, 300), item('返回主页', 1180, 660)])).rounds, 7);
  assert.equal(S.readSettle(look([item('休息', 645, 30), item('回合', 460, 33)])), null, '休整期不是结算');
}

// ── 本地假游戏跑回合流程（sim.js）：换人、换钱装备、三合一、联机倒计时 ──
{
  const { FakeGame, makeFakeIo, makeRuleBrain, loadPool } = await import('../plugins/ark-garrison/sim.js');
  const { playRest } = await import('../plugins/ark-garrison/turn.js');
  const pool = loadPool();
  const known = pool.map((p) => p.name);
  const unit = (tier) => { const p = pool.find((x) => x.tier === tier); return { name: p.name, tier, tags: p.tags, elite: false }; };
  const noBuy = async () => ({ ok: true, json: { think: '', memo: '', say: '', ops: [{ op: 'ready', slot: -1, unit: '', tile: -1, dir: 'none', to: '' }] } });

  // 场上满 8 个Ⅰ阶，木板上一个Ⅲ阶：开战前应该换上去
  {
    const g = new FakeGame({ seed: 3, pool });
    const t1 = pool.filter((p) => p.tier === 1).slice(0, 8);
    g.board = t1.map((p, i) => ({ name: p.name, tier: 1, tags: p.tags, elite: false, tile: i }));
    g.bench[0] = unit(3); g.shop = []; g.funds = 0;
    const r = await playRest({ io: makeFakeIo(g), ask: noBuy, bench: [], board: [], known });
    assert.ok(r.readied, '换完人开战');
    assert.ok(g.log.at(-1).includes('场上 8 人'));
    assert.ok(r.notes.some((n) => /自动换人.*上场成功/.test(n)), `场上满了要把高阶的换上去：${r.notes.join(' ')}`);
  }
  // 场上满 8 个Ⅲ阶，木板上一个Ⅵ阶：换人时把场上最弱的撤回木板留着（Ⅲ阶以后还能凑对子），不是直接卖
  {
    const g = new FakeGame({ seed: 4, pool });
    const t3 = pool.filter((p) => p.tier === 3).slice(0, 8);
    g.board = t3.map((p, i) => ({ name: p.name, tier: 3, tags: p.tags, elite: false, tile: i }));
    g.bench[0] = unit(6); g.shop = []; g.funds = 0;
    const r = await playRest({ io: makeFakeIo(g), ask: noBuy, bench: [], board: [], known });
    assert.ok(r.notes.some((n) => /自动换人：撤下场上.*成功/.test(n)), `高阶的人换下来要撤回木板：${r.notes.join(' ')}`);
    assert.ok(g.bench.some((u) => u && u.tier === 3), '撤下的Ⅲ阶留在木板上');
    assert.ok(g.board.some((u) => u.tier === 6), 'Ⅵ阶换上场');
  }
  // 场上满、没钱、木板空：这回合什么都不用做，也要撤一个再放回去（联机连着几回合不动会被判挂机）
  {
    const g = new FakeGame({ seed: 5, pool });
    const t2 = pool.filter((p) => p.tier === 2).slice(0, 8);
    g.board = t2.map((p, i) => ({ name: p.name, tier: 2, tags: p.tags, elite: false, tile: i }));
    g.shop = []; g.funds = 0;
    const r = await playRest({ io: makeFakeIo(g), ask: noBuy, bench: [], board: [], known, mem: {} });
    assert.ok(r.readied, '开战');
    assert.ok(r.notes.some((n) => /还没动过.*撤下.*再放回去/.test(n)), `没事做也要动一下：${r.notes.join(' ')}`);
    assert.equal(g.board.length, 8, '撤下的又放回场上了');
  }
  // 场上有个位置被认成装备名（点开详情读错了）：换人不拿它当最弱的去卖
  {
    const { swapValue } = await import('../plugins/ark-garrison/turn.js');
    assert.ok(swapValue(pool[0].name, { elites: new Set([pool[0].name]) }) > swapValue(pool[0].name) * 2, '精锐算两倍多');
  }
  // 场上满了、木板上堆了 8 个不成对的Ⅰ阶：开战前清掉，留 4 个左右
  {
    const g = new FakeGame({ seed: 8, pool });
    const t1 = pool.filter((p) => p.tier === 1);
    g.board = t1.slice(0, 8).map((p, i) => ({ name: p.name, tier: 1, tags: p.tags, elite: false, tile: i }));
    t1.slice(8, 16).forEach((p, k) => { g.bench[k] = { name: p.name, tier: 1, tags: p.tags, elite: false }; });
    g.shop = []; g.funds = 0;
    const r = await playRest({ io: makeFakeIo(g), ask: noBuy, bench: [], board: [], known });
    assert.ok(g.bench.filter(Boolean).length <= 5, `木板堵了要清：还剩 ${g.bench.filter(Boolean).length} 个；${r.notes.join(' ')}`);
  }
  // 换钱类装备：一拿到就用掉
  {
    const g = new FakeGame({ seed: 4, pool });
    g.board = [{ ...unit(1), tile: 0 }]; g.bench[0] = { name: '盟约之币', tier: 1, tags: [], equip: true, money: true }; g.shop = []; g.funds = 0;
    const r = await playRest({ io: makeFakeIo(g), ask: noBuy, bench: [], board: [], known });
    assert.ok(r.notes.some((n) => /自动用掉 盟约之币成功/.test(n)), `盟约之币要自动用掉：${r.notes.join(' ')}`);
  }
  // 三合一：已有两个同名，商店出第三张、买得起 → 自动买
  {
    const g = new FakeGame({ seed: 5, pool });
    const p = pool.find((x) => x.tier === 1);
    g.bench[0] = unit(1); g.bench[1] = unit(1); g.shop = [{ ...p, cost: 2 }]; g.funds = 2;
    const r = await playRest({ io: makeFakeIo(g), ask: noBuy, bench: [], board: [], known });
    assert.ok(r.notes.some((n) => /自动三合一：买 .*成功/.test(n)), `要自动三合一：${r.notes.join(' ')}`);
    assert.ok(g.log.some((l) => /三合一/.test(l)));
  }
  // 联机倒计时只剩 20 秒：不问模型，直接补满场开打
  {
    const g = new FakeGame({ seed: 6, pool });
    g.bench[0] = unit(1); g.bench[1] = unit(1);
    let asked = 0;
    const io = { ...makeFakeIo(g), countdown: async () => 20 };
    const r = await playRest({ io, ask: async (o) => { asked++; return noBuy(o); }, bench: [], board: [], known });
    assert.equal(asked, 0, '来不及问就别问');
    assert.ok(r.readied);
    assert.ok(g.board.length >= 2, '木板上的人要补上场');
  }
  // 整局跑 5 局：流程不卡、每回合问模型不超过 1.3 次
  {
    let asks = 0; let rests = 0;
    for (let s = 1; s <= 5; s++) {
      const g = new FakeGame({ seed: 100 + s, pool });
      const io = makeFakeIo(g); const ask = makeRuleBrain(g, { upgradeAt: 4 }); const bench = []; const board = [];
      while (!g.over) {
        g.readied = false;
        const r = await playRest({ io, ask, bench, board, known });
        asks += r.asks; rests++;
        assert.ok(g.readied || g.over, `第 ${g.round} 回合没走到开战：${r.why || r.notes.join(' ')}`);
      }
    }
    assert.ok(asks / rests <= 1.3, `每回合问 ${asks / rests} 次`);
  }
}

// ── 规则规划器（planner.js）──
{
  const { planRound, targetLevel, routeBonds } = await import('../plugins/ark-garrison/planner.js');
  assert.equal(targetLevel(1), 1); assert.equal(targetLevel(7), 4); assert.equal(targetLevel(11), 6);
  assert.deepEqual(routeBonds('主玩「莱塔尼亚」，副 奥术 精准'), { core: '莱塔尼亚', subs: ['奥术', '精准'] });
  const st = { round: 4, funds: 6, remain: 3, upgradeCost: 0, refreshCost: 1, alliances: [],
    shop: [{ slot: 1, name: '慕斯', cost: 2, tags: ['维多利亚'], empty: false }, { slot: 2, name: '折桠', cost: 2, tags: ['乌萨斯', '不屈'], empty: false }] };
  const mem = { level: 2 };
  const p = planRound({ st, bench: [{ name: '慕斯' }, { name: '慕斯' }, { name: '陨星' }], board: [{ name: '烈夏' }], round: 4, extra: '', mem });
  const kinds = p.ops.map((o) => `${o.op}${o.slot > 0 ? o.slot : ''}${o.unit ? `:${o.unit}` : ''}`);
  assert.ok(kinds.includes('buy1'), `有两个慕斯、商店出了第三张要买：${kinds}`);
  assert.ok(kinds.includes('upgrade'), `升级免费要升：${kinds}`);
  assert.ok(kinds.some((k) => k.startsWith('deploy:')), `木板上的人要上场：${kinds}`);
  assert.equal(p.ops.at(-1).op, 'ready');
  assert.equal(mem.level, 3, '升了级要记下来');
}

console.log('ark-garrison-test: all passed');
