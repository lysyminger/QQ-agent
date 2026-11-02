// 工具工坊 + 自查：让大脑自己补能力、自己核对自己。
//
// ── tool_request（写工具）──────────────────────────────────────────────────
//   大脑发现缺能力时提需求 → 另起一次 Codex（只读沙箱，代码按 JSON 交回来，不让它直接写盘）→
//   这里做静态检查 → 在独立子进程里跑 self-tools/validate.mjs（导入 + 定义校验 + test()）→
//   通过就写进 plugins/self-tools/tools/<id>.js，热重载自动上线；不通过把报错喂回去改，最多改 2 次。
//   主人 2026-11-02 选了"自测通过就自动上线"，不经人工审批；上线后私聊告诉主人一声，Codex 面板能看能删。
//   静态检查挡掉 README 里明令禁止的写法（子进程、eval、读配置 / 密钥、裸 fetch、往 tools/ 和
//   data/self-tools/ 以外写文件），这是自动上线前唯一的一道门。
//
// ── double_check（自查）───────────────────────────────────────────────────
//   回答具体事实（游戏机制、数值、版本、人名作品）前，把问题和草稿交给另一次 Codex（只读 + 联网）
//   独立核对，返回对 / 错 / 拿不准 + 改正后的说法。被群友说"你说错了"时也先用它核对再认错或解释。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_DIR } from '../../src/config.js';
import { listTools } from '../../src/tool-registry.js';

const APP_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SELF_TOOLS_DIR = path.join(APP_ROOT, 'plugins', 'self-tools');
const TOOLS_DIR = path.join(SELF_TOOLS_DIR, 'tools');
const WORK_DIR = path.join(DATA_DIR, 'codex-bridge', 'workshop');
const LOG_FILE = path.join(WORK_DIR, 'log.json');

const ID_RE = /^[a-z][a-z0-9_]{2,37}$/;
const MAX_ATTEMPTS = 3;

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    summary: { type: 'string' },
    code: { type: 'string' }
  },
  required: ['id', 'name', 'summary', 'code'],
  additionalProperties: false
};

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'wrong', 'unsure'] },
    problems: { type: 'array', items: { type: 'string' } },
    corrected: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } }
  },
  required: ['verdict', 'problems', 'corrected', 'sources'],
  additionalProperties: false
};

// 被纠正的说法：引用 / @ 机器人时出现这些词才算
const CORRECTION_RE = /说错了|你错了|不对吧|不是这样|搞错了|认错了|记错了|找错了|答非所问|瞎说|胡说|不是这个/;

/**
 * 自动上线前的静态检查。返回空串 = 通过，否则是原因。
 * 只挡 README 明令禁止的写法，宁可误挡（工坊会把原因喂回去让它改写法）。
 */
