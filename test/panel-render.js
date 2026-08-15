'use strict';

// Drives the REAL renderer/panel.js against a combined Claude + Codex payload,
// so the panel's own formatting is covered — not just the numbers behind it.
// Before this, the headline read Claude-only while Codex sat priceless in its
// own block, and nothing caught the mismatch.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createStubWorld } = require('./dom-stub');
const { combineUsage } = require('../backend/adapter');

const claude = {
  today: { cost: 41.256, tokens: 67_800_000, msgs: 197, input: 10_242, output: 57_662, cacheWrite5m: 0, cacheWrite1h: 199_974, cacheRead: 67_500_000 },
  window5h: { cost: 52.721, tokens: 80_000_000, startTs: Date.now() - 3.6e6, resetTs: Date.now() + 1.4e7 },
  byModel: { 'claude-opus-5': { cost: 41.256, tokens: 67_800_000, msgs: 197, input: 10_242, output: 57_662, cacheWrite5m: 0, cacheWrite1h: 199_974, cacheRead: 67_500_000 } },
  hourly: new Array(24).fill(0),
  hourlyTok: new Array(24).fill(0),
  daily: {},
  lifetime: { cost: 8392.98, tokens: 7_520_000_000, msgs: 20_000 },
  diagnostics: { lastScanTs: Date.now(), scannedFiles: 420, records: 17_135, streamingCorrections: 18, estimatedModelCount: 0, pricing: { live: true, stale: false } },
};
const codex = {
  today: { cost: 20.068, tokens: 23_000_000, msgs: 152, input: 22_000_000, output: 120_000, cachedInput: 20_000_000, reasoningOutput: 30_000 },
  window5h: { cost: 36.799, tokens: 40_000_000, startTs: Date.now() - 4.0e6, resetTs: Date.now() + 1.3e7 },
  byModel: {
    'gpt-5.6-sol': { cost: 18.991, tokens: 21_500_000, msgs: 136, input: 20_600_000, output: 110_000, cachedInput: 19_000_000, reasoningOutput: 28_000, unitPrice: { input: 5, cachedInput: 0.5, output: 30 }, priceExact: true },
    // guardian / auto-review threads: a Codex-internal profile with no public
    // price, billed at the tier fallback and reported as an estimate.
    'codex-auto-review': { cost: 1.077, tokens: 1_500_000, msgs: 16, input: 1_400_000, output: 10_000, cachedInput: 1_000_000, reasoningOutput: 2_000 },
  },
  hourly: new Array(24).fill(0),
  hourlyTok: new Array(24).fill(0),
  daily: {},
  lifetime: { cost: 1390.25, tokens: 2_200_000_000, msgs: 22_578 },
  diagnostics: { sessions: 109, events: 22_578, estimatedModelCount: 2 },
};

const usage = combineUsage(claude, codex, 'all');
const stats = {
  ...usage,
  messages: 0,
  active: { project: 'LLMPET', model: 'claude-opus-5' },
  sessions: [
    { project: 'LLMPET', agent: 'claude', state: 'working', op: '编辑文件', sessionId: '374a5c05-c2f4-45ed-ac56-cec5f412b39d', badge: null },
    { project: 'whale', agent: 'codex', state: 'thinking', sessionId: '019fc6b1-fd00-7a21-9c33-2b7e51aa1f04', badge: null },
    // a session the backend could not identify must still render, without a chip
    { project: 'ghost', agent: 'claude', state: 'idle', sessionId: null, badge: null },
  ],
  todos: [], todosProject: '', lastOps: [],
  bg: { items: [] },
  codexUsage: codex,
  codexDiagnostics: codex.diagnostics,
  diagnostics: claude.diagnostics,
  codexLimits: null,
};

