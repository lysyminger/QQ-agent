// 工具工坊 + 自查（plugins/codex-bridge/workshop.js）：假 Codex，不调真模型；工具写进临时目录，不碰 plugins/self-tools/tools/。
//   node test/workshop-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ws-'));
const { createWorkshop, staticCheck } = await import('../plugins/codex-bridge/workshop.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ws-tools-'));

// ── 静态检查 ──
{
  const ok = `import { safeFetch } from '../../../src/safe-fetch.js';\nexport default {};\nconst r = await safeFetch('https://x');`;
  assert.equal(staticCheck(ok), '', 'safeFetch 不算裸 fetch');
  for (const [code, why] of [
    [`import { exec } from 'node:child_process';`, '子进程'],
    [`eval('1')`, 'eval'],
    [`const k = process.env.KEY;`, '环境变量'],
    [`fs.readFileSync('data/config.json')`, '配置'],
    [`const r = await fetch('https://x');`, '裸 fetch'],
    [`fs.writeFileSync('C:/a.txt', 'x')`, '写文件'],
    [`await import(name)`, '动态 import'],
    [`const x = require('fs')`, 'require']
  ]) assert.notEqual(staticCheck(code), '', `应拦下：${why}`);
  assert.equal(staticCheck(`fs.mkdirSync(path.join(DATA, 'self-tools', 'x'))`), '', '写 data/self-tools 下面放行');
}

const GOOD = (id) => `// ${id}：测试用工具
import { validateFetchUrl } from '../../../src/safe-fetch.js';
export default {
  id: '${id}',
  name: '测试工具',
  description: '把输入的两个数加起来，测试工坊用的。',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  async execute(ctx, args) { return { content: String(Number(args.a) + Number(args.b)) }; }
};
export async function test() {
  if (typeof validateFetchUrl !== 'function') throw new Error('src 没导入成功');
  const r = await (await import('./${id}.js')).default.execute({}, { a: 1, b: 2 });
  if (r.content !== '3') throw new Error('算错了');
}
`;

function makeWorkshop(runOnce, extra = {}) {
  const notes = [];
  const ws = createWorkshop({
    runOnce,
    locate: () => ({ nodeBin: process.execPath }),
    settings: () => ({ workshopEnabled: true, workshopDailyMax: 6, ...extra }),
    log: () => {},
    notifyOwner: (t) => notes.push(t),
    toolsDir
  });
  return { ws, notes };
}
const tool = (ws, id) => ws.tools.find((t) => t.id === id);
const ctx = { chatKey: 'group:1', session: { trigger: [{ senderId: '42', senderName: '小王', text: '帮我做个加法工具' }] } };

async function waitIdle(ws) {
  for (let i = 0; i < 200 && ws.status().building; i++) await sleep(100);
  assert.equal(ws.status().building, null, '工坊应该已经收尾');
}

// ── 写工具：第一次交的代码静态检查不过 → 带着原因重写 → 自测通过 → 上线 ──
{
  const prompts = [];
  let n = 0;
  const { ws, notes } = makeWorkshop(async ({ prompt }) => {
    prompts.push(prompt);
    n++;
    const code = n === 1 ? `import { exec } from 'node:child_process';\n${GOOD('add_two')}` : GOOD('add_two');
    return { ok: true, json: { id: 'add_two', name: '加法', summary: '两个数相加', code } };
  });
  const r = await tool(ws, 'tool_request').execute(ctx, { id: 'add_two', need: '输入两个数 a、b，返回它们的和' });
  assert.ok(!r.isError, r.content);
  assert.match((await tool(ws, 'tool_request').execute(ctx, { id: 'other_one', need: '再来一个别的工具试试' })).content, /一次只能写一个/);
  await waitIdle(ws);
  assert.equal(n, 2, '第一次被静态检查拦下，改了一次');
  assert.match(prompts[1], /静态检查没过：不许起子进程/, '把没过的原因喂回去');
  assert.ok(fs.existsSync(path.join(toolsDir, 'add_two.js')), '通过后写进 tools 目录');
  assert.ok(fs.readFileSync(path.join(toolsDir, 'add_two.js'), 'utf8').includes("'../../../src/safe-fetch.js'"), '上线的文件保留相对路径');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /自动上线[\s\S]*add_two[\s\S]*小王/);
  assert.match(ws.hint('s1', 'group:1'), /已经写好上线了/);
  assert.equal(ws.hint('s1', 'group:1'), '', '提示只给一次');
  const st = ws.status();
  assert.equal(st.tools[0].id, 'add_two');
  assert.equal(st.tools[0].by, '小王');
  assert.match((await tool(ws, 'tool_request').execute(ctx, { id: 'add_two', need: '同名的工具再写一遍' })).content, /已经有叫 add_two/);
  assert.deepEqual(ws.remove('add_two'), { ok: true });
  assert.ok(!fs.existsSync(path.join(toolsDir, 'add_two.js')));
}

