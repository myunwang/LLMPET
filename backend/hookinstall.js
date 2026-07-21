'use strict';

// Merge-safe Claude Code hook installer (original implementation).
//
// Registers, into ~/.claude/settings.json:
//   • command hooks for the lifecycle events the pet reacts to — each runs
//     `"<node>" "<hook>" <Event>`
//   • one blocking HTTP hook for PermissionRequest → our /permission endpoint
//
// Safety (the whole point of doing this ourselves):
//   • we ONLY add/update entries whose command contains our hook filename, or
//     whose http url is our permission url — every other hook the user has is
//     left byte-for-byte untouched;
//   • writes are atomic (tmp + rename);
//   • uninstall backs the file up first.
//
// The settings.hooks shape is Claude Code's documented hook interface.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPermissionUrl, resolveNodeBin, readRuntimeConfig, PORTS, BASE_PORT, PERMISSION_PATH } = require('./transport');
const { commandForNode } = require('./shell-quote');
const { readTextBoundedSync } = require('./safe-json');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'octopus-hook.js');
const PRETOOL_HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'pretool-hook.js');
const MARKER = 'octopus-hook.js';
const PRETOOL_MARKER = 'pretool-hook.js';
const STATE_TIMEOUT_S = 5;
const PERMISSION_TIMEOUT_S = 600;
const MAX_SETTINGS_BYTES = 16 * 1024 * 1024;

const COMMAND_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'Notification', 'Elicitation',
];

function readSettings() {
  try {
    const raw = readTextBoundedSync(SETTINGS_PATH, MAX_SETTINGS_BYTES);
    const obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`read settings.json: ${err.message}`);
  }
}

