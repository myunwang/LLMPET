'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Provider registry — lazy loading.
// ─────────────────────────────────────────────────────────────────────────────
//
// Selects which agent provider(s) are active. Default is 'claude' so the app
// behaves exactly as before until a user opts into codewhale.
//
// Selection rules (first match wins):
//   1. env OCTOPUS_PROVIDER='claude' | 'codewhale' | 'claude,codewhale' | 'all'
//   2. ~/.octopus/config.json field `providers` (array of ids) — set by the
//      detail panel in a later round.
//   3. default: ['claude']
//
// Providers are loaded lazily: only the claude provider is required at module
// load time. codewhale and aider are required on first access via getProvider()
// or when they appear in the active selection. This saves ~50ms startup for
// default claude-only users (avoids parsing codewhale.js + its dependencies).

const { validateProvider } = require('./base');
const config = require('../backend/config');

// Provider module paths — only resolved when actually needed.
const PROVIDER_MODULES = {
  claude: './claude',
  codewhale: './codewhale',
  aider: './aider',
};

// All known provider IDs (static, no loading required).
const ALL_IDS = Object.freeze(Object.keys(PROVIDER_MODULES));

// Lazy-loaded cache: id → provider descriptor object.
const loaded = new Map();

// Always-load claude at startup (it's the default and must be available
// immediately for the hook server to accept events).
loaded.set('claude', require('./claude'));

/**
 * Load a single provider module on demand. Returns the cached descriptor
 * if already loaded, otherwise require()s and validates it.
 */
function ensureLoaded(id) {
  if (loaded.has(id)) return loaded.get(id);
  const modPath = PROVIDER_MODULES[id];
  if (!modPath) return undefined;
  try {
    const descriptor = require(modPath);
    const missing = validateProvider(descriptor);
    if (missing.length) {
      console.warn(`[providers] "${id}" missing: ${missing.join(', ')}`);
    }
    loaded.set(id, descriptor);
    return descriptor;
  } catch (e) {
    console.error(`[providers] failed to load "${id}": ${e.message}`);
    return undefined;
  }
}

let cache = null;

function readEnvSelection() {
  const raw = (process.env.OCTOPUS_PROVIDER || '').trim();
  if (!raw) return null;
  if (raw === 'all') return ALL_IDS.slice();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function readConfigSelection() {
  try {
    const selected = config.get().providers;
    return Array.isArray(selected) && selected.length ? selected.slice() : null;
  } catch {}
  return null;
}

// Resolve the active provider id list. Order matters: it's the priority order
// for session-id routing when two agents share a session id (rare; codewhale
// session ids are 'sess_…' and claude's are uuids, so collisions are unlikely).
function resolveActive() {
  const picked = readEnvSelection() || readConfigSelection() || ['claude'];
  // de-dup, keep order, drop unknown ids with a warning surfaced via the list.
  const out = [];
  const seen = new Set();
  for (const id of picked) {
    if (seen.has(id)) continue;
    seen.add(id);
    // Validate id is known (exists in PROVIDER_MODULES) — don't trigger full load
    if (PROVIDER_MODULES[id]) out.push(id);
    else console.warn(`[providers] unknown provider id "${id}" — ignored`);
  }
  if (!out.length) {
    console.warn('[providers] no valid providers selected; falling back to claude');
    return ['claude'];
  }
  return out;
}

function load() {
  if (cache) return cache;
  const activeIds = resolveActive();
  const active = [];
  for (const id of activeIds) {
    const p = ensureLoaded(id);
    if (p) active.push(p);
  }
  cache = Object.freeze({
    activeIds: Object.freeze(activeIds.slice()),
    active: Object.freeze(active),
    all: Object.freeze(ALL_IDS.slice()),
  });
  return cache;
}

function getActiveProviders() { return load().active; }
function getActiveIds() { return load().activeIds; }
function getProvider(id) { return ensureLoaded(id) || null; }
function is_active(id) { return load().activeIds.includes(id); }

// Invalidate the cache (used if config.json is edited at runtime in a later
// round). Safe to call any time. Does NOT unload already-loaded providers.
function invalidate() { cache = null; return load(); }

module.exports = {
  getActiveProviders,
  getActiveIds,
  getProvider,
  is_active,
  invalidate,
  ALL_IDS,
};