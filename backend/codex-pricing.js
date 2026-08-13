'use strict';

// Pricing for Codex (OpenAI) usage — the mirror of metering.js's Claude table.
//
// Codex rollouts report `last_token_usage` as { input_tokens, cached_input_tokens,
// output_tokens, reasoning_output_tokens }. OpenAI bills three rates:
//   fresh input  = input_tokens - cached_input_tokens   (cached is a SUBSET)
//   cached input = cached_input_tokens                  (model-specific rate)
//   output       = output_tokens                        (reasoning is a SUBSET)
// Adding cached input or reasoning output on top would double-bill them, which is
// why both are tracked separately but never summed into the charged base.
//
// Priority: user override (~/.octopus/pricing.json, "codexModels" map) >
// official built-ins below > LiteLLM sync cache (openaiModels) > tier fallback.
// A third-party cache is useful for unknown models, but must never silently
// replace an official price for a model LLMPET already knows.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.octopus');
const PRICING_OVERRIDE_PATH = path.join(STATE_DIR, 'pricing.json');
const PRICING_CACHE_PATH = path.join(STATE_DIR, 'pricing-cache.json');

// USD per 1,000,000 tokens. Keyword tiers are the last-resort fallback for a
// model id the sync has never seen; exact ids come from LiteLLM at runtime.
const DEFAULT_CODEX_PRICING = {
  pro:     { input: 30,   cachedInput: 30,    output: 180 },
  codex:   { input: 1.75, cachedInput: 0.175, output: 14 },
  mini:    { input: 0.75, cachedInput: 0.075, output: 4.5 },
  nano:    { input: 0.2,  cachedInput: 0.02,  output: 1.2 },
  default: { input: 5,    cachedInput: 0.5,   output: 30 },
};

// Built-in exact prices so a first run (or an offline machine) still bills the
// models Codex actually ships with, instead of falling back to the tier guess.
const BUILTIN_CODEX_MODELS = {
  'gpt-5.6':       { input: 5,    cachedInput: 0.5,   output: 30,  longContextThreshold: 272_000 },
  'gpt-5.6-sol':   { input: 5,    cachedInput: 0.5,   output: 30,  longContextThreshold: 272_000 },
  'gpt-5.6-terra': { input: 2,    cachedInput: 0.2,   output: 12,  longContextThreshold: 272_000 },
  'gpt-5.6-luna':  { input: 0.2,  cachedInput: 0.02,  output: 1.2, longContextThreshold: 272_000 },
  'gpt-5.5':       { input: 5,    cachedInput: 0.5,   output: 30,  longContextThreshold: 272_000 },
  'gpt-5.5-pro':   { input: 30,   cachedInput: 30,    output: 180 },
  'gpt-5.4':       { input: 2.5,  cachedInput: 0.25,  output: 15,  longContextThreshold: 272_000 },
  'gpt-5.4-pro':   { input: 30,   cachedInput: 30,    output: 180, longContextThreshold: 272_000 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.1-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-codex':   { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5':         { input: 1.25, cachedInput: 0.125, output: 10 },
};

// Rollouts sometimes name an internal thread profile where a model id belongs —
// `codex-auto-review` is the guardian/auto-review subagent, which has no public
// price. Those ids stay OUT of the exact table on purpose so priceForCodex()
// reports them as estimates and the panel can say so.
const INTERNAL_PROFILE_IDS = new Set(['codex-auto-review', 'unknown']);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Normalize an OpenAI/Codex model name: lowercase, drop any provider/region
// prefix (openai/, azure/global/, openrouter/openai/) and the dated suffix
// LiteLLM appends (gpt-5.5-2026-04-23 → gpt-5.5).
function normCodexModelName(model) {
  const s = String(model || '').toLowerCase().trim().split(':')[0];
  if (!s) return '';
  const bare = s.slice(s.lastIndexOf('/') + 1);
  return bare.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
}

function normalizeCodexRow(row, fallback = DEFAULT_CODEX_PRICING.default) {
  const input = Number.isFinite(row && row.input) ? row.input : fallback.input;
  const cachedInput = Number.isFinite(row && row.cachedInput) ? row.cachedInput : input * 0.1;
  const output = Number.isFinite(row && row.output) ? row.output : fallback.output;
  const out = { input, cachedInput, output };
  const contextWindow = Number.isFinite(row && row.contextWindow) ? row.contextWindow : fallback.contextWindow;
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    out.contextWindow = Math.floor(contextWindow);
  }
  const longContextThreshold = Number.isFinite(row && row.longContextThreshold)
    ? row.longContextThreshold : fallback.longContextThreshold;
  if (Number.isFinite(longContextThreshold) && longContextThreshold > 0) {
    out.longContextThreshold = Math.floor(longContextThreshold);
  }
  return out;
}

