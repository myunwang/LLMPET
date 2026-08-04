'use strict';

// Regression coverage for "installing a new build reset my billing".
//
// Both ledgers used to drop every aggregate when the state schema changed and
// rebuild from the transcripts. Claude Code deletes transcripts after
// cleanupPeriodDays (30 by default), so the rebuild could not reach the older
// days and they were erased for good — on this machine the v1→v2 bump took
// 2026-05-08 … 2026-05-28 with it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMetering } = require('../backend/metering');
const { createCodexMetering } = require('../backend/codex-metering');
const archiveUtil = require('../backend/usage-archive');

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const DAY = 24 * 60 * 60 * 1000;
const oldDay = dayKey(Date.now() - 40 * DAY);   // transcripts for this day are gone
const recentDay = dayKey(Date.now() - 2 * DAY); // still re-scannable

// ── 1. a schema bump keeps the days the rebuild cannot reach ─────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-archive-'));
  const projectsDir = path.join(root, 'projects');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // A state file written by an older schema, holding two days of history.
  fs.writeFileSync(path.join(stateDir, 'usage.json'), JSON.stringify({
    schemaVersion: 1,
    cursors: {},
    daily: {
      [oldDay]: { cost: 42.5, tokens: 5_000_000, msgs: 120 },
      [recentDay]: { cost: 7.25, tokens: 900_000, msgs: 30 },
    },
    byModelByDay: { [oldDay]: { 'claude-opus-4-1': { cost: 42.5, tokens: 5_000_000, msgs: 120 } } },
    hourlyByDay: {},
    // lifetime knows about a third day that had already been pruned away.
    lifetime: { cost: 100, tokens: 9_000_000, msgs: 200 },
  }));

  const meter = createMetering({ projectsDir, stateDir });
  meter.start(1e9); // load() + one scan; no transcripts exist to rebuild from
  const stats = meter.getStats();

  assert.ok(stats.daily[oldDay], 'a day whose transcripts are gone must survive the schema bump');
  assert.strictEqual(stats.daily[oldDay].cost, 42.5);
  assert.strictEqual(stats.daily[oldDay].tokens, 5_000_000);
  assert.strictEqual(stats.daily[recentDay].tokens, 900_000);
  assert.strictEqual(stats.diagnostics.migratedFrom, 1, 'the migration must still be reported');

  // lifetime = carried (9M - 5.9M retained = 3.1M) + merged retained (5.9M).
  assert.strictEqual(stats.lifetime.tokens, 9_000_000, 'lifetime must not shrink across a schema bump');
  assert.strictEqual(stats.lifetime.msgs, 200);
  meter.stop();

  // Reopening at the current schema must keep serving the archived day, and it
  // must not be double counted into lifetime on every load.
  const again = createMetering({ projectsDir, stateDir });
  again.start(1e9);
  const reopened = again.getStats();
  assert.strictEqual(reopened.daily[oldDay].tokens, 5_000_000, 'archive must persist across restarts');
  assert.strictEqual(reopened.lifetime.tokens, 9_000_000, 'reload must not re-add archived history');
  again.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 2. a rebuilt day that recovers MORE than the archive wins ────────────────
{
  const archive = archiveUtil.buildArchive({
    schemaVersion: 1,
    daily: { [recentDay]: { cost: 1, tokens: 100, msgs: 2 } },
    lifetime: { cost: 1, tokens: 100, msgs: 2 },
  });
  const live = { [recentDay]: { cost: 9, tokens: 900, msgs: 20 } };
  const merged = archiveUtil.mergedDaily(live, archive);
  assert.strictEqual(merged[recentDay].tokens, 900, 'the richer (live) ledger must win');

  // …and the reverse: a partial rebuild must not shrink the day.
  const partial = { [recentDay]: { cost: 0.2, tokens: 20, msgs: 1 } };
  assert.strictEqual(
    archiveUtil.mergedDaily(partial, archive)[recentDay].tokens, 100,
    'a partial rebuild must not shrink an archived day',
  );
}

// ── 3. pruning a day moves it into the carry instead of losing it ────────────
{
  const archive = archiveUtil.buildArchive({
    schemaVersion: 1,
    daily: { '2000-01-01': { cost: 5, tokens: 500, msgs: 3 } },
    lifetime: { cost: 5, tokens: 500, msgs: 3 },
  });
  const pruned = archiveUtil.pruneArchive(archive, {}, '2020-01-01');
  assert.strictEqual(Object.keys(pruned.daily).length, 0, 'expired archived days are dropped from the calendar');
  assert.strictEqual(pruned.carried.tokens, 500, '…but their totals move into the carry');
  assert.strictEqual(archiveUtil.mergedLifetime({}, pruned, {}).tokens, 500);
}

// ── 4. the Codex ledger gets the same protection ─────────────────────────────
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-codex-archive-'));
  const sessionsDir = path.join(root, 'sessions');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'codex-usage.json'), JSON.stringify({
    schemaVersion: 2,
    files: {},
    daily: { [oldDay]: { tokens: 3_000_000, input: 2_900_000, output: 100_000, cachedInput: 0, reasoningOutput: 0, cacheWrite: 0, msgs: 44 } },
    hourlyByDay: {},
    byModelByDay: {},
    lifetime: { tokens: 3_000_000, input: 2_900_000, output: 100_000, cachedInput: 0, reasoningOutput: 0, cacheWrite: 0, msgs: 44 },
  }));

  const codex = createCodexMetering({ sessionsDir, stateDir });
  codex.start(1e9);
  await new Promise((r) => setTimeout(r, 60));
  const stats = codex.getStats();
  assert.strictEqual(stats.daily[oldDay].tokens, 3_000_000, 'Codex history must survive its schema bump too');
  assert.strictEqual(stats.lifetime.tokens, 3_000_000);
  assert.strictEqual(stats.diagnostics.migratedFrom, 2);
  codex.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('usage archive (upgrade-safe history) checks passed');
})();
