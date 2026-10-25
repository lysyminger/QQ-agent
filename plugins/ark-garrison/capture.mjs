// plugins/ark-garrison/capture.mjs —— 采集素材：你正常玩，它在旁边只看不点，界面一变就存一张。
//
//   node plugins/ark-garrison/capture.mjs                  默认采 30 分钟，Ctrl+C 随时停
//   node plugins/ark-garrison/capture.mjs --minutes 60 --interval 1500
//
// 判断"界面变了"：每次截图做全屏 OCR，和上一张存下来的图比文字重合度，低于 60% 就算新界面。
// 输出：data/ark-garrison/capture/<时间>/NNN.png + NNN.json（OCR 文字和坐标，坐标按 1280x720）。
// 这些图之后拿来裁模板、定 OCR 区域；全程不会点游戏。

import fs from 'node:fs';
import path from 'node:path';
import { connect, screencap, ocr, close, WORK_DIR } from './maa.js';

function args() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : ''; };
  return {
    minutes: Number(get('--minutes')) || 30,
    interval: Math.max(500, Number(get('--interval')) || 1500),
    serial: get('--serial')
  };
}

// 只比"像文字"的识别结果：图标上的乱码（1~2 个字符）会随动画抖动，算进去每帧都像新界面
const textsOf = (items) => new Set(items.map((x) => x.text.trim()).filter((t) => t.length >= 2));
function overlap(a, b) {
  if (!a.size && !b.size) return 1;
  let same = 0;
  for (const t of a) if (b.has(t)) same++;
  return same / Math.max(a.size, b.size);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function main() {
  const opt = args();
  const out = path.join(WORK_DIR, 'capture', stamp());
  fs.mkdirSync(out, { recursive: true });
  const session = await connect({ serial: opt.serial });
  const deadline = Date.now() + opt.minutes * 60000;
  let stop = false;
  process.on('SIGINT', () => { stop = true; });

  console.log(`开始采集（${session.device.name}），每 ${opt.interval}ms 看一眼，最长 ${opt.minutes} 分钟；输出 ${out}`);
  let lastTexts = null;
  let n = 0;
  try {
    while (!stop && Date.now() < deadline) {
      const t0 = Date.now();
      try {
        const cap = await screencap(session.ctrl);
        const r = await ocr(session.tasker, cap.image);
        const texts = textsOf(r.items);
        if (!lastTexts || overlap(texts, lastTexts) < 0.6) {
          n++;
          const name = String(n).padStart(3, '0');
          fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(cap.image));
          fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ at: new Date().toISOString(), items: r.items }, null, 2), 'utf8');
          lastTexts = texts;
          console.log(`#${name} 新界面：${[...texts].slice(0, 6).join(' / ') || '（没有文字）'}`);
        }
      } catch (e) {
        console.warn(`这一帧失败：${e.message}`);
      }
      await sleep(Math.max(0, opt.interval - (Date.now() - t0)));
    }
  } finally {
    close(session);
    console.log(`结束，共存了 ${n} 个界面：${out}`);
  }
}

main().catch((e) => {
  console.error(`失败：${e.message}`);
  process.exitCode = 1;
});
