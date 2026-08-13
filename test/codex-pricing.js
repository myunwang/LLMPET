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

  // Pro models have no cached-input discount, even when the source omits it.
  const implied = _extractOpenAIModels({
    'gpt-5-pro': { litellm_provider: 'openai', input_cost_per_token: 0.000015, output_cost_per_token: 0.00012 },
  });
  assert.strictEqual(implied['gpt-5-pro'].cachedInput, 15);
}

// ── the cost formula ─────────────────────────────────────────────────────────
{
  const pricing = loadCodexPricing({ pricingCachePath: '/nope', pricingOverridePath: '/nope' });
  const { price, exact, source } = priceForCodex(pricing, 'gpt-5.6-sol');
  assert.strictEqual(exact, true, 'a shipped Codex model must resolve exactly, even offline');
  assert.strictEqual(source, 'official', 'shipped model prices come from the verified official table');

  // 100k input of which 80k was cached, 10k output.
  const cost = codexUsageCost({ input: 100_000, cachedInput: 80_000, output: 10_000, reasoningOutput: 6_000 }, price);
  const expected = (20_000 * 5 + 80_000 * 0.5 + 10_000 * 30) / 1e6;
  assert.ok(Math.abs(cost - expected) < 1e-12, `cached input is a discount, not an extra charge (${cost} vs ${expected})`);

  // reasoning_output is already inside output_tokens — charging it again would
  // inflate every reasoning-heavy turn.
  const noReasoning = codexUsageCost({ input: 100_000, cachedInput: 80_000, output: 10_000 }, price);
  assert.strictEqual(cost, noReasoning, 'reasoning output must never be billed on top of output');

  const pro = priceForCodex(pricing, 'gpt-5.5-pro');
  assert.strictEqual(pro.exact, true, 'a shipped Pro model must resolve exactly offline');
  assert.strictEqual(pro.price.cachedInput, 30, 'Pro cached input has no discount');
  const proCost = codexUsageCost({ input: 100_000, cachedInput: 80_000, output: 10_000 }, pro.price);
  const proExpected = (100_000 * 30 + 10_000 * 180) / 1e6;
  assert.ok(Math.abs(proCost - proExpected) < 1e-12,
    `Pro cached input must stay at the full input rate (${proCost} vs ${proExpected})`);

  // Internal thread profiles have no public price → tier fallback, flagged.
  const review = priceForCodex(pricing, 'codex-auto-review');
  assert.strictEqual(review.exact, false, 'internal profiles must be reported as estimates');
  assert.ok(review.price.input > 0);
  assert.strictEqual(priceForCodex(pricing, 'gpt-5.9-mini').exact, false);
  assert.strictEqual(priceForCodex(pricing, 'gpt-5.9-mini').price.input, 0.75, 'unknown mini → mini tier');

  // GPT-5.4+ long-context pricing is request-scoped. A request over 272K input
  // charges all of that request's input at 2x and its output at 1.5x.
  const longCost = codexUsageCost({ input: 300_000, cachedInput: 100_000, output: 10_000 }, price);
  const longExpected = (200_000 * 5 * 2 + 100_000 * 0.5 * 2 + 10_000 * 30 * 1.5) / 1e6;
  assert.ok(Math.abs(longCost - longExpected) < 1e-12, 'a >272K request uses the official long-context multiplier');

  // A daily/model aggregate can mix normal and long requests. Only the split
  // long subset is multiplied; the aggregate total itself is not a request.
  const mixedCost = codexUsageCost({
    input: 400_000, cachedInput: 120_000, output: 20_000,
    longContextInput: 300_000, longContextCachedInput: 100_000, longContextOutput: 10_000,
  }, price);
  const mixedExpected = (
    80_000 * 5 + 20_000 * 0.5 + 10_000 * 30
    + 200_000 * 5 * 2 + 100_000 * 0.5 * 2 + 10_000 * 30 * 1.5
  ) / 1e6;
  assert.ok(Math.abs(mixedCost - mixedExpected) < 1e-12, 'aggregate repricing multiplies only explicitly marked long requests');

  const largeAggregateWithoutLongRequests = codexUsageCost({
    input: 400_000, cachedInput: 120_000, output: 20_000,
    longContextInput: 0, longContextCachedInput: 0, longContextOutput: 0,
  }, price);
  const largeAggregateExpected = (280_000 * 5 + 120_000 * 0.5 + 20_000 * 30) / 1e6;
  assert.ok(Math.abs(largeAggregateWithoutLongRequests - largeAggregateExpected) < 1e-12,
    'a large day/model aggregate with zero long-request splits must never trigger the request threshold');
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

  // A stale third-party sync must not overwrite a verified official row.
  fs.writeFileSync(path.join(stateDir, 'pricing-cache.json'), JSON.stringify({
    ts: Date.now(),
    openaiModels: { 'gpt-5.6-sol': { input: 10, cachedInput: 1, output: 60 } },
  }));
  meter.reloadPricing();
  const repriced = meter.getStats();
  assert.ok(Math.abs(repriced.today.cost - expected) < 1e-9, 'synced cache cannot replace a verified official price');
  assert.strictEqual(repriced.today.tokens, 110_000, 'repricing must not touch token counts');
  assert.ok(Math.abs(repriced.hourly.reduce((a, b) => a + b, 0) - repriced.today.cost) < 1e-9, 'hourly cost follows the reprice');

  // An explicit user override is still authoritative and does re-cost retained
  // history, unlike the third-party cache.
  fs.writeFileSync(path.join(stateDir, 'pricing.json'), JSON.stringify({
    codexModels: { 'gpt-5.6-sol': { input: 10, cachedInput: 1, output: 60 } },
  }));
  meter.reloadPricing();
  const overridden = meter.getStats();
  assert.ok(Math.abs(overridden.today.cost - expected * 2) < 1e-9, 'an explicit user override re-costs retained history');
  assert.strictEqual(overridden.byModel['gpt-5.6-sol'].priceSource, 'override');

  meter.stop();
  fs.rmSync(root, { recursive: true, force: true });

  // ── resumed rollouts: token_count before turn_context ──────────────────────
  // A resumed session replays its history first, so token_count can appear
  // hundreds of lines before the turn_context that names the model. Billing
  // those to "unknown" mislabelled 68M real gpt-5.6-sol tokens on this machine.
  {
    const rroot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-codex-resume-'));
    const dir = path.join(rroot, 'sessions', '2026', '08', '04');
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const tokenLine = (n) => JSON.stringify({
      type: 'event_msg',
      timestamp: at,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: n, cached_input_tokens: 0, output_tokens: 0, total_tokens: n },
          last_token_usage: { input_tokens: n, cached_input_tokens: 0, output_tokens: 0, total_tokens: n },
        },
      },
    });
    fs.writeFileSync(path.join(dir, 'rollout-2026-08-04T00-00-00-resumed.jsonl'), [
      JSON.stringify({ type: 'session_meta', timestamp: at, payload: { id: 'r1', cwd: '/tmp' } }),
      tokenLine(1000),  // replayed history — model not named yet
      tokenLine(2000),
      JSON.stringify({ type: 'turn_context', timestamp: at, payload: { model: 'gpt-5.6-sol' } }),
      tokenLine(3000),
    ].join('\n') + '\n');

    const resumed = createCodexMetering({
      sessionsDir: path.join(rroot, 'sessions'),
      stateDir: path.join(rroot, 'state'),
      pricingCachePath: '/nope',
      pricingOverridePath: '/nope',
    });
    await resumed.scan();
    const s = resumed.getStats();
    assert.strictEqual(s.byModel.unknown, undefined, 'pre-turn_context events must not land in "unknown"');
    assert.strictEqual(s.byModel['gpt-5.6-sol'].tokens, 6000, 'they belong to the model the file eventually names');
    assert.strictEqual(s.byModel['gpt-5.6-sol'].msgs, 3);
    assert.strictEqual(s.today.tokens, 6000, 'and the day total is unchanged');
    resumed.stop();
    fs.rmSync(rroot, { recursive: true, force: true });
  }

  // A rollout that never names a model, and has gone quiet, still gets billed —
  // parked events must not disappear.
  {
    const oroot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-codex-orphan-'));
    const dir = path.join(oroot, 'sessions', '2026', '08', '04');
    fs.mkdirSync(dir, { recursive: true });
    // mtime is stale (the rollout has gone quiet) but the event itself is from
    // today, so it lands in the day bucket getStats() reports.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const file = path.join(dir, 'rollout-2026-08-04T00-00-00-orphan.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 500, output_tokens: 0, total_tokens: 500 },
          last_token_usage: { input_tokens: 500, output_tokens: 0, total_tokens: 500 },
        },
      },
    }) + '\n');
    fs.utimesSync(file, old, old);

    const orphan = createCodexMetering({
      sessionsDir: path.join(oroot, 'sessions'),
      stateDir: path.join(oroot, 'state'),
      pricingCachePath: '/nope',
      pricingOverridePath: '/nope',
    });
    await orphan.scan();  // first pass parks the event (no model yet)
    await orphan.scan();  // second pass sees EOF + stale mtime → bills it
    const s = orphan.getStats();
    assert.strictEqual(s.byModel.unknown.tokens, 500, 'an idle model-less rollout is still billed, as unknown');
    orphan.stop();
    fs.rmSync(oroot, { recursive: true, force: true });
  }

  console.log('codex pricing checks passed');
})();
