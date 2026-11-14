// plugins/ark-garrison/emulator.js
//
// 雷电模拟器 9 的开关：用它自带的 ldconsole.exe（不用自己拼 adb 命令启动虚拟机）。
//   ldconsole list2                         列实例：序号,标题,顶层窗口,绑定窗口,安卓已启动,进程,虚拟机进程,宽,高,dpi
//   ldconsole launch --index N              开实例
//   ldconsole runapp --index N --packagename 包名
//   ldconsole adb --index N --command "..."  对这个实例跑 adb
// ldconsole 的输出是 GBK（实例标题是中文），这里只解析数字字段，标题不用。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const ARK_PACKAGE = 'com.hypergryph.arknights';
const DEFAULT_DIRS = ['D:\\software\\leidian\\LDPlayer9', 'C:\\leidian\\LDPlayer9', 'D:\\leidian\\LDPlayer9', 'C:\\Program Files\\leidian\\LDPlayer9'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找 ldconsole.exe：设置里填的目录优先，其次注册表里雷电 9 的安装位置，最后几个常见目录。 */
export async function findLdDir(configured = '') {
  const ok = (d) => d && fs.existsSync(path.join(d, 'ldconsole.exe'));
  if (ok(configured)) return configured;
  const reg = await run('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'dnplayer.exe', '/d'], 8000).catch(() => '');
  const m = String(reg).match(/DisplayIcon\s+REG_SZ\s+(.+?)\\dnplayer\.exe/i);
  if (m && ok(m[1].trim())) return m[1].trim();
  return DEFAULT_DIRS.find(ok) || '';
}

function run(file, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'latin1', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

export function createEmulator({ ldDir, index = 0 }) {
  const con = (args, ms) => run(path.join(ldDir, 'ldconsole.exe'), args, ms);
  const adb = (command, ms = 15000) => con(['adb', '--index', String(index), '--command', command], ms);

  /** 这个实例的状态：{ exists, running(安卓已启动), pid, width, height }。 */
  async function status() {
    const out = await con(['list2']);
    for (const line of out.split(/\r?\n/)) {
      const f = line.split(',');
      if (f.length < 10 || Number(f[0]) !== index) continue;
      return { exists: true, running: f[4] === '1', pid: Number(f[5]) || 0, width: Number(f[7]), height: Number(f[8]) };
    }
    return { exists: false, running: false };
  }

  /** 安卓系统是否真的开机完成（list2 的「已启动」比这个早几秒）。 */
  async function booted() {
    return /^\s*1\s*$/m.test(await adb('shell getprop sys.boot_completed').catch(() => ''));
  }

  /** 当前前台的应用包名（取不到返回空串）。 */
  async function foreground() {
    const out = await adb('shell dumpsys window').catch(() => '');
    const m = out.match(/mCurrentFocus=Window\{[^}]*?\s([\w.]+)\/[\w.$]+\}/);
    return m ? m[1] : '';
  }

  /** 开模拟器并等安卓开机完成，最多等 timeoutMs。返回用了多少秒。 */
  async function ensureRunning(timeoutMs = 150000, onWait = null) {
    const t0 = Date.now();
    const st = await status();
    if (!st.exists) throw new Error(`雷电里没有序号 ${index} 的模拟器实例`);
    if (!st.running) await con(['launch', '--index', String(index)]);
    let told = false;
    while (Date.now() - t0 < timeoutMs) {
      if ((await status()).running && await booted()) return Math.round((Date.now() - t0) / 1000);
      if (!told && Date.now() - t0 > 15000) { told = true; onWait?.(); }
      await sleep(3000);
    }
    throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒模拟器还没开好`);
  }

  /** 把明日方舟切到前台（没开就启动）。 */
  async function ensureGame() {
    if (await foreground() === ARK_PACKAGE) return false;
    await con(['runapp', '--index', String(index), '--packagename', ARK_PACKAGE]);
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      if (await foreground() === ARK_PACKAGE) return true;
    }
    throw new Error('明日方舟没能切到前台（模拟器里装了官服吗？）');
  }

  return { status, booted, foreground, ensureRunning, ensureGame, adb, index, ldDir };
}
