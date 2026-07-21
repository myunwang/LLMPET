'use strict';

// Local HTTP server: GET /state (health), POST /state (hook ingest),
// POST /permission (blocking permission hook).
//
// Port discovery, the runtime file, and the server identity header all come from
// backend/transport.js (our own). The /state body fields are Claude Code's hook
// payload (a data interface); every value is normalized/validated before use.

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {
  SERVER_HEADER,
  SERVER_ID,
  TOKEN_HEADER,
  BASE_PORT,
  getPortCandidates,
  createRuntimeToken,
  readRuntimeConfig,
  writeRuntimeConfig,
  clearRuntimeConfig,
} = require('./transport');
const { createCodeWhalePermissions } = require('./codewhale-permission');
const { createMeteringCodeWhale } = require('./metering-codewhale');
const { log } = require('./log');

// A Stop event carries the assistant's last reply (up to ~2200 chars). In CJK
// that is ~3 bytes/char ≈ 6.6KB, so a 4KB cap silently 413-dropped the whole
// Stop for long Chinese replies (completion state + 💬 bubble lost). 16KB clears
// the worst case with headroom; everything else in the body is small.
const MAX_STATE_BODY_BYTES = 16 * 1024;
const MAX_PERMISSION_BODY_BYTES = 1024 * 1024; // tool_input can be large
const ASSISTANT_LAST_OUTPUT_MAX = 2400;
const BODY_READ_TIMEOUT_MS = 10 * 1000;
const MAX_COUNT = 1_000_000;
const DEFAULT_TRANSCRIPT_ROOTS = [path.join(os.homedir(), '.claude', 'projects')];

// ── input normalizers (faithful to server-route-state.js, Claude subset) ──────

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normText(v, max, fallback = null) {
  if (typeof v !== 'string') return fallback;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!t) return fallback;
  return t.length > max ? t.slice(0, max) : t;
}

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
  const out = { used: Math.min(used, Number.MAX_SAFE_INTEGER) };
  const limit = Number(v.limit);
  if (Number.isFinite(limit) && limit > 0) out.limit = Math.min(limit, Number.MAX_SAFE_INTEGER);
  const percent = Number(v.percent);
  if (Number.isFinite(percent)) out.percent = Math.max(0, Math.min(100, Math.round(percent)));
  else if (out.limit) out.percent = Math.max(0, Math.min(100, Math.round((used / out.limit) * 100)));
  if (v.source === 'claude' || v.source === 'codex') out.source = v.source;
  return out;
}

// Shallow-deep truncate tool_input so a giant payload can't blow up memory/IPC.
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function truncateInput(value, depth = 0) {
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((x) => truncateInput(x, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 48)) {
      if (UNSAFE_OBJECT_KEYS.has(k)) continue;
      out[k] = truncateInput(value[k], depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) + '…' : value;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

function isLoopback(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Defense against DNS-rebinding: even when the TCP peer is loopback, a rebound
// page reaches us with Host = attacker.com. Only accept loopback Host values.
function hostAllowed(req) {
  const raw = String((req.headers && req.headers.host) || '').trim().toLowerCase();
  if (!raw) return true; // some node clients omit Host on a raw socket
  if (raw.length > 128 || raw.includes('\0') || /[\r\n\t ]/.test(raw)) return false;

  let hostname = raw;
  let port = '';
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return false;
    hostname = raw.slice(0, close + 1);
    const rest = raw.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(':')) return false;
      port = rest.slice(1);
    }
  } else {
    const colon = raw.lastIndexOf(':');
    if (colon >= 0) {
      // Loopback IPv4/localhost never contain a colon; anything else is invalid.
      hostname = raw.slice(0, colon);
      port = raw.slice(colon + 1);
    }
  }

  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false;
  if (!port) return true;
  if (port.length > 5) return false;
  for (const ch of port) if (ch < '0' || ch > '9') return false;
  const number = Number(port);
  return Number.isInteger(number) && number >= 1 && number <= 65535;
}

// Our node hook never sets Origin/Referer; a browser fetch/XHR always attaches
// Origin on cross-origin (and Referer on same-origin) requests. Reject any
// request that carries one → blocks CSRF from a page the user is visiting.
function fromBrowser(req) {
  return !!(req.headers && (req.headers.origin || req.headers.referer));
}