function loadCodexPricing(options = {}) {
  const cachePath = options.pricingCachePath || PRICING_CACHE_PATH;
  const overridePath = options.pricingOverridePath || PRICING_OVERRIDE_PATH;
  const out = JSON.parse(JSON.stringify(DEFAULT_CODEX_PRICING));
  out._models = {};
  out._sources = {};
  // layer 1: synced cache (openaiModels written by pricing-sync). This fills
  // models not yet present in the bundled official table.
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c && c.openaiModels && typeof c.openaiModels === 'object') {
      for (const [id, row] of Object.entries(c.openaiModels)) {
        if (row && typeof row === 'object' && Number.isFinite(row.input)) {
          const key = normCodexModelName(id);
          out._models[key] = normalizeCodexRow(row);
          out._sources[key] = 'synced';
        }
      }
    }
  } catch {}
  // layer 2: exact prices verified against OpenAI's model pages — these beat
  // a stale or incorrect third-party cache.
  for (const [id, row] of Object.entries(BUILTIN_CODEX_MODELS)) {
    out._models[id] = normalizeCodexRow(row);
    out._sources[id] = 'official';
  }
  // layer 3: explicit user override — always wins.
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    const models = raw && raw.codexModels;
    if (models && typeof models === 'object') {
      for (const [id, row] of Object.entries(models)) {
        const k = normCodexModelName(id);
        if (k && row && typeof row === 'object') {
          out._models[k] = normalizeCodexRow(row, out._models[k] || DEFAULT_CODEX_PRICING.default);
          out._sources[k] = 'override';
        }
      }
    }
    for (const tier of Object.keys(DEFAULT_CODEX_PRICING)) {
      const row = raw && raw[`codex.${tier}`];
      if (row && typeof row === 'object') out[tier] = normalizeCodexRow(row, out[tier]);
    }
  } catch {}
  for (const tier of Object.keys(DEFAULT_CODEX_PRICING)) {
    out[tier] = normalizeCodexRow(out[tier], DEFAULT_CODEX_PRICING[tier]);
  }
  return out;
}

// Resolve a price row. `exact` is false when the id was never in the table —
// the caller surfaces that as "billed at an estimated rate" in diagnostics
// rather than silently presenting a guess as a real number.
function priceForCodex(pricing, model) {
  const id = normCodexModelName(model);
  const models = (pricing && pricing._models) || {};
  if (id && models[id] && !INTERNAL_PROFILE_IDS.has(id)) {
    return {
      price: normalizeCodexRow(models[id]),
      exact: true,
      source: (pricing && pricing._sources && pricing._sources[id]) || 'exact',
    };
  }
  const tier = id.includes('-pro') ? 'pro'
    : id.includes('nano') ? 'nano'
    : id.includes('mini') ? 'mini'
    : id.includes('codex') ? 'codex'
    : 'default';
  return {
    price: normalizeCodexRow((pricing && pricing[tier]) || DEFAULT_CODEX_PRICING[tier]),
    exact: false,
    source: 'estimated',
  };
}

// Cost of one usage delta. Cached input is discounted, not additive; reasoning
// output is already inside output_tokens and is never charged twice.
function codexUsageCost(usage, price) {
  const u = usage || {};
  const p = normalizeCodexRow(price);
  const input = num(u.input);
  const cachedInput = Math.min(input, num(u.cachedInput));
  const freshInput = input - cachedInput;
  // OpenAI prices GPT-5.4+ requests above 272K input tokens at 2x input
  // (including cached input) and 1.5x output for the full request.
  // Aggregated ledger rows always carry these split fields, even when every
  // request was below the threshold and all three values are zero. Checking
  // their numeric value made a 1.8B-token day look like one giant request and
  // incorrectly doubled the whole day. Presence, not >0, distinguishes an
  // aggregate from the one-request objects used by callers/tests.
  const explicitlySplit = Object.prototype.hasOwnProperty.call(u, 'longContextInput')
    || Object.prototype.hasOwnProperty.call(u, 'longContextCachedInput')
    || Object.prototype.hasOwnProperty.call(u, 'longContextOutput');
  const wholeRequestIsLong = !explicitlySplit
    && num(p.longContextThreshold) > 0
    && input > p.longContextThreshold;
  const longInput = explicitlySplit ? Math.min(input, num(u.longContextInput))
    : (wholeRequestIsLong ? input : 0);
  const longCachedInput = explicitlySplit
    ? Math.min(longInput, cachedInput, num(u.longContextCachedInput))
    : (wholeRequestIsLong ? cachedInput : 0);
  const longFreshInput = Math.min(freshInput, Math.max(0, longInput - longCachedInput));
  const longOutput = explicitlySplit ? Math.min(num(u.output), num(u.longContextOutput))
    : (wholeRequestIsLong ? num(u.output) : 0);
  return (
    (freshInput - longFreshInput) * p.input
    + longFreshInput * p.input * 2
    + (cachedInput - longCachedInput) * p.cachedInput
    + longCachedInput * p.cachedInput * 2
    + (num(u.output) - longOutput) * p.output
    + longOutput * p.output * 1.5
  ) / 1e6;
}

module.exports = {
  DEFAULT_CODEX_PRICING,
  BUILTIN_CODEX_MODELS,
  INTERNAL_PROFILE_IDS,
  normCodexModelName,
  normalizeCodexRow,
  loadCodexPricing,
  priceForCodex,
  codexUsageCost,
};