const world = createStubWorld();
world.sandbox.window.pet = {
  onPanelStats: () => {}, onPrice: () => {}, onConfig: () => {},
  getConfig: () => Promise.resolve({ mode: 'pet', skin: 'mascot' }),
  getStats: () => Promise.resolve(null),
  setPanelHeight: () => {}, closePanel: () => {},
  setMode: () => {}, setSkin: () => {},
};
world.sandbox.cancelAnimationFrame = () => {};
vm.createContext(world.sandbox);
for (const file of ['shared/i18n.js', 'renderer/panel.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), world.sandbox, { filename: file });
}
vm.runInContext('render(__stats)', Object.assign(world.sandbox, { __stats: stats }), { filename: 'drive' });

const text = (id) => world.elements(id).textContent;
const html = (id) => world.elements(id)._innerHTML;

// ── the headline is the whole machine ────────────────────────────────────────
assert.strictEqual(text('today-cost'), '$61.324', 'today must be Claude + Codex');
assert.ok(text('today-tokens').startsWith('90.80M tokens'), `got ${text('today-tokens')}`);
assert.ok(text('today-tokens').endsWith('349 轮'), `turns must sum too: ${text('today-tokens')}`);
assert.strictEqual(text('today-split'), 'Claude $41.26 · Codex $20.07', 'the split must be visible under the total');
assert.strictEqual(text('win-cost'), '$9783.230');
assert.strictEqual(text('win-split'), 'Claude $8392.98 · Codex $1390.25');

// ── the Claude-labelled token block stays Claude's own numbers ───────────────
assert.strictEqual(text('t-cr'), '67.50M', 'the 5m/1h cache rows are Claude semantics, not a blend');
assert.strictEqual(text('t-msg'), 197);

// ── Codex now shows money, with tokens demoted to the footnote ───────────────
assert.strictEqual(text('codex-today'), '$20.068', 'Codex must be priced, not just counted');
assert.strictEqual(text('codex-lifetime'), '$1390.25');
assert.ok(text('codex-today-detail').startsWith('23.00M tok · '), text('codex-today-detail'));
assert.ok(text('codex-lifetime-detail').includes('2 个模型按估算价'), text('codex-lifetime-detail'));

// ── both agents share the by-model list, each badged with its source ─────────
const byModel = html('by-model');
assert.ok(byModel.includes('>opus-5<'), 'Claude models listed');
assert.ok(byModel.includes('>gpt-5.6-sol<'), 'Codex models listed in the same table');
assert.ok(byModel.includes('>codex-auto-review<'), 'internal Codex profiles are listed, not hidden');
assert.ok(byModel.includes('$61.324'), 'the by-model total must match the headline');
assert.ok(byModel.includes('缓存输入'), 'Codex rows use the Codex breakdown template');
assert.ok(byModel.includes('1h写'), 'Claude rows keep the cache-TTL template');
assert.strictEqual((byModel.match(/m-agent/g) || []).length, 3, 'every model row carries an agent badge');
assert.strictEqual((byModel.match(/fill="#3b82f6"/g) || []).length, 2, 'both Codex rows badge as Codex');

// The product must not present the old fixed 5-hour window as a Codex limit.
{
  const markup = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'panel.html'), 'utf8');
  assert.ok(!markup.includes('id="codex-wrap"'), 'the Codex 5h quota card is removed');
  assert.ok(!markup.includes('id="budget-wrap"'), 'the 5h reference budget is removed');
  assert.ok(!markup.includes('5 小时'), 'the usage panel no longer labels a fixed 5-hour window');
}

// ── each session row carries a copyable session id ───────────────────────────
{
  const list = html('sess-list');
  assert.ok(list.includes('data-id="374a5c05-c2f4-45ed-ac56-cec5f412b39d"'), 'the full id is kept for copying');
  assert.ok(list.includes('>374a5c05<'), 'the chip shows a short prefix, not the full 36 chars');
  assert.ok(list.includes('data-id="019fc6b1-fd00-7a21-9c33-2b7e51aa1f04"'), 'Codex sessions get an id too');
  assert.ok(list.includes('>019fc6b1<'));
  assert.ok(list.includes('点击复制完整会话 id'), 'the tooltip explains the click');
  assert.strictEqual((list.match(/class="sess-id"/g) || []).length, 2, 'a session with no id renders no chip');
  assert.ok(list.includes('ghost'), '…but the row itself still renders');
}

// ── a single-agent pet never shows the other agent's money ───────────────────
{
  const codexOnly = combineUsage(claude, codex, 'codex');
  vm.runInContext('render(__solo)', Object.assign(world.sandbox, {
    __solo: { ...stats, ...codexOnly },
  }), { filename: 'drive-solo' });
  assert.strictEqual(text('today-cost'), '$20.068', 'a Codex pet must not be shown Claude spend');
  assert.strictEqual(text('today-split'), '', 'no split line when only one agent has usage');
}

// ── dsh has context usage but no attributable billing ledger ────────────────
{
  const dshOnly = combineUsage(claude, codex, 'dsh');
  vm.runInContext('render(__dsh)', Object.assign(world.sandbox, {
    __dsh: { ...stats, ...dshOnly, usageProvider: 'dsh' },
  }), { filename: 'drive-dsh' });
  assert.strictEqual(dshOnly.billingAvailable, false);
  assert.strictEqual(text('today-cost'), '—', 'DSH panel must not show combined provider cost');
  assert.strictEqual(text('win-cost'), '—');
  assert.strictEqual(text('today-split'), '');
  assert.strictEqual(text('win-split'), '');
  assert.strictEqual(text('t-cr'), '—', 'Claude token semantics are unavailable on DSH');
  assert.ok(world.elements('codex-usage').classList.contains('hidden'));
  assert.ok(!html('by-model').includes('$'), 'DSH must not inherit either provider model ledger');
  assert.strictEqual(text('hours-readout'), '—');
  assert.strictEqual(text('cal-readout'), '—');
}

console.log('panel render (combined Claude + Codex) checks passed');
