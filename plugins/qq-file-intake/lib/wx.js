// 微信侧：盯着微信的「接收文件」目录，把新到的文件剪贴搬进收件箱。
//
// ── 微信 4.x 的目录长这样（实测本机）──────────────────────────────────────
//   E:\xwechat_files\<wxid>_<4位>\msg\file\<YYYY-MM>\综测文档说明.docx
//   E:\xwechat_files\<wxid>_<4位>\msg\video\...   （视频，本插件默认不碰）
// 特点：**收到的文件（含群里别人发的）全落在这一个目录**，文件本身是明文的
// （不像图片/语音是 .dat 加密），文件名与发送者无关 —— 所以"是不是主人发的"这件事
// 在微信侧根本判断不出来。这也正是外面只做"搬进收件箱"、**不自动入库**的原因：
// 只有主人亲口说「\入库 xxx」才会进知识库（见 index.js 的说明）。
//
// ── 为什么必须监听 + 定时扫描两条腿 ──────────────────────────────────────
//   · fs.watch(recursive) 是主路径：文件一落盘就能立刻搬走（秒级）。
//   · Windows 的 recursive watch 在目录树很深/网络盘上会漏事件（实测偶发），
//     所以再挂一个几分钟一次的定时扫描兜底 —— 漏了也会在下一轮补上。
//   · 两次判定都要求文件"安静"够久（wxMinAgeSec）：微信是边下边写，
//     抢在下载中途搬走会得到一个半截文件（搬走的还是原件，损失不可逆）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wxCandidateVerdict, parseWxPath, wxExtAllowed } from './logic.js';

/** 常见微信数据根目录候选（用户可在设置里用分号覆盖）。 */
export function defaultWxRoots() {
  const home = os.homedir();
  const list = [
    'E:\\xwechat_files',
    'D:\\xwechat_files',
    'F:\\xwechat_files',
    'C:\\xwechat_files',
    path.join(home, 'Documents', 'xwechat_files'),
    path.join(home, 'xwechat_files'),
    path.join(home, 'Documents', 'WeChat Files'),
    path.join('D:\\Documents', 'xwechat_files')
  ];
  return [...new Set(list)];
}

/** 设置里的 roots 串 → 数组（空 = 用默认候选）。 */
export function wxRootsFromSetting(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return defaultWxRoots();
  return s.split(/[;；\n]+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 从根目录里找出所有「<账号>/msg/file」目录。
 * @returns {Array<{root:string, account:string, dir:string}>}
 */
export function discoverWxFileDirs(roots) {
  const out = [];
  for (const root of roots || []) {
    let children = [];
    try {
      children = fs.readdirSync(root, { withFileTypes: true });
    } catch { continue; }
    for (const c of children) {
      if (!c.isDirectory()) continue;
      const dir = path.join(root, c.name, 'msg', 'file');
      try {
        if (fs.statSync(dir).isDirectory()) out.push({ root, account: c.name, dir });
      } catch { /* 这个账号没有 file 目录 */ }
    }
  }
  return out;
}

/**
 * 扫一个「msg/file」目录里值得搬的文件（含月份子目录）。
 * @returns {Array<{file:string,name:string,size:number,mtimeMs:number,account:string,month:string}>}
 */
export function scanWxFileDir(dir, o = {}) {
  const nested = o.recursive !== false;
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (nested && depth < 2) walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || e.name.startsWith('.')) continue;
      // 微信用 .tmp/.dat 表示正在下载的中间件，一律跳过
      if (/\.(tmp|part|crdownload)$/i.test(e.name)) continue;
      if (!wxExtAllowed(e.name, o.exts)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const meta = parseWxPath(full);
      out.push({
        file: full, name: e.name, size: st.size, mtimeMs: st.mtimeMs,
        account: meta.account, month: meta.month
      });
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * 批次里哪些现在可以搬（纯判定，真机/离线共用）。
 * @returns {Array<{file:string,name:string,size:number,mtimeMs:number,key:string,account:string,month:string}>}
 */
export function pickWxMovable(entries, o = {}) {
  const out = [];
  for (const e of entries || []) {
    const v = wxCandidateVerdict(e, {
      now: o.now, minAgeMs: o.minAgeMs, since: o.since, exts: o.exts, known: o.known, srcPath: e.file
    });
    if (v.ok) out.push({ ...e, key: v.key });
  }
  // 老文件先搬（月份目录里日期更早的），顺序稳定便于回执与排障
  out.sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
  return out;
}

/**
 * 挂 fs.watch（递归监听每个账号的 msg/file 目录）。
 * @param {Array<{dir:string,account:string}>} dirs
 * @param {() => void} onChanged 有变化时回调（调用方自己做防抖/节流）
 * @returns {Array<{dir:string, watcher:any}>} handles（交给 stopWatchers 关掉）
 */
export function startWxWatchers(dirs, onChanged) {
  const handles = [];
  for (const d of dirs || []) {
    try {
      const watcher = fs.watch(d.dir, { recursive: true }, () => {
        try { onChanged?.(); } catch { /* 回调异常不该打断监听 */ }
      });
      watcher.on?.('error', () => { /* 单个 watcher 坏掉不致命，定时扫描兜底 */ });
      handles.push({ dir: d.dir, watcher });
    } catch { /* 目录不可监听（网络盘等）：交给定时扫描 */ }
  }
  return handles;
}

export function stopWxWatchers(handles) {
  for (const h of handles || []) {
    try { h.watcher?.close(); } catch { /* ignore */ }
  }
}
