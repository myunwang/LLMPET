'use strict';

// Live Models.dev catalog fetch + secret-free disk cache.
//
// Design (mirrors CodeWhale's crates/tui/src/models_dev_live.rs):
//   1. On startup, read the bundled seed catalog synchronously → immediately usable.
//   2. Read ~/.octopus/catalog/models-dev.json if it exists. If fresh (< TTL),
//      use it. If stale, return it anyway (better than nothing) and trigger a
//      background refresh.
//   3. Background refresh: fetch https://models.dev/catalog.json with a 15s
//      timeout, 64 MiB response cap, explicit User-Agent, no credentials.
//      Transform to our internal schema, validate, atomic-write to disk.
//   4. On success, notify the metering module to reload its catalog.
//   5. On any failure, log + keep using the previous cache or bundled seed.
//
// Layered lookup at priceFor() time:
//   user_override (~/.octopus/pricing-codewhale.json, future)
//     → live cache (~/.octopus/catalog/models-dev.json, 24h TTL)
//     → bundled seed (backend/model-catalog.bundled.json)
//     → null (token-only, unknownPrice flag set)
//
// Models.dev is MIT-licensed (https://github.com/anomalyco/models.dev, Copyright
// (c) 2025 models.dev). Free to use, modify, distribute. Same license as LLMPET.
//
// Env knobs (mirror CodeWhale's CODEWHALE_MODELS_DEV_* family):
//   OCTOPUS_MODELS_DEV_URL           Override catalog URL
//   OCTOPUS_MODELS_DEV_PATH          Load catalog from local file (skips network)
//   OCTOPUS_DISABLE_MODELS_DEV_FETCH Disable network fetch entirely
//   OCTOPUS_NO_NET                   Already exists; also disables this fetch

const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');
const { log } = require('./log');

const DEFAULT_URL = 'https://models.dev/catalog.json';
const DEFAULT_TTL_SECS = 24 * 60 * 60; // 24h, same as CodeWhale
const FETCH_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024; // 64 MiB cap, same as CodeWhale
const MAX_CACHE_BYTES = 16 * 1024 * 1024; // 16 MiB cap on cached file
const USER_AGENT = 'Octopus/0.1.1 (+https://github.com/myunwang/LLMPET)';
const CACHE_SCHEMA_VERSION = 2;

const CACHE_DIR = path.join(os.homedir(), '.octopus', 'catalog');
const CACHE_FILE = path.join(CACHE_DIR, 'models-dev.json');

// Sanity bounds for validating parsed entries. Reject anything that looks
// like a data corruption or a malicious payload.
const MAX_MODEL_ID_LEN = 256;
const MAX_PRICE = 1000; // USD per million tokens; no real model exceeds this
const MAX_CONTEXT = 100_000_000; // 100M tokens; no real model exceeds this

