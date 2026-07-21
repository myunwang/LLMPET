'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createCodeWhalePermissions } = require('../backend/codewhale-permission');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
    this.body = '';
    this.writableEnded = false;
    this.destroyed = false;
  }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; }
  end(body = '') { this.body += String(body); this.writableEnded = true; }
  decision() { return this.body ? JSON.parse(this.body) : null; }
}

function add(perms, sessionId, toolName = 'Bash', input = {}) {
  const res = new FakeResponse();
  perms.addPermission(res, { sessionId, toolName, toolInput: input });
  return res;
}

// Disabled/DND must fail safe with an explicit native-prompt fallback.
{
  const perms = createCodeWhalePermissions({ shouldDrop: () => true });
  const res = add(perms, 's-drop');
  assert.deepStrictEqual(res.decision().decision, 'ask');
  assert.strictEqual(perms.getPending().length, 0);
}

// A normal decision is held and then returned byte-for-byte as JSON.
{
  const perms = createCodeWhalePermissions();
  const res = add(perms, 's-normal', 'Write', { file_path: 'a.txt', content: 'x' });
  const [entry] = perms.getPending();
  assert(entry && !res.writableEnded);
  assert.strictEqual(perms.decide(entry.id, 'allow'), true);
  assert.strictEqual(res.decision().decision, 'allow');
}

// Invalid batch modes must not resolve or create a hidden rule.
{
  const perms = createCodeWhalePermissions();
  const res = add(perms, 's-invalid', 'Bash');
  const [entry] = perms.getPending();
  assert.strictEqual(perms.decideBatch(entry.id, 'all'), false);
  assert.strictEqual(res.writableEnded, false);
  assert.deepStrictEqual(perms.getBatchRuleCounts(), { sessions: 0, toolSessions: 0 });
  perms.decide(entry.id, 'deny');
}

// "Allow this tool" is scoped to the current session, never global.
{
  const perms = createCodeWhalePermissions();
  const first = add(perms, 'session-A', 'Bash');
  const [entry] = perms.getPending();
  assert.strictEqual(perms.decideBatch(entry.id, 'tool'), true);
  assert.strictEqual(first.decision().decision, 'allow');

  const sameSession = add(perms, 'session-A', 'Bash');
  assert.strictEqual(sameSession.decision().decision, 'allow');
  assert.strictEqual(perms.getPending().length, 0);

  const otherSession = add(perms, 'session-B', 'Bash');
  assert.strictEqual(otherSession.writableEnded, false, 'rule leaked across sessions');
  const otherEntry = perms.getPending()[0];
  perms.decide(otherEntry.id, 'deny');
}

// Rules expire and are removed on SessionEnd.
{
  let now = 1_000;
  const perms = createCodeWhalePermissions({ now: () => now });
  const first = add(perms, 'session-expire', 'Write');
  const [entry] = perms.getPending();
  perms.decideBatch(entry.id, 'session');
  assert.strictEqual(first.decision().decision, 'allow');
  assert.deepStrictEqual(perms.getBatchRuleCounts(), { sessions: 1, toolSessions: 0 });

  now += 31 * 60 * 1000;
  const expired = add(perms, 'session-expire', 'Write');
  assert.strictEqual(expired.writableEnded, false, 'expired rule still auto-allowed');
  perms.sweepForSessionEvent('session-expire', 'SessionEnd');
  assert.strictEqual(expired.decision().decision, 'deny');
  assert.deepStrictEqual(perms.getBatchRuleCounts(), { sessions: 0, toolSessions: 0 });
}

console.log('codewhale-permission-security: ok');
