'use strict';

const $ = (id) => document.getElementById(id);
let config = { mode: 'pet', skin: 'mascot' };
let lastOpKey = null;
const t = (key, vars) => window.OctoI18n.t(key, vars);
// Date formatting follows the UI language, not the OS locale.
const LOCALE_TAG = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' };

let hoursSummary = ''; // 24h 视图默认读数（鼠标移开时恢复）
let calSummary = '';   // 日历默认读数
let usageMetric = 'tokens';
const dKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function fmt(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function shortModel(m) {
  if (!m) return '?';
  return String(m).replace(/^claude-/, '').replace(/\[1m\]/, '·1M');
}

let lastStats = null; // kept so a language switch can relabel without a new push
const hasBillingLedger = (stats) => !!(
  stats && stats.billingAvailable !== false && !['dsh', 'unknown'].includes(stats.usageProvider)
);

function renderUnavailableUsage() {
  $('chart').innerHTML = '';
  $('cal').innerHTML = '';
  hoursSummary = '—';
  calSummary = '—';
  $('hours-readout').textContent = hoursSummary;
  $('cal-readout').textContent = calSummary;
}

function render(s) {
  if (!s) return;
  lastStats = s;
  // 头部
  if (s.active && s.active.project) {
    $('active-sub').textContent = `${s.active.project} · ${shortModel(s.active.model)}`;
  }
  const billingAvailable = hasBillingLedger(s);
  // 大数：Claude + Codex 合计，下方给出两家的拆分（只有一家有量时不显示拆分）。
  // A dsh/unknown-only snapshot has no attributable price ledger; render a
  // neutral dash rather than turning somebody else's spend into a $0/combined
  // bill for that provider.
  if (billingAvailable) {
    $('today-cost').textContent = '$' + (s.today.cost || 0).toFixed(3);
    $('today-tokens').textContent = fmt(s.today.tokens) + ' tokens · ' + s.today.messages + t('panel.rounds');
    renderSplit('today-split', s.todayByProvider);
    $('win-cost').textContent = '$' + (s.lifetime.cost || 0).toFixed(3);
    $('win-reset').textContent = fmt(s.lifetime.tokens) + ' tokens · ' + s.lifetime.messages + t('panel.rounds');
    renderSplit('win-split', s.lifetimeByProvider);
  } else {
    $('today-cost').textContent = '—';
    $('today-tokens').textContent = '—';
    $('win-cost').textContent = '—';
    $('win-reset').textContent = '—';
    renderSplit('today-split', null);
    renderSplit('win-split', null);
  }

  // token 明细：这一块的行是 Claude 的缓存 TTL 语义（5m/1h 写入），Codex 没有
  // 对应字段，所以取 Claude 那一侧而不是合计——否则标题和数字对不上。
  const claudeToday = billingAvailable
    ? (s.todayByProvider && s.todayByProvider.claude) || s.today
    : null;
  for (const id of ['t-in', 't-out', 't-cw5', 't-cw1', 't-cr', 't-msg']) $(id).textContent = '—';
  if (claudeToday) {
    $('t-in').textContent = fmt(claudeToday.input);
    $('t-out').textContent = fmt(claudeToday.output);
    $('t-cw5').textContent = fmt(claudeToday.cacheWrite5m);
    $('t-cw1').textContent = fmt(claudeToday.cacheWrite1h);
    $('t-cr').textContent = fmt(claudeToday.cacheRead);
    $('t-msg').textContent = claudeToday.messages;
  }

  renderCodexUsage(billingAvailable ? s.codexUsage : null, billingAvailable ? s.codexDiagnostics : null);
  renderDiagnostics(billingAvailable ? s.diagnostics : null);

  // 按模型（有总有分：每模型 cost + 占比条 + in/out/cache 四元组明细，末行合计）
  renderByModel(billingAvailable ? (s.byModel || {}) : {});

  // 待办清单
  renderTodos(s.todos || [], s.todosProject || '');

  // 用量趋势：24h + 日历
  if (billingAvailable) {
    renderChart(s.hourly || [], s.hourlyTok || []);
    renderCal(s.daily || {});
  } else renderUnavailableUsage();

  // 进行中的任务（各会话状态）
  renderSessList(s.sessions || []);

  // 后台任务对账
  renderBg(s.bg || { items: [] });

  // 操作流
  const ops = s.lastOps || [];
  const list = $('ops');
  if (ops.length === 0) {
    list.innerHTML = '<li class="empty">' + escapeHtml(t('panel.waitingOps')) + '</li>';
  } else {
    const topKey = ops[0].ts + ops[0].detail;
    const isNew = topKey !== lastOpKey;
    lastOpKey = topKey;
    list.innerHTML = ops
      .map(
        (o, i) =>
          `<li class="${i === 0 && isNew ? 'new' : ''}"><span>${o.icon || '🔧'}</span><span>${escapeHtml(o.detail)}</span><span class="op-proj">${escapeHtml(o.project || '')}</span><span class="op-time">${timeStr(o.ts)}</span></li>`
      )
      .join('');
  }
  fitPanelHeight();
}

// 合计大数下方的两家拆分。只有一家有量时留空——单 agent 的机器不该看到
// 「Codex $0.000」这种噪音。
function renderSplit(id, byProvider) {
  const el = $(id);
  if (!el) return;
  const claude = (byProvider && byProvider.claude && byProvider.claude.cost) || 0;
  const codex = (byProvider && byProvider.codex && byProvider.codex.cost) || 0;
  if (claude <= 0 || codex <= 0) { el.textContent = ''; return; }
  el.textContent = t('panel.providerSplit', { claude: claude.toFixed(2), codex: codex.toFixed(2) });
}

// 面板按内容高度自适应：量出内容底边（footer 底）到卡片顶的距离，通知主进程调窗口高，
// 避免固定高窗口在内容变短时露出大片空白。requestAnimationFrame 确保布局已完成。
let fitRaf = 0;
function fitPanelHeight() {
  if (!window.pet || !window.pet.setPanelHeight) return;
  if (fitRaf) cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    const card = $('card');
    const last = card && card.lastElementChild; // 内容最后一块（footer 已移除）
    if (!card || !last) return;
    const h = Math.ceil(last.getBoundingClientRect().bottom - card.getBoundingClientRect().top + card.scrollTop) + 14; // +底部呼吸留白
    if (h > 0) window.pet.setPanelHeight(h);
  });
}

