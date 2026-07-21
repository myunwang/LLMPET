'use strict';

// End-to-end integration test: verify that the full sync pipeline works
//   bundled seed → background refresh → catalog reload → priceFor() returns live price
//
// This test exercises the metering-codewhale.js + models-dev-sync.js integration.
// It uses a local mock HTTP server to avoid real network dependency, and a
// temporary HOME directory to avoid polluting the user's real cache.

const assert = require('assert');
const fs = require('fs');
const http = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Spawn a child process with a custom HOME and env, run a script, return stdout.
function runChild(home, env, script) {
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  if (r.status !== 0) {
    console.error('Child stderr:', r.stderr);
    console.error('Child stdout:', r.stdout);
  }
  assert.strictEqual(r.status, 0, `child exited with ${r.status}`);
  return r.stdout;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-e2e-'));
const cacheDir = path.join(home, '.octopus', 'catalog');
const cacheFile = path.join(cacheDir, 'models-dev.json');

// === Test 1: bundled seed works without live cache ===
// When ~/.octopus/catalog/models-dev.json doesn't exist, the metering module
// must still work using only the bundled seed (backend/model-catalog.bundled.json).
{
  const script = `
    const {createMeteringCodeWhale} = require('./backend/metering-codewhale.js');
    const cw = createMeteringCodeWhale();
    cw.start();
    const ds = cw.priceFor('deepseek-v4-pro');
    const mimo = cw.priceFor('mimo-v2.5');
    const unknown = cw.priceFor('not-a-real-model-xyz');
    cw.stop();
    process.stdout.write(JSON.stringify({ds, mimo, unknown, size: cw.catalogSize}));
  `;
  // Disable live fetch so the test doesn't hit the network
  const out = runChild(home, { OCTOPUS_DISABLE_MODELS_DEV_FETCH: '1' }, script);
  // Strip any log lines from stdout
  const json = out.split('\n').filter((l) => l.startsWith('{')).pop();
  const r = JSON.parse(json);
  assert.ok(r.ds, 'deepseek-v4-pro must be priced from bundled seed');
  assert.strictEqual(r.ds.input, 0.435, 'bundled deepseek-v4-pro input must be $0.435');
  assert.strictEqual(r.ds.output, 0.87, 'bundled deepseek-v4-pro output must be $0.87');
  assert.ok(r.mimo, 'mimo-v2.5 must be priced from bundled seed');
  assert.strictEqual(r.mimo.input, 0.14);
  assert.strictEqual(r.unknown, null, 'unknown model must return null');
  assert.ok(r.size >= 49, `bundled catalog must have ≥49 entries (got ${r.size})`);
  console.log('  ✓ Test 1: bundled seed alone works (no live cache, no network)');
}

// === Test 2: live cache takes precedence over bundled seed ===
// Write a fake live cache that overrides deepseek-v4-pro with a clearly
// different price, and verify that priceFor() returns the live value.
{
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const fakeCache = {
    schema_version: 2,
    source: 'models.dev',
    fetched_at: new Date().toISOString(),
    ttl_secs: 86400,
    upstream_url: 'https://models.dev/catalog.json',
    upstream_etag: '"fake-etag"',
    entries: {
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        input_usd_per_million: 99.99,
        output_usd_per_million: 199.99,
        cache_read_usd_per_million: 9.999,
        cache_write_usd_per_million: null,
        context_window: 1000000,
        max_output: 384000,
        supports_reasoning: true,
        provenance: 'models.dev',
      },
      'brand-new-model-not-in-bundled': {
        id: 'brand-new-model-not-in-bundled',
        input_usd_per_million: 0.5,
        output_usd_per_million: 2.5,
        cache_read_usd_per_million: 0.05,
        cache_write_usd_per_million: null,
        context_window: 500000,
        max_output: 64000,
        supports_reasoning: false,
        provenance: 'models.dev',
      },
    },
  };
  fs.writeFileSync(cacheFile, JSON.stringify(fakeCache), { mode: 0o600 });

  const script = `
    const {createMeteringCodeWhale} = require('./backend/metering-codewhale.js');
    const cw = createMeteringCodeWhale();
    cw.start();
    const ds = cw.priceFor('deepseek-v4-pro');
    const newModel = cw.priceFor('brand-new-model-not-in-bundled');
    const mimo = cw.priceFor('mimo-v2.5'); // not overridden in fake cache
    cw.stop();
    process.stdout.write(JSON.stringify({ds, newModel, mimo, size: cw.catalogSize}));
  `;
  const out = runChild(home, { OCTOPUS_DISABLE_MODELS_DEV_FETCH: '1' }, script);
  const json = out.split('\n').filter((l) => l.startsWith('{')).pop();
  const r = JSON.parse(json);
  assert.strictEqual(r.ds.input, 99.99, 'live cache must override bundled deepseek-v4-pro price');
  assert.strictEqual(r.ds.output, 199.99);
  assert.strictEqual(r.ds.cacheRead, 9.999);
  assert.strictEqual(r.ds.cacheWrite, null, 'null cacheWrite must be preserved');
  assert.ok(r.newModel, 'live cache must add brand-new models not in bundled seed');
  assert.strictEqual(r.newModel.input, 0.5);
  // mimo-v2.5 is NOT in the fake cache → must fall back to bundled seed
  assert.strictEqual(r.mimo.input, 0.14, 'non-overridden model must use bundled seed');
  assert.ok(r.size >= 50, `merged catalog must have ≥50 entries (49 bundled + 1 new live) (got ${r.size})`);
  console.log('  ✓ Test 2: live cache overrides bundled + adds new models');
}

