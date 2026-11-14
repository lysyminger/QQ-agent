// 表情包自动收集：离线测试（假消息 / 假看图 / 假收藏，不调模型、不发 QQ）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-sac-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const mod = await import('../plugins/sticker-auto-collect/index.js');
const { handle, stickerMediaOf, parseJudge, internals } = mod;

let pass = 0; let fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  [ok] ${name}`); } else { fail++; console.log(`  [FAIL] ${name}`); } };

let settings = { enabled: true, chance: 0, popularSenders: 2, maxPerDay: 2, maxAuto: 60 };
internals.setApi({ config: () => settings });
internals.reset();

const collected = [];
const orch = {
  onebot: {},
  stickers: {
    entries: [{ id: '3050532093_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0', qqFile: '' }],
    async collect(mid, { url, file, note }) { collected.push({ mid, url, file, note }); return { id: `collected_${mid}` }; }
  }
};
let verdict = { ok: true, desc: '猫猫震惊 不敢相信' };
let lastContext = '';
internals.deps.judge = async (_bytes, ctx) => { lastContext = ctx; return verdict; };
internals.deps.wait = async () => {};
const history = [];
orch.store = { recent: () => history };
internals.deps.fetchBytes = async () => Buffer.from('fakeimage');

const msg = (mid, sender, file, summary = '[动画表情]', self = false) => ({
  mid, senderId: sender, self, text: '[表情包]',
  media: [{ kind: 'image', file, url: 'https://multimedia.nt.qq.com.cn/x', summary }]
});

check('照片不算表情包', stickerMediaOf(msg(1, 'a', 'B1B1B1B1B1B1.jpg', '[图片]')).length === 0);
check('自己发的 file=0 不算', stickerMediaOf(msg(1, 'a', '0')).length === 0);
check('[动画表情] 算', stickerMediaOf(msg(1, 'a', 'C1C1C1C1C1C1.jpg')).length === 1);

check('私聊不收', (await handle(orch, 'private:1', msg(2, 'a', 'D1D1D1D1D1D1.jpg'))) === null);
check('自己发的不收', (await handle(orch, 'group:9', msg(3, 'a', 'D1D1D1D1D1D1.jpg', '[动画表情]', true))) === null);

// chance=0：第一个人发不收，第二个人发同一张 → 流行，收
const say = (sender, text) => ({ senderId: sender, senderName: sender, text, media: [] });
history.push(say('a', '紫卡只有26p'), msg(10, 'a', 'E1E1E1E1E1E1.jpg'), say('b', '对的'));
check('一个人发、不抽中 → 不收', (await handle(orch, 'group:9', msg(10, 'a', 'E1E1E1E1E1E1.jpg'))) === null);
check('同一人再发不算流行', (await handle(orch, 'group:9', msg(11, 'a', 'E1E1E1E1E1E1.jpg'))) === null);
history.push(say('c', '我把五百猪肉脯全换成赤毒了'), msg(12, 'b', 'E1E1E1E1E1E1.jpg'), say('c', '没事不亏'));
const r1 = await handle(orch, 'group:9', msg(12, 'b', 'E1E1E1E1E1E1.jpg'));
check('两个人发过 → 收', r1?.collected === '猫猫震惊 不敢相信' && collected.length === 1 && collected[0].mid === 12);
check('看图时带上两次出现的语境', /第 1 次[\s\S]*紫卡只有26p[\s\S]*a：【这张】[\s\S]*第 2 次[\s\S]*赤毒[\s\S]*b：【这张】\nc：没事不亏/.test(lastContext));
check('收过的不再收', (await handle(orch, 'group:9', msg(13, 'c', 'E1E1E1E1E1E1.jpg'))) === null && collected.length === 1);

// 随机抽中 + 看图拒绝
settings.chance = 1;
verdict = { ok: false, why: '聊天截图' };
const r2 = await handle(orch, 'group:9', msg(20, 'a', 'F1F1F1F1F1F1.jpg'));
check('看图说不合适 → 不收', r2?.rejected === '聊天截图' && collected.length === 1);
check('拒过的不再看', (await handle(orch, 'group:9', msg(21, 'b', 'F1F1F1F1F1F1.jpg'))) === null);

// 已经在库里的
const r3 = await handle(orch, 'group:9', msg(30, 'a', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.jpg'));
check('已在表情库 → 跳过', r3?.skipped === 'in-library');

// 每日上限 2
verdict = { ok: true, desc: '狗头 doge 阴阳' };
const r4 = await handle(orch, 'group:9', msg(40, 'a', 'G1G1G1G1G1G1.jpg'));
check('第二张收了', r4?.collected && collected.length === 2);
const r5 = await handle(orch, 'group:9', msg(41, 'a', 'H1H1H1H1H1H1.jpg'));
check('超过每日上限 → 不收', r5?.skipped === 'quota' && collected.length === 2);

// 状态落盘
const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'sticker-auto-collect.json'), 'utf8'));
check('状态写进数据目录', saved.todayCount === 2 && saved.seen.E1E1E1E1E1E1.decided === 'collected');

// 解析
check('解析 ok', parseJudge('```json\n{"ok":true,"desc":"白猫挥拳 冲"}\n```').desc === '白猫挥拳 冲');
check('解析 拒绝', parseJudge('{"ok":false,"why":"擦边"}').ok === false);
check('备注截到 20 字', parseJudge(`{"ok":true,"desc":"${'字'.repeat(30)}"}`).desc.length === 20);
check('【别发】当拒绝', parseJudge('{"ok":true,"desc":"【别发】粗口"}').ok === false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
