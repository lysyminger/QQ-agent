// "吃什么"自动推荐 + food_pick：用假发送器模拟群消息，不连 QQ。
//   node test/food-pick-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { isFoodAsk, pickShops, foodText, sendFoodPick, foodHint, foodAutoCheck, FOOD_PICK_TOOL, bindFood } = await import('../plugins/codex-bridge/food.js');
// index.js 能正常加载（新模块接上了、语法没坏）
await import('../plugins/codex-bridge/index.js');

const OWNER = process.env.QQ_AGENT_OWNER || '10000';
let cfg = { foodAuto: true, foodGroups: [] };
bindFood({ settings: () => cfg, ownerIds: () => [OWNER], messageText: (e) => String(e?.text || '') });

const shopsFile = JSON.parse(fs.readFileSync('data/codex-bridge/food/shops.json', 'utf8'));
const shops = shopsFile.shops;
assert.ok(shops.length >= 30, `店单至少 30 家（实际 ${shops.length}）`);
assert.ok(shops.every((s) => s.rating >= 4.5 && (!s.cost || s.cost <= 60) && s.distance <= 1500), '店单都满足 4.5 分 / 人均 60 / 1.5 公里');
assert.ok(shops.every((s) => !/暂停|装修|歇业|停业/.test(s.name)), '店单里没有停业的');
assert.ok(fs.existsSync('data/knowledge-base/learned/树人周边吃什么.md'), '知识库：吃什么词条');
assert.ok(fs.existsSync('data/knowledge-base/learned/浙江树人学院拱宸桥校区周边.md'), '知识库：周边总览词条');

// ── 识别 ──
const yes = ['今天吃什么', '中午吃啥', '饿了', '有人点外卖吗', '晚饭吃什么好', '夜宵吃啥', '吃点啥好呢', '附近有什么好吃的', '去哪吃饭', '喵喵今天吃哪家'];
const no = ['吃什么醋', '吃啥瓜', '你在吃什么', '我中午吃了麻辣烫', '吃什么药好', '饿了么会员', '今天天气不错', `${'很长的一段话'.repeat(10)}吃什么`];
for (const t of yes) assert.equal(isFoodAsk(t), true, `应识别：${t}`);
for (const t of no) assert.equal(isFoodAsk(t), false, `不应识别：${t}`);

// ── 挑店 ──
const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
assert.ok(pickShops({ keyword: '面' }, shops).every((s) => `${s.name}${s.category}${s.tags.join('')}`.includes('面')), '关键词过滤');
assert.ok(pickShops({ maxCost: 20, count: 5 }, shops).every((s) => !s.cost || s.cost <= 20), '人均过滤');
assert.ok(pickShops({ maxDistance: 500, count: 5 }, shops).every((s) => s.distance <= 500), '距离过滤');
assert.equal(pickShops({ count: 3 }, shops).length, 3, '挑 3 家');
assert.equal(new Set(pickShops({ count: 5 }, shops).map((s) => s.id)).size, 5, '一次挑多家不重复');
const exclude = shops.slice(1).map((s) => s.id);
assert.equal(pickShops({ exclude }, shops)[0].id, shops[0].id, '避开最近推过的');
assert.equal(pickShops({ keyword: '不存在的菜' }, shops).length, 0, '没有符合的返回空');

