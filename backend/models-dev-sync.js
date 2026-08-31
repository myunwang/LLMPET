'use strict';

// models.dev catalog sync — an independent price cache for CodeWhale models.
//
// Verified upstream shape (fetched and inspected directly, 2026-08):
//   GET https://models.dev/catalog.json  → {"models": {...}, "providers": {...}}
//   providers.<id>.models.<modelId>.cost = { input, output, cache_read,
//     cache_write, ... } in USD per million tokens
//   providers.<id>.models.<modelId>.limit = { context, output, ... }
//   providers.<id>.models.<modelId>.reasoning = bool
//   The top-level "models" object is provider-independent metadata (362 rows)
//   and carries no prices — only "providers" is interesting here.
//   There is NO per-provider endpoint; unknown paths return 200 + the SPA HTML,
//   so JSON.parse failing on a 200 is a real possibility we defend against.
//
// Security boundaries (the reason this module exists as its own cache):
//   • The catalog legitimately contains object keys like "__proto__",
//     "constructor" and "prototype" as provider/model ids. The cache is built
//     with a null-prototype dictionary and those keys are rejected outright,
//     so a hostile upstream can never pollute Object.prototype.
//   • Every number is bounds-checked (NaN/Infinity/negative/absurd rejected →
//     null), every string length-capped. The cache file is written atomically
//     with 0600 permissions.
//   • Body size is capped at 64 MiB (real catalog ≈ 4.7 MB); timeouts are 15s.
//   • Network failure NEVER blocks startup: the previous cache (or no cache)
//     stays in effect and pricing falls back to honest $0-unknown.

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');

const URL = 'https://models.dev/catalog.json';
// Same home override as the CodeWhale usage ledger: tests and sandboxed setups
// redirect ALL CodeWhale state with LLMPET_CODEWHALE_HOME, and the price cache
// must follow (default path is unchanged for normal installs).
const STATE_HOME = process.env.LLMPET_CODEWHALE_HOME
  ? process.env.LLMPET_CODEWHALE_HOME
  : path.join(os.homedir(), '.octopus');
const CACHE_PATH = path.join(STATE_HOME, 'catalog', 'models-dev.json');
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BODY = 64 * 1024 * 1024;
const MAX_PRICE = 1000;            // USD / million tokens — anything above is bogus
const MAX_LIMIT = 100000000;       // tokens
const MAX_KEY_LEN = 256;
const TTL_MS = 24 * 60 * 60 * 1000; // matches upstream CodeWhale's own cache TTL

function safeKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LEN && !UNSAFE_KEYS.has(key);
}

function finite(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

// Transform the upstream catalog into a flat, provider-qualified price table.
// Entries are stored twice: "provider/model" (unambiguous) and bare "model"
// (first provider in source order wins, deterministically) so lookups work
// with or without the provider qualifier.
function transformModelsDev(upstream) {
  if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) return null;
  const providers = upstream.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return null;
  const entries = Object.create(null);
  for (const providerId of Object.keys(providers)) {
    if (!safeKey(providerId)) continue;
    const provider = providers[providerId];
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
    const models = provider.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const modelId of Object.keys(models)) {
      if (!safeKey(modelId)) continue;
      const model = models[modelId];
      if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
      const cost = model.cost && typeof model.cost === 'object' && !Array.isArray(model.cost) ? model.cost : {};
      const limit = model.limit && typeof model.limit === 'object' && !Array.isArray(model.limit) ? model.limit : {};
      const row = Object.assign(Object.create(null), {
        id: modelId,
        input_usd_per_million: finite(cost.input, MAX_PRICE),
        output_usd_per_million: finite(cost.output, MAX_PRICE),
        cache_read_usd_per_million: finite(cost.cache_read, MAX_PRICE),
        cache_write_usd_per_million: finite(cost.cache_write, MAX_PRICE),
        context_window: finite(limit.context, MAX_LIMIT),
        max_output: finite(limit.output, MAX_LIMIT),
        supports_reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : null,
        provenance: `models.dev:${providerId}`,
      });
      entries[`${providerId}/${modelId}`] = row;
      if (!Object.prototype.hasOwnProperty.call(entries, modelId)) entries[modelId] = row;
    }
  }
  const count = Object.keys(entries).length;
  return count ? { schema_version: 1, source: 'models.dev', fetched_at: new Date().toISOString(), entries } : null;
}

function fetchCatalog(url = URL) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000, headers: { 'User-Agent': 'LLMPET/1.1.1 (+models-dev)' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= MAX_BODY) chunks.push(chunk);
        else req.destroy(new Error('body too large'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error(`catalog is not JSON (${e.message})`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Load the last good cache from disk (null-prototype entries preserved via
// JSON.parse reviver-less rebuild — we re-create the null proto defensively).
function loadCatalog(cachePath = CACHE_PATH) {
  let raw;
  try { raw = fs.readFileSync(cachePath, 'utf8'); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = parsed.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
  const clean = Object.create(null);
  for (const key of Object.keys(entries)) {
    if (!safeKey(key)) continue;
    const row = entries[key];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    clean[key] = Object.assign(Object.create(null), {
      id: typeof row.id === 'string' ? row.id : key,
      input_usd_per_million: finite(row.input_usd_per_million, MAX_PRICE),
      output_usd_per_million: finite(row.output_usd_per_million, MAX_PRICE),
      cache_read_usd_per_million: finite(row.cache_read_usd_per_million, MAX_PRICE),
      cache_write_usd_per_million: finite(row.cache_write_usd_per_million, MAX_PRICE),
      context_window: finite(row.context_window, MAX_LIMIT),
      max_output: finite(row.max_output, MAX_LIMIT),
      supports_reasoning: typeof row.supports_reasoning === 'boolean' ? row.supports_reasoning : null,
      provenance: typeof row.provenance === 'string' ? row.provenance : 'models.dev',
    });
  }
  return Object.keys(clean).length ? { ...parsed, entries: clean } : null;
}

function catalogAgeMs(catalog, now = Date.now()) {
  if (!catalog || typeof catalog.fetched_at !== 'string') return Number.POSITIVE_INFINITY;
  const t = Date.parse(catalog.fetched_at);
  return Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY;
}

async function refresh(url) {
  const cache = transformModelsDev(await fetchCatalog(url || process.env.LLMPET_MODELS_DEV_URL || URL));
  if (!cache) throw new Error('models.dev catalog contains no valid models');
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
  fs.renameSync(tmp, CACHE_PATH);
  log('models.dev', `synced ${Object.keys(cache.entries).length} price rows`);
  return cache;
}

module.exports = { transformModelsDev, refresh, fetchCatalog, loadCatalog, catalogAgeMs, CACHE_PATH, URL, TTL_MS };
