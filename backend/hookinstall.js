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
const {
  buildPermissionUrl,
  resolveNodeBin,
  readRuntimeConfig,
  validToken,
  PORTS,
  BASE_PORT,
} = require('./transport');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'octopus-hook.js');
const MARKER = 'octopus-hook.js';
// Read-only Bash auto-allow gate (Claude Code PreToolUse, matcher "Bash").
// Distinct marker so it can coexist with the state hook on the same event.
const PRETOOL_SCRIPT = path.join(__dirname, '..', 'hook', 'pretool-hook.js');
const PRETOOL_MARKER = 'pretool-hook.js';
const PRETOOL_MATCHER = 'Bash';
const STATE_TIMEOUT_S = 5;
const PERMISSION_TIMEOUT_S = 600;

const COMMAND_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'Notification', 'Elicitation', 'ElicitationResult',
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
  const cmd = `"${nodeBin}" "${HOOK_SCRIPT}" ${event}`;
  if (process.platform === 'win32') {
    return { type: 'command', shell: 'powershell', command: `& ${cmd}`, timeout: STATE_TIMEOUT_S };
  }
  return { type: 'command', command: cmd, timeout: STATE_TIMEOUT_S };
}

function preToolHook(nodeBin) {
  const cmd = `"${nodeBin}" "${PRETOOL_SCRIPT}"`;
  if (process.platform === 'win32') {
    return { type: 'command', shell: 'powershell', command: `& ${cmd}`, timeout: STATE_TIMEOUT_S };
  }
  return { type: 'command', command: cmd, timeout: STATE_TIMEOUT_S };
}

function isOurCommand(hook) {
  return hook && typeof hook.command === 'string' && hook.command.includes(MARKER);
}
function isOurPreTool(hook) {
  return hook && typeof hook.command === 'string' && hook.command.includes(PRETOOL_MARKER);
}
function isOurHttp(hook) {
  if (!hook || hook.type !== 'http' || typeof hook.url !== 'string') return false;
  try {
    const url = new URL(hook.url);
    return url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      PORTS.includes(Number(url.port)) &&
      url.pathname === '/permission';
  } catch {
    return false;
  }
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
// `matcher` only labels the group we append when nothing matched yet.
function syncEvent(hooks, event, desired, match, matcher = '') {
  if (!Array.isArray(hooks[event])) {
    const existing = hooks[event];
    hooks[event] = existing && typeof existing === 'object' ? [existing] : [];
  }
  let kept = null;
  let changed = false;
  let duplicateCount = 0;
  const groups = [];
  for (const group of hooks[event]) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      groups.push(group);
      continue;
    }
    const nextHooks = [];
    let matchedInGroup = 0;
    for (const h of group.hooks) {
      if (!match(h)) {
        nextHooks.push(h);
        continue;
      }
      matchedInGroup++;
      if (kept) {
        duplicateCount++;
        continue;
      }
      kept = h;
      for (const k of Object.keys(desired)) {
        if (h[k] !== desired[k]) { h[k] = desired[k]; changed = true; }
      }
      nextHooks.push(h);
    }
    // Removing an ours-only duplicate group is safe; other apps' groups and
    // malformed entries are preserved byte-for-byte in spirit.
    if (nextHooks.length || matchedInGroup === 0) groups.push({ ...group, hooks: nextHooks });
  }
  if (!kept) {
    groups.push({ matcher, hooks: [desired] });
    hooks[event] = groups;
    return 'added';
  }
  hooks[event] = groups;
  return changed || duplicateCount ? 'updated' : 'skipped';
}

function registerHooks(port, token) {
  if (!validToken(token)) throw new Error('runtime authentication token unavailable');
  const nodeBin = resolveNodeBin();
  const settings = readSettings();
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const result = { added: 0, updated: 0, skipped: 0, purged: purgeLegacy(settings.hooks) };

  for (const event of COMMAND_EVENTS) {
    const r = syncEvent(settings.hooks, event, commandHook(nodeBin, event), isOurCommand);
    result[r]++;
  }
  // Read-only Bash gate on PreToolUse (Bash matcher only — the recognizer
  // returns no opinion for every other tool, so why run for them).
  {
    const r = syncEvent(settings.hooks, 'PreToolUse', preToolHook(nodeBin), isOurPreTool, PRETOOL_MATCHER);
    result[r]++;
  }
  const httpDesired = { type: 'http', url: buildPermissionUrl(port || BASE_PORT, token), timeout: PERMISSION_TIMEOUT_S };
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
        if (isOurCommand(h) || isOurHttp(h) || isOurPreTool(h)) { removed++; return false; }
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

function hooksCurrent(port, token) {
  if (!validToken(token)) return false;
  try {
    const settings = readSettings();
    const hooks = settings.hooks || {};
    const pretoolOk = (() => {
      const ours = Array.isArray(hooks.PreToolUse)
        ? hooks.PreToolUse.flatMap((group) => Array.isArray(group && group.hooks) ? group.hooks : []).filter(isOurPreTool)
        : [];
      return ours.length === 1;
    })();
    // Count duplicates, but deliberately accept another live LLMPET build's
    // command path. Requiring this process's exact app path makes a dev build
    // and the installed app rewrite settings.json back and forth forever.
    const commandsOk = COMMAND_EVENTS.every((event) => {
      const ours = Array.isArray(hooks[event])
        ? hooks[event].flatMap((group) => Array.isArray(group && group.hooks) ? group.hooks : []).filter(isOurCommand)
        : [];
      return ours.length === 1;
    }) && pretoolOk;
    const desiredUrl = buildPermissionUrl(port || BASE_PORT, token);
    const permissionHooks = Array.isArray(hooks.PermissionRequest)
      ? hooks.PermissionRequest.flatMap((group) => Array.isArray(group && group.hooks) ? group.hooks : []).filter(isOurHttp)
      : [];
    const permissionOk = permissionHooks.length === 1
      && permissionHooks[0].url === desiredUrl;
    return commandsOk && permissionOk;
  } catch {
    return false;
  }
}

function markerPresent() {
  try { return fs.readFileSync(SETTINGS_PATH, 'utf8').includes(MARKER); } catch { return false; }
}

module.exports = {
  registerHooks,
  unregisterHooks,
  markerPresent,
  hooksCurrent,
  SETTINGS_PATH,
  HOOK_SCRIPT,
  MARKER,
  PRETOOL_SCRIPT,
  PRETOOL_MARKER,
  PRETOOL_MATCHER,
  COMMAND_EVENTS,
  syncEvent,
};

// CLI: `node backend/hookinstall.js` installs; `--uninstall` removes.
if (require.main === module) {
  if (process.argv.includes('--uninstall')) {
    console.log(unregisterHooks({ backup: true }));
  } else {
    const runtime = readRuntimeConfig();
    console.log(registerHooks(runtime && runtime.port, runtime && runtime.token));
  }
}
