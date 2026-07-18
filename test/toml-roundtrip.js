'use strict';
// TOML round-trip test — verifies ACTUAL file bytes, not console display
// (console capture strips [ characters, creating false positives)

const fs = require('fs');
const path = require('path');
const codewhale = require('../providers/codewhale');
const tomlHooks = require('../backend/toml-hooks');

const TMPDIR = '/tmp/toml-rt-' + process.pid;
fs.mkdirSync(TMPDIR, { recursive: true });

// ---- helpers (write to stderr to avoid [ stripping) ----
function log(msg) { process.stderr.write(msg + '\n'); }
function checkBrackets(filePath, label) {
  const buf = fs.readFileSync(filePath);
  const s = buf.toString('utf8');
  const doubleBracketCount = (s.match(/\[\[/g) || []).length;
  const singleBracketCount = (s.match(/\[(?!\[)/g) || []).length;
  const hasMarker = s.includes('codewhale-hook.js');
  const hasEchoHello = s.includes('echo hello');
  const hasEchoDone = s.includes('echo done');
  const hasModelSection = s.includes('[model]');
  const hasHooksEnabled = s.includes('enabled = true');
  log(`  ${label}:`);
  log(`    [[ count: ${doubleBracketCount}`);
  log(`    [ count: ${singleBracketCount}`);
  log(`    marker: ${hasMarker}`);
  log(`    echo hello preserved: ${hasEchoHello}`);
  log(`    echo done preserved: ${hasEchoDone}`);
  log(`    [model] preserved: ${hasModelSection}`);
  log(`    [hooks] enabled preserved: ${hasHooksEnabled}`);
  return { doubleBracketCount, singleBracketCount, hasMarker, hasEchoHello, hasEchoDone, hasModelSection, hasHooksEnabled };
}

// ---- Test 1: Fresh install ----
log('=== Test 1: Fresh install ===');
const testFile = path.join(TMPDIR, 'config.toml');
const sample = [
  '# Sample config',
  'provider = "deepseek"',
  '',
  '[hooks]',
  'enabled = true',
  'default_timeout_secs = 30',
  '',
  '[[hooks.hooks]]',
  'event = "message_submit"',
  'command = "echo hello"',
  'timeout_secs = 2',
  'continue_on_error = true',
  '',
  '[[hooks.hooks]]',
  'event = "turn_end"',
  'command = "echo done"',
  'timeout_secs = 2',
  '',
  '[model]',
  'name = "test"',
].join('\n') + '\n';
fs.writeFileSync(testFile, sample, 'utf8');
codewhale.dirs.settingsFile = testFile;

log('Before install:');
const before = checkBrackets(testFile, 'BEFORE');

const regResult = tomlHooks.registerHooks();
log(`Register result: ${JSON.stringify(regResult)}`);

log('After install:');
const after = checkBrackets(testFile, 'AFTER');
log(`markerPresent: ${tomlHooks.markerPresent()}`);

// Count our entries by counting lines with our marker
const content = fs.readFileSync(testFile, 'utf8');
const ourLines = content.split('\n').filter(l => l.includes('codewhale-hook.js')).length;
log(`Our entry lines: ${ourLines} (expect ${8} events = 8 headers)`);

// ---- Test 2: Update (reinstall) ----
log('\n=== Test 2: Reinstall (update) ===');
const reg2 = tomlHooks.registerHooks();
log(`Reinstall result: ${JSON.stringify(reg2)}`);
const ourLines2 = fs.readFileSync(testFile, 'utf8').split('\n').filter(l => l.includes('codewhale-hook.js')).length;
log(`Our entry lines after reinstall: ${ourLines2} (should still be 8 headers)`);

// ---- Test 3: Uninstall ----
log('\n=== Test 3: Uninstall ===');
const unResult = tomlHooks.unregisterHooks({ backup: false });
log(`Uninstall result: ${JSON.stringify(unResult)}`);
log('After uninstall:');
const final = checkBrackets(testFile, 'FINAL');
log(`markerPresent: ${tomlHooks.markerPresent()}`);
const ourLinesFinal = fs.readFileSync(testFile, 'utf8').split('\n').filter(l => l.includes('codewhale-hook.js')).length;
log(`Our entry lines: ${ourLinesFinal} (should be 0)`);

// ---- Test 4: Idempotent uninstall ----
log('\n=== Test 4: Idempotent uninstall ===');
const un2 = tomlHooks.unregisterHooks({ backup: false });
log(`Second uninstall: ${JSON.stringify(un2)} (should be removed: 0)`);

// ---- Summary ----
log('\n=== SUMMARY ===');
const allOk =
  before.hasEchoHello && before.hasEchoDone && before.hasModelSection &&
  before.hasHooksEnabled &&
  after.hasMarker && after.hasEchoHello && after.hasEchoDone && after.hasModelSection &&
  ourLines === 8 &&
  ourLines2 === 8 &&
  ourLinesFinal === 0 && !final.hasMarker &&
  final.hasEchoHello && final.hasEchoDone && final.hasModelSection;
log(allOk ? 'PASS' : 'FAIL');

// Clean up
fs.rmSync(TMPDIR, { recursive: true });