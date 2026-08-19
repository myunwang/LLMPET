'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPetDragTrace } = require('../backend/pet-drag-trace');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-drag-trace-'));
  const filePath = path.join(dir, 'pet-drag.jsonl');
  const trace = createPetDragTrace({ filePath, maxBytes: 4096, flushMs: 5 });

  trace.record('renderer', 'pointerdown', {
    dragId: 'drag-1',
    pointer: { x: 120, y: 240, buttons: 1 },
    invalid: Infinity,
  });
  trace.record('main', 'position-applied', {
    dragId: 'drag-1', requested: { x: 300, y: 400 }, actual: { x: 300, y: 400 },
  });
  await trace.flush();

  const rows = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(rows.length, 2, 'batched trace must retain each event');
  assert.strictEqual(rows[0].dragId, 'drag-1');
  assert.strictEqual(rows[0].invalid, String(Infinity), 'non-finite/native-hostile values must remain diagnosable');
  assert(rows[1].seq > rows[0].seq, 'trace sequence must preserve event order');

  for (let i = 0; i < 40; i++) {
    trace.record('renderer', 'position-request', { dragId: 'drag-rotate', frame: i, note: 'x'.repeat(180) });
  }
  await trace.flush();
  trace.record('main', 'rotation-probe', { dragId: 'drag-rotate' });
  await trace.flush();
  assert(fs.existsSync(filePath + '.1'), 'trace must rotate instead of growing without bound');
  assert(fs.readFileSync(filePath, 'utf8').includes('rotation-probe'), 'new trace file must continue after rotation');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('pet drag trace checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
