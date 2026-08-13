'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodexMetering, normalizeUsage, deltaUsage } = require('../backend/codex-metering');

const first = normalizeUsage({
  input_tokens: 100,
  cached_input_tokens: 60,
  output_tokens: 20,
  reasoning_output_tokens: 8,
  total_tokens: 120,
});
const second = normalizeUsage({
  input_tokens: 250,
  cached_input_tokens: 150,
  output_tokens: 50,
  reasoning_output_tokens: 18,
  total_tokens: 300,
});
assert.deepStrictEqual(deltaUsage(first, second), {
  tokens: 180, input: 150, output: 30, cachedInput: 90, reasoningOutput: 10, cacheWrite: 0,
  longContextInput: 0, longContextCachedInput: 0, longContextOutput: 0,
});
assert.strictEqual(first.tokens, first.input + first.output);
assert(first.cachedInput <= first.input, 'cached input is a subset, not extra total tokens');
assert(first.reasoningOutput <= first.output, 'reasoning output is a subset, not extra total tokens');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-codex-meter-'));
  const sessionsDir = path.join(root, 'sessions', '2026', '07', '29');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rollout = path.join(sessionsDir, 'rollout-test.jsonl');
  const rows = [
    { timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'codex-session-1' } },
    { timestamp: new Date().toISOString(), type: 'turn_context', payload: { model: 'gpt-5.6-codex' } },
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: {
        input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120,
      },
      last_token_usage: {
        input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120,
      },
    } } },
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: {
        input_tokens: 250, cached_input_tokens: 150, output_tokens: 50, reasoning_output_tokens: 18, total_tokens: 300,
      },
      last_token_usage: {
        input_tokens: 150, cached_input_tokens: 90, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 180,
      },
    } } },
    // Real rollouts can reset total_token_usage after compaction. The ledger
    // must add only this request (70), not the reset cumulative snapshot as a
    // new segment on top of the previous 300.
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: {
        input_tokens: 60, cached_input_tokens: 32, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 70,
      },
      last_token_usage: {
        input_tokens: 60, cached_input_tokens: 32, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 70,
      },
    } } },
  ];
  fs.writeFileSync(rollout, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  const meter = createCodexMetering({ sessionsDir: path.join(root, 'sessions'), stateDir });
  await meter.scan();
  let stats = meter.getStats();
  assert.strictEqual(stats.today.tokens, 370);
  assert.strictEqual(stats.today.input, 310);
  assert.strictEqual(stats.today.output, 60);
  assert.strictEqual(stats.today.cachedInput, 182);
  assert.strictEqual(stats.today.reasoningOutput, 22);
  assert.strictEqual(stats.today.msgs, 3);
  assert.strictEqual(stats.lifetime.tokens, 370);
  assert.strictEqual(stats.hourlyTok.reduce((a, b) => a + b, 0), 370);
  assert.strictEqual(stats.diagnostics.resets, 1);
  assert.deepStrictEqual(stats.byModel['gpt-5.6-codex'].unitPrice,
    { input: 1.75, cachedInput: 0.175, output: 14 });
  assert.strictEqual(stats.byModel['gpt-5.6-codex'].priceExact, false,
    'an unknown rollout model must expose that its displayed rate is estimated');

  // A migration scan must surface today's rollouts before a huge historical
  // file, and prefer smaller unread files within the same priority tier.
  const today = new Date();
  const todayDir = path.join(root, 'priority', String(today.getFullYear()),
    String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0'));
  const oldDir = path.join(root, 'priority', '2020', '01', '01');
  fs.mkdirSync(todayDir, { recursive: true });
  fs.mkdirSync(oldDir, { recursive: true });
  const todaySmall = path.join(todayDir, 'small.jsonl');
  const todayLarge = path.join(todayDir, 'large.jsonl');
  const oldSmall = path.join(oldDir, 'old.jsonl');
  fs.writeFileSync(todaySmall, 'x');
  fs.writeFileSync(todayLarge, 'x'.repeat(200));
  fs.writeFileSync(oldSmall, 'x');
  const prioritized = await meter._prioritizeFiles([oldSmall, todayLarge, todaySmall]);
  assert.deepStrictEqual(prioritized, [todaySmall, todayLarge, oldSmall],
    'today comes first, with the smallest unread rollout first');

  await meter.scan();
  stats = meter.getStats();
  assert.strictEqual(stats.today.tokens, 370, 'second scan must not double count');
  meter.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('codex metering checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
