'use strict';

const assert = require('assert');
const { parseElapsed, parsePs, processMeta, classify, createRuntimeMonitor } = require('../backend/runtime-monitor');

assert.strictEqual(parseElapsed('01:02'), 62);
assert.strictEqual(parseElapsed('2-03:04:05'), 183845);

const rows = parsePs([
  '  100     1  00:12 S  0.0  0.2 /usr/bin/python3 -m useful_worker run',
  '  101   100  00:11 S  4.2  1.1 /usr/bin/python3 /Users/me/train.py --epochs 2',
  '  102     1  01:02 S  0.1  0.4 /Users/me/.local/bin/codex app-server --listen stdio://',
  '  103     1  01:00 S  0.0  0.3 /Applications/Chrome.app/Contents/Frameworks/Helper --type=renderer',
  '  104     1  00:40 S  0.1  0.4 /opt/homebrew/bin/dsh web',
  '  105     1  00:30 S  0.1  0.4 /opt/homebrew/bin/dsh --profile headless run-the-tests',
  '  106     1  00:20 S  0.1  0.4 /opt/homebrew/bin/dsh --profile tui --resume session-123',
  '  107     1  00:10 S  0.1  0.4 /usr/local/bin/node /Users/me/node_modules/@deepseek-ai/dsh/lib/bin.js --profile tui',
  '  108     1  00:09 S  0.1  0.4 /usr/local/bin/npx --yes @deepseek-ai/dsh web',
].join('\n'));
assert.strictEqual(rows.length, 9);
assert.strictEqual(processMeta(rows[0]).label, 'python3 · useful_worker');
assert.strictEqual(processMeta(rows[1]).label, 'python3 · train.py');
assert.strictEqual(processMeta(rows[2]).provider, 'codex');
assert.strictEqual(processMeta(rows[3]), null);
for (const [index, label] of [[4, 'dsh · Web'], [5, 'dsh · Headless'], [6, 'dsh · TUI'], [7, 'dsh · TUI'], [8, 'dsh · Web']]) {
  const meta = processMeta(rows[index]);
  assert.deepStrictEqual(meta, { kind: 'agent', provider: 'dsh', label });
}

const items = classify(rows, { selfPid: 999 });
assert.strictEqual(items.length, 8);
assert.strictEqual(items[0].pid, 101, 'newest concrete script sorts first');
assert.strictEqual(items[1].pid, 100, 'script runners stay ahead of agent infrastructure');

let changes = 0;
const monitor = createRuntimeMonitor({
  selfPid: 999, intervalMs: 999999,
  listProcesses: (done) => done(null, rows),
  onChange: () => { changes++; },
});
monitor.scanNow().then((snapshot) => {
  assert.strictEqual(snapshot.running, 8);
  assert.strictEqual(snapshot.scripts, 2);
  assert.strictEqual(snapshot.agents, 6);
  assert.ok(snapshot.lastScanAt > 0);
  assert.strictEqual(changes, 1);
  console.log('runtime monitor checks passed');
}).catch((error) => { console.error(error); process.exit(1); });
