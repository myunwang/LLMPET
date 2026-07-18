'use strict';

// CodeWhale metering — token usage from turn_end events × bundled catalog prices.
//
// Unlike Claude's metering.js (which scans JSONL transcript files), CodeWhale's
// turn_end hook delivers the full usage object directly (R2.3). We record it
// on arrival — no file scanning needed.
//
// Pricing source: model_catalog.bundled.json (R2.13) — shipped with CodeWhale,
// copied to backend/model-catalog.bundled.json. Entries have
//   input_usd_per_million, output_usd_per_million, context_window
// Cache pricing is not in the catalog; we estimate:
//   cache_read ≈ 0.1× input,  cache_write ≈ 1.25× input
// (same ratios as Claude's DEFAULT_PRICING).
//
// Unknown-price models are recorded with cost=0 and flagged; they don't corrupt
// aggregates (R2.13: "unknown price → None, not fabricated $0").

const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('./log');

const CATALOG_PATH = path.join(__dirname, 'model-catalog.bundled.json');
const STATE_DIR = path.join(os.homedir(), '.octopus');
const STATE_PATH = path.join(STATE_DIR, 'usage-codewhale.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 5 * 60 * 60 * 1000;
const DAILY_KEEP_DAYS = 95;
const RECENT_KEEP_MS = WINDOW_MS + 30 * 60 * 1000;
const BACKFILL_MS = DAILY_KEEP_DAYS * DAY_MS;

// Cache pricing ratios (same as Claude DEFAULT_PRICING ratios)
const CACHE_READ_RATIO = 0.1;
const CACHE_WRITE_RATIO = 1.25;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyDay() {
  return { cost: 0, tokens: 0, msgs: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function num(v) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0) ? n : 0;
}

// Load the bundled model catalog. Returns a Map: model_id → { input, output, context_window }
function loadCatalog(catalogPath) {
  const catalog = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(catalogPath || CATALOG_PATH, 'utf8'));
    const entries = data && data.entries ? data.entries : {};
    for (const [id, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue;
      const input = Number(entry.input_usd_per_million);
      const output = Number(entry.output_usd_per_million);
      const cacheRead = Number(entry.cache_read_usd_per_million);
      const cacheWrite = Number(entry.cache_write_usd_per_million);
      const contextWindow = Number(entry.context_window);
      // Only store entries that have at least input pricing
      if (Number.isFinite(input) && input >= 0) {
        catalog.set(id, {
          input,
          output: Number.isFinite(output) ? output : null,
          cacheRead: Number.isFinite(cacheRead) && cacheRead >= 0 ? cacheRead : null,
          cacheWrite: Number.isFinite(cacheWrite) && cacheWrite >= 0 ? cacheWrite : null,
          contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
        });
      }
      // Also store under provider/id format if different
      if (entry.provider_model_id && entry.provider_model_id !== id) {
        catalog.set(entry.provider_model_id, catalog.get(id));
      }
    }
  } catch (err) {
    log('cw-meter', 'catalog load error:', err.message);
  }
  return catalog;
}

// Look up pricing for a model. Returns { input, output, contextWindow? } or null.
function priceFor(catalog, model) {
  if (!model) return null;
  const m = String(model).trim();
  if (!m) return null;
  // Exact match first
  if (catalog.has(m)) return catalog.get(m);
  // Case-insensitive match
  const lower = m.toLowerCase();
  for (const [id, entry] of catalog) {
    if (id.toLowerCase() === lower) return entry;
  }
  // Prefix match (e.g. "deepseek-chat" matches "deepseek-chat" exactly, but
  // also handle model names that may have version suffixes)
  for (const [id, entry] of catalog) {
    if (lower.startsWith(id.toLowerCase()) || id.toLowerCase().startsWith(lower)) return entry;
  }
  return null;
}

// Look up context window for a model (for context_usage.percent calculation).
function contextWindowFor(catalog, model) {
  const p = priceFor(catalog, model);
  return p && p.contextWindow ? p.contextWindow : null;
}

