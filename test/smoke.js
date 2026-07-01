'use strict';

// Headless end-to-end smoke test of the backend spine (no Electron):
//   hook POST /state  → core → adapter (events + stats)
//   CC   POST /permission (held open) → decidePermission → byte-exact response
// Run: node test/smoke.js

const http = require('http');
const assert = require('assert');
const { createCore } = require('../backend/core');
const { createPermissions } = require('../backend/permission');
const { createServer } = require('../backend/server');
const adapter = require('../backend/adapter');

const events = [];
let dirtyCount = 0;

const core = createCore({
  onActivity: (act) => { for (const ev of adapter.activityToEvents(act)) events.push(ev); },
  onDirty: () => { dirtyCount++; },
});
const permissions = createPermissions({
  onAdded: (entry) => { events.push({ kind: 'waiting', permId: entry.id, sessionId: entry.sessionId }); },
  onChange: () => {},
});
const server = createServer({ core, permissions, shouldDropForDnd: () => false });

function post(pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: server.getPort(), path: pathName, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function get(pathName) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.getPort(), path: pathName }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = 'test-session-aaaa';
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

async function main() {
  server.start();
  for (let i = 0; i < 50 && !server.getPort(); i++) await sleep(20);
  assert(server.getPort(), 'server failed to bind a port');
  console.log('server on', server.getPort());

  console.log('\n[1] health');
  const health = await get('/state');
  check('GET /state returns ok', () => {
    assert.strictEqual(health.status, 200);
    assert.strictEqual(JSON.parse(health.body).app, 'octopus');
    assert.strictEqual(health.headers['x-octopus-server'], 'octopus');
  });

  console.log('\n[2] session lifecycle via /state');
  let r = await post('/state', { state: 'idle', event: 'SessionStart', session_id: SID, cwd: '/Users/me/proj-x' });
  check('SessionStart accepted', () => { assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['x-octopus-server'], 'octopus'); });
  check('greet event emitted', () => assert(events.some((e) => e.kind === 'greet')));

  r = await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: SID, cwd: '/Users/me/proj-x' });
  check('user-turn event emitted', () => assert(events.some((e) => e.kind === 'user-turn')));
  check('session is thinking', () => assert.strictEqual(core.getSession(SID).state, 'thinking'));

  r = await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: SID, cwd: '/Users/me/proj-x' });
  check('operation event for Bash', () => assert(events.some((e) => e.kind === 'operation' && e.tool === 'Bash')));

  r = await post('/state', {
    state: 'attention', event: 'Stop', session_id: SID, cwd: '/Users/me/proj-x',
    assistant_last_output: '我已经修好了那个 bug，并跑通了测试。',
  });
  check('turn-done event emitted', () => assert(events.some((e) => e.kind === 'turn-done')));
  check('say event carries Claude message', () => assert(events.some((e) => e.kind === 'say' && /修好/.test(e.text))));
  check('session requiresCompletionAck after Stop', () => assert.strictEqual(core.getSession(SID).requiresCompletionAck, true));

  console.log('\n[3] unknown state rejected');
  r = await post('/state', { state: 'bogus', event: 'X', session_id: SID });
  check('unknown state → 400', () => assert.strictEqual(r.status, 400));

  console.log('\n[4] permission hold-open → decide allow (byte-exact)');
  const permSid = 'perm-session-bbbb';
  // create the session first so the choice gets a project name
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: permSid, cwd: '/Users/me/proj-y' });
  const permRespP = post('/permission', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, session_id: permSid });
  await sleep(80);
  check('permission is pending', () => assert.strictEqual(permissions.getPending().length, 1));
  const pend = permissions.getPending()[0];
  check('waiting event emitted with permId', () => assert(events.some((e) => e.kind === 'waiting' && e.permId === pend.id)));

  // build the stats the frontend would receive and verify the waiting overlay + choice
  const stats = adapter.buildPetStats(core.buildSnapshot(), permissions.getPending(), null);
  check('stats waitingCount = 1', () => assert.strictEqual(stats.waitingCount, 1));
  check('waiting session has perm choice', () => {
    const ws = stats.sessions.find((s) => s.state === 'waiting');
    assert(ws && ws.choice && ws.choice.kind === 'perm' && ws.choice.permId === pend.id);
    assert(/rm -rf build/.test(ws.choice.question));
  });

  permissions.decide(pend.id, 'allow');
  const permResp = await permRespP;
  check('permission response is byte-exact allow', () => {
    assert.strictEqual(permResp.status, 200);
    assert.strictEqual(permResp.headers['x-octopus-server'], 'octopus');
    assert.deepStrictEqual(JSON.parse(permResp.body), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });
  check('no pending after decide', () => assert.strictEqual(permissions.getPending().length, 0));

  console.log('\n[5] permission deny carries message');
  const denySid = 'deny-session-cccc';
  const denyP = post('/permission', { tool_name: 'Write', tool_input: { file_path: '/etc/hosts' }, session_id: denySid });
  await sleep(60);
  const dpend = permissions.getPending()[0];
  permissions.decide(dpend.id, 'deny');
  const denyResp = await denyP;
  check('deny response shape', () => {
    const j = JSON.parse(denyResp.body);
    assert.strictEqual(j.hookSpecificOutput.decision.behavior, 'deny');
  });

  console.log('\n[6] passthrough tool auto-allowed (not held)');
  const ptResp = await post('/permission', { tool_name: 'TaskCreate', tool_input: {}, session_id: 'pt' });
  check('TaskCreate auto-allow', () => assert.strictEqual(JSON.parse(ptResp.body).hookSpecificOutput.decision.behavior, 'allow'));

  console.log('\n[7] stale permission swept when user answers in terminal');
  const sweepSid = 'sweep-session-dddd';
  const sweepP = post('/permission', { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: sweepSid });
  await sleep(60);
  check('one pending before sweep', () => assert.strictEqual(permissions.getPending().filter((p) => p.sessionId === sweepSid).length, 1));
  await post('/state', { state: 'working', event: 'PostToolUse', tool_name: 'Bash', session_id: sweepSid });
  const sweepResp = await sweepP;
  check('swept perm got deny', () => assert.strictEqual(JSON.parse(sweepResp.body).hookSpecificOutput.decision.behavior, 'deny'));

  server.stop();
  console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILURE(S)'} — events captured: ${events.length}, dirty fires: ${dirtyCount}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
