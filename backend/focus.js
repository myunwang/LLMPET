'use strict';

// focusSession(session) — bring the terminal window/app that owns a Claude Code
// session to the foreground, for the pet's left-click / "💬 去回复".
//
// Our hook reports source_pid as the terminal process plus a pid_chain. On macOS
// we activate the GUI app that owns one of those pids via System Events, and we
// return whether a process was ACTUALLY matched (osascript exits 0 even when no
// process matched, so we check its stdout). On Windows we probe the pid chain
// for a process that owns a top-level window (WindowsTerminal / conhost apps /
// VS Code) and bring it to the foreground via user32. Linux focus needs native
// helpers and is a known gap — focusSession returns false there so the caller
// can fall back (e.g. open the panel).

const { execFile } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');
const { log } = require('./log');
const { normalizeWindowsPid, readCachedWindowsTerminalTabRoute } = require('./pidwalk');

const WT_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOWS_TERMINAL_HELPER = path.join(__dirname, 'focus-windows-terminal.ps1');
const WINDOWS_TERMINAL_BROKER = path.join(__dirname, 'terminal-focus-broker.ps1');
const WINDOWS_TERMINAL_BROKER_INSTALLER = path.join(__dirname, 'install-terminal-focus-broker.ps1');

function terminalFocusProfileKey(profilePath = os.homedir()) {
  const normalized = path.resolve(profilePath).replace(/[\\/]+$/, '').toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

function terminalFocusBrokerPipeName(profilePath = os.homedir()) {
  return `LLMPET.TerminalFocus.v1.${terminalFocusProfileKey(profilePath)}`;
}

function terminalFocusBrokerPipePath(profilePath = os.homedir()) {
  return `\\\\.\\pipe\\${terminalFocusBrokerPipeName(profilePath)}`;
}

const TERMINAL_FOCUS_BROKER_PIPE = terminalFocusBrokerPipePath();
const terminalFocusBrokerChannels = new Map();

function runOsascript(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => {
      resolve(!err && String(stdout || '').trim() === 'ok');
    });
  });
}

// Activate the GUI application that owns `pid`. Returns true only when a process
// with that unix id existed and was brought frontmost.
async function activateMacPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const script = [
    'tell application "System Events"',
    `  set procs to (every process whose unix id is ${pid})`,
    '  if (count of procs) > 0 then',
    '    set frontmost of (item 1 of procs) to true',
    '    return "ok"',
    '  end if',
    'end tell',
    'return "none"',
  ].join('\n');
  return runOsascript(script);
}

// Windows: one PowerShell run tries every candidate pid in order and focuses
// the first one that owns a top-level window. SetForegroundWindow from a
// background process is throttled by Windows, so we also call
// SwitchToThisWindow as a fallback (it emulates the Alt-Tab path).
function activateWinPids(pids) {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (!list.length) return Promise.resolve(false);
  const script = [
    "Add-Type -Namespace W -Name U -MemberDefinition '",
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
    "'",
    `foreach ($id in @(${list.join(',')})) {`,
    '  $p = Get-Process -Id $id -ErrorAction SilentlyContinue',
    '  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {',
    '    $h = $p.MainWindowHandle',
    '    if ([W.U]::IsIconic($h)) { [W.U]::ShowWindowAsync($h, 9) | Out-Null }',
    '    [W.U]::SetForegroundWindow($h) | Out-Null',
    '    [W.U]::SwitchToThisWindow($h, $true)',
    '    Write-Output ("ok|" + $id)',
    '    exit 0',
    '  }',
    '}',
    "Write-Output 'none'",
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        const m = /^ok\|(\d+)$/m.exec(String(stdout || ''));
        resolve(!err && m ? parseInt(m[1], 10) : false);
      });
  });
}

function normalizeWindowHandle(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[1-9]\d{0,18}$/.test(text)) return null;
  try { return BigInt(text) <= 9223372036854775807n ? text : null; } catch { return null; }
}

function normalizeRuntimeId(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const result = value.map(Number);
  return result.every((entry) => Number.isInteger(entry) && entry >= -2147483648 && entry <= 2147483647)
    ? result : null;
}

