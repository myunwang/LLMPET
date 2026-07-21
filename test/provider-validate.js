'use strict';
// R13-拓展: Provider abstraction layer unit tests.
// Covers base.js (validateProvider, makeNotImplemented, STATES, INTERNAL_BODY_FIELDS),
// index.js (registry, resolveActive, getActiveProviders, getProvider, invalidate),
// and validates that claude.js and codewhale.js pass validation.

const { validateProvider, makeNotImplemented, STATES, INTERNAL_BODY_FIELDS, REQUIRED_FIELDS } = require('../providers/base');
const { getActiveProviders, getActiveIds, getProvider, is_active, invalidate, ALL_IDS } = require('../providers/index');

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ ' + msg); } }

// ── base.js: validateProvider ──────────────────────────────────────────────────

console.log('[V1] validateProvider — null/undefined/non-object');
assert(Array.isArray(validateProvider(null)), 'null returns array');
assert(validateProvider(null).length === 1, 'null reports 1 missing');
assert(validateProvider(null)[0] === '<not an object>', 'null message is "<not an object>"');
assert(validateProvider(undefined).length === 1, 'undefined returns 1 missing');
assert(validateProvider(42).length === 1, 'number returns 1 missing');
assert(validateProvider('claude').length === 1, 'string returns 1 missing');
assert(validateProvider(false).length === 1, 'false returns 1 missing');

console.log('[V2] validateProvider — empty object');
{
  const missing = validateProvider({});
  // REQUIRED_FIELDS (13) + hookEvents(non-empty) = 14
  assert(missing.length === REQUIRED_FIELDS.length + 1, `empty object missing ${REQUIRED_FIELDS.length + 1} items (13 fields + hookEvents check)`);
  assert(missing.includes('hookEvents(non-empty)'), 'empty object flagged hookEvents(non-empty)');
}

console.log('[V3] validateProvider — partially filled object');
{
  const p = { id: 'test', displayName: 'Test' };
  const missing = validateProvider(p);
  assert(!missing.includes('id'), 'id is present');
  assert(!missing.includes('displayName'), 'displayName is present');
  assert(missing.includes('dirs'), 'dirs is missing');
  assert(missing.includes('hookEvents(non-empty)'), 'hookEvents(non-empty) flagged');
}

console.log('[V4] validateProvider — hookEvents empty array');
{
  const p = { id: 'x', displayName: 'X', dirs: {}, hookEvents: [], eventToPetState: {},
    hookScript: '/a', permission: {}, transcript: {}, pricing: {}, capabilities: {},
    installHooks() {}, uninstallHooks() {}, parseHookStdin() {} };
  const missing = validateProvider(p);
  assert(missing.includes('hookEvents(non-empty)'), 'empty hookEvents flagged');
}

console.log('[V5] validateProvider — minimal valid provider');
{
  const p = { id: 'x', displayName: 'X', dirs: {}, hookEvents: ['e1'], eventToPetState: {},
    hookScript: '/a', permission: {}, transcript: {}, pricing: {}, capabilities: {},
    installHooks() {}, uninstallHooks() {}, parseHookStdin() {} };
  const missing = validateProvider(p);
  assert(missing.length === 0, `minimal provider passes (${missing.length} missing)`);
}

// ── base.js: makeNotImplemented ───────────────────────────────────────────────

console.log('[V6] makeNotImplemented');
{
  const fn = makeNotImplemented('test-prov', 'launch');
  assert(typeof fn === 'function', 'returns a function');
  let err;
  try { fn(); } catch (e) { err = e; }
  assert(err instanceof Error, 'throws Error');
  assert(err.code === 'ENOTIMPL', 'error.code = ENOTIMPL');
  assert(err.provider === 'test-prov', 'error.provider = test-prov');
  assert(err.fn === 'launch', 'error.fn = launch');
  assert(err.message.includes('test-prov'), 'message includes provider id');
  assert(err.message.includes('launch'), 'message includes function name');
}

// ── base.js: STATES and INTERNAL_BODY_FIELDS ─────────────────────────────────

console.log('[V7] STATES');
assert(Array.isArray(STATES), 'STATES is array');
assert(STATES.length > 10, `STATES has ${STATES.length} entries (>=10)`);
assert(STATES.includes('idle'), 'STATES includes idle');
assert(STATES.includes('working'), 'STATES includes working');
assert(STATES.includes('thinking'), 'STATES includes thinking');
assert(STATES.includes('sleeping'), 'STATES includes sleeping');
assert(Object.isFrozen(STATES), 'STATES is frozen');