// 按模型明细：每模型一行 = 名称 + 占比条 + $花费 + token/占比；下方灰字给出
// 入/出/缓写/缓读 四元组与轮次；最后一行合计。数据里没有明细字段（旧数据）时只
// 显示头行，跑一次 `npm run meter:rebuild` 可回填历史明细。
function renderByModel(byModel) {
  const bm = $('by-model');
  const entries = Object.entries(byModel).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  if (!entries.length) { bm.innerHTML = '<div class="empty">' + escapeHtml(t('panel.noData')) + '</div>'; return; }
  const totCost = entries.reduce((s, [, v]) => s + (v.cost || 0), 0);
  const totTok = entries.reduce((s, [, v]) => s + (v.tokens || 0), 0);
  const base = totCost || 1;
  let html = '';
  for (const [model, v] of entries) {
    const pct = Math.round(((v.cost || 0) / base) * 100);
    // 两家的 token 分类不同：Claude 是 5m/1h 缓存写 + 缓存读，Codex 是缓存输入 +
    // 推理输出，各用各的明细模板，不硬塞进同一行。
    const hasDetail = (v.input || v.output || v.cacheCreate || v.cacheRead || v.cachedInput);
    const body = v.agent === 'codex'
      ? t('panel.codexBreakdown', {
        in: fmt(v.input), out: fmt(v.output),
        cached: fmt(v.cachedInput), reasoning: fmt(v.reasoningOutput),
      })
      : t('panel.modelDetail', {
        in: fmt(v.input), out: fmt(v.output),
        cw5: fmt(v.cacheWrite5m), cw1: fmt(v.cacheWrite1h), cr: fmt(v.cacheRead),
      });
    const detail = hasDetail
      ? `<div class="m-detail">${escapeHtml(body)}${v.msgs ? escapeHtml(t('panel.modelRounds', { n: v.msgs })) : ''}</div>`
      : '';
    // Codex 与 Claude 现在同列，加来源小图标区分（与会话列表同款）
    const icon = AGENT_ICON[v.agent] || AGENT_ICON.claude;
    html += `<div class="m-item">`
      + `<div class="m-head"><span class="m-agent">${icon}</span><span class="mc">${escapeHtml(shortModel(model))}</span>`
      + `<span class="m-bar"><i style="width:${pct}%"></i></span>`
      + `<b class="m-cost">$${(v.cost || 0).toFixed(3)}</b>`
      + `<span class="m-tok">${fmt(v.tokens)} · ${pct}%</span></div>`
      + detail + `</div>`;
  }
  html += `<div class="m-item m-total"><div class="m-head"><span class="mc">${escapeHtml(t('panel.total'))}</span>`
    + `<span class="m-bar"></span><b class="m-cost">$${totCost.toFixed(3)}</b>`
    + `<span class="m-tok">${fmt(totTok)}</span></div></div>`;
  bm.innerHTML = html;
}

