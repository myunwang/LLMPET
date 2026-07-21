#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CodeWhale hook — run by CodeWhale as: node codewhale-hook.js <Event>
// ─────────────────────────────────────────────────────────────────────────────
//
// Mirrors hook/octopus-hook.js structure but adapted for CodeWhale differences:
//   • 10 registered events, including tool_call_after and mode_change
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
// If the pet server is unreachable or returns an invalid response, emit an
// explicit `ask` decision. Empty stdout can be interpreted as Allow by some
// CodeWhale versions, so fail-open behavior is never used for permissions.
//
// Must be fast and never throw — CodeWhale waits on it.

const http = require('http');
const transport = require('../backend/transport');
const codewhale = require('../providers/codewhale');

const STDIN_READ_TIMEOUT_MS = 300;
const STDIN_MAX_BYTES = 1024 * 1024;

// ── stdin reader (for non-tool_call_before events) ──────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let payload = {};
      try {
        if (!tooLarge) {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) payload = JSON.parse(raw);
        }
      } catch {}
      resolve(payload);
    };
    process.stdin.on('data', (c) => {
      if (tooLarge) return;
      bytes += c.length;
      if (bytes > STDIN_MAX_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        finish();
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, STDIN_READ_TIMEOUT_MS);
  });
}

// ── tool_call_before: build payload from env vars (R2.2) ──────────────────
// W14 (version compatibility): CodeWhale may rename env vars across versions
// (DEEPSEEK_* → CODEWHALE_*). We check both prefixes defensively so the hook
// keeps working even if CodeWhale renames its env vars in a future update.
function readToolCallBeforeEnv() {
  // Try DEEPSEEK_* (current) first, then CODEWHALE_* (future-proofing)
  const env = process.env;
  const sid = env.DEEPSEEK_SESSION_ID || env.CODEWHALE_SESSION_ID || '';
  return {
    session_id: sid,
    workspace: env.DEEPSEEK_WORKSPACE || env.CODEWHALE_WORKSPACE || '',
    mode: env.DEEPSEEK_MODE || env.CODEWHALE_MODE || '',
    model: env.DEEPSEEK_MODEL || env.CODEWHALE_MODEL || '',
    total_tokens: 0,
    tool_name: env.DEEPSEEK_TOOL_NAME || env.CODEWHALE_TOOL_NAME || '',
    tool_input_json: env.DEEPSEEK_TOOL_ARGS || env.CODEWHALE_TOOL_ARGS || '',
  };
}

// ── Permission bridge (Round 3) ────────────────────────────────────────────
// POST tool info to /codewhale-permission and block until the pet responds.
// Returns the parsed decision object, or null if server unreachable / error.
//
// R2.11: timeout=Allow so the server must actively deny before timeout.
// The server's AUTO_CLOSE_MS (480s) handles this.  Our HTTP timeout (590s)
// is a safety net in case the server hangs without responding.
const CW_PERM_HTTP_TIMEOUT_MS = 590 * 1000;
const CW_PERM_RESPONSE_MAX_BYTES = 16 * 1024;
const VALID_DECISIONS = new Set(['allow', 'deny', 'ask']);

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function postCodeWhalePermission(body, callback) {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    callback(value);
  };

  const runtime = transport.readRuntimeConfig();
  if (!runtime) { finish(null); return; }
  const { port, token } = runtime;

  // Parse tool_input_json string (from DEEPSEEK_TOOL_ARGS env var) into an object
  // for the permission endpoint. If parsing fails, send an empty object; the
  // displayed tool name/session still remain available to the user.
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
        [transport.TOKEN_HEADER]: token,
      },
    },
    (res) => {
      // runtime.json is user-writable state. Verify the responding process is
      // actually Octopus before trusting an allow/deny decision.
      if (res.statusCode !== 200 || !transport.headerIsOurs(res)) {
        res.resume();
        finish(null);
        return;
      }
      const chunks = [];
      let bytes = 0;
      let oversized = false;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > CW_PERM_RESPONSE_MAX_BYTES) {
          oversized = true;
          chunks.length = 0;
          return;
        }
        if (!oversized) chunks.push(c);
      });
      res.on('end', () => {
        if (oversized) { finish(null); return; }
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const obj = JSON.parse(raw);
          const decision = obj && typeof obj.decision === 'string'
            ? obj.decision.toLowerCase().trim() : '';
          if (VALID_DECISIONS.has(decision)) {
            finish({ ...obj, decision });
          } else {
            finish(null);
          }
        } catch {
          finish(null);
        }
      });
      res.on('error', () => finish(null));
    }
  );
  req.on('error', () => finish(null));
  req.on('timeout', () => { req.destroy(); finish(null); });
  req.end(payload);
}


function safeAsk(reason) {
  return {
    decision: 'ask',
    reason: reason || 'Octopus is unavailable; use CodeWhale permission prompt',
  };
}

function writeDecision(decision) {
  const safe = decision && VALID_DECISIONS.has(decision.decision)
    ? decision : safeAsk('Invalid Octopus permission response');
  try { process.stdout.write(JSON.stringify(safe) + '\n'); } catch {}
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
  const payload = readToolCallBeforeEnv();
  let body;
  try {
    body = codewhale.parseHookStdin('tool_call_before', payload);
  } catch { body = null; }

  // W14 (version compatibility): if env vars gave no session_id, try reading
  // stdin as a fallback. CodeWhale's current version doesn't write stdin for
  // TCB, but a future version might — this keeps us forward-compatible.
  // Also: if session_id is missing entirely, we cannot safely associate the
  // decision with a session, so explicitly fall back to CodeWhale's own prompt.
  if (!body || !body.session_id) {
    readStdin().then((stdinPayload) => {
      let mergedBody = body;
      if (stdinPayload && typeof stdinPayload.session_id === 'string' && stdinPayload.session_id) {
        // Merge stdin session_id into the env-based payload and re-parse
        const merged = Object.assign({}, payload, stdinPayload);
        try { mergedBody = codewhale.parseHookStdin('tool_call_before', merged); } catch { mergedBody = body; }
      }
      if (!mergedBody || !mergedBody.session_id) {
        writeDecision(safeAsk('Missing CodeWhale session id'));
        process.exit(0);
      }
      proceedWithTcb(mergedBody);
    }).catch(() => {
      writeDecision(safeAsk('Unable to read CodeWhale hook input'));
      process.exit(0);
    });
  } else {
    proceedWithTcb(body);
  }
}

function proceedWithTcb(body) {
  // 1. Fire state update (non-blocking) so the pet shows "working" state.
  //    Don't wait for callback — we need to proceed to permission bridge.
  transport.postState(body);

  // 2. Block on permission bridge — the server parks this connection until
  //    the pet user clicks allow/deny, then returns the decision JSON.
  postCodeWhalePermission(body, (decision) => {
    // Server unreachable, spoofed, oversized, malformed, or timed out → ask.
    // Never emit empty stdout for a permission event because that can fail open.
    writeDecision(decision || safeAsk('Octopus permission service unavailable'));
    process.exit(0);
  });
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
module.exports = { readToolCallBeforeEnv, postCodeWhalePermission, safeAsk, writeDecision, VALID_DECISIONS };