// plugins/ark-garrison/probe.mjs —— 开发时手动探路：截一张图 + OCR，或者点一下 / 滑一下再截。
//
//   node plugins/ark-garrison/probe.mjs shot [名字]           截图 + 全屏 OCR
//   node plugins/ark-garrison/probe.mjs click x y [名字]      点 (x,y) 后等 1.5 秒再截
//   node plugins/ark-garrison/probe.mjs swipe x1 y1 x2 y2 [名字]
//   node plugins/ark-garrison/probe.mjs back [名字]           按返回键
//   node plugins/ark-garrison/probe.mjs hold x y [名字]       按住 (x,y) 往上提一点，按着时截图（看能放的格子亮没亮），再放回原处松手
//
// 坐标都按 1280x720。输出到 data/ark-garrison/probe/<名字>.png / .txt，并把 OCR 结果打到终端。

import fs from 'node:fs';
import path from 'node:path';
import { connect, screencap, ocr, click, swipe, key, close, WORK_DIR } from './maa.js';

const [cmd = 'shot', ...rest] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nums = rest.filter((x) => /^-?\d+$/.test(x)).map(Number);
const name = rest.find((x) => !/^-?\d+$/.test(x)) || `p${Date.now()}`;

const session = await connect();
try {
  if (cmd === 'click') { await click(session.ctrl, nums[0], nums[1]); await sleep(1500); }
  else if (cmd === 'swipe') { await swipe(session.ctrl, nums[0], nums[1], nums[2], nums[3], 400); await sleep(1500); }
  else if (cmd === 'back') { await key(session.ctrl, 4); await sleep(1500); }
  let held = false;
  if (cmd === 'hold') {
    const [x, y] = nums;
    await session.ctrl.post_touch_down(0, x, y, 1).wait();
    await sleep(200);
    for (let i = 1; i <= 6; i++) { await session.ctrl.post_touch_move(0, x, y - i * 10, 1).wait(); await sleep(30); }
    await sleep(500);
    held = true;
  }
  const cap = await screencap(session.ctrl);
  if (held) {
    for (let i = 5; i >= 0; i--) { await session.ctrl.post_touch_move(0, nums[0], nums[1] - i * 10, 1).wait(); await sleep(30); }
    await session.ctrl.post_touch_up(0).wait();
  }
  const r = await ocr(session.tasker, cap.image);
  const dir = path.join(WORK_DIR, 'probe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(cap.image));
  const lines = r.items.map((x) => `${x.text}  @${x.box.join(',')}`);
  fs.writeFileSync(path.join(dir, `${name}.txt`), lines.join('\n'), 'utf8');
  console.log(path.join(dir, `${name}.png`));
  console.log(lines.join('\n'));
} finally {
  close(session);
}
