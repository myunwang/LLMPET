'use strict';

// Merge-safe installer for Codex lifecycle hooks.
//
// Newer Codex builds keep live thread state in SQLite and may no longer append
// rollout JSONL files. Hooks are the documented event interface, so LLMPET uses
// them as the primary live source while retaining codex-watch.js as a legacy
// fallback and metering source.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveNodeBin } = require('./transport');

const CODEX_HOOKS_PATH = path.join(os.homedir(), '.codex', 'hooks.json');
const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'octopus-hook.js');
const MARKER = 'octopus-hook.js';
const AGENT_ARG = 'codex';
const STATE_TIMEOUT_S = 5;

// Only events in the documented Codex hook surface. Claude-only events such as
// StopFailure and Elicitation remain registered exclusively in settings.json.
const CODEX_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
];

function readHooks(filePath = CODEX_HOOKS_PATH) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`read Codex hooks.json: ${err.message}`);
  }
}

function writeAtomic(obj, filePath = CODEX_HOOKS_PATH) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.hooks.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function commandHook(nodeBin, event, platform = process.platform) {
  const command = `${quote(nodeBin)} ${quote(HOOK_SCRIPT)} ${event} ${AGENT_ARG}`;
  const hook = {
    type: 'command',
    command,
    timeout: event === 'SessionEnd' ? 1 : STATE_TIMEOUT_S,
  };
  // Codex executes commandWindows through PowerShell. A quoted executable path
  // is only a string expression there; prefix it with the call operator so an
  // absolute Node path containing spaces is actually launched.
  if (platform === 'win32') hook.commandWindows = `& ${command}`;
  return hook;
}

function isOurCommand(hook) {
  if (!hook || typeof hook !== 'object') return false;
  return [hook.command, hook.commandWindows]
    .some((command) => typeof command === 'string' && command.includes(MARKER));
}

function sameDesired(hook, desired) {
  return Object.keys(desired).every((key) => hook[key] === desired[key]) && !('shell' in hook);
}

// Keep every unrelated handler and matcher group. If a previous LLMPET build
// left duplicate handlers, retain one and remove only the duplicates we own.
function syncEvent(hooks, event, desired) {
  if (!Array.isArray(hooks[event])) {
    const prior = hooks[event];
    hooks[event] = prior && typeof prior === 'object' ? [prior] : [];
  }

  let found = null;
  let changed = false;
  const groups = [];
  for (const group of hooks[event]) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      groups.push(group);
      continue;
    }
    const kept = [];
    for (const hook of group.hooks) {
      if (!isOurCommand(hook)) {
        kept.push(hook);
        continue;
      }
      if (found) {
        changed = true;
        continue;
      }
      found = hook;
      if (!sameDesired(hook, desired)) {
        for (const key of Object.keys(desired)) hook[key] = desired[key];
        delete hook.shell;
        changed = true;
      }
      kept.push(hook);
    }
    if (kept.length) groups.push({ ...group, hooks: kept });
  }
  hooks[event] = groups;

  if (!found) {
    hooks[event].push({ matcher: '', hooks: [desired] });
    return 'added';
  }
  return changed ? 'updated' : 'skipped';
}

function removeOurHooks(hooks) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = [];
    for (const group of hooks[event]) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        groups.push(group);
        continue;
      }
      const kept = group.hooks.filter((hook) => {
        if (isOurCommand(hook)) { removed++; return false; }
        return true;
      });
      if (kept.length) groups.push({ ...group, hooks: kept });
    }
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  return removed;
}

function registerCodexHooks(options = {}) {
  const filePath = options.hooksPath || CODEX_HOOKS_PATH;
  const nodeBin = options.nodeBin || resolveNodeBin();
  const platform = options.platform || process.platform;
  const config = readHooks(filePath);
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) config.hooks = {};
  const result = { added: 0, updated: 0, skipped: 0 };

  for (const event of CODEX_EVENTS) {
    const status = syncEvent(config.hooks, event, commandHook(nodeBin, event, platform));
    result[status]++;
  }
  if (result.added || result.updated) writeAtomic(config, filePath);
  return { ...result, nodeBin, hooksPath: filePath };
}

function unregisterCodexHooks(options = {}) {
  const filePath = options.hooksPath || CODEX_HOOKS_PATH;
  let config;
  try { config = readHooks(filePath); } catch { return { removed: 0, backupPath: null }; }
  if (!config.hooks) return { removed: 0, backupPath: null };
  const removed = removeOurHooks(config.hooks);
  if (!removed) return { removed: 0, backupPath: null };

  let backupPath = null;
  if (options.backup) {
    try {
      backupPath = `${filePath}.octopus-backup-${Date.now()}.bak`;
      fs.copyFileSync(filePath, backupPath);
    } catch { backupPath = null; }
  }
  writeAtomic(config, filePath);
  return { removed, backupPath };
}

function codexHooksCurrent(options = {}) {
  const filePath = options.hooksPath || CODEX_HOOKS_PATH;
  const nodeBin = options.nodeBin || resolveNodeBin();
  const platform = options.platform || process.platform;
  try {
    const config = readHooks(filePath);
    const hooks = config.hooks || {};
    return CODEX_EVENTS.every((event) => {
      const desired = commandHook(nodeBin, event, platform);
      return Array.isArray(hooks[event]) && hooks[event].some((group) =>
        Array.isArray(group && group.hooks) && group.hooks.some((hook) =>
          isOurCommand(hook) && sameDesired(hook, desired)));
    });
  } catch {
    return false;
  }
}

module.exports = {
  registerCodexHooks,
  unregisterCodexHooks,
  codexHooksCurrent,
  readHooks,
  removeOurHooks,
  CODEX_HOOKS_PATH,
  CODEX_EVENTS,
  HOOK_SCRIPT,
  MARKER,
};

if (require.main === module) {
  if (process.argv.includes('--uninstall')) console.log(unregisterCodexHooks({ backup: true }));
  else console.log(registerCodexHooks());
}