// ── 写工具：自测一直不过 → 改 3 次放弃，不上线 ──
{
  let n = 0;
  const bad = GOOD('bad_add').replace("throw new Error('算错了')", "throw new Error('算错了')").replace("String(Number(args.a) + Number(args.b))", "'5'");
  const { ws, notes } = makeWorkshop(async () => { n++; return { ok: true, json: { id: 'bad_add', name: '坏加法', summary: 'x', code: bad } }; });
  await tool(ws, 'tool_request').execute(ctx, { id: 'bad_add', need: '输入两个数 a、b，返回它们的和' });
  await waitIdle(ws);
  assert.equal(n, 3);
  assert.ok(!fs.existsSync(path.join(toolsDir, 'bad_add.js')));
  assert.equal(notes.length, 0, '没上线不通知主人');
  assert.match(ws.hint('s2', 'group:1'), /没写成[\s\S]*算错了/);
  assert.equal(ws.status().recent[0].status, 'failed');
}

// ── 参数校验 / 开关 / 每日上限 ──
{
  const { ws } = makeWorkshop(async () => ({ ok: false, error: 'x' }), { workshopDailyMax: 2 });
  const req = tool(ws, 'tool_request');
  assert.match((await req.execute(ctx, { id: 'Bad-Id', need: '随便一个需求说明' })).content, /小写字母开头/);
  assert.match((await req.execute(ctx, { id: 'ok_id', need: '短' })).content, /写清楚/);
  assert.match((await req.execute(ctx, { id: 'ok_id', need: '今天第三个工具，应该被上限挡下' })).content, /到上限/, '上面两轮已经写了 2 个');
  const { ws: off } = makeWorkshop(async () => ({ ok: true }), { workshopEnabled: false });
  assert.match((await tool(off, 'tool_request').execute(ctx, { id: 'ok_id', need: '关掉了还想写' })).content, /关掉/);
}

// ── 自查 ──
{
  let got = null;
  const { ws } = makeWorkshop(async (opts) => {
    got = opts;
    return { ok: true, json: { verdict: 'wrong', problems: ['私法活力带的是次要失活'], corrected: '私法活力加的是次要失活', sources: ['https://wiki.example/a'] } };
  });
  const r = await tool(ws, 'double_check').execute(ctx, { question: '私法活力加什么', draft: '私法活力本身加回盾' });
  assert.equal(got.search, true);
  assert.equal(got.schema.required.includes('verdict'), true);
  assert.match(got.prompt, /私法活力本身加回盾/);
  assert.match(r.content, /【自查结果】有错/);
  assert.match(r.content, /改正后的说法：私法活力加的是次要失活/);
  assert.match(r.content, /kb_remember/);
  const { ws: down } = makeWorkshop(async () => ({ ok: false, error: '超时' }));
  assert.ok((await tool(down, 'double_check').execute(ctx, { question: 'q', draft: 'd' })).isError);
}

// ── 被纠正：引用 / @ 机器人且带纠正的话才提醒 ──
{
  const { ws } = makeWorkshop(async () => ({ ok: true }));
  ws.noteTrigger('s3', [{ senderName: '阿柒', text: '说错了，带次要失活', atMe: false }], '305');
  assert.equal(ws.hint('s3', 'group:9'), '', '没 @ 也没引用机器人：不算');
  ws.noteTrigger('s4', [{ senderName: '阿柒', text: '[引用 喵喵(QQ:305)：私法活力加回盾] 说错了，带次要失活' }], '305');
  assert.match(ws.hint('s4', 'group:9'), /【有人说你说错了】阿柒：[\s\S]*double_check/);
  ws.noteTrigger('s5', [{ senderName: '阿柒', text: '你今天真可爱', atMe: true }], '305');
  assert.equal(ws.hint('s5', 'group:9'), '');
}

fs.rmSync(toolsDir, { recursive: true, force: true });
console.log('workshop-test: all passed');
