#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CodeWhale hook — run by CodeWhale as: node codewhale-hook.js <Event>
// ─────────────────────────────────────────────────────────────────────────────
//
// Mirrors hook/octopus-hook.js structure but adapted for CodeWhale differences:
//   • 8 events (session_start/end, message_submit, tool_call_before, turn_end,
//     subagent_spawn/complete, on_error)
//   • tool_call_before: reads ENV VARS (DEEPSEEK_TOOL_*), NOT stdin (R2.2)
//   • All other events: read stdin JSON (same as Claude)
//   • PATH is NOT stripped (R2.5) — no resolveNodeBin needed
//   • Uses codewhale.parseHookStdin for normalization
//
// Round 3: tool_call_before now also does permission bridge:
//   1. POST state to /state (fire-and-forget, pet shows "working")
//   2. POST tool info to /codewhale-permission (BLOCKS until pet user decides)
//   3. Print decision JSON to stdout → CodeWhale reads it
//   4. Exit 0
//
// If the pet server is unreachable, print nothing (CodeWhale treats empty stdout
// as Allow, falling through to its own permission prompt).  This ensures the pet
// never blocks the user when it's not running.
//
// Must be fast and never throw — CodeWhale waits on it.

const http = require('http');
const transport = require('../backend/transport');
const codewhale = require('../providers/codewhale');

const STDIN_READ_TIMEOUT_MS = 300;

// ── stdin reader (for non-tool_call_before events) ──────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let payload = {};
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim()) payload = JSON.parse(raw);
      } catch {}
      resolve(payload);
    };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, STDIN_READ_TIMEOUT_MS);
  });
}

// ── tool_call_before: read stdin JSON (primary) + env vars (fallback) ──────
// R2.2 said "env vars only" but CodeWhale 0.9.0 ALSO sends JSON on stdin with
// session_id, workspace, model, etc. We read stdin FIRST (consistent with
// other events), then supplement with env vars for tool_name/tool_input.
async function readToolCallBeforePayload() {
  // 1. Read stdin JSON (has session_id, workspace, model, etc.)
  const stdinPayload = await readStdin();
  // 2. Read env vars (tool_name, tool_input come from env)
  const envPayload = {
    tool_name: process.env.DEEPSEEK_TOOL_NAME || process.env.CODEWHALE_TOOL_NAME || '',
    tool_input_json: process.env.DEEPSEEK_TOOL_ARGS || process.env.CODEWHALE_TOOL_ARGS || '',
  };
  // Merge: stdin takes priority for session/workspace/model; env for tool info
  return { ...envPayload, ...stdinPayload };
}

// ── Permission bridge (Round 3) ────────────────────────────────────────────
// POST tool info to /codewhale-permission and block until the pet responds.
// Returns the parsed decision object, or null if server unreachable / error.
//
// R2.11: timeout=Allow so the server must actively deny before timeout.
// The server's AUTO_CLOSE_MS (480s) handles this.  Our HTTP timeout (590s)
// is a safety net in case the server hangs without responding.
const CW_PERM_HTTP_TIMEOUT_MS = 590 * 1000;

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function postCodeWhalePermission(body, callback) {
  const port = transport.readRuntimePort();
  if (!port) { callback(null); return; }

  // Parse tool_input_json string (from DEEPSEEK_TOOL_ARGS env var) into an object
  // for the permission endpoint.  If parsing fails, send empty object.
  let toolInput = {};
  if (typeof body.tool_input_json === 'string' && body.tool_input_json.trim()) {
    const parsed = tryParseJson(body.tool_input_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      toolInput = parsed;
    }
  }

  const payload = JSON.stringify({
    tool_name: body.tool_name || '',
    tool_input: toolInput,
    session_id: body.session_id || '',
    workspace: body.cwd || '',
    mode: body.agent_mode || '',
    model: body.model || '',
  });

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/codewhale-permission',
      method: 'POST',
      timeout: CW_PERM_HTTP_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const obj = JSON.parse(raw);
          // Validate: must have a string "decision" field
          if (obj && typeof obj.decision === 'string' && obj.decision) {
            callback(obj);
          } else {
            callback(null);
          }
        } catch {
          callback(null);
        }
      });
    }
  );
  req.on('error', () => callback(null));
  req.on('timeout', () => { req.destroy(); callback(null); });
  req.end(payload);
}

// ── Non-TCB event handler (unchanged from Round 2) ────────────────────────
function handleOtherEvent(event) {
  readStdin().then((payload) => {
    let body;
    try {
      body = codewhale.parseHookStdin(event, payload || {});
    } catch { body = null; }
    if (!body) process.exit(0);
    // Fire state update, then exit
    transport.postState(body, () => process.exit(0));
    setTimeout(() => process.exit(0), 250);
  }).catch(() => process.exit(0));
}

// ── tool_call_before handler (Round 3: permission bridge) ──────────────────
function handleToolCallBefore() {
  readToolCallBeforePayload().then((payload) => {
    let body;
    try {
      body = codewhale.parseHookStdin('tool_call_before', payload);
    } catch { body = null; }
    if (!body) process.exit(0);

    // 1. Fire state update (non-blocking) so the pet shows "working" state.
    //    Don't wait for callback — we need to proceed to permission bridge.
    transport.postState(body);

    // 2. Block on permission bridge — the server parks this connection until
    //    the pet user clicks allow/deny, then returns the decision JSON.
    postCodeWhalePermission(body, (decision) => {
      if (!decision) {
        // Server unreachable or bad response → print nothing.
        // CodeWhale treats empty stdout as Allow (R2.2: "空 stdout → Allow"),
        // so the user sees CodeWhale's own permission prompt.  This is the
        // correct behavior when the pet is not running.
        process.exit(0);
      }
      // Print the decision JSON to stdout for CodeWhale to consume.
      // Valid values: allow, deny, ask (R2.2).
      try {
        process.stdout.write(JSON.stringify(decision) + '\n');
      } catch {}
      process.exit(0);
    });
  }).catch(() => process.exit(0));
}

function main() {
  const event = process.argv[2];
  if (!event || !codewhale.eventToPetState[event]) process.exit(0);

  if (event === 'tool_call_before') {
    handleToolCallBefore();
  } else {
    handleOtherEvent(event);
  }
}

if (require.main === module) main();
module.exports = { readToolCallBeforePayload, postCodeWhalePermission };