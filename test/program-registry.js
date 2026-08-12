'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerProgram, createProgramRegistry } = require('../backend/program-registry');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-programs-'));
  const statePath = path.join(root, 'state', 'generated-programs.json');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const record = registerProgram({
    name: 'Demo', cwd: project, provider: 'codex', verifiedAt: Date.now(),
    launch: { type: 'command', command: 'npm', args: ['run', 'dev'] },
  }, { statePath });
  assert.ok(record.id);

  let launched = null;
  const registry = createProgramRegistry({
    statePath,
    launchCommand: async (item) => { launched = item; return { ok: true }; },
  });
  assert.strictEqual(registry.list().length, 1);
  assert.strictEqual(registry.list()[0].available, true);
  assert.deepStrictEqual(registry.list()[0].launch.args, ['run', 'dev']);
  assert.deepStrictEqual(await registry.launch(record.id), { ok: true });
  assert.strictEqual(launched.id, record.id);
  assert.strictEqual(registry.remove(record.id), true);
  assert.strictEqual(registry.list().length, 0);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('program registry: ok');
}

run().catch((error) => { console.error(error); process.exit(1); });
