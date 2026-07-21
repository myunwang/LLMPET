'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tests = [
  'test/syntax.js',
  'test/smoke.js',
  'test/state-smoke.js',
  'test/pricing.js',
  'test/territory.js',
  'test/adaptive-polling.js',
  'test/lazy-provider.js',
  'test/provider-cost-panel.js',
  'test/provider-validate.js',
  'test/renderer-cleanup.js',
  'test/toml-roundtrip.js',
  'test/server-security.js',
  'test/deep-security.js',
  'test/metering-security.js',
  'test/models-dev-sync.js',
  'test/models-dev-sync-integration.js',
  'test/repository-consistency.js',
  'test/codewhale-permission-security.js',
  'test/codewhale-hook-security.js',
  'test/codewhale-provider-security.js',
];

for (const file of tests) {
  process.stdout.write(`\n=== ${file} ===\n`);
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
  assert.strictEqual(r.status, 0, `${file} failed with status ${r.status}`);
}
console.log(`\ncore suite: ok (${tests.length} files)`);
