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

// Valid decision values per R2.2 (hooks.rs:521-603).
const VALID_DECISIONS = new Set(['allow', 'deny', 'ask']);

function createCodeWhalePermissions(options = {}) {
  let onAdded = typeof options.onAdded === 'function' ? options.onAdded : () => {};
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  // shouldDrop() → true when DND/disabled: let CodeWhale handle permission itself.
  const shouldDrop = typeof options.shouldDrop === 'function' ? options.shouldDrop : () => false;

  /** @type {Map<string, object>} */
  const pending = new Map();

  function destroy(res) {
    try { res.destroy(); } catch {}
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
  // decision: 'allow' | 'deny' | 'ask' | null (null → destroy, CW treats as Allow)
  function resolveEntry(entry, decision, reason) {
    if (!entry || !pending.has(entry.id)) return false;
    pending.delete(entry.id);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (entry.res && entry.closeHandler) {
      try { entry.res.off('close', entry.closeHandler); } catch {}
    }

    const writeTo = (res) => {
      if (!res || res.writableEnded || res.destroyed) return;
      if (decision === null) {
        // null = destroy connection → CW treats empty stdout as Allow
        destroy(res);
      } else {
        sendResponse(res, decision, reason || undefined);
      }
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
    // DND / disabled → destroy; CW uses its own permission prompt.
    if (shouldDrop()) { destroy(res); return; }

    const toolName = parsed.toolName || 'Unknown';
    const sessionId = parsed.sessionId || 'default';
    const toolInput = parsed.toolInput && typeof parsed.toolInput === 'object' ? parsed.toolInput : {};

    // De-dup retries: if an IDENTICAL request is already pending, attach this
    // connection to the existing entry (one user click answers all copies).
    const sig = requestSig(sessionId, toolName, toolInput);
    for (const e of pending.values()) {
      if (e.sig === sig) {
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

  // Sweep stale pending entries when a session event arrives that implies the
  // tool already ran or the session ended (same pattern as Claude permission.js).
  const SWEEP_EVENTS = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd']);
  function sweepForSessionEvent(sessionId, event) {
    if (!SWEEP_EVENTS.has(event)) return;
    for (const entry of [...pending.values()]) {
      if (entry.sessionId === sessionId) {
        resolveEntry(entry, 'deny', 'Event superseded');
      }
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
  }

  return {
    addPermission,
    decide,
    sweepForSessionEvent,
    getPending,
    hasPendingForSession,
    dropAllForDnd,
    cleanup,
    // Round 6: allow main.js to wire onAdded after server creates the instance.
    setOnAdded: (fn) => { onAdded = typeof fn === 'function' ? fn : () => {}; },
  };
}

module.exports = { createCodeWhalePermissions };