// Only accept transcript files under Claude's own project data directory.
// This prevents a forged lifecycle payload from turning the 10-second sweeper
// into an arbitrary local-file reader. Existing regular files are also checked
// after realpath resolution so symlink escapes are rejected.
function pathInside(filePath, root) {
  const rel = path.relative(path.resolve(root), path.resolve(filePath));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function normTranscriptPath(v, roots = DEFAULT_TRANSCRIPT_ROOTS) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 4096 || /[\0\r\n]/.test(t)) return null;
  if (path.extname(t).toLowerCase() !== '.jsonl' || !path.isAbsolute(t)) return null;
  if (!roots.some((root) => pathInside(t, root))) return null;
  try {
    const st = fs.lstatSync(t);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const real = fs.realpathSync(t);
    if (!roots.some((root) => pathInside(real, root))) return null;
  } catch (err) {
    if (err && err.code !== 'ENOENT') return null;
  }
  return t;
}

function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function contentTypeIsJson(req) {
  const value = String((req.headers && req.headers['content-type']) || '').toLowerCase();
  return /^application\/json(?:\s*;|$)/.test(value);
}

function clampCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_COUNT, Math.floor(n))) : 0;
}

function readBody(req, cap, onDone) {
  const chunks = [];
  let size = 0;
  let finished = false;
  const timer = setTimeout(() => done(null, 'timeout'), BODY_READ_TIMEOUT_MS);
  if (timer.unref) timer.unref();

  const cleanup = () => {
    clearTimeout(timer);
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
    req.off('aborted', onAborted);
  };
  const done = (value, error = null) => {
    if (finished) return;
    finished = true;
    cleanup();
    onDone(value, error);
  };
  const onData = (chunk) => {
    size += chunk.length;
    if (size > cap) {
      chunks.length = 0;
      req.resume();
      done(null, 'too-large');
      return;
    }
    chunks.push(chunk);
  };
  const onEnd = () => done(Buffer.concat(chunks).toString('utf8'));
  const onError = () => done(null, 'io');
  const onAborted = () => done(null, 'aborted');

  const declaredRaw = req.headers && req.headers['content-length'];
  const declared = declaredRaw == null ? null : Number(declaredRaw);
  if (declared != null && (!Number.isSafeInteger(declared) || declared < 0)) {
    req.resume(); done(null, 'bad-length'); return;
  }
  if (declared != null && declared > cap) {
    req.resume(); done(null, 'too-large'); return;
  }
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
  req.on('aborted', onAborted);
}

