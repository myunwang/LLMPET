'use strict';

// Read the same ChatGPT quota windows exposed by Codex /status through the
// documented App Server account/rateLimits/read method. The rollout watcher is
// still kept by main.js as a compatibility fallback for older Codex builds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { findCli } = require('./launch');
const { log } = require('./log');
const { normalizeAppServerRateLimits } = require('../shared/codex-rate-limits');

const POLL_MS = 2 * 60 * 1000;
const RESTART_MS = 30 * 1000;
const AUTH_RETRY_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

function findBundledWindowsCodex() {
  if (process.platform !== 'win32') return null;
  const npmRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm');
  const scope = path.join(npmRoot, 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  let packages = [];
  try { packages = fs.readdirSync(scope, { withFileTypes: true }); } catch { return null; }
  for (const pkg of packages) {
    if (!pkg.isDirectory() || !pkg.name.startsWith('codex-win32-')) continue;
    const vendor = path.join(scope, pkg.name, 'vendor');
    let targets = [];
    try { targets = fs.readdirSync(vendor, { withFileTypes: true }); } catch { continue; }
    for (const target of targets) {
      if (!target.isDirectory()) continue;
      const candidate = path.join(vendor, target.name, 'bin', 'codex.exe');
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

function resolveCodexExecutable(findCliImpl = findCli) {
  const bundled = findBundledWindowsCodex();
  if (bundled) return bundled;
  return findCliImpl('codex');
}

function createCodexRateLimits(deps = {}) {
  const onRateLimits = typeof deps.onRateLimits === 'function' ? deps.onRateLimits : () => {};
  const spawnImpl = deps.spawnImpl || spawn;
  const findCliImpl = deps.findCliImpl || findCli;
  const pollMs = Number.isFinite(deps.pollMs) ? deps.pollMs : POLL_MS;
  const restartMs = Number.isFinite(deps.restartMs) ? deps.restartMs : RESTART_MS;
  const authRetryMs = Number.isFinite(deps.authRetryMs) ? deps.authRetryMs : AUTH_RETRY_MS;
  const requestTimeoutMs = Number.isFinite(deps.requestTimeoutMs) ? deps.requestTimeoutMs : REQUEST_TIMEOUT_MS;
  let child = null;
  let stopped = true;
  let initialized = false;
  let nextId = 1;
  let stdoutBuffer = '';
  let pollTimer = null;
  let restartTimer = null;
  let readPending = false;
  let authBlocked = false;
  const pending = new Map();

  function write(message) {
    if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
    try { child.stdin.write(JSON.stringify(message) + '\n'); return true; } catch { return false; }
  }

  function request(method, params, callback) {
    const id = nextId++;
    const timeout = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      entry.callback(null, new Error(`${method} timed out`));
    }, requestTimeoutMs);
    if (timeout.unref) timeout.unref();
    pending.set(id, { callback, timeout });
    const message = { method, id };
    if (params !== undefined) message.params = params;
    if (!write(message)) {
      clearTimeout(timeout);
      pending.delete(id);
      callback(null, new Error(`${method} write failed`));
    }
    return id;
  }

  function accept(payload) {
    const limits = normalizeAppServerRateLimits(payload);
    if (!limits) return;
    onRateLimits(limits);
  }

  function readRateLimits() {
    if (!initialized || readPending) return;
    readPending = true;
    request('account/rateLimits/read', undefined, (result, error) => {
      readPending = false;
      if (error) {
        log('codex-rate', error.message);
        if (/authentication required|not logged in/i.test(error.message)) {
          authBlocked = true;
          const proc = child;
          if (proc) { try { proc.kill(); } catch {} }
        }
        return;
      }
      authBlocked = false;
      accept(result);
    });
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      entry.callback(message.result || null, message.error ? new Error(message.error.message || 'App Server error') : null);
      return;
    }
    if (message.method === 'account/rateLimits/updated') accept(message.params);
  }

  function consumeStdout(chunk) {
    stdoutBuffer += chunk.toString('utf8');
    if (stdoutBuffer.length > 2 * 1024 * 1024) stdoutBuffer = stdoutBuffer.slice(-1024 * 1024);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleMessage(JSON.parse(line)); } catch {}
    }
  }

  function clearPending(reason) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      try { entry.callback(null, new Error(reason)); } catch {}
    }
    pending.clear();
    readPending = false;
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => { restartTimer = null; connect(); }, authBlocked ? authRetryMs : restartMs);
    if (restartTimer.unref) restartTimer.unref();
  }

  function connect() {
    if (stopped || child) return;
    initialized = false;
    stdoutBuffer = '';
    const executable = resolveCodexExecutable(findCliImpl);
    let proc;
    try {
      proc = spawnImpl(executable, ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (error) {
      log('codex-rate', `App Server start failed: ${error.message}`);
      scheduleRestart();
      return;
    }
    child = proc;
    proc.stdout.on('data', consumeStdout);
    proc.on('spawn', () => {
      request('initialize', {
        clientInfo: { name: 'llmpet', title: 'LLMPET', version: '1.1.1' },
        capabilities: { optOutNotificationMethods: ['thread/started', 'item/agentMessage/delta'] },
      }, (_result, error) => {
        if (error) {
          log('codex-rate', `initialize failed: ${error.message}`);
          try { proc.kill(); } catch {}
          return;
        }
        initialized = true;
        write({ method: 'initialized', params: {} });
        readRateLimits();
        if (!pollTimer) {
          pollTimer = setInterval(readRateLimits, pollMs);
          if (pollTimer.unref) pollTimer.unref();
        }
        log('codex-rate', 'App Server quota reader ready');
      });
    });
    proc.on('error', (error) => log('codex-rate', `App Server error: ${error.message}`));
    proc.on('close', (code) => {
      if (child !== proc) return;
      child = null;
      initialized = false;
      clearPending('App Server closed');
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (!stopped) {
        log('codex-rate', `App Server exited (${code == null ? 'unknown' : code}); retrying`);
        scheduleRestart();
      }
    });
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    clearPending('quota reader stopped');
    const proc = child;
    child = null;
    initialized = false;
    if (proc) { try { proc.kill(); } catch {} }
  }

  return { start, stop, refresh: readRateLimits };
}

module.exports = {
  createCodexRateLimits,
  resolveCodexExecutable,
  findBundledWindowsCodex,
};
