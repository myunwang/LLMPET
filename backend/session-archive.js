'use strict';

// Unified, read-only session archive for Claude Code + Codex + DeepSeek Harness.
//
// Source transcripts remain provider-owned. LLMPET persists only a small
// metadata index until the user explicitly enables local backup, at which
// point changed JSONL files are copied into ~/.octopus/session-vault. Nothing
// is uploaded and source files are never rewritten or deleted.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { readSessionMetadata: readDshSessionMetadata } = require('./dsh-watch');
const { readCodexSessionIndex } = require('./codex-session-index');

const INDEX_SCHEMA = 1;
const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

function safeText(value, max = 400) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function timestamp(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function messageText(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return typeof part.text === 'string' ? part.text : typeof part.input_text === 'string' ? part.input_text : '';
  }).filter(Boolean).join('\n');
}

function promptTitle(value) {
  const text = messageText(value);
  for (const line of String(text || '').split(/\r?\n/)) {
    const clean = safeText(line, 96);
    if (clean) return clean.length > 64 ? `${clean.slice(0, 64)}…` : clean;
  }
  return '';
}

async function readChunk(file, start, length) {
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(Math.max(0, length));
    const result = await handle.read(buffer, 0, buffer.length, Math.max(0, start));
    return buffer.subarray(0, result.bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle) { try { await handle.close(); } catch {} }
  }
}

async function sampledLines(file, size) {
  const head = await readChunk(file, 0, Math.min(size, HEAD_BYTES));
  if (size <= HEAD_BYTES) return head.split('\n');
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = await readChunk(file, tailStart, size - tailStart);
  const tailLines = tail.split('\n');
  tailLines.shift(); // the first tail row may be a partial JSON line
  return head.split('\n').concat(tailLines);
}

async function walkJsonl(root, maxDepth = 8) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: file, depth: depth + 1 });
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(file);
    }
  }
  return out;
}

async function walkDshLogs(root, maxDepth = 4) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: file, depth: depth + 1 });
      else if (entry.isFile() && (entry.name === 'session.jsonl.zstd' || entry.name === 'session.jsonl')) out.push(file);
    }
  }
  return out;
}

function claudeOrigin(entrypoint) {
  if (entrypoint === 'claude-desktop') return 'desktop';
  if (entrypoint === 'cli') return 'cli';
  return 'unknown';
}

function codexOrigin(meta) {
  const originator = String(meta.originator || '').toLowerCase();
  const source = typeof meta.source === 'string' ? meta.source.toLowerCase() : '';
  if (originator.includes('desktop') || source === 'vscode') return 'desktop';
  if (originator.includes('tui') || source === 'cli' || source === 'exec') return 'cli';
  return 'unknown';
}

function archiveKey(provider, id) { return `${provider}:${id}`; }

async function scanClaude(root) {
  const files = await walkJsonl(root, 8);
  const sessions = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    if (rel.split(path.sep).includes('subagents')) continue;
    let stat;
    try { stat = await fsp.stat(file); } catch { continue; }
    if (!stat.isFile()) continue;
    const lines = await sampledLines(file, stat.size);
    let id = path.basename(file, '.jsonl');
    let cwd = '';
    let entrypoint = '';
    let title = '';
    let customTitle = '';
    let createdAt = 0;
    for (const line of lines) {
      const row = jsonLine(line);
      if (!row || row.isSidechain === true) continue;
      if (row.sessionId) id = String(row.sessionId);
      if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
      if (!entrypoint && typeof row.entrypoint === 'string') entrypoint = row.entrypoint;
      if (!createdAt) createdAt = timestamp(row.timestamp);
      if ((row.type === 'custom-title' || row.type === 'agent-name')) {
        customTitle = safeText(row.customTitle || row.title || row.custom_title || row.agentName || row.agent_name, 96) || customTitle;
      }
      if (!title && row.type === 'user') title = promptTitle(row.message);
    }
    const cleanId = safeText(id, 256);
    if (!cleanId) continue;
    sessions.push({
      key: archiveKey('claude', cleanId), id: cleanId, provider: 'claude',
      origin: claudeOrigin(entrypoint), title: customTitle || title || path.basename(cwd || cleanId),
      cwd: safeText(cwd, 1024), project: safeText(path.basename(cwd || path.dirname(file)), 160),
      sourcePath: file, sourceAvailable: true, providerArchived: false,
      createdAt: createdAt || stat.birthtimeMs || stat.mtimeMs,
      updatedAt: stat.mtimeMs, size: stat.size,
    });
  }
  return sessions;
}