function envFlag(name) {
  const v = process.env[name];
  if (!v) return false;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function getCatalogUrl() {
  return process.env.OCTOPUS_MODELS_DEV_URL || DEFAULT_URL;
}

function getCachePath() {
  return CACHE_FILE;
}

function isFetchDisabled() {
  return envFlag('OCTOPUS_DISABLE_MODELS_DEV_FETCH') || envFlag('OCTOPUS_NO_NET');
}

// Parse ISO 8601 timestamp; returns NaN on malformed input.
function parseTs(s) {
  if (typeof s !== 'string') return NaN;
  const t = Date.parse(s);
  return t;
}

function isCacheFresh(cache, now = Date.now()) {
  if (!cache || typeof cache !== 'object') return false;
  const fetchedAt = parseTs(cache.fetched_at);
  if (!Number.isFinite(fetchedAt)) return false;
  const ttl = Number(cache.ttl_secs);
  const ttlMs = (Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECS) * 1000;
  return (now - fetchedAt) < ttlMs;
}

// Validate a single catalog entry's price fields.
// Returns the cleaned entry object, or null if invalid.
function cleanEntry(id, raw) {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_MODEL_ID_LEN) return null;
  if (!raw || typeof raw !== 'object') return null;

  const clean = { id };

  // input_usd_per_million: number >= 0, <= MAX_PRICE, or null
  if (raw.input_usd_per_million == null) {
    clean.input_usd_per_million = null;
  } else if (typeof raw.input_usd_per_million === 'number' &&
             Number.isFinite(raw.input_usd_per_million) &&
             raw.input_usd_per_million >= 0 && raw.input_usd_per_million <= MAX_PRICE) {
    clean.input_usd_per_million = raw.input_usd_per_million;
  } else {
    return null;
  }

  // output_usd_per_million: same rules
  if (raw.output_usd_per_million == null) {
    clean.output_usd_per_million = null;
  } else if (typeof raw.output_usd_per_million === 'number' &&
             Number.isFinite(raw.output_usd_per_million) &&
             raw.output_usd_per_million >= 0 && raw.output_usd_per_million <= MAX_PRICE) {
    clean.output_usd_per_million = raw.output_usd_per_million;
  } else {
    return null;
  }

  // cache_read / cache_write: same rules (null allowed; 0 allowed = "free")
  for (const f of ['cache_read_usd_per_million', 'cache_write_usd_per_million']) {
    if (raw[f] == null) {
      clean[f] = null;
    } else if (typeof raw[f] === 'number' && Number.isFinite(raw[f]) && raw[f] >= 0 && raw[f] <= MAX_PRICE) {
      clean[f] = raw[f];
    } else {
      return null;
    }
  }

  // context_window: positive integer, <= MAX_CONTEXT
  if (raw.context_window == null) {
    clean.context_window = null;
  } else if (typeof raw.context_window === 'number' && Number.isFinite(raw.context_window) &&
             Number.isInteger(raw.context_window) && raw.context_window > 0 && raw.context_window <= MAX_CONTEXT) {
    clean.context_window = raw.context_window;
  } else {
    return null;
  }

  // max_output: positive integer or null
  if (raw.max_output == null) {
    clean.max_output = null;
  } else if (typeof raw.max_output === 'number' && Number.isFinite(raw.max_output) &&
             Number.isInteger(raw.max_output) && raw.max_output > 0 && raw.max_output <= MAX_CONTEXT) {
    clean.max_output = raw.max_output;
  } else {
    clean.max_output = null; // be lenient on max_output
  }

  // supports_reasoning: bool or null
  if (typeof raw.supports_reasoning === 'boolean') {
    clean.supports_reasoning = raw.supports_reasoning;
  } else {
    clean.supports_reasoning = null;
  }

  // provenance: must be a string
  clean.provenance = typeof raw.provenance === 'string' ? raw.provenance : 'models.dev';

  return clean;
}

// Validate the full cache object. Returns a clean cache or null.
function validateCache(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.schema_version !== CACHE_SCHEMA_VERSION) return null;
  if (!obj.entries || typeof obj.entries !== 'object') return null;
  const fetchedAt = parseTs(obj.fetched_at);
  if (!Number.isFinite(fetchedAt)) return null;

  const cleanEntries = {};
  let count = 0;
  for (const [id, raw] of Object.entries(obj.entries)) {
    const clean = cleanEntry(id, raw);
    if (clean) {
      cleanEntries[id] = clean;
      count++;
    }
  }
  if (count === 0) return null;

  return {
    schema_version: CACHE_SCHEMA_VERSION,
    source: typeof obj.source === 'string' ? obj.source : 'models.dev',
    fetched_at: obj.fetched_at,
    ttl_secs: Number.isFinite(Number(obj.ttl_secs)) && Number(obj.ttl_secs) > 0 ? Number(obj.ttl_secs) : DEFAULT_TTL_SECS,
    upstream_url: typeof obj.upstream_url === 'string' ? obj.upstream_url : getCatalogUrl(),
    upstream_etag: typeof obj.upstream_etag === 'string' ? obj.upstream_etag : null,
    entries: cleanEntries,
  };
}

