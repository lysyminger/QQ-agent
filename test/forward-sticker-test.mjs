// 合并转发（两种取法 / 图片编号 / 过期重取）+ 表情包（【别发】/ 硬间隔）：假 OneBot，不连 QQ。
//   node test/forward-sticker-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-fwd-'));
const { fetchForwardNodes, expandForwardNodes } = await import('../src/onebot.js');
const { buildStickerContext, formatStickerList, isHiddenSticker } = await import('../src/stickers.js');
const { StickerManager } = await import('../src/sticker-manager.js');
const { getConfig } = await import('../src/config.js');
const { buildToolDefs } = await import('../src/tools.js');
const tool = (id) => buildToolDefs().find((t) => t.id === id);

const img = (url, summary = '') => ({ type: 'image', data: { file: path.basename(url), url, summary } });
const node = (name, uid, message) => ({ sender: { nickname: name, user_id: uid }, message });

// ── 取转发：message_id 报空就换转发段里的 id ──
{
  const calls = [];
  const ob = {
    async call(action, p) {
      calls.push(`${action}:${JSON.stringify(p)}`);
      if (action === 'get_forward_msg' && p.message_id != null) throw new Error('download forward message payload is empty');
      if (action === 'get_msg') return { message: [{ type: 'forward', data: { id: 'RES1' } }] };
      if (action === 'get_forward_msg' && p.id === 'RES1') return { messages: [node('甲', 1, '你好')] };
      throw new Error('unexpected');
    }
  };
  assert.equal((await fetchForwardNodes(ob, -5)).length, 1, 'message_id 取不到时用 get_msg 查到的 id 取');
  assert.deepEqual(calls.map((c) => c.split(':')[0]), ['get_forward_msg', 'get_msg', 'get_forward_msg']);
  calls.length = 0;
  ob.call = async (action, p) => { calls.push(action); if (p.message_id != null) throw new Error('empty'); return { messages: [node('乙', 2, 'x')] }; };
  assert.equal((await fetchForwardNodes(ob, -5, ['RES2'])).length, 1, '给了 resIds 就不再 get_msg');
  assert.deepEqual(calls, ['get_forward_msg', 'get_forward_msg']);
  ob.call = async () => { throw new Error('payload is empty'); };
  await assert.rejects(fetchForwardNodes(ob, -5, ['RES3']), /payload is empty/, '两种都失败就把错误抛出去');
}

// ── 展开：照片编号、表情包不编号、占位 QQ 不写 ──
{
  const ex = await expandForwardNodes([
    node('甲', 1094950020, [{ type: 'text', data: { text: '看这个' } }, img('https://x.qq.com/a.jpg')]),
    node('乙', 1094950020, [img('https://x.qq.com/s.gif', '[动画表情]'), img('https://x.qq.com/b.jpg', '[图片]')]),
    node('丙', 111, [img('https://x.qq.com/c.jpg')]),
    node('丁', 222, 'a'), node('戊', 222, 'b')
  ]);
  assert.match(ex.text, /甲: 看这个\[图片1\]/);
  assert.match(ex.text, /乙: \[表情包\]\[图片2\]/);
  assert.match(ex.text, /丙\(QQ:111\): \[图片3\]/, '真实号照写');
  assert.ok(!ex.text.includes('1094950020'), '占位 QQ 不写');
  assert.match(ex.text, /\n丁: a\n戊: b/, '两个名字共用一个号也不写号');
  assert.deepEqual(ex.media.map((m) => m.url), ['https://x.qq.com/a.jpg', 'https://x.qq.com/b.jpg', 'https://x.qq.com/c.jpg'], 'media 顺序和编号一致，表情包不进');
}

