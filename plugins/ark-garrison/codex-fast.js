// plugins/ark-garrison/codex-fast.js
//
// 命令行训练 / 试玩用的 Codex 调用：常驻一个 `codex app-server`，每一步开一个用完即弃（ephemeral）的新对话。
// 和 codex-local.js（每步起一次 `codex exec`）的接口一样：ask({ prompt, images, schema, effort, timeoutMinutes })
//   → { ok, text, json, seconds } 或 { ok:false, error, seconds }。
//
// 2026-11-10 实测（同一张截图、同一份提示词）：
//   codex exec 每步 13～17 秒起（光启动进程、加载配置插件、新建会话就占一大半）；
//   常驻 app-server 每步约 10～14 秒：新开对话只要 0.1 秒，剩下基本是服务端模型本身的耗时，
//   换模型（gpt-5.6-luna / gpt-6.1-terra / gpt-6-luna）、去掉图片、缩短提示词都在 10 秒上下。
// 所以这里能省的是进程开销；再往下只能靠少问（本地规则、一次多排几步）。
//
// 几个讲究：
//   · baseInstructions 换成一句短的：不要 Codex 默认那一大段写代码的系统提示；工具、联网全关。
//   · serviceTier=priority（模型列表里的「Fast」档，luna 标的是 1.5 倍速，不额外耗额度）；不支持时自动去掉重试。
//   · Cockpit 换号是改 ~/.codex/auth.json；常驻进程不一定会重新读，所以每次调用前比一下当前号，变了就重启进程。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readCurrentAccount } from './quota.js';

const DEFAULT_CODEX_JS = 'D:\\Development\\node-v24.11.0-win-x64\\node_modules\\@openai\\codex\\bin\\codex.js';
const BASE = '你在替人操作手机游戏《明日方舟》。看截图和文字，严格按给定的 JSON 格式回答，不调用任何工具。';
const OFF = ['shell_tool', 'apps', 'plugins', 'memories', 'multi_agent', 'image_generation', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'code_mode_host'];