console.log('[V8] INTERNAL_BODY_FIELDS');
assert(Array.isArray(INTERNAL_BODY_FIELDS), 'INTERNAL_BODY_FIELDS is array');
assert(INTERNAL_BODY_FIELDS.includes('state'), 'includes state');
assert(INTERNAL_BODY_FIELDS.includes('event'), 'includes event');
assert(INTERNAL_BODY_FIELDS.includes('session_id'), 'includes session_id');
assert(INTERNAL_BODY_FIELDS.includes('provider'), 'includes provider');
assert(INTERNAL_BODY_FIELDS.includes('cwd'), 'includes cwd');
assert(Object.isFrozen(INTERNAL_BODY_FIELDS), 'INTERNAL_BODY_FIELDS is frozen');

// ── index.js: registry basics ─────────────────────────────────────────────────

console.log('[V9] ALL_IDS and getProvider');
assert(Array.isArray(ALL_IDS), 'ALL_IDS is array');
assert(ALL_IDS.includes('claude'), 'ALL_IDS includes claude');
assert(ALL_IDS.includes('codewhale'), 'ALL_IDS includes codewhale');
assert(ALL_IDS.includes('aider'), 'ALL_IDS includes aider');
assert(getProvider('claude') !== null, 'getProvider(claude) returns non-null');
assert(getProvider('codewhale') !== null, 'getProvider(codewhale) returns non-null');
assert(getProvider('aider') !== null, 'getProvider(aider) returns non-null');
assert(getProvider('claude').id === 'claude', 'claude provider id is claude');
assert(getProvider('codewhale').id === 'codewhale', 'codewhale provider id is codewhale');
assert(getProvider('aider').id === 'aider', 'aider provider id is aider');
assert(getProvider('nonexistent') === null, 'getProvider(unknown) returns null');

// ── index.js: both registered providers pass validation ───────────────────────

console.log('[V10] Registered providers pass validateProvider');
{
  for (const id of ALL_IDS) {
    const p = getProvider(id);
    const missing = validateProvider(p);
    assert(missing.length === 0, `${id} passes validation (0 missing)`);
    assert(p.id === id, `${id} has correct id field`);
    assert(typeof p.displayName === 'string' && p.displayName.length > 0, `${id} has non-empty displayName`);
    assert(Array.isArray(p.hookEvents) && p.hookEvents.length > 0, `${id} has non-empty hookEvents`);
    assert(typeof p.parseHookStdin === 'function', `${id} has parseHookStdin function`);
    assert(typeof p.installHooks === 'function', `${id} has installHooks function`);
    assert(typeof p.uninstallHooks === 'function', `${id} has uninstallHooks function`);
  }
}

// ── index.js: active providers (default config, no env) ───────────────────────

console.log('[V11] getActiveProviders / getActiveIds — default');
{
  // Clear env to ensure default behavior (delete cached value)
  delete process.env.OCTOPUS_PROVIDER;
  invalidate();
  const active = getActiveProviders();
  const ids = getActiveIds();
  assert(Array.isArray(ids) && ids.length >= 1, 'at least 1 active provider');
  assert(ids[0] === 'claude', 'first active is claude (default)');
  assert(active.length === ids.length, 'active.length === activeIds.length');
  assert(active[0].id === 'claude', 'first active provider is claude');
}

console.log('[V12] is_active');
{
  invalidate();
  assert(is_active('claude') === true, 'claude is active by default');
  // codewhale may or may not be in config — don't assert; just check return type
  assert(typeof is_active('claude') === 'boolean', 'is_active returns boolean');
  assert(is_active('nonexistent') === false, 'nonexistent is not active');
}

// ── index.js: OCTOPUS_PROVIDER env ────────────────────────────────────────────

console.log('[V13] OCTOPUS_PROVIDER env — single');
{
  process.env.OCTOPUS_PROVIDER = 'codewhale';
  invalidate();
  const ids = getActiveIds();
  assert(ids.length === 1, 'single env → 1 provider');
  assert(ids[0] === 'codewhale', 'env codewhale selected');
  delete process.env.OCTOPUS_PROVIDER;
}

console.log('[V14] OCTOPUS_PROVIDER env — comma-separated');
{
  process.env.OCTOPUS_PROVIDER = 'claude,codewhale';
  invalidate();
  const ids = getActiveIds();
  assert(ids.length === 2, 'comma-separated → 2 providers');
  assert(ids[0] === 'claude' && ids[1] === 'codewhale', 'order preserved');
  delete process.env.OCTOPUS_PROVIDER;
}

