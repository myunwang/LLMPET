'use strict';

// Permission holder for CodeWhale's tool_call_before hook (Round 3).
//
// CodeWhale has no blocking HTTP hook like Claude Code. Instead, the
// tool_call_before hook process must:
//   1. POST tool info to /codewhale-permission (this module parks the response)
//   2. Block until the pet user decides (allow/deny)
//   3. The hook then prints the decision JSON to stdout and exits
//
// Response format (CodeWhale TOOL_CALL_BEFORE_DECISION, R2.2):
//   { "decision": "allow"|"deny"|"ask", "reason": "...", ... }
//
// Key differences from Claude's permission.js:
//   - Simpler response format (no hookSpecificOutput wrapper)
//   - No elicitation (AskUserQuestion) — CodeWhale doesn't have it
//   - No suggestions / updatedPermissions — not in CodeWhale's hook protocol
//   - Default deny on auto-close (R2.11: CW timeout folds to Allow, so we
//     must actively decide before CW's timeout; deny is conservative)
//   - Separate pending Map — never mixed with Claude's permission entries
//
// This module has the same interface shape as permission.js so the frontend
// can treat both uniformly when multi-provider UI is wired (Round 6+).

const crypto = require('crypto');
const { SERVER_HEADER, SERVER_ID } = require('./transport');
const { log } = require('./log');

// Auto-close: resolve as deny before CodeWhale's own timeout folds to Allow.
// CW's TOML timeout_secs=600s.  We deny at 480s (8 min) — well before that —
// so the hook gets a real deny instead of the dangerous timeout=Allow.
// (Claude's permission.js uses the same 8 min value.)
const AUTO_CLOSE_MS = 8 * 60 * 1000;
const BATCH_RULE_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING = 128;
const MAX_DUPES_PER_REQUEST = 8;

// Valid decision values per R2.2 (hooks.rs:521-603).
const VALID_DECISIONS = new Set(['allow', 'deny', 'ask']);

// Passthrough tools (same as permission.js): read-only, orchestration, low-risk.
// These never trigger a permission bubble — auto-allow immediately.
const PASSTHROUGH_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
  'Read', 'Glob', 'Grep', 'LS',
  'WebSearch', 'TodoWrite',
]);

// Conditional passthrough: check tool + input for safe auto-allow.
// Reuses the same logic from permission.js so both providers stay in sync.
function checkConditionalPassthrough(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};

  if (toolName === 'WebFetch') {
    const url = String(input.url || '').trim();
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return true;
    return false;
  }

  if (toolName === 'Bash') {
    const cmd = String(input.command || '').trim();
    if (!cmd) return null;
    const SAFE_PATTERNS = [
      /^(ls|cat|head|tail|less|wc|pwd|echo|date|whoami|uname|which|type|du|df|env|printenv|arch|hostname)\b/,
      /^(find|grep|rg|ag|fd|locate|tree)\b/,
      /^(git\s+(status|log|diff|show|branch|remote|describe|rev-parse|config|help))\b/,
    ];
    return SAFE_PATTERNS.some((re) => re.test(cmd)) ? true : null;
  }

  return null;
}

