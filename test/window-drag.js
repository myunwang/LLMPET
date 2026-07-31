'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { beginDrag, nextDragBounds } = require('../backend/window-drag');

const drag = beginDrag(
  { x: -400, y: -38, width: 323, height: 344 },
  { x: -300, y: 120 },
  { width: 320, height: 340 },
);

assert.deepStrictEqual(
  nextDragBounds(drag, { x: -290, y: 135 }),
  { x: -390, y: -23, width: 320, height: 340 },
  'window movement must equal the main-process cursor delta',
);
assert.strictEqual(
  nextDragBounds(drag, { x: -290, y: 135 }),
  null,
  'a synthetic pointermove caused by moving the window must not reapply identical bounds',
);
assert.deepStrictEqual(
  nextDragBounds(drag, { x: -289, y: 135 }),
  { x: -389, y: -23, width: 320, height: 340 },
  'the intended logical size must not recycle fractionally rounded getBounds dimensions',
);

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert(/window\.pet\.beginWinDrag\(\)/.test(renderer), 'renderer must begin drag in the main process');
assert(/window\.pet\.updateWinDrag\(\)/.test(renderer), 'renderer must use the main process as cursor authority');
assert(!/window\.pet\.setWinPos\(/.test(renderer), 'renderer must not mix DOM screen coordinates with BrowserWindow bounds');
assert(/beginWinDrag:/.test(preload) && /endWinDrag:/.test(preload), 'preload must expose the drag lifecycle');
assert(/screen\.getCursorScreenPoint\(\)/.test(main), 'main process must sample the cursor in BrowserWindow DIP space');
assert(/if \(st\.drag\) \{ st\.resizeAfterDrag = true; return; \}/.test(main), 'popup resize must be deferred while dragging');

console.log('window drag checks passed');
