// 收件箱的状态文件（data/qq-file-intake/state.json）。
//
// 记什么：
//   qq.<chatKey|mid>  这条消息里的文件处理到哪一步了（下载中/已落盘/太大/失败）
//   wx.<sha1>         微信这个文件搬过了没
//   wxArmedAt         插件第一次跑的时刻 —— **只处理它之后的新文件**，
//                     否则装插件当天会把主人 6~9 月收到的几百个文件一次性搬走
//   hinted.<key>      这一轮有没有把"刚收到文件"提示给过模型（提示只贴一次）
//
// 写盘纪律：**原子替换**（先写 .tmp 再 rename）。直接 writeFileSync 覆盖时如果
// 进程正好退出，留下的半截 JSON 会让下次启动 JSON.parse 抛错 → 状态全丢 →
// 同一个文件被重复下载/重复搬移。

import fs from 'node:fs';
import path from 'node:path';

export function createState(file) {
  let data = empty();
  let dirty = false;
  let timer = null;

  function empty() {
    return { version: 1, qq: {}, wx: {}, hinted: {}, wxArmedAt: 0, lastWxScanAt: 0, updatedAt: 0 };
  }

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const j = JSON.parse(raw);
      data = { ...empty(), ...(j && typeof j === 'object' ? j : {}) };
      data.qq = data.qq && typeof data.qq === 'object' ? data.qq : {};
      data.wx = data.wx && typeof data.wx === 'object' ? data.wx : {};
      data.hinted = data.hinted && typeof data.hinted === 'object' ? data.hinted : {};
    } catch {
      // 文件不存在或坏了：从头来。坏文件不删（留证据），改名让下一次能重建。
      try { if (fs.existsSync(file)) fs.renameSync(file, `${file}.bad-${Date.now()}`); } catch { /* ignore */ }
      data = empty();
    }
    ensureDirs();
    return data;
  }

  function ensureDirs() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  }

  function save() {
    try {
      ensureDirs();
      data.updatedAt = Date.now();
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
      fs.renameSync(tmp, file);
      dirty = false;
    } catch { /* 状态写不进去不该影响主流程 */ }
  }

  /** 攒一下再写（一轮里可能连着改好几处）。 */
  function touch(delayMs = 800) {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) save();
    }, Math.max(0, delayMs));
    timer.unref?.();
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (dirty) save();
  }

  function pruneOlderThan(days, now = Date.now()) {
    if (!(days > 0)) return 0;
    const cut = now - days * 86400000;
    let n = 0;
    for (const [k, v] of Object.entries(data.qq)) {
      if ((Number(v?.at) || 0) < cut) { delete data.qq[k]; n += 1; }
    }
    for (const [k, v] of Object.entries(data.wx)) {
      if ((Number(v?.at) || 0) < cut) { delete data.wx[k]; n += 1; }
    }
    for (const [k, v] of Object.entries(data.hinted)) {
      if ((Number(v) || 0) < cut) { delete data.hinted[k]; n += 1; }
    }
    if (n) touch(0);
    return n;
  }

  /** 只读快照（测试与能力查询用）。 */
  function snapshot() {
    return {
      qqCount: Object.keys(data.qq).length,
      wxCount: Object.keys(data.wx).length,
      wxArmedAt: Number(data.wxArmedAt) || 0,
      lastWxScanAt: Number(data.lastWxScanAt) || 0,
      updatedAt: Number(data.updatedAt) || 0
    };
  }

  load();

  return {
    data,
    file,
    load,
    save,
    touch,
    flush,
    pruneOlderThan,
    snapshot,
    get qq() { return data.qq; },
    get wx() { return data.wx; },
    get hinted() { return data.hinted; }
  };
}
