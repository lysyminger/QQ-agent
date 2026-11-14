// plugins/ark-garrison/cal.mjs —— 开发时校准用：对存好的截图按区域（roi）做 OCR，看小数字能不能读准。
//
//   node plugins/ark-garrison/cal.mjs <截图.png> [x,y,w,h ...]     不给区域就读 screen.js 里定义的全部区域
//
// 截图要是 1280x720（probe.mjs / eyes 存的都是）。

import fs from 'node:fs';
import { connect, ocr, close } from './maa.js';
import { REGIONS } from './screen.js';

const [file, ...rois] = process.argv.slice(2);
if (!file) { console.log('用法：node plugins/ark-garrison/cal.mjs <截图.png> [x,y,w,h ...]'); process.exit(1); }
const buf = fs.readFileSync(file);
const image = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const s = await connect();
try {
  const list = rois.length
    ? rois.map((r, i) => [`roi${i}`, r.split(',').map(Number)])
    : Object.entries(REGIONS).flatMap(([k, v]) => (Array.isArray(v[0]) ? v.map((r, i) => [`${k}${i}`, r]) : [[k, v]]));
  for (const [name, roi] of list) {
    const r = await ocr(s.tasker, image, roi, { onlyRec: process.env.ONLY_REC === '1' });
    console.log(name.padEnd(12), JSON.stringify(roi).padEnd(22), `${Math.round(r.ms)}ms`.padEnd(6), r.items.map((x) => `${x.text}(${(x.score ?? 0).toFixed(2)})`).join(' | ') || '（空）');
  }
} finally {
  close(s);
}
