// 自己写的工具：tools/ 下每个 .js 文件 default export 一个工具定义（约定见 README.md），
// 这里逐个导入、注册。单个文件坏了只跳过它自己，不影响别的工具和整个插件。
//
// 导入时带文件内容 hash：文件没改就还是同一个模块，改了才重新执行它的顶层代码。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(HERE, 'tools');

export function checkTool(def) {
  if (!def || typeof def !== 'object') return '没有 default export 工具定义';
  if (!/^[a-z][a-z0-9_]{2,37}$/.test(String(def.id || ''))) return 'id 必须是 3-38 位小写字母 / 数字 / 下划线，字母开头';
  if (!String(def.name || '').trim()) return '缺 name（中文显示名）';
  if (String(def.description || '').trim().length < 10) return 'description 太短（要写清楚什么时候用）';
  if (!def.parameters || def.parameters.type !== 'object') return 'parameters 必须是 { type: "object", properties: {...} }';
  if (typeof def.execute !== 'function') return '缺 execute(ctx, args) 函数';
  return '';
}

export async function setup(api) {
  if (api.config()?.enabled === false) return;
  let files = [];
  try { files = fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js')).sort(); } catch { return; }
  for (const f of files) {
    const file = path.join(TOOLS_DIR, f);
    try {
      const ver = createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
      const mod = await import(`${pathToFileURL(file).href}?v=${ver}`);
      const def = mod.default;
      const bad = checkTool(def);
      if (bad) { api.log?.(`[self-tools] 跳过 ${f}：${bad}`); continue; }
      api.registerTool({ category: 'utility', icon: '🛠️', ...def });
    } catch (e) {
      api.log?.(`[self-tools] 加载 ${f} 失败：${e?.message ?? e}`);
    }
  }
}
