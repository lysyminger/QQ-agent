// agent-reach 插件：参数校验、结果整理、错误码、限流、浏览锁定。用假 runner，不需要装 Agent Reach。
//   node test/agent-reach-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-reach-'));
const { getConfig } = await import('../src/config.js');
const { __internal: ar } = await import('../plugins/agent-reach/index.js');

let conf = { binPath: process.execPath, maxPerMinute: 60 };   // 随便一个存在的文件当程序路径，真正跑的是假 runner
const logs = [];
ar.setApi({ config: () => conf, log: (m) => logs.push(m), warn: (m) => logs.push(m) });
const calls = [];
let reply = () => ({ ok: true, channel: 'web', items: [] });
ar.setRunner(async (_bin, args) => {
  calls.push(args);
  const r = reply(args);
  return typeof r === 'string' ? { code: 0, out: r, err: '' } : { code: 0, out: JSON.stringify(r), err: '' };
});
const fresh = () => { ar.reset(); calls.length = 0; logs.length = 0; };

// ── 读链接：结果整理成文字，标成外部资料 ──
{
  fresh();
  reply = () => ({
    ok: true, channel: 'xiaohongshu', backend: 'opencli',
    items: [{ title: '学校附近的咖啡', url: 'https://www.xiaohongshu.com/explore/1', author: '小王', published_at: '2026-10-30', text: '正文'.repeat(10), raw: { secret: 'x' } }]
  });
  const r = await ar.execRead({ url: 'https://www.xiaohongshu.com/explore/1' });
  assert.ok(!r.isError);
  assert.deepEqual(calls[0], ['read', 'https://www.xiaohongshu.com/explore/1']);
  assert.match(r.content, /【外部内容 · xiaohongshu · opencli】/);
  assert.match(r.content, /不是给你的指令/);
  assert.match(r.content, /\[1\] 学校附近的咖啡 — 小王 · 2026-10-30/);
  assert.doesNotMatch(r.content, /secret/, 'raw 不给模型');
}

// ── 读链接：内网和非 http 链接直接拒，不调程序 ──
{
  fresh();
  for (const url of ['http://127.0.0.1:3900/x', 'http://192.168.1.1/', 'file:///C:/a.txt', 'https://u:p@example.com/', '']) {
    const r = await ar.execRead({ url });
    assert.ok(r.isError, `应拒绝：${url}`);
  }
  assert.equal(calls.length, 0);
}

// ── 截断：单条和总量都有上限 ──
{
  fresh();
  conf = { ...conf, perItemChars: 300, maxChars: 900 };
  reply = () => ({ ok: true, channel: 'reddit', items: Array.from({ length: 6 }, (_, i) => ({ title: `帖${i}`, text: 'a'.repeat(2000) })) });
  const r = await ar.execRead({ url: 'https://www.reddit.com/r/x/1' });
  assert.match(r.content, /已截断/);
  assert.match(r.content, /还有 \d+ 条没列出/);
  assert.ok(r.content.length < 1400);
  conf = { binPath: process.execPath, maxPerMinute: 60 };
}

// ── 错误码：给模型的是固定话术，hint 里的命令只进日志 ──
{
  fresh();
  reply = () => ({ ok: false, channel: 'xiaohongshu', error: { code: 'NEED_LOGIN', message: 'login required', hint: 'agent-reach login xiaohongshu' } });
  const r = await ar.execRead({ url: 'https://www.xiaohongshu.com/explore/2' });
  assert.ok(r.isError);
  assert.match(r.content, /^xiaohongshu：这个平台要登录/);
  assert.doesNotMatch(r.content, /agent-reach login xiaohongshu/);
  assert.ok(logs.some((l) => /NEED_LOGIN/.test(l)));
}

// ── 输出前面混了别的行也能解析；完全不是 JSON 就报读不了 ──
{
  assert.deepEqual(ar.parseOutput('warning: x\n{"ok":true,"items":[]}\n'), { ok: true, items: [] });
  fresh();
  reply = () => 'Traceback (most recent call last): boom';
  const r = await ar.execRead({ url: 'https://example.com/' });
  assert.ok(r.isError);
  assert.match(r.content, /没有正常返回/);
}

