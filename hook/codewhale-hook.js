#!/usr/bin/env node
'use strict';

// CodeWhale hook — run by the CodeWhale TUI as:
//   node codewhale-hook.js <event>
//
// Verified against CodeWhale's documented hook contract (docs/HOOKS.md and the
// executor source — commit 7d942bd):
//   • 11 lifecycle events exist: session_start, session_end, message_submit,
//     tool_call_before, tool_call_after, turn_end, subagent_spawn,
//     subagent_complete, on_error, mode_change, shell_env. We register the 10
//     lifecycle ones; shell_env is an env injector for exec_shell, not a
//     lifecycle hook. `turn_start` and `error` DO NOT exist.
//   • tool_call_before receives its payload through ENVIRONMENT VARIABLES
//     (DEEPSEEK_TOOL_NAME / DEEPSEEK_TOOL_ARGS / DEEPSEEK_SESSION_ID — the
//     DEEPSEEK_ prefix is retained upstream for compatibility; there is no
//     CODEWHALE_TOOL_NAME). stdin JSON is only provided for message_submit,
//     turn_end, subagent_spawn and subagent_complete.
//   • A tool_call_before hook ANSWERS by printing {decision:"allow"|"deny"|
//     "ask", reason} to stdout and exiting 0. Empty/invalid stdout is treated
//     by CodeWhale as allow (legacy passthrough!), exit 2 is a hard deny, and
//     an unanswered timeout defaults to allow unless the hook is a strict
//     gate. Our installer therefore marks tool_call_before as a strict gate
//     (continue_on_error = false) and this script always answers, failing
//     closed to "ask" (CodeWhale's own prompt) when LLMPET is unreachable.
//
// State events are best-effort fire-and-forget; only tool_call_before blocks.

const http = require('http');
const transport = require('../backend/transport');

// CodeWhale event → (internal Claude-equivalent event, pet state). Same
// mapping vocabulary the Claude hook uses, so core/adapter need no
// CodeWhale-specific paths.
//
// mode_change maps to a synthetic 'ModeChange' event (NOT Claude's
// 'Notification'): the adapter turns Notification/Elicitation into a
// "needs input" card, but a Plan/Work/Operate switch is user-initiated
// context, not a request for attention — a card would be wrong. The brief
// 'attention' oneshot (15s TTL) acknowledges the switch and decays on its own.
const EVENT_MAP = {
  session_start:    { event: 'SessionStart',    state: 'idle' },
  session_end:      { event: 'SessionEnd',      state: 'sleeping' },
  message_submit:   { event: 'UserPromptSubmit', state: 'thinking' },
  tool_call_before: { event: 'PreToolUse',      state: 'working' },
  tool_call_after:  { event: 'PostToolUse',     state: 'working' },
  turn_end:         { event: 'Stop',            state: 'attention' },
  subagent_spawn:   { event: 'SubagentStart',   state: 'juggling' },
  subagent_complete:{ event: 'SubagentStop',    state: 'working' },
  on_error:         { event: 'StopFailure',     state: 'error' },
  mode_change:      { event: 'ModeChange',      state: 'attention' },
};

const ASK = '{"decision":"ask"}\n';
const MAX_STDIN_BYTES = 1024 * 1024;

function envPayload() {
  const e = process.env;
  // Verified env contract: DEEPSEEK_TOOL_NAME/DEEPSEEK_TOOL_ARGS (no
  // CODEWHALE_ spellings exist upstream), session id dual-written under both
  // prefixes.
  let toolInput = {};
  try { toolInput = JSON.parse(e.DEEPSEEK_TOOL_ARGS || '{}'); } catch {}
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) toolInput = {};
  return {
    session_id: e.DEEPSEEK_SESSION_ID || e.CODEWHALE_SESSION_ID || '',
    cwd: e.DEEPSEEK_WORKSPACE || '',
    model: e.DEEPSEEK_MODEL || '',
    tool_name: e.DEEPSEEK_TOOL_NAME || '',
    tool_input: toolInput,
  };
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      let payload = {};
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim()) payload = JSON.parse(raw);
      } catch {}
      resolve(payload && typeof payload === 'object' ? payload : {});
    };
    process.stdin.on('data', (c) => {
      bytes += c.length;
      if (bytes <= MAX_STDIN_BYTES) chunks.push(c);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    // Observer events carry their JSON on stdin; tool_call_before does not.
    // A short timeout keeps malformed callers from hanging the turn. unref so
    // the timer never outlives the work: without it every hook process stayed
    // alive ~300ms after posting state, stacking up across the 10 events a
    // busy turn fires.
    const guard = setTimeout(finish, 300);
    if (guard.unref) guard.unref();
  });
}

