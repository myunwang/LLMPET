'use strict';

// PR3 冒烟：models.dev 转换安全边界 + CodeWhale 计量 + TOML 安装器
// 基于验证过的真实协议形状，不依赖任何可能过期的旧测试基线。

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ── 1. transformModelsDev：特殊 key 安全边界 ──────────────────────────────────
const { transformModelsDev } = require('../backend/models-dev-sync');

const rawCatalog = JSON.stringify({
  __proto__: undefined, // JSON.parse 不会产生这个；用普通对象手动构造下面的场景
});
// 手动构造带 __proto__ key 的对象（模拟恶意/合法上游数据）
const providers = JSON.parse('{"__proto__":{"models":{"evil":{"cost":{"input":1}}}},"anthropic":{"models":{"constructor":{"cost":{"input":3}},"claude-haiku-test":{"cost":{"input":0.8,"output":4,"cache_read":0.08},"limit":{"context":200000,"output":8192},"reasoning":true}}}}');
// JSON.parse 上的 "__proto__" 键实际会设置原型 — 检查一下
console.log('proto-key JSON.parse 结果: Object.keys =', Object.keys(providers));

const catalog = transformModelsDev({ providers });
assert(catalog && catalog.entries['claude-haiku-test'], 'model row missing');
assert.strictEqual(Object.getPrototypeOf(catalog.entries), null, 'entries not null-proto');
assert.strictEqual(Object.prototype.polluted, undefined, 'prototype polluted!');
assert.strictEqual(Object.prototype.hasOwnProperty.call(catalog.entries, '__proto__'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(catalog.entries, 'constructor'), false);
assert.strictEqual(catalog.entries['claude-haiku-test'].input_usd_per_million, 0.8);
assert.strictEqual(catalog.entries['claude-haiku-test'].cache_read_usd_per_million, 0.08);
assert.strictEqual(catalog.entries['claude-haiku-test'].context_window, 200000);
assert.strictEqual(catalog.entries['claude-haiku-test'].supports_reasoning, true);
assert(catalog.entries['anthropic/claude-haiku-test'], 'provider-qualified row missing');

// 数值边界：Infinity / 负数 / 字符串全部拒绝
const weird = transformModelsDev({
  providers: { x: { models: { m: { cost: { input: Infinity, output: -5 }, limit: { context: 'big' } } } } },
});
assert.strictEqual(weird.entries.m.input_usd_per_million, null);
assert.strictEqual(weird.entries.m.output_usd_per_million, null);
assert.strictEqual(weird.entries.m.context_window, null);

// 顶层形状错误
assert.strictEqual(transformModelsDev(null), null);
assert.strictEqual(transformModelsDev([]), null);
assert.strictEqual(transformModelsDev({ providers: [] }), null);
console.log('✓ models.dev transform：特殊 key + 数值边界 + 形状校验 OK');

// ── 2. codewhale-metering：记账/去重/定价 ────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-meter-'));

// 通过 LLMPET_CODEWHALE_HOME 控制 metering 的状态路径（不污染真实 ~/.octopus）。
// 故意选一个与 HOME 推导路径【不同】的目录：如果 models-dev-sync 的 CACHE_PATH
// 丢了 env 支持、退回 HOME 推导，下面的缓存断言必须失败 —— 同目录的伪覆盖
// 测不出这个回归。
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-home-'));
const cwStateHome = path.join(fakeHome, 'cw-state-isolated');
process.env.HOME = fakeHome;
process.env.LLMPET_CODEWHALE_HOME = cwStateHome;
delete require.cache[require.resolve('../backend/models-dev-sync')];
delete require.cache[require.resolve('../backend/codewhale-metering')];

const mds = require('../backend/models-dev-sync');
assert.strictEqual(mds.CACHE_PATH.startsWith(cwStateHome), true, `CACHE_PATH must follow LLMPET_CODEWHALE_HOME, got ${mds.CACHE_PATH}`);
assert.strictEqual(mds.CACHE_PATH.includes('catalog'), true);
fs.mkdirSync(path.dirname(mds.CACHE_PATH), { recursive: true });
fs.writeFileSync(mds.CACHE_PATH, JSON.stringify({
  schema_version: 1,
  source: 'models.dev',
  fetched_at: new Date().toISOString(),
  entries: {
    'deepseek/deepseek-chat': { id: 'deepseek-chat', input_usd_per_million: 0.27, output_usd_per_million: 1.1, cache_read_usd_per_million: 0.07, cache_write_usd_per_million: 0.27, provenance: 'models.dev:deepseek' },
    'deepseek-chat': { id: 'deepseek-chat', input_usd_per_million: 0.27, output_usd_per_million: 1.1, cache_read_usd_per_million: 0.07, cache_write_usd_per_million: 0.27, provenance: 'models.dev:deepseek' },
  },
}));

const { createCodeWhaleMetering, normalizeUsage } = require('../backend/codewhale-metering');
const meter = createCodeWhaleMetering({});

// 验证过的 turn_end usage 形状
const turn1 = {
  sessionId: 'sess-test-1',
  model: 'deepseek-chat',
  provider: 'deepseek',
  turnId: 'turn-1',
  usage: { input_tokens: 1000, output_tokens: 500, prompt_cache_hit_tokens: 400, prompt_cache_write_tokens: 100, reasoning_tokens: 50 },
};
assert.strictEqual(meter.record(turn1), true, 'first record');
// turn_id 重复 → 拒绝
assert.strictEqual(meter.record(turn1), false, 'duplicate turn_id must be rejected');
// 不同 turn → 记账
assert.strictEqual(meter.record({ ...turn1, turnId: 'turn-2', usage: { input_tokens: 100, output_tokens: 50 } }), true);

const stats = meter.getStats();
// 定价: turn1 = (1000-400)*0.27/1e6 + 500*1.1/1e6 + 400*0.07/1e6 + 100*0.27/1e6
//      = 0.000162 + 0.00055 + 0.000028 + 0.000027 = 0.000767
const expect1 = (600 * 0.27 + 500 * 1.1 + 400 * 0.07 + 100 * 0.27) / 1e6;
// turn2 = 100*0.27/1e6 + 50*1.1/1e6 = 0.000027 + 0.000055
const expect2 = (100 * 0.27 + 50 * 1.1) / 1e6;
assert.ok(Math.abs(stats.today.cost - (expect1 + expect2)) < 1e-12, `cost ${stats.today.cost} != ${expect1 + expect2}`);
assert.strictEqual(stats.today.tokens, 1650);
assert.strictEqual(stats.today.msgs, 2);
assert(stats.byModel['deepseek-chat'], 'byModel row');
assert.strictEqual(stats.byModel['deepseek-chat'].priceSource, 'models.dev:deepseek');

// 未知模型：honest $0
assert.strictEqual(meter.record({ ...turn1, turnId: 'turn-3', model: 'mystery-model' }), true);
const stats2 = meter.getStats();
assert.strictEqual(stats2.diagnostics.unknownModels['mystery-model'], 1500); // spread 保留 turn1 的 usage
assert.ok(stats2.byModel['mystery-model'].priceExact === false);

// 持久化 round-trip
meter.save();
const rawState = JSON.parse(fs.readFileSync(path.join(process.env.LLMPET_CODEWHALE_HOME, 'codewhale-usage.json'), 'utf8'));
assert.strictEqual(rawState.schemaVersion, 1);
assert.strictEqual(rawState.seenTurns['t:turn-1'] > 0, true);
console.log('✓ codewhale metering：turn_id 去重 + DeepSeek 缓存语义定价 + 未知模型 honest $0 + 持久化');

// seenTurns 有界性：灌超过 MAX_SEEN_TURNS 条记录后 map 必须回落（批量修剪）
{
  const MAX_SEEN_TURNS = 20000;
  const t0 = Date.now();
  for (let i = 0; i < MAX_SEEN_TURNS + 10; i++) {
    meter.record({ sessionId: 'bulk', model: 'deepseek-chat', provider: 'deepseek', usage: { input_tokens: 1, output_tokens: 1 }, turnId: `bulk-${i}` });
  }
  const loopMs = Date.now() - t0;
  assert(loopMs < 5000, `20k records must be fast (size-counter guard), took ${loopMs}ms`);
  meter.save();
  const bulk = JSON.parse(fs.readFileSync(path.join(cwStateHome, 'codewhale-usage.json'), 'utf8'));
  const seen = Object.keys(bulk.seenTurns).length;
  assert(seen <= MAX_SEEN_TURNS + 10, `seenTurns must stay bounded, got ${seen}`);
  assert(seen >= MAX_SEEN_TURNS / 2, `pruning must keep a dedup window, got ${seen}`);
  // 修剪后新记录仍正常入账（去重窗口未坏）
  assert.strictEqual(meter.record({ sessionId: 'bulk', model: 'deepseek-chat', provider: 'deepseek', usage: { input_tokens: 1, output_tokens: 1 }, turnId: 'bulk-after-prune' }), true);
  console.log(`✓ codewhale metering：seenTurns 批量修剪后有界（${seen} 条，${loopMs}ms）且去重窗口完好`);
}

// ── 3. TOML 安装器：验证过的事件名 + 幂等 + 用户内容保留 ─────────────────────
process.env.CODEWHALE_CONFIG = path.join(fakeHome, 'config.toml');
delete require.cache[require.resolve('../backend/codewhale-provider')];
delete require.cache[require.resolve('../backend/transport')];
const provider = require('../backend/codewhale-provider');

const userToml = '# my own config\nmodel = "deepseek-chat"\n\n[[hooks.hooks]]\nevent = "mode_change"\ncommand = "echo mine"\n';
fs.writeFileSync(process.env.CODEWHALE_CONFIG, userToml);

const r1 = provider.install();
assert.strictEqual(r1.installed, 10);
const after1 = fs.readFileSync(process.env.CODEWHALE_CONFIG, 'utf8');
assert(after1.includes('# my own config'), 'user content lost');
assert(after1.includes('event = "message_submit"'), 'message_submit missing');
assert(after1.includes('event = "on_error"'), 'on_error missing');
assert(after1.includes('event = "subagent_spawn"'), 'subagent_spawn missing');
assert(!/\bturn_start\b/.test(after1), 'turn_start must NOT be registered (does not exist upstream)');
assert(!/event = "error"/.test(after1), 'error event must NOT be registered (upstream name is on_error)');
assert(after1.includes('continue_on_error = false'), 'gate must be strict');
assert(after1.includes('timeout_secs = 600'), 'gate timeout 600');
// 观察者后台化（Web 验证的官方语义：同 payload、不被等待、stdout 弃置）
assert(after1.includes('background = true'), 'observers must run in the background (never awaited)');
const gateBlock = after1.split('event = "tool_call_before"')[1].split('[[hooks.hooks]]')[0];
assert(gateBlock.includes('background = false'), 'gate must stay foreground (stdout IS the verdict)');
assert(gateBlock.includes('continue_on_error = false') && gateBlock.includes('timeout_secs = 600'));
const observerBlock = after1.split('event = "turn_end"')[1].split('[[hooks.hooks]]')[0];
assert(observerBlock.includes('background = true') && observerBlock.includes('continue_on_error = true'));

provider.install();
const after2 = fs.readFileSync(process.env.CODEWHALE_CONFIG, 'utf8');
assert.strictEqual(after1, after2, 'install not idempotent');

// 旧格式升级：先写入【无 background 行】的旧托管块，install() 必须整体重写为新格式
{
  const oldBlock = provider.managedBlock().split('\n\n').map((entry) => entry.replace(/\nbackground = (?:true|false)$/, '')).join('\n\n');
  assert(!oldBlock.includes('background ='), 'old-format fixture must actually lack background lines');
  fs.writeFileSync(process.env.CODEWHALE_CONFIG, `# my own config\nmodel = "deepseek-chat"\n\n[[hooks.hooks]]\nevent = "mode_change"\ncommand = "echo mine"\n\n${oldBlock}\n`);
  provider.install();
  const upgraded = fs.readFileSync(process.env.CODEWHALE_CONFIG, 'utf8');
  assert(upgraded.includes('background = true'), 'upgrade must add background = true for observers');
  assert.strictEqual((upgraded.match(/BEGIN LLMPET CODEWHALE HOOKS/g) || []).length, 1, 'upgrade must not duplicate the managed block');
  assert.strictEqual((upgraded.match(/event = "turn_end"/g) || []).length, 1, 'upgrade must not duplicate entries');
  assert(upgraded.includes('# my own config'), 'user content lost on upgrade');
  console.log('✓ TOML 升级：旧格式块被整体重写，无重复，用户内容保留');
}

const r3 = provider.uninstall();
assert.strictEqual(r3.removed, 10);
const after3 = fs.readFileSync(process.env.CODEWHALE_CONFIG, 'utf8');
assert(after3.includes('# my own config'), 'user content lost on uninstall');
assert(after3.includes('echo mine'), 'user hook lost on uninstall');
assert(!after3.includes('LLMPET CODEWHALE'), 'managed block not removed');
console.log('✓ TOML 安装器：验证过的 10 事件 + 严格门 + 幂等 + 用户内容保留');

// ── 4. codewhale-hook EVENT_MAP 映射到合法状态 ───────────────────────────────
delete require.cache[require.resolve('../hook/codewhale-hook')];
delete require.cache[require.resolve('../backend/transport')];
const { EVENT_MAP } = require('../hook/codewhale-hook');
const States = require('../shared/states');
for (const [ev, { state }] of Object.entries(EVENT_MAP)) {
  assert(States.VALID_STATES.includes(state), `state ${state} for ${ev} is not in VALID_STATES`);
}
assert.strictEqual(Object.keys(EVENT_MAP).length, 10);
assert(!EVENT_MAP.turn_start && !EVENT_MAP.error, 'invented events present');
// mode_change 绝不能映射到 Notification：adapter 会把 Notification 变成
// 「需要输入」卡片，而模式切换是用户自己按键触发的上下文，不该弹卡。
assert.strictEqual(EVENT_MAP.mode_change.event, 'ModeChange', 'mode_change must NOT map to Notification (adapter card side-effect)');
assert.strictEqual(EVENT_MAP.mode_change.state, 'attention');
console.log('✓ codewhale-hook：10 个验证过的事件，映射状态全部合法，mode_change 不弹卡');

// ── 5. adapter：CodeWhale 权限卡的身份/文案/提示 ─────────────────────────────
delete require.cache[require.resolve('../shared/i18n')];
delete require.cache[require.resolve('../backend/adapter')];
const adapter = require('../backend/adapter');
const i18n = require('../shared/i18n');
i18n.setLang('zh');

// humanizeTool 认 CodeWhale 工具名（exec_shell→command，file 工具→path）
assert(adapter.humanizeTool('exec_shell', { command: 'cargo test' }).includes('cargo test'));
assert(adapter.humanizeTool('write_file', { path: 'src/lib.rs' }).includes('src/lib.rs'));
assert(adapter.humanizeTool('read_file', { path: 'README.md' }).includes('README.md'));

// 权限卡：Claude 会话保持裸工具名（字节级不变）；CodeWhale 会话带身份前缀。
// hint 从 entry 的 createdAt/expiresAt 推导（快照路径没有 autoDenyMins，
// 推导保证两条渲染路径的卡片一致）。
const claudeChoice = adapter.buildPermChoice(
  { id: 'p1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' }, suggestions: [] },
  { id: 's1', agentId: 'claude-code', cwd: '/tmp/a' });
