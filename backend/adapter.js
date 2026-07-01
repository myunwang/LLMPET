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
};
const TOOL_LABEL = {
  Edit: '编辑文件', MultiEdit: '编辑文件', Write: '写文件', NotebookEdit: '编辑笔记本',
  Read: '读取文件', Bash: '运行命令', Grep: '搜索代码', Glob: '查找文件',
  WebSearch: '联网搜索', WebFetch: '抓取网页', Task: '派出子 agent', Agent: '派出子 agent',
  TodoWrite: '更新待办',
};

function toolIcon(tool) { return TOOL_ICON[tool] || '🔧'; }
function toolLabel(tool) { return TOOL_LABEL[tool] || tool || '处理中'; }

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
function mapState(state) {
  switch (state) {
    case 'working':
    case 'juggling':
    case 'carrying':
    case 'sweeping':
      return 'working';
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
  return {
    kind: 'continue',
    sessionId: entry.id,
    project: projectName(entry),
    header: '',
    question: entry.assistantLastOutput ? clip(entry.assistantLastOutput, 120) : 'Claude 在等你回复',
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
      state,
      reason,
      idleMs: e.idleMs,
      // op 只在「正在干活/思考」时有效，避免 idle 会话仍带着上次的 op
      // 字面量（panel 之前会渲染成「空闲 + 处理中」自相矛盾）。
      op: (state === 'working' || state === 'thinking') && e.lastEvent && e.lastEvent.rawEvent
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
  const thinkingCount = counted.filter((s) => s.state === 'thinking').length;
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
    thinkingCount,
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
    ts: snapshot.ts,
  };
}

// ── pet:event derivation ──────────────────────────────────────────────────────
// Diff one activity into zero+ discrete events the frontend animates on.
function activityToEvents(act) {
  const { session, event, isNew, realCompletion, assistantChanged } = act;
  if (!session || session.headless) return []; // background sessions: no bubbles
  const project = projectName(session);
  const out = [];

  switch (event) {
    case 'SessionStart':
      if (isNew) out.push({ kind: 'greet', project, ts: Date.now() });
      break;
    case 'UserPromptSubmit': {
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
