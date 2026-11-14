// plugins/ark-garrison/eyes.js
//
// 玩游戏时的"眼睛和手"：一条常驻的 MaaFramework 连接（maa.js），加上截图存盘、叠坐标网格。
// 坐标一律按 1280x720（MaaFramework 会把截图缩到短边 720）。
//
// 为什么要叠网格：让 Codex 看图报坐标时有刻度可对，比凭感觉估像素准得多。
// 网格用 ffmpeg 画（项目里别处已经依赖 ffmpeg），不额外装图像库。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { connect, screencap, ocr, click, key, close, dragDeploy, WORK_DIR } from './maa.js';

export const W = 1280;
export const H = 720;
const LIVE_DIR = path.join(WORK_DIR, 'live');
const KEEP = 60;   // live 目录只留最近这么多张

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffmpeg(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: timeoutMs }, (err) => resolve(!err));
  });
}

/** 每 80 像素一条线，上边和左边标刻度。失败返回 null（调用方退回原图）。 */
async function gridOf(src) {
  const out = src.replace(/\.png$/, '.grid.png');
  const font = 'C\\:/Windows/Fonts/arial.ttf';
  const labels = [];
  for (let x = 80; x < W; x += 80) labels.push(`drawtext=fontfile='${font}':text='${x}':x=${x + 2}:y=2:fontsize=14:fontcolor=yellow:box=1:boxcolor=black@0.6`);
  for (let y = 80; y < H; y += 80) labels.push(`drawtext=fontfile='${font}':text='${y}':x=2:y=${y + 2}:fontsize=14:fontcolor=yellow:box=1:boxcolor=black@0.6`);
  const vf = [`scale=${W}:${H}`, 'drawgrid=w=80:h=80:t=1:c=yellow@0.35', ...labels].join(',');
  return (await ffmpeg(['-i', src, '-vf', vf, out])) ? out : null;
}