function createCodeWhalePermissions(options = {}) {
  let onAdded = typeof options.onAdded === 'function' ? options.onAdded : () => {};
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  // shouldDrop() → true when DND/disabled: let CodeWhale handle permission itself.
  const shouldDrop = typeof options.shouldDrop === 'function' ? options.shouldDrop : () => false;
  // W12: onResolved(entry, decision) — fired when a permission is resolved
  // (by user click, auto-close, disconnect, or batch). Lets main.js notify the
  // pet UI to dismiss the ask panel and clear the 'waiting' state.
  let onResolved = typeof options.onResolved === 'function' ? options.onResolved : () => {};

  /** @type {Map<string, object>} */
  const pending = new Map();

  // Batch authorization rules are deliberately SESSION-SCOPED and time-limited.
  // A previous implementation kept `allow tool always` globally for the whole
  // Octopus process, which could silently authorize the same tool in unrelated
  // workspaces/sessions. Values are expiry timestamps, refreshed on use.
  const allowAllSession = new Map();             // Map<sessionId, expiresAt>
  const allowToolForSession = new Map();         // Map<sessionId, Map<toolName, expiresAt>>

  function nowMs() {
    return typeof options.now === 'function' ? Number(options.now()) : Date.now();
  }

  function liveExpiry(expiresAt) {
    return Number.isFinite(expiresAt) && expiresAt > nowMs();
  }

  function pruneBatchRules() {
    for (const [sid, exp] of allowAllSession) if (!liveExpiry(exp)) allowAllSession.delete(sid);
    for (const [sid, tools] of allowToolForSession) {
      for (const [tool, exp] of tools) if (!liveExpiry(exp)) tools.delete(tool);
      if (tools.size === 0) allowToolForSession.delete(sid);
    }
  }

  function refreshExpiry() { return nowMs() + BATCH_RULE_TTL_MS; }

  // Check if a request matches an auto-allow rule. Returns 'allow' or null.
  function checkAutoAllow(sessionId, toolName) {
    pruneBatchRules();
    const allExp = sessionId && allowAllSession.get(sessionId);
    if (liveExpiry(allExp)) {
      allowAllSession.set(sessionId, refreshExpiry());
      return 'allow';
    }
    const tools = sessionId && allowToolForSession.get(sessionId);
    const toolExp = tools && toolName && tools.get(toolName);
    if (liveExpiry(toolExp)) {
      tools.set(toolName, refreshExpiry());
      return 'allow';
    }
    return null;
  }

  // Send CodeWhale-format decision JSON to the held-open HTTP response.
  function sendResponse(res, decision, reason) {
    const obj = { decision };
    if (reason) obj.reason = reason;
    const body = JSON.stringify(obj);
    try {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        [SERVER_HEADER]: SERVER_ID,
      });
      res.end(body);
    } catch {}
  }

  // Resolve a pending entry: write the decision, clean up, notify.
  // The bridge never uses an empty/destroyed response as a decision because
  // CodeWhale may interpret that fail-open. Unknown conditions fall back to ask.
  function resolveEntry(entry, decision, reason) {
    if (!entry || !pending.has(entry.id)) return false;
    pending.delete(entry.id);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (entry.res && entry.closeHandler) {
      try { entry.res.off('close', entry.closeHandler); } catch {}
    }

    const writeTo = (res) => {
      if (!res || res.writableEnded || res.destroyed) return;
      const safeDecision = VALID_DECISIONS.has(decision) ? decision : 'ask';
      sendResponse(res, safeDecision, reason || undefined);
    };
    writeTo(entry.res);
    // Handle duplicate/retry connections (same pattern as Claude permission.js)
    if (Array.isArray(entry.dupes)) {
      for (const d of entry.dupes) {
        try { if (d.res && d.closeHandler) d.res.off('close', d.closeHandler); } catch {}
        writeTo(d.res);
      }
    }
    const dn = entry.dupes && entry.dupes.length ? ` (+${entry.dupes.length} dup)` : '';
    log('cw-perm', `resolve id=${entry.id.slice(0, 8)} ${entry.toolName} -> ${decision}${dn}${reason ? ' (' + reason + ')' : ''}`);
    // W12: notify main.js so it can tell the pet UI to dismiss the ask panel.
    try { onResolved({ id: entry.id, sessionId: entry.sessionId, toolName: entry.toolName }, decision); } catch (e) { log('cw-perm', 'onResolved error:', e.message); }
    onChange();
    return true;
  }

  // Signature for de-dup: identical session+tool+input while one is pending = retry.
  function requestSig(sessionId, toolName, toolInput) {
    let inp = '';
    try { inp = JSON.stringify(toolInput); } catch { inp = ''; }
    if (inp.length > 2000) inp = inp.slice(0, 2000);
    return sessionId + '|' + toolName + '|' + inp;
  }

  // Ingress from the HTTP /codewhale-permission route.
  // parsed: { toolName, toolInput, sessionId, agentId?, mode?, model?, workspace? }
  function addPermission(res, parsed) {
    // DND / disabled → explicitly ask CodeWhale to use its own prompt. Never
    // drop the connection: an empty hook result can be interpreted as Allow.
    if (shouldDrop()) {
      sendResponse(res, 'ask', 'Octopus permission UI unavailable');
      return;
    }

    const toolName = parsed.toolName || 'Unknown';
    const sessionId = parsed.sessionId || 'default';
    const toolInput = parsed.toolInput && typeof parsed.toolInput === 'object' ? parsed.toolInput : {};

    // Passthrough tools (read-only/orchestration) → auto-allow, no bubble.
    if (PASSTHROUGH_TOOLS.has(toolName)) {
      sendResponse(res, 'allow');
      log('cw-perm', `passthrough ${toolName} session=${String(sessionId).slice(-6)}`);
      return;
    }

    // Conditional passthrough: check tool + input for safe auto-allow/deny.
    const condResult = checkConditionalPassthrough(toolName, toolInput);
    if (condResult === true) {
      sendResponse(res, 'allow');
      log('cw-perm', `cond-allow ${toolName} session=${String(sessionId).slice(-6)}`);
      return;
    }
    if (condResult === false) {
      sendResponse(res, 'deny', 'Unsafe input for conditional tool');
      log('cw-perm', `cond-deny ${toolName} session=${String(sessionId).slice(-6)}`);
      return;
    }

    // W11: auto-allow check — if a batch rule matches, respond immediately
    // without showing a permission bubble. This is the key to "不再一个一个点".
    const autoDecision = checkAutoAllow(sessionId, toolName);
    if (autoDecision) {
      sendResponse(res, autoDecision);
      log('cw-perm', `auto-${autoDecision} ${toolName} session=${String(sessionId).slice(-6)} (batch rule)`);
      return;
    }

    // Bound the local queue so a buggy hook storm cannot hold unlimited HTTP
    // responses/timers. Falling back to `ask` preserves the user's native gate.
    if (pending.size >= MAX_PENDING) {
      sendResponse(res, 'ask', 'Octopus permission queue is full');
      log('cw-perm', `queue-full ${toolName} session=${String(sessionId).slice(-6)}`);
      return;
    }

    // De-dup retries: if an IDENTICAL request is already pending, attach this
    // connection to the existing entry (one user click answers all copies).
    const sig = requestSig(sessionId, toolName, toolInput);
    for (const e of pending.values()) {
      if (e.sig === sig) {
        if (e.dupes.length >= MAX_DUPES_PER_REQUEST) {
          sendResponse(res, 'ask', 'Too many duplicate permission requests');
          return;
        }
        const dup = { res, closeHandler: null };
        dup.closeHandler = () => { const i = e.dupes.indexOf(dup); if (i >= 0) e.dupes.splice(i, 1); };
        e.dupes.push(dup);
        try { res.on('close', dup.closeHandler); } catch {}
        log('cw-perm', `dup -> ${e.id.slice(0, 8)} ${toolName} (${e.dupes.length} pending copies)`);
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
      agentId: parsed.agentId || 'codewhale',
      mode: parsed.mode || null,
      model: parsed.model || null,
      workspace: parsed.workspace || null,
      createdAt: Date.now(),
      timer: null,
      closeHandler: null,
    };

    // Client disconnected before deciding → deny (R2.11: must actively deny).
    entry.closeHandler = () => {
      if (res.writableFinished) return;
      resolveEntry(entry, 'deny', 'Client disconnected');
    };
    try { res.on('close', entry.closeHandler); } catch {}

    // Auto-close: deny well before CW's timeout=Allow (R2.11).
    entry.timer = setTimeout(() => resolveEntry(entry, 'deny', 'Auto-denied: pet timeout'), AUTO_CLOSE_MS);
    if (entry.timer.unref) entry.timer.unref();

    pending.set(entry.id, entry);
    log('cw-perm', `pending id=${entry.id.slice(0, 8)} ${toolName} session=${String(sessionId).slice(-6)} mode=${entry.mode || '?'}`);
    try { onAdded(entry); } catch (err) { log('cw-perm', 'onAdded error:', err.message); }
    onChange();
  }

  // Frontend decision call.
  // behavior: 'allow' | 'deny' | 'ask'
  function decide(permId, behavior) {
    const entry = pending.get(permId);
    if (!entry) {
      log('cw-perm', `decide: no pending id=${String(permId).slice(0, 8)}`);
      return false;
    }
    const d = String(behavior || '').toLowerCase().trim();
    if (!VALID_DECISIONS.has(d)) {
      log('cw-perm', `decide: invalid behavior "${behavior}" for id=${entry.id.slice(0, 8)}`);
      return false;
    }
    return resolveEntry(entry, d);
  }

  // Batch authorization — resolve the current entry AND set a short-lived,
  // session-scoped rule. `tool` means this tool in THIS session, not globally.
  // This keeps the convenience while preventing cross-project privilege bleed.
  function decideBatch(permId, mode) {
    const entry = pending.get(permId);
    if (!entry || (mode !== 'session' && mode !== 'tool')) return false;
    const expiry = refreshExpiry();
    if (mode === 'session') {
      allowAllSession.set(entry.sessionId, expiry);
      log('cw-perm', `batch: allow-all-session ${String(entry.sessionId).slice(-6)} ttl=${BATCH_RULE_TTL_MS}`);
    } else {
      let tools = allowToolForSession.get(entry.sessionId);
      if (!tools) { tools = new Map(); allowToolForSession.set(entry.sessionId, tools); }
      tools.set(entry.toolName, expiry);
      log('cw-perm', `batch: allow-tool-session ${entry.toolName} session=${String(entry.sessionId).slice(-6)} ttl=${BATCH_RULE_TTL_MS}`);
    }
    // One click also clears matching requests already waiting in the same scope.
    for (const e of [...pending.values()]) {
      if (e.id === entry.id || e.sessionId !== entry.sessionId) continue;
      const matches = mode === 'session' || e.toolName === entry.toolName;
      if (matches) resolveEntry(e, 'allow', 'batch');
    }
    return resolveEntry(entry, 'allow');
  }

  // Clear batch rules. A sessionId limits the operation to that session.
  function clearBatchRules(mode, sessionId) {
    const normalized = mode === 'session' || mode === 'tool' ? mode : 'all';
    if (normalized === 'session' || normalized === 'all') {
      if (sessionId) allowAllSession.delete(sessionId);
      else allowAllSession.clear();
    }
    if (normalized === 'tool' || normalized === 'all') {
      if (sessionId) allowToolForSession.delete(sessionId);
      else allowToolForSession.clear();
    }
  }

  // Sweep stale pending entries when a session event arrives that implies the
  // tool already ran or the session ended (same pattern as Claude permission.js).
  // W22: added PostToolUse (tool_call_after) — if a tool completes, its pending
  // permission is stale and should be denied (the tool already ran, possibly
  // because the user answered in the CW terminal or CW auto-approved).
  const SWEEP_EVENTS = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd', 'PostToolUse']);
  function sweepForSessionEvent(sessionId, event) {
    if (!SWEEP_EVENTS.has(event)) return;
    for (const entry of [...pending.values()]) {
      if (entry.sessionId === sessionId) {
        resolveEntry(entry, 'deny', 'Event superseded');
      }
    }
    // W11: when a session ends, clear its batch auto-allow rule so a future
    // session with the same ID (unlikely but possible) doesn't inherit it.
    if (event === 'SessionEnd' && sessionId) {
      allowAllSession.delete(sessionId);
      allowToolForSession.delete(sessionId);
    }
  }

  function getPending() {
    return [...pending.values()].map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      toolName: e.toolName,
      toolInput: e.toolInput,
      agentId: e.agentId,
      mode: e.mode,
      model: e.model,
      workspace: e.workspace,
      createdAt: e.createdAt,
    }));
  }

  function hasPendingForSession(sessionId) {
    for (const e of pending.values()) if (e.sessionId === sessionId) return true;
    return false;
  }

  function dropAllForDnd() {
    for (const entry of [...pending.values()]) resolveEntry(entry, 'deny', 'dnd');
  }

  function cleanup() {
    for (const entry of [...pending.values()]) resolveEntry(entry, 'deny', 'Pet is quitting');
    clearBatchRules('all');
  }

  return {
    addPermission,
    decide,
    decideBatch,
    clearBatchRules,
    sweepForSessionEvent,
    getPending,
    hasPendingForSession,
    dropAllForDnd,
    cleanup,
    // Round 6: allow main.js to wire onAdded after server creates the instance.
    setOnAdded: (fn) => { onAdded = typeof fn === 'function' ? fn : () => {}; },
    // W12: allow main.js to wire onResolved after server creates the instance.
    setOnResolved: (fn) => { onResolved = typeof fn === 'function' ? fn : () => {}; },
    // Test/diagnostic visibility without exposing mutable rule collections.
    getBatchRuleCounts: () => { pruneBatchRules(); return { sessions: allowAllSession.size, toolSessions: allowToolForSession.size }; },
  };
}

module.exports = { createCodeWhalePermissions };