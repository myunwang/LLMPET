'use strict';

// Local HTTP server: GET /state (health), POST /state (hook ingest),
// POST /permission (blocking permission hook).
//
// Port discovery, the runtime file, and the server identity header all come from
// backend/transport.js (our own). The /state body fields are Claude Code's hook
// payload (a data interface); every value is normalized/validated before use.

const http = require('http');
const path = require('path');
const {
  SERVER_HEADER,
  SERVER_ID,
  BASE_PORT,
  getPortCandidates,
  readRuntimePort,
  writeRuntimeConfig,
  clearRuntimeConfig,
} = require('./transport');
const { log } = require('./log');

// A Stop event carries the assistant's last reply (up to ~2200 chars). In CJK
// that is ~3 bytes/char ≈ 6.6KB, so a 4KB cap silently 413-dropped the whole
// Stop for long Chinese replies (completion state + 💬 bubble lost). 16KB clears
// the worst case with headroom; everything else in the body is small.
const MAX_STATE_BODY_BYTES = 16 * 1024;
const MAX_PERMISSION_BODY_BYTES = 1024 * 1024; // tool_input can be large
const ASSISTANT_LAST_OUTPUT_MAX = 2400;

// ── input normalizers (faithful to server-route-state.js, Claude subset) ──────
function normNum(v) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}
function normHwnd(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!/^[1-9]\d{0,18}$/.test(t)) return null;
  try { return BigInt(t) <= 9223372036854775807n ? t : null; } catch { return null; }
}
function normTmuxSocket(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 4096 || /[\0\r\n]/.test(t)) return null;
  if (t.startsWith('/')) return t;
  return t !== 'default' && /^[\w.-]{1,64}$/.test(t) ? t : null;
}
function normTmuxClient(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 256 || t.startsWith('-')) return null;
  return /^[\w./:-]+$/.test(t) ? t : null;
}
function normTerminalApp(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return /^[a-z0-9._-]{1,64}$/.test(t) ? t : null;
}
function normTerminalTty(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return /^(?:\/dev\/)?tty[\w.-]{1,80}$/.test(t) ? t : null;
}
function normAssistant(v) {
  if (typeof v !== 'string') return null;
  const t = v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (!t) return null;
  return t.length > ASSISTANT_LAST_OUTPUT_MAX ? t.slice(0, ASSISTANT_LAST_OUTPUT_MAX) : t;
}
function normContext(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const used = Number(v.used);
  if (!Number.isFinite(used) || used < 0) return null;
  const out = { used };
  const limit = Number(v.limit);
  if (Number.isFinite(limit) && limit > 0) out.limit = limit;
  const percent = Number(v.percent);
  if (Number.isFinite(percent)) out.percent = Math.max(0, Math.min(100, Math.round(percent)));
  else if (out.limit) out.percent = Math.max(0, Math.min(100, Math.round((used / out.limit) * 100)));
  if (v.source === 'claude' || v.source === 'codex') out.source = v.source;
  return out;
}

// Shallow-deep truncate tool_input so a giant payload can't blow up memory/IPC.
function truncateInput(value, depth = 0) {
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((x) => truncateInput(x, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 48)) out[k] = truncateInput(value[k], depth + 1);
    return out;
  }
  if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) + '…' : value;
  return value;
}