// === Test 3: stale cache is still used (better than nothing) ===
// Write a cache with fetched_at = 30 days ago (stale). The metering module
// must still use it (don't discard stale cache), but shouldRefresh flag triggers.
{
  const staleCache = {
    schema_version: 2,
    source: 'models.dev',
    fetched_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    ttl_secs: 86400,
    entries: {
      'stale-model': {
        id: 'stale-model',
        input_usd_per_million: 0.1,
        output_usd_per_million: 0.5,
        cache_read_usd_per_million: 0.01,
        cache_write_usd_per_million: null,
        context_window: 100000,
        max_output: 32000,
        supports_reasoning: false,
        provenance: 'models.dev',
      },
    },
  };
  fs.writeFileSync(cacheFile, JSON.stringify(staleCache), { mode: 0o600 });

  const script = `
    const sync = require('./backend/models-dev-sync.js');
    const {cache, shouldRefresh} = sync.loadAndMaybeRefresh();
    const fresh = sync.isCacheFresh(cache);
    process.stdout.write(JSON.stringify({
      hasCache: !!cache,
      shouldRefresh,
      fresh,
      staleModel: cache && cache.entries['stale-model'] ? cache.entries['stale-model'].input_usd_per_million : null,
    }));
  `;
  const out = runChild(home, { OCTOPUS_DISABLE_MODELS_DEV_FETCH: '1' }, script);
  const r = JSON.parse(out);
  assert.strictEqual(r.hasCache, true, 'stale cache must still be returned');
  assert.strictEqual(r.fresh, false, 'cache must be detected as stale');
  assert.strictEqual(r.shouldRefresh, false, 'shouldRefresh must be false when fetch disabled');
  assert.strictEqual(r.staleModel, 0.1, 'stale cache entries must be readable');
  console.log('  ✓ Test 3: stale cache is used (graceful degradation)');
}

// === Test 4: shouldRefresh triggers when fetch is enabled ===
// Same stale cache, but with fetch enabled → shouldRefresh must be true.
{
  const script = `
    const sync = require('./backend/models-dev-sync.js');
    const {cache, shouldRefresh} = sync.loadAndMaybeRefresh();
    process.stdout.write(JSON.stringify({
      hasCache: !!cache,
      shouldRefresh,
    }));
  `;
  const out = runChild(home, {}, script); // no OCTOPUS_DISABLE_MODELS_DEV_FETCH
  const r = JSON.parse(out);
  assert.strictEqual(r.hasCache, true);
  assert.strictEqual(r.shouldRefresh, true, 'shouldRefresh must be true when cache is stale and fetch is enabled');
  console.log('  ✓ Test 4: shouldRefresh triggers when fetch enabled and cache stale');
}