function createServer(deps) {
  const core = deps.core;
  const permissions = deps.permissions;
  const shouldDropForDnd = typeof deps.shouldDropForDnd === 'function' ? deps.shouldDropForDnd : () => false;
  const transcriptRoots = Array.isArray(deps.transcriptRoots) && deps.transcriptRoots.length ? deps.transcriptRoots : DEFAULT_TRANSCRIPT_ROOTS;

  // Sweep time-window guard: per-session last sweep timestamp.
  // Prevents rapid fire sweeps from overwhelming pending permission entries.
  let lastSweepTs = null;  // Map<sessionId, timestamp>

  // CodeWhale permission holder (Round 3) — separate from Claude's, same pattern.
  // Created here so no changes to main.js are needed.
  const cwPermissions = createCodeWhalePermissions({
    shouldDrop: shouldDropForDnd,
    onChange: () => {},
  });

  // CodeWhale metering (Round 4) — records turn_end usage directly, no file scan.
  const cwMetering = createMeteringCodeWhale();
  cwMetering.start();

  let server = null;
  let activePort = null;
  let activeToken = null;

  function handleStatePost(req, res) {
    readBody(req, MAX_STATE_BODY_BYTES, (body, bodyError) => {
      if (body === null) { res.writeHead(bodyError === 'too-large' ? 413 : 408); res.end(bodyError === 'too-large' ? 'state payload too large' : 'state payload timeout'); return; }
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
      if (!isPlainObject(data)) { res.writeHead(400); res.end('bad payload'); return; }

      const state = data.state;
      const event = data.event;
      // No session_id → reject. Defaulting to 'default' forged a ghost session
      // named "efault" and cross-wired state between real sessions. The hook
      // already drops these; this closes the same hole on the server side.
      const sid = normText(data.session_id, 256);
      if (!sid) { res.writeHead(400); res.end('missing session_id'); return; }
      if (!core.VALID_STATES.has(state)) { res.writeHead(400); res.end('unknown state'); return; }

      // DND: accept (so the hook gets a fast 200) but the renderer suppresses noise.
      const fields = {
        toolName: normText(data.tool_name, 128),
        cwd: normText(data.cwd, 4096),
        editor: data.editor === 'code' || data.editor === 'cursor' ? data.editor : null,
        sourcePid: normNum(data.source_pid),
        wtHwnd: normHwnd(data.wt_hwnd ?? data.wtHwnd),
        pidChain: Array.isArray(data.pid_chain) ? data.pid_chain.filter((n) => Number.isFinite(n) && n > 0).slice(0, 64) : null,
        tmuxSocket: normTmuxSocket(data.tmux_socket),
        tmuxClient: normTmuxClient(data.tmux_client),
        ghosttyTerminalId: normText(data.ghostty_terminal_id, 256),
        agentId: data.provider === 'codewhale' ? 'codewhale' : 'claude-code',
        provider: data.provider === 'codewhale' ? 'codewhale' : null,
        headless: data.headless === true,
        transcriptPath: normTranscriptPath(data.transcript_path, transcriptRoots),
        model: normText(data.model, 128),
        sessionTitle: normText(data.session_title, 512),
        sessionSource: typeof data.session_source === 'string' && /^[a-z]{1,16}$/.test(data.session_source) ? data.session_source : null,
        contextUsage: normContext(data.context_usage),
        assistantLastOutput: normAssistant(data.assistant_last_output),
        assistantLastOutputTruncated: data.assistant_last_output_truncated === true,
        preserveState: data.preserve_state === true,
        errorType: normText(data.api_error_type, 128),
        userEmotion: normText(data.user_emotion, 64),
        assistantEmotion: normText(data.assistant_emotion, 64),
        backgroundTasksCount: clampCount(data.background_tasks_count),
        sessionCronsCount: clampCount(data.session_crons_count),
        stopHookActive: data.stop_hook_active === true,
      };

      // The user clearly answered in the terminal → clear stale permission bubbles.
      // Time-window guard: prevent re-sweeping the same session+event within 500ms.
      const now = Date.now();
      if (!lastSweepTs || !lastSweepTs.has(sid) || now - lastSweepTs.get(sid) > 500) {
        permissions.sweepForSessionEvent(sid, event);
        cwPermissions.sweepForSessionEvent(sid, event);
        if (!lastSweepTs) lastSweepTs = new Map();
        lastSweepTs.set(sid, now);
      }

      // CodeWhale metering: record turn_end usage directly (R4).
      // body.turn_usage comes from codewhale.parseHookStdin for turn_end events.
      if (data.turn_usage && typeof data.turn_usage === 'object') {
        cwMetering.recordTurnEnd(data);
      }

      core.updateSession(sid, state, event, fields);
      res.writeHead(200, { [SERVER_HEADER]: SERVER_ID });
      res.end('ok');
    });
  }

  function handlePermissionPost(req, res) {
    readBody(req, MAX_PERMISSION_BODY_BYTES, (body, bodyError) => {
      if (body === null) {
        // Too large → auto-deny so CC doesn't hang.
        try {
          res.writeHead(200, { 'Content-Type': 'application/json', [SERVER_HEADER]: SERVER_ID });
          res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: bodyError === 'too-large' ? 'payload too large' : 'payload read timeout' } } }));
        } catch {}
        return;
      }
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
      if (!isPlainObject(data)) { res.writeHead(400); res.end('bad payload'); return; }

      const rawInput = isPlainObject(data.tool_input) ? data.tool_input : {};
      const sessionId = normText(data.session_id, 256);
      if (!sessionId) {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json', [SERVER_HEADER]: SERVER_ID });
          res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'missing session_id' } } }));
        } catch {}
        return;
      }
      // AskUserQuestion's questions must round-trip verbatim into updatedInput, so
      // keep the raw input for it; truncate everything else for safety. Suggestions
      // are UI metadata, therefore cap both their count and nested values.
      const toolName = normText(data.tool_name, 128, 'Unknown');
      const isElicit = toolName === 'AskUserQuestion';
      const suggestions = Array.isArray(data.permission_suggestions)
        ? data.permission_suggestions.filter(isPlainObject).slice(0, 8).map((x) => truncateInput(x))
        : [];
      const parsed = {
        toolName,
        toolInput: isElicit ? rawInput : truncateInput(rawInput),
        suggestions,
        sessionId,
        agentId: 'claude-code',
        headless: data.headless === true,
      };
      // permission module parks `res` and writes the decision later.
      permissions.addPermission(res, parsed);
    });
  }

  // ── CodeWhale permission endpoint (Round 3) ──────────────────────────────
  // codewhale-hook.js POSTs here for tool_call_before events and blocks until
  // the pet user decides. Response format is CodeWhale's TOOL_CALL_BEFORE_DECISION:
  //   { "decision": "allow"|"deny"|"ask", "reason": "..." }
  // Separate from /permission to avoid any risk to Claude's response format.
  function handleCodeWhalePermissionPost(req, res) {
    readBody(req, MAX_PERMISSION_BODY_BYTES, (body, bodyError) => {
      // Helper: send a direct deny response (used when we can't park the request).
      const denyDirect = (reason) => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json', [SERVER_HEADER]: SERVER_ID });
          res.end(JSON.stringify({ decision: 'deny', reason }));
        } catch {}
      };
      if (body === null) { denyDirect(bodyError === 'too-large' ? 'payload too large' : 'payload read timeout'); return; }
      let data;
      try { data = JSON.parse(body); } catch { denyDirect('bad json'); return; }
      if (!isPlainObject(data)) { denyDirect('bad payload'); return; }

      const rawInput = isPlainObject(data.tool_input) ? data.tool_input : {};
      const sessionId = normText(data.session_id, 256);
      if (!sessionId) {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json', [SERVER_HEADER]: SERVER_ID });
          res.end(JSON.stringify({ decision: 'ask', reason: 'missing session_id' }));
        } catch {}
        return;
      }
      const parsed = {
        toolName: normText(data.tool_name, 128, 'Unknown'),
        toolInput: truncateInput(rawInput),
        sessionId,
        agentId: 'codewhale',
        mode: normText(data.mode, 64),
        model: normText(data.model, 128),
        workspace: normText(data.workspace, 4096),
      };
      // cwPermissions parks `res` and writes the CodeWhale-format decision later.
      cwPermissions.addPermission(res, parsed);
    });
  }

  function requestAuthorized(req, url) {
    const header = req.headers && req.headers[TOKEN_HEADER];
    const headerToken = Array.isArray(header) ? header[0] : header;
    const queryToken = url.searchParams.get('token');
    return safeTokenEqual(String(headerToken || queryToken || ''), activeToken || '');
  }

  function onRequest(req, res) {
    if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
    if (!hostAllowed(req) || fromBrowser(req)) { res.writeHead(403); res.end('forbidden'); return; }
    let url;
    try { url = new URL(req.url || '/', 'http://127.0.0.1'); } catch { res.writeHead(400); res.end('bad url'); return; }
    const route = url.pathname;
    if (req.method === 'GET' && route === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', [SERVER_HEADER]: SERVER_ID });
      res.end(JSON.stringify({ ok: true, app: SERVER_ID, port: activePort || BASE_PORT }));
      return;
    }
    if (req.method === 'GET' && route === '/debug') {
      if (process.env.OCTOPUS_DEBUG !== '1') { res.writeHead(404); res.end(); return; }
      if (!requestAuthorized(req, url)) { res.writeHead(401, { [SERVER_HEADER]: SERVER_ID }); res.end('unauthorized'); return; }
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
    if (req.method === 'POST') {
      if (!requestAuthorized(req, url)) { res.writeHead(401, { [SERVER_HEADER]: SERVER_ID }); res.end('unauthorized'); return; }
      if (!contentTypeIsJson(req)) { res.writeHead(415, { [SERVER_HEADER]: SERVER_ID }); res.end('application/json required'); return; }
      if (route === '/state') return handleStatePost(req, res);
      if (route === '/permission') return handlePermissionPost(req, res);
      if (route === '/codewhale-permission') return handleCodeWhalePermissionPost(req, res);
    }
    res.writeHead(404); res.end();
  }

  function start() {
    activeToken = createRuntimeToken();
    server = http.createServer(onRequest);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 2000;
    server.maxHeadersCount = 32;
    server.maxConnections = 128;
    server.on('clientError', (_err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {} });
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
      writeRuntimeConfig(activePort, activeToken);
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
      const cfg = readRuntimeConfig();
      if (!cfg || cfg.port !== activePort || cfg.token !== activeToken) {
        log('server', `runtime.json changed (another instance?) — reasserting ${activePort}`);
        writeRuntimeConfig(activePort, activeToken);
      }
    }, 15000);
    if (runtimeGuard.unref) runtimeGuard.unref();
  }
  function stopRuntimeGuard() {
    if (runtimeGuard) { clearInterval(runtimeGuard); runtimeGuard = null; }
  }

  function getPort() { return activePort; }
  function getToken() { return activeToken; }

  function stop() {
    stopRuntimeGuard();
    cwMetering.stop();
    cwPermissions.cleanup();
    // 只清掉指向自己的记录，避免误删另一个存活实例刚写的端口
    clearRuntimeConfig({ port: activePort, token: activeToken });
    if (server) {
      try { server.close(); } catch {}
      try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch {}
      server = null;
    }
    activePort = null;
    activeToken = null;
  }

  // Expose CodeWhale sub-modules for main.js integration (Round 6).
  // This lets main.js wire IPC handlers for cw permission decisions and
  // include cw metering/pending in stats — without creating a second instance.
  function getCwPermissions() { return cwPermissions; }
  function getCwMetering() { return cwMetering; }

  return { start, stop, getPort, getToken, getCwPermissions, getCwMetering };
}

module.exports = { createServer, MAX_STATE_BODY_BYTES, MAX_PERMISSION_BODY_BYTES, BODY_READ_TIMEOUT_MS, _truncateInput: truncateInput, _normTranscriptPath: normTranscriptPath };
