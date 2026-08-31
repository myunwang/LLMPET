'use strict';

// Persistent CodeWhale token + cost ledger.
//
// Data source: the turn_end hook event carries the authoritative per-turn
// usage inline (verified CodeWhale contract) — no session-file parsing, no
// cumulative-counter guessing. Each turn is keyed by turn_id so a retried
// hook delivery cannot double-bill; events without a turn_id fall back to a
// session+model+usage digest.
//
// Verified usage shape (CodeWhale turn_end stdin):
//   usage: { input_tokens, output_tokens, prompt_cache_hit_tokens,
//            prompt_cache_miss_tokens, prompt_cache_write_tokens,
//            reasoning_tokens, reasoning_replay_tokens }
// DeepSeek-style semantics: input_tokens = hit + miss. Billing therefore uses
// the NON-cached input for the input price and the cache-hit tokens for the
// cache-read price, so cached tokens are never charged twice.
// reasoning_tokens are a subset of output (reported, never added on top).
// reasoning_replay_tokens have ambiguous upstream pricing — counted in
// diagnostics only, deliberately NOT billed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');
const archiveUtil = require('./usage-archive');
const modelsDev = require('./models-dev-sync');

const STATE_DIR = process.env.LLMPET_CODEWHALE_HOME
  ? path.join(process.env.LLMPET_CODEWHALE_HOME)
  : path.join(os.homedir(), '.octopus');
const STATE_PATH = path.join(STATE_DIR, 'codewhale-usage.json');
const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_KEEP_DAYS = 95;
const WINDOW_MS = 5 * 60 * 60 * 1000; // matches the Claude/Codex ledgers
const RECENT_KEEP_MS = WINDOW_MS + 30 * 60 * 1000;
const MAX_SEEN_TURNS = 20000;        // bounded dedup window
const SAVE_DEBOUNCE_MS = 4000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function emptyDay() {
  return { cost: 0, tokens: 0, msgs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── pricing ───────────────────────────────────────────────────────────────────
// Priority: provider-qualified row → bare model row → unknown ($0, tracked in
// diagnostics — an honest gap, never a guess).
let catalog = null;
let catalogLoaded = false;

function reloadPricing() {
  catalog = modelsDev.loadCatalog();
  catalogLoaded = true;
  return !!catalog;
}

function priceFor(provider, model) {
  if (!catalogLoaded) reloadPricing();
  if (!catalog) return null;
  const entries = catalog.entries;
  const key = (provider && typeof provider === 'string' && model) ? `${provider}/${model}` : null;
  if (key && Object.prototype.hasOwnProperty.call(entries, key)) return entries[key];
  if (model && Object.prototype.hasOwnProperty.call(entries, model)) return entries[model];
  return null;
}

function usageCost(row, provider) {
  const price = priceFor(provider, row.model);
  if (!price) return { cost: 0, exact: false, source: 'unknown' };
  // DeepSeek semantics: input_tokens already includes the cache-hit portion.
  const cacheRead = row.cacheRead;
  const uncachedInput = Math.max(0, row.input - cacheRead);
  const cost =
    (uncachedInput / 1e6) * (price.input_usd_per_million || 0)
    + (row.output / 1e6) * (price.output_usd_per_million || 0)
    + (cacheRead / 1e6) * (price.cache_read_usd_per_million || 0)
    + (row.cacheWrite / 1e6) * (price.cache_write_usd_per_million || 0);
  return { cost, exact: true, source: price.provenance || 'models.dev' };
}

// Verified turn_end usage → ledger row.
function normalizeUsage(raw, model) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.prompt_cache_hit_tokens);
  const cacheWrite = num(u.prompt_cache_write_tokens);
  return {
    model: typeof model === 'string' && model ? model : '(unknown)',
    tokens: input + output,
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoningOutput: num(u.reasoning_tokens),
    reasoningReplay: num(u.reasoning_replay_tokens),
  };
}

function digest(row) {
  return `${row.model}|${row.tokens}|${row.input}|${row.output}|${row.cacheRead}|${row.cacheWrite}`;
}

function createState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    daily: {},          // dayKey → aggregate row
    byModelByDay: {},   // dayKey → model → aggregate row
    seenTurns: {},      // turn_id/digest → last ts (dedup)
    window: [],         // recent events for the 5h rolling window
    diagnostics: { unknownModels: {}, replayTokens: 0 },
  };
}

