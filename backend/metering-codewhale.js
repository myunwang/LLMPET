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
const { dict, finiteNonNegative, safeMapKey, cleanDailyMap, cleanByModelMap, cleanHourlyMap, cleanRecent, readJsonBounded } = require('./metering-state');
const modelsDevSync = require('./models-dev-sync');

const CATALOG_PATH = path.join(__dirname, 'model-catalog.bundled.json');
const STATE_DIR = path.join(os.homedir(), '.octopus');
const STATE_PATH = path.join(STATE_DIR, 'usage-codewhale.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 5 * 60 * 60 * 1000;
const DAILY_KEEP_DAYS = 95;
const RECENT_KEEP_MS = WINDOW_MS + 30 * 60 * 1000;
const BACKFILL_MS = DAILY_KEEP_DAYS * DAY_MS;
const MAX_RECENT_RECORDS = 50000;

// Cache pricing ratios — used as fallback only when the catalog entry does NOT
// publish a vendor-specific cache_read_usd_per_million / cache_write_usd_per_million.
// These ratios match Claude's DEFAULT_PRICING and the OpenAI / DeepSeek conventions.
// For vendors that publish different cache rates (e.g. Z.AI GLM at 18.6% read, Xiaomi
// MiMo at 2% read), the catalog now carries the exact vendor value and these
// ratios are NOT used.
const CACHE_READ_RATIO = 0.1;
const CACHE_WRITE_RATIO = 1.25;

function dayKey(ts) {
  let d = new Date(ts);
  if (!Number.isFinite(d.getTime())) d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyDay() {
  return { cost: 0, tokens: 0, msgs: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, unknownPrice: 0 };
}

function num(v) {
  const n = Number(v);
  return finiteNonNegative(n, 1e12);
}

// Catalog v2 (2026-07-20) ships vendor-published prices for every common
// CodeWhale model. We no longer fabricate a default estimate for unknown
// models — instead we return null so the caller records tokens but cost=0
// (matching CODEWHALE.md §Token 计量与花费: "未知模型 → 记录 token 数但花费标为 0").
//
// Legacy FALLBACK_PRICING table removed: the catalog now carries the same
// values directly. Keeping a parallel fallback table was a footgun — if the
// catalog lost an entry, the fallback would silently mask the data loss.
//
// Legacy DEFAULT_FALLBACK ($1/$5) removed: returning a fabricated price for
// truly unknown models misled users into thinking they had spent money when
// they hadn't (or, worse, vastly understated cost for new premium models).
// The honest answer for an unknown model is "we don't know the price".

// Load the bundled model catalog, merged with the live Models.dev cache if available.
// Lookup priority (highest first):
//   1. Live cache (~/.octopus/catalog/models-dev.json) — refreshed in background
//   2. Bundled seed (backend/model-catalog.bundled.json) — shipped with the app
//
// Entries store: { input, output, cacheRead, cacheWrite, contextWindow }
// cacheRead / cacheWrite may be null (vendor doesn't publish → caller uses
// heuristic). input / output may be null ONLY when the catalog entry exists
// but lacks price fields (e.g. context-only metadata entries); the caller
// treats null input as "unknown price → cost=0, token-only".
//
// Entries with no resolvable price AND no context_window are skipped
// entirely (keeps the Map small and lets priceFor() correctly return null for
// models that aren't in the catalog at all).
function loadCatalog(catalogPath) {
  const bundled = loadBundledCatalog(catalogPath);
  // Merge: live cache takes precedence (overrides bundled entries with the same id).
  // Unknown models in the live cache are additive (they fill gaps in the bundled seed).
  const liveCache = modelsDevSync.readCacheSync();
  if (!liveCache || !liveCache.entries) return bundled;
  const merged = new Map(bundled);
  let liveCount = 0;
  for (const [id, entry] of Object.entries(liveCache.entries)) {
    const stored = normalizeEntry(entry);
    if (stored) {
      merged.set(id, stored);
      liveCount++;
      // Also store under provider_model_id alias if different
      if (entry.provider_model_id && entry.provider_model_id !== id) {
        merged.set(entry.provider_model_id, stored);
      }
    }
  }
  if (liveCount > 0) {
    log('cw-meter', `catalog merged: ${bundled.size} bundled + ${liveCount} live (models.dev)`);
  }
  return merged;
}

// Internal: load ONLY the bundled seed catalog. Used by loadCatalog() above
// and by tests that want to isolate bundled behavior.
function loadBundledCatalog(catalogPath) {
  const catalog = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(catalogPath || CATALOG_PATH, 'utf8'));
    const entries = data && data.entries ? data.entries : {};
    for (const [id, entry] of Object.entries(entries)) {
      const stored = normalizeEntry(entry);
      if (stored) {
        catalog.set(id, stored);
        // Also store under provider_model_id alias if different
        if (entry.provider_model_id && entry.provider_model_id !== id) {
          catalog.set(entry.provider_model_id, stored);
        }
      }
    }
  } catch (err) {
    log('cw-meter', 'catalog load error:', err.message);
  }
  return catalog;
}

