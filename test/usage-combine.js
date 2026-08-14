'use strict';

// The panel headline used to be Claude-only while Codex sat in its own block
// with no price, so "今日花费" excluded a third of this machine's real spend.
// It also computed `usageProvider` and never honoured it, so a Codex-only pet
// was shown Claude's money.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildPetStats, combineUsage } = require('../backend/adapter');

const claude = {
  today: { cost: 18.07, tokens: 29_432_411, msgs: 72, input: 10_242, output: 57_662, cacheWrite5m: 0, cacheWrite1h: 199_974, cacheRead: 29_164_533 },
  window5h: { cost: 29.5, tokens: 38_698_424, startTs: 1000, resetTs: 19_000 },
  byModel: { 'claude-opus-5': { cost: 18.07, tokens: 29_432_411, msgs: 72 } },
  hourly: new Array(24).fill(0).map((_, i) => (i === 3 ? 18.07 : 0)),
  hourlyTok: new Array(24).fill(0).map((_, i) => (i === 3 ? 29_432_411 : 0)),
  daily: { '2026-08-04': { cost: 18.07, tokens: 29_432_411, msgs: 72 } },
  lifetime: { cost: 8193.96, tokens: 7_419_527_508, msgs: 20_143 },
};
const codex = {
  today: { cost: 4.5, tokens: 13_687_685, msgs: 87, input: 13_365_492, output: 40_301, cachedInput: 12_340_224, reasoningOutput: 10_673 },
  window5h: { cost: 3.1, tokens: 9_000_000, startTs: 500, resetTs: 18_500 },
  byModel: { 'gpt-5.6-sol': { cost: 4.5, tokens: 13_687_685, msgs: 87, unitPrice: { input: 5, cachedInput: 0.5, output: 30 }, priceExact: true } },
  hourly: new Array(24).fill(0).map((_, i) => (i === 3 ? 4.5 : 0)),
  hourlyTok: new Array(24).fill(0).map((_, i) => (i === 3 ? 13_687_685 : 0)),
  daily: { '2026-08-04': { cost: 4.5, tokens: 13_687_685, msgs: 87 }, '2026-08-03': { cost: 9, tokens: 189_800_000, msgs: 1221 } },
  lifetime: { cost: 900, tokens: 3_080_362_970, msgs: 22_578 },
};

// ── the shared panel sees both ───────────────────────────────────────────────
{
  const all = combineUsage(claude, codex, 'all');
  assert.ok(Math.abs(all.today.cost - 22.57) < 1e-9, 'the headline must be Claude + Codex');
  assert.strictEqual(all.today.tokens, 29_432_411 + 13_687_685);
  assert.strictEqual(all.today.messages, 72 + 87);
  assert.strictEqual(all.todayByProvider.claude.cost, 18.07);
  assert.strictEqual(all.todayByProvider.codex.cost, 4.5);
  assert.strictEqual(all.lifetimeByProvider.claude.cost, 8193.96);
  assert.strictEqual(all.lifetimeByProvider.codex.cost, 900);

  assert.ok(Math.abs(all.window5h.cost - 32.6) < 1e-9);
  assert.strictEqual(all.window5h.startTs, 500, 'the window starts at the earliest live event of either agent');

  assert.deepStrictEqual(Object.keys(all.byModel).sort(), ['claude-opus-5', 'gpt-5.6-sol']);
  assert.strictEqual(all.byModel['claude-opus-5'].agent, 'claude', 'model rows carry their agent for the badge');
  assert.strictEqual(all.byModel['gpt-5.6-sol'].agent, 'codex');
  assert.deepStrictEqual(all.byModel['gpt-5.6-sol'].unitPrice, { input: 5, cachedInput: 0.5, output: 30 });
  assert.strictEqual(all.byModel['gpt-5.6-sol'].priceExact, true);

  assert.ok(Math.abs(all.hourly[3] - 22.57) < 1e-9, 'the 24h cost chart sums both agents');
  assert.strictEqual(all.hourlyTok[3], 29_432_411 + 13_687_685);
  assert.strictEqual(all.hourly.length, 24);

  assert.ok(Math.abs(all.daily['2026-08-04'].cost - 22.57) < 1e-9, 'the calendar sums both agents');
  assert.strictEqual(all.daily['2026-08-03'].tokens, 189_800_000, 'a Codex-only day still shows up');
  assert.strictEqual(all.lifetime.tokens, 7_419_527_508 + 3_080_362_970);
  assert.strictEqual(all.lifetime.messages, 20_143 + 22_578);
}

