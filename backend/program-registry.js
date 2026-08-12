'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;

function cleanText(value, max = 160) {
  return String(value || '').replace(/[\r\n\u0000]/g, ' ').trim().slice(0, max);
}

function absolutePath(value, base = process.cwd()) {
  const raw = String(value || '').trim();
  return raw ? path.resolve(base, raw) : '';
}

function stableId(record) {
  const launch = record.launch || {};
  const identity = [record.cwd, launch.type, launch.command, ...(launch.args || []), launch.target].join('\u0000');
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function normalizeRecord(input, now = Date.now()) {
  const cwd = absolutePath(input && input.cwd);
  const launchInput = input && input.launch || {};
  const launchType = launchInput.type === 'open' ? 'open' : 'command';
  const launch = launchType === 'open'
    ? { type: 'open', target: absolutePath(launchInput.target, cwd || process.cwd()) }
    : {
      type: 'command',
      command: cleanText(launchInput.command, 240),
      args: Array.isArray(launchInput.args) ? launchInput.args.map((arg) => cleanText(arg, 500)).slice(0, 32) : [],
      terminal: launchInput.terminal !== false,
    };
  if (!cwd) throw new Error('cwd is required');
  if (launch.type === 'open' && !launch.target) throw new Error('open target is required');
  if (launch.type === 'command' && !launch.command) throw new Error('command is required');
  const record = {
    id: cleanText(input && input.id, 80),
    name: cleanText(input && input.name, 80) || path.basename(cwd),
    description: cleanText(input && input.description, 240),
    cwd,
    icon: absolutePath(input && input.icon, cwd),
    provider: input && input.provider === 'claude' ? 'claude' : input && input.provider === 'codex' ? 'codex' : 'unknown',
    launch,
    verifiedAt: Number(input && input.verifiedAt) || now,
    createdAt: Number(input && input.createdAt) || now,
    updatedAt: now,
  };
  if (!record.id) record.id = stableId(record);
  return record;
}

function readRegistry(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      schemaVersion: SCHEMA_VERSION,
      programs: Array.isArray(parsed.programs) ? parsed.programs : [],
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return { schemaVersion: SCHEMA_VERSION, programs: [], updatedAt: 0 };
  }
}

function writeRegistry(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, programs: state.programs, updatedAt: Date.now() }, null, 2) + '\n';
  const temp = path.join(path.dirname(statePath), `.generated-programs.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, statePath);
}

function registerProgram(input, options = {}) {
  const statePath = options.statePath || path.join(os.homedir(), '.octopus', 'generated-programs.json');
  const record = normalizeRecord(input);
  if (!fs.existsSync(record.cwd)) throw new Error(`working directory does not exist: ${record.cwd}`);
  if (record.launch.type === 'open' && !fs.existsSync(record.launch.target)) {
    throw new Error(`open target does not exist: ${record.launch.target}`);
  }
  const state = readRegistry(statePath);
  const previous = state.programs.find((item) => item && item.id === record.id);
  record.createdAt = previous && Number(previous.createdAt) || record.createdAt;
  state.programs = [record, ...state.programs.filter((item) => item && item.id !== record.id)].slice(0, 500);
  writeRegistry(statePath, state);
  return record;
}

function createProgramRegistry(options = {}) {
  const statePath = options.statePath || path.join(os.homedir(), '.octopus', 'generated-programs.json');
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const launchCommand = typeof options.launchCommand === 'function' ? options.launchCommand : async () => ({ ok: false, code: 'no-launcher' });
  const openPath = typeof options.openPath === 'function' ? options.openPath : async () => 'no-opener';
  const revealPath = typeof options.revealPath === 'function' ? options.revealPath : () => {};
  let watcher = null;
  let lastMtime = 0;

  function list() {
    const state = readRegistry(statePath);
    return state.programs.map((item) => {
      let record;
      try { record = normalizeRecord(item, Number(item.updatedAt) || Date.now()); }
      catch { return null; }
      record.createdAt = Number(item.createdAt) || record.createdAt;
      record.updatedAt = Number(item.updatedAt) || record.updatedAt;
      record.verifiedAt = Number(item.verifiedAt) || record.verifiedAt;
      const cwdAvailable = fs.existsSync(record.cwd);
      const targetAvailable = record.launch.type !== 'open' || fs.existsSync(record.launch.target);
      const iconAvailable = !!record.icon && fs.existsSync(record.icon);
      return { ...record, available: cwdAvailable && targetAvailable, iconAvailable };
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function get(id) { return list().find((item) => item.id === id) || null; }

  async function launch(id) {
    const record = get(cleanText(id, 80));
    if (!record) return { ok: false, code: 'not-found' };
    if (!record.available) return { ok: false, code: 'missing' };
    if (record.launch.type === 'open') {
      const error = await openPath(record.launch.target);
      return error ? { ok: false, code: 'open-failed', message: error } : { ok: true, mode: 'open' };
    }
    return launchCommand(record);
  }

  function reveal(id) {
    const record = get(cleanText(id, 80));
    if (!record) return false;
    revealPath(record.launch.type === 'open' ? record.launch.target : record.cwd);
    return true;
  }

  function remove(id) {
    const state = readRegistry(statePath);
    const before = state.programs.length;
    state.programs = state.programs.filter((item) => item && item.id !== id);
    if (state.programs.length === before) return false;
    writeRegistry(statePath, state);
    onChange({ type: 'removed', id });
    return true;
  }

  function start() {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(statePath)) writeRegistry(statePath, { programs: [] });
    try { lastMtime = fs.statSync(statePath).mtimeMs; } catch {}
    watcher = setInterval(() => {
      let mtime = 0;
      try { mtime = fs.statSync(statePath).mtimeMs; } catch {}
      if (mtime && mtime !== lastMtime) {
        lastMtime = mtime;
        onChange({ type: 'changed', count: list().length });
      }
    }, 1200);
    watcher.unref?.();
  }

  function stop() { if (watcher) clearInterval(watcher); watcher = null; }

  return { statePath, start, stop, list, get, launch, reveal, remove };
}

module.exports = {
  SCHEMA_VERSION,
  normalizeRecord,
  readRegistry,
  writeRegistry,
  registerProgram,
  createProgramRegistry,
};