console.log('[V15] OCTOPUS_PROVIDER env — "all"');
{
  process.env.OCTOPUS_PROVIDER = 'all';
  invalidate();
  const ids = getActiveIds();
  assert(ids.length === ALL_IDS.length, `"all" → ${ALL_IDS.length} providers`);
  delete process.env.OCTOPUS_PROVIDER;
}

console.log('[V16] OCTOPUS_PROVIDER env — unknown id filtered');
{
  process.env.OCTOPUS_PROVIDER = 'claude,fake-provider';
  invalidate();
  const ids = getActiveIds();
  assert(ids.length === 1, 'unknown id filtered out');
  assert(ids[0] === 'claude', 'only claude remains');
  delete process.env.OCTOPUS_PROVIDER;
}

console.log('[V17] OCTOPUS_PROVIDER env — all unknown → fallback claude');
{
  process.env.OCTOPUS_PROVIDER = 'fake1,fake2';
  invalidate();
  const ids = getActiveIds();
  assert(ids.length === 1, 'all unknown → fallback 1 provider');
  assert(ids[0] === 'claude', 'fallback is claude');
  delete process.env.OCTOPUS_PROVIDER;
}

console.log('[V18] OCTOPUS_PROVIDER env — dedup');
{
  process.env.OCTOPUS_PROVIDER = 'claude,claude,codewhale,claude';
  invalidate();
  const ids = getActiveIds();
  assert(ids.length === 2, 'duplicates removed');
  assert(ids[0] === 'claude' && ids[1] === 'codewhale', 'order preserved after dedup');
  delete process.env.OCTOPUS_PROVIDER;
}

console.log('[V19] OCTOPUS_PROVIDER env — empty/whitespace trimmed');
{
  process.env.OCTOPUS_PROVIDER = '  claude , codewhale  ';
  invalidate();
  const ids = getActiveIds();
  assert(ids.length === 2, 'whitespace trimmed');
  delete process.env.OCTOPUS_PROVIDER;
}

// ── index.js: invalidate cache ────────────────────────────────────────────────

console.log('[V20] invalidate');
{
  delete process.env.OCTOPUS_PROVIDER;
  invalidate();
  const a = getActiveIds();
  process.env.OCTOPUS_PROVIDER = 'codewhale';
  // Before invalidate, cache still has default
  const b = getActiveIds();
  assert(b[0] === 'claude', 'cache returns old result before invalidate');
  invalidate();
  const c = getActiveIds();
  assert(c[0] === 'codewhale', 'after invalidate, new env is read');
  delete process.env.OCTOPUS_PROVIDER;
  invalidate();
}

// ── Provider descriptor shape checks ──────────────────────────────────────────

console.log('[V21] Claude provider descriptor shape');
{
  const p = getProvider('claude');
  assert(p.displayName === 'Claude Code', 'displayName = Claude Code');
  assert(typeof p.dirs === 'object', 'dirs is object');
  assert(typeof p.dirs.settingsFile === 'string', 'dirs.settingsFile is string');
  assert(typeof p.dirs.dataHome === 'string', 'dirs.dataHome is string');
  assert(p.dirs.settingsFormat === 'json', 'settingsFormat = json');
  assert(typeof p.hookScript === 'string' && p.hookScript.length > 0, 'hookScript is non-empty string');
  assert(typeof p.hookMarker === 'string' && p.hookMarker.length > 0, 'hookMarker is non-empty string');
  assert(typeof p.eventToPetState === 'object', 'eventToPetState is object');
  assert(typeof p.permission === 'object', 'permission is object');
  assert(typeof p.transcript === 'object', 'transcript is object');
  assert(typeof p.pricing === 'object', 'pricing is object');
  assert(typeof p.capabilities === 'object', 'capabilities is object');
  assert(p.hookEvents.includes('PreToolUse'), 'claude hookEvents includes PreToolUse');
}

console.log('[V22] CodeWhale provider descriptor shape');
{
  const p = getProvider('codewhale');
  assert(p.displayName === 'CodeWhale', 'displayName = CodeWhale');
  assert(typeof p.dirs === 'object', 'dirs is object');
  assert(p.dirs.settingsFormat === 'toml', 'settingsFormat = toml');
  assert(typeof p.hookScript === 'string' && p.hookScript.includes('codewhale-hook'), 'hookScript points to codewhale-hook');
  assert(typeof p.eventToPetState === 'object', 'eventToPetState is object');
  assert(p.hookEvents.includes('session_start'), 'codewhale hookEvents includes session_start');
  assert(p.hookEvents.includes('turn_end'), 'codewhale hookEvents includes turn_end');
  assert(p.hookEvents.includes('tool_call_before'), 'codewhale hookEvents includes tool_call_before');
  assert(p.permission.mechanism === 'tool_call_before_decision', 'permission mechanism = tool_call_before_decision');
  assert(p.pricing.source === 'bundled-catalog', 'pricing source = bundled-catalog');
}