// key (not label): resolved at render time so a language switch relabels rows.
const STATE_META = {
  working: { key: 'state.working', cls: 'st-working' },
  juggling: { key: 'state.juggling', cls: 'st-working' },
  sweeping: { key: 'state.sweeping', cls: 'st-working' },
  thinking: { key: 'state.thinking', cls: 'st-thinking' },
  loafing: { key: 'state.loafing', cls: 'st-idle' },
  waiting: { key: 'state.waiting', cls: 'st-waiting' },
  needsinput: { key: 'state.needsinput', cls: 'st-needsinput' },
  error: { key: 'state.error', cls: 'st-error' },
  done: { key: 'state.done', cls: 'st-done' },
  idle: { key: 'state.idle', cls: 'st-idle' },
  sleeping: { key: 'state.sleeping', cls: 'st-sleeping' },
  greet: { key: 'state.greet', cls: 'st-greet' },
  talking: { key: 'state.talking', cls: 'st-talking' },
};
function renderCodexUsage(usage, diag) {
  const wrap = $('codex-usage');
  if (!wrap) return;
  const today = usage && usage.today;
  const lifetime = usage && usage.lifetime;
  if (!today || !lifetime || (!today.tokens && !lifetime.tokens)) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  // This is an API-standard equivalent derived from local rollout tokens. A
  // ChatGPT/Codex subscription is governed by its quota, not billed this sum.
  $('codex-today').textContent = '$' + (today.cost || 0).toFixed(3);
  $('codex-lifetime').textContent = '$' + (lifetime.cost || 0).toFixed(2);
  $('codex-today-detail').textContent = fmt(today.tokens) + ' tok · ' + t('panel.codexBreakdown', {
    in: fmt(today.input), out: fmt(today.output),
    cached: fmt(today.cachedInput), reasoning: fmt(today.reasoningOutput),
  });
  const info = diag || (usage && usage.diagnostics) || {};
  const bits = [fmt(lifetime.tokens) + ' tok', t('panel.codexLocalHistory', {
    sessions: info.sessions || 0,
    events: info.events || 0,
  })];
  if (info.estimatedModelCount) bits.push(t('panel.codexEstimated', { n: info.estimatedModelCount }));
  $('codex-lifetime-detail').textContent = bits.join(' · ');
}

function renderDiagnostics(diag) {
  const el = $('usage-diagnostics');
  if (!el) return;
  if (!diag) { el.textContent = ''; return; }
  const last = diag.lastScanTs
    ? new Date(diag.lastScanTs).toLocaleTimeString(LOCALE_TAG[window.OctoI18n.getLang()], { hour: '2-digit', minute: '2-digit' })
    : t('panel.diagNever');
  const bits = [
    t('panel.diagScan', { when: last, files: diag.scannedFiles || 0, records: diag.records || 0 }),
    t('panel.diagCorrections', { n: diag.streamingCorrections || 0 }),
  ];
  if (diag.estimatedModelCount) bits.push(t('panel.diagEstimated', { n: diag.estimatedModelCount }));
  if (diag.pricing && diag.pricing.stale) bits.push(t('panel.diagStale'));
  el.textContent = bits.join(' · ');
}

function renderChart(hourlyCost, hourlyTokens) {
  const el = $('chart');
  if (!el) return;
  const hourly = usageMetric === 'cost' ? hourlyCost : hourlyTokens;
  const values = hourly && hourly.length ? hourly : new Array(24).fill(0);
  const max = Math.max(0.000001, ...values);
  const nowH = new Date().getHours();
  let total = 0, peakH = 0, peakV = 0;
  el.innerHTML = values
    .map((value, h) => {
      total += value;
      if (value > peakV) { peakV = value; peakH = h; }
      const pct = Math.max(3, Math.round((value / max) * 100));
      const cls = value <= 0 ? 'bar empty' : h === nowH ? 'bar now' : 'bar';
      const display = usageMetric === 'cost' ? '$' + value.toFixed(3) : fmt(value) + ' tok';
      return `<div class="${cls}" data-h="${h}" data-v="${escapeHtml(display)}" style="height:${value <= 0 ? 4 : pct}%" title="${h}:00 · ${escapeHtml(display)}"></div>`;
    })
    .join('');
  hoursSummary = usageMetric === 'cost'
    ? t('panel.hoursSummaryCost', { total: total.toFixed(2), peakH, peakV: peakV.toFixed(2) })
    : t('panel.hoursSummaryTokens', { total: fmt(total), peakH, peakV: fmt(peakV) });
  const ro = $('hours-readout');
  if (ro) ro.innerHTML = hoursSummary;
}