// Official/canonical provider keys in models.dev. These get priority when
// multiple providers serve the same model id with different prices (e.g.
// `deepseek-v4-pro` is served by `deepseek` at $0.435/$0.87 but also by
// aggregators like `frogbot` at $1.74/$3.48 with a 4× markup).
// Keys are lowercase; matched case-insensitively against provider ids.
const OFFICIAL_PROVIDERS = new Set([
  'deepseek', 'openai', 'anthropic', 'zai', 'z-ai', 'moonshot', 'moonshotai',
  'xiaomi', 'xiaomi-mimo', 'minimax', 'minimax-anthropic', 'stepfun', 'sakana',
  'longcat', 'long-cat', 'meta', 'xai', 'arcee', 'alibaba', 'alibaba-cn',
  'together', 'fireworks', 'novita', 'deepinfra', 'siliconflow',
  'siliconflow-cn', 'huggingface', 'nvidia-nim', 'openrouter', 'volcengine',
  'wanjie-ark', 'atlascloud', 'sglang', 'vllm', 'ollama', 'qianfan',
  'openmodel', 'openai-codex', 'deepseek-anthropic',
]);

function isOfficialProvider(providerId) {
  if (!providerId || typeof providerId !== 'string') return false;
  return OFFICIAL_PROVIDERS.has(providerId.toLowerCase());
}

// Transform models.dev catalog.json → our internal schema.
// models.dev shape:
//   { models: {...}, providers: { "deepseek": { models: { "deepseek-v4-pro": { cost: { input, output, cache_read, cache_write }, limit: { context, output } } } } } }
// We flatten providers[].models[] into entries{}, keying by model id.
// Also add provider-prefixed keys (e.g. "deepseek/deepseek-v4-pro") as aliases.
//
// Provider priority (a single model id may be served by multiple providers):
//   1. Official provider (deepseek, openai, anthropic, ...) with non-zero price
//   2. Official provider with any cost field
//   3. Official provider (context-only)
//   4. Any provider with non-zero price (aggregator's real price)
//   5. Any provider with any cost field
//   6. First candidate (context-only metadata)
//
// This prevents aggregators like `frogbot` (4× markup on deepseek-v4-pro)
// from shadowing the official DeepSeek price ($0.435/$0.87).
function transformModelsDev(upstream) {
  if (!upstream || typeof upstream !== 'object') return null;
  const providers = upstream.providers;
  if (!providers || typeof providers !== 'object') return null;

  // For each model id, collect all (provider, entry) candidates.
  const candidates = new Map(); // modelId → array of { providerId, entry, hasPrice, isOfficial }
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object' || !provider.models) continue;
    const isOfficial = isOfficialProvider(providerId);
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model || typeof model !== 'object') continue;
      const cost = model.cost;
      const limit = model.limit || {};
      const input = (cost && typeof cost.input === 'number') ? cost.input : null;
      const output = (cost && typeof cost.output === 'number') ? cost.output : null;
      const cacheRead = (cost && typeof cost.cache_read === 'number') ? cost.cache_read : null;
      const cacheWrite = (cost && typeof cost.cache_write === 'number') ? cost.cache_write : null;
      const contextWindow = (limit && typeof limit.context === 'number') ? limit.context : null;
      const maxOutput = (limit && typeof limit.output === 'number') ? limit.output : null;
      const supportsReasoning = typeof model.reasoning === 'boolean' ? model.reasoning : null;
      const entry = {
        id: modelId,
        input_usd_per_million: input,
        output_usd_per_million: output,
        cache_read_usd_per_million: cacheRead,
        cache_write_usd_per_million: cacheWrite,
        context_window: contextWindow,
        max_output: maxOutput,
        supports_reasoning: supportsReasoning,
        provenance: 'models.dev',
      };
      // Skip entries that carry no useful info (no price AND no context).
      if (input == null && output == null && contextWindow == null) continue;
      const hasNonZeroPrice = (input != null && input > 0) || (output != null && output > 0);
      if (!candidates.has(modelId)) candidates.set(modelId, []);
      candidates.get(modelId).push({ providerId, entry, hasNonZeroPrice, isOfficial });
    }
  }

  if (candidates.size === 0) return null;

  // For each model, pick the best candidate by priority.
  const entries = {};
  for (const [modelId, cands] of candidates) {
    let chosen =
      cands.find((c) => c.isOfficial && c.hasNonZeroPrice) ||
      cands.find((c) => c.isOfficial && (c.entry.input_usd_per_million != null || c.entry.output_usd_per_million != null)) ||
      cands.find((c) => c.isOfficial) ||
      cands.find((c) => c.hasNonZeroPrice) ||
      cands.find((c) => c.entry.input_usd_per_million != null || c.entry.output_usd_per_million != null) ||
      cands[0];
    entries[modelId] = chosen.entry;
    // Also store under provider-prefixed alias (e.g. "deepseek/deepseek-v4-pro").
    const prefixed = `${chosen.providerId}/${modelId}`;
    if (prefixed !== modelId && !entries[prefixed]) {
      entries[prefixed] = { ...chosen.entry, id: prefixed };
    }
  }

  return {
    schema_version: CACHE_SCHEMA_VERSION,
    source: 'models.dev',
    fetched_at: new Date().toISOString(),
    ttl_secs: DEFAULT_TTL_SECS,
    upstream_url: getCatalogUrl(),
    upstream_etag: null, // set by fetchModelsDev when ETag is available
    entries,
  };
}