function codexMetaIgnored(meta) {
  const source = meta && meta.source;
  return meta && (meta.thread_source === 'subagent'
    || (source && typeof source === 'object' && source.subagent));
}

async function scanCodexRoot(root, providerArchived = false, officialTitles = new Map()) {
  const files = await walkJsonl(root, 5);
  const sessions = [];
  for (const file of files) {
    let stat;
    try { stat = await fsp.stat(file); } catch { continue; }
    if (!stat.isFile()) continue;
    const lines = await sampledLines(file, stat.size);
    let meta = null;
    let title = '';
    let lastTitle = '';
    let cwd = '';
    let lastTimestamp = 0;
    for (const line of lines) {
      const row = jsonLine(line);
      if (!row) continue;
      const payload = row.payload || {};
      if (!meta && row.type === 'session_meta') meta = payload;
      if (row.type === 'turn_context' && !cwd && typeof payload.cwd === 'string') cwd = payload.cwd;
      if (row.type === 'event_msg' && payload.type === 'user_message') {
        const next = promptTitle(payload.message);
        if (next) { if (!title) title = next; lastTitle = next; }
      }
      lastTimestamp = Math.max(lastTimestamp, timestamp(row.timestamp));
    }
    meta = meta || {};
    if (codexMetaIgnored(meta)) continue;
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
    const id = safeText(meta.id || meta.session_id || (match && match[1]) || path.basename(file, '.jsonl'), 256);
    if (!id) continue;
    cwd = cwd || (typeof meta.cwd === 'string' ? meta.cwd : '');
    const officialTitle = officialTitles instanceof Map ? officialTitles.get(id) : '';
    sessions.push({
      key: archiveKey('codex', id), id, provider: 'codex', origin: codexOrigin(meta),
      title: safeText(officialTitle, 96) || lastTitle || title || path.basename(cwd || id),
      cwd: safeText(cwd, 1024),
      project: safeText(path.basename(cwd || path.dirname(file)), 160),
      sourcePath: file, sourceAvailable: true, providerArchived: !!providerArchived,
      createdAt: timestamp(meta.timestamp, stat.birthtimeMs || stat.mtimeMs),
      updatedAt: lastTimestamp || stat.mtimeMs, size: stat.size,
    });
  }
  return sessions;
}

async function scanDsh(root) {
  const files = await walkDshLogs(root, 4);
  const sessions = [];
  for (const file of files) {
    const meta = readDshSessionMetadata(file);
    if (!meta || !meta.id) continue;
    const cwd = safeText(meta.cwd, 1024);
    const id = safeText(meta.id, 256);
    if (!id) continue;
    sessions.push({
      key: archiveKey('dsh', id), id, provider: 'dsh', origin: 'harness',
      title: safeText(meta.title, 96) || path.basename(cwd || id), cwd,
      project: safeText(path.basename(cwd || path.dirname(path.dirname(file))), 160),
      sourcePath: file, sourceAvailable: true, providerArchived: false,
      createdAt: Number(meta.createdAt) || Number(meta.updatedAt) || 0,
      updatedAt: Number(meta.updatedAt) || 0, size: Math.max(0, Number(meta.size) || 0),
    });
  }
  return sessions;
}

