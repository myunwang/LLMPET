'use strict';

// Permission holder for CodeWhale's tool_call_before bridge.
//
// CodeWhale's hook process POSTs the tool call here and parks until the user
// answers the pet bubble (or a timeout). The hook then prints our decision to
// its stdout. Verified upstream semantics that drive the design:
//
//   • An unanswered CodeWhale hook timeout defaults to ALLOW (legacy
//     passthrough). We must therefore ALWAYS answer before the TOML
//     timeout_secs (600s): at 8 minutes an undecided request is answered
//     "deny" — fail closed, never silently allowed.
//   • The response body is {decision:"allow"|"deny"|"ask", reason?}. Unknown
//     decision values degrade to "ask" (CodeWhale's own prompt), and the
//     reason is only surfaced for deny.
//   • tool_input arrives from a size-capped env var upstream, but the HTTP
//     body is ours to bound: requests over 1 MiB are rejected by the server
//     route, and pending entries are capped so a runaway agent cannot park
//     unbounded connections.

const crypto = require('crypto');
const { SERVER_HEADER, SERVER_ID } = require('./transport');
const { isSafeReadOnlyCommand } = require('./command-safety');

const AUTO_DENY_MS = 8 * 60 * 1000;      // under the 600s TOML timeout
const MAX_PENDING = 64;                  // overflow → immediate ask (fail closed)
const MAX_REASONS_CHARS = 2000;          // CodeWhale truncates reasons to 2000

function createCodeWhalePermissions(options = {}) {
  const pending = new Map();
  const notify = typeof options.onChange === 'function' ? options.onChange : () => {};
  // Test seam: shrink the fail-closed window so tests don't wait real
  // minutes. Production callers omit it and get AUTO_DENY_MS (8 min, under
  // the 600s TOML gate timeout). Before this was honored, the permission
  // pool test alone silently cost 8 wall-clock minutes.
  const autoDenyMs = Number.isFinite(options.autoDenyMs) && options.autoDenyMs > 0
    ? options.autoDenyMs
    : AUTO_DENY_MS;

  function send(res, decision, reason) {
    if (!res || res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(
      reason ? { decision, reason: String(reason).slice(0, MAX_REASONS_CHARS) } : { decision },
    );
    try {
      res.writeHead(200, { 'Content-Type': 'application/json', [SERVER_HEADER]: SERVER_ID });
      res.end(body);
    } catch {}
  }

  function addPermission(res, parsed) {
    const toolName = String(parsed.toolName || 'Unknown');
    const toolInput = parsed.toolInput && typeof parsed.toolInput === 'object' ? parsed.toolInput : {};
    // Same fail-closed recognizer as the Claude PreToolUse gate: a single
    // verified read-only command never bothers the user. CodeWhale's shell
    // tool is `exec_shell` with the command in tool_input.command (verified
    // against the upstream permission-rule docs) — the Claude-era 'Bash'
    // spelling never arrives on this route and would have made the
    // auto-allow dead code, prompting for every read-only command.
    if (toolName === 'exec_shell' && isSafeReadOnlyCommand(toolInput.command)) {
      send(res, 'allow');
      return;
    }
    if (pending.size >= MAX_PENDING) {
      send(res, 'ask', 'LLMPET permission queue is full');
      return;
    }
    const id = `cw-${crypto.randomBytes(12).toString('hex')}`;
    const entry = {
      id,
      agentId: 'codewhale',
      sessionId: String(parsed.sessionId || ''),
      toolName,
      toolInput,
      suggestions: [],
      isElicitation: false,
      questions: null,
      createdAt: Date.now(),
      // When the fail-closed auto-deny fires — surfaced on the card so the
      // user knows an unanswered request won't wait forever.
      expiresAt: Date.now() + autoDenyMs,
      res,
    };
    entry.timer = setTimeout(() => decide(id, 'deny', 'Timed out waiting for a decision'), autoDenyMs);
    entry.timer.unref?.();
    // The TUI gave up (user ctrl-C'd the turn, hook timeout…) → drop silently.
    res.on('close', () => {
      if (!res.writableEnded && pending.has(id)) {
        pending.delete(id);
        clearTimeout(entry.timer);
        notify();
      }
    });
    pending.set(id, entry);
    notify();
    if (typeof options.onAdded === 'function') options.onAdded(entry);
  }

  function decide(id, behavior, reason) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    const decision = behavior === 'allow' ? 'allow' : behavior === 'deny' ? 'deny' : 'ask';
    send(entry.res, decision, decision === 'deny' ? (reason || 'Denied in LLMPET') : reason);
    notify();
    return true;
  }

  function getPending() {
    return [...pending.values()].map(({ res, timer, ...entry }) => entry);
  }

  // Session-level sweep: when a CodeWhale session ends, its parked requests
  // are moot — hand them back to CodeWhale's own prompt instead of holding
  // connections for the full 8 minutes.
  function sweepForSession(sessionId, behavior = 'ask') {
    for (const entry of [...pending.values()]) {
      if (entry.sessionId === sessionId) decide(entry.id, behavior, 'Session ended');
    }
  }

  function cleanup() {
    for (const id of [...pending.keys()]) decide(id, 'deny', 'Pet is quitting');
  }

  return { addPermission, decide, getPending, sweepForSession, cleanup };
}

module.exports = { createCodeWhalePermissions, AUTO_DENY_MS, MAX_PENDING };
