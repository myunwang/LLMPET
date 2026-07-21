'use strict';

// Permission registry for Claude Code's blocking PermissionRequest HTTP hook.
//
// Claude Code POSTs to /permission and holds the connection open until we write
// a decision. We park the `res`, stamp a permId, surface the pending request to
// the frontend (which renders allow/deny in the pet bubble and calls
// decidePermission(permId, behavior)), then write the byte-exact response CC
// expects:
//   { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {...} } }
//
// Original implementation: park the held-open response, surface the request to
// the frontend, and write the decision back. The pet renders the bubble (no
// separate window). Claude Code only — no Codex/opencode/elicitation variants.

const crypto = require('crypto');
const { SERVER_HEADER, SERVER_ID } = require('./transport');
const { log } = require('./log');

// Tools Claude Code may ask permission for but which are pure orchestration,
// read-only, or low-risk — auto-allow so the pet never blocks them.
const PASSTHROUGH_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
  // 只读工具：读取文件、搜索路径、无副作用的操作
  'Read', 'Glob', 'Grep', 'LS',
  // 低风险工具：网络搜索（不写本地）、内部待办状态
  'WebSearch', 'TodoWrite',
]);

// 条件性放行：工具名 + 输入参数检查，仅在安全条件下自动放行。
// RETURN VALUES:
//   null        → 不做条件判断（走完整权限流程）
//   true        → 自动 allow（条件满足）
//   false       → 自动 deny（条件明确不满足，安全拒绝）
function checkConditionalPassthrough(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};

  if (toolName === 'WebFetch') {
    // WebFetch: 仅允许 HTTP(S) GET 请求；阻止 file:// 或其它协议
    const url = String(input.url || '').trim();
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return true;
    return false; // 非 http(s) URL → 拒绝
  }

  if (toolName === 'Bash') {
    const cmd = String(input.command || '').trim();
    if (!cmd) return null;
    // 只读命令白名单：读取/搜索/日志/状态/时间/环境
    const SAFE_PATTERNS = [
      /^(ls|cat|head|tail|less|wc|pwd|echo|date|whoami|uname|which|type|du|df|env|printenv|arch|hostname)\b/,
      /^(find|grep|rg|ag|fd|locate|tree)\b/,
      /^(git\s+(status|log|diff|show|branch|remote|describe|rev-parse|config|help))\b/,
    ];
    return SAFE_PATTERNS.some((re) => re.test(cmd)) ? true : null;
  }

  return null; // 不属于已知条件性放行类型 → 走正常流程
}

// Resolve a hair before CC's own 600s hook timeout so a forgotten bubble lets
// CC fall back to its in-terminal prompt instead of hanging.
const AUTO_CLOSE_MS = 8 * 60 * 1000;
const MAX_PENDING = 128;
const MAX_DUPES_PER_REQUEST = 8;
const MAX_ANSWER_CHARS = 4096;
const MAX_FEEDBACK_CHARS = 4096;

// AskUserQuestion (elicitation): Claude Code sends it through the same
// PermissionRequest HTTP hook with tool_input.questions[]. We answer it by
// replying { behavior:"allow", updatedInput:{...toolInput, answers} } where
// answers maps each question text → the chosen option label / custom text.

function cleanText(value, max) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function boundedClone(value, depth = 0) {
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => boundedClone(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 48)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
      out[key] = boundedClone(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 4096 ? value.slice(0, 4096) : value;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

// Clean the questions for the UI (titles + descriptions per option).
function parseElicitationQuestions(toolInput) {
  const qs = toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  return qs.slice(0, 10).map((q) => {
    if (!q || typeof q !== 'object') return null;
    const question = cleanText(q.question || q.prompt || '', 1000);
    if (!question) return null;
    const options = Array.isArray(q.options) ? q.options.slice(0, 12).map((o) => {
      if (typeof o === 'string') return { label: cleanText(o, 500), description: '' };
      if (o && typeof o === 'object') return { label: cleanText(o.label || '', 500), description: cleanText(o.description || '', 1000) };
      return null;
    }).filter((o) => o && o.label) : [];
    return { header: cleanText(q.header || '', 200), question, options, multiSelect: q.multiSelect === true };
  }).filter(Boolean);
}

// Build the updatedInput Claude Code applies as the answer.
function buildElicitationUpdatedInput(toolInput, answers) {
  const input = boundedClone(toolInput && typeof toolInput === 'object' ? toolInput : {});
  const questions = Array.isArray(input.questions) ? input.questions.slice(0, 10) : [];
  const norm = Object.create(null);
  for (const q of questions) {
    if (!q || typeof q.question !== 'string' || !q.question) continue;
    const a = answers && Object.prototype.hasOwnProperty.call(answers, q.question) ? answers[q.question] : undefined;
    if (typeof a === 'string' && a.trim()) {
      Object.defineProperty(norm, q.question, { value: cleanText(a, MAX_ANSWER_CHARS), enumerable: true, configurable: true });
    }
  }
  return { ...input, questions, answers: norm };
}

// Identity of a permission request, for collapsing duplicate re-sends. Two genuinely
// separate asks never overlap (CC waits for the answer first), so an identical sig
// while one is still pending == a retry, safe to merge.
function requestSig(sessionId, toolName, toolInput) {
  let inp = '';
  try { inp = JSON.stringify(toolInput); } catch { inp = ''; }
  if (inp.length > 2000) inp = inp.slice(0, 2000);
  return sessionId + '|' + toolName + '|' + inp;
}

function sendPermissionResponse(res, decision) {
  const body = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });
  try {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      [SERVER_HEADER]: SERVER_ID,
    });
    res.end(body);
  } catch {}
}

