'use strict';
// R12-拓展: verify providerCost field in buildPetStats output.
const { buildPetStats } = require('../backend/adapter');

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ ' + msg); } }

// Minimal snapshot with one idle session.
const snapshot = {
  sessions: [{
    id: 's1', pid: 123, cwd: '/Users/me/proj', state: 'idle',
    idleMs: 60000, headless: false, project: 'proj',
    provider: 'claude', lastEvent: null, contextUsage: {},
  }],
  lastActivityTs: Date.now(), idleMs: 60000, ts: Date.now(),
};

// Test 1: no metering at all → providerCost is empty object
{
  const stats = buildPetStats(snapshot, [], null, {});
  assert(stats.providerCost !== undefined, 'providerCost field exists');
  assert(typeof stats.providerCost === 'object', 'providerCost is an object');
  assert(Object.keys(stats.providerCost).length === 0, 'empty when no metering');
}

// Test 2: meterByProvider with claude data
{
  const meterByProvider = {
    claude: { today: { cost: 1.5, tokens: 50000, msgs: 10, input: 30000, output: 20000 } },
  };
  const stats = buildPetStats(snapshot, [], null, { meterByProvider });
  assert(stats.providerCost.claude !== undefined, 'claude entry exists');
  assert(stats.providerCost.claude.cost === 1.5, 'claude cost = 1.5');
  assert(stats.providerCost.claude.tokens === 50000, 'claude tokens = 50000');
  assert(stats.providerCost.claude.messages === 10, 'claude messages = 10');
}

// Test 3: meterByProvider with both providers + matching merged metering
{
  const meterByProvider = {
    claude: { today: { cost: 2.0, tokens: 80000, msgs: 15 } },
    codewhale: { today: { cost: 0.5, tokens: 20000, msgs: 5 } },
  };
  // In production, main.js pre-merges metering via mergeMetering().
  const mergedMetering = { today: { cost: 2.5, tokens: 100000, msgs: 20 } };
  const stats = buildPetStats(snapshot, [], mergedMetering, { meterByProvider });
  assert(stats.providerCost.claude.cost === 2.0, 'claude cost correct');
  assert(stats.providerCost.codewhale.cost === 0.5, 'codewhale cost correct');
  assert(stats.providerCost.codewhale.tokens === 20000, 'codewhale tokens correct');
  // The merged today should be the sum
  assert(stats.today.cost === 2.5, 'merged today cost = 2.5');
}

// Test 4: msgs → messages normalization
{
  const meterByProvider = {
    claude: { today: { cost: 1.0, tokens: 1000, msgs: 3 } },
    codewhale: { today: { cost: 0.5, tokens: 500, messages: 2 } },
  };
  const stats = buildPetStats(snapshot, [], null, { meterByProvider });
  assert(stats.providerCost.claude.messages === 3, 'msgs normalized to messages for claude');
  assert(stats.providerCost.codewhale.messages === 2, 'messages kept for codewhale');
}

// Test 5: zero-cost provider still included
{
  const meterByProvider = {
    claude: { today: { cost: 0, tokens: 0, msgs: 0 } },
    codewhale: { today: { cost: 1.0, tokens: 5000, msgs: 2 } },
  };
  const stats = buildPetStats(snapshot, [], null, { meterByProvider });
  assert(stats.providerCost.claude !== undefined, 'zero-cost claude still present in providerCost');
}

// Test 6: existing stats fields unaffected
{
  const meterByProvider = {
    claude: { today: { cost: 0.3, tokens: 1000, msgs: 1 } },
  };
  const mergedMetering = { today: { cost: 0.3, tokens: 1000, msgs: 1 } };
  const stats = buildPetStats(snapshot, [], mergedMetering, { meterByProvider, lastOps: [{ ts: 123 }] });
  assert(stats.lastOps.length === 1, 'lastOps unaffected');
  assert(stats.today.cost === 0.3, 'today cost from provider');
}

console.log(failed ? `\n✗ ${failed} FAILED` : `\n✅ ALL PASS — ${passed} passed, 0 failed`);
process.exit(failed ? 1 : 0);