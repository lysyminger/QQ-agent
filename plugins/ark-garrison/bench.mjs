// plugins/ark-garrison/bench.mjs —— 最小验证：MaaFramework 截图 / OCR / 点击各要多久。
//
//   node plugins/ark-garrison/bench.mjs                       只截图 + OCR（不碰游戏）
//   node plugins/ark-garrison/bench.mjs --rounds 10           多测几轮取平均
//   node plugins/ark-garrison/bench.mjs --serial 127.0.0.1:16384
//   node plugins/ark-garrison/bench.mjs --adb D:/Development/adb/adb.exe
//   node plugins/ark-garrison/bench.mjs --click 640,20        额外测点击（⚠️ 会真的点游戏，挑个空白处）
//
// 结果：控制台打印耗时；最后一张截图和 OCR 结果存到 data/ark-garrison/bench/。

import fs from 'node:fs';
import path from 'node:path';
import { connect, screencap, ocr, click, close, WORK_DIR } from './maa.js';

function args() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : ''; };
  return {
    rounds: Math.max(1, Number(get('--rounds')) || 5),
    serial: get('--serial'),
    adb: get('--adb'),
    click: get('--click')
  };
}

const fmt = (ms) => `${ms.toFixed(1)}ms`;
function stats(list) {
  const s = [...list].sort((x, y) => x - y);
  const avg = s.reduce((x, y) => x + y, 0) / s.length;
  return `平均 ${fmt(avg)}｜最快 ${fmt(s[0])}｜最慢 ${fmt(s[s.length - 1])}`;
}

async function main() {
  const opt = args();
  const session = await connect({ adbPath: opt.adb, serial: opt.serial });
  const { ctrl, tasker, device, timings } = session;
  try {
    console.log(`设备：${device.name}  ${device.address}`);
    console.log(`分辨率：${(ctrl.resolution || []).join('x') || '未知'}`);
    console.log(`找设备 ${fmt(timings.findMs)}｜加载 OCR 模型 ${fmt(timings.resourceMs)}｜连接 ${fmt(timings.connectMs)}（一次性开销）`);

    const capMs = [];
    const ocrMs = [];
    let last = null;
    for (let i = 0; i < opt.rounds; i++) {
      const cap = await screencap(ctrl);
      const r = await ocr(tasker, cap.image);
      capMs.push(cap.ms);
      ocrMs.push(r.ms);
      last = { image: cap.image, items: r.items };
      console.log(`第 ${i + 1} 轮：截图 ${fmt(cap.ms)}  全屏 OCR ${fmt(r.ms)}（${r.items.length} 段文字）`);
    }
    console.log(`\n截图     ${stats(capMs)}`);
    console.log(`全屏 OCR ${stats(ocrMs)}`);
    console.log(`看一眼合计 ≈ ${fmt(capMs.reduce((x, y) => x + y, 0) / capMs.length + ocrMs.reduce((x, y) => x + y, 0) / ocrMs.length)}`);

    if (opt.click) {
      const [x, y] = opt.click.split(',').map(Number);
      const c = await click(ctrl, x, y);
      console.log(`点击 (${x},${y})：${c.ok ? '成功' : '失败'} ${fmt(c.ms)}`);
    }

    const out = path.join(WORK_DIR, 'bench');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'screen.png'), Buffer.from(last.image));
    fs.writeFileSync(path.join(out, 'ocr.json'), JSON.stringify(last.items, null, 2), 'utf8');
    console.log(`\n最后一张截图和 OCR 结果：${out}`);
    console.log('识别到的文字（前 30 段）：');
    for (const it of last.items.slice(0, 30)) console.log(`  [${it.box.join(',')}] ${it.text}`);
  } finally {
    close(session);
  }
}

main().catch((e) => {
  console.error(`失败：${e.message}`);
  process.exitCode = 1;
});
