'use strict';

// Persistent Codex token + cost ledger.
//
// Codex rollout token_count events expose both total_token_usage (a cumulative
// counter that can reset after compaction/context reconstruction) and
// last_token_usage (the exact current request). We ledger last_token_usage once
// per append-only event. Using positive cumulative deltas over-counted a real
// day by >10x because every cumulative reset re-added a large partial history.
// Cached input and reasoning output are subsets of input/output, so they are
// reported separately but never added on top of total_tokens.
//
// Every event is priced through codex-pricing.js (OpenAI rates synced from the
// same public LiteLLM table as the Claude side). Before that this ledger counted
// tokens and billed them at $0, so a Codex-heavy day showed no spend at all.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { log } = require('./log');
const archiveUtil = require('./usage-archive');
const { loadCodexPricing, priceForCodex, codexUsageCost } = require('./codex-pricing');

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const STATE_DIR = path.join(os.homedir(), '.octopus');
const STATE_PATH = path.join(STATE_DIR, 'codex-usage.json');
const SCHEMA_VERSION = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_KEEP_DAYS = 95;
const WINDOW_MS = 5 * 60 * 60 * 1000;                 // matches the Claude ledger
const RECENT_KEEP_MS = WINDOW_MS + 30 * 60 * 1000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function emptyUsage() {
  return {
    tokens: 0, input: 0, output: 0, cachedInput: 0,
    reasoningOutput: 0, cacheWrite: 0,
  };
}

function normalizeUsage(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const input = num(u.input_tokens ?? u.inputTokens);
  const output = num(u.output_tokens ?? u.outputTokens);
  return {
    tokens: num(u.total_tokens ?? u.totalTokens) || input + output,
    input,
    output,
    cachedInput: num(u.cached_input_tokens ?? u.cachedInputTokens),
    reasoningOutput: num(u.reasoning_output_tokens ?? u.reasoningOutputTokens),
    cacheWrite: num(u.cache_write_input_tokens ?? u.cacheWriteInputTokens),
  };
}

