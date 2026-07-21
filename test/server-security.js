'use strict';

const assert = require('assert');
const http = require('http');
const { createCore } = require('../backend/core');
const { createPermissions } = require('../backend/permission');
const { createServer } = require('../backend/server');
const transport = require('../backend/transport');

const core = createCore({ onActivity: () => {}, onDirty: () => {} });
const permissions = createPermissions({ onAdded: () => {}, onChange: () => {} });
const server = createServer({ core, permissions, shouldDropForDnd: () => false });

function request({ path = '/state', method = 'GET', headers = {}, body = '', auth = method === 'POST' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.getPort(),
      path,
      method,
      headers: auth ? { ...headers, [transport.TOKEN_HEADER]: server.getToken() } : headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('condition timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

(async () => {
  server.start();
  await waitFor(() => !!server.getPort());

  const health = await request({ headers: { Host: `127.0.0.1:${server.getPort()}` } });
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.headers[transport.SERVER_HEADER], transport.SERVER_ID);

  const rebound = await request({ headers: { Host: 'attacker.example' } });
  assert.strictEqual(rebound.status, 403, 'DNS-rebinding Host was accepted');

  const browser = await request({ headers: { Origin: 'https://attacker.example' } });
  assert.strictEqual(browser.status, 403, 'browser-origin request was accepted');

  const unauthorizedPayload = JSON.stringify({ state: 'idle', event: 'SessionStart', session_id: 'forged' });
  const unauthorized = await request({
    path: '/state', method: 'POST', auth: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(unauthorizedPayload)) },
    body: unauthorizedPayload,
  });
  assert.strictEqual(unauthorized.status, 401, 'unauthenticated local POST was accepted');

  const wrongType = await request({
    path: '/state', method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': '2' }, body: '{}',
  });
  assert.strictEqual(wrongType.status, 415, 'non-JSON POST was accepted');

  const badJson = await request({
    path: '/codewhale-permission',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
    body: '{',
  });
  assert.strictEqual(JSON.parse(badJson.body).decision, 'deny');

  const nullState = await request({
    path: '/state', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '4' }, body: 'null',
  });
  assert.strictEqual(nullState.status, 400, 'null /state payload crashed or was accepted');

  const nullPermission = await request({
    path: '/codewhale-permission', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '4' }, body: 'null',
  });
  assert.strictEqual(JSON.parse(nullPermission.body).decision, 'deny');

  const noSessionPayload = JSON.stringify({ tool_name: 'Read', tool_input: {} });
  const noSession = await request({
    path: '/codewhale-permission', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(noSessionPayload)) },
    body: noSessionPayload,
  });
  assert.strictEqual(JSON.parse(noSession.body).decision, 'ask');


  const noClaudeSessionPayload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
  const noClaudeSession = await request({
    path: '/permission', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(noClaudeSessionPayload)) },
    body: noClaudeSessionPayload,
  });
  const noClaudeDecision = JSON.parse(noClaudeSession.body);
  assert.strictEqual(noClaudeDecision.hookSpecificOutput.decision.behavior, 'deny');
  assert.strictEqual(permissions.getPending().length, 0, 'missing-session Claude permission entered queue');

  const claudePayload = JSON.stringify({
    tool_name: 'T'.repeat(300),
    tool_input: { command: 'C'.repeat(5000) },
    permission_suggestions: Array.from({ length: 20 }, (_, i) => ({ type: 'addRules', rules: [{ ruleContent: 'R'.repeat(5000) + i }] })),
    session_id: 'Q'.repeat(500),
  });
  const claudePendingPromise = request({
    path: '/permission', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(claudePayload)) },
    body: claudePayload,
  });
  await waitFor(() => permissions.getPending().length === 1);
  const [claudeEntry] = permissions.getPending();
  assert(claudeEntry.toolName.length <= 128);
  assert(claudeEntry.sessionId.length <= 256);
  assert(claudeEntry.toolInput.command.length <= 2001);
  assert(claudeEntry.suggestions.length <= 8);
  permissions.decide(claudeEntry.id, 'deny');
  const claudeDecision = JSON.parse((await claudePendingPromise).body);
  assert.strictEqual(claudeDecision.hookSpecificOutput.decision.behavior, 'deny');

  const oversizedBody = Buffer.alloc(1024 * 1024 + 1, 0x20);
  const declaredTooLarge = await request({
    path: '/codewhale-permission',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(oversizedBody.length) },
    body: oversizedBody,
  });
  assert.strictEqual(JSON.parse(declaredTooLarge.body).decision, 'deny');

  // Dynamic hold-open check: values are normalized before reaching the UI.
  const payload = JSON.stringify({
    tool_name: 'X'.repeat(300) + '\u0000',
    tool_input: { command: 'Y'.repeat(5000) },
    session_id: 'S'.repeat(500),
    mode: 'M'.repeat(100),
    model: 'Z'.repeat(300),
    workspace: '/tmp/' + 'W'.repeat(5000),
  });
  const pendingPromise = request({
    path: '/codewhale-permission',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    body: payload,
  });
  const cw = server.getCwPermissions();
  await waitFor(() => cw.getPending().length === 1);
  const [entry] = cw.getPending();
  assert(entry.toolName.length <= 128);
  assert(entry.sessionId.length <= 256);
  assert(entry.mode.length <= 64);
  assert(entry.model.length <= 128);
  assert(entry.workspace.length <= 4096);
  assert(entry.toolInput.command.length <= 2001);
  cw.decide(entry.id, 'deny');
  assert.strictEqual(JSON.parse((await pendingPromise).body).decision, 'deny');

  server.stop();
  console.log('server-security: ok');
})().catch((err) => {
  try { server.stop(); } catch {}
  console.error(err.stack || err);
  process.exit(1);
});
