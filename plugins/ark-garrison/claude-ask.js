// plugins/ark-garrison/claude-ask.js
//
// 用主人的 Claude 订阅（本机 Claude Code 的登录）做决策：Claude Agent SDK 起一次 Claude Code，
// 自定义一句短系统提示、关掉所有工具、不读用户的设置 / MCP，按 JSON 格式回答。
// 接口和 codex-fast.js 一样：ask({ prompt, images, schema, effort, timeoutMinutes }) → { ok, text, json, seconds } / { ok:false, error }。
//
// 登录过期时报「Claude 没登录」：在终端运行一次 `claude`，按提示 /login。
// 模型默认 sonnet（ARK_CLAUDE_MODEL 可改，比如 haiku）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SYSTEM = '你在替人操作手机游戏《明日方舟》的「卫戍协议」模式。看截图和文字，严格按给定的 JSON 格式回答。';

export function createClaudeAsk({ model = process.env.ARK_CLAUDE_MODEL || 'sonnet', log = () => {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-claude-'));

  async function ask({ prompt, images = [], schema = null, effort = 'low', timeoutMinutes = 3 }) {
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 100) / 10;
    const content = [
      ...images.map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.endsWith('.jpg') ? 'image/jpeg' : 'image/png', data: fs.readFileSync(p).toString('base64') } })),
      { type: 'text', text: prompt }
    ];
    async function* input() {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMinutes * 60000);
    let result = null;
    let error = '';
    try {
      const q = query({
        prompt: input(),
        options: {
          model, cwd, abortController: ac,
          systemPrompt: SYSTEM,
          tools: [],
          settingSources: [],
          persistSession: false,
          maxTurns: 6,   // 按格式输出要走一轮内部工具，Haiku 偶尔要重试几次；3 次时它一半会超
          effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : 'low',
          ...(schema ? { outputFormat: { type: 'json_schema', schema } } : {})
        }
      });
      for await (const m of q) {
        if (m.type === 'result') { result = m; break; }
      }
    } catch (e) {
      error = ac.signal.aborted ? `超过 ${timeoutMinutes} 分钟` : String(e?.message || e);
    } finally {
      clearTimeout(timer);
    }
    if (!result && !error) error = '没有输出';
    if (result && result.subtype !== 'success') error = `${result.subtype}${result.errors?.length ? `：${result.errors.join('；')}` : ''}`;
    if (result?.is_error && !error) error = String(result.result || '出错了');
    if (error) {
      if (/OAuth|authenticat|login|401|Not logged/i.test(error)) error = `Claude 没登录（在终端运行 claude 按提示登录）：${error.slice(0, 120)}`;
      log(`Claude 出错：${error}`);
      return { ok: false, error: error.slice(0, 300), seconds: seconds() };
    }
    const text = String(result.result || '').trim();
    let json = result.structured_output ?? null;
    if (schema && !json) {
      try { json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text); } catch { return { ok: false, error: 'Claude 没按格式返回 JSON', seconds: seconds() }; }
    }
    return { ok: true, text: text || JSON.stringify(json), json, seconds: seconds(), usage: result.usage, costUsd: result.total_cost_usd };
  }

  ask.close = () => {};
  return ask;
}

/**
 * 主脑用完额度时退到备用脑：primary 报额度错误后 coolMinutes 分钟内都走 secondary，之后再试 primary。
 * 两个都是 ask 函数（同一个接口）。
 */
export function withFallback(primary, secondary, { isQuota, coolMinutes = 30, log = () => {} }) {
  let downUntil = 0;
  const ask = async (opts) => {
    if (Date.now() >= downUntil) {
      const r = await primary(opts);
      if (r.ok || !isQuota(r.error)) return r;
      downUntil = Date.now() + coolMinutes * 60000;
      log(`主脑额度用完（${String(r.error).slice(0, 80)}），${coolMinutes} 分钟内改用备用`);
    }
    return secondary(opts);
  };
  ask.close = () => { primary.close?.(); secondary.close?.(); };
  return ask;
}
