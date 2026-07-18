'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TOML merge-safe hook installer for CodeWhale.
// ─────────────────────────────────────────────────────────────────────────────
//
// Handles ~/.codewhale/config.toml — ONLY the [[hooks.hooks]] array.
// Strategy mirrors backend/hookinstall.js (Claude JSON version):
//   • ONLY touches entries whose `command` contains our marker string.
//   • All other TOML content (tables, values, comments) preserved byte-for-byte.
//   • Atomic write (tmp + rename).
//   • Uninstall backs up first.
//
// TOML parsing is intentionally line-based and minimal — we only need to
// identify and manipulate [[hooks.hooks]] array entries. A full TOML parser
// would be massive overkill and a dependency risk.
//
// Source schema (R2.8):
//   [hooks]
//   enabled = true
//   [[hooks.hooks]]
//   event = "tool_call_before"
//   command = "node /abs/codewhale-hook.js tool_call_before"
//   timeout_secs = 600
//   background = false
//   continue_on_error = false
//   name = "octopus"
//   # condition = ... (optional, we don't set this)

const fs = require('fs');
const path = require('path');
const codewhale = require('../providers/codewhale');

const MARKER = codewhale.hookMarker;                    // 'codewhale-hook.js'

// Path is read dynamically from the provider each call, NOT cached at require time.
// This allows callers to override codewhale.dirs.settingsFile before calling.
function getSettingsPath() {
  return codewhale.dirs.settingsFile;
}

// ── Line-level TOML parsing ──────────────────────────────────────────────────
// We parse just enough to find and manipulate [[hooks.hooks]] entries.
// Each entry is an object { _lines: [lineNumbers], _startLine, _endLine, key: value, ... }
// and we track the line ranges so we can splice the file accurately.

// Find the line index of the last [[hooks.hooks]] header, or -1.
function findLastHooksHooksArrayLine(lines) {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\[\[hooks\.hooks\]\]\s*$/.test(lines[i])) last = i;
  }
  return last;
}

// Find the line index of [hooks] header, or -1.
function findHooksTableLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^\[hooks\]\s*$/.test(lines[i])) return i;
  }
  return -1;
}

// Parse a single [[hooks.hooks]] entry starting at `startLine`.
// Returns { startLine, endLine, fields: {key: value, ...} } where endLine
// is the last NON-BLANK line of the entry (exclusive of trailing blanks and
// the next header/EOF). Trailing blank lines are NOT part of the entry —
// they belong to the inter-entry separator and must be preserved as-is
// during removal/insertion to avoid corrupting neighbouring entries.
function parseEntry(lines, startLine) {
  const fields = {};
  let i = startLine + 1; // skip the [[hooks.hooks]] line itself
  let lastNonBlank = startLine; // the header line itself counts
  while (i < lines.length) {
    const line = lines[i];
    // Next table/array header or EOF ends this entry
    if (/^\s*\[/.test(line)) break;
    // Key = value (simple string/number/bool)
    const m = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (m) {
      fields[m[1]] = m[2].trim();
      lastNonBlank = i;
    } else if (line.trim() !== '') {
      // Non-empty, non-key line (e.g. comment) — still part of entry
      lastNonBlank = i;
    }
    i++;
  }
  return { startLine, endLine: lastNonBlank, fields };
}

// Check if a parsed entry is "ours" (command contains our marker).
function isOurEntry(entry) {
  const cmd = entry.fields.command || '';
  return cmd.includes(MARKER);
}

// Serialize an entry object back to TOML lines.
function entryToToml(fields) {
  const out = ['[[hooks.hooks]]'];
  // Deterministic key order
  const order = ['event', 'command', 'timeout_secs', 'background', 'continue_on_error', 'name', 'condition'];
  for (const k of order) {
    if (fields[k] !== undefined) out.push(`${k} = ${fields[k]}`);
  }
  // Any extra keys
  for (const k of Object.keys(fields)) {
    if (!order.includes(k)) out.push(`${k} = ${fields[k]}`);
  }
  return out;
}

// ── Atomic file ops ──────────────────────────────────────────────────────────
function readConfig() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`read config.toml: ${err.message}`);
  }
}

function writeAtomic(content) {
  const dir = path.dirname(getSettingsPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, getSettingsPath());
}

