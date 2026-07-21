'use strict';

// focusSession(session) — bring the terminal window/app that owns a Claude Code
// session to the foreground, for the pet's left-click / "💬 去回复".
//
// Our hook reports source_pid as the terminal process plus a pid_chain. On macOS
// we activate the GUI app that owns one of those pids via System Events, and we
// return whether a process was ACTUALLY matched (osascript exits 0 even when no
// process matched, so we check its stdout). Windows/Linux focus needs native
// helpers and is a known gap for v1 — focusSession returns false there so the
// caller can fall back (e.g. open the panel).

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

// Returns true if it actually focused a window for this session.
async function focusSession(session) {
  if (!session) return false;
  if (process.platform !== 'darwin') {
    log('focus', `focusSession: ${process.platform} not supported yet`);
    return false;
  }
  const seen = new Set();
  const candidates = [];
  if (session.sourcePid) candidates.push(session.sourcePid);
  if (Array.isArray(session.pidChain)) for (const p of session.pidChain) candidates.push(p);
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
