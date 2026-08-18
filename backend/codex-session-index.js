'use strict';

// Codex keeps the user-facing thread title outside rollout JSONL files. The
// rollout only contains prompts, so deriving a title from it makes renamed
// desktop tasks look missing in LLMPET. session_index.jsonl is the small,
// local, read-only mapping used by Codex for those stable titles.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PATH = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const MAX_INDEX_BYTES = 32 * 1024 * 1024;

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function parseCodexSessionIndex(text) {
  const titles = new Map();
  for (const line of String(text || '').split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    const id = cleanText(row.id || row.session_id, 256);
    const title = cleanText(row.thread_name || row.title, 160);
    if (id && title) titles.set(id, title);
  }
  return titles;
}

function readCodexSessionIndex(filePath = DEFAULT_PATH) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return new Map();
    return parseCodexSessionIndex(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return new Map();
  }
}

function createCodexSessionIndex(filePath = DEFAULT_PATH) {
  let signature = '';
  let titles = new Map();

  function refresh() {
    let stat;
    try { stat = fs.statSync(filePath); } catch {
      const changed = signature !== 'missing' || titles.size > 0;
      signature = 'missing';
      titles = new Map();
      return changed;
    }
    const nextSignature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (nextSignature === signature) return false;
    signature = nextSignature;
    titles = stat.isFile() && stat.size <= MAX_INDEX_BYTES
      ? readCodexSessionIndex(filePath)
      : new Map();
    return true;
  }

  function get(id) { return titles.get(String(id || '')) || ''; }

  return { filePath, refresh, get, snapshot: () => new Map(titles) };
}

module.exports = {
  DEFAULT_PATH,
  MAX_INDEX_BYTES,
  parseCodexSessionIndex,
  readCodexSessionIndex,
  createCodexSessionIndex,
};
