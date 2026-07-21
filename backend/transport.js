'use strict';

// Octopus transport — original implementation.
//
// Shared between the hook script and the server: a small set of localhost ports,
// a runtime file that records which port the running app bound, the identity
// header the hook uses to recognize our server, the hook→server POST, and node
// binary resolution (Claude Code runs hooks with a stripped PATH, so the hook
// command must embed an absolute node path).
//
// The protocol facts this targets (Claude Code's hook command/HTTP shape, the
// PermissionRequest response JSON) are interfaces, not anyone's code — this file
// is written from scratch with Octopus's own naming/ports/paths.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SERVER_ID = 'octopus';
const SERVER_HEADER = 'x-octopus-server';
const TOKEN_HEADER = 'x-octopus-token';
const BASE_PORT = 41330;
const PORT_COUNT = 5;
const PORTS = Array.from({ length: PORT_COUNT }, (_, i) => BASE_PORT + i);
const STATE_PATH = '/state';
const PERMISSION_PATH = '/permission';
const RUNTIME_PATH = path.join(os.homedir(), '.octopus', 'runtime.json');
const POST_TIMEOUT_MS = 120;

function inRange(port) {
  const p = Number(port);
  return Number.isInteger(p) && PORTS.includes(p) ? p : null;
}

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}

function createRuntimeToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function readRuntimeConfig() {
  try {
    const obj = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
    const port = obj && obj.app === SERVER_ID ? inRange(obj.port) : null;
    const token = obj && validToken(obj.token);
    if (!port || !token) return null;
    return { app: SERVER_ID, port, token, pid: Number.isInteger(obj.pid) ? obj.pid : null };
  } catch {
    return null;
  }
}

function readRuntimePort() {
  const cfg = readRuntimeConfig();
  return cfg ? cfg.port : null;
}

