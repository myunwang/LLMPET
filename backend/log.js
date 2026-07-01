'use strict';

// Tiny append-only logger. Backs window.pet.openLog() / petLog(tag,msg).
// Lives under ~/.octopus/octopus.log so it survives app restarts and is easy to
// tail while debugging the hook → server → pet pipeline.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = path.join(os.homedir(), '.octopus');
const LOG_PATH = path.join(LOG_DIR, 'octopus.log');
const MAX_BYTES = 1 * 1024 * 1024; // rotate at 1 MB so the file never grows unbounded

let stream = null;

function ensureStream() {
  if (stream) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Rotate once if the existing file got large.
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > MAX_BYTES) fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    } catch {}
    stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  } catch {
    stream = null;
  }
  return stream;
}

function log(tag, ...parts) {
  const line = `${new Date().toISOString()} [${tag}] ${parts
    .map((p) => (typeof p === 'string' ? p : safeJson(p)))
    .join(' ')}\n`;
  const s = ensureStream();
  if (s) {
    try { s.write(line); } catch {}
  }
  // Also mirror to stdout so `npm start` shows the pipeline live.
  try { process.stdout.write(line); } catch {}
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { log, LOG_PATH, LOG_DIR };
