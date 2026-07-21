'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-cw-provider-'));
const sessions = path.join(root, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
process.env.CODEWHALE_HOME = root;
const provider = require('../providers/codewhale');

try {
  for (let i = 0; i < 60; i++) {
    const id = `s-${String(i).padStart(2, '0')}`;
    const updated = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({
      metadata: { id, title: `session ${i}`, updated_at: updated },
      messages: [{ role: 'assistant', content: [{ type: 'text', text: `ok ${i}` }] }],
    }));
  }
  assert.strictEqual(provider.listSessions().length, 50, 'session list is not capped at 50');
  assert.strictEqual(provider.listSessions()[0].id, 's-59', 'session list is not sorted by metadata updated_at');
  assert.strictEqual(provider.readTranscriptTail('s-59')[0].role, 'assistant');

  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ messages: [{ role: 'assistant', content: 'secret' }] }));
  assert.strictEqual(provider.readTranscriptTail(outside), null, 'absolute path escaped sessions directory');

  const link = path.join(sessions, 'link.json');
  try {
    fs.symlinkSync(outside, link);
    assert.strictEqual(provider.readTranscriptTail(link), null, 'symlink escaped sessions directory');
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
  }

  const huge = path.join(sessions, 'huge.json');
  fs.writeFileSync(huge, '{}');
  fs.truncateSync(huge, 16 * 1024 * 1024 + 1);
  assert.strictEqual(provider.readTranscriptTail(huge), null, 'oversized session file was read');

  // Even when many individually-allowed files exist, listing sessions must not
  // synchronously read more than the global 64 MiB main-thread budget.
  const budgetFiles = [];
  for (let i = 0; i < 20; i++) {
    const file = path.join(sessions, `budget-${i}.json`);
    fs.writeFileSync(file, '{}');
    fs.truncateSync(file, 4 * 1024 * 1024);
    const t = new Date(Date.now() + 10000 + i * 1000);
    fs.utimesSync(file, t, t);
    budgetFiles.push(file);
  }
  const originalRead = fs.readFileSync;
  let sessionBytesRead = 0;
  fs.readFileSync = function patched(file, ...args) {
    const resolved = path.resolve(String(file));
    if (budgetFiles.includes(resolved)) sessionBytesRead += fs.statSync(resolved).size;
    return originalRead.call(this, file, ...args);
  };
  try { provider.listSessions(); } finally { fs.readFileSync = originalRead; }
  assert(sessionBytesRead <= 64 * 1024 * 1024, `session scan exceeded budget: ${sessionBytesRead}`);

  console.log('codewhale-provider-security: ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
