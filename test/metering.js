'use strict';

// Regression coverage for the two expensive metering bugs:
// 1) Claude emits the same message id repeatedly while output_tokens grows;
// 2) 5-minute and 1-hour cache writes have different prices.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMetering } = require('../backend/metering');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-metering-'));
const projectsDir = path.join(root, 'projects');
const stateDir = path.join(root, 'state');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

const meter = createMetering({ projectsDir, stateDir });
const now = Date.now();
const first = {
  input_tokens: 4,
  output_tokens: 2,
  cache_creation_input_tokens: 120,
  cache_read_input_tokens: 50,
  cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 100 },
};
const final = { ...first, output_tokens: 372 };

assert.strictEqual(meter._ingest('message-1|request-1', now, 'claude-opus-4-1', first), true);
assert.strictEqual(meter._ingest('message-1|request-1', now, 'claude-opus-4-1', final), true);
assert.strictEqual(meter._ingest('message-1|request-1', now, 'claude-opus-4-1', final), false);

const stats = meter.getStats();
assert.strictEqual(stats.today.msgs, 1, 'streaming updates must remain one turn');
assert.strictEqual(stats.today.output, 372, 'final output usage must win over the first partial row');
assert.strictEqual(stats.today.cacheWrite5m, 20);
assert.strictEqual(stats.today.cacheWrite1h, 100);
assert.strictEqual(stats.today.cacheCreate, 120);
assert.strictEqual(stats.today.tokens, 4 + 372 + 20 + 100 + 50);
assert.strictEqual(stats.lifetime.tokens, stats.today.tokens, 'Claude lifetime must advance with deduplicated usage');
assert.strictEqual(stats.lifetime.msgs, 1, 'streaming corrections must not create lifetime turns');
assert.strictEqual(stats.hourlyTok.reduce((a, b) => a + b, 0), stats.today.tokens);
assert.strictEqual(stats.diagnostics.streamingCorrections, 1);
assert.strictEqual(stats.diagnostics.records, 1);

// Opus 4.1 fallback: input 15, output 75, 5m write 18.75, 1h write 30, read 1.5.
const expectedCost = (4 * 15 + 372 * 75 + 20 * 18.75 + 100 * 30 + 50 * 1.5) / 1e6;
assert(Math.abs(stats.today.cost - expectedCost) < 1e-12);

const lifetimeBeforeReprice = meter.getStats().lifetime.tokens;
meter.reloadPricing();
assert.strictEqual(
  meter.getStats().lifetime.tokens,
  lifetimeBeforeReprice,
  'repricing retained records must not double-count lifetime progression',
);

meter.stop();

// ── multi-iteration turns ────────────────────────────────────────────────────
// A turn that needed several API calls lists every one in usage.iterations[],
// while the top-level fields describe only the LAST one. Billing is per API
// call, so the top level alone under-counts the turn.
{
  const iterMeter = createMetering({ projectsDir, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-iter-')) });
  const usage = {
    input_tokens: 2, output_tokens: 641, cache_creation_input_tokens: 0, cache_read_input_tokens: 51245,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    iterations: [
      {
        input_tokens: 2, output_tokens: 834, cache_creation_input_tokens: 1486, cache_read_input_tokens: 52561,
        cache_creation: { ephemeral_5m_input_tokens: 1486, ephemeral_1h_input_tokens: 0 },
      },
      {
        input_tokens: 2, output_tokens: 641, cache_creation_input_tokens: 0, cache_read_input_tokens: 51245,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    ],
  };
  assert.strictEqual(iterMeter._ingest('m|r', Date.now(), 'claude-opus-4-1', usage), true);
  const s = iterMeter.getStats();
  assert.strictEqual(s.today.output, 834 + 641, 'every iteration must be billed, not just the last');
  assert.strictEqual(s.today.cacheRead, 52561 + 51245);
  assert.strictEqual(s.today.cacheWrite5m, 1486);
  assert.strictEqual(s.today.msgs, 1, 'iterations are one turn, not several');
  iterMeter.stop();

  // A transcript row without iterations[] must still bill from the top level.
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-plain-'));
  const plain = createMetering({ projectsDir, stateDir: plainDir });
  assert.strictEqual(plain._ingest('m|r', Date.now(), 'claude-opus-4-1', {
    input_tokens: 7, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  }), true);
  assert.strictEqual(plain.getStats().today.output, 9);
  plain.stop();
}

// ── nested subagent transcripts ──────────────────────────────────────────────
// Task-tool and workflow runs live under <session-id>/subagents/** and bill to
// the same account; a flat one-level scan silently dropped all of them.
{
  const nestedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-nested-'));
  const projects = path.join(nestedRoot, 'projects');
  const deep = path.join(projects, '-Users-me-proj', 'session-1', 'subagents', 'workflows', 'wf_1');
  fs.mkdirSync(deep, { recursive: true });
  const line = (id, out) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    requestId: id,
    message: { id, model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }) + '\n';
  fs.writeFileSync(path.join(projects, '-Users-me-proj', 'top.jsonl'), line('top', 100));
  fs.writeFileSync(path.join(deep, 'agent-x.jsonl'), line('sub', 250));

  const nested = createMetering({ projectsDir: projects, stateDir: path.join(nestedRoot, 'state') });
  nested.scan().then(() => {
    const s = nested.getStats();
    assert.strictEqual(s.today.output, 350, 'subagent transcripts must be billed too');
    assert.strictEqual(s.today.msgs, 2);
    nested.stop();
    fs.rmSync(nestedRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    console.log('metering streaming/TTL/iteration/subagent checks passed');
  });
}