function deltaUsage(previous, current) {
  const a = previous || emptyUsage();
  const b = current || emptyUsage();
  // A lower total means Codex restarted its cumulative counter. Treat the new
  // snapshot as a fresh segment instead of producing a negative delta.
  const reset = num(b.tokens) < num(a.tokens);
  const out = {};
  for (const key of Object.keys(emptyUsage())) {
    out[key] = reset ? num(b[key]) : Math.max(0, num(b[key]) - num(a[key]));
  }
  return out;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyDay() {
  return { ...emptyUsage(), cost: 0, msgs: 0 };
}

function addUsage(target, delta, messageDelta = 0, cost = 0) {
  for (const key of Object.keys(emptyUsage())) target[key] = num(target[key]) + num(delta[key]);
  target.cost = num(target.cost) + (Number.isFinite(cost) ? cost : 0);
  target.msgs = num(target.msgs) + messageDelta;
}

function createCodexMetering(options = {}) {
  const sessionsDir = options.sessionsDir || SESSIONS_DIR;
  const stateDir = options.stateDir || STATE_DIR;
  const statePath = options.statePath || path.join(stateDir, 'codex-usage.json');
  const pricingPaths = {
    pricingCachePath: options.pricingCachePath || path.join(stateDir, 'pricing-cache.json'),
    pricingOverridePath: options.pricingOverridePath || path.join(stateDir, 'pricing.json'),
  };
  let pricing = loadCodexPricing(pricingPaths);

  const state = {
    schemaVersion: SCHEMA_VERSION,
    files: {},     // path -> { offset, carry, sessionId, model }
    sessions: {},  // sessionId/path -> latest cumulative usage (reset diagnostics only)
    daily: {},
    hourlyByDay: {},
    hourlyTokensByDay: {},
    byModelByDay: {},
    recent: [],          // [{ ts, cost, tokens }] within RECENT_KEEP_MS, for window5h
    carried: emptyDay(), // days pruned out of the window; lifetime = carried + daily
    archive: null,       // frozen aggregates from a previous schema (usage-archive.js)
    diagnostics: { lastScanTs: 0, scannedFiles: 0, events: 0, resets: 0, migratedFrom: null, estimatedModels: {} },
  };
  let scanning = false;
  let dirty = false;
  let saveTimer = null;
  let timer = null;

  function reset() {
    state.files = {};
    state.sessions = {};
    state.daily = {};
    state.hourlyByDay = {};
    state.hourlyTokensByDay = {};
    state.byModelByDay = {};
    state.recent = [];
    state.carried = emptyDay();
    state.diagnostics = {
      lastScanTs: 0, scannedFiles: 0, events: 0, resets: 0, migratedFrom: null, estimatedModels: {},
    };
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      if (raw.schemaVersion !== SCHEMA_VERSION) {
        // Same protection as the Claude ledger: freeze the old aggregates rather
        // than dropping them. Codex rollouts are re-scannable for longer than
        // Claude transcripts, but not forever — a discarded day is unrecoverable.
        state.diagnostics.migratedFrom = Number(raw.schemaVersion) || 1;
        state.archive = archiveUtil.mergeArchives(raw.archive || null, archiveUtil.buildArchive(raw));
        const kept = state.archive ? Object.keys(state.archive.daily).length : 0;
        log('codex-meter', `usage schema ${state.diagnostics.migratedFrom} → ${SCHEMA_VERSION}; rebuilding from rollouts (archived ${kept} day(s) of history)`);
        return;
      }
      state.files = raw.files && typeof raw.files === 'object' ? raw.files : {};
      state.sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
      state.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
      state.hourlyByDay = raw.hourlyByDay && typeof raw.hourlyByDay === 'object' ? raw.hourlyByDay : {};
      state.hourlyTokensByDay = raw.hourlyTokensByDay && typeof raw.hourlyTokensByDay === 'object' ? raw.hourlyTokensByDay : {};
      state.byModelByDay = raw.byModelByDay && typeof raw.byModelByDay === 'object' ? raw.byModelByDay : {};
      state.recent = Array.isArray(raw.recent) ? raw.recent : [];
      state.archive = raw.archive || null;
      if (raw.carried && typeof raw.carried === 'object') {
        state.carried = { ...emptyDay(), ...raw.carried };
      } else if (raw.lifetime && typeof raw.lifetime === 'object') {
        const retained = archiveUtil.sumRows(Object.values(state.daily));
        state.carried = emptyDay();
        for (const key of Object.keys(state.carried)) {
          state.carried[key] = Math.max(0, num(raw.lifetime[key]) - num(retained[key]));
        }
      }
      state.diagnostics = raw.diagnostics && typeof raw.diagnostics === 'object'
        ? { ...state.diagnostics, ...raw.diagnostics } : state.diagnostics;
    } catch {}
    pruneDaily();
  }

  function pruneDaily() {
    const cutoff = dayKey(Date.now() - DAILY_KEEP_DAYS * DAY_MS);
    for (const key of Object.keys(state.daily)) {
      if (key >= cutoff) continue;
      archiveUtil.addRow(state.carried, state.daily[key]);
      delete state.daily[key];
    }
    for (const key of Object.keys(state.hourlyByDay)) if (key < cutoff) delete state.hourlyByDay[key];
    for (const key of Object.keys(state.hourlyTokensByDay)) if (key < cutoff) delete state.hourlyTokensByDay[key];
    for (const key of Object.keys(state.byModelByDay)) if (key < cutoff) delete state.byModelByDay[key];
    state.archive = archiveUtil.pruneArchive(state.archive, state.daily, cutoff);
  }

  function saveNow() {
    dirty = false;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = path.join(stateDir, `.codex-usage.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (error) {
      log('codex-meter', 'save failed:', error.message);
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) saveNow(); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  async function listFiles(dir = sessionsDir, out = []) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await listFiles(full, out);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
  }

  function record(ts, model, delta) {
    if (num(delta.tokens) <= 0) return;
    const modelKey = model || 'unknown';
    const { price, exact } = priceForCodex(pricing, modelKey);
    const cost = codexUsageCost(delta, price);
    if (!exact) {
      const estimates = state.diagnostics.estimatedModels || (state.diagnostics.estimatedModels = {});
      estimates[modelKey] = num(estimates[modelKey]) + 1;
    }

    const key = dayKey(ts);
    const day = (state.daily[key] = state.daily[key] || emptyDay());
    addUsage(day, delta, 1, cost);
    const hour = new Date(ts).getHours();
    // hourlyByDay is cost (what the panel's 24h chart plots for Claude too);
    // hourlyTokensByDay keeps the token view the chart can toggle to.
    const hours = (state.hourlyByDay[key] = state.hourlyByDay[key] || new Array(24).fill(0));
    hours[hour] += cost;
    const hourTokens = (state.hourlyTokensByDay[key] = state.hourlyTokensByDay[key] || new Array(24).fill(0));
    hourTokens[hour] += delta.tokens;
    const models = (state.byModelByDay[key] = state.byModelByDay[key] || {});
    const row = (models[modelKey] = models[modelKey] || emptyDay());
    addUsage(row, delta, 1, cost);

    if (Date.now() - ts < RECENT_KEEP_MS) state.recent.push({ ts, cost, tokens: delta.tokens });
  }

  function pruneRecent() {
    const cutoff = Date.now() - RECENT_KEEP_MS;
    if (!state.recent.length) return;
    // Rollouts are scanned in path order, so `recent` is not time-ordered.
    if (state.recent.some((r) => r.ts < cutoff)) {
      state.recent = state.recent.filter((r) => r.ts >= cutoff);
    }
  }

  // Rolling 5h spend, same shape as the Claude ledger's window5h.
  function window5h() {
    const windowStart = Date.now() - WINDOW_MS;
    let cost = 0, tokens = 0, oldest = 0;
    for (const r of state.recent) {
      if (r.ts < windowStart) continue;
      cost += num(r.cost); tokens += num(r.tokens);
      if (!oldest || r.ts < oldest) oldest = r.ts;
    }
    return { cost, tokens, startTs: oldest || 0, resetTs: oldest ? oldest + WINDOW_MS : 0 };
  }

  function processObject(fileState, file, object) {
    const payload = object && object.payload && typeof object.payload === 'object' ? object.payload : {};
    if (object.type === 'session_meta') {
      fileState.sessionId = String(payload.id || payload.session_id || fileState.sessionId || file);
      return;
    }
    if (object.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) fileState.model = payload.model;
      return;
    }
    if (object.type !== 'event_msg' || payload.type !== 'token_count') return;
    const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
    const cumulative = normalizeUsage(info.total_token_usage || info.totalTokenUsage);
    const current = normalizeUsage(info.last_token_usage || info.lastTokenUsage);
    if (current.tokens <= 0) return;
    const sessionKey = fileState.sessionId || file;
    const previous = state.sessions[sessionKey] && state.sessions[sessionKey].usage;
    if (previous && cumulative.tokens < num(previous.tokens)) state.diagnostics.resets++;
    state.sessions[sessionKey] = { usage: cumulative, updatedAt: Date.parse(object.timestamp) || Date.now() };
    const ts = Date.parse(object.timestamp) || Date.now();
    record(ts, fileState.model, current);
    state.diagnostics.events++;
  }

  async function scanFile(file) {
    let stat;
    try { stat = await fsp.stat(file); } catch { return; }
    const fileState = state.files[file] || { offset: 0, carry: '', sessionId: null, model: null };
    if (fileState.offset > stat.size) {
      // Rollouts are append-only. A truncation invalidates the cumulative cursor;
      // a full rebuild is safer than silently double counting.
      state.diagnostics.truncated = (state.diagnostics.truncated || 0) + 1;
      return;
    }
    if (fileState.offset === stat.size) return;
    const stream = fs.createReadStream(file, { start: fileState.offset, encoding: 'utf8' });
    let carry = fileState.carry || '';
    for await (const chunk of stream) {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() || '';
      for (const line of lines) {
        if (!line || line.charCodeAt(0) !== 123) continue;
        let object;
        try { object = JSON.parse(line); } catch { continue; }
        processObject(fileState, file, object);
      }
    }
    fileState.offset = stat.size;
    fileState.carry = carry;
    state.files[file] = fileState;
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const files = (await listFiles()).sort();
      for (const file of files) {
        try { await scanFile(file); } catch (error) { log('codex-meter', 'scanFile failed:', path.basename(file), error.message); }
      }
      state.diagnostics.lastScanTs = Date.now();
      state.diagnostics.scannedFiles = files.length;
      pruneRecent();
      pruneDaily();
      scheduleSave();
    } catch (error) {
      log('codex-meter', 'scan failed:', error.message);
    } finally {
      scanning = false;
    }
  }

  function getStats() {
    const todayKey = dayKey(Date.now());
    const daily = archiveUtil.mergedDaily(state.daily, state.archive);
    const estimated = state.diagnostics.estimatedModels || {};
    return {
      today: { ...emptyDay(), ...(state.daily[todayKey] || {}) },
      lifetime: { ...emptyDay(), ...archiveUtil.mergedLifetime(state.carried, state.archive, daily) },
      window5h: window5h(),
      hourly: (state.hourlyByDay[todayKey] || new Array(24).fill(0)).slice(),
      hourlyTok: (state.hourlyTokensByDay[todayKey] || new Array(24).fill(0)).slice(),
      daily: Object.fromEntries(Object.entries(daily).map(([key, value]) => [
        key, { cost: num(value.cost), tokens: num(value.tokens), msgs: num(value.msgs) },
      ])),
      byModel: state.byModelByDay[todayKey] ? { ...state.byModelByDay[todayKey] } : {},
      diagnostics: {
        ...state.diagnostics,
        sessions: Object.keys(state.sessions).length,
        estimatedModelCount: Object.keys(estimated).length,
        estimatedModels: Object.entries(estimated)
          .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([model, count]) => ({ model, count })),
      },
    };
  }

  async function rebuild() {
    // Archive before wiping — a rollout that has aged out of ~/.codex/sessions
    // cannot be re-read, so its day would otherwise disappear for good.
    const archived = archiveUtil.mergeArchives(state.archive, archiveUtil.buildArchive({
      schemaVersion: SCHEMA_VERSION,
      daily: state.daily,
      byModelByDay: state.byModelByDay,
      hourlyByDay: state.hourlyByDay,
      hourlyTokensByDay: state.hourlyTokensByDay,
      lifetime: archiveUtil.mergedLifetime(state.carried, null, state.daily),
    }));
    reset();
    state.archive = archived;
    pricing = loadCodexPricing(pricingPaths);
    await scan();
    saveNow();
    return getStats();
  }

  // Re-read the price table and re-cost every retained day from its per-model
  // token breakdown. Codex keeps no per-event records, but byModelByDay holds
  // the exact token quadruple per model, which is all the cost formula needs.
  function reloadPricing() {
    pricing = loadCodexPricing(pricingPaths);
    state.diagnostics.estimatedModels = {};
    for (const [day, models] of Object.entries(state.byModelByDay)) {
      const dayRow = (state.daily[day] = state.daily[day] || emptyDay());
      let dayCost = 0;
      for (const [model, row] of Object.entries(models)) {
        const { price, exact } = priceForCodex(pricing, model);
        row.cost = codexUsageCost(row, price);
        dayCost += row.cost;
        if (!exact) {
          const estimates = state.diagnostics.estimatedModels;
          estimates[model] = num(estimates[model]) + num(row.msgs);
        }
      }
      // Redistribute the day's cost over its hourly token curve. Scaling the old
      // cost curve instead would collapse to zero for a day recorded before this
      // ledger had any cost at all.
      const hourTokens = state.hourlyTokensByDay[day];
      if (Array.isArray(hourTokens)) {
        const totalTokens = hourTokens.reduce((sum, v) => sum + num(v), 0);
        state.hourlyByDay[day] = hourTokens.map((v) => (totalTokens ? (dayCost * num(v)) / totalTokens : 0));
      }
      dayRow.cost = dayCost;
    }
    scheduleSave();
  }

  function start(intervalMs = 30000) {
    load();
    scan();
    timer = setInterval(scan, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
  }

  return {
    start, stop, scan, rebuild, reloadPricing, getStats,
    _state: state, _processObject: processObject,
  };
}

module.exports = { createCodexMetering, normalizeUsage, deltaUsage, emptyUsage };