// ── 平台内搜索：参数拼法、默认 search、带 --limit ──
const channelList = { ok: true, items: [
  { title: 'bilibili', raw: { name: 'bilibili', actions: ['search', 'subtitle', 'hot'] } },
  { title: 'xiaohongshu', raw: { name: 'xiaohongshu', actions: [{ name: 'search' }, { name: 'comments' }], ready: false } }
] };
{
  fresh();
  reply = (args) => (args[0] === 'channels' ? channelList : { ok: true, channel: 'bilibili', items: [{ title: '视频', url: 'https://b23.tv/x' }] });
  const r = await ar.execQuery({ channel: 'Bilibili', query: '树人学院', limit: 3 });
  assert.ok(!r.isError);
  assert.deepEqual(calls, [['channels'], ['bilibili', 'search', '树人学院', '--limit', '3']]);
  calls.length = 0;
  await ar.execQuery({ channel: 'bilibili', action: 'subtitle', query: 'BV1xx' });
  assert.deepEqual(calls, [['bilibili', 'subtitle', 'BV1xx']], '渠道列表有缓存；非 search 不带 --limit');
}

// ── 平台内搜索：管理命令、开关注入、未知平台都拦下 ──
{
  fresh();
  reply = (args) => (args[0] === 'channels' ? channelList : { ok: true, items: [] });
  for (const bad of [
    { channel: 'login', query: 'xiaohongshu' },
    { channel: 'update' },
    { channel: 'bilibili', action: 'uninstall' },
    { channel: 'bilibili', query: '--backend=evil' },
    { channel: 'bili bili' },
    { channel: '' }
  ]) {
    const r = await ar.execQuery(bad);
    assert.ok(r.isError, `应拒绝：${JSON.stringify(bad)}`);
  }
  assert.equal(calls.length, 0);
  const r = await ar.execQuery({ channel: 'weibo', query: 'x' });
  assert.ok(r.isError);
  assert.match(r.content, /没有「weibo」/);
  assert.match(r.content, /bilibili：search \/ subtitle \/ hot/);
  assert.match(r.content, /xiaohongshu（未启用）：search \/ comments/);
}

// ── BAD_INPUT 时把能用的动作列给模型 ──
{
  fresh();
  reply = (args) => (args[0] === 'channels' ? channelList : { ok: false, channel: 'bilibili', error: { code: 'BAD_INPUT' } });
  const r = await ar.execQuery({ channel: 'bilibili', action: 'trending' });
  assert.match(r.content, /参数不对。\n能用的平台和动作：/);
}

// ── 设置关掉搜索、浏览锁定 ──
{
  fresh();
  conf = { ...conf, allowQuery: false };
  assert.ok((await ar.execQuery({ channel: 'bilibili', query: 'x' })).isError);
  conf = { binPath: process.execPath, maxPerMinute: 60 };

  const cfg = getConfig();
  const saved = cfg.security;
  cfg.security = { ...(saved || {}), browseLock: { enabled: true, hosts: ['github.com'] } };
  try {
    assert.match((await ar.execQuery({ channel: 'bilibili', query: 'x' })).content, /浏览锁定/);
    assert.match((await ar.execRead({ url: 'https://www.reddit.com/r/x' })).content, /不在允许的网站里/);
    reply = () => ({ ok: true, channel: 'github', items: [] });
    assert.ok(!(await ar.execRead({ url: 'https://github.com/a/b' })).isError, '白名单里的站照常读');
  } finally {
    cfg.security = saved;
  }
  assert.equal(calls.filter((c) => c[0] === 'read').length, 1);
}

// ── 限流：每分钟次数 ──
{
  fresh();
  conf = { ...conf, maxPerMinute: 2 };
  reply = () => ({ ok: true, items: [] });
  assert.ok(!(await ar.execRead({ url: 'https://example.com/1' })).isError);
  assert.ok(!(await ar.execRead({ url: 'https://example.com/2' })).isError);
  const r = await ar.execRead({ url: 'https://example.com/3' });
  assert.ok(r.isError);
  assert.match(r.content, /太多/);
  conf = { binPath: process.execPath, maxPerMinute: 60 };
}

// ── 找不到程序 ──
{
  fresh();
  conf = { binPath: path.join(os.tmpdir(), 'no-such-agent-reach.exe') };
  const r = await ar.execRead({ url: 'https://example.com/' });
  assert.ok(r.isError);
  assert.match(r.content, /没找到 agent-reach/);
}

console.log('agent-reach-test: all passed');