function createCodeWhaleMetering(options = {}) {
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const statePath = options.statePath || STATE_PATH;
  const state = createState();
  let saveTimer = null;
  let dirty = false;

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  } catch {}

  // seenTurns pruning keeps the dedup map bounded. A size counter guards the
  // check so the common path stays O(1): calling Object.keys() on every
  // record was the dominant cost once the map grew (20k keys → ~1ms per
  // record). Pruning is batched — over the cap we drop down to half of it,
  // amortizing the O(n log n) sort over MAX_SEEN_TURNS/2 records.
  let seenCount = 0;
  function pruneSeen() {
    if (seenCount <= MAX_SEEN_TURNS) return;
    const keys = Object.keys(state.seenTurns);
    keys.sort((a, b) => state.seenTurns[a] - state.seenTurns[b]);
    const keep = Math.floor(MAX_SEEN_TURNS / 2);
    const drop = keys.slice(0, keys.length - keep);
    for (const k of drop) delete state.seenTurns[k];
    seenCount = keys.length - drop.length;
  }

  function markSeen(key, now) {
    state.seenTurns[key] = now;
    seenCount += 1;
    pruneSeen();
  }

  function record(turn) {
    const now = Date.now();
    // Aborted/errored turns can still carry usage (partial generations bill
    // upstream); only an explicit non-completed status with ZERO usage is noise.
    const row = normalizeUsage(turn.usage, turn.model);
    if (!row.tokens) return false;
    const key = turn.turnId ? `t:${turn.turnId}` : `d:${turn.sessionId || ''}:${digest(row)}`;
    if (Object.prototype.hasOwnProperty.call(state.seenTurns, key)) return false;
    markSeen(key, now);

    const priced = usageCost(row, turn.provider);
    if (!priced.exact) {
      state.diagnostics.unknownModels[row.model] = (state.diagnostics.unknownModels[row.model] || 0) + row.tokens;
    }
    if (row.reasoningReplay) {
      state.diagnostics.replayTokens = num(state.diagnostics.replayTokens) + row.reasoningReplay;
    }

    const day = dayKey(now);
    const d = state.daily[day] || (state.daily[day] = emptyDay());
    d.cost += priced.cost;
    d.tokens += row.tokens;
    d.msgs += 1;
    d.input += row.input;
    d.output += row.output;
    d.cacheRead += row.cacheRead;
    d.cacheWrite += row.cacheWrite;

    const bm = state.byModelByDay[day] || (state.byModelByDay[day] = {});
    const m = bm[row.model] || (bm[row.model] = { ...emptyDay(), model: row.model });
    m.cost += priced.cost;
    m.tokens += row.tokens;
    m.msgs += 1;
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;

    state.window.push({ ts: now, cost: priced.cost, tokens: row.tokens });
    dirty = true;
    onChange();
    return true;
  }

  function window5h() {
    const now = Date.now();
    state.window = state.window.filter((e) => now - e.ts <= RECENT_KEEP_MS);
    const inWindow = state.window.filter((e) => now - e.ts <= WINDOW_MS);
    return {
      cost: inWindow.reduce((a, e) => a + e.cost, 0),
      tokens: inWindow.reduce((a, e) => a + e.tokens, 0),
      startsAt: inWindow.length ? Math.min(...inWindow.map((e) => e.ts)) : null,
    };
  }

  function pruneDays() {
    const cutoff = dayKey(Date.now() - DAILY_KEEP_DAYS * DAY_MS);
    for (const day of Object.keys(state.daily)) {
      if (day < cutoff) {
        delete state.daily[day];
        if (state.byModelByDay[day]) delete state.byModelByDay[day];
      }
    }
  }

  function getStats() {
    const todayKey = dayKey(Date.now());
    const daily = archiveUtil.mergedDaily(state.daily, null);
    return {
      today: { ...emptyDay(), ...(state.daily[todayKey] || {}) },
      lifetime: { ...emptyDay(), ...archiveUtil.mergedLifetime(emptyDay(), null, daily) },
      window5h: window5h(),
      daily: Object.fromEntries(Object.entries(daily).map(([key, value]) => [
        key, { cost: num(value.cost), tokens: num(value.tokens), msgs: num(value.msgs) },
      ])),
      byModel: Object.fromEntries(Object.entries(state.byModelByDay[todayKey] || {}).map(([model, row]) => {
        const resolved = usageCost({ ...row, model }, null);
        return [model, {
          ...row,
          unitPrice: priceFor(null, model) || null,
          priceExact: resolved.exact,
          priceSource: resolved.source,
        }];
      })),
      diagnostics: {
        ...state.diagnostics,
        unknownModelCount: Object.keys(state.diagnostics.unknownModels || {}).length,
        catalogFetchedAt: catalog ? catalog.fetched_at : null,
      },
    };
  }

  function load() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    if (raw.schemaVersion !== SCHEMA_VERSION) return; // fresh start on bump (archive on later bumps)
    state.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
    state.byModelByDay = raw.byModelByDay && typeof raw.byModelByDay === 'object' ? raw.byModelByDay : {};
    state.seenTurns = raw.seenTurns && typeof raw.seenTurns === 'object' ? raw.seenTurns : {};
    seenCount = Object.keys(state.seenTurns).length;
    state.window = Array.isArray(raw.window) ? raw.window.filter((e) => e && typeof e === 'object') : [];
    state.diagnostics = raw.diagnostics && typeof raw.diagnostics === 'object'
      ? raw.diagnostics
      : { unknownModels: {}, replayTokens: 0 };
  }

  function save() {
    if (!dirty) return;
    try {
      pruneDays();
      const tmp = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        daily: state.daily,
        byModelByDay: state.byModelByDay,
        seenTurns: state.seenTurns,
        window: state.window,
        diagnostics: state.diagnostics,
      }));
      fs.renameSync(tmp, statePath);
      dirty = false;
    } catch (e) {
      log('codewhale-metering', `save failed: ${e.message}`);
    }
  }

  function start(intervalMs = 30000) {
    load();
    reloadPricing();
    // One background refresh per boot (+ every 24h while running) keeps prices
    // current; failure keeps the previous cache and never blocks anything.
    const sync = async () => {
      try {
        const age = modelsDev.catalogAgeMs(catalog);
        if (!catalog || age > modelsDev.TTL_MS) {
          await modelsDev.refresh();
          reloadPricing();
          onChange();
        }
      } catch (e) {
        log('models.dev', `refresh failed (keeping cache): ${e.message}`);
      }
    };
    sync();
    const timer = setInterval(() => { save(); sync(); }, intervalMs);
    if (timer.unref) timer.unref();
    return { stop: () => { clearInterval(timer); save(); } };
  }

  return { record, getStats, reloadPricing, start, save, statePath };
}

module.exports = { createCodeWhaleMetering, normalizeUsage, usageCost, STATE_PATH };
