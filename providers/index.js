'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Provider registry.
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
// The registry is lazy + cached. Each provider is validated on first load; a
// provider missing required fields is dropped with a logged warning (never
// crashes the app).

const path = require('path');
const os = require('os');
const fs = require('fs');
const { validateProvider } = require('./base');

const claudeProvider = require('./claude');
const codewhaleProvider = require('./codewhale');

const REGISTRY = Object.freeze({
  claude: claudeProvider,
  codewhale: codewhaleProvider,
});

const ALL_IDS = Object.freeze(Object.keys(REGISTRY));

let cache = null;

function readEnvSelection() {
  const raw = (process.env.OCTOPUS_PROVIDER || '').trim();
  if (!raw) return null;
  if (raw === 'all') return ALL_IDS.slice();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function readConfigSelection() {
  try {
    const cfgPath = path.join(os.homedir(), '.octopus', 'config.json');
    const obj = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (Array.isArray(obj.providers) && obj.providers.length) {
      return obj.providers.map((s) => String(s).trim()).filter(Boolean);
    }
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
    if (REGISTRY[id]) out.push(id);
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
    const p = REGISTRY[id];
    const missing = validateProvider(p);
    if (missing.length) {
      // codewhale is intentionally partial during adaptation — still register
      // it (its parseHookStdin works), but surface the gaps.
      console.warn(`[providers] "${id}" missing: ${missing.join(', ')}`);
    }
    active.push(p);
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
function getProvider(id) { return REGISTRY[id] || null; }
function is_active(id) { return load().activeIds.includes(id); }

// Invalidate the cache (used if config.json is edited at runtime in a later
// round). Safe to call any time.
function invalidate() { cache = null; return load(); }

module.exports = {
  getActiveProviders,
  getActiveIds,
  getProvider,
  is_active,
  invalidate,
  ALL_IDS,
};
