'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { commandForNode } = require('../backend/shell-quote');
const { localFileMatches, trustedIpcEvent, clampBoundsToWorkArea } = require('../backend/window-security');
const { createPermissions, _boundedClone, _buildElicitationUpdatedInput } = require('../backend/permission');
const { createCore } = require('../backend/core');
const { readTextBoundedSync } = require('../backend/safe-json');
const transcript = require('../backend/transcript');

const ROOT = path.resolve(__dirname, '..');

function fakeResponse() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.writableFinished = false;
  res.writeHead = () => {};
  res.end = () => { res.writableEnded = true; res.writableFinished = true; };
  res.destroy = () => { res.destroyed = true; };
  return res;
}

// POSIX shell quoting must preserve every argument without executing metacharacters.
if (process.platform !== 'win32') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-quote-'));
  const weirdDir = path.join(temp, "space ' $(touch SHOULD_NOT_EXIST)");
  fs.mkdirSync(weirdDir);
  const script = path.join(weirdDir, 'echo args.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const event = "Evt; touch ALSO_NOT_CREATED; echo 'x'";
  const cmd = commandForNode(process.execPath, script, event, 'linux');
  const run = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', cwd: temp });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout), [event]);
  assert.strictEqual(fs.existsSync(path.join(temp, 'SHOULD_NOT_EXIST')), false);
  assert.strictEqual(fs.existsSync(path.join(temp, 'ALSO_NOT_CREATED')), false);
  fs.rmSync(temp, { recursive: true, force: true });
}

// Exact local-file allowlisting and off-screen recovery helpers.
const petFile = path.join(ROOT, 'renderer', 'pet.html');
assert(localFileMatches(new URL(`file://${petFile}`).href, petFile));
assert(!localFileMatches(new URL(`file://${path.join(ROOT, 'renderer', 'panel.html')}`).href, petFile));
assert(!localFileMatches('https://example.com/pet.html', petFile));
const wc = {};
const win = { isDestroyed: () => false, webContents: wc };
assert(trustedIpcEvent({ sender: wc, senderFrame: { url: new URL(`file://${petFile}`).href } }, [{ win, file: petFile }]));
assert(!trustedIpcEvent({ sender: {}, senderFrame: { url: new URL(`file://${petFile}`).href } }, [{ win, file: petFile }]));
assert.deepStrictEqual(
  clampBoundsToWorkArea({ x: 9999, y: -9999, width: 320, height: 340 }, { x: 0, y: 0, width: 1920, height: 1080 }),
  { x: 1600, y: 0, width: 320, height: 340 }
);

// Prototype-pollution keys and oversized elicitation answers are bounded.
const cloned = _boundedClone(JSON.parse('{"ok":1,"__proto__":{"polluted":true},"constructor":{"x":1}}'));
assert.strictEqual(cloned.ok, 1);
assert.strictEqual(Object.prototype.hasOwnProperty.call(cloned, '__proto__'), false);
assert.strictEqual({}.polluted, undefined);
const updated = _buildElicitationUpdatedInput(
  { questions: [{ question: '__proto__', options: [{ label: 'yes' }] }] },
  JSON.parse('{"__proto__":"' + 'x'.repeat(5000) + '"}')
);
assert.strictEqual(Object.prototype.hasOwnProperty.call(updated.answers, '__proto__'), true);
assert.strictEqual(updated.answers.__proto__.length, 4096);

// A duplicate-hook storm is bounded at one card + eight parked copies.
const perms = createPermissions();
const primary = fakeResponse();
// A duplicate-hook storm is bounded at one card + eight parked copies.
// Use 'Write' (not in PASSTHROUGH_TOOLS) so it actually parks for dedup test.
const parsed = { toolName: 'Write', toolInput: { file_path: '/tmp/test.txt', content: 'hello' }, sessionId: 'dup-session' };
perms.addPermission(primary, parsed);
const dupes = Array.from({ length: 9 }, () => fakeResponse());
for (const res of dupes) perms.addPermission(res, parsed);
assert.strictEqual(perms.getPending().length, 1);
assert.strictEqual(dupes[8].destroyed, true, 'ninth duplicate was not rejected');
perms.cleanup();

