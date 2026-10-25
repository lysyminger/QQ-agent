// plugins/ark-garrison/maa.js
//
// 卫戍协议陪玩的"眼睛和手"：MaaFramework（@maaxyz/maa-node）的薄封装。
// 只做三件事：连模拟器、截图、OCR / 点击；怎么玩由上层（Codex）决定。
//
// ── 依赖放哪 ────────────────────────────────────────────────────────────
//   maa-node 带 ~90MB 原生 DLL，只有这个插件用，所以装在插件自己的 node_modules 里
//   （plugins/ark-garrison/package.json），不进主程序 package.json。
//   它是 CJS 包，加载后挂在 globalThis.maa 上，这里用 createRequire 取。
//
// ── OCR 模型 ────────────────────────────────────────────────────────────
//   直接用 MAA 仓库里的 PaddleOCR 模型（mode/MaaAssistantArknights/resource/PaddleOCR），
//   它对方舟的字体调过；首次运行时按 MaaFramework 要求的 model/ocr/{det,rec}.onnx + keys.txt
//   布局复制到 data/ark-garrison/resource/ 下。mode/ 不入库，所以缺了就报清楚去哪下。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR, ROOT } from '../../src/config.js';

const require = createRequire(import.meta.url);

export const WORK_DIR = path.join(DATA_DIR, 'ark-garrison');
export const RESOURCE_DIR = path.join(WORK_DIR, 'resource');
const MAA_OCR_DIR = path.join(ROOT, 'mode', 'MaaAssistantArknights', 'resource', 'PaddleOCR');

let maaLib = null;
export function loadMaa() {
  if (maaLib) return maaLib;
  try {
    maaLib = require('@maaxyz/maa-node');
  } catch (e) {
    throw new Error(`加载 MaaFramework 失败（在 plugins/ark-garrison 里 npm install 过吗？）：${e.message}`);
  }
  return maaLib;
}

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // 毫秒，带小数

/**
 * 准备 MaaFramework 资源包：只需要 OCR 模型；识别全部走代码直调。
 * pipeline 目录不能是空的（空目录 load_all_json 直接判失败），放一个什么都不做的占位节点。
 */
export function ensureResource() {
  const ocrDir = path.join(RESOURCE_DIR, 'model', 'ocr');
  const files = [
    ['det', 'inference.onnx', 'det.onnx'],
    ['rec', 'inference.onnx', 'rec.onnx'],
    ['rec', 'keys.txt', 'keys.txt']
  ];
  fs.mkdirSync(ocrDir, { recursive: true });
  const pipelineDir = path.join(RESOURCE_DIR, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const placeholder = path.join(pipelineDir, 'ark-garrison.json');
  if (!fs.existsSync(placeholder)) {
    fs.writeFileSync(placeholder, JSON.stringify({ ArkGarrisonNoop: { recognition: 'DirectHit', action: 'DoNothing' } }, null, 2), 'utf8');
  }
  for (const [sub, from, to] of files) {
    const dst = path.join(ocrDir, to);
    if (fs.existsSync(dst)) continue;
    const src = path.join(MAA_OCR_DIR, sub, from);
    if (!fs.existsSync(src)) {
      throw new Error(`缺 OCR 模型 ${src}：先把 MAA 源码克隆到 mode/MaaAssistantArknights`);
    }
    fs.copyFileSync(src, dst);
  }
  return RESOURCE_DIR;
}

/**
 * 连上模拟器，返回 { maa, ctrl, res, tasker, device, timings }。
 * serial 留空 = 用 adb 找到的第一台设备。
 */
export async function connect({ adbPath = '', serial = '' } = {}) {
  const maa = loadMaa();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  // MaaFramework 的调试日志写到 data/ark-garrison/debug，别往插件目录里拉屎
  maa.Global.log_dir = path.join(WORK_DIR, 'debug');
  try { maa.Global.stdout_level = 'Off'; } catch { /* 旧版本没有这个开关 */ }

  const timings = {};
  let t = now();
  // 先不带 adb 路径找：这样 MaaFramework 会识别正在运行的模拟器（雷电 / MuMu），
  // 给设备配好 extras（模拟器自带的截图通道，比 adb 截图快一个数量级）。
  // 指定 adb 路径时它只走普通 adb，所以只在自动识别找不到时才用。
  let devices = (await maa.AdbController.find()) || [];
  if (adbPath && !devices.some((d) => !serial || d[2] === serial)) {
    devices = (await maa.AdbController.find(adbPath)) || [];
  }
  timings.findMs = now() - t;
  const device = serial ? devices.find((d) => d[2] === serial) : devices[0];
  if (!device) {
    const seen = devices.map((d) => `${d[0]}(${d[2]})`).join('、') || '无';
    throw new Error(`找不到模拟器${serial ? ` ${serial}` : ''}；adb 能看到的设备：${seen}`);
  }
  const [, adb, address, screencapMethods, inputMethods, config] = device;

  t = now();
  const res = new maa.Resource();
  const loaded = await res.post_bundle(ensureResource()).wait().succeeded;
  timings.resourceMs = now() - t;
  if (!loaded) throw new Error('MaaFramework 资源加载失败（看 data/ark-garrison/debug 里的日志）');

  t = now();
  const ctrl = new maa.AdbController(adb, address, screencapMethods, inputMethods, config);
  const connected = await ctrl.post_connection().wait().succeeded;
  timings.connectMs = now() - t;
  if (!connected) throw new Error(`连接 ${address} 失败`);

  const tasker = new maa.Tasker();
  tasker.controller = ctrl;
  tasker.resource = res;
  if (!tasker.inited) throw new Error('Tasker 初始化失败');

  return { maa, ctrl, res, tasker, device: { name: device[0], adb, address }, timings };
}

/** 截一张图，返回 { image(编码后的图片 ArrayBuffer), ms }。 */
export async function screencap(ctrl) {
  const t = now();
  const image = await ctrl.post_screencap().wait().get();
  if (!image) throw new Error('截图失败');
  return { image, ms: now() - t };
}

/**
 * 对整张图（或 roi 区域）做 OCR，返回 { items: [{ text, box, score }], ms }。
 * roi 是 [x, y, w, h]，坐标按 MaaFramework 的 720p 基准（短边 720）。
 */
export async function ocr(tasker, image, roi = null) {
  const t = now();
  const param = roi ? { roi } : {};
  const detail = await tasker.post_recognition('OCR', param, image).wait().get();
  const ms = now() - t;
  const nodeId = detail?.nodes?.[0];
  const reco = nodeId != null ? tasker.node_detail(nodeId)?.reco : null;
  const all = Array.isArray(reco?.detail?.all) ? reco.detail.all : [];
  const items = all
    .filter((x) => x?.text)
    .map((x) => ({ text: x.text, box: x.box, score: x.score ?? null }));
  return { items, ms };
}

/** 点击（坐标同样按 720p 基准）。 */
export async function click(ctrl, x, y) {
  const t = now();
  const ok = await ctrl.post_click(x, y).wait().succeeded;
  return { ok, ms: now() - t };
}

export function close(session) {
  try { session?.tasker?.destroy(); } catch { /* ignore */ }
  try { session?.ctrl?.destroy(); } catch { /* ignore */ }
  try { session?.res?.destroy(); } catch { /* ignore */ }
}
