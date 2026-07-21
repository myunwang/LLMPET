'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { dict, safeMapKey, cleanByModelMap, finiteNonNegative } = require('../backend/metering-state');
const { _readNewLinesBounded, _limits } = require('../backend/metering');
const { loadCatalog: loadCwCatalog, priceFor: cwPriceFor } = require('../backend/metering-codewhale');

assert.strictEqual(Object.getPrototypeOf(dict()), null);
assert.strictEqual(safeMapKey('__proto__', 'unknown'), 'unknown');
assert.strictEqual(safeMapKey('constructor', 'unknown'), 'unknown');
assert.strictEqual(finiteNonNegative(Infinity), 0);
assert.strictEqual(finiteNonNegative(1e99, 123), 123);
const clean = cleanByModelMap(JSON.parse('{"2026-07-20":{"__proto__":{"cost":99},"ok":{"cost":1}}}'));
assert.strictEqual(Object.getPrototypeOf(clean), null);
assert.strictEqual(Object.getPrototypeOf(clean['2026-07-20']), null);
assert.strictEqual(Object.prototype.hasOwnProperty.call(clean['2026-07-20'], '__proto__'), false);
assert.strictEqual(clean['2026-07-20'].ok.cost, 1);
assert.strictEqual({}.cost, undefined);

// Oversized JSONL records must be skipped with fixed memory and without
// permanently stalling the cursor; a normal record after them is still read.
async function testBoundedTailRead() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-meter-tail-'));
  const file = path.join(dir, 'huge.jsonl');
  const valid = JSON.stringify({ type: 'assistant', message: { id: 'ok' } });
  fs.writeFileSync(file, Buffer.concat([
    Buffer.alloc(_limits.READ_CHUNK_BYTES + 1024, 0x78),
    Buffer.from(`\n${valid}\n`),
  ]));
  const size = fs.statSync(file).size;
  const first = await _readNewLinesBounded(file, 0, size);
  assert.strictEqual(first.lines.length, 0);
  assert(first.bytesRead <= _limits.READ_CHUNK_BYTES);
  assert.strictEqual(first.newOffset, _limits.READ_CHUNK_BYTES);
  const second = await _readNewLinesBounded(file, first.newOffset, size);
  assert.deepStrictEqual(second.lines, [valid]);
  assert.strictEqual(second.newOffset, size);
  fs.rmSync(dir, { recursive: true, force: true });
}

const root = path.resolve(__dirname, '..');
(async () => {
await testBoundedTailRead();

// A provider_model_id alias without a valid base price must not create an
// `undefined` exact-match entry that bypasses the conservative fallback.
// Since catalog v2 (2026-07-20), unknown models honestly return null instead
// of fabricating a $1/$5 estimate — see metering-codewhale.js loadCatalog comment.
const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-catalog-sec-'));
const catalogFile = path.join(catalogDir, 'catalog.json');
// 'ghost' entry has a provider_model_id alias but no price fields at all;
// loadCatalog must skip it entirely so priceFor('ghost') returns null.
fs.writeFileSync(catalogFile, JSON.stringify({ entries: { ghost: { provider_model_id: 'provider/ghost' } } }));
const ghostCatalog = loadCwCatalog(catalogFile);
// Ghost has no price fields → entry skipped → priceFor returns null.
assert.strictEqual(ghostCatalog.has('ghost'), false);
assert.strictEqual(cwPriceFor(ghostCatalog, 'ghost'), null);
assert.strictEqual(cwPriceFor(ghostCatalog, 'provider/ghost'), null);
assert.strictEqual(cwPriceFor(ghostCatalog, 'unknown-model-xyz'), null);
fs.rmSync(catalogDir, { recursive: true, force: true });

// Catalog v2 sanity: real CodeWhale bundled catalog must price deepseek-v4-pro
// at the verified vendor rate ($0.435/$0.87 per DeepSeek's official pricing page
// https://api-docs.deepseek.com/quick_start/pricing, cross-checked against
// models.dev catalog 2026-07-20) and carry vendor-specific cache rates.
const realCatalog = loadCwCatalog();
const ds = cwPriceFor(realCatalog, 'deepseek-v4-pro');
assert.strictEqual(ds.input, 0.435);
assert.strictEqual(ds.output, 0.87);
assert.strictEqual(ds.cacheRead, 0.003625); // vendor-published, not 10% heuristic
assert.strictEqual(ds.cacheWrite, null); // DeepSeek doesn't publish cache_write
// Xiaomi MiMo cache_read is 2% of input (vendor-published), not the 10% heuristic.
const mimo = cwPriceFor(realCatalog, 'mimo-v2.5');
assert.strictEqual(mimo.input, 0.14);
assert.strictEqual(mimo.cacheRead, 0.0028);
// Unknown model has no entry at all → null (token-only).
assert.strictEqual(cwPriceFor(realCatalog, 'not-a-real-model-xyz'), null);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-meter-sec-'));
const childCode = `
const fs=require('fs'), path=require('path');
const home=process.env.HOME;
const project=path.join(home,'.claude','projects','p'); fs.mkdirSync(project,{recursive:true});
const transcript=path.join(project,'s.jsonl');
fs.writeFileSync(transcript, JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),requestId:'r',message:{id:'m',model:'__proto__',usage:{input_tokens:1e308,output_tokens:4,cache_creation_input_tokens:0,cache_read_input_tokens:0}}})+'\\n');
const {createMetering}=require(${JSON.stringify(path.join(root, 'backend', 'metering.js'))});
const {createMeteringCodeWhale}=require(${JSON.stringify(path.join(root, 'backend', 'metering-codewhale.js'))});
(async()=>{
  const m=createMetering(); await m.scan(); const claude=m.getStats(); m.stop();
  const cw=createMeteringCodeWhale(); cw.start(); cw.recordTurnEnd({model:'constructor',turn_duration_ms:0,turn_usage:{input:1e308,output:2,cache_read:0,cache_create:0,cache_write:0}}); const whale=cw.getStats(); cw.stop();
  const usage=path.join(home,'.octopus','usage.json'); const usageCw=path.join(home,'.octopus','usage-codewhale.json');
  process.stdout.write(JSON.stringify({claude,whale,modes:[fs.statSync(usage).mode&0o777,fs.statSync(usageCw).mode&0o777],polluted:{}.cost}));
})().catch(e=>{console.error(e);process.exit(1)});
`;
const child = spawnSync(process.execPath, ['-e', childCode], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, HOME: home, USERPROFILE: home, OCTOPUS_DISABLE_MODELS_DEV_FETCH: '1' },
  maxBuffer: 4 * 1024 * 1024,
});
assert.strictEqual(child.status, 0, child.stderr);
const result = JSON.parse(child.stdout);
assert.strictEqual(result.polluted, undefined);
assert(result.claude.byModel.unknown, 'unsafe Claude model key was not normalized');
assert(result.whale.byModel.unknown, 'unsafe CodeWhale model key was not normalized');
assert(Number.isFinite(result.claude.today.cost));
assert(Number.isFinite(result.whale.today.cost));
if (process.platform !== 'win32') assert.deepStrictEqual(result.modes, [0o600, 0o600]);
fs.rmSync(home, { recursive: true, force: true });
console.log('metering-security: ok');
})().catch((err) => { console.error(err); process.exit(1); });
