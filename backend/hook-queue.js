'use strict';

// Durable handoff for the one hook event that discovers a stopped/crashed app.
// Each event is written as its own atomically-renamed file so concurrent Claude
// and Codex hooks cannot overwrite each other. The recovered app drains the
// queue only after its authenticated loopback server is listening.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PENDING_HOOK_DIR = path.join(os.homedir(), '.octopus', 'pending-hooks');
const MAX_PENDING_EVENTS = 200;
const MAX_PENDING_EVENT_BYTES = 24 * 1024;

function pendingFiles(directory = PENDING_HOOK_DIR) {
  try {
    return fs.readdirSync(directory)
      .filter((name) => /^event-[\w.-]+\.json$/.test(name))
      .sort()
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

function isQueuedPath(filePath, directory = PENDING_HOOK_DIR) {
  if (!filePath) return false;
  try {
    return path.dirname(path.resolve(filePath)) === path.resolve(directory);
  } catch {
    return false;
  }
}

function removePendingHookEvent(filePath, options = {}) {
  const directory = options.directory || PENDING_HOOK_DIR;
  if (!isQueuedPath(filePath, directory)) return false;
  try { fs.unlinkSync(filePath); return true; } catch { return false; }
}

function prunePendingHookEvents(directory, limit = MAX_PENDING_EVENTS) {
  const files = pendingFiles(directory);
  const excess = Math.max(0, files.length - Math.max(1, limit));
  for (const filePath of files.slice(0, excess)) removePendingHookEvent(filePath, { directory });
}

function enqueueHookEvent(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const directory = options.directory || PENDING_HOOK_DIR;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const id = options.id || `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let payload;
  try { payload = JSON.stringify({ version: 1, queuedAt: now, body }); } catch { return null; }
  if (Buffer.byteLength(payload) > MAX_PENDING_EVENT_BYTES) return null;

  const base = `event-${String(now).padStart(16, '0')}-${String(id).replace(/[^\w.-]/g, '_')}`;
  const tempPath = path.join(directory, `${base}.tmp`);
  const finalPath = path.join(directory, `${base}.json`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, finalPath);
    try { fs.chmodSync(finalPath, 0o600); } catch {}
    prunePendingHookEvents(directory, options.limit);
    return finalPath;
  } catch {
    try { fs.unlinkSync(tempPath); } catch {}
    return null;
  }
}

function readPendingHookEvent(filePath, directory) {
  if (!isQueuedPath(filePath, directory)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (
      parsed && parsed.version === 1 && parsed.body
      && typeof parsed.body === 'object' && !Array.isArray(parsed.body)
    ) return parsed.body;
  } catch {}
  return null;
}

function drainPendingHookEvents(options = {}, done = () => {}) {
  const directory = options.directory || PENDING_HOOK_DIR;
  const postState = options.postState;
  const files = pendingFiles(directory);
  let index = 0;
  let delivered = 0;

  const finish = (failed = null) => {
    done({ delivered, failed, remaining: pendingFiles(directory).length });
  };
  const next = () => {
    if (index >= files.length) return finish();
    const filePath = files[index++];
    const body = readPendingHookEvent(filePath, directory);
    if (!body) {
      removePendingHookEvent(filePath, { directory });
      return next();
    }
    if (typeof postState !== 'function') return finish(filePath);

    let settled = false;
    try {
      postState(body, (ok) => {
        if (settled) return;
        settled = true;
        if (ok === true) {
          removePendingHookEvent(filePath, { directory });
          delivered++;
          next();
        } else {
          finish(filePath);
        }
      });
    } catch {
      if (!settled) finish(filePath);
    }
  };

  next();
  return files.length;
}

module.exports = {
  PENDING_HOOK_DIR,
  MAX_PENDING_EVENTS,
  enqueueHookEvent,
  removePendingHookEvent,
  drainPendingHookEvents,
  pendingFiles,
};