function renderCal(daily) {
  const el = $('cal');
  if (!el) return;
  daily = daily || {};
  const WEEKS = 12, DAYS = WEEKS * 7;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (DAYS - 1));
  start.setDate(start.getDate() - start.getDay()); // 回到周日对齐
  const todayK = dKey(today);
  const list = [];
  let max = 1e-6, total = 0;
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const k = dKey(d);
    const v = daily[k] || { cost: 0, tokens: 0, msgs: 0 };
    const metricValue = usageMetric === 'cost' ? v.cost : (v.tokens || 0);
    if (metricValue > max) max = metricValue;
    total += metricValue;
    list.push({ k, cost: v.cost, tokens: v.tokens || 0, msgs: v.msgs || 0 });
  }
  let html = '';
  for (let i = 0; i < list.length; i += 7) {
    html += '<div class="cal-col">';
    for (let j = 0; j < 7 && i + j < list.length; j++) {
      const c = list[i + j];
      const metricValue = usageMetric === 'cost' ? c.cost : c.tokens;
      const lvl = metricValue <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((metricValue / max) * 4)));
      const isToday = c.k === todayK ? ' today' : '';
      html += `<div class="cal-cell lv${lvl}${isToday}" data-k="${c.k}" data-c="${c.cost.toFixed(2)}" data-t="${fmt(c.tokens)}" data-m="${c.msgs}" title="${c.k} · $${c.cost.toFixed(2)}"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
  calSummary = usageMetric === 'cost'
    ? t('panel.calSummaryCost', { n: list.length, total: total.toFixed(2) })
    : t('panel.calSummaryTokens', { n: list.length, total: fmt(total) });
  const cr = $('cal-readout');
  if (cr) cr.innerHTML = calSummary;
}

// 会话来源小图标：Claude 橙 burst / Codex 蓝终端块 / dsh 深蓝鲸波（与桌宠 HUD 同款）
const AGENT_ICON = {
  claude: '<svg viewBox="0 0 24 24" fill="#d97757"><path d="M12 1l2.2 6.3L20.5 5l-4 5.4 6.5 1.6-6.5 1.6 4 5.4-6.3-2.3L12 23l-2.2-6.3L3.5 19l4-5.4L1 12l6.5-1.6-4-5.4 6.3 2.3z"/></svg>',
  codex: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#3b82f6"/><path d="M7 8l4 4-4 4" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 16.5h4.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  dsh: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#4d6bfe"/><circle cx="8.6" cy="9" r="1.5" fill="#fff"/><path d="M12 9h5.4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M5 15c1.6 0 1.6-1.7 3.3-1.7S9.9 15 11.5 15s1.6-1.7 3.3-1.7S16.4 15 18 15" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
  unknown: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#777582"/><text x="12" y="17" fill="#fff" font-size="14" font-weight="700" text-anchor="middle">?</text></svg>',
};
const AGENT_NAME = { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek Harness', unknown: 'Agent' };

function renderSessList(sessions) {
  const el = $('sess-list');
  if (!sessions.length) {
    el.innerHTML = '<div class="empty">' + escapeHtml(t('panel.noActiveSession')) + '</div>';
    return;
  }
  el.innerHTML = sessions
    .map((s) => {
      // 与桌宠 HUD 同源：badge=done/interrupted 时盖掉 idle，对齐头顶小点
      const effState = s.state === 'idle' && s.badge === 'done' ? 'done'
        : s.state === 'idle' && s.badge === 'interrupted' ? 'error'
        : s.state;
      const m = STATE_META[effState] || STATE_META.idle;
      const detail =
        effState === 'waiting' ? escapeHtml(s.reason ? t('wait.' + s.reason) : t('wait.default'))
        : effState === 'needsinput' ? escapeHtml((s.choice && s.choice.question) || t('state.needsinput'))
        : (effState === 'working' || effState === 'juggling' || effState === 'sweeping' || effState === 'thinking') && s.op ? escapeHtml(s.op)
        : escapeHtml(t(m.key));
      const icon = AGENT_ICON[s.agent] || AGENT_ICON.unknown;
      const who = AGENT_NAME[s.agent] || 'Agent';
      // 会话 id 芯片：短前缀够认人，点一下复制完整 id（跨 session 协作时贴给
      // 另一个 agent 去 resume）。title 挂完整 id，不用复制也能看全。
      const id = s.sessionId ? `<button class="sess-id" data-id="${escapeHtml(s.sessionId)}" title="${escapeHtml(s.sessionId)}&#10;${escapeHtml(t('panel.copyId'))}">${escapeHtml(shortId(s.sessionId))}</button>` : '';
      return `<div class="row sess"><span class="badge ${m.cls}">${escapeHtml(t(m.key))}</span><span class="sess-agent" title="${who}">${icon}</span><span class="sess-proj">${escapeHtml(s.project)}</span>${id}<span class="sess-op">${detail}</span></div>`;
    })
    .join('');
}

// 会话 id 前 8 位——UUID 的前段在本机范围内已经足够唯一，完整 id 在 title 和
// 剪贴板里。面板很窄，塞 36 个字符会把项目名和状态挤没。
function shortId(id) {
  const s = String(id || '');
  return s.length > 8 ? s.slice(0, 8) : s;
}

const TODO_ICON = { completed: '✅', in_progress: '▶️', pending: '⬜️' };
function renderTodos(todos, proj) {
  // 空待办不占版面（待办常年为空）——整块收起
  const block = $('todo-block');
  if (block) block.style.display = todos.length ? '' : 'none';
  const el = $('todo-list');
  if (!el) return;
  const prog = $('todo-prog');
  const pj = $('todo-proj');
  if (!todos.length) {
    el.innerHTML = '<div class="empty">' + escapeHtml(t('panel.noTodo')) + '</div>';
    if (prog) prog.textContent = '';
    if (pj) pj.textContent = '';
    return;
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  if (prog) prog.textContent = `${done}/${todos.length}`;
  if (pj) pj.textContent = proj ? '· ' + proj : '';
  el.innerHTML = todos
    .map((t) => {
      const cls = t.status === 'completed' ? 'td done' : t.status === 'in_progress' ? 'td doing' : 'td';
      return `<div class="${cls}"><span class="td-ic">${TODO_ICON[t.status] || '⬜️'}</span><span class="td-txt">${escapeHtml(t.content)}</span></div>`;
    })
    .join('');
}

const BG_META = {
  running: { key: 'bg.running', cls: 'st-working' },
  suspect: { key: 'bg.suspect', cls: 'st-waiting' },
  unregistered: { key: 'bg.unregistered', cls: 'st-waiting' },
  ended: { key: 'bg.ended', cls: 'st-idle' },
};
function ageStr(sec) {
  if (sec == null) return '';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
  return (sec / 86400).toFixed(1) + 'd';
}
function renderBg(bg) {
  const el = $('bg-list');
  if (!el) return;
  const items = (bg.items || []).filter((x) => x.alive); // 只列还活着的
  // 没有后台进程时整块收起，不占版面
  const block = $('bg-block');
  if (block) block.style.display = items.length ? '' : 'none';
  const head = $('bg-head');
  if (head) head.textContent = t('panel.bgHead', { running: bg.running || 0, zombie: bg.zombie || 0 });
  if (!items.length) {
    el.innerHTML = '<div class="empty">' + escapeHtml(t('panel.bgClean')) + '</div>';
    return;
  }
  el.innerHTML = items
    .map((it) => {
      const m = BG_META[it.status] || BG_META.ended;
      const ic = it.status === 'running' ? '✅' : it.status === 'ended' ? '⚪' : '🧟';
      const purpose = it.purpose ? escapeHtml(it.purpose) : escapeHtml(String(it.cmd).slice(0, 48));
      return `<div class="row sess"><span class="badge ${m.cls}">${ic}${escapeHtml(t(m.key))}</span><span class="sess-proj">${purpose}</span><span class="sess-op">${ageStr(it.ageSec)} · ${it.stop ? escapeHtml(it.stop) : ''}</span></div>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function applyConfigUI() {
  document.querySelectorAll('#mode-seg .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === config.mode)
  );
  document.querySelectorAll('#skin-seg .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.skin === (config.skin || 'mascot'))
  );
}