// 推荐是随口一句：一行、没有括号 / 表情 / 分类标签，店名的分店并进去
const branchShop = shops.find((s) => /[(（]/.test(s.name) && /[(（]/.test(s.address)) || shops[0];
const text = foodText(branchShop, seq([0]));
assert.ok(text.startsWith(`要不吃${branchShop.name.replace(/[()（）]/g, '')}`), `开头：${text}`);
assert.match(text, /4\.\d分，/);
assert.match(text, /离学校\d/);
assert.ok(!/[()（）「」📍\n]/u.test(text), `不带括号 / 表情 / 换行：${text}`);
assert.ok(!/高德|外卖 App|面馆粉店小吃|中餐小炒|汉堡炸鸡/.test(text), `不带说明和分类：${text}`);
const all = shops.map((s) => foodText(s));
assert.ok(all.every((t) => !/[()（）\n]/.test(t)), '45 家的推荐都没有括号');
for (const t of all.slice(0, 6)) console.log('  ', t);

// ── 自动推荐（假发送器） ──
const sent = [];
const fakeOrch = {
  sender: {
    async sendTextBatch(chatKey, msgs, opts = {}) { sent.push({ kind: 'text', chatKey, text: msgs[0], opts }); return { sent: [{}] }; },
    async sendImage(chatKey, img, opts = {}) { sent.push({ kind: 'image', chatKey, img, opts }); return {}; }
  }
};
const group = `group:food-test-${Date.now()}`;
const other = `${group}-2`;
const mk = (mid, text, extra = {}) => ({ id: mid, mid, senderId: '10001', text, ...extra });

const first = await sendFoodPick(fakeOrch, group, mk(1, '中午吃什么'));
assert.ok(first, '第一次问：推荐');
await new Promise((r) => setTimeout(r, 20));
assert.equal(sent[0].kind, 'text');
assert.equal(sent[0].opts.replyToMessageId, 1, '引用问的那条');
assert.ok(sent[0].text.includes(first.name.replace(/[()（）]/g, '')));
assert.equal(sent.length, 1, '只发一句文字，不再单独补发店铺照片');

const second = await sendFoodPick(fakeOrch, group, mk(2, '晚饭吃啥'));
assert.ok(second && second.id !== first.id, '同群紧接着再问：照样推荐，换一家');
assert.equal(foodAutoCheck(group, mk(2, '晚饭吃啥')).reason, 'done');
assert.equal(await sendFoodPick(fakeOrch, group, mk(1, '中午吃什么')), null, '同一条不重复发');
assert.ok(await sendFoodPick(fakeOrch, other, mk(3, '饿了')), '别的群独立冷却');
assert.equal(await sendFoodPick(fakeOrch, group, mk(4, '吃什么', { self: true })), null, '自己的消息不触发');
assert.equal(await sendFoodPick(fakeOrch, 'private:10001', mk(5, '吃什么')), null, '私聊不自动推荐');
assert.equal(await sendFoodPick(fakeOrch, group, mk(6, '今天天气不错')), null, '无关消息不触发');

// 不限次数：群友连着问每次都推荐，最近推过的不重复
const picks = [];
for (let i = 0; i < 12; i++) picks.push((await sendFoodPick(fakeOrch, group, mk(100 + i, '吃什么', { senderId: String(20000 + i) })))?.id);
assert.ok(picks.every(Boolean), '连问 12 次每次都推荐');
assert.equal(new Set([first.id, second.id, ...picks]).size, 14, '最近推过的不重复');

// 开关和群范围
cfg = { foodAuto: false, foodGroups: [] };
assert.equal(foodAutoCheck(`${group}-3`, mk(7, '吃什么')).reason, 'off', '关掉开关不推荐');
cfg = { foodAuto: true, foodGroups: ['123456'] };
assert.equal(foodAutoCheck(`${group}-3`, mk(8, '吃什么')).reason, 'off', '不在指定群不推荐');
assert.equal(foodAutoCheck('group:123456', mk(9, '吃什么')).ok, true, '指定的群推荐');
cfg = { foodAuto: true, foodGroups: [] };

// 引用失败时退回不引用再发
const flaky = { sender: { calls: 0, async sendTextBatch(c, m, o = {}) { this.calls++; if (o.replyToMessageId) throw new Error('引用的消息不存在'); return {}; } } };
assert.ok(await sendFoodPick(flaky, `${group}-4`, mk(10, '吃啥')), '引用失败也能发出去');
assert.equal(flaky.sender.calls, 2);

// ── 给大脑的提示 ──
globalThis.__codexBridge.orch = { sessions: { current: new Map([['s1', { trigger: [mk(1, '中午吃什么'), mk(50, '夜宵吃啥'), mk(6, '今天天气不错')] }]]) } };
const hint = foodHint('s1', group);
assert.match(hint, new RegExp(`#1 问吃什么，程序已经自动推荐了「${first.name.replace(/[()]/g, '\\$&')}」`), '提示：已推荐哪家');
assert.match(hint, /#50 像在问吃什么，自动推荐没发出去/, '提示：没发出去的');
assert.ok(!hint.includes('#6'), '无关消息不提示');
assert.equal(foodHint('s1', 'private:1'), '', '私聊没有提示');

// ── food_pick 工具 ──
const r1 = await FOOD_PICK_TOOL.execute({ chatKey: `${group}-5` }, { keyword: '火锅', count: 2 });
assert.ok(!r1.isError && /火锅/.test(r1.content), '按类别挑');
const r2 = await FOOD_PICK_TOOL.execute({ chatKey: `${group}-5` }, { maxCost: 20, maxDistance: 400 });
assert.ok(!r2.isError && r2.content.startsWith('· '), '近又便宜');
const r3 = await FOOD_PICK_TOOL.execute({}, { keyword: '佛跳墙' });
assert.match(r3.content, /没有符合条件/, '店单里没有就说没有');

console.log('food-pick: PASS（假发送器模拟，没有发 QQ 消息）');
console.log('样例推荐：\n' + sent[0].text);
console.log('火锅：\n' + r1.content);
console.log('近又便宜：\n' + r2.content);