console.log('[V23] parseHookStdin returns internal body shape');
{
  const claude = getProvider('claude');
  // Test with a minimal Claude stdin payload (as if from PreToolUse hook)
  const result = claude.parseHookStdin('PreToolUse', {
    session_id: 'test-sess-123',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    cwd: '/Users/me/proj',
  });
  assert(result !== null, 'claude parseHookStdin returns non-null');
  assert(result.state === 'working', 'PreToolUse → working');
  assert(result.event === 'PreToolUse', 'event preserved');
  assert(result.session_id === 'test-sess-123', 'session_id passed through');
  // Claude's parseHookStdin delegates to hook.buildBody which doesn't stamp provider;
  // the server core adds provider at routing time.
  assert(result.provider === undefined || result.provider === 'claude', 'provider field behavior documented');

  const cw = getProvider('codewhale');
  const cwResult = cw.parseHookStdin('message_submit', {
    session_id: 'some-uuid',
    message: { content: 'hello' },
  });
  assert(cwResult !== null, 'codewhale parseHookStdin returns non-null');
  assert(cwResult.provider === 'codewhale', 'codewhale result has provider = codewhale');

  // Aider stub: parseHookStdin works with synthetic payloads
  const aider = getProvider('aider');
  assert(aider !== null, 'aider provider exists');
  const aResult = aider.parseHookStdin('session_start', {
    session_id: 'aider-sess-1',
    cwd: '/home/user/project',
    model: 'gpt-4o',
  });
  assert(aResult !== null, 'aider parseHookStdin returns non-null');
  assert(aResult.provider === 'aider', 'aider result has provider = aider');
  assert(aResult.event === 'SessionStart', 'aider session_start → SessionStart');
  assert(aResult.state === 'idle', 'aider session_start → idle');
  assert(aResult.session_id === 'aider-sess-1', 'session_id passed through');

  const aNull = aider.parseHookStdin('nonexistent_event', { session_id: 'x' });
  assert(aNull === null, 'aider unknown event → null');
  const aNoSid = aider.parseHookStdin('turn_end', {});
  assert(aNoSid === null, 'aider missing session_id → null');
}

console.log('[V24] findCodeWhale — Unix PATH discovery');
{
  if (process.platform === 'win32') {
    assert(true, 'Unix PATH discovery skipped on Windows');
  } else {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-cw-bin-'));
    const fake = path.join(tmp, 'codewhale');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${tmp}${path.delimiter}${previousPath || ''}`;
      const found = getProvider('codewhale').findCodeWhale();
      assert(found === fake, 'findCodeWhale resolves executable from inherited PATH');
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ── Cleanup: restore default state ────────────────────────────────────────────
delete process.env.OCTOPUS_PROVIDER;
invalidate();

console.log('[V25] Aider provider descriptor — stub with correct shape');
{
  const p = getProvider('aider');
  assert(p.displayName === 'Aider', 'displayName = Aider');
  assert(p.dirs.settingsFormat === 'yaml', 'settingsFormat = yaml');
  assert(p.permission.mechanism === 'none', 'permission mechanism = none (no hook)');
  assert(p.capabilities.permissionBubble === false, 'permissionBubble = false');
  assert(p.capabilities.metering === false, 'metering = false');
  assert(p.capabilities.launch === false, 'launch = false (stub)');
  assert(typeof p.launch === 'function', 'launch is a function (stub)');
  assert(typeof p.readTranscriptTail === 'function', 'readTranscriptTail is a function (stub)');
  // Stub functions should throw ENOTIMPL
  let threw = false;
  try { p.launch(); } catch (e) { threw = e.code === 'ENOTIMPL' && e.provider === 'aider'; }
  assert(threw, 'launch stub throws ENOTIMPL');
  threw = false;
  try { p.readTranscriptTail('/tmp/test'); } catch (e) { threw = e.code === 'ENOTIMPL'; }
  assert(threw, 'readTranscriptTail stub throws ENOTIMPL');
}

console.log(failed ? `\n✗ ${failed} FAILED` : `\n✅ ALL PASS — ${passed} passed, 0 failed`);
process.exit(failed ? 1 : 0);