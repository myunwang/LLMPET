'use strict';

// CodeWhale hook installer — merges a managed block into ~/.codewhale/config.toml.
//
// Verified contract (CodeWhale docs/HOOKS.md + hooks/executor source):
//   [[hooks.hooks]]
//   event = "..."            # one of the 11 lifecycle event names
//   command = "sh-compatible string"   # Unix: sh -c; Windows: cmd /C
//   name = "..."             # optional label
//   timeout_secs = 30        # optional, default 30
//   background = false       # optional; true = fire-and-forget (cannot steer)
//   continue_on_error = true # optional; false = strict gate (timeout → deny)
//
// Two upstream gotchas this installer accounts for:
//   • [hooks].default_timeout_secs, when set by the user, OVERRIDES every
//     per-hook timeout_secs — we cannot win that fight, so the permission
//     holder independently answers "deny" at 8 minutes and CodeWhale's own
//     timeout behavior (allow for non-strict gates) is never relied upon.
//   • A hook that never answers defaults to ALLOW on timeout. Our
//     tool_call_before entry is therefore a strict gate (continue_on_error =
//     false): an unresponsive LLMPET fails CLOSED (deny), never open.
//
// Merge safety: only the block between our BEGIN/END markers is managed.
// User TOML outside the markers is preserved byte-for-byte, never reordered.
// Writes are atomic (tmp + rename) with 0600 permissions.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveNodeBin } = require('./transport');

const CONFIG = process.env.CODEWHALE_CONFIG || path.join(os.homedir(), '.codewhale', 'config.toml');
const HOOK = path.join(__dirname, '..', 'hook', 'codewhale-hook.js');
const BEGIN = '# BEGIN LLMPET CODEWHALE HOOKS';
const END = '# END LLMPET CODEWHALE HOOKS';

// The 10 lifecycle events (shell_env deliberately not registered — it is an
// exec_shell env injector, not a lifecycle hook). Names verified against
// CodeWhale's ALL_HOOK_EVENTS; `turn_start`/`error` do not exist upstream.
const EVENTS = [
  'session_start', 'session_end', 'message_submit',
  'tool_call_before', 'tool_call_after', 'turn_end',
  'subagent_spawn', 'subagent_complete', 'on_error', 'mode_change',
];

function entryFor(event) {
  const isGate = event === 'tool_call_before';
  return [
    '[[hooks.hooks]]',
    `event = ${JSON.stringify(event)}`,
    `command = ${JSON.stringify(`${resolveNodeBin()} ${HOOK} ${event}`)}`,
    'name = "llmpet"',
    `timeout_secs = ${isGate ? 600 : 5}`,
    // Observer hooks are best-effort: a crashed pet must never break the TUI.
    // The permission gate is the opposite — strict, so an unreachable pet
    // denies instead of CodeWhale's default allow-on-timeout.
    `continue_on_error = ${isGate ? 'false' : 'true'}`,
    // Observers run in the BACKGROUND: verified upstream semantics — a
    // background hook receives the identical env vars and stdin JSON, is
    // submitted to a 32-entry supervisor queue and never awaited, and its
    // stdout is discarded (we print nothing on observers anyway). Foreground
    // observers are awaited in config order inside a worker, so every state
    // sync would ride the turn's critical path. The gate must stay
    // foreground: its stdout IS the verdict (CodeWhale warns when a
    // background hook tries to steer).
    `background = ${isGate ? 'false' : 'true'}`,
  ].join('\n');
}

function managedBlock() {
  return [BEGIN, ...EVENTS.map(entryFor), END].join('\n\n');
}

function strip(raw) {
  const start = raw.indexOf(BEGIN);
  if (start < 0) return raw;
  const end = raw.indexOf(END, start);
  if (end < 0) return raw.slice(0, start);
  return raw.slice(0, start) + raw.slice(end + END.length).replace(/^\r?\n/, '');
}

function install() {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  let raw = '';
  try { raw = fs.readFileSync(CONFIG, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const clean = strip(raw).replace(/\s+$/, '');
  const next = `${clean}${clean ? '\n\n' : ''}${managedBlock()}\n`;
  const tmp = `${CONFIG}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);
  return { installed: EVENTS.length, path: CONFIG };
}

function uninstall() {
  let raw;
  try { raw = fs.readFileSync(CONFIG, 'utf8'); } catch { return { removed: 0 }; }
  const next = strip(raw);
  if (next === raw) return { removed: 0 };
  const tmp = `${CONFIG}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);
  return { removed: EVENTS.length };
}

module.exports = { install, uninstall, CONFIG, EVENTS, managedBlock, entryFor };