export function createFastAsk({ codexJs = process.env.CODEX_JS || DEFAULT_CODEX_JS, model = process.env.ARK_MODEL || '', tier = process.env.ARK_TIER ?? 'priority', log = () => {} } = {}) {
  if (!fs.existsSync(codexJs)) throw new Error(`找不到 Codex CLI：${codexJs}（设环境变量 CODEX_JS）`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-codex-'));
  let srv = null;          // { child, pending, listeners, account }
  let starting = null;
  let useTier = tier;

  function start() {
    const child = spawn(process.execPath, [codexJs, 'app-server'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const s = { child, pending: new Map(), listeners: new Set(), nextId: 1, alive: true, account: readCurrentAccount()?.key || '' };
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && !m.method && s.pending.has(m.id)) {
          const p = s.pending.get(m.id);
          s.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)));
          else p.resolve(m.result);
          continue;
        }
        // 它来要批准（不该发生，工具都关了）：一律拒绝
        if (m.id != null && m.method) { send(s, { id: m.id, result: { decision: 'decline' } }); continue; }
        for (const l of s.listeners) l(m);
      }
    });
    child.stderr.on('data', () => {});
    const die = (why) => {
      if (!s.alive) return;
      s.alive = false;
      for (const p of s.pending.values()) p.reject(new Error(why));
      s.pending.clear();
      for (const l of s.listeners) l({ method: '__exit', why });
      if (srv === s) srv = null;
    };
    child.on('exit', (code) => die(`Codex 进程退出（${code}）`));
    child.on('error', (e) => die(`启动 Codex 失败：${e.message}`));
    return s;
  }

  const send = (s, obj) => { if (s.alive) s.child.stdin.write(`${JSON.stringify(obj)}\n`); };
  const request = (s, method, params, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = s.nextId++;
    const timer = setTimeout(() => { s.pending.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs);
    s.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    send(s, { id, method, params });
  });

  function stop() {
    const s = srv;
    srv = null;
    if (s) { s.alive = false; try { s.child.kill(); } catch { /* ignore */ } }
  }

  async function server() {
    // Cockpit 换了号：重启进程，让它重新读 auth.json
    const now = readCurrentAccount()?.key || '';
    if (srv?.alive && srv.account !== now) { log('Codex 账号换了，重启常驻进程'); stop(); }
    if (srv?.alive) return srv;
    if (starting) return starting;
    starting = (async () => {
      const s = start();
      try {
        await request(s, 'initialize', { clientInfo: { name: 'ark-garrison', version: '1.0' }, capabilities: { experimentalApi: true } }, 60000);
        send(s, { method: 'initialized' });
        srv = s;
        return s;
      } catch (e) {
        try { s.child.kill(); } catch { /* ignore */ }
        throw e;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  async function turn(s, { prompt, images, schema, effort, timeoutMs }) {
    const th = await request(s, 'thread/start', {
      cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
      ...(model ? { model } : {}),
      baseInstructions: BASE,
      config: { web_search: 'disabled', ...Object.fromEntries(OFF.map((f) => [`features.${f}`, false])) }
    });
    const threadId = th.thread.id;
    return new Promise((resolve) => {
      let text = '';
      let settled = false;
      const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); s.listeners.delete(l); resolve(r); };
      const l = (m) => {
        if (m.method === '__exit') return finish({ error: m.why });
        const p = m.params || {};
        if (p.threadId && p.threadId !== threadId) return;
        if (m.method === 'item/completed' && p.item?.type === 'agentMessage') text = p.item.text || text;
        if (m.method === 'error') finish({ error: String(p.error?.message || p.message || '出错了') });
        if (m.method === 'turn/completed') {
          const t = p.turn || {};
          if (t.status === 'failed' || t.error) finish({ error: String(t.error?.message || t.error || 'Codex 这一轮失败了') });
          else finish({ text });
        }
      };
      const timer = setTimeout(() => {
        request(s, 'turn/interrupt', { threadId }).catch(() => {});
        finish({ error: `超过 ${Math.round(timeoutMs / 60000)} 分钟` });
      }, timeoutMs);
      s.listeners.add(l);
      request(s, 'turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }, ...images.map((p) => ({ type: 'localImage', path: p }))],
        ...(effort ? { effort } : {}),
        ...(schema ? { outputSchema: schema } : {}),
        ...(useTier ? { serviceTier: useTier } : {})
      }).catch((e) => finish({ error: e.message, startFailed: true }));
    });
  }

  async function ask({ prompt, images = [], schema = null, effort = 'medium', timeoutMinutes = 4 }) {
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 100) / 10;
    let r;
    try {
      const s = await server();
      r = await turn(s, { prompt, images, schema, effort, timeoutMs: timeoutMinutes * 60000 });
      // Fast 档不被接受：去掉再来一次，以后都不带
      if (r.error && useTier && /service.?tier|priority/i.test(r.error)) {
        log(`Fast 档用不了（${r.error.slice(0, 80)}），改用默认档`);
        useTier = '';
        r = await turn(s, { prompt, images, schema, effort, timeoutMs: timeoutMinutes * 60000 });
      }
    } catch (e) {
      r = { error: e.message };
    }
    if (r.error && /进程退出|启动 Codex 失败|没在运行/.test(r.error)) stop();
    const text = String(r.text || '').trim();
    if (r.error || !text) return { ok: false, error: String(r.error || '没有输出').slice(0, 300), seconds: seconds() };
    let json = null;
    if (schema) {
      try { json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text); } catch { return { ok: false, error: 'Codex 没按格式返回 JSON', seconds: seconds() }; }
    }
    return { ok: true, text, json, seconds: seconds() };
  }

  ask.close = stop;
  return ask;
}