// Internal: normalize a raw catalog entry into our internal {input, output,
// cacheRead, cacheWrite, contextWindow} shape. Returns null for entries that
// carry no useful info (no price AND no context).
// Shared between loadBundledCatalog and the live cache merge in loadCatalog.
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const input = entry.input_usd_per_million;
  const output = entry.output_usd_per_million;
  const cacheRead = entry.cache_read_usd_per_million;
  const cacheWrite = entry.cache_write_usd_per_million;
  const contextWindow = entry.context_window;
  // `null` in the JSON means "vendor doesn't publish this rate" — must be
  // preserved as null (NOT coerced to 0 via Number(null)). Use strict typeof
  // checks to keep null distinct from explicit 0 (which means "free").
  const hasInput = typeof input === 'number' && Number.isFinite(input) && input >= 0;
  const hasOutput = typeof output === 'number' && Number.isFinite(output) && output >= 0;
  const hasCacheRead = typeof cacheRead === 'number' && Number.isFinite(cacheRead) && cacheRead >= 0;
  const hasCacheWrite = typeof cacheWrite === 'number' && Number.isFinite(cacheWrite) && cacheWrite >= 0;
  const hasContext = typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0;
  // Skip entries that carry no useful info (no price AND no context window).
  if (!hasInput && !hasOutput && !hasContext) return null;
  return {
    input: hasInput ? input : null,
    output: hasOutput ? output : null,
    cacheRead: hasCacheRead ? cacheRead : null,
    cacheWrite: hasCacheWrite ? cacheWrite : null,
    contextWindow: hasContext ? contextWindow : null,
  };
}

