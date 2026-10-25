// codex-bridge 这一批修复的整体测试：每项记录 输入 / 预期 / 实际 / 耗时，最后写成 JSON + Markdown 报告。
// 用法：node test/codex-bridge-fixes-test.mjs [报告目录]   （默认 test/reports/<日期>）
//   --live      额外做实机测试：用 OneBot 直接给主人私聊发一条测试消息，检查聊天记录补记
//   --bili      额外测 B 站接口（专栏搜索 / 读正文 / 视频音轨），会调 B 站，别连着跑
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// 主人 QQ：真机联测（发到主人私聊）时用 QQ_AGENT_OWNER 指定，离线部分用占位号即可
const OWNER = process.env.QQ_AGENT_OWNER || '10000';

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const BILI = argv.includes('--bili');
const day = new Date().toLocaleDateString('sv-SE');
const OUT = path.resolve(argv.find((a) => !a.startsWith('--')) || path.join('test', 'reports', day));
fs.mkdirSync(OUT, { recursive: true });

const ws = await import('../src/web-search.js');
const { safeFetchBinary } = await import('../src/safe-fetch.js');
const { ChatStore } = await import('../src/store.js');
const refs = await import('../plugins/codex-bridge/refs.js');
const media = await import('../plugins/codex-bridge/media-tools.js');
const { __internal: brainInternal } = await import('../plugins/codex-bridge/brain.js');
const bridge = await import('../plugins/codex-bridge/index.js');
refs.bindRefs({ settings: () => ({ publicImageGen: true }), ownerIds: () => [OWNER] });
media.bindMediaTools({ settings: () => ({}) });

const results = [];
async function test(group, name, fn) {
  const t0 = Date.now();
  const rec = { group, name, ok: false, ms: 0, input: null, expected: null, actual: null, note: '' };
  try {
    await fn(rec);
    rec.ok = rec.ok !== 'skip' ? true : 'skip';
  } catch (e) {
    rec.ok = false;
    rec.error = String(e?.message ?? e).slice(0, 500);
  }
  rec.ms = Date.now() - t0;
  results.push(rec);
  console.log(`${rec.ok === true ? '✅' : rec.ok === 'skip' ? '⏭️' : '❌'} [${group}] ${name}（${rec.ms}ms）${rec.error ? ` —— ${rec.error}` : ''}`);
}
const isImg = (b) => b?.length > 2000 && ((b[0] === 0xff && b[1] === 0xd8) || b[0] === 0x89 || b.toString('ascii', 0, 3) === 'GIF' || b.toString('ascii', 8, 12) === 'WEBP');
const short = (u, n = 90) => (String(u || '').length > n ? `${String(u).slice(0, n)}…` : String(u || ''));

// ── 1. 网图搜索 ───────────────────────────────────────────────────────────
const IMG_QUERIES = ['三角初华 BanG Dream', '四宫宁月', '琪露诺', 'DeepSeek 鲸鱼', '千石由乃', 'Frieren', 'nailong'];
for (const q of IMG_QUERIES) {
  await test('1 网图搜索', `百度 / Bing「${q}」`, async (rec) => {
    rec.input = q;
    rec.expected = '百度能出结果（主力）；Bing 是备用，允许失败；结果带来源标题和来源页';
    const row = {};
    for (const [k, fn] of [['百度', ws.baiduImageSearch], ['Bing', ws.bingImageSearch]]) {
      try {
        const l = await fn(q, { limit: 8 });
        row[k] = { 条数: l.length, 有标题: l.filter((r) => r.title).length, 有来源页: l.filter((r) => r.page).length, 前三: l.slice(0, 3).map((r) => ({ 标题: r.title || '（无）', 图: short(r.url), 来源页: short(r.page) })) };
      } catch (e) { row[k] = { 失败: String(e.message).slice(0, 80) }; }
    }
    rec.actual = row;
    assert.ok(row.百度.条数 > 0, '百度没出结果');
  });
}
await test('1 网图搜索', '搜出来的前 5 条能下载成真图片（看文件头）', async (rec) => {
  rec.input = IMG_QUERIES;
  rec.expected = '每个词前 5 条里至少 3 张是真图片';
  rec.actual = {};
  for (const q of IMG_QUERIES) {
    const l = await ws.baiduImageSearch(q, { limit: 8 });
    let ok = 0;
    for (const r of l.slice(0, 5)) { try { if (isImg((await safeFetchBinary(r.url, 4 * 1024 * 1024, { timeoutMs: 10000 })).buffer)) ok++; } catch { /* 下不了 */ } }
    rec.actual[q] = `${ok}/5`;
    assert.ok(ok >= 3, `「${q}」只有 ${ok}/5 张能下`);
  }
});
await test('1 网图搜索', '商品页 / 网页地址不会被当成图', async (rec) => {
  rec.input = 'DeepSeek 鲸鱼（之前混进过 taobao / yangkeduo 商品页）';
  rec.expected = '结果里没有 .html / .php 结尾或商品详情页';
  const l = await ws.baiduImageSearch('DeepSeek 鲸鱼', { limit: 12 });
  const bad = l.filter((r) => /\.(html?|php)(\?|$)/i.test(r.url));
  rec.actual = { 条数: l.length, 网页地址: bad.map((r) => r.url) };
  assert.equal(bad.length, 0);
});