// Unchanged transcript tails are not reparsed every cleanup tick.
const tempTranscript = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-tail-cache-'));
const transcriptFile = path.join(tempTranscript, 'session.jsonl');
fs.writeFileSync(transcriptFile, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
const originalReadTail = transcript.readTail;
let reads = 0;
transcript.readTail = (...args) => { reads++; return originalReadTail(...args); };
try {
  const core = createCore();
  core.updateSession('cache-session', 'working', 'PreToolUse', { transcriptPath: transcriptFile });
  reads = 0;
  core.cleanStaleSessions();
  core.cleanStaleSessions();
  assert.strictEqual(reads, 1, 'unchanged transcript was reparsed');
  fs.appendFileSync(transcriptFile, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done' } }) + '\n');
  core.cleanStaleSessions();
  assert.strictEqual(reads, 2, 'changed transcript was not reparsed');
} finally {
  transcript.readTail = originalReadTail;
  fs.rmSync(tempTranscript, { recursive: true, force: true });
}

// Hook installation must write a tokenized permission URL and private files.
const childHome = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-hook-token-'));
const transportPath = path.join(ROOT, 'backend', 'transport.js');
const installerPath = path.join(ROOT, 'backend', 'hookinstall.js');
const childCode = `
const fs = require('fs');
const transport = require(${JSON.stringify(transportPath)});
const installer = require(${JSON.stringify(installerPath)});
const token = transport.createRuntimeToken();
if (!transport.writeRuntimeConfig(transport.BASE_PORT, token)) process.exit(2);
installer.registerHooks(transport.BASE_PORT);
const raw = fs.readFileSync(installer.SETTINGS_PATH, 'utf8');
const settings = JSON.parse(raw);
const hook = settings.hooks.PermissionRequest.flatMap(g => g.hooks || []).find(h => h.type === 'http');
const result = { url: hook.url, runtimeMode: fs.statSync(transport.RUNTIME_PATH).mode & 0o777, settingsMode: fs.statSync(installer.SETTINGS_PATH).mode & 0o777 };
installer.unregisterHooks();
process.stdout.write(JSON.stringify(result));
`;
const child = spawnSync(process.execPath, ['-e', childCode], {
  encoding: 'utf8',
  env: { ...process.env, HOME: childHome, USERPROFILE: childHome },
});
assert.strictEqual(child.status, 0, child.stderr);
const installResult = JSON.parse(child.stdout);
const permissionUrl = new URL(installResult.url);
assert.strictEqual(permissionUrl.pathname, '/permission');
assert(/^[A-Za-z0-9_-]{32,128}$/.test(permissionUrl.searchParams.get('token') || ''));
if (process.platform !== 'win32') {
  assert.strictEqual(installResult.runtimeMode, 0o600);
  assert.strictEqual(installResult.settingsMode, 0o600);
}
fs.rmSync(childHome, { recursive: true, force: true });


// Startup config readers reject oversized files before allocating them.
const boundedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-bounded-json-'));
const boundedFile = path.join(boundedDir, 'config.json');
fs.writeFileSync(boundedFile, '{}');
fs.truncateSync(boundedFile, 1025);
assert.throws(() => readTextBoundedSync(boundedFile, 1024), (err) => err && err.code === 'EFILETOOBIG');
fs.rmSync(boundedDir, { recursive: true, force: true });

// Static release invariants for Electron renderer hardening.
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const petHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'pet.html'), 'utf8');
const panelHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'panel.html'), 'utf8');
assert(!mainSource.includes('sandbox: false'));
assert((mainSource.match(/sandbox: true/g) || []).length >= 2);
assert(mainSource.includes("trustedHandle('get-config'"));
assert(mainSource.includes("trustedOn('quit-app'"));
assert(mainSource.includes('setPermissionRequestHandler'));
assert(mainSource.includes('setPermissionCheckHandler'));
assert(mainSource.includes("ses.on('will-download'"));
assert(mainSource.includes('webviewTag: false'));
assert(mainSource.includes('installScreenGuards'));
assert(mainSource.includes('display-metrics-changed'));
assert(mainSource.includes('Claude provider disabled — Octopus hooks removed'));
assert(mainSource.includes('CodeWhale stale hooks removed'));
assert(petHtml.includes('Content-Security-Policy'));
assert(panelHtml.includes('Content-Security-Policy'));
assert(petHtml.includes("connect-src 'none'"));

console.log('deep-security: ok');