export function createEyes({ serial = '' } = {}) {
  let session = null;

  async function ensure() {
    if (session) return session;
    session = await connect({ serial, input: 'maatouch' });
    return session;
  }

  /** 连接坏了（模拟器重启等）时丢掉，下次自动重连。 */
  function reset() { close(session); session = null; }

  async function withSession(fn) {
    try {
      return await fn(await ensure());
    } catch (e) {
      reset();
      return fn(await ensure());
    }
  }

  /**
   * 看一眼：截图存盘 + 全屏 OCR。
   * 返回 { file, grid, items: [{ text, x, y, box }] }，x/y 是文字中心点。
   */
  async function look({ withGrid = false } = {}) {
    return withSession(async (s) => {
      const cap = await screencap(s.ctrl);
      const image = cap.image;
      const r = await ocr(s.tasker, cap.image);
      fs.mkdirSync(LIVE_DIR, { recursive: true });
      const file = path.join(LIVE_DIR, `${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(cap.image));
      prune();
      const items = r.items.map((it) => {
        const [bx, by, bw, bh] = it.box;
        return { text: it.text, x: Math.round(bx + bw / 2), y: Math.round(by + bh / 2), box: it.box };
      });
      const grid = withGrid ? await gridOf(file) : null;
      return { file, grid, items, text: items.map((i) => i.text).join(' '), image };
    });
  }

  async function tap(x, y) { return withSession((s) => click(s.ctrl, clampX(x), clampY(y))); }
  async function back() { return withSession((s) => key(s.ctrl, 4)); }

  // ── 拖动：Maatouch + MAA 的部署手法（maa.js dragDeploy）────────────────
  // 2026-11-10 实测（雷电 9）：MaaFramework 默认挑的触控方式拿不起卫戍里的干员；
  // 强制 Maatouch（MAA 自己用的触控）+ 按住停一下、先快后慢、停稳再松手就能放上去，放置 + 选朝向约 2 秒。
  const DIR = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] };
  /**
   * 从 (x1,y1) 拖到 (x2,y2)。dir 给了方向（right/left/up/down）就是部署干员：
   * 放下后游戏弹出朝向菱形，再从落点往那个方向拖一下选朝向。
   */
  async function drag(x1, y1, x2, y2, _ms = 0, dir = '') {
    return withSession(async (s) => {
      await dragDeploy(s.ctrl, clampX(x1), clampY(y1), clampX(x2), clampY(y2));
      const d = DIR[dir];
      if (d) {
        await sleep(600);
        await dragDeploy(s.ctrl, clampX(x2), clampY(y2), clampX(x2 + d[0] * 220), clampY(y2 + d[1] * 220));
      }
      return { ok: true };
    });
  }

  // ── 按住不放（部署用）：按住整备区的干员时，游戏会把能放的格子染绿，镜头也会切到收起商店的视角 ──
  let held = null;   // { x, y }：手指现在按在哪
  /** 按住 (x,y) 往上提一点，停一下，按着截图存盘。返回 { file }，手指不松。 */
  async function pickUp(x, y) {
    return withSession(async (s) => {
      x = clampX(x); y = clampY(y);
      await s.ctrl.post_touch_down(0, x, y, 1).wait();
      await sleep(200);
      for (let i = 1; i <= 6; i++) { await s.ctrl.post_touch_move(0, x, y - i * 10, 1).wait(); await sleep(30); }
      held = { x, y: y - 60 };
      await sleep(450);
      const cap = await screencap(s.ctrl);
      fs.mkdirSync(LIVE_DIR, { recursive: true });
      const file = path.join(LIVE_DIR, `${Date.now()}.hold.png`);
      fs.writeFileSync(file, Buffer.from(cap.image));
      return { file };
    });
  }
  /** 按着的手指先快后慢移到 (x,y)，停稳再松手（MAA 的部署手法）。 */
  async function dropAt(x, y) {
    if (!held) return { ok: false };
    const s = await ensure();
    const { x: x1, y: y1 } = held;
    x = clampX(x); y = clampY(y);
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      const p = 1 - (1 - i / steps) ** 2;
      await s.ctrl.post_touch_move(0, Math.round(x1 + (x - x1) * p), Math.round(y1 + (y - y1) * p), 1).wait();
      await sleep(25);
    }
    await sleep(250);
    await s.ctrl.post_touch_up(0).wait();
    held = null;
    return { ok: true };
  }
  /** 不放了：移回起点松手（干员回到整备区）。 */
  async function cancelHold(x, y) {
    if (!held) return;
    const s = await ensure();
    await s.ctrl.post_touch_move(0, clampX(x), clampY(y), 1).wait();
    await sleep(150);
    await s.ctrl.post_touch_up(0).wait();
    held = null;
  }
  /** 放下后选朝向：从落点往 dir 方向拖一下。 */
  async function face(x, y, dir) {
    const d = DIR[dir];
    if (!d) return;
    await sleep(500);
    return withSession((s) => dragDeploy(s.ctrl, clampX(x), clampY(y), clampX(x + d[0] * 220), clampY(y + d[1] * 220)));
  }
  /** 只截一张图存盘（不 OCR），给识别绿格之类用。 */
  async function shot() {
    return withSession(async (s) => {
      const cap = await screencap(s.ctrl);
      fs.mkdirSync(LIVE_DIR, { recursive: true });
      const file = path.join(LIVE_DIR, `${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(cap.image));
      return { file, image: cap.image };
    });
  }
  /** 按区域读：nums 是小数字（only_rec），texts 是普通文字。传入 look 时复用它那张图。 */
  async function readRegions(image, regions, { onlyRec = false } = {}) {
    return withSession(async (s) => {
      const out = {};
      for (const [k, roi] of Object.entries(regions)) {
        if (Array.isArray(roi[0])) {
          out[k] = [];
          for (const r of roi) out[k].push((await ocr(s.tasker, image, r, { onlyRec })).items.map((i) => i.text).join(''));
        } else out[k] = (await ocr(s.tasker, image, roi, { onlyRec })).items.map((i) => i.text).join('');
      }
      return out;
    });
  }

  /** 给已经存好的截图叠网格，失败返回 null。 */
  const gridFor = (file) => gridOf(file);

  return { look, gridFor, tap, drag, back, reset, close: reset, sleep, pickUp, dropAt, cancelHold, face, shot, readRegions };
}

const clampX = (x) => Math.max(1, Math.min(W - 2, Math.round(Number(x) || 0)));
const clampY = (y) => Math.max(1, Math.min(H - 2, Math.round(Number(y) || 0)));

function prune() {
  try {
    // 同一个时间戳开头的都算一组：截图、.grid（网格）、.hold（按住时）、.hold.tiles（格子编号图）；只留最近 KEEP 组
    const all = fs.readdirSync(LIVE_DIR).filter((f) => /^\d+(\.[a-z]+)*\.png$/.test(f));
    const stamps = [...new Set(all.map((f) => f.split('.')[0]))].sort();
    const drop = new Set(stamps.slice(0, Math.max(0, stamps.length - KEEP)));
    for (const f of all) if (drop.has(f.split('.')[0])) fs.rmSync(path.join(LIVE_DIR, f), { force: true });
  } catch { /* ignore */ }
}