function createPermissions(options = {}) {
  const onAdded = typeof options.onAdded === 'function' ? options.onAdded : () => {};
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  // shouldDrop() → true when DND/disabled: let CC fall back to its own prompt.
  const shouldDrop = typeof options.shouldDrop === 'function' ? options.shouldDrop : () => false;

  /** @type {Map<string, object>} */
  const pending = new Map();

  function destroy(res) {
    try { res.destroy(); } catch {}
  }

  // Resolve a pending entry: write the decision (or drop), clean up, notify.
  // behavior: 'allow' | 'deny' | 'no-decision'
  function resolveEntry(entry, behavior, message) {
    if (!entry || !pending.has(entry.id)) return false;
    pending.delete(entry.id);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (entry.res && entry.abortHandler) {
      try { entry.res.off('close', entry.abortHandler); } catch {}
    }

    // Build the decision once, then mirror it to the main connection AND any
    // duplicate/retry connections of the SAME request (Claude Code re-sent it —
    // e.g. a second, dead PermissionRequest hook made it retry). One user click
    // therefore answers every copy, so the card can't "reset + ask again".
    let decision = null;
    if (behavior !== 'no-decision') {
      decision = { behavior: behavior === 'deny' ? 'deny' : 'allow' };
      if (behavior === 'deny' && message) decision.message = message;
      if (entry.resolvedSuggestion) decision.updatedPermissions = [entry.resolvedSuggestion];
      if (behavior === 'allow' && entry.isElicitation && entry.resolvedUpdatedInput) {
        decision.updatedInput = entry.resolvedUpdatedInput;
      }
    }
    const writeTo = (res) => {
      if (!res || res.writableEnded || res.destroyed) return;
      if (decision === null) destroy(res); // CC falls back to terminal prompt
      else sendPermissionResponse(res, decision);
    };
    writeTo(entry.res);
    if (Array.isArray(entry.dupes)) {
      for (const d of entry.dupes) {
        try { if (d.res && d.closeHandler) d.res.off('close', d.closeHandler); } catch {}
        writeTo(d.res);
      }
    }
    const dn = entry.dupes && entry.dupes.length ? ` (+${entry.dupes.length} dup)` : '';
    log('perm', `resolve id=${entry.id.slice(0, 8)} ${entry.toolName} -> ${behavior}${dn}${message ? ' (' + message + ')' : ''}`);
    onChange();
    return true;
  }

  // Ingress from the HTTP /permission route. `parsed` is already normalized by
  // server.js: { toolName, toolInput, suggestions, sessionId, agentId, headless }.
  function addPermission(res, parsed) {
    // DND / agent disabled → don't answer; CC shows its own terminal prompt.
    if (shouldDrop()) { destroy(res); return; }

    const toolName = parsed.toolName || 'Unknown';
    const sessionId = parsed.sessionId || 'default';

    // Pure orchestration / read-only / low-risk tools → auto-allow.
    if (PASSTHROUGH_TOOLS.has(toolName)) {
      sendPermissionResponse(res, { behavior: 'allow' });
      return;
    }

    // Conditional passthrough: check tool + input for safe auto-allow/deny.
    const condResult = checkConditionalPassthrough(toolName, parsed.toolInput);
    if (condResult === true) {
      sendPermissionResponse(res, { behavior: 'allow' });
      log('perm', `cond-allow ${toolName} session=${String(sessionId).slice(-6)}`);
      return;
    }
    if (condResult === false) {
      sendPermissionResponse(res, { behavior: 'deny', message: 'Unsafe input for conditional tool' });
      log('perm', `cond-deny ${toolName} session=${String(sessionId).slice(-6)}`);
      return;
    }

    // Headless (claude -p) → can't ask a human; auto-deny.
    if (parsed.headless === true) {
      sendPermissionResponse(res, { behavior: 'deny', message: 'Non-interactive session; auto-denied' });
      log('perm', `headless-deny ${toolName} session=${String(sessionId).slice(-6)}`);
      return;
    }

    const toolInput = boundedClone(parsed.toolInput && typeof parsed.toolInput === 'object' ? parsed.toolInput : {});
    const isElicitation = toolName === 'AskUserQuestion';

    // De-dup retries: if an IDENTICAL request (same session+tool+input) is already
    // pending and unanswered, this is a re-send (not a genuine new ask — Claude Code
    // waits for the answer before issuing the next one). Attach this connection to
    // the existing card instead of spawning a second one; resolveEntry answers all.
    const sig = requestSig(sessionId, toolName, toolInput);
    for (const e of pending.values()) {
      if (e.sig === sig) {
        if (e.dupes.length >= MAX_DUPES_PER_REQUEST) { destroy(res); return; }
        const dup = { res, closeHandler: null };
        dup.closeHandler = () => { const i = e.dupes.indexOf(dup); if (i >= 0) e.dupes.splice(i, 1); };
        e.dupes.push(dup);
        try { res.on('close', dup.closeHandler); } catch {}
        log('perm', `dup -> ${e.id.slice(0, 8)} ${toolName} (${e.dupes.length} pending copies)`);
        return;
      }
    }

    if (pending.size >= MAX_PENDING) {
      destroy(res); // Claude falls back to its native terminal permission prompt.
      log('perm', `queue-full ${toolName} session=${String(sessionId).slice(-6)}`);
      return;
    }

    const entry = {
      id: crypto.randomUUID(),
      res,
      sig,
      dupes: [],
      sessionId,
      toolName,
      toolInput,
      isElicitation,
      questions: isElicitation ? parseElicitationQuestions(toolInput) : null,
      resolvedUpdatedInput: null,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      resolvedSuggestion: null,
      agentId: parsed.agentId || 'claude-code',
      createdAt: Date.now(),
      timer: null,
      abortHandler: null,
    };

    // CC disconnected before deciding → treat as deny.
    entry.abortHandler = () => {
      if (res.writableFinished) return;
      resolveEntry(entry, 'deny', 'Client disconnected');
    };
    try { res.on('close', entry.abortHandler); } catch {}

    entry.timer = setTimeout(() => resolveEntry(entry, 'no-decision', 'auto-close'), AUTO_CLOSE_MS);
    if (entry.timer.unref) entry.timer.unref();

    pending.set(entry.id, entry);
    log('perm', `pending id=${entry.id.slice(0, 8)} ${toolName} session=${String(sessionId).slice(-6)}`);
    try { onAdded(entry); } catch (err) { log('perm', 'onAdded error:', err.message); }
    onChange();
  }

  // Frontend decision:
  //   permission   → decidePermission(permId, 'allow' | 'deny')
  //   elicitation  → decidePermission(permId, { type:'elicitation-submit', answers })
  //                  or 'deny' (Go to Terminal → CC re-asks in the terminal)
  function decide(permId, behavior) {
    const entry = pending.get(permId);
    if (!entry) { log('perm', `decide: no pending id=${String(permId).slice(0, 8)}`); return false; }
    if (entry.isElicitation) {
      if (behavior && typeof behavior === 'object' && behavior.type === 'elicitation-submit') {
        entry.resolvedUpdatedInput = buildElicitationUpdatedInput(entry.toolInput, behavior.answers);
        return resolveEntry(entry, 'allow');
      }
      return resolveEntry(entry, 'deny', 'Answer in terminal');
    }
    // ExitPlanMode: reject with feedback → deny carrying the feedback as the
    // message so Claude revises the plan; approve → allow.
    if (behavior && typeof behavior === 'object' && behavior.type === 'plan-feedback') {
      const fb = cleanText(behavior.feedback || '', MAX_FEEDBACK_CHARS);
      return resolveEntry(entry, 'deny', fb || 'Plan rejected — please revise');
    }
    // "Always allow" suggestion button → allow + persist the rule via updatedPermissions.
    if (typeof behavior === 'string' && behavior.startsWith('suggestion:')) {
      const rawIndex = behavior.slice('suggestion:'.length);
      const i = /^\d{1,3}$/.test(rawIndex) ? Number(rawIndex) : -1;
      const sg = Array.isArray(entry.suggestions) ? entry.suggestions[i] : null;
      if (sg && typeof sg === 'object') {
        entry.resolvedSuggestion = { ...sg, destination: sg.destination || 'localSettings', behavior: sg.behavior || 'allow' };
      }
      return resolveEntry(entry, 'allow');
    }
    return resolveEntry(entry, behavior === 'allow' ? 'allow' : 'deny');
  }

  // When the user clearly answered in the terminal, sweep stale bubbles for that
  // session, so we clear any stale bubbles still open for it.
  const SWEEP_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd']);
  function sweepForSessionEvent(sessionId, event) {
    if (!SWEEP_EVENTS.has(event)) return;
    for (const entry of [...pending.values()]) {
      if (entry.sessionId === sessionId) {
        resolveEntry(entry, 'deny', 'User answered in terminal');
      }
    }
  }

  function getPending() {
    return [...pending.values()].map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      toolName: e.toolName,
      toolInput: e.toolInput,
      suggestions: e.suggestions,
      isElicitation: !!e.isElicitation,
      questions: e.questions || null,
      createdAt: e.createdAt,
    }));
  }

  function hasPendingForSession(sessionId) {
    for (const e of pending.values()) if (e.sessionId === sessionId) return true;
    return false;
  }

  function dropAllForDnd() {
    for (const entry of [...pending.values()]) resolveEntry(entry, 'no-decision', 'dnd');
  }

  function cleanup() {
    for (const entry of [...pending.values()]) resolveEntry(entry, 'deny', 'Pet is quitting');
  }

  return {
    addPermission,
    decide,
    sweepForSessionEvent,
    getPending,
    hasPendingForSession,
    dropAllForDnd,
    cleanup,
    PASSTHROUGH_TOOLS,
  };
}