function writeAtomic(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(SETTINGS_PATH), 0o700); } catch {}
  const tmp = path.join(path.dirname(SETTINGS_PATH), `.settings.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, SETTINGS_PATH);
  try { fs.chmodSync(SETTINGS_PATH, 0o600); } catch {}
}

function commandHook(nodeBin, event) {
  const command = commandForNode(nodeBin, HOOK_SCRIPT, event);
  if (process.platform === 'win32') {
    return { type: 'command', shell: 'powershell', command, timeout: STATE_TIMEOUT_S };
  }
  return { type: 'command', command, timeout: STATE_TIMEOUT_S };
}

// PreToolUse permission hook — runs BEFORE CC's permission system to auto-allow
// low-risk tools. Installed as a second PreToolUse entry alongside the state
// tracking hook. No timeout: it must complete instantly (< 1s).
function pretoolCommandHook(nodeBin) {
  const command = commandForNode(nodeBin, PRETOOL_HOOK_SCRIPT, 'PreToolUse');
  if (process.platform === 'win32') {
    return { type: 'command', shell: 'powershell', command, timeout: 5 };
  }
  return { type: 'command', command, timeout: 5 };
}

function isOurCommand(hook) {
  return hook && typeof hook.command === 'string' && (hook.command.includes(MARKER) || hook.command.includes(PRETOOL_MARKER));
}
function isOurHttp(hook) {
  if (!hook || hook.type !== 'http' || typeof hook.url !== 'string') return false;
  try {
    const u = new URL(hook.url);
    const port = Number(u.port || 80);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && PORTS.includes(port) && u.pathname === PERMISSION_PATH;
  } catch { return false; }
}

// Only OUR OWN earlier hook name (this app used to be "llmpet"). We deliberately
// do NOT touch any other app's hooks: another tool may be running with its own
// settings watcher, and tearing out its hooks would just start a rewrite war
// over settings.json. Removing another app's hooks is the user's call.
const LEGACY_MARKERS = ['llmpet-hook.js'];
function isLegacyCommand(hook) {
  return hook && typeof hook.command === 'string' && LEGACY_MARKERS.some((m) => hook.command.includes(m));
}
function purgeLegacy(hooks) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = [];
    for (const group of hooks[event]) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { groups.push(group); continue; }
      const kept = group.hooks.filter((h) => {
        if (isLegacyCommand(h)) { removed++; return false; }
        return true;
      });
      if (kept.length) groups.push({ ...group, hooks: kept });
    }
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  return removed;
}

// Ensure `event` has exactly one of our hooks (matching `match`), kept in sync
// with `desired`. Returns counts. Leaves all non-matching entries untouched.
function syncEvent(hooks, event, desired, match) {
  if (!Array.isArray(hooks[event])) {
    const existing = hooks[event];
    hooks[event] = existing && typeof existing === 'object' ? [existing] : [];
  }
  for (const group of hooks[event]) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (match(h)) {
        let changed = false;
        for (const k of Object.keys(desired)) {
          if (h[k] !== desired[k]) { h[k] = desired[k]; changed = true; }
        }
        return changed ? 'updated' : 'skipped';
      }
    }
  }
  hooks[event].push({ matcher: '', hooks: [desired] });
  return 'added';
}

function registerHooks(port) {
  const nodeBin = resolveNodeBin();
  const settings = readSettings();
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const runtime = readRuntimeConfig();
  const selectedPort = Number(port || (runtime && runtime.port) || BASE_PORT);
  if (!runtime || runtime.port !== selectedPort) throw new Error('Octopus server runtime token unavailable; start the app before installing hooks');
  const result = { added: 0, updated: 0, skipped: 0, purged: purgeLegacy(settings.hooks) };

  for (const event of COMMAND_EVENTS) {
    const r = syncEvent(settings.hooks, event, commandHook(nodeBin, event), isOurCommand);
    result[r]++;
  }
  // Install the pretool permission hook as an ADDITIONAL PreToolUse entry.
  // Using PRETOOL_MARKER as the matcher so we can distinguish it from the
  // state-tracking hook (MARKER) and update/replace independently.
  const pretoolDesired = pretoolCommandHook(nodeBin);
  const isOurPreTool = (hook) => hook && typeof hook.command === 'string' && hook.command.includes(PRETOOL_MARKER);
  if (!settings.hooks.PreToolUse || !Array.isArray(settings.hooks.PreToolUse)) {
    settings.hooks.PreToolUse = [];
  }
  let pretoolFound = false;
  for (const group of settings.hooks.PreToolUse) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (isOurPreTool(h)) {
        let changed = false;
        for (const k of Object.keys(pretoolDesired)) {
          if (h[k] !== pretoolDesired[k]) { h[k] = pretoolDesired[k]; changed = true; }
        }
        if (changed) result.updated++;
        else result.skipped++;
        pretoolFound = true;
        break;
      }
    }
    if (pretoolFound) break;
  }
  if (!pretoolFound) {
    settings.hooks.PreToolUse.push({ matcher: '', hooks: [pretoolDesired] });
    result.added++;
  }

  const httpDesired = { type: 'http', url: buildPermissionUrl(selectedPort, runtime.token), timeout: PERMISSION_TIMEOUT_S };
  const r = syncEvent(settings.hooks, 'PermissionRequest', httpDesired, isOurHttp);
  result[r]++;

  writeAtomic(settings);
  return { ...result, nodeBin };
}

function removeOurHooks(hooks) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = [];
    for (const group of hooks[event]) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { groups.push(group); continue; }
      const kept = group.hooks.filter((h) => {
        if (isOurCommand(h) || isOurHttp(h)) { removed++; return false; }
        return true;
      });
      if (kept.length) groups.push({ ...group, hooks: kept });
      else if (typeof group.command === 'string' && !group.command.includes(MARKER)) groups.push(group);
    }
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  return removed;
}

function unregisterHooks(options = {}) {
  let settings;
  try { settings = readSettings(); } catch { return { removed: 0 }; }
  if (!settings.hooks) return { removed: 0 };
  const removed = removeOurHooks(settings.hooks) + purgeLegacy(settings.hooks);
  if (!removed) return { removed: 0 };
  let backupPath = null;
  if (options.backup) {
    try {
      backupPath = `${SETTINGS_PATH}.octopus-backup-${Date.now()}.bak`;
      fs.copyFileSync(SETTINGS_PATH, backupPath);
    } catch { backupPath = null; }
  }
  writeAtomic(settings);
  return { removed, backupPath };
}

function markerPresent() {
  try { return readTextBoundedSync(SETTINGS_PATH, MAX_SETTINGS_BYTES).includes(MARKER); } catch { return false; }
}

module.exports = { registerHooks, unregisterHooks, markerPresent, SETTINGS_PATH, HOOK_SCRIPT, PRETOOL_HOOK_SCRIPT, MARKER, PRETOOL_MARKER, COMMAND_EVENTS };

// CLI: `node backend/hookinstall.js` installs; `--uninstall` removes.
if (require.main === module) {
  if (process.argv.includes('--uninstall')) {
    console.log(unregisterHooks({ backup: true }));
  } else {
    console.log(registerHooks(require('./transport').readRuntimePort()));
  }
}