// Synchronously read the cached catalog. Returns null if missing/invalid.
function readCacheSync() {
  // OCTOPUS_MODELS_DEV_PATH overrides the cache location (offline / testing).
  const overridePath = process.env.OCTOPUS_MODELS_DEV_PATH;
  const cachePath = overridePath || CACHE_FILE;
  try {
    const st = fs.statSync(cachePath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_CACHE_BYTES) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return validateCache(parsed);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      log('cw-sync', `cache read failed: ${err.message}`);
    }
    return null;
  }
}

// Atomic write: tmp file (mode 0600) → rename → chmod 0600.
function writeCacheAtomic(cache) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(CACHE_DIR, 0o700); } catch {}
    const tmp = path.join(CACHE_DIR, `.models-dev.${process.pid}.${Date.now()}.tmp`);
    const json = JSON.stringify(cache);
    if (Buffer.byteLength(json) > MAX_CACHE_BYTES) {
      log('cw-sync', `cache write skipped: serialized size ${Buffer.byteLength(json)} exceeds ${MAX_CACHE_BYTES}`);
      return false;
    }
    fs.writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CACHE_FILE);
    try { fs.chmodSync(CACHE_FILE, 0o600); } catch {}
    return true;
  } catch (err) {
    log('cw-sync', `cache write failed: ${err.message}`);
    return false;
  }
}