// ── get_message_images：index 单看、默认最多 6 张、链接过期重取转发 ──
{
  const entries = new Map();
  const store = {
    findByMid: (_c, mid) => entries.get(String(mid)) || null,
    updateByMid: (_c, mid, { replaceMedia }) => { entries.get(String(mid)).media = [...replaceMedia]; return true; }
  };
  // .invalid 域名解析必失败：从报错里能看出下载了哪几张（不连外网）
  const urls = Array.from({ length: 8 }, (_, i) => `https://old${i + 1}.invalid/a.jpg`);
  entries.set('-77', { mid: -77, text: '[合并转发 共8条]\n…', media: urls.map((url) => ({ kind: 'image', url })) });
  let fresh = 0;
  const onebot = { async call(action) {
    if (action !== 'get_forward_msg') throw new Error(action);
    fresh++;
    return { messages: urls.map((u, i) => node(`人${i}`, 1, [img(u.replace('old', 'new'))])) };
  } };
  const t = tool('get_message_images');
  assert.ok(t.parameters.properties.index, 'get_message_images 有 index 参数');
  const r = await t.execute({ chatKey: 'group:1', store, onebot }, { messageId: -77, index: 3 });
  assert.equal(fresh, 1, '旧链接取不到：重取了一次转发');
  assert.ok(entries.get('-77').media[0].url.startsWith('https://new1.'), '存档换上新链接');
  assert.ok(r.isError && /new3\.invalid/.test(r.content) && !/new1\./.test(r.content), `index=3 只下第 3 张：${r.content}`);
  const r2 = await t.execute({ chatKey: 'group:1', store, onebot }, { messageId: -77 });
  assert.equal((r2.content.match(/ENOTFOUND/g) || []).length, 6, '不带 index 最多下 6 张');
  const r3 = await t.execute({ chatKey: 'group:1', store, onebot }, { messageId: -77, index: 9 });
  assert.ok(r3.isError && /1~8/.test(r3.content), 'index 越界给范围');
}

// ── 表情包：【别发】不列不发、硬间隔 ──
{
  const list = [
    { id: 'a', desc: '粉猫太强了 佩服夸人', url: 'https://p.qpic.cn/a' },
    { id: 'b', desc: '【别发】低俗粗口文字图', url: 'https://p.qpic.cn/b' }
  ];
  assert.ok(isHiddenSticker(list[1]) && !isHiddenSticker(list[0]));
  const ctxText = buildStickerContext(list, 15);
  assert.ok(ctxText.includes('粉猫太强了') && !ctxText.includes('低俗'), '【别发】不进提示词');
  assert.equal(formatStickerList(list).stickers.length, 1, '【别发】不进 list_stickers');

  const mgr = new StickerManager({ call: async () => [] });
  getConfig().sticker.minGapMinutes = 30;
  assert.equal(mgr.gapLeft('group:1'), 0, '没发过可以发');
  mgr.noteSent('group:1', Date.now() - 10 * 60000);
  assert.ok(Math.abs(mgr.gapLeft('group:1') - 20 * 60000) < 1000, '10 分钟前发过，还要等 20 分钟');
  assert.equal(mgr.gapLeft('group:2'), 0, '别的群不受影响');
  getConfig().sticker.minGapMinutes = 0;
  assert.equal(mgr.gapLeft('group:1'), 0, '设成 0 就不限');

  getConfig().sticker.minGapMinutes = 30;
  const send = tool('send_sticker');
  const sent = [];
  const ctx = {
    chatKey: 'group:1', stickers: mgr, session: { sent: [], triggerText: '' }, emit() {},
    sender: { async sendSticker(c, s) { sent.push(s.id); return { message_id: 1 }; } }
  };
  mgr.entries = list.map((e) => ({ ...e, resId: e.id, tags: [] }));
  mgr.syncedAt = Date.now();
  const blocked = await send.execute(ctx, { stickerId: 'a' });
  assert.ok(blocked.isError && /刚发过表情包/.test(blocked.content), `间隔内拦下：${blocked.content}`);
  mgr.lastSentByChat.clear();
  const hidden = await send.execute(ctx, { stickerId: 'b' });
  assert.ok(hidden.isError && /别发/.test(hidden.content), '【别发】的发不出去');
  assert.equal(sent.length, 0);
}

console.log('forward-sticker: PASS（假 OneBot，没有发 QQ 消息）');