// 事件
window.pet.onPanelStats(render);
window.pet.onPrice((m) => {
  const el = $('price-src');
  if (!el || !m) return;
  if (m.live) {
    const when = m.ts ? new Date(m.ts).toLocaleString(LOCALE_TAG[window.OctoI18n.getLang()], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : t('panel.priceCache');
    el.textContent = t('panel.priceOnline', { count: m.count, when });
  } else {
    el.textContent = t('panel.priceFallback');
  }
});
window.pet.onConfig((cfg) => {
  if (!cfg) return;
  const langChanged = cfg.lang && cfg.lang !== window.OctoI18n.getLang();
  config = { ...config, ...cfg };
  if (langChanged) {
    window.OctoI18n.setLang(cfg.lang);
    applyStaticI18n();
    if (lastStats) render(lastStats); // relabel live rows without waiting for the next push
  }
  applyConfigUI();
});

// Static markup ships with its Chinese text inline so the panel is never blank
// before the first config push; data-i18n rewrites it per language.
function applyStaticI18n() {
  const lang = window.OctoI18n.getLang();
  document.documentElement.lang = lang;
  document.title = t('panel.title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}

$('close').addEventListener('click', () => window.pet.closePanel());
document.querySelectorAll('#mode-seg .seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    config.mode = b.dataset.mode;
    applyConfigUI();
    window.pet.setMode(b.dataset.mode);
  })
);
document.querySelectorAll('#skin-seg .seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    config.skin = b.dataset.skin;
    applyConfigUI();
    window.pet.setSkin(b.dataset.skin);
  })
);
// 视图切换：24h / 日历
document.querySelectorAll('.view-tabs .vt').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.view-tabs .vt').forEach((x) => x.classList.toggle('active', x === b));
    $('view-hours').classList.toggle('hidden', b.dataset.view !== 'hours');
    $('view-cal').classList.toggle('hidden', b.dataset.view !== 'cal');
  })
);

