'use strict';

// Merge-safe CodeWhale hook installer.
//
// Only [[hooks.hooks]] entries whose `command` contains our marker are changed.
// Other tables, comments, ordering, and line endings are preserved. Writes use a
// same-directory temporary file followed by rename so readers never see a
// partially-written config.

const fs = require('fs');
const path = require('path');
const codewhale = require('../providers/codewhale');
const { readTextBoundedSync } = require('./safe-json');

const MARKER = codewhale.hookMarker;
const ANY_TABLE_RE = /^\s*\[(?:\[)?[^\]]/;
const FIELD_RE = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

function tableHeaderBody(line) {
  if (typeof line !== 'string') return null;
  const hash = line.indexOf('#');
  const body = (hash >= 0 ? line.slice(0, hash) : line).trim();
  return body || null;
}

function isHookArrayHeader(line) {
  return tableHeaderBody(line) === '[[hooks.hooks]]';
}

function isHooksTableHeader(line) {
  return tableHeaderBody(line) === '[hooks]';
}

function getSettingsPath() {
  return codewhale.dirs.settingsFile;
}

function toRecords(raw) {
  const records = [];
  let offset = 0;
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    if (match[0] === '' && match.index === raw.length) break;
    records.push({
      content: match[1],
      ending: match[2],
      start: offset,
      end: offset + match[0].length,
    });
    offset += match[0].length;
    if (match[2] === '') break;
  }
  return records;
}

function dominantEol(records) {
  const counts = new Map();
  for (const r of records) {
    if (!r.ending) continue;
    counts.set(r.ending, (counts.get(r.ending) || 0) + 1);
  }
  let best = '\n';
  let max = -1;
  for (const [ending, count] of counts) {
    if (count > max) { best = ending; max = count; }
  }
  return best;
}

function parseEntry(records, startLine) {
  const fields = {};
  let i = startLine + 1;
  while (i < records.length) {
    const line = records[i].content;
    if (ANY_TABLE_RE.test(line)) break;
    const m = line.match(FIELD_RE);
    if (m && !line.trimStart().startsWith('#')) fields[m[1]] = m[2];
    i++;
  }
  return { startLine, endLine: i - 1, endExclusive: i, fields };
}

function findEntries(records) {
  const entries = [];
  for (let i = 0; i < records.length; i++) {
    if (!isHookArrayHeader(records[i].content)) continue;
    const entry = parseEntry(records, i);
    entries.push(entry);
    i = Math.max(i, entry.endLine);
  }
  return entries;
}

function unquoteTomlString(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

function isOurEntry(entry) {
  return unquoteTomlString(entry && entry.fields && entry.fields.command).includes(MARKER);
}

function tomlString(value) {
  // TOML basic strings support the JSON escapes used for the values produced
  // here. This safely handles quotes, backslashes, controls, and apostrophes.
  return JSON.stringify(String(value));
}

function entryToToml(fields, eol = '\n') {
  const lines = ['[[hooks.hooks]]'];
  const order = ['event', 'command', 'timeout_secs', 'background', 'continue_on_error', 'name', 'condition'];
  for (const key of order) {
    if (fields[key] !== undefined) lines.push(`${key} = ${fields[key]}`);
  }
  for (const key of Object.keys(fields)) {
    if (!order.includes(key)) lines.push(`${key} = ${fields[key]}`);
  }
  return lines.join(eol);
}

function readConfig() {
  try {
    return readTextBoundedSync(getSettingsPath(), MAX_CONFIG_BYTES);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`read config.toml: ${err.message}`);
  }
}

function writeAtomic(content) {
  const target = getSettingsPath();
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch {}
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, mode); } catch {}
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function removeRanges(raw, records, ranges) {
  if (!ranges.length) return raw;
  const spans = ranges
    .map((r) => ({ start: records[r.startLine].start, end: records[r.endLine].end }))
    .sort((a, b) => b.start - a.start);
  let out = raw;
  for (const span of spans) out = out.slice(0, span.start) + out.slice(span.end);
  return out;
}