assert.strictEqual(claudeChoice.header, 'Bash');
assert.strictEqual(claudeChoice.hint, '');
const cwChoice = adapter.buildPermChoice(
  { id: 'p2', sessionId: 's2', toolName: 'exec_shell', toolInput: { command: 'cargo test' }, suggestions: [], autoDenyMins: 8 },
  { id: 's2', agentId: 'codewhale', cwd: '/tmp/b' });
assert(cwChoice.header.startsWith('CodeWhale · '), `header should carry agent identity, got ${cwChoice.header}`);
assert(cwChoice.hint.includes('8'), 'auto-deny hint should mention the minutes');
// 快照路径形状：pending entry 只有 createdAt/expiresAt，没有 autoDenyMins
const now = Date.now();
const snapshotChoice = adapter.buildPermChoice(
  { id: 'p3', sessionId: 's3', toolName: 'exec_shell', toolInput: { command: 'cargo test' }, suggestions: [], createdAt: now, expiresAt: now + 8 * 60 * 1000 },
  { id: 's3', agentId: 'codewhale', cwd: '/tmp/c' });
assert(snapshotChoice.hint.includes('8'), `snapshot-path card must derive the hint from entry timestamps, got "${snapshotChoice.hint}"`);
// 无时间戳也无 autoDenyMins → 无提示（Claude 路径形状）
const plainChoice = adapter.buildPermChoice(
  { id: 'p4', sessionId: 's4', toolName: 'Bash', toolInput: { command: 'ls' }, suggestions: [] },
  { id: 's4', agentId: 'claude-code', cwd: '/tmp/d' });
assert.strictEqual(plainChoice.hint, '');

// activityToEvents：ModeChange 事件不产生任何卡片（Notification 才会）
const evts = adapter.activityToEvents({
  session: { id: 's2', agentId: 'codewhale', state: 'attention', cwd: '/tmp/b', recentEvents: [{ at: Date.now(), event: 'ModeChange', state: 'attention' }] },
  event: 'ModeChange', prevState: 'idle', newState: 'attention', isNew: false, realCompletion: false, assistantChanged: false, cwdActive: false,
});
assert(!evts.some((e) => e.kind === 'needsinput'), 'ModeChange must not produce a needsinput card');
console.log('✓ adapter：CodeWhale 权限卡身份前缀 + 自动拒绝提示 + humanizeTool + ModeChange 无卡片');

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log('\n✅ PR3 冒烟全部通过');
