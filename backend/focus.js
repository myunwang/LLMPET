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
const path = require('path');
const { log } = require('./log');
const { launchCliInRecentWindowsTerminal } = require('./launch');

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
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

function sessionPids(session) {
  const candidates = [];
  if (session && Array.isArray(session.pidChain)) candidates.push(...session.pidChain);
  if (session && session.sourcePid) candidates.push(session.sourcePid);
  return [...new Set(candidates.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function activateWindowsTerminalTab(pids, options = {}) {
  const candidates = [...new Set((pids || []).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!candidates.length) return Promise.resolve({ ok: false, reason: 'no-live-pid' });
  const marker = options.marker || `LLMPET-${crypto.randomUUID().replace(/-/g, '')}`;
  const helperPath = options.helperPath || WINDOWS_TERMINAL_HELPER;
  const execFileFn = options.execFile || execFile;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;

  return new Promise((resolve) => {
    execFileFn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', helperPath,
      '-PidList', candidates.join(','),
      '-Marker', marker,
      '-TimeoutMs', String(timeoutMs),
    ], { timeout: timeoutMs + 2000, windowsHide: true }, (error, stdout, stderr) => {
      const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
      let parsed = null;
      try { parsed = JSON.parse(lines[lines.length - 1] || ''); } catch {}
      if (parsed && parsed.ok === true) {
        resolve({ ok: true, pid: Number(parsed.pid) || null });
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

async function resumeSessionInWindowsTerminal(session, options = {}) {
  const sessionId = session && typeof session.id === 'string' ? session.id.trim() : '';
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, reason: 'invalid-session-id' };
  const cli = session.agentId === 'codex' ? 'codex' : 'claude';
  const args = cli === 'codex' ? ['resume', sessionId] : ['--resume', sessionId];
  const launcher = options.launcher || launchCliInRecentWindowsTerminal;
  const launched = await launcher(cli, { cwd: session.cwd, args });
  if (!launched || !launched.ok) {
    return { ok: false, reason: launched && (launched.code || launched.message) || 'resume-failed' };
  }
  return { ok: true, route: 'resumed-tab' };
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

  const resume = options.resume || resumeSessionInWindowsTerminal;
  const resumeTarget = async () => {
    const result = await resume(session);
    if (result && result.ok) return result;
    return { ok: false, route: 'failed', reason: result && result.reason || 'resume-failed' };
  };

  const pids = sessionPids(session);
  const isAlive = options.pidAlive || pidAlive;
  const livePids = pids.filter((pid) => isAlive(pid));
  if (session.ended === true || session.state === 'sleeping' || !livePids.length) {
    return resumeTarget();
  }

  if (typeof session.wtSession === 'string' && WT_SESSION_RE.test(session.wtSession)) {
    const exactFocus = options.exactFocus || activateWindowsTerminalTab;
    const exact = await exactFocus(livePids);
    if (exact && exact.ok) {
      log('focus', `focused Windows Terminal tab for session ${String(session.id).slice(-6)}`);
      return { ok: true, route: 'windows-terminal-tab' };
    }
    log('focus', `exact tab focus failed for session ${String(session.id).slice(-6)}: ${exact && exact.reason || 'unknown'}`);
    return resumeTarget();
  }

  if (await legacyFocus(session)) return { ok: true, route: 'windows-terminal-window' };
  return resumeTarget();
}

module.exports = {
  focusSession,
  focusSessionTarget,
  activateWindowsTerminalTab,
  resumeSessionInWindowsTerminal,
  sessionPids,
  pidAlive,
  SESSION_ID_RE,
  WT_SESSION_RE,
  WINDOWS_TERMINAL_HELPER,
};
