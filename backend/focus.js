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
const path = require('path');
const { log } = require('./log');
const { readCachedWindowsTerminalTabRoute } = require('./pidwalk');

const WT_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOWS_TERMINAL_HELPER = path.join(__dirname, 'focus-windows-terminal.ps1');

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

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// UI Automation cannot cross from a medium-integrity desktop pet into an
// elevated Windows Terminal. Retry only that explicitly diagnosed case with a
// one-shot RunAs helper. The elevated process receives a fixed script path and
// already-normalized numeric route; it cannot launch a shell/tab or run an
// arbitrary user command.
function activateWindowsTerminalTabElevated(session, options = {}) {
  const windowHandle = normalizeWindowHandle(session && session.wtHwnd);
  const runtimeId = normalizeRuntimeId(session && session.wtTabRuntimeId);
  if (!windowHandle || !runtimeId) return Promise.resolve({ ok: false, reason: 'route-missing' });
  const helperPath = options.helperPath || WINDOWS_TERMINAL_HELPER;
  const execFileFn = options.execFile || execFile;
  const innerCommand = [
    '&', psSingleQuote(helperPath),
    '-WindowHandle', psSingleQuote(windowHandle),
    '-RuntimeId', psSingleQuote(runtimeId.join(',')),
  ].join(' ');
  const encodedCommand = Buffer.from(innerCommand, 'utf16le').toString('base64');
  const launcher = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand'," + psSingleQuote(encodedCommand) + ')',
    "  if ($process.ExitCode -eq 0) { Write-Output '{\"ok\":true,\"reason\":\"focused-elevated\"}'; exit 0 }",
    "  Write-Output '{\"ok\":false,\"reason\":\"elevated-helper-failed\"}'; exit 1",
    '} catch {',
    "  Write-Output '{\"ok\":false,\"reason\":\"elevation-denied\"}'; exit 2",
    '}',
  ].join('\n');

  return new Promise((resolve) => {
    execFileFn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', launcher,
    ], { timeout: 30000, windowsHide: true }, (error, stdout) => {
      const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
      let parsed = null;
      try { parsed = JSON.parse(lines[lines.length - 1] || ''); } catch {}
      if (parsed && parsed.ok === true) {
        resolve({ ok: true });
        return;
      }
      resolve({
        ok: false,
        reason: parsed && typeof parsed.reason === 'string'
          ? parsed.reason
          : error && error.killed ? 'helper-timeout' : 'elevation-denied',
      });
    });
  });
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
    const elevatedFocus = options.elevatedFocus || activateWindowsTerminalTabElevated;
    const elevated = await elevatedFocus(target);
    if (elevated && elevated.ok) {
      log('focus', `focused elevated Windows Terminal tab for session ${String(session.id).slice(-6)}`);
      return { ok: true, route: 'windows-terminal-tab-elevated' };
    }
    reason = elevated && elevated.reason || 'elevation-denied';
  }
  log('focus', `exact tab focus failed for session ${String(session.id).slice(-6)}: ${reason}`);
  return { ok: false, route: 'failed', reason };
}

module.exports = {
  focusSession,
  focusSessionTarget,
  activateWindowsTerminalTab,
  activateWindowsTerminalTabElevated,
  WT_SESSION_RE,
  normalizeWindowHandle,
  normalizeRuntimeId,
  hydrateWindowsTerminalTabRoute,
  WINDOWS_TERMINAL_HELPER,
};