function cleanPersistedSession(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = ['claude', 'codex', 'dsh'].includes(value.provider) ? value.provider : '';
  const id = safeText(value.id, 256);
  if (!provider || !id) return null;
  return {
    key: archiveKey(provider, id), id, provider,
    origin: ['desktop', 'cli', 'harness', 'unknown'].includes(value.origin) ? value.origin : 'unknown',
    title: safeText(value.title, 96), project: safeText(value.project, 160), cwd: safeText(value.cwd, 1024),
    sourcePath: safeText(value.sourcePath, 4096), sourceAvailable: value.sourceAvailable === true,
    providerArchived: value.providerArchived === true,
    createdAt: Number(value.createdAt) || 0, updatedAt: Number(value.updatedAt) || 0,
    size: Math.max(0, Number(value.size) || 0), lastSeenAt: Number(value.lastSeenAt) || 0,
    backupAvailable: value.backupAvailable === true, backupPath: safeText(value.backupPath, 4096),
    backedUpAt: Number(value.backedUpAt) || 0,
  };
}

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, file);
  try { await fsp.chmod(file, 0o600); } catch {}
}

function createSessionArchive(options = {}) {
  const home = options.homeDir || os.homedir();
  const stateDir = options.stateDir || path.join(home, '.octopus');
  const indexPath = options.indexPath || path.join(stateDir, 'session-archive-index.json');
  const backupRoot = options.backupRoot || path.join(stateDir, 'session-vault');
  const claudeRoot = options.claudeRoot || path.join(home, '.claude', 'projects');
  const codexRoot = options.codexRoot || path.join(home, '.codex', 'sessions');
  const codexArchivedRoot = options.codexArchivedRoot || path.join(home, '.codex', 'archived_sessions');
  const codexSessionIndexPath = options.codexSessionIndexPath || path.join(home, '.codex', 'session_index.jsonl');
  const dshRoot = options.dshRoot || path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'sessions');
  const getSettings = typeof options.getSettings === 'function'
    ? options.getSettings : () => ({ backupEnabled: false, backupIntervalHours: 24 });
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const entries = new Map();
  let loaded = false;
  let refreshPromise = null;
  let backupPromise = null;
  let timer = null;
  let kickoffTimer = null;
  let lastScanAt = 0;
  let lastBackupAt = 0;
  let backupError = '';

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
      if (raw && raw.schema === INDEX_SCHEMA && Array.isArray(raw.sessions)) {
        for (const value of raw.sessions) {
          const session = cleanPersistedSession(value);
          if (session) entries.set(session.key, session);
        }
        lastScanAt = Number(raw.lastScanAt) || 0;
        lastBackupAt = Number(raw.lastBackupAt) || 0;
      }
    } catch {}
  }

  async function save() {
    await atomicJson(indexPath, {
      schema: INDEX_SCHEMA, lastScanAt, lastBackupAt,
      sessions: [...entries.values()],
    });
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      await load();
      const now = Date.now();
      const officialCodexTitles = readCodexSessionIndex(codexSessionIndexPath);
      const discovered = (await Promise.all([
        scanClaude(claudeRoot),
        scanCodexRoot(codexRoot, false, officialCodexTitles),
        scanCodexRoot(codexArchivedRoot, true, officialCodexTitles),
        scanDsh(dshRoot),
      ])).flat();
      // A Codex session can briefly exist in both the live and provider archive
      // directories during a move. Prefer the live copy rather than letting the
      // later archived scan make an openable conversation look unavailable.
      const foundByKey = new Map();
      for (const session of discovered) {
        const prior = foundByKey.get(session.key);
        if (prior && !prior.providerArchived && session.providerArchived) continue;
        if (!prior || !session.providerArchived || session.updatedAt > prior.updatedAt) foundByKey.set(session.key, session);
      }
      const found = [...foundByKey.values()];
      for (const session of entries.values()) session.sourceAvailable = false;
      for (const session of found) {
        const prior = entries.get(session.key) || {};
        entries.set(session.key, {
          ...prior, ...session, lastSeenAt: now,
          backupAvailable: prior.backupAvailable === true,
          backupPath: prior.backupPath || '', backedUpAt: prior.backedUpAt || 0,
        });
      }
      lastScanAt = now;
      await save();
      onChange({ type: 'scan-complete', summary: summary() });
      return summary();
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  function summary() {
    const all = [...entries.values()];
    const bytes = all.filter((s) => s.sourceAvailable).reduce((sum, s) => sum + (s.size || 0), 0);
    const backedUp = all.filter((s) => s.backupAvailable).length;
    return {
      total: all.length,
      claude: all.filter((s) => s.provider === 'claude').length,
      codex: all.filter((s) => s.provider === 'codex').length,
      dsh: all.filter((s) => s.provider === 'dsh').length,
      desktop: all.filter((s) => s.origin === 'desktop').length,
      cli: all.filter((s) => s.origin === 'cli').length,
      harness: all.filter((s) => s.origin === 'harness').length,
      available: all.filter((s) => s.sourceAvailable).length,
      backedUp, bytes, lastScanAt, lastBackupAt, backupError,
      backupRoot,
    };
  }

  function list(query = {}) {
    const provider = ['claude', 'codex', 'dsh'].includes(query.provider) ? query.provider : 'all';
    const origin = ['desktop', 'cli', 'harness'].includes(query.origin) ? query.origin : 'all';
    const backup = query.backup === 'backed-up' || query.backup === 'missing' ? query.backup : 'all';
    const needle = safeText(query.search, 200).toLocaleLowerCase();
    const activeIds = new Set(Array.isArray(query.activeIds) ? query.activeIds.map(String) : []);
    const sessions = [...entries.values()].filter((session) => {
      if (provider !== 'all' && session.provider !== provider) return false;
      if (origin !== 'all' && session.origin !== origin) return false;
      if (backup === 'backed-up' && !session.backupAvailable) return false;
      if (backup === 'missing' && session.backupAvailable) return false;
      if (!needle) return true;
      return [session.title, session.project, session.cwd, session.id]
        .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
    }).map((session) => ({ ...session, active: activeIds.has(session.id) }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.pageSize) || DEFAULT_PAGE_SIZE));
    const page = Math.max(1, Number(query.page) || 1);
    const start = (page - 1) * pageSize;
    return { sessions: sessions.slice(start, start + pageSize), total: sessions.length, page, pageSize, summary: summary() };
  }

  function get(key) { return entries.get(String(key || '')) || null; }

  async function copyTranscript(session) {
    const providerDir = path.join(backupRoot, session.provider);
    await fsp.mkdir(providerDir, { recursive: true, mode: 0o700 });
    const safeId = session.id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 220);
    const suffix = String(session.sourcePath || '').endsWith('.jsonl.zstd') ? '.jsonl.zstd' : '.jsonl';
    const destination = path.join(providerDir, `${safeId}${suffix}`);
    let current = null;
    try { current = await fsp.stat(destination); } catch {}
    if (current && current.size === session.size && current.mtimeMs >= session.updatedAt) {
      return { destination, copied: false };
    }
    const tmp = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
      try { await fsp.copyFile(session.sourcePath, tmp, fs.constants.COPYFILE_FICLONE); }
      catch { await fsp.copyFile(session.sourcePath, tmp); }
      const copied = await fsp.stat(tmp);
      if (copied.size !== session.size) throw new Error('copied-size-mismatch');
      await fsp.rename(tmp, destination);
      try { await fsp.chmod(destination, 0o600); } catch {}
      const stamp = new Date(session.updatedAt || Date.now());
      try { await fsp.utimes(destination, stamp, stamp); } catch {}
      return { destination, copied: true };
    } catch (error) {
      try { await fsp.unlink(tmp); } catch {}
      throw error;
    }
  }

  async function backupNow() {
    if (backupPromise) return backupPromise;
    backupPromise = (async () => {
      await refresh();
      backupError = '';
      const candidates = [...entries.values()].filter((session) => session.sourceAvailable && session.sourcePath);
      let copied = 0;
      let skipped = 0;
      let failed = 0;
      let completed = 0;
      onChange({ type: 'backup-start', total: candidates.length, summary: summary() });
      for (const session of candidates) {
        try {
          const result = await copyTranscript(session);
          if (result.copied) copied++; else skipped++;
          session.backupAvailable = true;
          session.backupPath = result.destination;
          session.backedUpAt = Date.now();
        } catch (error) {
          failed++;
          backupError = safeText(error && error.message, 240) || 'backup-failed';
        }
        completed++;
        onChange({ type: 'backup-progress', completed, total: candidates.length, copied, skipped, failed });
      }
      lastBackupAt = Date.now();
      await save();
      onChange({ type: 'backup-complete', copied, skipped, failed, summary: summary() });
      return { ok: failed === 0, copied, skipped, failed, summary: summary() };
    })().finally(() => { backupPromise = null; });
    return backupPromise;
  }

  function trustedSourcePath(session) {
    const candidate = path.resolve(session && session.sourcePath || '');
    if (!candidate) return '';
    const roots = [claudeRoot, codexRoot, codexArchivedRoot, dshRoot].map((root) => path.resolve(root) + path.sep);
    const supportedLog = candidate.endsWith('.jsonl') || candidate.endsWith('.jsonl.zstd');
    return roots.some((root) => candidate.startsWith(root)) && supportedLog ? candidate : '';
  }

  async function restore(key) {
    await load();
    const session = entries.get(String(key || ''));
    if (!session || !session.backupAvailable || !session.backupPath) return { ok: false, code: 'backup-missing' };
    const destination = trustedSourcePath(session);
    const source = path.resolve(session.backupPath);
    const trustedBackupRoot = path.resolve(backupRoot) + path.sep;
    if (!destination || !source.startsWith(trustedBackupRoot)) return { ok: false, code: 'unsafe-path' };
    try {
      await fsp.access(source, fs.constants.R_OK);
      try {
        await fsp.access(destination, fs.constants.F_OK);
        session.sourceAvailable = true;
        return { ok: true, code: 'already-present', session: { ...session } };
      } catch {}
      await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const tmp = `${destination}.${process.pid}.${Date.now()}.restore.tmp`;
      try {
        await fsp.copyFile(source, tmp);
        const [backupStat, restoredStat] = await Promise.all([fsp.stat(source), fsp.stat(tmp)]);
        if (backupStat.size !== restoredStat.size) throw new Error('restored-size-mismatch');
        await fsp.rename(tmp, destination);
      } catch (error) {
        try { await fsp.unlink(tmp); } catch {}
        throw error;
      }
      try { await fsp.chmod(destination, 0o600); } catch {}
      const stat = await fsp.stat(destination);
      session.sourceAvailable = true;
      session.size = stat.size;
      session.updatedAt = stat.mtimeMs;
      session.lastSeenAt = Date.now();
      await save();
      onChange({ type: 'restore-complete', key: session.key, summary: summary() });
      return { ok: true, code: 'restored', session: { ...session } };
    } catch (error) {
      return { ok: false, code: 'restore-failed', detail: safeText(error && error.message, 240) };
    }
  }

  function schedule() {
    if (timer) { clearInterval(timer); timer = null; }
    if (kickoffTimer) { clearTimeout(kickoffTimer); kickoffTimer = null; }
    const settings = getSettings() || {};
    if (settings.backupEnabled !== true) return;
    const hours = Math.max(1, Number(settings.backupIntervalHours) || 24);
    const dueAfter = hours * 60 * 60 * 1000;
    if (!lastBackupAt || Date.now() - lastBackupAt >= dueAfter) {
      kickoffTimer = setTimeout(() => {
        kickoffTimer = null;
        backupNow().catch((error) => { backupError = safeText(error && error.message, 240); });
      }, 10000);
      if (kickoffTimer.unref) kickoffTimer.unref();
    }
    const period = Math.min(hours * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
    timer = setInterval(() => {
      const liveSettings = getSettings() || {};
      const interval = Math.max(1, Number(liveSettings.backupIntervalHours) || 24) * 60 * 60 * 1000;
      if (liveSettings.backupEnabled === true && Date.now() - lastBackupAt >= interval) {
        backupNow().catch((error) => { backupError = safeText(error && error.message, 240); });
      }
    }, period);
    if (timer.unref) timer.unref();
  }

  async function start() {
    await load();
    schedule();
    return refresh();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (kickoffTimer) { clearTimeout(kickoffTimer); kickoffTimer = null; }
  }

  return { start, stop, refresh, list, get, summary, backupNow, restore, schedule, backupRoot, indexPath };
}

module.exports = {
  createSessionArchive,
  scanClaude,
  scanCodexRoot,
  scanDsh,
  archiveKey,
  promptTitle,
};
