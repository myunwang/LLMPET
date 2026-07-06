'use strict';

const $ = (id) => document.getElementById(id);
let config = { mode: 'pet', skin: 'mascot', budget5h: 0 };
let lastOpKey = null;
let hoursSummary = ''; // 24h 视图默认读数（鼠标移开时恢复）
let calSummary = '';   // 日历默认读数
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

function render(s) {
  if (!s) return;
  // 头部
  if (s.active && s.active.project) {
    $('active-sub').textContent = `${s.active.project} · ${shortModel(s.active.model)}`;
  }
  // 大数
  $('today-cost').textContent = '$' + (s.today.cost || 0).toFixed(3);
  $('today-tokens').textContent = fmt(s.today.tokens) + ' tokens · ' + s.today.messages + ' 轮';
  $('win-cost').textContent = '$' + (s.window5h.cost || 0).toFixed(3);
  if (s.window5h.tokens > 0 && s.window5h.resetTs) {
    $('win-reset').textContent = fmt(s.window5h.tokens) + ' tok · ' + timeStr(s.window5h.resetTs) + ' 重置';
  } else {
    $('win-reset').textContent = '窗口空闲';
  }

  // 预算条
  if (config.budget5h > 0) {
    $('budget-wrap').classList.remove('hidden');
    const pct = Math.min(100, (s.window5h.cost / config.budget5h) * 100);
    $('budget-pct').textContent = pct.toFixed(0) + '%';
    const fill = $('budget-fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('warn', pct >= 80);
  } else {
    $('budget-wrap').classList.add('hidden');
  }

  // token 明细
  $('t-in').textContent = fmt(s.today.input);
  $('t-out').textContent = fmt(s.today.output);
  $('t-cw').textContent = fmt(s.today.cacheCreate);
  $('t-cr').textContent = fmt(s.today.cacheRead);
  $('t-msg').textContent = s.today.messages;

  // 按模型（有总有分：每模型 cost + 占比条 + in/out/cache 四元组明细，末行合计）
  renderByModel(s.byModel || {});

  // 待办清单
  renderTodos(s.todos || [], s.todosProject || '');

  // 用量趋势：24h + 日历
  renderChart(s.hourly || []);
  renderCal(s.daily || {});

  // 进行中的任务（各会话状态）
  renderSessList(s.sessions || []);

  // 后台任务对账
  renderBg(s.bg || { items: [] });

  // 操作流
  const ops = s.lastOps || [];
  const list = $('ops');
  if (ops.length === 0) {
    list.innerHTML = '<li class="empty">等待操作…</li>';
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
}

// 按模型明细：每模型一行 = 名称 + 占比条 + $花费 + token/占比；下方灰字给出
// 入/出/缓写/缓读 四元组与轮次；最后一行合计。数据里没有明细字段（旧数据）时只
// 显示头行，跑一次 `npm run meter:rebuild` 可回填历史明细。
function renderByModel(byModel) {
  const bm = $('by-model');
  const entries = Object.entries(byModel).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  if (!entries.length) { bm.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const totCost = entries.reduce((s, [, v]) => s + (v.cost || 0), 0);
  const totTok = entries.reduce((s, [, v]) => s + (v.tokens || 0), 0);
  const base = totCost || 1;
  let html = '';
  for (const [model, v] of entries) {
    const pct = Math.round(((v.cost || 0) / base) * 100);
    const hasDetail = (v.input || v.output || v.cacheCreate || v.cacheRead);
    const detail = hasDetail
      ? `<div class="m-detail">入 ${fmt(v.input)} · 出 ${fmt(v.output)} · 缓写 ${fmt(v.cacheCreate)} · 缓读 ${fmt(v.cacheRead)}${v.msgs ? ' · ' + v.msgs + ' 轮' : ''}</div>`
      : '';
    html += `<div class="m-item">`
      + `<div class="m-head"><span class="mc">${escapeHtml(shortModel(model))}</span>`
      + `<span class="m-bar"><i style="width:${pct}%"></i></span>`
      + `<b class="m-cost">$${(v.cost || 0).toFixed(3)}</b>`
      + `<span class="m-tok">${fmt(v.tokens)} · ${pct}%</span></div>`
      + detail + `</div>`;
  }
  html += `<div class="m-item m-total"><div class="m-head"><span class="mc">合计</span>`
    + `<span class="m-bar"></span><b class="m-cost">$${totCost.toFixed(3)}</b>`
    + `<span class="m-tok">${fmt(totTok)}</span></div></div>`;
  bm.innerHTML = html;
}

const STATE_META = {
  working: { label: '干活中', cls: 'st-working' },
  juggling: { label: '并行子任务', cls: 'st-working' },
  sweeping: { label: '清理上下文', cls: 'st-working' },
  thinking: { label: '思考中', cls: 'st-thinking' },
  loafing: { label: '摸鱼中', cls: 'st-idle' },
  waiting: { label: '等你处理', cls: 'st-waiting' },
  needsinput: { label: '等你回复', cls: 'st-needsinput' },
  error: { label: '出错了', cls: 'st-error' },
  done: { label: '刚完成', cls: 'st-done' },
  idle: { label: '空闲', cls: 'st-idle' },
  sleeping: { label: '休息中', cls: 'st-sleeping' },
  greet: { label: '新会话', cls: 'st-greet' },
  talking: { label: '回应中', cls: 'st-talking' },
};
function renderChart(hourly) {
  const el = $('chart');
  if (!el) return;
  if (!hourly.length) hourly = new Array(24).fill(0);
  const max = Math.max(0.000001, ...hourly);
  const nowH = new Date().getHours();
  let total = 0, peakH = 0, peakV = 0;
  el.innerHTML = hourly
    .map((c, h) => {
      total += c;
      if (c > peakV) { peakV = c; peakH = h; }
      const pct = Math.max(3, Math.round((c / max) * 100));
      const cls = c <= 0 ? 'bar empty' : h === nowH ? 'bar now' : 'bar';
      return `<div class="${cls}" data-h="${h}" data-c="${c.toFixed(3)}" style="height:${c <= 0 ? 4 : pct}%" title="${h}:00 · $${c.toFixed(3)}"></div>`;
    })
    .join('');
  hoursSummary = `今日 <b>$${total.toFixed(2)}</b> · 峰值 ${peakH}点 <b>$${peakV.toFixed(2)}</b>`;
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
    if (v.cost > max) max = v.cost;
    total += v.cost;
    list.push({ k, cost: v.cost, tokens: v.tokens || 0, msgs: v.msgs || 0 });
  }
  let html = '';
  for (let i = 0; i < list.length; i += 7) {
    html += '<div class="cal-col">';
    for (let j = 0; j < 7 && i + j < list.length; j++) {
      const c = list[i + j];
      const lvl = c.cost <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((c.cost / max) * 4)));
      const isToday = c.k === todayK ? ' today' : '';
      html += `<div class="cal-cell lv${lvl}${isToday}" data-k="${c.k}" data-c="${c.cost.toFixed(2)}" data-t="${fmt(c.tokens)}" data-m="${c.msgs}" title="${c.k} · $${c.cost.toFixed(2)}"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
  calSummary = `近 ${list.length} 天合计 <b>$${total.toFixed(2)}</b>`;
  const cr = $('cal-readout');
  if (cr) cr.innerHTML = calSummary;
}

function renderSessList(sessions) {
  const el = $('sess-list');
  if (!sessions.length) {
    el.innerHTML = '<div class="empty">暂无活跃会话</div>';
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
        effState === 'waiting' ? `等你${s.reason || '处理'}`
        : effState === 'needsinput' ? escapeHtml((s.choice && s.choice.question) || '等你回复')
        : (effState === 'working' || effState === 'juggling' || effState === 'sweeping' || effState === 'thinking') && s.op ? escapeHtml(s.op)
        : escapeHtml(m.label);
      return `<div class="row sess"><span class="badge ${m.cls}">${m.label}</span><span class="sess-proj">${escapeHtml(s.project)}</span><span class="sess-op">${detail}</span></div>`;
    })
    .join('');
}

const TODO_ICON = { completed: '✅', in_progress: '▶️', pending: '⬜️' };
function renderTodos(todos, proj) {
  const el = $('todo-list');
  if (!el) return;
  const prog = $('todo-prog');
  const pj = $('todo-proj');
  if (!todos.length) {
    el.innerHTML = '<div class="empty">当前没有待办</div>';
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
  running: { label: '该跑', cls: 'st-working' },
  suspect: { label: '可疑', cls: 'st-waiting' },
  unregistered: { label: '疑似僵尸', cls: 'st-waiting' },
  ended: { label: '已结束', cls: 'st-idle' },
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
  const head = $('bg-head');
  if (head) head.textContent = `后台任务 ✅${bg.running || 0} · 🧟${bg.zombie || 0}`;
  if (!items.length) {
    el.innerHTML = '<div class="empty">没有长跑的后台进程 — 干净</div>';
    return;
  }
  el.innerHTML = items
    .map((it) => {
      const m = BG_META[it.status] || BG_META.ended;
      const ic = it.status === 'running' ? '✅' : it.status === 'ended' ? '⚪' : '🧟';
      const purpose = it.purpose ? escapeHtml(it.purpose) : escapeHtml(String(it.cmd).slice(0, 48));
      return `<div class="row sess"><span class="badge ${m.cls}">${ic}${m.label}</span><span class="sess-proj">${purpose}</span><span class="sess-op">${ageStr(it.ageSec)} · ${it.stop ? escapeHtml(it.stop) : ''}</span></div>`;
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
  const bi = $('budget');
  if (document.activeElement !== bi) bi.value = config.budget5h || '';
}

// 事件
window.pet.onPanelStats(render);
window.pet.onPrice((m) => {
  const el = $('price-src');
  if (!el || !m) return;
  if (m.live) {
    const when = m.ts ? new Date(m.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '缓存';
    el.textContent = `💲 价目：在线 ${m.count} 型号 · ${when} 更新（每24h自动）`;
  } else {
    el.textContent = '💲 价目：内置兜底表（在线源暂不可用）';
  }
});
window.pet.onConfig((cfg) => {
  if (!cfg) return;
  config = { ...config, ...cfg };
  applyConfigUI();
});

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
$('budget').addEventListener('change', (e) => {
  config.budget5h = Number(e.target.value) || 0;
  window.pet.setBudget(config.budget5h);
});

// 视图切换：24h / 日历
document.querySelectorAll('.view-tabs .vt').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.view-tabs .vt').forEach((x) => x.classList.toggle('active', x === b));
    $('view-hours').classList.toggle('hidden', b.dataset.view !== 'hours');
    $('view-cal').classList.toggle('hidden', b.dataset.view !== 'cal');
  })
);

// 悬停看具体数值：24h 柱
$('chart').addEventListener('mouseover', (e) => {
  const bar = e.target.closest('.bar');
  if (bar) $('hours-readout').innerHTML = `${bar.dataset.h}:00 · <b>$${bar.dataset.c}</b>`;
});
$('chart').addEventListener('mouseleave', () => { $('hours-readout').innerHTML = hoursSummary; });

// 悬停看具体数值：日历格子
$('cal').addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.cal-cell');
  if (cell) $('cal-readout').innerHTML = `${cell.dataset.k} · <b>$${cell.dataset.c}</b> · ${cell.dataset.t} tok · ${cell.dataset.m} 轮`;
});
$('cal').addEventListener('mouseleave', () => { $('cal-readout').innerHTML = calSummary; });

// 初始化
(async () => {
  const cfg = await window.pet.getConfig();
  if (cfg) { config = { ...config, ...cfg }; applyConfigUI(); }
  const s = await window.pet.getStats();
  if (s) render(s);
})();