// Look up pricing for a model. Returns { input, output, cacheRead, cacheWrite, contextWindow }
// or null. input/output may be null when vendor doesn't publish a price.
// cacheRead/cacheWrite may be null when vendor doesn't publish a cache rate
// (caller should fall back to the 10%/1.25× heuristic).
function priceFor(catalog, model) {
  if (!model) return null;
  const m = String(model).trim();
  if (!m) return null;
  // Exact match first
  if (catalog.has(m) && catalog.get(m)) return catalog.get(m);
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
  // Unknown model — return null. Caller records tokens but cost=0.
  // (Previously returned DEFAULT_FALLBACK = $1/$5 — see comment above loadCatalog.)
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
    daily: dict(),
    byModelByDay: dict(),
    hourlyByDay: dict(),
    recent: [],
  };
  let dirty = false;
  let saveTimer = null;

  function load() {
    try {
      const raw = readJsonBounded(STATE_PATH);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        state.daily = cleanDailyMap(raw.daily);
        state.byModelByDay = cleanByModelMap(raw.byModelByDay);
        state.hourlyByDay = cleanHourlyMap(raw.hourlyByDay);
        state.recent = cleanRecent(raw.recent);
      }
    } catch (err) {
      if (err && err.code === 'ESTATEBIG') log('cw-meter', 'ignored oversized state file:', err.message);
    }
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
      fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
      const tmp = path.join(STATE_DIR, `.usage-cw.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, STATE_PATH);
      try { fs.chmodSync(STATE_PATH, 0o600); } catch {}
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
    if (state.recent.length > MAX_RECENT_RECORDS) {
      state.recent.splice(0, state.recent.length - MAX_RECENT_RECORDS);
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
    // W23: DeepSeek API has prompt_cache_hit_tokens (cache read) and
    // prompt_cache_miss_tokens (NOT in cache, charged at full input price).
    // There is NO separate cache_write field — CodeWhale's prompt_cache_write_tokens
    // likely overlaps with cache_miss. To avoid double-counting, we take the
    // MAX of cache_create and cache_write (they represent the same tokens under
    // different names across CW versions), not the SUM.
    const cacheWriteEffective = Math.max(cacheCreate, cacheWrite);
    const tokens = input + output + cacheRead + cacheWriteEffective;
    if (tokens <= 0) return;

    const model = safeMapKey(body.model, 'unknown', 256);
    const pricing = priceFor(catalog, model);

    let cost = 0;
    let unknownPrice = 0;
    if (pricing && pricing.input != null) {
      const inputCost = input * pricing.input;
      const outputCost = output * (pricing.output != null ? pricing.output : pricing.input);
      // Use vendor-published cache rates when available; fall back to heuristic.
      const cacheReadRate = pricing.cacheRead != null ? pricing.cacheRead : pricing.input * CACHE_READ_RATIO;
      const cacheWriteRate = pricing.cacheWrite != null ? pricing.cacheWrite : pricing.input * CACHE_WRITE_RATIO;
      const cacheReadCost = cacheRead * cacheReadRate;
      // cache_write_effective covers both cache_create and cache_write (deduped)
      const cacheWriteCost = cacheWriteEffective * cacheWriteRate;
      cost = (inputCost + outputCost + cacheReadCost + cacheWriteCost) / 1e6;
    } else {
      // Unknown model (no public price). Record tokens honestly, cost stays 0.
      // Flag so UI can show "unknown price" badge rather than implying $0.
      unknownPrice = 1;
    }

    const duration = finiteNonNegative(body.turn_duration_ms, 30 * DAY_MS);
    const tsMs = Date.now() - duration;
    const k = dayKey(tsMs);

    const d = (state.daily[k] = state.daily[k] || emptyDay());
    d.cost += cost; d.tokens += tokens; d.msgs += 1;
    d.input += input; d.output += output; d.cacheCreate += cacheWriteEffective; d.cacheRead += cacheRead;
    if (unknownPrice) d.unknownPrice = (d.unknownPrice || 0) + 1;

    const fam = (state.byModelByDay[k] = state.byModelByDay[k] || dict());
    const mk = model;
    const mv = (fam[mk] = fam[mk] || { cost: 0, tokens: 0, msgs: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, unknownPrice: 0 });
    mv.cost += cost; mv.tokens += tokens; mv.msgs += 1;
    mv.input += input; mv.output += output; mv.cacheCreate += cacheWriteEffective; mv.cacheRead += cacheRead;
    if (unknownPrice) mv.unknownPrice = (mv.unknownPrice || 0) + 1;

    const hours = (state.hourlyByDay[k] = state.hourlyByDay[k] || new Array(24).fill(0));
    hours[new Date(tsMs).getHours()] += cost;

    if (Date.now() - tsMs < RECENT_KEEP_MS) {
      state.recent.push({ ts: tsMs, cost, tokens });
      if (state.recent.length > MAX_RECENT_RECORDS) {
        state.recent.splice(0, state.recent.length - MAX_RECENT_RECORDS);
      }
    }

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

  // Trigger a background refresh of the Models.dev live cache. When the refresh
  // completes, reloadCatalog() is called to pick up any new/updated entries.
  // Safe to call repeatedly — concurrent refreshes are deduped internally.
  // No-op if OCTOPUS_NO_NET or OCTOPUS_DISABLE_MODELS_DEV_FETCH is set.
  let periodicRefreshTimer = null;

  function startModelsDevSync() {
    const { cache, shouldRefresh } = modelsDevSync.loadAndMaybeRefresh();
    if (cache) {
      // Live cache exists (possibly stale) — reload now to pick it up.
      reloadCatalog();
    }
    if (shouldRefresh) {
      modelsDevSync.refreshInBackground(() => {
        // Refresh succeeded — reload to use the fresh entries.
        reloadCatalog();
      });
    }
    // W28: schedule periodic refresh every 24h so the catalog stays current
    // across long-running sessions without requiring a restart.
    if (!periodicRefreshTimer && !modelsDevSync._isFetchDisabled()) {
      const PERIODIC_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h
      periodicRefreshTimer = setInterval(() => {
        const { shouldRefresh: needRefresh } = modelsDevSync.loadAndMaybeRefresh();
        if (needRefresh) {
          modelsDevSync.refreshInBackground(() => {
            reloadCatalog();
            log('cw-meter', 'periodic models.dev refresh completed; catalog reloaded');
          });
        }
      }, PERIODIC_REFRESH_MS);
      if (periodicRefreshTimer.unref) periodicRefreshTimer.unref();
    }
  }

  function start() {
    load();
    catalog = loadCatalog(catalogPath);
    catalogCount = catalog.size;
    // Kick off background Models.dev sync (no-op if disabled).
    startModelsDevSync();
  }

  function stop() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (periodicRefreshTimer) { clearInterval(periodicRefreshTimer); periodicRefreshTimer = null; }
    saveNow();
  }

  return {
    start, stop, recordTurnEnd, getStats, totals, reloadCatalog,
    startModelsDevSync,
    priceFor: (model) => priceFor(catalog, model),
    contextWindowFor: (model) => contextWindowFor(catalog, model),
    get catalogSize() { return catalogCount; },
    get modelsDevSyncState() { return modelsDevSync.getRefreshState(); },
  };
}

module.exports = { createMeteringCodeWhale, loadCatalog, loadBundledCatalog, priceFor, contextWindowFor, CATALOG_PATH };