function askPermission(body, opts = {}) {
  return new Promise((resolve) => {
    const runtime = transport.readRuntimeConfig();
    if (!runtime) return resolve({ decision: 'ask', reason: 'LLMPET is not running' });
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: runtime.port,
      path: '/codewhale-permission',
      method: 'POST',
      // Under our TOML timeout_secs of 600. Overridable only by tests —
      // production callers never pass opts.
      timeout: opts.timeoutMs || 590000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        [transport.TOKEN_HEADER]: runtime.token,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      if (res.statusCode !== 200 || !transport.headerIsOurs(res)) {
        res.resume();
        return resolve({ decision: 'ask', reason: 'Untrusted LLMPET response' });
      }
      res.on('data', (c) => { size += c.length; if (size <= 16384) chunks.push(c); });
      res.on('end', () => {
        try {
          const out = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const decision = out && out.decision;
          if (decision === 'allow' || decision === 'deny' || decision === 'ask') {
            resolve({ decision, reason: typeof out.reason === 'string' ? out.reason : undefined });
          } else {
            resolve({ decision: 'ask' });
          }
        } catch {
          resolve({ decision: 'ask' });
        }
      });
    });
    req.on('error', (e) => resolve({
      decision: 'ask',
      reason: e && e.code === 'ETIMEDOUT' ? 'LLMPET permission bridge timed out' : 'LLMPET is not running',
    }));
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.end(payload);
  });
}

async function main() {
  const event = process.argv[2];
  const mapped = EVENT_MAP[event];
  if (!mapped) return; // unknown/unregistered event (e.g. shell_env): no-op

  let payload = envPayload();
  // Events with a stdin payload merge it over the env view (stdin is the
  // richer source where it exists).
  const stdin = await readStdin();
  payload = {
    ...payload,
    ...stdin,
    tool_input: payload.tool_name ? payload.tool_input : (stdin.tool_input && typeof stdin.tool_input === 'object' ? stdin.tool_input : payload.tool_input),
  };

  const sessionId = typeof payload.session_id === 'string' && payload.session_id
    ? payload.session_id
    : (typeof stdin.session_id === 'string' ? stdin.session_id : '');
  if (!sessionId) return; // no session identity → nothing to report

  const body = {
    state: mapped.state,
    event: mapped.event,
    session_id: sessionId,
    cwd: typeof (payload.workspace || payload.cwd) === 'string' ? (payload.workspace || payload.cwd) : '',
    model: typeof payload.model === 'string' ? payload.model : null,
    tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : null,
    agent_id: 'codewhale',
  };
  // turn_end carries the authoritative per-turn usage (verified shape); pass
  // it through so the server can ledger it without reading CodeWhale's
  // session files. turn_id dedups hook retries; status guards aborted turns.
  if (event === 'turn_end' && stdin.usage && typeof stdin.usage === 'object') {
    body.usage = stdin.usage;
    body.usage_totals = stdin.totals && typeof stdin.totals === 'object' ? stdin.totals : null;
    if (typeof stdin.turn_id === 'string' && stdin.turn_id) body.turn_id = stdin.turn_id;
    if (typeof stdin.status === 'string' && stdin.status) body.turn_status = stdin.status;
    if (typeof stdin.provider === 'string' && stdin.provider) body.provider = stdin.provider;
  }
  transport.postState(body);

  if (event === 'tool_call_before') {
    const decision = await askPermission({
      session_id: sessionId,
      tool_name: payload.tool_name || 'Unknown',
      tool_input: payload.tool_input || {},
    });
    process.stdout.write(JSON.stringify(decision) + '\n');
  }
}

if (require.main === module) {
  main().catch(() => process.stdout.write(ASK));
}
module.exports = { EVENT_MAP, envPayload, askPermission };
