'use strict';

// Pricing sync — public-data only, no credentials/API calls.
//
// Pulls Anthropic model prices from the community-maintained LiteLLM JSON
// (a static GitHub-hosted file) and caches them to ~/.octopus/pricing-cache.json.
// metering.loadPricing() merges them BENEATH the user's manual override at
// ~/.octopus/pricing.json, so a hand-tuned price still wins.
//
// Safety:
//   - Fetches one public JSON file. No auth, no account, no API quota.
//   - Failures are silent — the cost-chip stays accurate-enough on the built-in defaults.
//   - Stale caches are still used (better than nothing).

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('./log');
const { normModelName } = require('./metering');

const CACHE = path.join(os.homedir(), '.octopus', 'pricing-cache.json');
const URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 4000;            // let the app finish booting first
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY = 4 * 1024 * 1024;

function fetchJson(url) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (r) => {
      if (r.statusCode !== 200) { r.resume(); rej(new Error('HTTP ' + r.statusCode)); return; }
      let body = ''; let size = 0; let tooLarge = false;
      r.on('data', (c) => { if (tooLarge) return; size += c.length; if (size > MAX_BODY) { tooLarge = true; return; } body += c; });
      r.on('end', () => { if (tooLarge) { rej(new Error('body too large')); return; } try { res(JSON.parse(body)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
  });
}

// LiteLLM stores costs as USD per token; we use USD per 1M tokens.
const toMTok = (v) => (Number.isFinite(v) ? v * 1e6 : null);

// Collapse all per-model rows into family rows (opus/sonnet/haiku).
// LiteLLM lists newer dated variants later, so taking the last non-null wins
// = current pricing. Older models stay archived if they had different prices.
function extractFamilies(table) {
  const fams = { opus: null, sonnet: null, haiku: null };
  if (!table || typeof table !== 'object') return fams;
  for (const [name, m] of Object.entries(table)) {
    if (!m || typeof m !== 'object') continue;
    const n = String(name).toLowerCase();
    if (!n.includes('claude')) continue;
    if (m.litellm_provider && m.litellm_provider !== 'anthropic') continue;
    const fam = n.includes('opus') ? 'opus' : n.includes('sonnet') ? 'sonnet' : n.includes('haiku') ? 'haiku' : null;
    if (!fam) continue;
    const row = {
      input: toMTok(m.input_cost_per_token),
      output: toMTok(m.output_cost_per_token),
      cacheWrite: toMTok(m.cache_creation_input_token_cost),
      cacheRead: toMTok(m.cache_read_input_token_cost),
    };
    if (Object.values(row).every((v) => v == null)) continue;
    // merge: prefer last non-null (newer dated rows win)
    fams[fam] = {
      input: row.input != null ? row.input : (fams[fam] ? fams[fam].input : null),
      output: row.output != null ? row.output : (fams[fam] ? fams[fam].output : null),
      cacheWrite: row.cacheWrite != null ? row.cacheWrite : (fams[fam] ? fams[fam].cacheWrite : null),
      cacheRead: row.cacheRead != null ? row.cacheRead : (fams[fam] ? fams[fam].cacheRead : null),
    };
  }
  // Drop families with no usable numbers; round to 4 decimals.
  const out = {};
  const r = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
  for (const [fam, row] of Object.entries(fams)) {
    if (!row) continue;
    if (row.input == null && row.output == null) continue;
    out[fam] = { input: r(row.input), output: r(row.output), cacheWrite: r(row.cacheWrite), cacheRead: r(row.cacheRead) };
  }
  return out;
}

// Exact per-model-id prices (NOT folded to families), keyed by the bare model
// name the transcripts use (claude-fable-5, claude-opus-4-8). This is what fixes
// "every non-opus/sonnet/haiku model silently billed at sonnet price" and keeps
// opus generations (4-1 $15/$75 vs 4-8 $5/$25) distinct. Only anthropic-direct
// rows are taken (bedrock/vertex/region variants skipped).
function extractModels(table) {
  const out = {};
  if (!table || typeof table !== 'object') return out;
  const r = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
  for (const [name, m] of Object.entries(table)) {
    if (!m || typeof m !== 'object') continue;
    if (m.litellm_provider !== 'anthropic') continue;
    if (!/claude/i.test(name)) continue;
    const id = normModelName(name);
    if (!id) continue;
    const input = toMTok(m.input_cost_per_token);
    const output = toMTok(m.output_cost_per_token);
    if (input == null && output == null) continue;
    let cacheWrite = toMTok(m.cache_creation_input_token_cost);
    let cacheRead = toMTok(m.cache_read_input_token_cost);
    if (cacheWrite == null && input != null) cacheWrite = input * 1.25; // Anthropic standard ratios
    if (cacheRead == null && input != null) cacheRead = input * 0.1;
    out[id] = { input: r(input), output: r(output), cacheWrite: r(cacheWrite), cacheRead: r(cacheRead) };
  }
  return out;
}

function createPricingSync(options = {}) {
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  let timer = null;
  let stopped = false;

  function scheduleNext(ms) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, ms);
    if (timer.unref) timer.unref();
  }

  async function refresh() {
    if (stopped) return;
    try {
      const table = await fetchJson(URL);
      const pricing = extractFamilies(table);
      const models = extractModels(table);
      if (!Object.keys(pricing).length) throw new Error('no claude families extracted');
      try {
        fs.mkdirSync(path.dirname(CACHE), { recursive: true });
        fs.writeFileSync(CACHE, JSON.stringify({ ts: Date.now(), source: 'litellm', url: URL, pricing, models }, null, 2));
      } catch (e) { log('pricing', 'cache write failed:', e.message); }
      const fams = Object.keys(pricing).join('/');
      log('pricing', `synced from LiteLLM (${fams}; ${Object.keys(models).length} models)`);
      try { onUpdate(); } catch {}
    } catch (e) {
      log('pricing', 'sync skipped:', e.message);
    }
    scheduleNext(REFRESH_MS);
  }

  function start() {
    stopped = false;
    scheduleNext(STARTUP_DELAY_MS); // don't compete with hook install
  }
  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }
  function getCached() {
    try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
  }

  return { start, stop, getCached, refresh };
}

module.exports = { createPricingSync, CACHE_PATH: CACHE, _extractFamilies: extractFamilies, _extractModels: extractModels };