function isLoopback(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Defense against DNS-rebinding: even when the TCP peer is loopback, a rebound
// page reaches us with Host = attacker.com. Only accept loopback Host values.
function hostAllowed(req) {
  const host = String((req.headers && req.headers.host) || '').toLowerCase();
  if (!host) return true; // some node clients omit Host on a raw socket
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

// Our node hook never sets Origin/Referer; a browser fetch/XHR always attaches
// Origin on cross-origin (and Referer on same-origin) requests. Reject any
// request that carries one → blocks CSRF from a page the user is visiting.
function fromBrowser(req) {
  return !!(req.headers && (req.headers.origin || req.headers.referer));
}

// transcript_path is Claude Code's real path for the session's JSONL. Accept it
// verbatim (so we never re-derive the encoded dir wrongly) after a light sanity
// check: absolute, .jsonl, no control bytes.
function normTranscriptPath(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 4096 || /[\0\r\n]/.test(t)) return null;
  if (!t.endsWith('.jsonl') || !path.isAbsolute(t)) return null;
  return t;
}

function readBody(req, cap, onDone) {
  // Collect raw Buffers and decode ONCE at the end. `body += chunk` decoded each
  // TCP chunk on its own, so a multi-byte UTF-8 char split across a packet
  // boundary (common for CJK past ~1.4KB) became U+FFFD — corrupting assistant
  // bubbles and the AskUserQuestion round-trip. Cap still counts bytes.
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on('data', (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > cap) { tooLarge = true; return; }
    chunks.push(chunk);
  });
  req.on('end', () => onDone(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => onDone(null));
}

function createServer(deps) {
  const core = deps.core;
  const permissions = deps.permissions;
  const shouldDropForDnd = typeof deps.shouldDropForDnd === 'function' ? deps.shouldDropForDnd : () => false;

  let server = null;
  let activePort = null;

  function handleStatePost(req, res) {
    readBody(req, MAX_STATE_BODY_BYTES, (body) => {
      if (body === null) { res.writeHead(413); res.end('state payload too large'); return; }
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }

      const state = data.state;
      const event = data.event;
      // No session_id → reject. Defaulting to 'default' forged a ghost session
      // named "efault" and cross-wired state between real sessions. The hook
      // already drops these; this closes the same hole on the server side.
      const sid = typeof data.session_id === 'string' && data.session_id ? data.session_id : null;
      if (!sid) { res.writeHead(400); res.end('missing session_id'); return; }
      if (!core.VALID_STATES.has(state)) { res.writeHead(400); res.end('unknown state'); return; }

      // DND: accept (so the hook gets a fast 200) but the renderer suppresses noise.
      const fields = {
        toolName: typeof data.tool_name === 'string' && data.tool_name ? data.tool_name : null,
        cwd: typeof data.cwd === 'string' ? data.cwd : null,
        editor: data.editor === 'code' || data.editor === 'cursor' ? data.editor : null,
        sourcePid: normNum(data.source_pid),
        wtHwnd: normHwnd(data.wt_hwnd ?? data.wtHwnd),
        pidChain: Array.isArray(data.pid_chain) ? data.pid_chain.filter((n) => Number.isFinite(n) && n > 0) : null,
        tmuxSocket: normTmuxSocket(data.tmux_socket),
        tmuxClient: normTmuxClient(data.tmux_client),
        terminalApp: normTerminalApp(data.terminal_app),
        terminalTty: normTerminalTty(data.terminal_tty),
        ghosttyTerminalId: typeof data.ghostty_terminal_id === 'string' && data.ghostty_terminal_id.trim() ? data.ghostty_terminal_id.trim() : null,
        agentId: 'claude-code',
        headless: data.headless === true,
        externalResume: data.external_resume === true,
        transcriptPath: normTranscriptPath(data.transcript_path),
        model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : null,
        sessionTitle: typeof data.session_title === 'string' && data.session_title.trim() ? data.session_title.trim() : null,
        sessionSource: typeof data.session_source === 'string' && /^[a-z]{1,16}$/.test(data.session_source) ? data.session_source : null,
        contextUsage: normContext(data.context_usage),
        assistantLastOutput: normAssistant(data.assistant_last_output),
        assistantLastOutputTruncated: data.assistant_last_output_truncated === true,
        preserveState: data.preserve_state === true,
        errorType: typeof data.api_error_type === 'string' && data.api_error_type.trim() ? data.api_error_type.trim() : null,
        userEmotion: typeof data.user_emotion === 'string' && data.user_emotion.trim() ? data.user_emotion.trim() : null,
        assistantEmotion: typeof data.assistant_emotion === 'string' && data.assistant_emotion.trim() ? data.assistant_emotion.trim() : null,
        backgroundTasksCount: Number.isFinite(data.background_tasks_count) ? data.background_tasks_count : 0,
        sessionCronsCount: Number.isFinite(data.session_crons_count) ? data.session_crons_count : 0,
        stopHookActive: data.stop_hook_active === true,
      };

      // The user clearly answered in the terminal → clear stale permission bubbles.
      permissions.sweepForSessionEvent(sid, event);

      core.updateSession(sid, state, event, fields);
      res.writeHead(200, { [SERVER_HEADER]: SERVER_ID });
      res.end('ok');
    });
  }

  function handlePermissionPost(req, res) {
    readBody(req, MAX_PERMISSION_BODY_BYTES, (body) => {
      if (body === null) {
        // Too large → auto-deny so CC doesn't hang.
        try {
          res.writeHead(200, { 'Content-Type': 'application/json', [SERVER_HEADER]: SERVER_ID });
          res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'payload too large' } } }));
        } catch {}
        return;
      }
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }

      const rawInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
      // AskUserQuestion's questions must round-trip verbatim into updatedInput, so
      // keep the raw input for it; truncate everything else for safety.
      const isElicit = data.tool_name === 'AskUserQuestion';
      const parsed = {
        toolName: typeof data.tool_name === 'string' ? data.tool_name : 'Unknown',
        toolInput: isElicit ? rawInput : truncateInput(rawInput),
        suggestions: Array.isArray(data.permission_suggestions) ? data.permission_suggestions : [],
        sessionId: data.session_id || 'default',
        agentId: 'claude-code',
        headless: data.headless === true,
      };
      // permission module parks `res` and writes the decision later.
      permissions.addPermission(res, parsed);
    });
  }

  function onRequest(req, res) {
    if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
    if (!hostAllowed(req) || fromBrowser(req)) { res.writeHead(403); res.end('forbidden'); return; }
    if (req.method === 'GET' && req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', [SERVER_HEADER]: SERVER_ID });
      res.end(JSON.stringify({ ok: true, app: SERVER_ID, port: activePort || BASE_PORT }));
      return;
    }
    if (req.method === 'GET' && req.url === '/debug') {
      // Off by default — it exposes session cwd/title/assistant text. Opt in with
      // OCTOPUS_DEBUG=1, and even then drop the reply text and the absolute cwd.
      if (process.env.OCTOPUS_DEBUG !== '1') { res.writeHead(404); res.end(); return; }
      const snap = core.buildSnapshot();
      const safe = snap.sessions.map((s) => ({
        ...s,
        cwd: s.cwd ? path.basename(s.cwd) : '',
        assistantLastOutput: undefined,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json', [SERVER_HEADER]: SERVER_ID });
      res.end(JSON.stringify({ sessions: safe, pending: permissions.getPending().map((p) => ({ id: p.id, sessionId: p.sessionId, toolName: p.toolName })) }, null, 2));
      return;
    }
    if (req.method === 'POST' && req.url === '/state') return handleStatePost(req, res);
    if (req.method === 'POST' && req.url === '/permission') return handlePermissionPost(req, res);
    res.writeHead(404); res.end();
  }

  function start() {
    server = http.createServer(onRequest);
    const ports = getPortCandidates();
    let idx = 0;

    server.on('error', (err) => {
      if (!activePort && err.code === 'EADDRINUSE' && idx < ports.length - 1) {
        idx++;
        server.listen(ports[idx], '127.0.0.1');
        return;
      }
      if (!activePort && err.code === 'EADDRINUSE') {
        log('server', `ports ${ports[0]}-${ports[ports.length - 1]} all in use — state sync + permission bubbles disabled`);
      } else {
        log('server', 'http error:', err.message);
      }
    });

    server.on('listening', () => {
      activePort = ports[idx];
      writeRuntimeConfig(activePort);
      log('server', `listening on 127.0.0.1:${activePort}`);
      startRuntimeGuard();
    });

    server.listen(ports[idx], '127.0.0.1');
  }

  // 守护 runtime.json：别的代码副本（同一套 transport 的旧版/分叉）启动时会把
  // runtime 覆盖成自己的端口，hook 流量随之被劫走。存活期间发现记录不是自己
  // 就抢回来 —— 先到者赢。
  let runtimeGuard = null;
  function startRuntimeGuard() {
    stopRuntimeGuard();
    runtimeGuard = setInterval(() => {
      if (!activePort) return;
      const p = readRuntimePort();
      if (p !== activePort) {
        log('server', `runtime.json points to ${p} (another instance?) — reasserting ${activePort}`);
        writeRuntimeConfig(activePort);
      }
    }, 15000);
    if (runtimeGuard.unref) runtimeGuard.unref();
  }
  function stopRuntimeGuard() {
    if (runtimeGuard) { clearInterval(runtimeGuard); runtimeGuard = null; }
  }

  function getPort() { return activePort; }

  function stop() {
    stopRuntimeGuard();
    // 只清掉指向自己的记录，避免误删另一个存活实例刚写的端口
    if (readRuntimePort() === activePort) clearRuntimeConfig();
    if (server) { try { server.close(); } catch {} server = null; }
  }

  return { start, stop, getPort };
}

module.exports = { createServer, MAX_STATE_BODY_BYTES };