function insertionOffset(raw, records, entries, hooksTableLine) {
  if (entries.length) {
    // Insert before the next table, i.e. after the complete final hook entry.
    const last = entries[entries.length - 1];
    return last.endExclusive < records.length ? records[last.endExclusive].start : raw.length;
  }
  if (hooksTableLine >= 0) return records[hooksTableLine].end;
  return raw.length;
}

function makeHookBlock(eol) {
  return codewhale.hookTomlSchema.entries.map((entry) => {
    const fields = {
      event: tomlString(entry.event),
      command: tomlString(entry.command),
    };
    if (entry.timeout_secs != null) fields.timeout_secs = entry.timeout_secs;
    if (entry.background != null) fields.background = entry.background;
    if (entry.continue_on_error != null) fields.continue_on_error = entry.continue_on_error;
    if (entry.name) fields.name = tomlString(entry.name);
    return entryToToml(fields, eol);
  }).join(eol + eol);
}

function registerHooks() {
  const original = readConfig();
  let raw = original === null ? '' : original;
  const originalRecords = toRecords(raw);
  const oldEntries = findEntries(originalRecords);
  const ours = oldEntries.filter(isOurEntry);
  const oldEvents = new Set(ours.map((e) => unquoteTomlString(e.fields.event)));

  raw = removeRanges(raw, originalRecords, ours);
  let records = toRecords(raw);
  const eol = dominantEol(records);
  let hooksTableLine = records.findIndex((r) => isHooksTableHeader(r.content));
  let entries = findEntries(records);

  if (hooksTableLine < 0) {
    const prefix = raw && !/\r?\n$/.test(raw) ? eol : '';
    const header = `[hooks]${eol}enabled = true${eol}`;
    if (entries.length) {
      const at = records[entries[0].startLine].start;
      raw = raw.slice(0, at) + header + eol + raw.slice(at);
    } else {
      raw += prefix + (raw ? eol : '') + header;
    }
    records = toRecords(raw);
    hooksTableLine = records.findIndex((r) => isHooksTableHeader(r.content));
    entries = findEntries(records);
  }

  const block = makeHookBlock(eol);
  let at = insertionOffset(raw, records, entries, hooksTableLine);
  const before = raw.slice(0, at);
  const after = raw.slice(at);
  const lead = before && !before.endsWith(eol) ? eol : '';
  const separatorBefore = before.endsWith(eol + eol) || !before ? '' : eol;
  const separatorAfter = after && (after.startsWith(eol) || after.startsWith('\n') || after.startsWith('\r')) ? '' : eol;
  raw = before + lead + separatorBefore + block + eol + separatorAfter + after;

  writeAtomic(raw);
  const total = codewhale.hookTomlSchema.entries.length;
  let updated = 0;
  for (const entry of codewhale.hookTomlSchema.entries) if (oldEvents.has(entry.event)) updated++;
  return { added: total - updated, updated, skipped: 0, total };
}

function unregisterHooks(options = {}) {
  const raw = readConfig();
  if (raw === null) return { removed: 0 };
  const records = toRecords(raw);
  const ours = findEntries(records).filter(isOurEntry);
  if (!ours.length) return { removed: 0 };

  let backupPath = null;
  if (options.backup) {
    try {
      backupPath = `${getSettingsPath()}.octopus-backup-${Date.now()}.bak`;
      fs.copyFileSync(getSettingsPath(), backupPath);
    } catch { backupPath = null; }
  }
  writeAtomic(removeRanges(raw, records, ours));
  return { removed: ours.length, backupPath };
}

function markerPresent() {
  try {
    const raw = readConfig();
    return raw !== null && findEntries(toRecords(raw)).some(isOurEntry);
  } catch {
    return false;
  }
}

module.exports = {
  registerHooks,
  unregisterHooks,
  markerPresent,
  getSettingsPath,
  MARKER,
  toRecords,
  parseEntry,
  findEntries,
  entryToToml,
  tomlString,
  unquoteTomlString,
};
