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
  let stopped = false; // W17: guard against stale debounce firing after stop
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    watcher = fs.watch(SETTINGS_DIR, (_e, filename) => {
      if (stopped) return; // W17: ignore events after stop
      if (filename && filename !== 'settings.json') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (stopped) return; // W17: double-check inside debounce callback
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
  // W17: clear debounce AND close watcher AND set stopped flag. Previously
  // only the watcher was closed, leaving a pending debounce timer that could
  // fire 800ms later and re-register hooks — silently undoing an uninstall
  // and "locking" Claude Code back to the pet.
  return () => {
    stopped = true;
    if (debounce) { clearTimeout(debounce); debounce = null; }
    if (watcher) { try { watcher.close(); } catch {} }
  };
}

module.exports = { install, uninstall, startWatcher, markerPresent, SETTINGS_PATH };
