// 群友身份对照（qq-identity）自测：不联网、不依赖真机，用临时数据目录跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqid-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const mod = await import('./index.js');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
};
const logs = [];
mod.setup({ config: () => ({ enabled: true, injectLimit: 40, aliasKeep: 3, announceRename: true }), log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('warn: ' + a.join(' ')) });
await new Promise((r) => setTimeout(r, 30));

const CHAT = 'group:917801297';
const T0 = 1791600000000;

// ── ① 学习：同一个人、改了名字，仍然是同一个 QQ ─────────────────────────
mod.observeMessage(CHAT, '1254227558', '网络相机📷', T0);
mod.observeMessage(CHAT, '1254227558', '网络相机📷', T0 + 1000);
const renamed = mod.observeMessage(CHAT, '1254227558', '相机不拍照了', T0 + 2000);
check('同 QQ 两次同名消息 → 记为一个人', mod.describeMember(CHAT, '1254227558')?.count === 3);
check('改名被识别并记录日志', Boolean(renamed) && logs.some((l) => /改名为/.test(l)), JSON.stringify(renamed));
const d = mod.describeMember(CHAT, '1254227558');
check('当前名字已更新为新名字', d?.name === '相机不拍照了', d?.name);
check('曾用名仍然记得', (d?.aliases || []).includes('网络相机📷'), JSON.stringify(d?.aliases));

// ── ② 查询：新名字、曾用名都能查到同一个 QQ ─────────────────────────────
check('用新名字查到 QQ', mod.resolveUserId(CHAT, '相机不拍照了') === '1254227558');
check('用曾用名也能查到同一个 QQ', mod.resolveUserId(CHAT, '网络相机📷') === '1254227558');
check('查不到的返回空（不瞎猜）', mod.resolveUserId(CHAT, '查无此人') === '');

// ── ③ 别名裁剪：只保留最近 N 个 ─────────────────────────────────────────
for (let i = 0; i < 6; i++) mod.observeMessage(CHAT, '1254227558', `临时名${i}`, T0 + 3000 + i);
const d2 = mod.describeMember(CHAT, '1254227558');
check('别名数量被裁到配置上限（3）', Object.keys(d2.aliases).length + 1 <= 3, '别名=' + JSON.stringify(d2.aliases));

// ── ④ 提示词段：给出"名字 → QQ" ─────────────────────────────────────────
const secs = mod.promptSections({ chatKey: CHAT });
check('注入了一个提示词段', secs.length === 1 && secs[0].id === 'qq-identity');
check('段里含 QQ 号与"曾用名"', /QQ 1254227558/.test(secs[0].content), secs[0].content.slice(0, 120));
check('段里明确提示"名字会改、QQ 不会"', /名字会改/.test(secs[0].content));
check('优先级 45（不盖安全规则）', secs[0].priority === 45);

// ── ⑤ 能力：核心/别的插件能拿到身份能力 ─────────────────────────────────
const cap = mod.providers['message.identity']();
check('能力可解析名字→QQ', cap.resolveUserId(CHAT, '网络相机📷') === '1254227558');
check('能力可查最近成员', cap.listMembers(CHAT, 5).length >= 1);
check('全局兜底钩子已挂（核心 memory.js 用）', typeof globalThis.__qqIdentity?.resolveUserId === 'function');

// ── ⑥ 合并：把按名字存的存档并到 QQ 号下 ────────────────────────────────
const memDir = path.join(tmp, 'memory', 'group_917801297');
fs.mkdirSync(memDir, { recursive: true });
fs.writeFileSync(path.join(memDir, '1254227558.json'), JSON.stringify({
  userId: '1254227558', name: '相机不拍照了',
  impressions: [{ content: '已经存在的印象', createdAt: T0 }]
}, null, 1), 'utf8');
fs.writeFileSync(path.join(memDir, '_n_相机不拍照了.json'), JSON.stringify({
  name: '相机不拍照了',
  impressions: [
    { content: '已经存在的印象', createdAt: T0 },     // 重复项，合并时要去掉
    { content: '按名字存下来的新印象', createdAt: T0 + 5000 }
  ]
}, null, 1), 'utf8');
fs.writeFileSync(path.join(memDir, '_n_查无此人.json'), JSON.stringify({
  name: '查无此人', impressions: [{ content: '孤儿存档', createdAt: T0 }]
}, null, 1), 'utf8');

const dry = await mod.mergeNameKeyed(CHAT, { apply: false });
check('干跑：扫到 2 份按名字存的存档', dry.scanned === 2, String(dry.scanned));
check('干跑不改文件（_n_ 仍在）', fs.existsSync(path.join(memDir, '_n_相机不拍照了.json')));
check('无法解析的存档被跳过并给出原因', dry.skipped.some((s) => /还没有这个名字/.test(s.why)));

const applied = await mod.mergeNameKeyed(CHAT, { apply: true });
const mergedRec = JSON.parse(fs.readFileSync(path.join(memDir, '1254227558.json'), 'utf8'));
check('真合并：印象合并后共 2 条（重复项已去重）', mergedRec.impressions.length === 2, String(mergedRec.impressions.length));
check('真合并：新印象已并入 QQ 存档', mergedRec.impressions.some((x) => x.content === '按名字存下来的新印象'));
check('真合并：按名字的文件已移除', !fs.existsSync(path.join(memDir, '_n_相机不拍照了.json')));
check('真合并：无法解析的那份仍保留（不误删）', fs.existsSync(path.join(memDir, '_n_查无此人.json')));
const backups = fs.existsSync(applied.backup) ? fs.readdirSync(applied.backup) : [];
check('原件已备份（可回溯）', backups.includes('_n_相机不拍照了.json'), JSON.stringify(backups));

// ── ⑦ 落盘：对照表写进了数据目录 ────────────────────────────────────────
mod.deactivate();
await new Promise((r) => setTimeout(r, 60));
const stateFile = path.join(tmp, 'qq-identity.json');
check('对照表已落盘', fs.existsSync(stateFile));
const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
check('落盘内容含该群与该 QQ', Boolean(saved?.chats?.[CHAT]?.members?.['1254227558']));

// ── ⑧ 关闭开关后不再学习、不再注入 ──────────────────────────────────────
mod.setup({ config: () => ({ enabled: false }), log: () => {}, warn: () => {} });
mod.observeMessage('group:1', '999', '某人', T0);
check('关闭后不再学习新群', mod.promptSections({ chatKey: 'group:1' }).length === 0);
check('关闭后 observe 返回 null', mod.observeMessage('group:1', '999', '某人', T0) === null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