// ── 2. 知识库别名 ───────────────────────────────────────────────────────────
for (const [term, want] of [['三角初音', '三角初华'], ['Doloris', '三角初华'], ['初华', '三角初华'], ['四宫宁月', '四宫宁月'], ['完全不存在的词xyz', null]]) {
  await test('2 知识库别名', `「${term}」`, async (rec) => {
    rec.input = term;
    rec.expected = want ? `命中词条「${want}」` : '不命中';
    const hit = refs.kbAliasHit(term);
    rec.actual = hit ? { 词条: hit.name, 一句话: hit.oneLine, 专题: hit.topic } : '不命中';
    assert.equal(hit?.name ?? null, want);
  });
}

// ── 3. 画图请求识别 ─────────────────────────────────────────────────────────
const DRAW_CASES = [
  ['@喵喵ピエン 画一只deepseekd', ['deepseekd']],
  ['@喵喵ピエン 给我画一张三角初音', ['三角初音']],
  ['@喵喵ピエン 画一张萝莉控', ['萝莉控']],
  ['@喵喵ピエン 给我画一张柊筱娅', ['柊筱娅']],
  ['@喵喵ピエン 再画一张琪露诺吧', ['琪露诺']],
  ['@喵喵ピエン 能画个初音未来吗', ['初音未来']],
  ['@喵喵ピエン 帮我画奶蛙', ['奶蛙']],
  ['@喵喵ピエン 画一张芙莉莲不', ['芙莉莲']],
  ['@喵喵ピエン 开电，你画个图把@蹦吧蹦吧 他给电了', []],
  ['@喵喵ピエン 我的四宫宁月呢', []],
  ['[引用 海鸥(QQ:1)：[图片] #-82]@喵喵ピエン 把这块鲸币变得更值钱', []],
  ['这个动画好看', []],
  ['画风不错', []],
  ['@喵喵ピエン 拿我头像画一张奶龙', []],
  ['@喵喵ピエン 画一张这个', []]
];
await test('3 画图请求识别', `${DRAW_CASES.length} 条消息（含今天群里的真实消息）`, async (rec) => {
  rec.input = DRAW_CASES.map(([t]) => t);
  rec.expected = DRAW_CASES.map(([t, w]) => ({ 消息: t, 预期: w.join('、') || '（不算画图请求）' }));
  rec.actual = DRAW_CASES.map(([t, w]) => { const got = refs.drawSubjects(t); return { 消息: t, 预期: w.join('、') || '—', 实际: got.join('、') || '—', 对: JSON.stringify(got) === JSON.stringify(w) }; });
  const wrong = rec.actual.filter((x) => !x.对);
  assert.equal(wrong.length, 0, `识别错 ${wrong.length} 条：${wrong.map((x) => x.消息).join(' / ')}`);
});

