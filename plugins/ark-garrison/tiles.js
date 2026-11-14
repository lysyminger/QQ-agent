// plugins/ark-garrison/tiles.js
//
// 找「能放人的格子」：按住整备区的干员不放时，游戏会把能放的格子染成亮绿色。
// 这里在那张截图上找绿色连通块，每块是一个格子，返回格子中心（1280x720 坐标）。
// 不依赖地图数据（MAA 的格子坐标表只到第二期，「规程」这期的地图没有），换地图也照样能用。
//
// 图片解码用 ffmpeg 转成原始 RGB（项目里别处已经依赖 ffmpeg），不额外装图像库。

import { execFile } from 'node:child_process';

export const W = 1280;
export const H = 720;

/** png 文件 → { w, h, data: Buffer(RGB) }，统一缩到 1280x720。 */
export function decodeRgb(file) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { windowsHide: true, encoding: 'buffer', maxBuffer: W * H * 3 + 1024, timeout: 15000 },
      (err, stdout) => (err ? reject(err) : resolve({ w: W, h: H, data: stdout })));
  });
}

/** 亮绿色高亮（实测格子是 R≈110-175, G≈200-240, B≈40-110）。 */
export const isGreen = (r, g, b) => g > 175 && g - r > 45 && g - b > 90;

/**
 * 在 RGB 图里找绿色格子。
 * 只看棋盘区域（排除左边详情面板、下方木板和右下出售框），连通块面积在 [minArea, maxArea] 之间的才算一个格子；
 * 太大的块（几格连在一起）按包围盒尺寸估算格子数，切开取各自中心。
 * 返回 [{ x, y, area }]，按从上到下、从左到右排。
 */
export function findGreenTiles({ w, h, data }, { roi = [380, 150, 760, 330], minArea = 600, cell = 70 } = {}) {
  const [rx, ry, rw, rh] = roi;
  const mask = new Uint8Array(w * h);
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * w + x) * 3;
      if (isGreen(data[i], data[i + 1], data[i + 2])) mask[y * w + x] = 1;
    }
  }
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const p = y * w + x;
      if (!mask[p] || seen[p]) continue;
      let area = 0; let sx = 0; let sy = 0;
      let x0 = x; let x1 = x; let y0 = y; let y1 = y;
      stack.push(p);
      seen[p] = 1;
      while (stack.length) {
        const q = stack.pop();
        const qx = q % w; const qy = (q - qx) / w;
        area++; sx += qx; sy += qy;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        for (const n of [q - 1, q + 1, q - w, q + w]) {
          const nx = n % w;
          if (n < 0 || n >= w * h || seen[n] || !mask[n] || Math.abs(nx - qx) > 1) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (area < minArea) continue;
      // 几格连成一片：按包围盒大小切成若干格（透视下格子上窄下宽，粗估就够，落点只要在格子里）
      const cols = Math.max(1, Math.round((x1 - x0) / cell));
      const rows = Math.max(1, Math.round((y1 - y0) / (cell * 0.85)));
      if (cols === 1 && rows === 1) { out.push({ x: Math.round(sx / area), y: Math.round(sy / area), area }); continue; }
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cx = Math.round(x0 + (c + 0.5) * (x1 - x0) / cols);
          const cy = Math.round(y0 + (r + 0.5) * (y1 - y0) / rows);
          // 切出来的点要真落在绿色上（L 形的块切出来的角可能是空的）
          if (mask[cy * w + cx]) out.push({ x: cx, y: cy, area: Math.round(area / (cols * rows)) });
        }
      }
    }
  }
  return out.sort((a, b) => (Math.abs(a.y - b.y) > 25 ? a.y - b.y : a.x - b.x));
}

/** 按住干员时木板会变成亮青色（实测 R≈60-150, G≈190-240, B≈170-220）。 */
export const isTeal = (r, g, b) => g > 175 && b > 150 && r < 160 && g - r > 50;

/** 在按住的截图里找亮青色木板（y 540～680），返回离 nearX 最近、青色最密的一点 [x, y]；找不到返回 null。 */
export function findWalkway({ w, data }, nearX, { y0 = 540, y1 = 680 } = {}) {
  let best = null;
  for (let x = 60; x < 1100; x += 8) {
    let n = 0; let sy = 0;
    for (let y = y0; y < y1; y += 4) {
      const i = (y * w + x) * 3;
      if (isTeal(data[i], data[i + 1], data[i + 2])) { n++; sy += y; }
    }
    if (n < 12) continue;
    const d = Math.abs(x - nearX);
    if (!best || d < best.d) best = { d, x, y: Math.round(sy / n) };
  }
  return best ? [best.x, best.y] : null;
}

/**
 * 手上按着东西吗：按住木板上的人 / 装备时，右下角商店收起按钮变成金色的「+N 拖拽至此售出」框。
 * 场上站满了按住人不亮空绿格（只剩站着人的格子是绿的），不能拿「有没有绿格」判断拿没拿起来。
 * 实测按住时 (1110～1270, 540～650) 隔 2 像素采样约 330 个金色点，没按住时 0。
 */
export function isHolding({ w, data }) {
  let n = 0;
  for (let y = 540; y < 650; y += 2) {
    for (let x = 1110; x < 1270; x += 2) {
      const i = (y * w + x) * 3;
      if (data[i] > 200 && data[i + 1] > 150 && data[i + 2] < 90) n++;
    }
  }
  return n >= 80;
}

/**
 * 敌人出生点（红色线框方块）和要守的点（浅蓝线框方块）：取各自像素的重心。
 * 实测（规程等级 3 的两张图）：红框 R>200 G<90 B<90，在右边；蓝框 R<160 G>200 B>245 且 B 比 G 高 12 以上（青色木板 B 不够高，不会混进来）。
 * 按住人时左上的详情面板会盖住蓝框，这时 target 可能是 null。像素太少（<100 / <80）当没找到。
 */
export function findMarkers({ w, data }, { y0 = 110, y1 = 500 } = {}) {
  let rx = 0; let ry = 0; let rn = 0; let bx = 0; let by = 0; let bn = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = 250; x < 1280; x += 2) {
      const i = (y * w + x) * 3;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      if (x > 440 && r > 200 && g < 90 && b < 90) { rx += x; ry += y; rn++; }
      if (r < 160 && g > 200 && b > 245 && b - g > 12) { bx += x; by += y; bn++; }
    }
  }
  return {
    spawn: rn >= 100 ? { x: Math.round(rx / rn), y: Math.round(ry / rn) } : null,
    target: bn >= 80 ? { x: Math.round(bx / bn), y: Math.round(by / bn) } : null
  };
}

/** 画面基本是黑的（加载、转场）：隔 8 像素采样，平均亮度 < 22 就算。这种画面问模型只会得到「等一下」。 */
export function isDark({ w, h, data }) {
  let s = 0; let n = 0;
  for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) { const i = (y * w + x) * 3; s += data[i] + data[i + 1] + data[i + 2]; n++; }
  return n > 0 && s / n / 3 < 22;
}
