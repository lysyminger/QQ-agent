// plugins/ark-garrison/index.js
//
// 卫戍协议陪玩插件入口。现在只有底层（maa.js）和测速（bench.mjs），游戏循环还没写。
// maa.js 按需动态加载：maa-node 带 ~90MB 原生 DLL，插件开着但没在玩时不该把它拉进主进程。

import { logger } from '../../src/logger.js';

const ID = 'ark-garrison';
let cfg = null;

const settings = () => ({ serial: '', ...(typeof cfg === 'function' ? cfg() : {}) });

/** 连一次模拟器，截一张图 + 全屏 OCR，返回各步耗时（给控制台 / 其他插件排查用）。 */
async function bench() {
  const maa = await import('./maa.js');
  const session = await maa.connect({ serial: settings().serial });
  try {
    const cap = await maa.screencap(session.ctrl);
    const r = await maa.ocr(session.tasker, cap.image);
    return {
      ok: true,
      device: session.device,
      timings: { ...session.timings, screencapMs: cap.ms, ocrMs: r.ms },
      texts: r.items.map((x) => x.text)
    };
  } finally {
    maa.close(session);
  }
}

export function setup(api) {
  cfg = api.config;
  logger.info(ID, '已加载（开发中）：目前只有测速，node plugins/ark-garrison/bench.mjs');
}

export const providers = {
  'ark.bench': () => bench().catch((e) => ({ ok: false, error: e.message }))
};
