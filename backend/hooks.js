'use strict';

// Claude Code + Codex hook lifecycle. Both installers merge only LLMPET-owned
// handlers and preserve other tools' entries.

const fs = require('fs');
const path = require('path');
const {
  registerHooks,
  unregisterHooks,
  hooksCurrent: claudeHooksCurrent,
  SETTINGS_PATH,
} = require('./hookinstall');
const {
  registerCodexHooks,
  unregisterCodexHooks,
  codexHooksCurrent,
  CODEX_HOOKS_PATH,
} = require('./codex-hookinstall');
const { log } = require('./log');

const SETTINGS_DIR = path.dirname(SETTINGS_PATH);

function install(port, token) {
  const result = { claude: null, codex: null };
  try {
    const r = registerHooks(port, token);
    log('hooks', `installed (port ${port}) added=${r.added} updated=${r.updated} skipped=${r.skipped} purged=${r.purged || 0} node=${r.nodeBin}`);
    result.claude = r;
  } catch (err) {
    log('hooks', 'Claude install failed:', err.message);
  }
  try {
    const r = registerCodexHooks();
    log('codex-hooks', `installed added=${r.added} updated=${r.updated} skipped=${r.skipped} node=${r.nodeBin}`);
    result.codex = r;
  } catch (err) {
    log('codex-hooks', 'install failed:', err.message);
  }
  return result;
}

function uninstall() {
  const result = { claude: null, codex: null };
  try {
    const r = unregisterHooks({ backup: true });
    log('hooks', `uninstalled removed=${r.removed}${r.backupPath ? ' backup=' + r.backupPath : ''}`);
    result.claude = r;
  } catch (err) {
    log('hooks', 'Claude uninstall failed:', err.message);
  }
  try {
    const r = unregisterCodexHooks({ backup: true });
    log('codex-hooks', `uninstalled removed=${r.removed}${r.backupPath ? ' backup=' + r.backupPath : ''}`);
    result.codex = r;
  } catch (err) {
    log('codex-hooks', 'uninstall failed:', err.message);
  }
  return result;
}

function hooksCurrent(port, token) {
  return claudeHooksCurrent(port, token) && codexHooksCurrent();
}

// Watch the parent directories (not the files — atomic renames swap inodes).
function startWatcher(getRuntime) {
  const watchers = [];
  let debounce = null;
  const targets = [
    { dir: SETTINGS_DIR, file: path.basename(SETTINGS_PATH), label: 'Claude settings' },
    { dir: path.dirname(CODEX_HOOKS_PATH), file: path.basename(CODEX_HOOKS_PATH), label: 'Codex hooks' },
  ];

  for (const target of targets) {
    try {
      fs.mkdirSync(target.dir, { recursive: true });
      const watcher = fs.watch(target.dir, (_e, filename) => {
        if (filename && filename !== target.file) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const runtime = getRuntime();
          if (!runtime || !hooksCurrent(runtime.port, runtime.token)) {
            log('hooks', `${target.label} lost or changed LLMPET hooks — re-registering`);
            if (runtime) install(runtime.port, runtime.token);
          }
        }, 800);
        if (debounce.unref) debounce.unref();
      });
      watchers.push(watcher);
    } catch (err) {
      log('hooks', `${target.label} watcher failed:`, err.message);
    }
  }
  if (watchers.length) log('hooks', 'Claude/Codex settings watchers started');
  return () => {
    if (debounce) clearTimeout(debounce);
    for (const watcher of watchers) {
      try { watcher.close(); } catch {}
    }
  };
}

module.exports = { install, uninstall, startWatcher, hooksCurrent, SETTINGS_PATH, CODEX_HOOKS_PATH };
