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

// Tools Claude Code may ask permission for but which are pure orchestration —
// auto-allow so the pet never blocks them.
const PASSTHROUGH_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
]);

// Resolve a hair before CC's own 600s hook timeout so a forgotten bubble lets
// CC fall back to its in-terminal prompt instead of hanging.
const AUTO_CLOSE_MS = 8 * 60 * 1000;

// AskUserQuestion (elicitation): Claude Code sends it through the same
// PermissionRequest HTTP hook with tool_input.questions[]. We answer it by
// replying { behavior:"allow", updatedInput:{...toolInput, answers} } where
// answers maps each question text → the chosen option label / custom text.

// Clean the questions for the UI (titles + descriptions per option).
function parseElicitationQuestions(toolInput) {
  const qs = toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  return qs.slice(0, 10).map((q) => {
    if (!q || typeof q !== 'object') return null;
    const question = String(q.question || q.prompt || '').trim();
    if (!question) return null;
    const options = Array.isArray(q.options) ? q.options.slice(0, 12).map((o) => {
      if (typeof o === 'string') return { label: o, description: '' };
      if (o && typeof o === 'object') return { label: String(o.label || '').trim(), description: String(o.description || '').trim() };
      return null;
    }).filter((o) => o && o.label) : [];
    return { header: String(q.header || '').trim(), question, options, multiSelect: q.multiSelect === true };
  }).filter(Boolean);
}

// Build the updatedInput Claude Code applies as the answer.
function buildElicitationUpdatedInput(toolInput, answers) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const norm = {};
  for (const q of questions) {
    if (!q || typeof q.question !== 'string' || !q.question) continue;
    const a = answers && Object.prototype.hasOwnProperty.call(answers, q.question) ? answers[q.question] : undefined;
    if (typeof a === 'string' && a.trim()) norm[q.question] = a.trim();
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

    // Pure orchestration tools → auto-allow.
    if (PASSTHROUGH_TOOLS.has(toolName)) {
      sendPermissionResponse(res, { behavior: 'allow' });
      return;
    }
    // Headless (claude -p) → can't ask a human; auto-deny.
    if (parsed.headless === true) {
      sendPermissionResponse(res, { behavior: 'deny', message: 'Non-interactive session; auto-denied' });
      return;
    }

    const toolInput = parsed.toolInput && typeof parsed.toolInput === 'object' ? parsed.toolInput : {};
    const isElicitation = toolName === 'AskUserQuestion';

    // De-dup retries: if an IDENTICAL request (same session+tool+input) is already
    // pending and unanswered, this is a re-send (not a genuine new ask — Claude Code
    // waits for the answer before issuing the next one). Attach this connection to
    // the existing card instead of spawning a second one; resolveEntry answers all.
    const sig = requestSig(sessionId, toolName, toolInput);
    for (const e of pending.values()) {
      if (e.sig === sig) {
        const dup = { res, closeHandler: null };
        dup.closeHandler = () => { const i = e.dupes.indexOf(dup); if (i >= 0) e.dupes.splice(i, 1); };
        e.dupes.push(dup);
        try { res.on('close', dup.closeHandler); } catch {}
        log('perm', `dup -> ${e.id.slice(0, 8)} ${toolName} (${e.dupes.length} pending copies)`);
        return;
      }
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
      const fb = String(behavior.feedback || '').trim();
      return resolveEntry(entry, 'deny', fb || 'Plan rejected — please revise');
    }
    // "Always allow" suggestion button → allow + persist the rule via updatedPermissions.
    if (typeof behavior === 'string' && behavior.startsWith('suggestion:')) {
      const i = parseInt(behavior.slice('suggestion:'.length), 10);
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
  const SWEEP_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'Stop', 'UserPromptSubmit', 'SessionEnd']);
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

module.exports = { createPermissions, sendPermissionResponse, PASSTHROUGH_TOOLS };
