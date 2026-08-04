'use strict';

// Codex used to be metered but never priced: the panel counted its tokens and
// billed them at $0, so a Codex-heavy day showed no spend at all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadCodexPricing, priceForCodex, codexUsageCost, normCodexModelName,
} = require('../backend/codex-pricing');
const { createCodexMetering } = require('../backend/codex-metering');
const { _extractOpenAIModels } = require('../backend/pricing-sync');

// ── name normalisation ───────────────────────────────────────────────────────
assert.strictEqual(normCodexModelName('gpt-5.5-2026-04-23'), 'gpt-5.5', 'dated variants fold onto the bare id');
assert.strictEqual(normCodexModelName('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
assert.strictEqual(normCodexModelName('azure/global/gpt-5.1-codex'), 'gpt-5.1-codex');
assert.strictEqual(normCodexModelName('GPT-5.6-Terra'), 'gpt-5.6-terra');
assert.strictEqual(normCodexModelName(''), '');

// ── LiteLLM extraction takes openai-direct rows only ─────────────────────────
{
  const models = _extractOpenAIModels({
    'gpt-5.6-sol': {
      litellm_provider: 'openai',
      input_cost_per_token: 0.000005,
      cache_read_input_token_cost: 0.0000005,
      output_cost_per_token: 0.00003,
      max_input_tokens: 400000,
    },
    'azure/gpt-5.2-codex': {
      litellm_provider: 'azure', input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014,
    },
    'chatgpt/gpt-5.3-codex': { litellm_provider: 'chatgpt' }, // plan alias, no price
    'claude-opus-5': { litellm_provider: 'anthropic', input_cost_per_token: 0.000005 },
  });
  assert.deepStrictEqual(Object.keys(models), ['gpt-5.6-sol'], 'only openai-direct priced rows are taken');
  assert.strictEqual(models['gpt-5.6-sol'].input, 5);
  assert.strictEqual(models['gpt-5.6-sol'].cachedInput, 0.5);
  assert.strictEqual(models['gpt-5.6-sol'].output, 30);
  assert.strictEqual(models['gpt-5.6-sol'].contextWindow, 400000);

  // A row with no cached price falls back to OpenAI's standard 10% discount.
  const implied = _extractOpenAIModels({
    'gpt-5-pro': { litellm_provider: 'openai', input_cost_per_token: 0.000015, output_cost_per_token: 0.00012 },
  });
  assert.strictEqual(implied['gpt-5-pro'].cachedInput, 1.5);
}

// ── the cost formula ─────────────────────────────────────────────────────────
{
  const pricing = loadCodexPricing({ pricingCachePath: '/nope', pricingOverridePath: '/nope' });
  const { price, exact } = priceForCodex(pricing, 'gpt-5.6-sol');
  assert.strictEqual(exact, true, 'a shipped Codex model must resolve exactly, even offline');

  // 100k input of which 80k was cached, 10k output.
  const cost = codexUsageCost({ input: 100_000, cachedInput: 80_000, output: 10_000, reasoningOutput: 6_000 }, price);
  const expected = (20_000 * 5 + 80_000 * 0.5 + 10_000 * 30) / 1e6;
  assert.ok(Math.abs(cost - expected) < 1e-12, `cached input is a discount, not an extra charge (${cost} vs ${expected})`);

  // reasoning_output is already inside output_tokens — charging it again would
  // inflate every reasoning-heavy turn.
  const noReasoning = codexUsageCost({ input: 100_000, cachedInput: 80_000, output: 10_000 }, price);
  assert.strictEqual(cost, noReasoning, 'reasoning output must never be billed on top of output');

  // Internal thread profiles have no public price → tier fallback, flagged.
  const review = priceForCodex(pricing, 'codex-auto-review');
  assert.strictEqual(review.exact, false, 'internal profiles must be reported as estimates');
  assert.ok(review.price.input > 0);
  assert.strictEqual(priceForCodex(pricing, 'gpt-5.9-mini').exact, false);
  assert.strictEqual(priceForCodex(pricing, 'gpt-5.9-mini').price.input, 0.75, 'unknown mini → mini tier');
}

// ── the ledger records cost, and reprices when the table changes ─────────────
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-codex-price-'));
  const sessionsDir = path.join(root, 'sessions', '2026', '08', '04');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const ts = new Date().toISOString();
  const rollout = [
    JSON.stringify({ type: 'session_meta', timestamp: ts, payload: { id: 's1', cwd: '/tmp' } }),
    JSON.stringify({ type: 'turn_context', timestamp: ts, payload: { model: 'gpt-5.6-sol' } }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: ts,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 10000, total_tokens: 110000 },
          last_token_usage: { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 10000, total_tokens: 110000 },
        },
      },
    }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(sessionsDir, 'rollout-2026-08-04T00-00-00-s1.jsonl'), rollout);

  const meter = createCodexMetering({
    sessionsDir: path.join(root, 'sessions'),
    stateDir,
    pricingCachePath: path.join(stateDir, 'pricing-cache.json'),
    pricingOverridePath: path.join(stateDir, 'pricing.json'),
  });
  await meter.scan();
  const stats = meter.getStats();
  const expected = (20_000 * 5 + 80_000 * 0.5 + 10_000 * 30) / 1e6;
  assert.ok(Math.abs(stats.today.cost - expected) < 1e-9, `Codex usage must carry a price (${stats.today.cost})`);
  assert.strictEqual(stats.today.tokens, 110_000);
  assert.strictEqual(stats.byModel['gpt-5.6-sol'].cost, stats.today.cost);
  assert.ok(Math.abs(stats.hourly.reduce((a, b) => a + b, 0) - stats.today.cost) < 1e-9, 'hourly curve is cost');
  assert.strictEqual(stats.hourlyTok.reduce((a, b) => a + b, 0), 110_000, 'hourlyTok stays tokens');
  assert.ok(Math.abs(stats.window5h.cost - stats.today.cost) < 1e-9, 'a fresh event lands in the 5h window');

  // A synced price table must retroactively re-cost the retained days.
  fs.writeFileSync(path.join(stateDir, 'pricing-cache.json'), JSON.stringify({
    ts: Date.now(),
    openaiModels: { 'gpt-5.6-sol': { input: 10, cachedInput: 1, output: 60 } },
  }));
  meter.reloadPricing();
  const repriced = meter.getStats();
  assert.ok(Math.abs(repriced.today.cost - expected * 2) < 1e-9, 'reloadPricing must re-cost history, not only new events');
  assert.strictEqual(repriced.today.tokens, 110_000, 'repricing must not touch token counts');
  assert.ok(Math.abs(repriced.hourly.reduce((a, b) => a + b, 0) - repriced.today.cost) < 1e-9, 'hourly cost follows the reprice');

  meter.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('codex pricing checks passed');
})();
