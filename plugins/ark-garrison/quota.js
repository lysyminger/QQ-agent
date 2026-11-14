// plugins/ark-garrison/quota.js
//
// Codex 额度用完时的换号等待。
//
// 换号本身交给 Cockpit Tools：它的「Codex 自动切号」每次刷新额度（默认 10 分钟）发现当前号低于阈值，
// 就把 ~/.codex/auth.json 换成另一个号。这里每一步都新起一个 `codex exec`，所以 auth.json 一换，下一步就用新号。
// 我们不碰 Cockpit 加密存的 token（自己刷新 token 会让 Cockpit 那份失效），只读两样不敏感的东西：
//   · ~/.codex/auth.json 里 id_token 的账号标识（用来判断换没换号）；
//   · Cockpit 的 codex_accounts.json（几个号、哪个是第几号、什么套餐）和 config.json（自动切号开没开）。
//
// 碰到「额度用完」：记下这个号什么时候恢复，说一声，然后等——换到一个没用完的号、或者这个号恢复了，就接着打；
// 等太久就放弃。只说「1 号 / 2 号」，不把邮箱发到群里。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_HOME = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const COCKPIT_DIRS = () => [path.join(os.homedir(), '.antigravity_cockpit'), path.join(os.homedir(), '.cockpit_tools')];

// 「usage limit」是 ChatGPT 订阅额度用完；429 / rate limit / quota 也按额度处理（短暂限流等一会儿再试也对）
const QUOTA_RE = /usage.?limit|hit your (usage )?limit|rate.?limit|too many requests|\b429\b|quota|insufficient_quota|额度/i;
export const isQuotaError = (msg) => QUOTA_RE.test(String(msg || ''));

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** 当前 ~/.codex/auth.json 是哪个号：{ key, email, plan }；读不到返回 null。 */
export function readCurrentAccount(file = path.join(CODEX_HOME(), 'auth.json')) {
  const a = readJson(file);
  const idToken = a?.tokens?.id_token;
  if (!idToken) return a?.OPENAI_API_KEY ? { key: 'api-key', email: '', plan: 'api' } : null;
  try {
    const p = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    const auth = p['https://api.openai.com/auth'] || {};
    const email = String(p.email || '').toLowerCase();
    return { key: `${auth.chatgpt_user_id || p.sub || email}:${auth.chatgpt_account_id || a.tokens.account_id || ''}`, email, plan: auth.chatgpt_plan_type || '' };
  } catch {
    return { key: `account:${a.tokens.account_id || ''}`, email: '', plan: '' };
  }
}

/** Cockpit 里的 Codex 号（按它列表里的顺序）和自动切号设置；没装 Cockpit 返回 null。 */
export function readCockpit(dirs = COCKPIT_DIRS()) {
  for (const dir of dirs) {
    const idx = readJson(path.join(dir, 'codex_accounts.json'));
    if (!idx?.accounts) continue;
    const cfg = readJson(path.join(dir, 'config.json')) || {};
    return {
      accounts: idx.accounts.map((x, i) => ({ no: i + 1, id: x.id, email: String(x.email || '').toLowerCase(), plan: x.plan_type || '' })),
      currentId: idx.current_account_id || '',
      autoSwitch: Boolean(cfg.codex_auto_switch_enabled),
      refreshMinutes: Number(cfg.codex_auto_refresh_minutes) || 10
    };
  }
  return null;
}

/** 「2 号（plus）」这样的叫法；Cockpit 里找不到就只说套餐。 */
export function accountLabel(acc, cockpit) {
  if (!acc) return '当前的号';
  const hit = cockpit?.accounts.find((x) => x.email && x.email === acc.email);
  const plan = acc.plan || hit?.plan;
  return `${hit ? `${hit.no} 号` : '当前的号'}${plan ? `（${plan}）` : ''}`;
}

/**
 * 从报错里找「什么时候恢复」。认两种写法：
 *   try again in 2 hours 5 minutes / in 3 days 1 hour
 *   try again at 3:05 PM / at Nov 10th, 2026 3:05 PM
 * 认不出返回 null。
 */
export function parseRetryAt(msg, now = Date.now()) {
  const s = String(msg || '');
  const rel = s.match(/try again in ([^.]*)/i);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*(day|hour|hr|minute|min|second|sec)/gi)) {
      const k = unit.toLowerCase();
      ms += Number(n) * (k.startsWith('d') ? 86400000 : k.startsWith('h') ? 3600000 : k.startsWith('m') ? 60000 : 1000);
    }
    if (ms > 0) return now + ms;
  }
  const abs = s.match(/try again at ([^\n]*?\d{1,2}:\d{2}(?:\s*[AP]M)?)/i);
  if (abs) {
    const text = abs[1].replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, '').trim();
    const full = Date.parse(text);
    if (Number.isFinite(full) && /\d{4}/.test(text)) return full;
    const t = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (t) {
      let h = Number(t[1]) % 12;
      if (t[3]?.toUpperCase() === 'PM') h += 12;
      else if (!t[3]) h = Number(t[1]);
      const d = new Date(now);
      d.setHours(h, Number(t[2]), 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
  }
  return null;
}

