'use strict';

// Adapter: internal core model  ->  renderer contract.
//
// The frontend (preload README §4) wants a rich pet:stats snapshot and discrete
// pet:event messages. The core model has no todos and a
// different state vocabulary, so this layer:
//   - maps core session states -> the frontend's state words
//   - overlays pending permissions as 'waiting' sessions (+ allow/deny choice)
//   - synthesizes the counts the frontend aggregates on
//   - derives pet:event(s) by diffing the activity stream
// Pricing fields are present-but-zero (deferred: the reference has no pricing);
// a `context` field is added so the supplemented frontend can show context %.

const path = require('path');

const TOOL_ICON = {
  Edit: '📝', MultiEdit: '📝', Write: '📝', NotebookEdit: '📝',
  Read: '📖', Bash: '⚙️', Grep: '🔍', Glob: '🔍',
  WebSearch: '🌐', WebFetch: '🌐', Task: '🤖', Agent: '🤖',
  TodoWrite: '✅',
  // Codex 专属工具（codex-watch 归一化后的词）；exec/apply_patch 等已映射到上面的既有词
  Js: '🧮', Wait: '⏳',
};
const TOOL_LABEL = {
  Edit: '编辑文件', MultiEdit: '编辑文件', Write: '写文件', NotebookEdit: '编辑笔记本',
  Read: '读取文件', Bash: '运行命令', Grep: '搜索代码', Glob: '查找文件',
  WebSearch: '联网搜索', WebFetch: '抓取网页', Task: '派出子 agent', Agent: '派出子 agent',
  TodoWrite: '更新待办',
  Js: '跑 JS 代码', Wait: '等命令输出',
};

// core 的 agentId → 前端的 agent 短词（会话行图标 / 事件路由按这个分流）
function agentOf(entry) {
  return entry && entry.agentId === 'codex' ? 'codex' : 'claude';
}

function toolIcon(tool) { return TOOL_ICON[tool] || '🔧'; }
function toolLabel(tool) { return TOOL_LABEL[tool] || tool || '处理中'; }

// 「最近事件是工具活动」判定——op 标签只该跟着这些事件走
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop']);

// 工具结束后超过这个间隙仍无事件 → 摸鱼中（等下一步）
const LOAF_GAP_MS = 5000;
// transcript 在这个窗口内有写入 = 模型仍在产出（巡检 10s 刷一次 mtime）。
// 长推理时 CC 按内容块落盘，块间隔可达一两分钟——窗口放宽到 150s，
// 「时间在走、token 在涨」的慢长任务不会被误判成摸鱼。
const TRANSCRIPT_ACTIVE_MS = 150 * 1000;

// Friendly bubble text per Claude Code API/server error kind.
function errorMessage(type) {
  switch (type) {
    case 'rate_limit': return '🚦 被限流了，稍等…';
    case 'server_error':
    case 'overloaded_error':
    case 'overloaded':
    case 'api_error': return '🌐 服务器开小差了，正在重试…';
    case 'billing_error': return '💳 账单/额度异常';
    case 'authentication_failed':
    case 'oauth_org_not_allowed': return '🔑 鉴权失败';
    case 'model_not_found': return '🤖 模型不可用';
    case 'max_output_tokens': return '✂️ 输出超长被截断';
    default: return '😵 出了点状况，在想办法…';
  }
}