function hydrateWindowsTerminalTabRoute(session, options = {}) {
  if (!session || typeof session.id !== 'string') return session;
  if (
    typeof session.wtSession === 'string' && WT_SESSION_RE.test(session.wtSession) &&
    normalizeWindowsPid(session.wtProcessId) &&
    normalizeWindowHandle(session.wtHwnd) && normalizeRuntimeId(session.wtTabRuntimeId)
  ) return session;

  const readCachedRoute = options.readCachedRoute || readCachedWindowsTerminalTabRoute;
  let cached = null;
  try { cached = readCachedRoute(session.id); } catch {}
  if (!cached) return session;

  // A reused UI session id must never be allowed to cross-wire two Terminal
  // sessions. The disk route is accepted only when the WT_SESSION identities
  // agree, or when the in-memory event has not supplied one yet.
  const currentWtSession = typeof session.wtSession === 'string'
    ? session.wtSession.trim().replace(/^\{([^}]+)\}$/, '$1').toLowerCase()
    : null;
  if (currentWtSession && currentWtSession !== cached.wtSession) return session;
  return { ...session, ...cached };
}

function activateWindowsTerminalTab(session, options = {}) {
  const windowHandle = normalizeWindowHandle(session && session.wtHwnd);
  const runtimeId = normalizeRuntimeId(session && session.wtTabRuntimeId);
  if (!windowHandle || !runtimeId) return Promise.resolve({ ok: false, reason: 'route-missing' });
  const helperPath = options.helperPath || WINDOWS_TERMINAL_HELPER;
  const execFileFn = options.execFile || execFile;

  return new Promise((resolve) => {
    execFileFn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', helperPath,
      '-WindowHandle', windowHandle,
      '-RuntimeId', runtimeId.join(','),
    ], { timeout: 3500, windowsHide: true }, (error, stdout, stderr) => {
      const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
      let parsed = null;
      try { parsed = JSON.parse(lines[lines.length - 1] || ''); } catch {}
      if (parsed && parsed.ok === true) {
        resolve({ ok: true });
        return;
      }
      const reason = parsed && typeof parsed.reason === 'string'
        ? parsed.reason
        : error && error.killed ? 'helper-timeout'
          : error ? 'helper-failed' : 'invalid-helper-output';
      if (stderr) log('focus', `Windows Terminal helper: ${String(stderr).trim().slice(0, 300)}`);
      resolve({ ok: false, reason });
    });
  });
}

function parseTerminalFocusBrokerResponse(line) {
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { return { ok: false, reason: 'invalid-broker-output' }; }
  if (parsed && parsed.ok === true) return { ok: true };
  const reason = parsed && typeof parsed.reason === 'string' && /^[a-z0-9-]{1,64}$/.test(parsed.reason)
    ? parsed.reason : 'broker-failed';
  return { ok: false, reason };
}

function finishBrokerPending(channel, reason) {
  const pending = channel.pending.splice(0);
  for (const request of pending) {
    clearTimeout(request.timer);
    request.resolve({ ok: false, reason });
  }
}

