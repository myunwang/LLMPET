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

const SERVER_ID = 'octopus';
const SERVER_HEADER = 'x-octopus-server';
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

function readRuntimePort() {
  try {
    const obj = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
    return inRange(obj && obj.port);
  } catch {
    return null;
  }
}

function writeRuntimeConfig(port) {
  const p = inRange(port);
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true });
    const tmp = path.join(path.dirname(RUNTIME_PATH), `.runtime.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ app: SERVER_ID, port: p }), 'utf8');
    fs.renameSync(tmp, RUNTIME_PATH);
    return true;
  } catch {
    return false;
  }
}

function clearRuntimeConfig() {
  try { fs.unlinkSync(RUNTIME_PATH); return true; } catch { return false; }
}

// Candidate ports to try, runtime-recorded port first.
function getPortCandidates() {
  const out = [];
  const add = (p) => { const v = inRange(p); if (v && !out.includes(v)) out.push(v); };
  add(readRuntimePort());
  PORTS.forEach(add);
  return out;
}

function buildPermissionUrl(port) {
  return `http://127.0.0.1:${inRange(port) || BASE_PORT}${PERMISSION_PATH}`;
}

function headerIsOurs(res) {
  const v = res && res.headers && res.headers[SERVER_HEADER];
  return (Array.isArray(v) ? v[0] : v) === SERVER_ID;
}

// Probe one port's GET /state; callback(true) if it's our server.
function probe(port, timeoutMs, cb) {
  const req = http.get({ hostname: '127.0.0.1', port, path: STATE_PATH, timeout: timeoutMs }, (res) => {
    res.resume();
    cb(headerIsOurs(res));
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

// POST a state body to the first reachable Octopus server. Best-effort + fast:
// the hook must not block Claude Code, so it gives up quickly on each port.
function postState(body, cb) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const ports = getPortCandidates();
  let i = 0;
  const tryNext = () => {
    if (i >= ports.length) { cb && cb(false); return; }
    const port = ports[i++];
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: STATE_PATH, method: 'POST',
        timeout: POST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const ok = headerIsOurs(res);
        res.resume();
        if (ok) cb && cb(true, port);
        else tryNext();
      }
    );
    req.on('error', tryNext);
    req.on('timeout', () => { req.destroy(); tryNext(); });
    req.end(payload);
  };
  tryNext();
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
  SERVER_ID, SERVER_HEADER, PORTS, BASE_PORT, STATE_PATH, PERMISSION_PATH, RUNTIME_PATH,
  inRange, readRuntimePort, writeRuntimeConfig, clearRuntimeConfig,
  getPortCandidates, buildPermissionUrl, headerIsOurs, probe, postState, resolveNodeBin,
};