function createMeteringCodeWhale(options = {}) {
  const catalogPath = options.catalogPath || CATALOG_PATH;
  let catalog = loadCatalog(catalogPath);
  let catalogCount = catalog.size;

  // Same aggregate structure as Claude's metering for UI compatibility.
  let state = {
    daily: {},
    byModelByDay: {},
    hourlyByDay: {},
    recent: [],
  };
  let dirty = false;
  let saveTimer = null;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (raw && typeof raw === 'object') {
        state.daily = raw.daily || {};
        state.byModelByDay = raw.byModelByDay || {};
        state.hourlyByDay = raw.hourlyByDay || {};
        state.recent = Array.isArray(raw.recent) ? raw.recent : [];
      }
    } catch {}
    pruneDaily();
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) saveNow(); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function saveNow() {
    dirty = false;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = path.join(STATE_DIR, `.usage-cw.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, STATE_PATH);
    } catch (err) {
      log('cw-meter', 'save failed:', err.message);
    }
  }

  function pruneDaily() {
    const cutoff = dayKey(Date.now() - BACKFILL_MS);
    for (const k of Object.keys(state.daily)) if (k < cutoff) delete state.daily[k];
    for (const k of Object.keys(state.byModelByDay)) if (k < cutoff) delete state.byModelByDay[k];
    for (const k of Object.keys(state.hourlyByDay)) if (k < cutoff) delete state.hourlyByDay[k];
  }

  function pruneRecent() {
    const cutoff = Date.now() - RECENT_KEEP_MS;
    if (state.recent.length && state.recent[0].ts < cutoff) {
      state.recent = state.recent.filter((r) => r.ts >= cutoff);
    }
  }

  // Record usage from a turn_end event body.
  // body.turn_usage: { input, output, cache_read, cache_create, cache_write, reasoning, reasoning_replay }
  // body.model: model name
  // body.context_usage: { used } (from totals.conversation_tokens)
  function recordTurnEnd(body) {
    const u = body.turn_usage;
    if (!u || typeof u !== 'object') return;

    const input = num(u.input);
    const output = num(u.output);
    const cacheRead = num(u.cache_read);
    const cacheCreate = num(u.cache_create);
    const cacheWrite = num(u.cache_write);
    const tokens = input + output + cacheRead + cacheCreate + cacheWrite;
    if (tokens <= 0) return;

    const model = body.model || 'unknown';
    const pricing = priceFor(catalog, model);

    let cost = 0;
    if (pricing) {
      const inputCost = input * pricing.input;
      const outputCost = output * (pricing.output || pricing.input);
      // Use catalog cache prices if available; otherwise estimate with ratios.
      const cacheReadCost = cacheRead * (pricing.cacheRead != null ? pricing.cacheRead : pricing.input * CACHE_READ_RATIO);
      const cacheWriteCost = cacheWrite * (pricing.cacheWrite != null ? pricing.cacheWrite : pricing.input * CACHE_WRITE_RATIO);
      // cache_create (Claude's cache_creation_input_tokens) maps to cache_write
      const cacheCreateCost = cacheCreate * (pricing.cacheWrite != null ? pricing.cacheWrite : pricing.input * CACHE_WRITE_RATIO);
      cost = (inputCost + outputCost + cacheReadCost + cacheWriteCost + cacheCreateCost) / 1e6;
    }
    // If no pricing found, cost stays 0 (honest — not fabricated)

    const tsMs = body.turn_duration_ms ? Date.now() - body.turn_duration_ms : Date.now();
    const k = dayKey(tsMs);

    const d = (state.daily[k] = state.daily[k] || emptyDay());
    d.cost += cost; d.tokens += tokens; d.msgs += 1;
    d.input += input; d.output += output; d.cacheCreate += cacheCreate; d.cacheRead += cacheRead;

    const fam = (state.byModelByDay[k] = state.byModelByDay[k] || {});
    const mk = model;
    const mv = (fam[mk] = fam[mk] || { cost: 0, tokens: 0, msgs: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
    mv.cost += cost; mv.tokens += tokens; mv.msgs += 1;
    mv.input += input; mv.output += output; mv.cacheCreate += cacheCreate; mv.cacheRead += cacheRead;

    const hours = (state.hourlyByDay[k] = state.hourlyByDay[k] || new Array(24).fill(0));
    hours[new Date(tsMs).getHours()] += cost;

    if (Date.now() - tsMs < RECENT_KEEP_MS) state.recent.push({ ts: tsMs, cost, tokens });

    pruneRecent();
    scheduleSave();
  }

  function getStats() {
    const todayK = dayKey(Date.now());
    const today = { ...emptyDay(), ...(state.daily[todayK] || {}) };
    const byModel = state.byModelByDay[todayK] ? { ...state.byModelByDay[todayK] } : {};
    const hourly = (state.hourlyByDay[todayK] || new Array(24).fill(0)).slice();

    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    let wCost = 0, wTok = 0, oldest = 0;
    for (const r of state.recent) {
      if (r.ts < windowStart) continue;
      wCost += r.cost; wTok += r.tokens;
      if (!oldest || r.ts < oldest) oldest = r.ts;
    }
    const window5h = {
      cost: wCost, tokens: wTok,
      startTs: oldest || 0,
      resetTs: oldest ? oldest + WINDOW_MS : 0,
    };

    const daily = {};
    for (const [k, v] of Object.entries(state.daily)) {
      daily[k] = { cost: v.cost, tokens: v.tokens, msgs: v.msgs };
    }

    return { today, window5h, byModel, hourly, daily };
  }

  function totals() {
    let cost = 0, tokens = 0;
    const byModel = {};
    for (const day of Object.values(state.byModelByDay)) {
      for (const [id, v] of Object.entries(day)) {
        byModel[id] = (byModel[id] || 0) + (v.cost || 0);
        cost += v.cost || 0; tokens += v.tokens || 0;
      }
    }
    return { cost, tokens, byModel };
  }

  function reloadCatalog() {
    catalog = loadCatalog(catalogPath);
    catalogCount = catalog.size;
  }

  function start() {
    load();
    catalog = loadCatalog(catalogPath);
    catalogCount = catalog.size;
  }

  function stop() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
  }

  return {
    start, stop, recordTurnEnd, getStats, totals, reloadCatalog,
    priceFor: (model) => priceFor(catalog, model),
    contextWindowFor: (model) => contextWindowFor(catalog, model),
    get catalogSize() { return catalogCount; },
  };
}

module.exports = { createMeteringCodeWhale, loadCatalog, priceFor, contextWindowFor, CATALOG_PATH };