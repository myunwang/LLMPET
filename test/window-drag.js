'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { beginDrag, nextDragBounds, resizePetBounds } = require('../backend/window-drag');

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

const restingBounds = { x: 1576, y: 676, width: 320, height: 340 };
const expandedBounds = resizePetBounds(
  restingBounds,
  { width: 520, height: 520 },
  { x: 0, y: 0, width: 1920, height: 1040 },
);
assert.deepStrictEqual(
  expandedBounds,
  { x: 1476, y: 496, width: 520, height: 520 },
  'expanding a popup near the right edge must keep the dragged pet center and feet fixed',
);
assert.strictEqual(
  expandedBounds.x + expandedBounds.width / 2,
  restingBounds.x + restingBounds.width / 2,
  'popup expansion must not pull the pet left to fit the transparent window on-screen',
);
assert.deepStrictEqual(
  resizePetBounds(
    expandedBounds,
    { width: 320, height: 340 },
    { x: 0, y: 0, width: 1920, height: 1040 },
  ),
  restingBounds,
  'closing the popup must restore the exact dragged resting bounds',
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