function projectName(entry) {
  if (entry.sessionTitle) return entry.sessionTitle;
  if (entry.cwd) return path.basename(entry.cwd) || entry.cwd;
  return String(entry.id || '').slice(-6) || '会话';
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Light markdown strip for the speech bubble (so **bold**, `code`, # headings,
// and [links](url) read cleanly instead of showing raw syntax).
function plainText(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')          // code fences
    .replace(/`([^`]+)`/g, '$1')              // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')        // bold
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2') // italic
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // headings
    .replace(/^\s{0,3}[>\-*]\s+/gm, '')       // quote / list markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // links → text
}

// core session state -> frontend state word.
// juggling/sweeping 透传：皮肤有独立素材（cat-juggling/cat-sweeping），折叠成
// working 会让它们永远显示不出来；无素材的皮肤由前端自行回落。
function mapState(state) {
  switch (state) {
    case 'working':
    case 'carrying':
      return 'working';
    case 'juggling':
      return 'juggling';
    case 'sweeping':
      return 'sweeping';
    case 'thinking':
      return 'thinking';
    case 'error':
      return 'error';
    case 'notification':
      return 'needsinput';
    case 'sleeping':
      return 'sleeping';
    case 'attention': // turn just completed — handled by event/badge, sit idle
    case 'idle':
    case 'roam':
    default:
      return 'idle';
  }
}

// Human-readable permission question from the (full) tool_input CC sent us.
function humanizeTool(toolName, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (toolName) {
    case 'Bash':
      return '运行命令：' + clip(i.command || i.cmd || '', 80);
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return '修改文件：' + clip(i.file_path || i.path || i.notebook_path || '', 60);
    case 'Read':
      return '读取文件：' + clip(i.file_path || i.path || '', 60);
    case 'WebFetch':
      return '抓取网页：' + clip(i.url || '', 60);
    case 'WebSearch':
      return '联网搜索：' + clip(i.query || '', 60);
    default:
      return clip(toolName, 40) + ' 需要授权';
  }
}

// Label for a Claude Code permission suggestion ("always allow" / mode switch).
function suggestionLabel(sg) {
  if (!sg || typeof sg !== 'object') return null;
  if (sg.type === 'setMode') {
    return sg.mode === 'plan' ? '🅿️ 切到计划模式'
      : sg.mode === 'acceptEdits' ? '✍️ 自动接受编辑'
      : '设为 ' + clip(sg.mode, 16);
  }
  if (sg.type === 'addRules' || Array.isArray(sg.rules)) {
    const rules = (sg.rules || []).map((r) => (typeof r === 'string' ? r : (r.ruleContent || r.toolName || ''))).filter(Boolean);
    return '🔓 始终允许：' + clip(rules.join(', ') || '此操作', 36);
  }
  return null;
}

function buildPermChoice(perm, entry) {
  const options = [{ label: '✅ 允许', key: 'allow' }];
  const sgs = Array.isArray(perm.suggestions) ? perm.suggestions : [];
  for (let i = 0; i < sgs.length && i < 4; i++) {
    const lbl = suggestionLabel(sgs[i]);
    if (lbl) options.push({ label: lbl, key: 'suggestion:' + i });
  }
  options.push({ label: '⛔ 拒绝', key: 'deny' });
  return {
    kind: 'perm',
    sessionId: perm.sessionId,
    permId: perm.id,
    project: entry ? projectName(entry) : (perm.sessionId || '?'),
    header: perm.toolName,
    question: humanizeTool(perm.toolName, perm.toolInput),
    options,
    multi: false,
    allowInput: false,
  };
}

// ExitPlanMode → show the plan + approve / reject-with-feedback.
function buildPlanChoice(perm, entry) {
  const plan = perm.toolInput && typeof perm.toolInput.plan === 'string' ? perm.toolInput.plan : '';
  return {
    kind: 'plan',
    sessionId: perm.sessionId,
    permId: perm.id,
    project: entry ? projectName(entry) : (perm.sessionId || '?'),
    header: '方案评审',
    question: plan ? clip(plainText(plan), 900) : '请审阅这个方案',
    options: [{ label: '✅ 批准方案', key: 'allow' }],
    allowInput: true, // feedback box for "打回并反馈"
    multi: false,
  };
}

// AskUserQuestion → a rich multi-option card the user can actually answer.
function buildElicitationChoice(perm, entry) {
  const qs = Array.isArray(perm.questions) ? perm.questions : [];
  const single = qs.length === 1 ? qs[0] : null;
  return {
    kind: 'ask',
    sessionId: perm.sessionId,
    permId: perm.id,
    project: entry ? projectName(entry) : (perm.sessionId || '?'),
    header: single ? single.header : 'Needs Input',
    question: single ? single.question : '需要你回答',
    questions: qs, // [{ header, question, options:[{label,description}], multiSelect }]
    options: single ? single.options.map((o) => ({ label: o.label, desc: o.description })) : [],
    multi: false,
    allowInput: true,
  };
}

// "Claude asked something / wants a reply" → read-only context + 去回复 button.
function buildContinueChoice(entry) {
  const who = agentOf(entry) === 'codex' ? 'Codex' : 'Claude';
  return {
    kind: 'continue',
    sessionId: entry.id,
    project: projectName(entry),
    header: '',
    question: entry.assistantLastOutput ? clip(entry.assistantLastOutput, 120) : `${who} 在等你回复`,
    options: [],
    multi: false,
    allowInput: false,
  };
}

// ── pet:stats ───────────────────────────────────────────────────────────────
// `metering` (optional) = { today, window5h, byModel, hourly, daily } from
// backend/metering.js. When absent, pricing fields fall back to zeros.
// `opts.lastOps` (optional) = recent operation ring for the panel op stream.
function buildPetStats(snapshot, pendingPermissions, metering, opts) {
  const permsBySession = new Map();
  for (const p of pendingPermissions || []) {
    if (!permsBySession.has(p.sessionId)) permsBySession.set(p.sessionId, p);
  }

  // NOTE: do NOT dedup by sourcePid — switching/starting a session in the same
  // terminal gives a new session_id with the same pid, and collapsing "newest
  // per pid" would wipe the previous session's record from the panel. Distinct
  // session_ids are distinct sessions; ghosts are handled by stale cleanup
  // (idle→sleep→hidden, dead-pid removal) instead.
  const entries = snapshot.sessions || [];

  const sessions = entries.map((e) => {
    let state = mapState(e.state);
    let reason = null;
    let choice = null;

    // 「上一步干完了、下一步还没来」的间隙：
    //   - transcript 还在长（mtime 新鲜）= 模型在产出（重连后继续跑/流式输出）
    //     → 仍是干活，别误判摸鱼；
    //   - 文件不动才是真没动静 → 摸鱼（loafing），不硬说「思考中」。
    // 只认 PostToolUse/SubagentStop 间隙——PreToolUse 间隙是工具还在跑，仍算干活。
    // 真思考仍有渠道：UserPromptSubmit → thinking 是事件驱动的。
    if (state === 'working'
      && e.lastEvent && (e.lastEvent.rawEvent === 'PostToolUse' || e.lastEvent.rawEvent === 'SubagentStop')
      && e.idleMs > LOAF_GAP_MS) {
      const producing = e.transcriptActiveAt && (Date.now() - e.transcriptActiveAt) < TRANSCRIPT_ACTIVE_MS;
      if (!producing) state = 'loafing';
    }

    const perm = permsBySession.get(e.id);
    if (perm && perm.isElicitation && !e.headless) {
      state = 'needsinput';
      reason = '回复';
      choice = buildElicitationChoice(perm, e);
    } else if (perm && perm.toolName === 'ExitPlanMode' && !e.headless) {
      state = 'needsinput';
      reason = '审方案';
      choice = buildPlanChoice(perm, e);
    } else if (perm && !e.headless) {
      state = 'waiting';
      reason = '授权';
      choice = buildPermChoice(perm, e);
    } else if (e.state === 'notification' && !e.headless) {
      state = 'needsinput';
      reason = '回复';
      choice = buildContinueChoice(e);
    }

    return {
      project: projectName(e),
      agent: agentOf(e),
      state,
      reason,
      idleMs: e.idleMs,
      // op 只在「正在干活」且最近事件确实是工具事件时有效：idle 会话不带旧 op；
      // thinking（刚提交 prompt）也不再显示上一轮遗留的「运行命令」等陈旧标签。
      op: (state === 'working' || state === 'juggling' || state === 'sweeping')
        && e.lastEvent && TOOL_EVENTS.has(e.lastEvent.rawEvent)
        ? toolLabel(e.lastEventTool || '')
        : null,
      sessionId: e.id,
      headless: e.headless,
      badge: e.badge,
      model: e.model || null,
      // context-window usage % (for the session-list HUD badge), null if unknown
      contextPercent: e.contextUsage && typeof e.contextUsage.percent === 'number' ? e.contextUsage.percent : null,
      choice,
      todos: [], // no todo model in the core
    };
  });

  const counted = sessions.filter((s) => !s.headless);
  const waitingCount = counted.filter((s) => s.state === 'waiting').length;
  const needsinputCount = counted.filter((s) => s.state === 'needsinput').length;
  const workingCount = counted.filter((s) => s.state === 'working').length;
  const jugglingCount = counted.filter((s) => s.state === 'juggling').length;
  const sweepingCount = counted.filter((s) => s.state === 'sweeping').length;
  const thinkingCount = counted.filter((s) => s.state === 'thinking').length;
  const loafingCount = counted.filter((s) => s.state === 'loafing').length;
  const errorCount = counted.filter((s) => s.state === 'error').length;

  // Context usage of the active session (supplements the now-pricing-less chips).
  let context = null;
  const active = snapshot.active;
  if (active) {
    const ae = (snapshot.sessions || []).find((e) => e.id === active.sessionId);
    if (ae && ae.contextUsage) {
      context = {
        percent: typeof ae.contextUsage.percent === 'number' ? ae.contextUsage.percent : null,
        used: ae.contextUsage.used || 0,
        limit: ae.contextUsage.limit || null,
      };
    }
  }

  const m = metering || {};
  const today = m.today || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, tokens: 0, cost: 0, messages: 0 };
  // panel.js reads today.messages — metering names it `msgs`.
  const todayOut = {
    input: today.input || 0,
    output: today.output || 0,
    cacheCreate: today.cacheCreate || 0,
    cacheRead: today.cacheRead || 0,
    tokens: today.tokens || 0,
    cost: today.cost || 0,
    messages: today.messages != null ? today.messages : (today.msgs || 0),
  };

  // Header wants a short project label, not the full cwd path.
  let activeOut = snapshot.active;
  if (activeOut && activeOut.project) {
    activeOut = { ...activeOut, project: path.basename(activeOut.project) || activeOut.project };
  }

  return {
    today: todayOut,
    window5h: m.window5h || { tokens: 0, cost: 0, startTs: 0, resetTs: 0 },
    byModel: m.byModel || {},
    lastOps: Array.isArray(opts && opts.lastOps) ? opts.lastOps : [],
    active: activeOut,
    sessions,
    waitingCount,
    needsinputCount,
    workingCount,
    jugglingCount,
    sweepingCount,
    thinkingCount,
    loafingCount,
    errorCount,
    todos: [],
    todosProject: '',
    hourly: m.hourly || new Array(24).fill(0),
    hourlyTok: new Array(24).fill(0),
    daily: m.daily || {},
    lastActivityTs: snapshot.lastActivityTs || 0,
    idleMs: snapshot.idleMs,
    bg: { running: 0, zombie: 0, total: 0, items: [] },
    context, // supplement: { percent, used, limit } | null
    // Codex 套餐配额（5h/周窗口 used%）——Codex 没有逐 token 价目，配额比 $ 更真实
    codexLimits: (opts && opts.codexLimits) || null,
    ts: snapshot.ts,
  };
}

// ── pet:event derivation ──────────────────────────────────────────────────────
// Diff one activity into zero+ discrete events the frontend animates on.
// 每个项目 30 分钟内只欢迎一次：宿主 app（ccd/openloomi）「点击进入会话」
// 可能用一次性目录拉起全新 claude（新 id/新 cwd/无历史/source=startup），
// 与真·新对话在 hook 层面无法区分——频控是最后一道保险。
const GREET_DEBOUNCE_MS = 30 * 60 * 1000;
const lastGreetAt = new Map(); // project -> ts

function activityToEvents(act) {
  const { session, event, isNew, realCompletion, assistantChanged, cwdActive } = act;
  if (!session || session.headless) return []; // background sessions: no bubbles
  const project = projectName(session);
  const out = [];

  switch (event) {
    case 'SessionStart': {
      // 「进入新对话」的判定（用户定义的两种情形，欢迎都延迟到首条 prompt）：
      //  a) 全新会话的创建——首条 prompt 时欢迎；
      //  b) 看板上没有的会话被进入（resume 回来）——桌宠世界里它就是新出现的，
      //     同样欢迎。所以 source 不参与资格判定，只看 isNew。
      // 排除项：
      //  - cwdActive：该项目已有忙碌/近期会话 → 是进入执行中的任务，不是新对话
      //  - toolSpawned：~/.xxx/sessions/<uuid> 一次性目录 → 宿主 app 拉起的入口进程
      // 入口/巡检类会话永远等不到 prompt，自然静默。
      const toolSpawned = /\/\./.test(session.cwd || '');
      session.greetPending = (isNew && !cwdActive && !toolSpawned) ? Date.now() : null;
      break;
    }
    case 'UserPromptSubmit': {
      // 新会话资格预审通过 + 第一条 prompt 在 5 分钟内 + 同项目 30 分钟频控
      // → 此刻才欢迎（弹射上线 2s，随后聚合态自然接管为 thinking）。
      const pendingAt = session.greetPending || 0;
      const recentlyGreeted = (Date.now() - (lastGreetAt.get(project) || 0)) < GREET_DEBOUNCE_MS;
      session.greetPending = null;
      if (pendingAt && Date.now() - pendingAt < 5 * 60 * 1000 && !recentlyGreeted) {
        lastGreetAt.set(project, Date.now());
        out.push({ kind: 'greet', project, ts: Date.now() });
        break; // 欢迎已含「收到任务」之意，不再叠 user-turn（避免短暂态互抢）
      }
      const emo = session.pendingUserEmotion || null;
      out.push({ kind: 'user-turn', project, emotion: emo, ts: Date.now() });
      break;
    }
    case 'PreToolUse': {
      const tool = session.lastEventTool || '';
      out.push({ kind: 'operation', tool, icon: toolIcon(tool), detail: toolLabel(tool), file: '', project, ts: Date.now() });
      break;
    }
    case 'SubagentStart':
      out.push({ kind: 'operation', tool: 'Task', icon: toolIcon('Task'), detail: toolLabel('Task'), file: '', project, ts: Date.now() });
      break;
    case 'PostToolUseFailure':
    case 'StopFailure':
    case 'ApiError': {
      const et = session.errorType || null;
      out.push({ kind: 'error', project, errorType: et, text: errorMessage(et), ts: Date.now() });
      break;
    }
    case 'Stop':
      if (realCompletion) {
        const ops = countRecentOps(session);
        if (ops >= 5) out.push({ kind: 'big-done', project, ops, ts: Date.now() });
        else out.push({ kind: 'turn-done', project, ops, ts: Date.now() });
      }
      if (assistantChanged && session.assistantLastOutput) {
        const emo = session.pendingAssistantEmotion || null;
        out.push({ kind: 'say', text: clip(plainText(session.assistantLastOutput), 280), emotion: emo, project, ts: Date.now() });
      }
      break;
    case 'Notification':
    case 'Elicitation':
      out.push({
        kind: 'needsinput',
        project,
        reason: '回复',
        sessionId: session.id,
        choice: buildContinueChoice({ ...session, id: session.id }),
        ts: Date.now(),
      });
      break;
    default:
      break;
  }
  // 每个事件都带上来源 agent：双宠模式按它把事件路由到对应的桌宠窗口
  const agent = agentOf(session);
  for (const ev of out) ev.agent = agent;
  return out;
}

function countRecentOps(session) {
  const ev = Array.isArray(session.recentEvents) ? session.recentEvents : [];
  let n = 0;
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i];
    if (e.event === 'UserPromptSubmit') break;
    if (e.event === 'PreToolUse' || e.event === 'PostToolUse' || e.event === 'SubagentStart') n++;
  }
  return n;
}

module.exports = {
  buildPetStats,
  activityToEvents,
  agentOf,
  buildPermChoice,
  buildElicitationChoice,
  buildPlanChoice,
  buildContinueChoice,
  projectName,
  mapState,
  toolIcon,
  toolLabel,
  humanizeTool,
};