/**
 * Build a permission.allow rule for Claude Code's settings.json.
 * Returns an object suitable for inserting into `{ permissions: { allow: [...] } }`.
 *
 * @param {string} toolName - e.g. 'Bash', 'Edit', 'Write'
 * @param {object} options
 * @param {string} [options.command] - For Bash: command prefix to match (e.g. 'npm run')
 * @param {boolean} [options.edit] - For Edit/Write: allow all edits (no file pattern filter)
 * @param {string} [options.filePattern] - Glob pattern for files (e.g. 'src/*.ts')
 * @returns {object} settings.json allow rule
 */
function buildAllowRule(toolName, options = {}) {
  const rule = { toolName };
  if (options.command) {
    rule.command = String(options.command).slice(0, 256);
  }
  if (options.edit === true) {
    rule.edit = true;
  }
  if (options.filePattern) {
    rule.filePattern = String(options.filePattern).slice(0, 512);
  }
  return rule;
}

/**
 * Write a persistent allow rule to ~/.claude/settings.json.
 * Creates the file/`permissions.allow` array if absent.  Merges by toolName
 * (replaces an existing rule for the same tool).  Atomic write via tmp+rename.
 *
 * @param {object} rule - output of buildAllowRule()
 * @returns {boolean} true if the rule was written (or already present)
 */
function writeAllowRule(rule) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  let settings;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    if (err.code === 'ENOENT') settings = {};
    else return false;
  }
  if (!settings || typeof settings !== 'object') return false;
  if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  const existing = settings.permissions.allow.findIndex((r) => r && r.toolName === rule.toolName);
  if (existing >= 0) {
    // Already present – skip if identical, update if changed
    const cur = settings.permissions.allow[existing];
    if (JSON.stringify(cur) === JSON.stringify(rule)) return true;
    settings.permissions.allow[existing] = rule;
  } else {
    settings.permissions.allow.push(rule);
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(settingsPath), 0o700); } catch {}
    const tmp = path.join(path.dirname(settingsPath), `.settings.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, settingsPath);
    try { fs.chmodSync(settingsPath, 0o600); } catch {}
    return true;
  } catch {
    return false;
  }
}

module.exports = { createPermissions, sendPermissionResponse, PASSTHROUGH_TOOLS, MAX_PENDING, MAX_DUPES_PER_REQUEST, checkConditionalPassthrough, buildAllowRule, writeAllowRule, _boundedClone: boundedClone, _buildElicitationUpdatedInput: buildElicitationUpdatedInput };
