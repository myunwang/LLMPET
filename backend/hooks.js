'use strict';

// Claude Code hook lifecycle — install/uninstall via backend/hookinstall.js,
// plus a settings.json watcher that re-registers our hooks if another tool
// (CC-Switch, manual edits, …) overwrites the file without them.

const fs = require('fs');
const path = require('path');
const { registerHooks, unregisterHooks, markerPresent, SETTINGS_PATH } = require('./hookinstall');
const { log } = require('./log');

const SETTINGS_DIR = path.dirname(SETTINGS_PATH);

function install(port) {
  try {
    const r = registerHooks(port);
    log('hooks', `installed (port ${port}) added=${r.added} updated=${r.updated} skipped=${r.skipped} purged=${r.purged || 0} node=${r.nodeBin}`);
    return r;
  } catch (err) {
    log('hooks', 'install failed:', err.message);
    return null;
  }
}

function uninstall() {
  try {
    const r = unregisterHooks({ backup: true });
    log('hooks', `uninstalled removed=${r.removed}${r.backupPath ? ' backup=' + r.backupPath : ''}`);
    return r;
  } catch (err) {
    log('hooks', 'uninstall failed:', err.message);
    return null;
  }
}

// Watch the ~/.claude directory (not the file — atomic renames swap the inode).
function startWatcher(getPort) {
  let watcher = null;
  let debounce = null;
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    watcher = fs.watch(SETTINGS_DIR, (_e, filename) => {
      if (filename && filename !== 'settings.json') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (!markerPresent()) {
          log('hooks', 'settings.json lost our hooks — re-registering');
          install(getPort());
        }
      }, 800);
      if (debounce.unref) debounce.unref();
    });
    log('hooks', 'settings watcher started');
  } catch (err) {
    log('hooks', 'watcher failed:', err.message);
  }
  return () => { if (watcher) { try { watcher.close(); } catch {} } };
}

module.exports = { install, uninstall, startWatcher, markerPresent, SETTINGS_PATH };