// HTTPS GET with timeout, size cap, content-type check. Returns a Promise
// resolving to { body: Buffer, etag: string|null }.
function httpGet(url) {
  return new Promise((resolve, reject) => {
    let req;
    const timer = setTimeout(() => {
      try { req && req.destroy(new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`)); } catch {}
    }, FETCH_TIMEOUT_MS);

    try {
      req = https.get(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
          // No Authorization, no Cookie — public endpoint only.
        },
        // Don't follow redirects to non-models.dev hosts (DNS rebinding defense).
        // https.get follows redirects by default in modern Node; we cap redirects
        // implicitly by checking the response URL against the expected host.
      }, (res) => {
        const status = res.statusCode || 0;
        if (status !== 200) {
          clearTimeout(timer);
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const ctype = String(res.headers['content-type'] || '').toLowerCase();
        if (!ctype.includes('json')) {
          clearTimeout(timer);
          res.resume();
          reject(new Error(`unexpected content-type: ${ctype}`));
          return;
        }
        const chunks = [];
        let total = 0;
        let aborted = false;
        res.on('data', (chunk) => {
          if (aborted) return;
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            aborted = true;
            clearTimeout(timer);
            try { req.destroy(new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)); } catch {}
            reject(new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          clearTimeout(timer);
          const body = Buffer.concat(chunks);
          const etag = res.headers['etag'] || null;
          resolve({ body, etag });
        });
        res.on('error', (err) => {
          if (aborted) return;
          clearTimeout(timer);
          reject(err);
        });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

// Fetch + transform + validate. Returns the cache object or null.
async function fetchModelsDev(url) {
  const { body, etag } = await httpGet(url);
  let parsed;
  try {
    const text = body.toString('utf8');
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new Error(`JSON parse failed: ${err.message}`);
  }
  const cache = transformModelsDev(parsed);
  if (!cache) throw new Error('transform produced empty catalog');
  if (etag) cache.upstream_etag = etag;
  return cache;
}

// Refresh state — exposed for tests.
let refreshing = false;
let lastRefreshAt = 0;
let lastRefreshOk = false;
let lastRefreshError = null;

function getRefreshState() {
  return {
    refreshing,
    lastRefreshAt,
    lastRefreshOk,
    lastRefreshError,
  };
}

// Trigger a background refresh (no await). Safe to call repeatedly —
// concurrent refreshes are deduped via the `refreshing` flag.
function refreshInBackground(onRefreshed) {
  if (refreshing) return false;
  if (isFetchDisabled()) return false;
  // Throttle: don't refresh more than once per minute.
  if (Date.now() - lastRefreshAt < 60 * 1000 && lastRefreshOk) return false;

  refreshing = true;
  lastRefreshAt = Date.now();

  setImmediate(async () => {
    try {
      const url = getCatalogUrl();
      log('cw-sync', `fetching ${url}`);
      const cache = await fetchModelsDev(url);
      const ok = writeCacheAtomic(cache);
      lastRefreshOk = ok;
      lastRefreshError = ok ? null : 'write failed';
      if (ok) {
        const count = Object.keys(cache.entries).length;
        log('cw-sync', `refreshed: ${count} entries (etag=${cache.upstream_etag || 'none'})`);
        if (typeof onRefreshed === 'function') {
          try { onRefreshed(cache); } catch (cbErr) {
            log('cw-sync', `onRefreshed callback failed: ${cbErr.message}`);
          }
        }
      }
    } catch (err) {
      lastRefreshOk = false;
      lastRefreshError = err.message;
      log('cw-sync', `refresh failed: ${err.message}`);
      // Failure is non-fatal — caller continues with bundled seed or stale cache.
    } finally {
      refreshing = false;
    }
  });

  return true;
}

// Synchronous: read cache (any age) and decide if a refresh should be triggered.
// Returns { cache, shouldRefresh }.
function loadAndMaybeRefresh() {
  const cache = readCacheSync();
  const fresh = cache && isCacheFresh(cache);
  // Trigger refresh if cache is missing OR stale (but not if fetch is disabled).
  const shouldRefresh = !isFetchDisabled() && !fresh;
  return { cache, shouldRefresh };
}

module.exports = {
  // Public API
  loadAndMaybeRefresh,
  refreshInBackground,
  readCacheSync,
  isCacheFresh,
  getRefreshState,
  // Constants exposed for tests
  DEFAULT_URL,
  DEFAULT_TTL_SECS,
  CACHE_SCHEMA_VERSION,
  CACHE_FILE,
  CACHE_DIR,
  MAX_RESPONSE_BYTES,
  MAX_CACHE_BYTES,
  USER_AGENT,
  // Pure functions exposed for tests
  _transformModelsDev: transformModelsDev,
  _validateCache: validateCache,
  _cleanEntry: cleanEntry,
  _fetchModelsDev: fetchModelsDev,
  _envFlag: envFlag,
  _isFetchDisabled: isFetchDisabled,
  _getCatalogUrl: getCatalogUrl,
};