const fmtTime = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const sameDay = new Date().toDateString() === d.toDateString();
  return `${sameDay ? '' : `${d.getMonth() + 1}月${d.getDate()}日 `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// 进程内记着：哪个号用完了、什么时候恢复（until=null 表示不知道）、第一次碰到是什么时候
const G = globalThis.__arkQuota || (globalThis.__arkQuota = { exhausted: new Map() });

/** 测试用：清掉记录。 */
export function resetQuotaState() { G.exhausted.clear(); }

const usable = (key, now) => {
  const e = G.exhausted.get(key);
  if (!e) return true;
  if (e.until && now >= e.until) { G.exhausted.delete(key); return true; }
  return false;
};

/**
 * Codex 报了额度错误后调用：记下当前号用完了，等换号或恢复。
 * 返回 { ok:true, how:'switched'|'recovered'|'retry' } 表示可以接着问 Codex；
 *      { ok:false, status:'stopped'|'quota', reason } 表示别等了。
 *
 * maxMinutes：从第一次碰到这个号用完算起最多等多久（QQ 里开的局默认 20 分钟，够 Cockpit 刷新一轮；后台训练可以给几个小时）。
 * probeMinutes：报错里看不出什么时候恢复时（可能只是一时限流），每隔这么久放它再试一次；还不行会再进来接着等，不重复说。
 */
export async function waitForQuota({
  error, signal, report = async () => {}, log = () => {},
  maxMinutes = 20, probeMinutes = 5, pollMs = 20000,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  readAccount = readCurrentAccount, readCockpitState = readCockpit
} = {}) {
  const start = now();
  const before = readAccount();
  const cockpit = readCockpitState();
  const key = before?.key || 'unknown';
  const prev = G.exhausted.get(key);
  const retryAt = parseRetryAt(error, start) || prev?.until || null;
  const since = prev?.since || start;
  G.exhausted.set(key, { until: retryAt, since });
  const label = accountLabel(before, cockpit);

  // 已知用完的号里最早什么时候恢复
  const earliest = () => [...G.exhausted.values()].map((e) => e.until).filter(Boolean).sort((a, b) => a - b)[0] || null;
  const total = cockpit?.accounts.length || 0;
  const allOut = total > 0 && G.exhausted.size >= total;

  let msg = `${label}的 Codex 额度用完了${retryAt ? `（${fmtTime(retryAt)} 恢复）` : ''}，`;
  if (!cockpit) msg += '没找到 Cockpit，换号得手动来；我先等着。';
  else if (allOut) msg += `${total} 个号都用完了${earliest() ? `，最早 ${fmtTime(earliest())} 恢复` : ''}，先歇会儿。`;
  else if (cockpit.autoSwitch) msg += `等 Cockpit 自动换号（它 ${cockpit.refreshMinutes} 分钟查一次额度），换好接着打。`;
  else msg += 'Cockpit 没开 Codex 自动切号，要在 Cockpit 里手动换一个号，换好我接着打。';
  log(`额度：${msg}（${String(error || '').slice(0, 200)}）`);
  if (!prev) await report(msg);

  const deadline = since + maxMinutes * 60000;
  const until = retryAt ? deadline : Math.min(deadline, start + probeMinutes * 60000);

  while (now() < until) {
    if (signal?.aborted) return { ok: false, status: 'stopped', reason: '主人叫停了' };
    await sleep(Math.min(pollMs, Math.max(1000, until - now())));
    if (signal?.aborted) return { ok: false, status: 'stopped', reason: '主人叫停了' };
    const cur = readAccount();
    if (cur && cur.key !== key && usable(cur.key, now())) {
      const to = accountLabel(cur, readCockpitState());
      log(`额度：换到${to}了`);
      await report(`换到${to}了，接着打`);
      return { ok: true, how: 'switched' };
    }
    if (usable(key, now())) {
      log(`额度：${label}恢复了`);
      await report(`${label}的额度恢复了，接着打`);
      return { ok: true, how: 'recovered' };
    }
  }
  if (now() < deadline) return { ok: true, how: 'retry' };   // 看不出恢复时间：放它再试一次
  const when = earliest();
  G.exhausted.delete(key);   // 这次不等了；下回再碰到重新计时
  return { ok: false, status: 'quota', reason: `Codex 额度用完了，等了 ${maxMinutes} 分钟也没换上能用的号${when ? `，最早 ${fmtTime(when)} 恢复` : ''}` };
}