// ── 4. 查参考（ref_image_get） ──────────────────────────────────────────────
for (const [term, want] of [['奶龙', 'ref'], ['三角初音', 'kb'], ['四宫宁月', 'kb'], ['deepseekd', 'web']]) {
  await test('4 查参考 ref_image_get', `「${term}」`, async (rec) => {
    rec.input = term;
    rec.expected = { ref: '参考图库命中，附库里的图', kb: '知识库别名命中 + 自动附网图', web: '库里都没有，自动附网图' }[want];
    const r = await refs.REF_GET_TOOL.execute({}, { term });
    const parts = Array.isArray(r.content) ? r.content : [{ type: 'text', text: r.content }];
    rec.actual = { 附图张数: parts.length - 1, 返回给模型的文字: parts[0].text };
    const kind = /的参考图 \d+ 张/.test(parts[0].text) ? 'ref' : /本地知识库有这个/.test(parts[0].text) ? 'kb' : 'web';
    assert.equal(kind, want);
    assert.ok(parts.length - 1 >= 1, '一张图都没附');
  });
}

// ── 5. 画图请求预取 ─────────────────────────────────────────────────────────
await test('5 画图请求预取', '一轮里两个人点图 + 一个没 @ 的路人', async (rec) => {
  const trigger = [
    { self: false, atMe: true, senderId: '1600922142', senderName: '皇帝', mid: 1107440252, text: '@喵喵ピエン 给我画一张三角初音' },
    { self: false, atMe: true, senderId: '2648456766', senderName: '黄瓜精', mid: 166048111, text: '@喵喵ピエン 画一只deepseekd' },
    { self: false, atMe: false, senderId: '1', senderName: '路人', mid: 3, text: '画一张奶龙' }
  ];
  rec.input = trigger.map((e) => `${e.senderName}${e.atMe ? '（@了喵喵）' : '（没 @）'}：${e.text}`);
  rec.expected = '查 2 个（三角初音、deepseekd），路人那条不查；每个附 2 张参考图；说明里带点图人和消息号';
  globalThis.__codexBridge.orch = { onebot: { selfId: '3050532093' }, sessions: { current: new Map([['s1', { trigger }]]) } };
  const d = await refs.drawPrefetch('s1', 'group:961027421');
  rec.actual = { 附图张数: d?.images.length ?? 0, 塞进本轮输入的文字: d?.text ?? null };
  assert.ok(d && /皇帝（#1107440252）要画「三角初音」/.test(d.text) && /黄瓜精（#166048111）要画「deepseekd」/.test(d.text));
  assert.ok(!/奶龙/.test(d.text), '路人那条不该查');
  assert.equal(d.images.length, 4);
});

// ── 6. 画好的图归给谁 ───────────────────────────────────────────────────────
const T = (s) => 1000 * s;
for (const [name, files, marks, want] of [
  ['一个人点图', [{ p: 'a.png', t: T(50) }], [{ t: T(10), mid: '111' }], [['a.png', '111']]],
  ['A、B 先后点图，一张一张画', [{ p: 'a.png', t: T(50) }, { p: 'b.png', t: T(90) }], [{ t: T(10), mid: 'A' }, { t: T(60), mid: 'B' }], [['a.png', 'A'], ['b.png', 'B']]],
  ['同一个人重画了一次，只发最后一张', [{ p: 'a1.png', t: T(50) }, { p: 'a2.png', t: T(80) }], [{ t: T(10), mid: 'A' }], [['a2.png', 'A']]],
  ['没引用任何人（随口画）', [{ p: 'a.png', t: T(50) }], [], [['a.png', null]]],
  ['引用发生在图画完之后，不算', [{ p: 'a.png', t: T(50) }], [{ t: T(70), mid: 'X' }], [['a.png', null]]],
  ['A 的图、B 的图、A 又重画', [{ p: 'a1.png', t: T(40) }, { p: 'b.png', t: T(80) }, { p: 'a2.png', t: T(120) }], [{ t: T(10), mid: 'A' }, { t: T(60), mid: 'B' }, { t: T(100), mid: 'A' }], [['b.png', 'B'], ['a2.png', 'A']]]
]) {
  await test('6 画好的图归给谁', name, async (rec) => {
    rec.input = { 图: files.map((f) => `${f.p}@${f.t / 1000}s`), 引用: marks.map((m) => `${m.mid}@${m.t / 1000}s`) };
    rec.expected = want.map(([f, r]) => `${f} → ${r ?? '不引用'}`);
    const got = brainInternal.assignGeneratedTargets(files, marks);
    rec.actual = got.map((x) => `${x.file} → ${x.replyTo ?? '不引用'}`);
    assert.deepEqual(rec.actual, rec.expected);
  });
}

// ── 7. 发图：引用 + @ + 图 ──────────────────────────────────────────────────
const GEN = path.join(os.homedir(), '.codex', 'generated_images');
const genFiles = (() => { try { return fs.readdirSync(GEN).flatMap((d) => { try { return fs.readdirSync(path.join(GEN, d)).filter((f) => f.endsWith('.png')).map((f) => path.join(GEN, d, f)); } catch { return []; } }); } catch { return []; } })();
function fakeOrch(entries, { failWithReply = false } = {}) {
  const calls = [];
  return {
    calls,
    onebot: { selfId: '3050532093' },
    store: { findByMid: (_k, mid) => entries[String(mid)] || null },
    sender: { async sendImage(chatKey, img, opts = {}) { calls.push({ chatKey, file: path.basename(img.file), replyTo: opts.replyToMessageId ?? null, at: opts.atUserId ?? null }); if (failWithReply && opts.replyToMessageId) throw new Error('引用的消息不存在'); return { message_id: 1 }; } }
  };
}
await test('7 发图：引用 + @', '群聊：引用点图那条、@ 点图的人', async (rec) => {
  if (!genFiles.length) { rec.ok = 'skip'; rec.note = '本机没有画过的图'; return; }
  const orch = fakeOrch({ 1107440252: { senderId: '1600922142', self: false } });
  rec.input = { 群: 'group:961027421', 图: path.basename(genFiles[0]), 归给: '#1107440252（皇帝 1600922142 点的）' };
  rec.expected = '一条消息：reply=1107440252，at=1600922142，图';
  await bridge.sendGeneratedImages(orch, 'group:961027421', [{ file: genFiles[0], replyTo: '1107440252' }]);
  rec.actual = orch.calls;
  assert.deepEqual(orch.calls.map((c) => [c.replyTo, c.at]), [['1107440252', '1600922142']]);
});
await test('7 发图：引用 + @', '两个人各一张，各引用各的', async (rec) => {
  if (genFiles.length < 2) { rec.ok = 'skip'; return; }
  const orch = fakeOrch({ 1: { senderId: '111', self: false }, 2: { senderId: '222', self: false } });
  rec.input = '图 1 → #1（QQ 111），图 2 → #2（QQ 222）';
  rec.expected = '两条：(#1, @111)、(#2, @222)';
  await bridge.sendGeneratedImages(orch, 'group:1', [{ file: genFiles[0], replyTo: '1' }, { file: genFiles[1], replyTo: '2' }]);
  rec.actual = orch.calls;
  assert.deepEqual(orch.calls.map((c) => [c.replyTo, c.at]), [['1', '111'], ['2', '222']]);
});
await test('7 发图：引用 + @', '引用的是喵喵自己的消息：只引用不 @', async (rec) => {
  if (!genFiles.length) { rec.ok = 'skip'; return; }
  const orch = fakeOrch({ 9: { senderId: 'self', self: true } });
  rec.expected = 'reply=9，at=无';
  await bridge.sendGeneratedImages(orch, 'group:1', [{ file: genFiles[0], replyTo: '9' }]);
  rec.actual = orch.calls;
  assert.deepEqual(orch.calls.map((c) => [c.replyTo, c.at]), [['9', null]]);
});
await test('7 发图：引用 + @', '私聊：不引用不 @，直接发图', async (rec) => {
  if (!genFiles.length) { rec.ok = 'skip'; return; }
  const orch = fakeOrch({ 5: { senderId: OWNER, self: false } });
  rec.expected = 'reply=无，at=无';
  await bridge.sendGeneratedImages(orch, `private:${OWNER}`, [{ file: genFiles[0], replyTo: '5' }]);
  rec.actual = orch.calls;
  assert.deepEqual(orch.calls.map((c) => [c.replyTo, c.at]), [[null, null]]);
});
await test('7 发图：引用 + @', '引用失败（消息被撤回）：退回直接发图', async (rec) => {
  if (!genFiles.length) { rec.ok = 'skip'; return; }
  const orch = fakeOrch({ 7: { senderId: '777', self: false } }, { failWithReply: true });
  rec.expected = '先带引用发一次失败，再不带引用发一次';
  await bridge.sendGeneratedImages(orch, 'group:1', [{ file: genFiles[0], replyTo: '7' }]);
  rec.actual = orch.calls;
  assert.deepEqual(orch.calls.map((c) => [c.replyTo, c.at]), [['7', '777'], [null, null]]);
});
await test('7 发图：引用 + @', '不是 Codex 画的图（电脑上别的文件）不发', async (rec) => {
  const orch = fakeOrch({});
  const other = path.resolve('package.json');
  rec.input = other;
  rec.expected = '一条都不发';
  await bridge.sendGeneratedImages(orch, 'group:1', [{ file: other, replyTo: null }]);
  rec.actual = orch.calls;
  assert.equal(orch.calls.length, 0);
});

// ── 8. 聊天记录补记（自己消息的回显） ───────────────────────────────────────
await test('8 聊天记录补记', '回显先到、sender 留档后到：只留一条，用 sender 的内容', async (rec) => {
  const store = new ChatStore(0);
  const key = `group:selftest_${Date.now()}`;
  try {
    store.appendSelf(key, { text: '[图片]', mid: 555, echo: true });
    store.appendSelf(key, { text: '[图片:画好的图]', mid: 555, media: [{ kind: 'image', file: 'x.png' }] });
    const mine = store.recent(key, { limit: 10 }).filter((m) => m.self);
    rec.expected = '1 条，文字「[图片:画好的图]」，带本地文件，没有 echo 标记';
    rec.actual = mine.map((m) => ({ mid: m.mid, text: m.text, media: m.media, echo: m.echo ?? false }));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].text, '[图片:画好的图]');
    assert.ok(!mine[0].echo);
  } finally { fs.rmSync(path.join('data', 'messages', `${key.replace(/[^a-z0-9_]/gi, '_')}.json`), { force: true }); }
});
await test('8 聊天记录补记', 'sender 先留档、回显后到：不重复', async (rec) => {
  const store = new ChatStore(0);
  const key = `group:selftest_${Date.now()}`;
  try {
    store.appendSelf(key, { text: '在呢', mid: 777 });
    store.appendSelf(key, { text: '在呢', mid: 777, echo: true });
    store.appendSelf(key, { text: '外部发的另一条', mid: 778, echo: true });
    const mine = store.recent(key, { limit: 10 }).filter((m) => m.self);
    rec.expected = '2 条：777（sender 的）、778（补记，带 echo 标记）';
    rec.actual = mine.map((m) => ({ mid: m.mid, text: m.text, echo: m.echo ?? false }));
    assert.deepEqual(mine.map((m) => [m.mid, Boolean(m.echo)]), [[777, false], [778, true]]);
  } finally { fs.rmSync(path.join('data', 'messages', `${key.replace(/[^a-z0-9_]/gi, '_')}.json`), { force: true }); }
});
// 实机这条会真的给主人私聊发消息：没指定 QQ_AGENT_OWNER 就不跑，免得发给占位号
if (LIVE && process.env.QQ_AGENT_OWNER) {
  await test('8 聊天记录补记', '实机：直接调 OneBot 给主人私聊发一条，看喵喵的聊天记录有没有补上', async (rec) => {
    const cfg = JSON.parse(fs.readFileSync('data/config.json', 'utf8'));
    const text = `【测试】这条是测试脚本直接调接口发的，用来测聊天记录补记，可以忽略（${new Date().toLocaleTimeString('zh-CN')}）`;
    rec.input = { 发给: `private:${OWNER}`, 内容: text };
    rec.expected = `6 秒内 data/messages/private_${OWNER}.json 里出现这条（self=true，echo=true，mid 对得上）`;
    const r = await fetch('http://127.0.0.1:3000/send_private_msg', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.snowluma.httpAccessToken}` }, body: JSON.stringify({ user_id: Number(OWNER), message: [{ type: 'text', data: { text } }] }) });
    const j = await r.json();
    const mid = j?.data?.message_id;
    let hit = null;
    for (let i = 0; i < 12 && !hit; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      try { hit = JSON.parse(fs.readFileSync(`data/messages/private_${OWNER}.json`, 'utf8')).messages.find((m) => String(m.mid) === String(mid)) || null; } catch { /* 正在写 */ }
    }
    rec.actual = { 发送结果: j?.status, message_id: mid, 聊天记录里: hit };
    assert.ok(hit && hit.self && hit.echo && hit.text === text, '聊天记录里没补上');
  });
}

// ── 9. 听视频（本地转写） ───────────────────────────────────────────────────
await test('9 听视频', '把 5 段中文原声拼成一个"视频"，抽音轨 → whisper 转写', async (rec) => {
  const bili = await import('../plugins/media-download/bili.js');
  const ffmpeg = await bili.findFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-test-'));
  const clips = ['阿伟已经死了', '鸡汤来喽', '你不要过来呀', '燕子没有你我怎么活啊', '真相只有一个'];
  try {
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, clips.map((c) => `file '${path.resolve('data/knowledge-base/voices', `${c}.mp3`).replace(/\\/g, '/')}'`).join('\n'));
    const mp4 = path.join(dir, 'test.mp4');
    const wav = path.join(dir, 'a.wav');
    // 拼成带黑屏画面的 mp4，模拟群里发的视频；再按工具里一样的参数抽 16k 单声道音轨
    spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10', '-shortest', '-c:a', 'aac', '-c:v', 'libx264', mp4]);
    spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-t', '180', '-i', mp4, '-vn', '-ac', '1', '-ar', '16000', wav]);
    const t0 = Date.now();
    const r = spawnSync('python', ['-I', path.resolve('plugins/codex-bridge/asr.py'), wav], { encoding: 'utf8', maxBuffer: 1 << 24 });
    const asr = JSON.parse(String(r.stdout).trim().split('\n').pop());
    const text = asr.segments.map((s) => s.t).join(' ');
    rec.input = { 片段: clips, 视频大小KB: Math.round(fs.statSync(mp4).size / 1024) };
    rec.expected = '认出语种 zh，大部分台词能对上（机器识别允许个别错字）';
    rec.actual = { 语种: asr.language, 转写耗时秒: ((Date.now() - t0) / 1000).toFixed(1), 分段: asr.segments.map((s) => `[${s.s}s] ${s.t}`) };
    const hitCount = clips.filter((c) => [...c].filter((ch) => text.includes(ch)).length / c.length >= 0.6).length;
    rec.actual.对上的片段 = `${hitCount}/${clips.length}`;
    assert.equal(asr.language, 'zh');
    assert.ok(hitCount >= 3, `只对上 ${hitCount} 段`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
await test('9 听视频', '日语原声：为什么要演奏春日影', async (rec) => {
  const r = spawnSync('python', ['-I', path.resolve('plugins/codex-bridge/asr.py'), path.resolve('data/knowledge-base/voices/为什么要演奏春日影.mp3')], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const asr = JSON.parse(String(r.stdout).trim().split('\n').pop());
  rec.input = '为什么要演奏春日影.mp3（长崎素世，日语）';
  rec.expected = '认出语种 ja，能听出「春日影」（はるひかげ / 春日影）';
  rec.actual = { 语种: asr.language, 分段: asr.segments.map((s) => `[${s.s}s] ${s.t}`) };
  assert.equal(asr.language, 'ja');
});
await test('9 听视频', '没有视频的消息：工具好好报错，不崩', async (rec) => {
  const v = await media.VIDEO_LISTEN_TOOL.execute({ chatKey: 'group:1', store: { findByMid: () => ({ media: [], text: '普通文字' }) } }, { messageId: '1' });
  rec.input = '一条纯文字消息';
  rec.expected = '返回"没找到视频"之类的错误';
  rec.actual = v.content;
  assert.ok(/没找到视频/.test(v.content));
});
if (BILI) {
  await test('9 听视频', '实机：B 站视频 BV1GJ411x7h7 走完整工具', async (rec) => {
    rec.input = 'BV1GJ411x7h7';
    rec.expected = '下音轨 → 截前 3 分钟 → 转写，返回带时间的文字';
    const v = await media.VIDEO_LISTEN_TOOL.execute({ chatKey: 'group:1', store: { findByMid: () => null } }, { url: 'BV1GJ411x7h7' });
    rec.actual = String(v.content).slice(0, 1500);
    assert.ok(!v.isError, v.content);
  });
}

// ── 10. B 站专栏 ────────────────────────────────────────────────────────────
if (BILI) {
  let firstId = '';
  await test('10 B站专栏', '搜「四宫宁月」', async (rec) => {
    rec.input = '四宫宁月';
    rec.expected = '列出专栏：标题、摘要、cv 号';
    const r = await media.BILI_ARTICLE_TOOL.execute({}, { keyword: '四宫宁月' });
    rec.actual = r.content;
    firstId = String(r.content).match(/cv(\d+)/)?.[1] || '';
    assert.ok(firstId, r.content);
  });
  await test('10 B站专栏', '读搜到的第一篇', async (rec) => {
    rec.input = `cv${firstId}`;
    rec.expected = '正文文字 + 配图（附给模型看）';
    const r = await media.BILI_ARTICLE_TOOL.execute({}, { id: firstId });
    const parts = Array.isArray(r.content) ? r.content : [{ text: r.content }];
    rec.actual = { 附图张数: parts.length - 1, 文字: parts[0].text };
    assert.ok(parts.length >= 2, '没附上图');
  });
  await test('10 B站专栏', '图搜里混进专栏配图', async (rec) => {
    rec.input = '三角初华';
    rec.expected = '结果里有 bilibili.com/read 来源的图，和百度结果交替排';
    const l = await ws.searchImages('三角初华', { limit: 8 });
    rec.actual = l.map((r) => ({ 标题: r.title || '（无）', 图: short(r.url, 70), 来源页: short(r.page, 60) }));
    assert.ok(l.some((r) => /bilibili\.com\/read/.test(r.page || '')));
  });
}

// ── 11. 规则与加载 ──────────────────────────────────────────────────────────
await test('11 规则与加载', '大脑规则里写进了新要求', async (rec) => {
  const src = fs.readFileSync('plugins/codex-bridge/brain.js', 'utf8');
  const need = ['问人要图是最后一步', '一定带 replyToMessageId 引用点图的那条消息', '自动引用你开画前引用的那条、@ 点图的人', '一张一张来', 'bili_article', 'video_listen'];
  rec.input = need;
  rec.expected = '都在';
  rec.actual = need.map((n) => `${src.includes(n) ? '有' : '缺'}：${n}`);
  assert.ok(need.every((n) => src.includes(n)));
});
await test('11 规则与加载', '新工具都注册了', async (rec) => {
  const src = fs.readFileSync('plugins/codex-bridge/index.js', 'utf8');
  const need = ['REF_GET_TOOL', 'REF_SAVE_TOOL', 'BILI_ARTICLE_TOOL', 'VIDEO_LISTEN_TOOL'];
  const line = src.split('\n').find((l) => l.includes('for (const t of [AVATAR_TOOL')) || '';
  rec.input = need;
  rec.actual = line.trim();
  assert.ok(need.every((n) => line.includes(n)));
});
await test('11 规则与加载', '拆出去的文件行数', async (rec) => {
  rec.actual = Object.fromEntries(['index.js', 'brain.js', 'refs.js', 'media-tools.js', 'learner.js', 'asr.py'].map((f) => [f, fs.readFileSync(path.join('plugins/codex-bridge', f), 'utf8').split('\n').length]));
  rec.expected = 'index.js 比拆之前（2710 行）少';
  assert.ok(rec.actual['index.js'] < 2710);
});

// ── 输出 ────────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.ok === true).length;
const fail = results.filter((r) => r.ok === false).length;
const skip = results.filter((r) => r.ok === 'skip').length;
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), live: LIVE, bili: BILI, pass, fail, skip, results }, null, 1), 'utf8');
console.log(`\n通过 ${pass}，失败 ${fail}，跳过 ${skip}；数据：${path.join(OUT, 'results.json')}`);
process.exitCode = fail ? 1 : 0;
