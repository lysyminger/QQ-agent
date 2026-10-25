// 工坊自测：node validate.mjs <工具文件>
// 在独立子进程里跑（坏代码最多搞崩这个子进程，碰不到正在运行的机器人）：
//   ① 能导入  ② 定义合法（checkTool）  ③ 有 test() 就跑它（60 秒超时）
// 成功：退出码 0，stdout 打一行 JSON { ok, id, name }；失败：退出码 1，stderr 是原因。
import { pathToFileURL } from 'node:url';
import { checkTool } from './index.js';

const file = process.argv[2];
const fail = (msg) => { process.stderr.write(String(msg).slice(0, 2000)); process.exit(1); };
if (!file) fail('用法：node validate.mjs <工具文件>');

setTimeout(() => fail('自测超过 60 秒'), 60000).unref();
try {
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  const bad = checkTool(mod.default);
  if (bad) fail(`定义不合法：${bad}`);
  if (typeof mod.test === 'function') await mod.test();
  process.stdout.write(JSON.stringify({ ok: true, id: mod.default.id, name: mod.default.name }));
  process.exit(0);
} catch (e) {
  fail(`自测失败：${e?.stack || e?.message || e}`);
}
