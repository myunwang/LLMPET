'use strict';

// Bounded asynchronous logger. Each append opens/closes the file, so Windows can
// rotate it reliably without racing an open WriteStream handle. Calls from the
// Electron main process only enqueue short strings; disk I/O is serialized in
// the background and the queue is capped to prevent a log storm using memory.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = path.join(os.homedir(), '.octopus');
const LOG_PATH = path.join(LOG_DIR, 'octopus.log');
const ROTATED_PATH = LOG_PATH + '.1';
const MAX_BYTES = 1 * 1024 * 1024;
const MAX_QUEUE = 1000;

let queue = [];
let draining = false;
let written = null;
let stdoutUsable = true;
let dropped = 0;

if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', () => { stdoutUsable = false; });
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function enqueue(line) {
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    dropped++;
  }
  queue.push(line);
  drain().catch(() => {});
}

async function initFile() {
  await fs.promises.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  try { await fs.promises.chmod(LOG_DIR, 0o700); } catch {}
  if (written !== null) return;
  try {
    const st = await fs.promises.stat(LOG_PATH);
    written = st.size;
  } catch { written = 0; }
}

async function rotate() {
  try { await fs.promises.unlink(ROTATED_PATH); } catch {}
  try { await fs.promises.rename(LOG_PATH, ROTATED_PATH); } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  written = 0;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    await initFile();
    while (queue.length) {
      let line = queue.shift();
      if (dropped) {
        line = `${new Date().toISOString()} [log] dropped ${dropped} queued line(s)\n` + line;
        dropped = 0;
      }
      const bytes = Buffer.byteLength(line);
      if (written > 0 && written + bytes > MAX_BYTES) await rotate();
      await fs.promises.appendFile(LOG_PATH, line, { encoding: 'utf8', mode: 0o600 });
      try { await fs.promises.chmod(LOG_PATH, 0o600); } catch {}
      written += bytes;
    }
  } catch {
    // Logging must never crash or stall the tray app. A later call retries.
    written = null;
  } finally {
    draining = false;
    if (queue.length) setImmediate(() => drain().catch(() => {}));
  }
}

function log(tag, ...parts) {
  const safeTag = String(tag == null ? '' : tag).replace(/[\r\n\0]/g, ' ').slice(0, 96);
  const line = `${new Date().toISOString()} [${safeTag}] ${parts
    .map((p) => (typeof p === 'string' ? p : safeJson(p)))
    .join(' ')}\n`;
  enqueue(line);
  if (stdoutUsable && process.stdout && process.stdout.writable && !process.stdout.destroyed) {
    try { process.stdout.write(line); } catch { stdoutUsable = false; }
  }
}

module.exports = { log, LOG_PATH, LOG_DIR, _drain: drain };