export function staticCheck(code) {
  const c = String(code || '');
  const rules = [
    [/child_process|\bspawn\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bfork\s*\(/, '不许起子进程'],
    [/\beval\s*\(|new\s+Function\s*\(|\bnode:vm\b|from\s+['"]vm['"]/, '不许 eval / new Function / vm'],
    [/process\.binding|process\.dlopen|worker_threads/, '不许 process.binding / dlopen / worker_threads'],
    [/config\.json|apiKey|api_key|accessToken|access_token|dshProviderKeys|hardApiKey|\.codex[\\/]auth/i, '不许碰配置文件和密钥'],
    [/process\.env/, '不许读环境变量（里面可能有密钥）'],
    [/(^|[^.\w])fetch\s*\(/m, '联网要用 src/safe-fetch.js 的 safeFetch / safeFetchBinary，不能用裸 fetch'],
    [/\bimport\s*\(\s*[^'"`\s]/, '不许用变量拼动态 import'],
    [/(^|[^\w.])require\s*\(/m, '这是 ES Module，不要用 require']
  ];
  for (const [re, why] of rules) if (re.test(c)) return why;
  // 写文件只许写 data/self-tools/ 下面
  if (/\b(writeFile|appendFile|rm|rmSync|unlink|rename|mkdir|copyFile|cp|createWriteStream|truncate)(Sync)?\s*\(/.test(c)
    && !/self-tools/.test(c)) {
    return '要写文件只能写到 data/self-tools/<工具 id>/ 下面（代码里要能看出这个路径）';
  }
  return '';
}

function readLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) || []; } catch { return []; }
}

function writeLog(list) {
  try { fs.mkdirSync(WORK_DIR, { recursive: true }); fs.writeFileSync(LOG_FILE, JSON.stringify(list.slice(-100), null, 1), 'utf8'); } catch { /* ignore */ }
}

function readme() {
  try { return fs.readFileSync(path.join(SELF_TOOLS_DIR, 'README.md'), 'utf8'); } catch { return ''; }
}

/** 在独立子进程里跑 validate.mjs。'../../../' 换成仓库根目录的 file URL，让放在别处的检查副本也能找到 src/。 */
function validate(nodeBin, id, code) {
  const dir = path.join(WORK_DIR, 'check');
  fs.mkdirSync(dir, { recursive: true });
  const rootUrl = `${pathToFileURL(APP_ROOT).href}/`;
  const file = path.join(dir, `${id}.js`);
  fs.writeFileSync(file, String(code).split('../../../').join(rootUrl), 'utf8');
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(nodeBin, [path.join(SELF_TOOLS_DIR, 'validate.mjs'), file], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 90000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `跑不起自测：${e.message}` }); });
    child.on('close', (code2) => {
      clearTimeout(timer);
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      if (code2 === 0) resolve({ ok: true, out });
      else resolve({ ok: false, error: (err || out || `自测退出码 ${code2}`).slice(0, 1500) });
    });
  });
}

/**
 * deps: { runOnce(opts), locate() → { nodeBin, error }, settings(), ownerIds(), notifyOwner(text), log(msg) }
 */
export function createWorkshop(deps) {
  const state = { job: null, hints: new Map(), corrections: new Map() };
  const toolsDir = deps.toolsDir || TOOLS_DIR;   // 测试时换成临时目录

  const existingIds = () => new Set(listTools().map((t) => String(t.id).replace(/^self-tools__/, '')));

  async function build(job) {
    const nodeBin = deps.locate().nodeBin;
    if (!nodeBin) throw new Error('找不到 node.exe，没法跑自测');
    let lastCode = '';
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      job.attempts = attempt;
      job.stage = `第 ${attempt} 次编写`;
      const prompt = [
        '你在给 QQ 机器人 qq-agent 写一个新工具（一个 ES Module 文件）。下面是工具文件的约定，必须照做：',
        readme(),
        `【需求】${job.need}`,
        job.example ? `【用法举例】${job.example}` : '',
        `【工具 id】${job.id}（文件会放在 plugins/self-tools/tools/${job.id}.js）`,
        `【已有工具，不要重复】${[...existingIds()].slice(0, 200).join('、')}`,
        '额外规矩（不满足会被自动拒绝）：不许起子进程、不许 eval / new Function、不许读环境变量和任何配置 / 密钥文件；'
          + '联网只用 safeFetch / safeFetchBinary（从 ../../../src/safe-fetch.js 导入）；要存数据只写 data/self-tools/<id>/；'
          + '必须导出 test()，用真实但轻量的调用验证主路径能跑通（60 秒内，失败要 throw）。',
        lastCode ? `【上一版代码】\n${lastCode}\n\n【上一版没通过的原因】\n${lastError}\n\n改好再交。` : '',
        '可以联网查资料（接口文档、免 Key 的公开接口）。用 JSON 交回：id、name（中文名）、summary（一句话说它能做什么）、code（完整文件内容）。'
      ].filter(Boolean).join('\n\n');
      const r = await deps.runOnce({ prompt, schema: TOOL_SCHEMA, effort: 'high', search: true, timeoutMinutes: 12 });
      if (!r.ok) throw new Error(`Codex 没写出来：${r.error}`);
      const j = r.json || {};
      const code = String(j.code || '');
      job.name = String(j.name || job.name || job.id).slice(0, 30);
      job.summary = String(j.summary || '').slice(0, 200);
      lastCode = code;
      if (String(j.id || '') !== job.id) { lastError = `id 必须是 ${job.id}，你交的是 ${j.id}`; continue; }
      const bad = staticCheck(code);
      if (bad) { lastError = `静态检查没过：${bad}`; job.stage = lastError; continue; }
      job.stage = `第 ${attempt} 次自测`;
      const v = await validate(nodeBin, job.id, code);
      if (!v.ok) { lastError = v.error; job.stage = `自测没过：${v.error.slice(0, 80)}`; continue; }
      fs.mkdirSync(toolsDir, { recursive: true });
      fs.writeFileSync(path.join(toolsDir, `${job.id}.js`), code, 'utf8');
      return;
    }
    throw new Error(`改了 ${MAX_ATTEMPTS} 次还是没通过：${lastError.slice(0, 300)}`);
  }

  async function run(job) {
    const log = readLog();
    try {
      await build(job);
      job.status = 'online';
      job.stage = '已上线';
      deps.log(`工具工坊：${job.id}（${job.name}）自测通过，已上线`);
      state.hints.set(job.chatKey, `【新工具】你之前要的「${job.name}」（${job.id}）已经写好上线了：${job.summary}。下一轮起就能用，可以回头告诉要它的人。`);
      deps.notifyOwner?.(`喵喵自己写了个新工具，已经自动上线：\n「${job.name}」${job.id}\n${job.summary}\n需求：${job.need}\n（${job.byName || job.by} 在 ${job.chatKey} 提的）\n不想要就在控制台 Codex 页删掉，或删 plugins/self-tools/tools/${job.id}.js`);
    } catch (e) {
      job.status = 'failed';
      job.error = String(e?.message ?? e).slice(0, 500);
      job.stage = '失败';
      deps.log(`工具工坊：${job.id} 没写成：${job.error}`);
      state.hints.set(job.chatKey, `【新工具】你之前要的「${job.name || job.id}」没写成（${job.error.slice(0, 120)}）。需要的话换个思路再提，或者用 learn_log(kind=gap) 记下来让主人看。`);
    } finally {
      job.endedAt = Date.now();
      writeLog([...log, { ...job }]);
      state.job = null;
    }
  }

  const REQUEST_TOOL = {
    id: 'tool_request',
    name: '自己写个新工具',
    category: 'utility',
    icon: '🧰',
    description: '现有工具都做不到某件事、但写一小段代码就能做到时（查某个公开接口、算点东西、整理数据、定期抓某个网页……），'
      + '用这个给自己写一个新工具：说清楚要它做什么、输入什么、返回什么。另一个 Codex 会写好代码、自测通过后自动上线，通常要几分钟，'
      + '上线后下一轮就能直接调用。一次只能写一个，每天有上限。先确认真的没有现成工具能做（包括组合几个工具）；'
      + '写好的工具跑在主人电脑上，只能联网查东西和在自己的数据目录里存东西，碰不到别的文件，也不能替人操作电脑（那是 owner_task 的事）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工具 id：小写字母开头，只用小写字母 / 数字 / 下划线，3-38 位，如 bili_hot_list' },
        need: { type: 'string', description: '要它做什么：输入是什么、返回什么、从哪拿数据（有的话写上网址）' },
        example: { type: 'string', description: '可选：一个具体用法，如「输入 杭州 → 返回现在的天气和温度」' }
      },
      required: ['id', 'need']
    },
    async execute(ctx, args = {}) {
      const s = deps.settings();
      if (s.workshopEnabled === false) return { content: '写工具的功能在设置里关掉了。', isError: true };
      const id = String(args.id || '').trim().toLowerCase();
      const need = String(args.need || '').trim();
      if (!ID_RE.test(id)) return { content: 'id 要小写字母开头，只用小写字母 / 数字 / 下划线，3-38 位。', isError: true };
      if (need.length < 8) return { content: 'need 写清楚一点：要它做什么、输入什么、返回什么。', isError: true };
      if (existingIds().has(id) || fs.existsSync(path.join(toolsDir, `${id}.js`))) return { content: `已经有叫 ${id} 的工具了，直接用它，或者换个 id。`, isError: true };
      if (state.job) return { content: `正在写「${state.job.name || state.job.id}」，一次只能写一个，等它写完再提。`, isError: true };
      const today = new Date().toDateString();
      const doneToday = readLog().filter((j) => new Date(j.at).toDateString() === today).length;
      const max = Math.max(1, Number(s.workshopDailyMax) || 6);
      if (doneToday >= max) return { content: `今天已经写了 ${doneToday} 个工具，到上限了，明天再提。`, isError: true };
      const last = Array.isArray(ctx.session?.trigger) ? ctx.session.trigger.filter((e) => e && !e.self).at(-1) : null;
      const job = {
        id, need: need.slice(0, 800), example: String(args.example || '').slice(0, 300), name: id, summary: '',
        chatKey: ctx.chatKey || '', by: String(last?.senderId || ''), byName: String(last?.senderName || ''),
        at: Date.now(), status: 'building', stage: '排队', attempts: 0
      };
      state.job = job;
      run(job).catch(() => { state.job = null; });
      return { content: `开始写了（${id}）。另一个 Codex 在写代码和自测，通常几分钟，上线后会告诉你。现在先照常回话，可以跟对方说"我去给自己做个工具，等我一下"。` };
    }
  };

  const CHECK_TOOL = {
    id: 'double_check',
    name: '自查一下',
    category: 'query',
    icon: '🔎',
    description: '回答里有具体事实（游戏机制 / 数值 / 版本更新、作品和角色设定、人名、时间、价格、规则）又不是十拿九稳时，'
      + '先把问题和你打算说的话交给另一个 Codex 独立联网核对，再决定怎么说。有人说你说错了，也先用它核对。'
      + '要等几十秒：被叫到的正经提问才用，随口闲聊不用。返回：对 / 错 / 拿不准、哪里有问题、改正后的说法、来源。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '对方问的是什么（带上必要的上下文，比如哪个游戏、哪个版本）' },
        draft: { type: 'string', description: '你打算怎么回答（或者被说错的那句话）' }
      },
      required: ['question', 'draft']
    },
    async execute(ctx, args = {}) {
      const question = String(args.question || '').trim().slice(0, 1500);
      const draft = String(args.draft || '').trim().slice(0, 2000);
      if (!question || !draft) return { content: 'question 和 draft 都要填。', isError: true };
      const prompt = [
        '你是事实核对员。下面是 QQ 群里有人问的问题，以及机器人打算给出的回答。请独立核对回答里的每一个具体事实（数值、机制、版本、名字、时间、设定），',
        '必须联网查证，优先看官方说明、官方 wiki / 百科、更新公告、靠谱的社区资料，注意版本和日期（以今天为准）。',
        `【问题】${question}`,
        `【打算的回答】${draft}`,
        '用 JSON 交回：verdict（ok = 都对 / wrong = 有错 / unsure = 查不到可靠来源）、problems（每条一句话说错在哪，没错就空数组）、',
        'corrected（改正后的回答，口语、简短，保持原来的意思和语气；没错就照抄原回答）、sources（用到的网址，最多 3 个）。'
      ].join('\n');
      const started = Date.now();
      const r = await deps.runOnce({ prompt, schema: CHECK_SCHEMA, effort: 'high', search: true, timeoutMinutes: 4 });
      if (!r.ok) return { content: `核对没做成（${r.error}），按你有把握的部分说，拿不准的地方直说不确定。`, isError: true };
      const j = r.json || {};
      const label = { ok: '核对通过', wrong: '有错', unsure: '拿不准（没查到可靠来源）' }[j.verdict] || '拿不准';
      deps.log(`自查（${Math.round((Date.now() - started) / 1000)} 秒）：${label} —— ${question.slice(0, 40)}`);
      return {
        content: [
          `【自查结果】${label}`,
          (j.problems || []).length ? `问题：\n${j.problems.map((p) => `· ${p}`).join('\n')}` : '',
          j.verdict !== 'ok' && j.corrected ? `改正后的说法：${j.corrected}` : '',
          (j.sources || []).length ? `来源：${j.sources.slice(0, 3).join(' ')}` : '',
          j.verdict === 'wrong' ? '按改正后的说法回；如果是被人纠正，认错并说清对的是什么，再 kb_remember 记下更正、learn_log(kind=fix)。'
            : j.verdict === 'unsure' ? '拿不准的部分直说不确定，别说得像定论。' : ''
        ].filter(Boolean).join('\n')
      };
    }
  };

  return {
    tools: [REQUEST_TOOL, CHECK_TOOL],

    /** before-context：这一轮有人说机器人说错了 → 记下来，hint() 时提醒它先核对 */
    noteTrigger(sessionId, triggerEntries, selfId) {
      const hit = (triggerEntries || []).filter((e) => e && !e.self).find((e) => {
        const t = String(e.text || '');
        const toMe = e.atMe || (selfId && t.includes(`(QQ:${selfId})`));
        return toMe && CORRECTION_RE.test(t);
      });
      if (!hit) return;
      state.corrections.set(sessionId, `${hit.senderName || hit.senderId}：${String(hit.text || '').slice(0, 200)}`);
      if (state.corrections.size > 100) state.corrections.delete(state.corrections.keys().next().value);
    },

    /** 每轮给大脑的增量提示：被纠正了 / 要的工具上线了（或没写成） */
    hint(sessionId, chatKey) {
      const out = [];
      const c = state.corrections.get(sessionId);
      if (c) {
        state.corrections.delete(sessionId);
        out.push(`【有人说你说错了】${c}\n先核对再回应：拿不准就用 double_check（把被说错的那句话当 draft），或查知识库 / 联网。确认错了就当场改正、说清对的是什么，kb_remember 记下更正、learn_log(kind=fix)；没错就客气地讲出依据，别硬改口。`);
      }
      const h = state.hints.get(chatKey);
      if (h) { state.hints.delete(chatKey); out.push(h); }
      return out.join('\n');
    },

    status() {
      let files = [];
      try { files = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js')); } catch { /* 还没有 */ }
      const log = readLog();
      return {
        building: state.job ? { ...state.job } : null,
        tools: files.map((f) => {
          const id = f.slice(0, -3);
          const rec = [...log].reverse().find((j) => j.id === id && j.status === 'online');
          let mtime = 0;
          try { mtime = fs.statSync(path.join(toolsDir, f)).mtimeMs; } catch { /* ignore */ }
          return { id, name: rec?.name || id, summary: rec?.summary || '', need: rec?.need || '', by: rec?.byName || rec?.by || '', chatKey: rec?.chatKey || '', at: rec?.endedAt || mtime };
        }).sort((a, b) => b.at - a.at),
        recent: log.slice(-10).reverse()
      };
    },

    remove(id) {
      if (!ID_RE.test(String(id || ''))) return { ok: false, error: 'id 不对' };
      const file = path.join(toolsDir, `${id}.js`);
      if (!fs.existsSync(file)) return { ok: false, error: `没有 ${id} 这个工具` };
      fs.rmSync(file, { force: true });
      deps.log(`工具工坊：${id} 已删除（热重载后下线）`);
      return { ok: true };
    }
  };
}