function getTerminalFocusBrokerChannel(pipePath) {
  if (terminalFocusBrokerChannels.has(pipePath)) return terminalFocusBrokerChannels.get(pipePath);
  const channel = {
    pipePath,
    server: null,
    socket: null,
    buffer: '',
    pending: [],
    connectionWaiters: [],
    startError: null,
    ready: null,
  };
  channel.server = net.createServer((socket) => {
    if (channel.socket && !channel.socket.destroyed) {
      finishBrokerPending(channel, 'broker-disconnected');
      channel.socket.destroy();
    }
    channel.socket = socket;
    channel.buffer = '';
    socket.setEncoding('utf8');
    if (typeof socket.unref === 'function') socket.unref();
    const waiters = channel.connectionWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(socket);
    }
    socket.on('data', (chunk) => {
      channel.buffer += String(chunk || '');
      if (channel.buffer.length > 8192) {
        finishBrokerPending(channel, 'broker-response-too-large');
        socket.destroy();
        return;
      }
      let newline = channel.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = channel.buffer.slice(0, newline).replace(/\r$/, '');
        channel.buffer = channel.buffer.slice(newline + 1);
        const request = channel.pending.shift();
        if (request) {
          clearTimeout(request.timer);
          request.resolve(parseTerminalFocusBrokerResponse(line));
        }
        newline = channel.buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (channel.socket !== socket) return;
      channel.socket = null;
      channel.buffer = '';
      finishBrokerPending(channel, 'broker-disconnected');
    });
  });
  channel.ready = new Promise((resolve) => {
    let ready = false;
    const finishReady = () => {
      if (ready) return;
      ready = true;
      resolve();
    };
    channel.server.on('error', (error) => {
      channel.startError = error;
      finishReady();
      finishBrokerPending(channel, 'broker-unavailable');
    });
    channel.server.listen(pipePath, () => {
      if (typeof channel.server.unref === 'function') channel.server.unref();
      finishReady();
    });
  });
  terminalFocusBrokerChannels.set(pipePath, channel);
  return channel;
}

async function waitForTerminalFocusBroker(channel, timeoutMs) {
  await channel.ready;
  if (channel.startError) return null;
  if (channel.socket && !channel.socket.destroyed) return channel.socket;
  return new Promise((resolve) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const index = channel.connectionWaiters.indexOf(waiter);
      if (index >= 0) channel.connectionWaiters.splice(index, 1);
      resolve(null);
    }, timeoutMs);
    channel.connectionWaiters.push(waiter);
  });
}

async function requestTerminalFocusBroker(payload, options = {}) {
  const pipePath = options.pipePath || TERMINAL_FOCUS_BROKER_PIPE;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 3500;
  const channel = getTerminalFocusBrokerChannel(pipePath);
  const socket = await waitForTerminalFocusBroker(channel, timeoutMs);
  if (!socket) return { ok: false, reason: 'broker-unavailable' };
  return new Promise((resolve) => {
    const request = { resolve, timer: null };
    request.timer = setTimeout(() => {
      const index = channel.pending.indexOf(request);
      if (index >= 0) channel.pending.splice(index, 1);
      resolve({ ok: false, reason: 'broker-timeout' });
      if (channel.socket === socket && !socket.destroyed) socket.destroy();
    }, timeoutMs);
    channel.pending.push(request);
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
    } catch {
      clearTimeout(request.timer);
      const index = channel.pending.indexOf(request);
      if (index >= 0) channel.pending.splice(index, 1);
      resolve({ ok: false, reason: 'broker-failed' });
    }
  });
}

function closeTerminalFocusBrokerChannel(pipePath = TERMINAL_FOCUS_BROKER_PIPE) {
  const channel = terminalFocusBrokerChannels.get(pipePath);
  if (!channel) return;
  terminalFocusBrokerChannels.delete(pipePath);
  finishBrokerPending(channel, 'broker-unavailable');
  for (const waiter of channel.connectionWaiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
  if (channel.socket && !channel.socket.destroyed) channel.socket.destroy();
  try { channel.server.close(); } catch {}
}

// UI Automation cannot cross from a medium-integrity desktop pet into an
// elevated Windows Terminal. Users can explicitly enable a per-user logon task
// whose launcher requests elevation once for that desktop session. Subsequent
// clicks send only the bound numeric window and UI Automation RuntimeId.
function activateWindowsTerminalTabBroker(session, options = {}) {
  const windowHandle = normalizeWindowHandle(session && session.wtHwnd);
  const runtimeId = normalizeRuntimeId(session && session.wtTabRuntimeId);
  if (!windowHandle || !runtimeId) return Promise.resolve({ ok: false, reason: 'route-missing' });
  const request = options.request || requestTerminalFocusBroker;
  return request({
    protocol: 1,
    operation: 'focus-windows-terminal-tab',
    windowHandle,
    runtimeId,
  }, options);
}

async function shutdownTerminalFocusBroker(options = {}) {
  const pipePath = options.pipePath || TERMINAL_FOCUS_BROKER_PIPE;
  const result = await requestTerminalFocusBroker({ protocol: 1, operation: 'shutdown' }, {
    ...options,
    pipePath,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 800,
  });
  closeTerminalFocusBrokerChannel(pipePath);
  return result;
}

// Returns true if it actually focused a window for this session.
async function focusSession(session) {
  if (!session) return false;
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    log('focus', `focusSession: ${process.platform} not supported yet`);
    return false;
  }
  const seen = new Set();
  const candidates = [];
  if (session.sourcePid) candidates.push(session.sourcePid);
  if (Array.isArray(session.pidChain)) for (const p of session.pidChain) candidates.push(p);

  if (process.platform === 'win32') {
    const ordered = [...new Set(candidates)];
    const focused = await activateWinPids(ordered);
    if (focused) {
      log('focus', `focused pid ${focused} for session ${String(session.id).slice(-6)}`);
      return true;
    }
    log('focus', `could not focus session ${String(session.id).slice(-6)} (pids ${ordered.join(',') || 'none'})`);
    return false;
  }

  for (const pid of candidates) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    // eslint-disable-next-line no-await-in-loop
    if (await activateMacPid(pid)) {
      log('focus', `focused pid ${pid} for session ${String(session.id).slice(-6)}`);
      return true;
    }
  }
  log('focus', `could not focus session ${String(session.id).slice(-6)} (pids ${candidates.join(',') || 'none'})`);
  return false;
}

