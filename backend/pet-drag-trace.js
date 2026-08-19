'use strict';

// Dedicated structured trace for transparent-window dragging. Keep it separate
// from octopus.log so a short high-frequency gesture cannot drown session logs.
// Writes are batched and asynchronous: diagnostics must not become drag jitter.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TRACE_DIR = path.join(os.homedir(), '.octopus');
const PET_DRAG_TRACE_PATH = path.join(TRACE_DIR, 'pet-drag.jsonl');
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FLUSH_MS = 60;

function cleanValue(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return value.slice(0, 180);
  if (depth >= 3) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => cleanValue(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 180);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    out[String(key).slice(0, 64)] = cleanValue(item, depth + 1);
  }
  return out;
}

function createPetDragTrace(options = {}) {
  const filePath = options.filePath || PET_DRAG_TRACE_PATH;
  const maxBytes = Math.max(4096, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const flushMs = Math.max(5, Number(options.flushMs) || DEFAULT_FLUSH_MS);
  let queue = [];
  let timer = null;
  let writeChain = Promise.resolve();
  let sequence = 0;

  async function writeBatch(lines) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    let currentBytes = 0;
    try { currentBytes = (await fs.promises.stat(filePath)).size; } catch {}
    const payload = lines.join('');
    if (currentBytes + Buffer.byteLength(payload) > maxBytes) {
      try { await fs.promises.rename(filePath, filePath + '.1'); } catch {}
    }
    await fs.promises.appendFile(filePath, payload, 'utf8');
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return writeChain;
    const lines = queue;
    queue = [];
    writeChain = writeChain.then(() => writeBatch(lines)).catch(() => {});
    return writeChain;
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(flush, flushMs);
    if (timer.unref) timer.unref();
  }

  function record(source, event, details = {}) {
    const entry = {
      ts: new Date().toISOString(),
      seq: ++sequence,
      source: String(source || 'unknown').slice(0, 32),
      event: String(event || 'unknown').slice(0, 64),
      ...cleanValue(details),
    };
    queue.push(`${JSON.stringify(entry)}\n`);
    if (queue.length >= 24) flush();
    else scheduleFlush();
    return entry.seq;
  }

  return { filePath, record, flush };
}

const dragTrace = createPetDragTrace();

module.exports = {
  PET_DRAG_TRACE_PATH,
  createPetDragTrace,
  dragTrace,
};
