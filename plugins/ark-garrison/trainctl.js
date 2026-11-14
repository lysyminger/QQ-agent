// plugins/ark-garrison/trainctl.js —— 面板上「卫戍训练」卡片的后台：看训练在不在跑、暂停 / 继续 / 开始。
// 只读写 data/ark-garrison 里的标记文件、起子进程，不加载 maa（插件没启用也能用）。
//
//   PAUSE    有这个文件：训练打完手上这局就停在两局之间等着，删掉就接着打（联机中途停会被判挂机违规，所以不做「立刻停」）
//   train.pid  train.mjs 起来时写自己的 pid，退出时删
//   train.log  训练日志（取最后几行给面板看）

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { DATA_DIR } from '../../src/config.js';

export const WORK = path.join(DATA_DIR, 'ark-garrison');
export const PAUSE = path.join(WORK, 'PAUSE');
export const PID = path.join(WORK, 'train.pid');
const LOG = path.join(WORK, 'train.log');
const STATS = path.join(WORK, 'stats.jsonl');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function trainerPid() {
  try { const pid = Number(fs.readFileSync(PID, 'utf8')); return pid && alive(pid) ? pid : null; } catch { return null; }
}

function tail(file, n) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 64 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').filter((l) => l.trim()).slice(-n);
  } catch { return []; }
}

function record() {
  let win = 0; let lose = 0; let last = null;
  try {
    for (const l of fs.readFileSync(STATS, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const j = JSON.parse(l);
      if (j.result === 'win') win++; else if (j.result === 'lose') lose++;
      last = j;
    }
  } catch { /* 还没有战绩 */ }
  return { win, lose, last: last ? { mode: last.mode || '', result: last.result || '', rounds: last.rounds ?? null } : null };
}

export function status() {
  const pid = trainerPid();
  const lines = tail(LOG, 40);
  const paused = fs.existsSync(PAUSE);
  const waiting = paused && lines.some((l) => /暂停中/.test(l)) && !lines.slice(lines.findLastIndex((l) => /暂停中/.test(l)) + 1).some((l) => /局开始/.test(l));
  const game = [...lines].reverse().find((l) => /局开始/.test(l)) || '';
  const round = [...lines].reverse().find((l) => /回合 \d+ 第/.test(l))?.match(/回合 (\d+)/)?.[1] || null;
  return {
    ok: true,
    running: Boolean(pid),
    pid,
    paused,
    // paused 但还没停下：在打手上这局，打完才停
    state: !pid ? 'stopped' : paused ? (waiting ? 'paused' : 'pausing') : 'running',
    game: game.replace(/^\S+ \S+ /, ''),
    round: round ? Number(round) : null,
    record: record(),
    log: lines.slice(-12)
  };
}

// 找系统的 node（面板跑在 Electron 里，process.execPath 是 electron.exe；maa-node 的原生模块要用真 node 跑）
function nodeBin() {
  if (!process.versions.electron) return process.execPath;
  try { return execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim() || 'node'; } catch { return 'node'; }
}

export function start({ mode = 'indie', games = 100, level = 0 } = {}) {
  if (trainerPid()) return { ok: true, already: true, status: status() };
  try { fs.rmSync(PAUSE, { force: true }); } catch { /* ignore */ }
  const root = path.resolve(HERE, '..', '..');
  const args = [path.join(HERE, 'train.mjs'), '--games', String(games), ...(mode === 'coop' ? ['--mode', 'coop'] : []), ...(level ? ['--level', String(level)] : [])];
  const child = spawn(nodeBin(), args, { cwd: root, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  child.unref();
  return { ok: true, started: child.pid, status: status() };
}

export function control({ action, mode } = {}) {
  fs.mkdirSync(WORK, { recursive: true });
  if (action === 'pause') { fs.writeFileSync(PAUSE, new Date().toISOString()); return { ok: true, status: status() }; }
  if (action === 'resume') {
    try { fs.rmSync(PAUSE, { force: true }); } catch { /* ignore */ }
    return trainerPid() ? { ok: true, status: status() } : start({ mode });
  }
  if (action === 'start') return start({ mode });
  return { ok: false, error: `不认识的操作：${action}` };
}