// ── a single-agent pet only ever sees its own numbers ────────────────────────
{
  const onlyClaude = combineUsage(claude, codex, 'claude');
  assert.strictEqual(onlyClaude.today.cost, 18.07);
  assert.strictEqual(onlyClaude.todayByProvider.codex.cost, 0);
  assert.deepStrictEqual(Object.keys(onlyClaude.byModel), ['claude-opus-5']);
  assert.strictEqual(onlyClaude.daily['2026-08-03'], undefined, 'Codex-only days stay out of a Claude pet');

  const onlyCodex = combineUsage(claude, codex, 'codex');
  assert.strictEqual(onlyCodex.today.cost, 4.5, 'a Codex pet must not be shown Claude spend');
  assert.strictEqual(onlyCodex.todayByProvider.claude.cost, 0);
  assert.deepStrictEqual(Object.keys(onlyCodex.byModel), ['gpt-5.6-sol']);
  assert.strictEqual(onlyCodex.window5h.cost, 3.1);

  for (const provider of ['dsh', 'future-agent']) {
    const unavailable = combineUsage(claude, codex, provider);
    assert.strictEqual(unavailable.billingAvailable, false, `${provider} has no attributable billing ledger`);
    assert.strictEqual(unavailable.today.cost, 0);
    assert.strictEqual(unavailable.today.tokens, 0);
    assert.strictEqual(unavailable.lifetime.cost, 0);
    assert.strictEqual(unavailable.todayByProvider.claude.cost, 0);
    assert.strictEqual(unavailable.todayByProvider.codex.cost, 0);
    assert.deepStrictEqual(unavailable.byModel, {});
    assert.ok(unavailable.hourly.every((value) => value === 0));
    assert.deepStrictEqual(unavailable.daily, {});
  }

  const dshStats = buildPetStats(
    { sessions: [], active: null, ts: 1 },
    [],
    claude,
    { codexUsage: codex, usageProvider: 'dsh' },
  );
  assert.strictEqual(dshStats.billingAvailable, false);
  assert.strictEqual(dshStats.usageProvider, 'dsh');
  assert.strictEqual(dshStats.today.cost, 0, 'a DSH pet snapshot must not contain Claude/Codex spend');
}

// ── missing ledgers degrade to zeros, never to NaN ───────────────────────────
{
  const none = combineUsage(null, null, 'all');
  assert.strictEqual(none.today.cost, 0);
  assert.strictEqual(none.today.tokens, 0);
  assert.strictEqual(none.window5h.resetTs, 0);
  assert.strictEqual(none.lifetimeByProvider.claude.cost, 0);
  assert.strictEqual(none.lifetimeByProvider.codex.cost, 0);
  assert.deepStrictEqual(none.byModel, {});
  assert.strictEqual(none.hourly.length, 24);
  assert.ok(none.hourly.every((v) => v === 0));
  assert.deepStrictEqual(none.daily, {});

  const claudeOnlyMachine = combineUsage(claude, null, 'all');
  assert.strictEqual(claudeOnlyMachine.today.cost, 18.07, 'a machine without Codex is unchanged');
  assert.strictEqual(claudeOnlyMachine.todayByProvider.codex.tokens, 0);
}

console.log('usage combine (Claude + Codex panel) checks passed');

// Integration guard: main.js must not turn the shared `all` surface back into
// Claude-only usage before handing it to combineUsage().
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert.ok(mainSource.includes('usageProvider: agent,'), 'shared pet/panel passes provider=all through unchanged');
assert.ok(!mainSource.includes("usageProvider: agent === 'codex' ? 'codex' : 'claude'"), 'all must never collapse to Claude');
