// ── Codex 页：Codex 大脑（codex-bridge 插件）的进程、对话、用量和启停 ─────────────
// 数据来自 GET /api/codex/status（插件的 codex.status 能力 + 核心按价格表补的参考成本），
// 按钮走 POST /api/codex/control。样式复用 SnowLuma 页的卡片 / 状态行。

let codexPageTimer = null;

function codexWhere(chatKey) {
  const k = String(chatKey || '');
  const name = typeof chatNameOf === 'function' ? chatNameOf(k) : '';
  const base = k.startsWith('private:') ? `私聊 ${k.slice(8)}` : `群 ${k.slice(6)}`;
  return name && name !== k ? `${name}（${base}）` : base;
}

function codexAgo(t) {
  if (!t) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

function codexMoney(v) {
  return v == null ? '—' : `¥${Number(v).toFixed(2)}`;
}

function codexUsageRow(label, u, cost) {
  if (!u) return '';
  const fresh = Math.max(0, (u.prompt || 0) - (u.cached || 0));
  const hit = u.prompt ? Math.round(((u.cached || 0) / u.prompt) * 100) : 0;
  return `<tr>
    <td>${esc(label)}</td>
    <td>${u.turns || 0}</td>
    <td title="其中命中缓存 ${fmtTokens(u.cached || 0)}">${fmtTokens(u.prompt || 0)}<span class="muted">（新 ${fmtTokens(fresh)} · 缓存 ${hit}%）</span></td>
    <td title="已经包含思考 token">${fmtTokens(u.completion || 0)}<span class="muted">（思考 ${fmtTokens(u.reasoning || 0)}）</span></td>
    <td>${codexMoney(cost)}</td>
    <td>${u.failures || 0}</td>
  </tr>`;
}

async function loadCodexPage({ quiet = false } = {}) {
  const box = $('#codex-page');
  if (!box) return;
  let st;
  try {
    st = await api('/api/codex/status');
  } catch (e) {
    if (!quiet) box.innerHTML = `<div class="snowluma-page-card"><h2>Codex 大脑</h2><div class="empty-hint">读取状态失败：${esc(e.message)}</div></div>`;
    return;
  }
  if (!st || st.ok === false) {
    box.innerHTML = `<div class="snowluma-page-card"><h2>Codex 大脑</h2><div class="empty-hint">${esc(st?.error || 'codex-bridge 插件没有启用')}</div></div>`;
    return;
  }
  const b = st.brain;
  const u = b?.usage || {};
  const price = u.price;
  const alive = Boolean(b?.alive);
  const lastExit = b?.lastExit;
  const threads = b?.threads || [];
  const running = b?.running || [];

  box.innerHTML = `
    <div class="snowluma-page-card">
      <h2>Codex 大脑</h2>
      <div class="hint" style="margin-bottom:12px">
        Codex 接管的聊天里，机器人每次「调模型」都换成本机常驻的 Codex（app-server 进程）；工具、插件、档位照旧由 QQ Agent 执行。
        大脑出错时这一轮自动退回设置里的普通模型。
      </div>

      <div class="snowluma-qq-section">
        <div class="snowluma-state-row">
          <span class="dot ${alive ? 'dot-on' : 'dot-off'}"></span>
          <span>进程：<strong>${!b ? '未使用（直连模式）' : b.starting ? '启动中…' : alive ? '运行中' : '未运行'}</strong></span>
          ${alive && b.pid ? `<span class="muted">pid ${b.pid} · 启动于 ${codexAgo(b.startedAt)}</span>` : ''}
          ${b && !alive ? '<span class="muted">有消息要它回时会自动拉起</span>' : ''}
        </div>
        <div class="snowluma-state-row muted" style="font-size:12px">
          <span>本次运行启动过 ${b?.starts || 0} 次${lastExit ? ` · 上次退出 ${codexAgo(lastExit.at)}（code=${esc(String(lastExit.code ?? ''))}${lastExit.byUs ? '，手动重启' : ''}）` : ''}</span>
        </div>
        ${b?.lastError ? `<div class="snowluma-state-row" style="font-size:12px;color:var(--orange)"><span>最近一次出错：${esc(b.lastError)}（累计 ${b.failures || 0} 次退回普通模型）</span></div>` : ''}
        <div class="snowluma-state-row">
          <span>模型：<strong>${esc(st.model)}</strong></span>
          <span class="muted">随口插话 ${esc(st.effort || '默认')} · 被叫到 ${esc(st.effortAddressed || '默认')} · 联网搜索${st.webSearch ? '开' : '关'}</span>
        </div>
        ${st.locateError ? `<div class="snowluma-state-row" style="color:var(--orange)"><span>${esc(st.locateError)}</span></div>` : ''}
        <div class="snowluma-actions">
          <button class="btn btn-primary" id="codex-start-btn" ${!b || alive || b.starting ? 'disabled' : ''}>立即启动</button>
          <button class="btn" id="codex-restart-btn" ${!b ? 'disabled' : ''} title="杀掉常驻进程再拉起；各聊天的对话会接着用">重启进程</button>
          <button class="btn btn-danger" id="codex-stop-btn" ${!alive ? 'disabled' : ''} title="下次有消息时会自动拉起">停止进程</button>
          <button class="btn btn-small" id="codex-reload-btn" title="重新扫描并加载插件（改了 codex-bridge 代码后用）">重载插件</button>
          <button class="btn btn-small" id="codex-refresh-btn">刷新</button>
          <span id="codex-hint" class="muted" style="font-size:12px"></span>
        </div>
      </div>

      <hr class="sl-sep">

      <h3 class="usage-h3">用量与参考成本</h3>
      <div class="hint" style="margin-bottom:8px">
        token 数是 Codex 自己报的（输出已包含思考），按这条对话的累计值做差记账，不会因为通知晚到而漏记。
        <b>参考成本</b>按 API 官方价${price ? `（${esc(price.matched || '')}：输入 ¥${price.in}/百万、缓存命中 ¥${price.cached}/百万、输出 ¥${price.out}/百万）` : ''}折算；
        走 ChatGPT 订阅登录的 Codex 不按 token 扣钱，实际花的是订阅额度，这个数只用来比较轻重。
        「用量」页的总成本也按同一口径把 Codex 算进去。
      </div>
      <table class="usage-table" style="width:100%">
        <thead><tr><th></th><th>轮数</th><th>输入</th><th>输出</th><th>参考成本</th><th>退回普通模型</th></tr></thead>
        <tbody>
          ${codexUsageRow('今天', u.today, u.todayCost)}
          ${codexUsageRow('近 7 天', u.last7, u.last7Cost)}
        </tbody>
      </table>

      <hr class="sl-sep">

      <h3 class="usage-h3">接管的聊天（${(st.modes || []).length}）</h3>
      ${(st.modes || []).length ? '' : '<div class="muted">没有聊天开着 Codex 模式（主人在 QQ 里发「菜单」查看开启指令）。主人在任何群叫它时仍由大脑回复。</div>'}
      <div class="tool-meta" style="gap:6px;margin-bottom:10px">
        ${(st.modes || []).map((k) => `<span class="tool-dep">${esc(codexWhere(k))}</span>`).join('')}
      </div>

      <h3 class="usage-h3">对话（${threads.length}）</h3>
      <div class="hint" style="margin-bottom:6px">每个聊天一条长期 Codex 对话；上下文超过 ${fmtTokens(b?.rolloverTokens || 0)} 会自动换新对话。「重置」= 下一轮开新对话、重新给全量提示词。</div>
      <table class="usage-table" style="width:100%">
        <thead><tr><th>聊天</th><th>上下文</th><th>最近活动</th><th>状态</th><th></th></tr></thead>
        <tbody>
          ${threads.map((t) => {
            const pct = b?.rolloverTokens ? Math.min(100, Math.round((t.lastInput / b.rolloverTokens) * 100)) : 0;
            return `<tr>
              <td>${esc(codexWhere(t.chatKey))}</td>
              <td>${fmtTokens(t.lastInput)} <span class="muted">（${pct}%）</span></td>
              <td>${codexAgo(t.at)}</td>
              <td>${t.busy ? '<strong>正在想</strong>' : '<span class="muted">空闲</span>'}</td>
              <td><button class="btn btn-small codex-reset-btn" data-chat="${esc(t.chatKey)}" ${t.busy ? 'disabled' : ''}>重置</button></td>
            </tr>`;
          }).join('') || '<tr><td colspan="5" class="muted">还没有对话</td></tr>'}
        </tbody>
      </table>
      ${running.length ? `<div class="hint" style="margin-top:8px">正在进行：${running.map((r) => `${esc(codexWhere(r.chatKey))}（${codexAgo(r.startedAt)}开始${r.sentAny ? '，已发言' : ''}）`).join('、')}</div>` : ''}

      <hr class="sl-sep">

      ${(() => {
        const ws = st.workshop || {};
        const building = ws.building;
        const failed = (ws.recent || []).filter((j) => j.status === 'failed').slice(0, 3);
        return `
      <h3 class="usage-h3">自己写的工具（${(ws.tools || []).length}）</h3>
      <div class="hint" style="margin-bottom:6px">
        大脑缺能力时用 tool_request 让另一个 Codex 写新工具：静态检查 + 自测通过就自动上线（plugins/self-tools/tools/），上线后私聊告诉主人。
        ${ws.enabled === false ? '<b>现在在设置里关掉了。</b>' : `每天最多 ${ws.dailyMax || 6} 个。`}删掉就下线。
      </div>
      ${building ? `<div class="snowluma-state-row"><span class="dot dot-on"></span><span>正在写：<strong>${esc(building.name || building.id)}</strong></span><span class="muted">${esc(building.stage || '')} · ${esc(codexAgo(building.at))}开始 · ${esc(building.byName || building.by || '')}提的</span></div>
      <div class="snowluma-state-row muted" style="font-size:12px"><span>需求：${esc(building.need || '')}</span></div>` : ''}
      <table class="usage-table" style="width:100%">
        <thead><tr><th>工具</th><th>能做什么</th><th>谁提的</th><th>上线</th><th></th></tr></thead>
        <tbody>
          ${(ws.tools || []).map((t) => `<tr>
            <td><strong>${esc(t.name)}</strong><br><code class="mcard-tool-id">${esc(t.id)}</code></td>
            <td>${esc(t.summary || t.need || '')}</td>
            <td>${esc(t.by || '—')}${t.chatKey ? `<br><span class="muted">${esc(codexWhere(t.chatKey))}</span>` : ''}</td>
            <td>${codexAgo(t.at)}</td>
            <td><button class="btn btn-small btn-danger codex-tool-del" data-id="${esc(t.id)}">删除</button></td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">还没有自己写的工具</td></tr>'}
        </tbody>
      </table>
      ${failed.length ? `<div class="hint" style="margin-top:8px">最近没写成：${failed.map((j) => `${esc(j.name || j.id)}（${esc(String(j.error || '').slice(0, 80))}）`).join('；')}</div>` : ''}`;
      })()}
    </div>`;

  const hint = (t) => { const el = $('#codex-hint'); if (el) el.textContent = t; };
  const control = async (action, extra = {}, doing = '处理中…') => {
    hint(doing);
    try {
      const r = await api('/api/codex/control', { method: 'POST', body: JSON.stringify({ action, ...extra }) });
      hint(r.ok === false ? `失败：${r.error}` : '完成');
    } catch (e) {
      hint(`失败：${e.message}`);
    }
    loadCodexPage({ quiet: true });
  };
  $('#codex-start-btn')?.addEventListener('click', () => control('start', {}, '正在启动 Codex…'));
  $('#codex-restart-btn')?.addEventListener('click', () => control('restart', {}, '正在重启 Codex…'));
  $('#codex-stop-btn')?.addEventListener('click', () => control('stop', {}, '正在停止…'));
  $('#codex-refresh-btn')?.addEventListener('click', () => loadCodexPage());
  $('#codex-reload-btn')?.addEventListener('click', async () => {
    hint('正在重载插件…');
    try {
      const r = await api('/api/skills/reload', { method: 'POST' });
      hint(`重载完成：${(r.loaded || []).length} 个成功${(r.failed || []).length ? `，${r.failed.length} 个失败（${r.failed.map((f) => f.id).join('、')}）` : ''}`);
    } catch (e) { hint(`重载失败：${e.message}`); }
    loadCodexPage({ quiet: true });
  });
  for (const btn of box.querySelectorAll('.codex-tool-del')) {
    btn.addEventListener('click', async () => {
      const toolId = btn.dataset.id;
      if (!(await uiConfirm(`删除自己写的工具 ${toolId}？删掉后热重载就下线，要用得让它重新写。`))) return;
      control('remove-tool', { toolId }, '正在删除…');
    });
  }
  for (const btn of box.querySelectorAll('.codex-reset-btn')) {
    btn.addEventListener('click', async () => {
      const chatKey = btn.dataset.chat;
      if (!(await uiConfirm(`重置 ${codexWhere(chatKey)} 的 Codex 对话？下一轮会开新对话、重新发全量提示词（之前的上下文它就不记得了）。`))) return;
      control('reset-thread', { chatKey }, '正在重置…');
    });
  }

  // 停在这一页时每 5 秒刷新一次（进程状态、正在想的对话）
  clearTimeout(codexPageTimer);
  codexPageTimer = setTimeout(() => { if (state.tab === 'codex') loadCodexPage({ quiet: true }); }, 5000);
}