function writeRuntimeConfig(port, token) {
  const p = inRange(port);
  const t = validToken(token);
  if (!p || !t) return false;
  try {
    const dir = path.dirname(RUNTIME_PATH);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    const tmp = path.join(dir, `.runtime.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ app: SERVER_ID, port: p, token: t, pid: process.pid }), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, RUNTIME_PATH);
    try { fs.chmodSync(RUNTIME_PATH, 0o600); } catch {}
    return true;
  } catch {
    return false;
  }
}

function clearRuntimeConfig(expected) {
  try {
    if (expected) {
      const cur = readRuntimeConfig();
      if (!cur || cur.port !== expected.port || cur.token !== expected.token) return false;
    }
    fs.unlinkSync(RUNTIME_PATH);
    return true;
  } catch { return false; }
}

// Candidate ports are for unauthenticated health probes only. Mutating hook
// traffic never scans ports: it uses the token-bearing runtime record exactly.
function getPortCandidates() {
  const out = [];
  const add = (p) => { const v = inRange(p); if (v && !out.includes(v)) out.push(v); };
  const cfg = readRuntimeConfig();
  add(cfg && cfg.port);
  PORTS.forEach(add);
  return out;
}

function buildPermissionUrl(port, token) {
  const p = inRange(port) || BASE_PORT;
  let t = validToken(token);
  if (!t) {
    const cfg = readRuntimeConfig();
    if (cfg && cfg.port === p) t = cfg.token;
  }
  const suffix = t ? `?token=${encodeURIComponent(t)}` : '';
  return `http://127.0.0.1:${p}${PERMISSION_PATH}${suffix}`;
}

function headerIsOurs(res) {
  const v = res && res.headers && res.headers[SERVER_HEADER];
  return (Array.isArray(v) ? v[0] : v) === SERVER_ID;
}

// Probe one port's GET /state; callback(true) if it's our server.
function probe(port, timeoutMs, cb) {
  let called = false;
  const done = (ok) => { if (called) return; called = true; cb(!!ok); };
  const req = http.get({ hostname: '127.0.0.1', port, path: STATE_PATH, timeout: timeoutMs }, (res) => {
    res.resume();
    done(headerIsOurs(res));
  });
  req.on('error', () => done(false));
  req.on('timeout', () => { req.destroy(); done(false); });
}

// POST one state update using the authenticated runtime record. Best-effort and
// fast: lifecycle hooks must never stall the coding agent.
function postState(body, cb) {
  const runtime = readRuntimeConfig();
  if (!runtime) { if (cb) cb(false); return; }
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  let called = false;
  const done = (ok) => { if (called) return; called = true; if (cb) cb(!!ok, runtime.port); };
  const req = http.request(
    {
      hostname: '127.0.0.1', port: runtime.port, path: STATE_PATH, method: 'POST',
      timeout: POST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        [TOKEN_HEADER]: runtime.token,
      },
    },
    (res) => {
      const ok = res.statusCode === 200 && headerIsOurs(res);
      res.resume();
      done(ok);
    }
  );
  req.on('error', () => done(false));
  req.on('timeout', () => { req.destroy(); done(false); });
  req.end(payload);
}

// Resolve an absolute node binary for embedding in hook commands. Claude Code
// runs hooks with a minimal PATH (/usr/bin:/bin) that excludes Homebrew / nvm /
// volta / fnm, so a bare "node" frequently fails — we probe common locations,
// then fall back to a login shell lookup, then to process.execPath / "node".
function resolveNodeBin() {
  const plat = process.platform;
  if (plat === 'win32') return resolveWinNode();

  // Plain node process (not Electron): its own execPath is node.
  if (!process.versions.electron && process.execPath) return process.execPath;

  const home = os.homedir();
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(home, '.volta', 'bin', 'node'),
    path.join(home, '.nvm', 'current', 'bin', 'node'),
    path.join(home, '.local', 'bin', 'node'),
    '/usr/bin/node',
  ];
  // Newest nvm/fnm version dirs. Sort numerically, NOT lexically — a lexical sort
  // ranks 'v8.x' after 'v18.x'/'v20.x' and would pick the ancient v8 first.
  for (const root of [path.join(home, '.nvm', 'versions', 'node'), path.join(home, '.fnm', 'node-versions')]) {
    try {
      const vers = fs.readdirSync(root).filter((v) => /^v?\d+\./.test(v)).sort(cmpVersionDesc);
      for (const v of vers) candidates.push(path.join(root, v, root.includes('.fnm') ? 'installation' : '', 'bin', 'node').replace('//', '/'));
    } catch {}
  }
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  // Login shell lookup (sources nvm/fnm rc files).
  try {
    const { execFileSync } = require('child_process');
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-lic', 'command -v node 2>/dev/null'], { encoding: 'utf8', timeout: 5000 });
    const line = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('/')).pop();
    if (line) { fs.accessSync(line, fs.constants.X_OK); return line; }
  } catch {}
  // Last resort: bare 'node'. Never process.execPath here — under Electron that's
  // the app binary, so every hook event would spawn a whole GUI instance. (A real
  // node process already returned its own execPath at the top.)
  return 'node';
}

// Compare 'v18.19.0' style versions numerically, newest first.
function cmpVersionDesc(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

function resolveWinNode() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('where', ['node'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const line = out.split(/\r?\n/).map((s) => s.trim()).find((s) => /node\.exe$/i.test(s) && !/scoop\\shims/i.test(s));
    if (line) return line;
  } catch {}
  for (const p of [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe')].filter(Boolean)) {
    try { fs.accessSync(p); return p; } catch {}
  }
  return 'node';
}

module.exports = {
  SERVER_ID, SERVER_HEADER, TOKEN_HEADER, PORTS, BASE_PORT, STATE_PATH, PERMISSION_PATH, RUNTIME_PATH,
  inRange, validToken, createRuntimeToken, readRuntimeConfig, readRuntimePort, writeRuntimeConfig, clearRuntimeConfig,
  getPortCandidates, buildPermissionUrl, headerIsOurs, probe, postState, resolveNodeBin,
};
