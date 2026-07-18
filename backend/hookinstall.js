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
const { buildPermissionUrl, resolveNodeBin, PORTS, BASE_PORT } = require('./transport');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'octopus-hook.js');
const HOOK_MARKER = 'octopus-hook.js';

// When inside an asar archive, hook/ is unpacked to app.asar.unpacked/hook/.
// System node (used by Claude Code to run hooks) cannot read asar virtual
// paths, so point the command at the real filesystem path.
function resolveHookScriptPath() {
  const p = HOOK_SCRIPT;
  if (p.includes('.asar' + path.sep)) {
    return p.replace(/\.asar([\\/])/, '.asar.unpacked$1');
  }
  return p;
}
const MARKER = 'octopus-hook.js';
const STATE_TIMEOUT_S = 5;
const PERMISSION_TIMEOUT_S = 600;

const COMMAND_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'Notification', 'Elicitation',
];

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`read settings.json: ${err.message}`);
  }
}

function writeAtomic(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = path.join(path.dirname(SETTINGS_PATH), `.settings.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

function commandHook(nodeBin, event) {
  const cmd = `"${nodeBin}" "${resolveHookScriptPath()}" ${event}`;
  if (process.platform === 'win32') {
    return { type: 'command', shell: 'powershell', command: `& ${cmd}`, timeout: STATE_TIMEOUT_S };
  }
  return { type: 'command', command: cmd, timeout: STATE_TIMEOUT_S };
}

function isOurCommand(hook) {
  return hook && typeof hook.command === 'string' && hook.command.includes(MARKER);
}
function isOurHttp(hook, permUrls) {
  return hook && hook.type === 'http' && typeof hook.url === 'string' && permUrls.has(hook.url);
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
  const permUrls = new Set(PORTS.map(buildPermissionUrl));
  const result = { added: 0, updated: 0, skipped: 0, purged: purgeLegacy(settings.hooks) };

  for (const event of COMMAND_EVENTS) {
    const r = syncEvent(settings.hooks, event, commandHook(nodeBin, event), isOurCommand);
    result[r]++;
  }
  const httpDesired = { type: 'http', url: buildPermissionUrl(port || BASE_PORT), timeout: PERMISSION_TIMEOUT_S };
  const r = syncEvent(settings.hooks, 'PermissionRequest', httpDesired, (h) => isOurHttp(h, permUrls));
  result[r]++;

  writeAtomic(settings);
  return { ...result, nodeBin };
}

function removeOurHooks(hooks, permUrls) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = [];
    for (const group of hooks[event]) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { groups.push(group); continue; }
      const kept = group.hooks.filter((h) => {
        if (isOurCommand(h) || isOurHttp(h, permUrls)) { removed++; return false; }
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
  const permUrls = new Set(PORTS.map(buildPermissionUrl));
  const removed = removeOurHooks(settings.hooks, permUrls) + purgeLegacy(settings.hooks);
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
  try { return fs.readFileSync(SETTINGS_PATH, 'utf8').includes(MARKER); } catch { return false; }
}

module.exports = { registerHooks, unregisterHooks, markerPresent, SETTINGS_PATH, HOOK_SCRIPT, MARKER, COMMAND_EVENTS };

// CLI: `node backend/hookinstall.js` installs; `--uninstall` removes.
if (require.main === module) {
  if (process.argv.includes('--uninstall')) {
    console.log(unregisterHooks({ backup: true }));
  } else {
    console.log(registerHooks(require('./transport').readRuntimePort()));
  }
}