async function focusSessionTarget(session, options = {}) {
  if (!session) return { ok: false, route: 'failed', reason: 'session-not-found' };
  const platform = options.platform || process.platform;
  const legacyFocus = options.legacyFocus || focusSession;
  if (platform !== 'win32') {
    const focused = await legacyFocus(session);
    return focused
      ? { ok: true, route: 'terminal-window' }
      : { ok: false, route: 'failed', reason: 'focus-unsupported' };
  }

  const target = hydrateWindowsTerminalTabRoute(session, options);

  if (
    typeof target.wtSession !== 'string' ||
    !WT_SESSION_RE.test(target.wtSession) ||
    !normalizeWindowsPid(target.wtProcessId) ||
    !normalizeWindowHandle(target.wtHwnd) ||
    !normalizeRuntimeId(target.wtTabRuntimeId)
  ) {
    return { ok: false, route: 'failed', reason: 'route-missing' };
  }

  const exactFocus = options.exactFocus || activateWindowsTerminalTab;
  const exact = await exactFocus(target);
  if (exact && exact.ok) {
    log('focus', `focused Windows Terminal tab for session ${String(session.id).slice(-6)}`);
    return { ok: true, route: 'windows-terminal-tab' };
  }
  let reason = exact && exact.reason || 'tab-unavailable';
  if (reason === 'elevation-required') {
    const brokerFocus = options.brokerFocus || activateWindowsTerminalTabBroker;
    const broker = await brokerFocus(target);
    if (broker && broker.ok) {
      log('focus', `focused elevated Windows Terminal tab via broker for session ${String(session.id).slice(-6)}`);
      return { ok: true, route: 'windows-terminal-tab-broker' };
    }
    reason = broker && broker.reason || 'broker-unavailable';
  }
  log('focus', `exact tab focus failed for session ${String(session.id).slice(-6)}: ${reason}`);
  return { ok: false, route: 'failed', reason };
}

module.exports = {
  focusSession,
  focusSessionTarget,
  activateWindowsTerminalTab,
  activateWindowsTerminalTabBroker,
  requestTerminalFocusBroker,
  closeTerminalFocusBrokerChannel,
  shutdownTerminalFocusBroker,
  terminalFocusProfileKey,
  terminalFocusBrokerPipeName,
  terminalFocusBrokerPipePath,
  WT_SESSION_RE,
  normalizeWindowHandle,
  normalizeRuntimeId,
  hydrateWindowsTerminalTabRoute,
  WINDOWS_TERMINAL_HELPER,
  WINDOWS_TERMINAL_BROKER,
  WINDOWS_TERMINAL_BROKER_INSTALLER,
  TERMINAL_FOCUS_BROKER_PIPE,
};