document.querySelectorAll('.metric-tabs .mt').forEach((b) =>
  b.addEventListener('click', () => {
    usageMetric = b.dataset.metric === 'cost' ? 'cost' : 'tokens';
    document.querySelectorAll('.metric-tabs .mt').forEach((x) => x.classList.toggle('active', x === b));
    if (lastStats) {
      if (hasBillingLedger(lastStats)) {
        renderChart(lastStats.hourly || [], lastStats.hourlyTok || []);
        renderCal(lastStats.daily || {});
      } else renderUnavailableUsage();
    }
  })
);

// 悬停看具体数值：24h 柱
$('chart').addEventListener('mouseover', (e) => {
  const bar = e.target.closest('.bar');
  if (bar) $('hours-readout').innerHTML = `${bar.dataset.h}:00 · <b>${escapeHtml(bar.dataset.v)}</b>`;
});
$('chart').addEventListener('mouseleave', () => { $('hours-readout').innerHTML = hoursSummary; });

// 悬停看具体数值：日历格子
$('cal').addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.cal-cell');
  if (cell) $('cal-readout').innerHTML = t('panel.calReadout', { k: cell.dataset.k, c: cell.dataset.c, t: cell.dataset.t, m: cell.dataset.m });
});
$('cal').addEventListener('mouseleave', () => { $('cal-readout').innerHTML = calSummary; });

// 点会话 id 芯片 → 复制完整 id。委托在列表上，因为行是每次 render 重建的。
$('sess-list').addEventListener('click', async (e) => {
  const chip = e.target.closest && e.target.closest('.sess-id');
  if (!chip || !window.pet.copySessionId) return;
  const ok = await window.pet.copySessionId(chip.dataset.id);
  if (!ok) return;
  chip.textContent = t('panel.copied');
  chip.classList.add('copied');
  // 定时复原，不依赖下一次 render——面板空闲时 stats 可能好一会儿才推一次
  setTimeout(() => {
    chip.textContent = shortId(chip.dataset.id);
    chip.classList.remove('copied');
  }, 1200);
});

// 初始化
(async () => {
  const cfg = await window.pet.getConfig();
  if (cfg) { config = { ...config, ...cfg }; window.OctoI18n.setLang(cfg.lang || 'zh'); applyConfigUI(); }
  applyStaticI18n();
  const s = await window.pet.getStats();
  if (s) render(s);
})();
