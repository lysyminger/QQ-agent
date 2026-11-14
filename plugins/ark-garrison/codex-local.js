// plugins/ark-garrison/codex-local.js
//
// 命令行试玩（play.mjs）用的 Codex 调用：直接起 `codex exec`，和 codex-bridge 的 runOnce 参数口径一致。
// 在 QQ 应用里跑时走 codex-bridge 提供的 codex.run 能力，不用这个文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_CODEX_JS = 'D:\\Development\\node-v24.11.0-win-x64\\node_modules\\@openai\\codex\\bin\\codex.js';
// 只让它看图想事情：关掉能碰电脑的工具
const DISABLE = ['shell_tool', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'apps', 'multi_agent', 'plugins', 'memories', 'code_mode_host', 'image_generation'];

export function createLocalAsk({ codexJs = process.env.CODEX_JS || DEFAULT_CODEX_JS, model = process.env.ARK_MODEL || '' } = {}) {
  if (!fs.existsSync(codexJs)) throw new Error(`找不到 Codex CLI：${codexJs}（设环境变量 CODEX_JS）`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-codex-'));

  return function ask({ prompt, images = [], schema = null, effort = 'medium', timeoutMinutes = 4 }) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const outFile = path.join(tmp, `out-${stamp}.txt`);
    const schemaFile = schema ? path.join(tmp, `schema-${stamp}.json`) : '';
    if (schema) fs.writeFileSync(schemaFile, JSON.stringify(schema), 'utf8');
    const args = [codexJs, 'exec',
      ...images.flatMap((p) => ['-i', p]),
      '--json', '--skip-git-repo-check', '--ephemeral',
      ...(model ? ['-m', model] : []),
      '-c', `model_reasoning_effort="${effort}"`,
      ...(schemaFile ? ['--output-schema', schemaFile] : []),
      ...DISABLE.flatMap((f) => ['--disable', f]),
      '-c', 'sandbox_mode="read-only"', '-c', 'web_search="disabled"', '-o', outFile, '-C', tmp, '-'];
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, args, { cwd: tmp, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let error = '';
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { const ev = JSON.parse(line); if (ev.type === 'turn.failed' || ev.type === 'error') error = String(ev.error?.message || ev.message || '').slice(0, 300); } catch { /* ignore */ }
        }
      });
      child.stderr.on('data', () => {});
      const timer = setTimeout(() => { error = `超过 ${timeoutMinutes} 分钟`; child.kill(); }, timeoutMinutes * 60000);
      child.on('close', () => {
        clearTimeout(timer);
        let text = '';
        try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch { /* ignore */ }
        for (const f of [outFile, schemaFile]) { if (f) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
        const seconds = Math.round((Date.now() - started) / 1000);
        if (!text || error) { resolve({ ok: false, error: error || '没有输出', seconds }); return; }
        let json = null;
        if (schema) { try { json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text); } catch { resolve({ ok: false, error: 'Codex 没按格式返回 JSON', seconds }); return; } }
        resolve({ ok: true, text, json, seconds });
      });
      child.stdin.end(prompt, 'utf8');
    });
  };
}