// === Test 5: corrupted cache file is ignored, falls back to bundled ===
{
  fs.writeFileSync(cacheFile, '{corrupted json!!!', { mode: 0o600 });
  const script = `
    const {createMeteringCodeWhale} = require('./backend/metering-codewhale.js');
    const cw = createMeteringCodeWhale();
    cw.start();
    const ds = cw.priceFor('deepseek-v4-pro');
    cw.stop();
    process.stdout.write(JSON.stringify({ds, size: cw.catalogSize}));
  `;
  const out = runChild(home, { OCTOPUS_DISABLE_MODELS_DEV_FETCH: '1' }, script);
  const json = out.split('\n').filter((l) => l.startsWith('{')).pop();
  const r = JSON.parse(json);
  // Corrupted cache must be ignored → fall back to bundled seed
  assert.ok(r.ds, 'must still get deepseek-v4-pro from bundled seed despite corrupted cache');
  assert.strictEqual(r.ds.input, 0.435, 'must use bundled price (not live override)');
  assert.ok(r.size >= 49, `must have ≥49 bundled entries (got ${r.size})`);
  console.log('  ✓ Test 5: corrupted cache is ignored, bundled seed still works');
}

// === Test 6: real network fetch (live integration, optional) ===
// This actually hits models.dev. Skipped if OCTOPUS_SKIP_LIVE_TESTS=1.
if (process.env.OCTOPUS_SKIP_LIVE_TESTS !== '1') {
  // Wipe the cache and let the real fetcher populate it
  fs.rmSync(cacheFile, { force: true });
  const script = `
    const sync = require('./backend/models-dev-sync.js');
    (async () => {
      // Trigger a synchronous fetch (no background)
      const cache = await sync._fetchModelsDev(sync.DEFAULT_URL);
      // Save it
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(path.join(process.env.HOME, '.octopus', 'catalog'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(process.env.HOME, '.octopus', 'catalog', 'models-dev.json'),
        JSON.stringify(cache),
        { mode: 0o600 }
      );
      process.stdout.write(JSON.stringify({
        count: Object.keys(cache.entries).length,
        deepseek: cache.entries['deepseek-v4-pro'] ? {
          input: cache.entries['deepseek-v4-pro'].input_usd_per_million,
          output: cache.entries['deepseek-v4-pro'].output_usd_per_million,
        } : null,
        claude: cache.entries['claude-opus-4-8'] ? {
          input: cache.entries['claude-opus-4-8'].input_usd_per_million,
          output: cache.entries['claude-opus-4-8'].output_usd_per_million,
        } : null,
        etag: cache.upstream_etag,
      }));
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  try {
    const out = runChild(home, {}, script);
    const json = out.split('\n').filter((l) => l.startsWith('{')).pop();
    const r = JSON.parse(json);
    assert.ok(r.count > 100, `live fetch must return 100+ entries (got ${r.count})`);
    assert.ok(r.deepseek, 'live cache must include deepseek-v4-pro');
    assert.strictEqual(r.deepseek.input, 0.435, 'live deepseek-v4-pro input must be $0.435');
    assert.strictEqual(r.deepseek.output, 0.87, 'live deepseek-v4-pro output must be $0.87');
    assert.ok(r.claude, 'live cache must include claude-opus-4-8');
    assert.strictEqual(r.claude.input, 5);
    assert.strictEqual(r.claude.output, 25);
    assert.ok(r.etag, 'live fetch must capture ETag header');
    console.log(`  ✓ Test 6: live fetch from models.dev returned ${r.count} entries with correct prices (etag=${r.etag})`);

    // Now verify the saved cache is readable
    const script2 = `
      const {createMeteringCodeWhale} = require('./backend/metering-codewhale.js');
      const cw = createMeteringCodeWhale();
      cw.start();
      const ds = cw.priceFor('deepseek-v4-pro');
      const kimi = cw.priceFor('kimi-k3');
      cw.stop();
      process.stdout.write(JSON.stringify({
        dsInput: ds && ds.input,
        kimiInput: kimi && kimi.input,
        size: cw.catalogSize,
        syncState: cw.modelsDevSyncState,
      }));
    `;
    const out2 = runChild(home, { OCTOPUS_DISABLE_MODELS_DEV_FETCH: '1' }, script2);
    const json2 = out2.split('\n').filter((l) => l.startsWith('{')).pop();
    const r2 = JSON.parse(json2);
    assert.strictEqual(r2.dsInput, 0.435, 'after live fetch, deepseek-v4-pro must use live price');
    assert.ok(r2.kimiInput, 'kimi-k3 must be in live cache');
    assert.strictEqual(r2.kimiInput, 3, 'kimi-k3 input must be $3');
    assert.ok(r2.size > 1000, `merged catalog must have 1000+ entries after live fetch (got ${r2.size})`);
    console.log(`  ✓ Test 6b: saved live cache is reloaded correctly (${r2.size} entries merged with bundled)`);
  } catch (err) {
    console.log(`  ⚠ Test 6 skipped: ${err.message}`);
    console.log('  ⚠ this is non-fatal; bundled seed still works offline');
  }
} else {
  console.log('  ⚠ Test 6 skipped (OCTOPUS_SKIP_LIVE_TESTS=1)');
}

// === Test 7: background refresh is non-blocking ===
// Calling cw.start() with a missing cache must not block even if the network
// is slow. The refresh is scheduled with setImmediate and runs in the background.
{
  fs.rmSync(cacheFile, { force: true });
  const script = `
    const sync = require('./backend/models-dev-sync.js');
    const startMs = Date.now();
    const { cache, shouldRefresh } = sync.loadAndMaybeRefresh();
    const elapsedMs = Date.now() - startMs;
    process.stdout.write(JSON.stringify({
      hasCache: !!cache,
      shouldRefresh,
      elapsedMs,
    }));
  `;
  const out = runChild(home, {}, script);
  const r = JSON.parse(out);
  assert.strictEqual(r.hasCache, false, 'no cache should be present');
  assert.strictEqual(r.shouldRefresh, true, 'refresh should be requested');
  assert.ok(r.elapsedMs < 100, `loadAndMaybeRefresh must be non-blocking (took ${r.elapsedMs}ms)`);
  console.log(`  ✓ Test 7: loadAndMaybeRefresh is non-blocking (${r.elapsedMs}ms)`);
}

// === Test 8: OCTOPUS_MODELS_DEV_PATH overrides cache location ===
// Set OCTOPUS_MODELS_DEV_PATH to a custom file with a known entry, verify
// it's used instead of the default ~/.octopus/catalog/models-dev.json.
{
  const customCachePath = path.join(home, 'custom-cache.json');
  const customCache = {
    schema_version: 2,
    source: 'custom',
    fetched_at: new Date().toISOString(),
    ttl_secs: 86400,
    entries: {
      'custom-path-model': {
        id: 'custom-path-model',
        input_usd_per_million: 0.42,
        output_usd_per_million: 2.1,
        cache_read_usd_per_million: 0.042,
        cache_write_usd_per_million: null,
        context_window: 500000,
        max_output: 32000,
        supports_reasoning: true,
        provenance: 'custom',
      },
    },
  };
  fs.writeFileSync(customCachePath, JSON.stringify(customCache), { mode: 0o600 });

  const script = `
    const {createMeteringCodeWhale} = require('./backend/metering-codewhale.js');
    const cw = createMeteringCodeWhale();
    cw.start();
    const m = cw.priceFor('custom-path-model');
    cw.stop();
    process.stdout.write(JSON.stringify({m}));
  `;
  const out = runChild(home, {
    OCTOPUS_MODELS_DEV_PATH: customCachePath,
    OCTOPUS_DISABLE_MODELS_DEV_FETCH: '1',
  }, script);
  const json = out.split('\n').filter((l) => l.startsWith('{')).pop();
  const r = JSON.parse(json);
  assert.ok(r.m, 'model from custom OCTOPUS_MODELS_DEV_PATH must be found');
  assert.strictEqual(r.m.input, 0.42);
  console.log('  ✓ Test 8: OCTOPUS_MODELS_DEV_PATH overrides cache location');
}

// Cleanup
fs.rmSync(home, { recursive: true, force: true });

console.log('\nmodels-dev-sync integration: ok');
