'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { sanitize } = require('../backend/config');
const { loadRenderer } = require('./dom-stub');
const { createCodexRateLimits } = require('../backend/codex-rate-limits');
const {
  normalizeAppServerRateLimits,
  weeklyRemainingPercent,
} = require('../shared/codex-rate-limits');

const normalized = normalizeAppServerRateLimits({
  rateLimitsByLimitId: {
    codex: {
      primary: { usedPercent: 21.4, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: 37.6, windowDurationMins: 10080, resetsAt: 200 },
      planType: 'plus',
    },
  },
}, 1234);
assert.deepStrictEqual(normalized, {
  ts: 1234,
  source: 'app-server',
  usedPercent: 21.4,
  windowMinutes: 300,
  resetsAt: 100000,
  secondaryUsedPercent: 37.6,
  secondaryWindowMinutes: 10080,
  secondaryResetsAt: 200000,
  planType: 'plus',
});
assert.strictEqual(weeklyRemainingPercent(normalized), 62);
assert.strictEqual(weeklyRemainingPercent({ usedPercent: 44, windowMinutes: 10080 }), 56);
assert.strictEqual(weeklyRemainingPercent({ usedPercent: 44, windowMinutes: 300 }), null);
assert.strictEqual(weeklyRemainingPercent({ secondaryUsedPercent: -5 }), 100);
assert.strictEqual(weeklyRemainingPercent({ secondaryUsedPercent: 105 }), 0);
assert.strictEqual(weeklyRemainingPercent(null), null);

assert.strictEqual(sanitize({ codexChipMode: 'weeklyRemaining' }).codexChipMode, 'weeklyRemaining');
assert.strictEqual(sanitize({ codexChipMode: 'invalid' }).codexChipMode, 'usage');
assert.strictEqual(sanitize({ codexTagMode: 'weeklyRemaining' }).codexChipMode, 'weeklyRemaining');

const renderer = loadRenderer([
  'shared/i18n.js',
  'shared/states.js',
  'shared/codex-rate-limits.js',
  'renderer/icons.js',
  'renderer/pet.js',
], { search: '?agent=codex' });
renderer.handlers.config({ skin: 'cat', muted: true, lang: 'zh', codexChipMode: 'weeklyRemaining' });
renderer.handlers.stats({
  today: { cost: 0 }, window5h: { cost: 0 }, codexUsage: { today: { tokens: 1234 } },
  codexLimits: { usedPercent: 45, windowMinutes: 10080 }, sessions: [], bg: { zombie: 0 },
  waitingCount: 0, needsinputCount: 0, workingCount: 0, jugglingCount: 0,
  sweepingCount: 0, thinkingCount: 0, loafingCount: 0, errorCount: 0, idleMs: 1000,
});
assert(renderer.elements('agent-tag').innerHTML.includes('Codex'), 'blue agent tag must keep the Codex name');
assert(!renderer.elements('agent-tag').innerHTML.includes('Weekly'), 'weekly text must not replace the blue agent tag');
assert.strictEqual(renderer.elements('chip-cost').textContent, 'Weekly 剩余 55%');
assert.strictEqual(renderer.elements('chip-sep').style.display, 'none');
assert.strictEqual(renderer.elements('chip-window').style.display, 'none');
renderer.handlers.config({ skin: 'cat', muted: true, lang: 'zh', codexChipMode: 'usage' });
assert.strictEqual(renderer.elements('chip-sep').style.display, '');
assert.strictEqual(renderer.elements('chip-window').style.display, '');

async function integrationCheck() {
  const writes = [];
  let fake;
  const spawnImpl = () => {
    fake = new EventEmitter();
    fake.stdout = new PassThrough();
    fake.stderr = new PassThrough();
    fake.stdin = {
      destroyed: false,
      writable: true,
      write(line) {
        const message = JSON.parse(line);
        writes.push(message);
        if (message.method === 'initialize') {
          setImmediate(() => fake.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n'));
        } else if (message.method === 'account/rateLimits/read') {
          setImmediate(() => fake.stdout.write(JSON.stringify({
            id: message.id,
            result: {
              rateLimits: {
                primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 100 },
                secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 200 },
              },
            },
          }) + '\n'));
        }
        return true;
      },
    };
    fake.kill = () => { fake.emit('close', 0); return true; };
    setImmediate(() => fake.emit('spawn'));
    return fake;
  };

  let client;
  const limits = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('fake App Server response timed out')), 1000);
    client = createCodexRateLimits({
      spawnImpl,
      findCliImpl: () => 'codex-test',
      pollMs: 60 * 1000,
      requestTimeoutMs: 500,
      onRateLimits(value) { clearTimeout(timeout); resolve(value); },
    });
    client.start();
  });
  client.stop();
  assert.strictEqual(limits.secondaryUsedPercent, 25);
  assert.deepStrictEqual(writes.map((message) => message.method), [
    'initialize', 'initialized', 'account/rateLimits/read',
  ]);

  const root = path.join(__dirname, '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  assert(read('main.js').includes("createCodexRateLimits"));
  assert(read('renderer/pet.html').includes('shared/codex-rate-limits.js'));
  assert(read('renderer/pet.js').includes("codexChipMode === 'weeklyRemaining'"));
  console.log('Codex rate-limit checks passed');
  process.exit(0);
}

integrationCheck().catch((error) => {
  console.error(error);
  process.exit(1);
});
