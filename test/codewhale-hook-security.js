'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const transport = require('../backend/transport');
const hook = require('../hook/codewhale-hook');

function callPermission(body) {
  return new Promise((resolve) => hook.postCodeWhalePermission(body, resolve));
}

function listenMock(handler) {
  return new Promise((resolve, reject) => {
    let index = 0;
    const tryNext = () => {
      if (index >= transport.PORTS.length) return reject(new Error('no free Octopus test port'));
      const port = transport.PORTS[index++];
      const server = http.createServer(handler);
      server.once('error', (err) => {
        server.close();
        if (err.code === 'EADDRINUSE') tryNext();
        else reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolve({ server, port }));
    };
    tryNext();
  });
}

async function withMock(responseHeaders, responseBody, fn) {
  const token = transport.createRuntimeToken();
  const { server, port } = await listenMock((req, res) => {
    assert.strictEqual(req.headers[transport.TOKEN_HEADER], token);
    req.resume();
    res.writeHead(200, responseHeaders);
    res.end(responseBody);
  });
  const runtimePath = transport.RUNTIME_PATH;
  let old = null;
  try { old = fs.readFileSync(runtimePath); } catch {}
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify({ app: transport.SERVER_ID, port, token }), { mode: 0o600 });
  try { await fn(); } finally {
    await new Promise((resolve) => server.close(resolve));
    if (old) fs.writeFileSync(runtimePath, old);
    else { try { fs.unlinkSync(runtimePath); } catch {} }
  }
}

(async () => {
  const body = { tool_name: 'Bash', tool_input_json: '{}', session_id: 's1' };

  await withMock({ [transport.SERVER_HEADER]: transport.SERVER_ID }, '{"decision":"allow"}', async () => {
    const result = await callPermission(body);
    assert.strictEqual(result.decision, 'allow');
  });

  await withMock({}, '{"decision":"allow"}', async () => {
    assert.strictEqual(await callPermission(body), null, 'trusted spoofed response without identity header');
  });

  await withMock({ [transport.SERVER_HEADER]: transport.SERVER_ID }, '{"decision":"maybe"}', async () => {
    assert.strictEqual(await callPermission(body), null, 'accepted invalid decision');
  });

  // End-to-end child process: no runtime/server must emit explicit ask, not empty stdout.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-hook-home-'));
  const child = spawnSync(process.execPath, ['hook/codewhale-hook.js', 'tool_call_before'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      DEEPSEEK_SESSION_ID: 'child-session',
      DEEPSEEK_TOOL_NAME: 'Bash',
      DEEPSEEK_TOOL_ARGS: '{"command":"echo ok"}',
    },
  });
  assert.strictEqual(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout.trim());
  assert.strictEqual(output.decision, 'ask');

  // Oversized stdin fallback is bounded and also returns an explicit ask.
  const oversized = spawnSync(process.execPath, ['hook/codewhale-hook.js', 'tool_call_before'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 5000,
    input: JSON.stringify({ session_id: 'stdin-session', pad: 'x'.repeat(1024 * 1024 + 100) }),
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
  });
  assert.strictEqual(oversized.status, 0, oversized.stderr);
  assert.strictEqual(JSON.parse(oversized.stdout.trim()).decision, 'ask');

  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log('codewhale-hook-security: ok');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