// ── Core: register hooks ─────────────────────────────────────────────────────
// Reads config.toml, finds/removes our old entries, appends new ones,
// writes atomically. Returns {added, updated, skipped}.
function registerHooks() {
  const entries = codewhale.hookTomlSchema.entries;
  let raw = readConfig();
  const lines = raw ? raw.split('\n') : [];

  // 1. Remove our existing entries (track line ranges)
  const ourRanges = [];
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\[\[hooks\.hooks\]\]\s*$/.test(lines[i])) {
      const entry = parseEntry(lines, i);
      parsed.push(entry);
      if (isOurEntry(entry)) {
        ourRanges.push({ start: entry.startLine, end: entry.endLine });
      }
    }
  }

  // 2. Build new file without our old entries (from bottom up to preserve indices)
  const removeSet = new Set();
  for (const r of ourRanges) {
    for (let i = r.start; i <= r.end; i++) removeSet.add(i);
  }
  let newLines = lines.filter((_, i) => !removeSet.has(i));

  // 3. Ensure [hooks] table header exists (add if missing)
  let hooksLine = findHooksTableLine(newLines);
  if (hooksLine === -1) {
    // Also check for [[hooks.hooks]] without a preceding [hooks]
    const arrLine = findLastHooksHooksArrayLine(newLines);
    if (arrLine >= 0) {
      // Insert [hooks] before the first [[hooks.hooks]]
      newLines.splice(arrLine, 0, '[hooks]', '');
      hooksLine = arrLine;
    } else {
      // No hooks at all — append at end
      newLines = newLines.concat(['', '[hooks]', '']);
      hooksLine = newLines.length - 2;
    }
  }

  // 4. Find insertion point: AFTER the last [[hooks.hooks]] entry's full range.
  //    We must not insert in the middle of an existing entry (between its header
  //    and its trailing fields) — that would split the entry and leave a stray
  //    empty header. So we find the last [[hooks.hooks]] header, parse its full
  //    range (now correctly excluding trailing blanks), and insert after endLine.
  let insertAfter = -1;
  for (let i = newLines.length - 1; i >= 0; i--) {
    if (/^\[\[hooks\.hooks\]\]\s*$/.test(newLines[i])) {
      const e = parseEntry(newLines, i);
      insertAfter = e.endLine;
      break;
    }
  }
  if (insertAfter < 0) insertAfter = hooksLine; // right after [hooks]

  // 5. Build our new TOML entries
  const ourEntries = entries.map((e) => {
    const f = { event: `"${e.event}"`, command: `"${e.command}"` };
    if (e.timeout_secs != null) f.timeout_secs = e.timeout_secs;
    if (e.background != null) f.background = e.background;
    if (e.continue_on_error != null) f.continue_on_error = e.continue_on_error;
    if (e.name) f.name = `"${e.name}"`;
    return f;
  });

  // Count what happened (matched by event)
  const oldEvents = new Set();
  for (const p of parsed) {
    if (isOurEntry(p)) oldEvents.add(p.fields.event);
  }
  let added = 0, updated = 0, skipped = 0;
  for (const e of ourEntries) {
    if (oldEvents.has(e.event)) updated++;
    else added++;
  }

  // 6. Insert our entries after the insertion point
  const tomlLines = ourEntries.flatMap((f) => entryToToml(f));
  // Splice after insertAfter line
  newLines.splice(insertAfter + 1, 0, '', ...tomlLines, '');

  // 7. Clean up excessive blank lines (max 1 consecutive)
  const cleaned = [];
  let prevBlank = false;
  for (const line of newLines) {
    if (line.trim() === '') {
      if (prevBlank) continue;
      prevBlank = true;
    } else {
      prevBlank = false;
    }
    cleaned.push(line);
  }
  // Trim trailing blanks
  while (cleaned.length && cleaned[cleaned.length - 1].trim() === '') cleaned.pop();

  writeAtomic(cleaned.join('\n') + '\n');
  return { added, updated, skipped, total: added + updated };
}

// ── Core: unregister hooks ───────────────────────────────────────────────────
function unregisterHooks(options = {}) {
  let raw = readConfig();
  if (raw === null) return { removed: 0 };

  const lines = raw.split('\n');
  let removed = 0;

  // Find and mark our entries for removal
  const removeSet = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (/^\[\[hooks\.hooks\]\]\s*$/.test(lines[i])) {
      const entry = parseEntry(lines, i);
      if (isOurEntry(entry)) {
        for (let j = entry.startLine; j <= entry.endLine; j++) removeSet.add(j);
        removed++;
      }
    }
  }

  if (removed === 0) return { removed: 0 };

  // Backup before modifying
  let backupPath = null;
  if (options.backup) {
    try {
      backupPath = `${getSettingsPath()}.octopus-backup-${Date.now()}.bak`;
      fs.copyFileSync(getSettingsPath(), backupPath);
    } catch { backupPath = null; }
  }

  const newLines = lines.filter((_, i) => !removeSet.has(i));
  writeAtomic(newLines.join('\n') + '\n');
  return { removed, backupPath };
}

// ── Core: check if our marker is present ─────────────────────────────────────
function markerPresent() {
  try {
    const raw = readConfig();
    return raw !== null && raw.includes(MARKER);
  } catch {
    return false;
  }
}

module.exports = { registerHooks, unregisterHooks, markerPresent, getSettingsPath, MARKER };