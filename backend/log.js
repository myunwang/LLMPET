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
let written = 0; // bytes in the current LOG_PATH, tracked so we rotate mid-run
let stdoutUsable = true;

// Socket/PTY 写失败是异步 error 事件，try/catch 捕获不到。启动终端关闭后
// 只停止镜像 stdout，文件日志仍继续工作，绝不能因此击穿 Electron 主进程。
if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', () => { stdoutUsable = false; });
}

function ensureStream() {
  if (stream) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Rotate once if the existing file is already large; else resume its size.
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > MAX_BYTES) { fs.renameSync(LOG_PATH, LOG_PATH + '.1'); written = 0; }
      else written = st.size;
    } catch { written = 0; }
    const created = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    created.on('error', () => { if (stream === created) stream = null; });
    stream = created;
  } catch {
    stream = null;
  }
  return stream;
}

// A tray app runs for weeks without a restart, so checking size only at stream
// creation let the file grow unbounded past MAX_BYTES. Rotate whenever the
// running total crosses the cap; the next log() re-creates a fresh stream.
function rotateIfNeeded() {
  if (written <= MAX_BYTES) return;
  try {
    if (stream) { stream.end(); stream = null; }
    fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    written = 0;
  } catch { /* keep appending to the current file if rotate fails */ }
}

function log(tag, ...parts) {
  const line = `${new Date().toISOString()} [${tag}] ${parts
    .map((p) => (typeof p === 'string' ? p : safeJson(p)))
    .join(' ')}\n`;
  const s = ensureStream();
  if (s) {
    try { s.write(line); written += Buffer.byteLength(line); rotateIfNeeded(); } catch {}
  }
  // Also mirror to stdout so `npm start` shows the pipeline live.
  if (stdoutUsable && process.stdout && process.stdout.writable && !process.stdout.destroyed) {
    try { process.stdout.write(line); } catch { stdoutUsable = false; }
  }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { log, LOG_PATH, LOG_DIR };
