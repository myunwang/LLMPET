'use strict';

// Pricing unit test — per-model-id billing (the bug: every model that wasn't
// opus/sonnet/haiku, e.g. claude-fable-5, silently billed at the sonnet default;
// and opus generations were folded to one price). No network / no real files —
// drives extractModels + priceFor off an inline LiteLLM-shaped fixture.
// Run: node test/pricing.js

const assert = require('assert');
const { normModelName, priceFor, DEFAULT_PRICING } = require('../backend/metering');
const { _extractModels } = require('../backend/pricing-sync');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}
const per = (v) => v / 1e6; // USD per token from USD per Mtok

// LiteLLM-shaped fixture: anthropic-direct rows + a bedrock/region variant and a
// non-claude row that must be filtered out.
const TABLE = {
  'claude-fable-5': { litellm_provider: 'anthropic', input_cost_per_token: per(10), output_cost_per_token: per(50), cache_creation_input_token_cost: per(12.5), cache_read_input_token_cost: per(1) },
  'claude-opus-4-8': { litellm_provider: 'anthropic', input_cost_per_token: per(5), output_cost_per_token: per(25) },
  'claude-opus-4-1': { litellm_provider: 'anthropic', input_cost_per_token: per(15), output_cost_per_token: per(75) },
  'claude-opus-4-5-20251101': { litellm_provider: 'anthropic', input_cost_per_token: per(5), output_cost_per_token: per(25) },
  'us.anthropic.claude-fable-5': { litellm_provider: 'bedrock_converse', input_cost_per_token: per(11), output_cost_per_token: per(55) },
  'gpt-4o': { litellm_provider: 'openai', input_cost_per_token: per(2.5), output_cost_per_token: per(10) },
};

console.log('[P1] normModelName 规范化');
check('裸名不变', () => assert.strictEqual(normModelName('claude-fable-5'), 'claude-fable-5'));
check('去 provider/区域前缀', () => assert.strictEqual(normModelName('us.anthropic.claude-opus-4-8'), 'claude-opus-4-8'));
check('去 8 位日期后缀', () => assert.strictEqual(normModelName('claude-opus-4-5-20251101'), 'claude-opus-4-5'));
check('去版本后缀 -v1:0', () => assert.strictEqual(normModelName('claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5'));
check('空/异常输入不崩', () => { assert.strictEqual(normModelName(''), ''); assert.strictEqual(normModelName(null), ''); });

console.log('[P2] extractModels：只取 anthropic 直连，按裸名');
const models = _extractModels(TABLE);
check('fable-5 精确价 10/50', () => assert(models['claude-fable-5'].input === 10 && models['claude-fable-5'].output === 50));
check('cache 价缺失 → 1.25x / 0.1x 标准比例兜底', () => { const m = models['claude-opus-4-8']; assert.strictEqual(m.cacheWrite, 6.25); assert.strictEqual(m.cacheRead, 0.5); });
check('opus 各代区分（4-1=15，4-8=5）', () => assert(models['claude-opus-4-1'].input === 15 && models['claude-opus-4-8'].input === 5));
check('带日期变体折叠到裸名', () => assert(models['claude-opus-4-5'] && models['claude-opus-4-5'].input === 5));
check('区域/bedrock 变体被跳过（fable 仍是直连 10）', () => assert.strictEqual(models['claude-fable-5'].input, 10));
check('非 claude 模型被跳过', () => assert(!Object.keys(models).some((k) => k.includes('gpt'))));

console.log('[P3] priceFor：精确 id → 家族关键词 → default');
const pricing = { ...JSON.parse(JSON.stringify(DEFAULT_PRICING)), _models: models };
check('fable-5 走精确 10/50（不再落 sonnet 3/15）', () => { const p = priceFor(pricing, 'claude-fable-5'); assert(p.input === 10 && p.output === 50); });
check('opus-4-1 与 opus-4-8 不同价', () => assert(priceFor(pricing, 'claude-opus-4-1').input === 15 && priceFor(pricing, 'claude-opus-4-8').input === 5));
check('未同步 → fable 家族兜底（仍 10，非 sonnet）', () => { const p2 = { ...JSON.parse(JSON.stringify(DEFAULT_PRICING)), _models: {} }; assert.strictEqual(priceFor(p2, 'claude-fable-5').input, 10); });
check('完全未知模型 → default', () => { const p2 = { ...JSON.parse(JSON.stringify(DEFAULT_PRICING)), _models: {} }; assert.strictEqual(priceFor(p2, 'totally-unknown'), p2.default); });
check('无 _models 字段也不崩', () => assert(priceFor(DEFAULT_PRICING, 'claude-opus-4-8')));

console.log(failures === 0 ? '\n✅ PRICING ALL PASS' : '\n❌ ' + failures + ' FAILURE(S)');
process.exit(failures ? 1 : 0);
