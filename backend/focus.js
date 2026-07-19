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
const { log } = require('./log');

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

module.exports = { focusSession };
