'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  beginDrag,
  nextDragBounds,
  normalizeHitRegions,
  resizePetLayout,
} = require('../backend/window-drag');

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
const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const expandedRight = resizePetLayout(
  restingBounds,
  { width: 520, height: 520 },
  workArea,
);
assert.deepStrictEqual(
  expandedRight.bounds,
  { x: 1400, y: 496, width: 520, height: 520 },
  'an expanded popup near the right edge must remain fully inside the work area',
);
assert.deepStrictEqual(expandedRight.contentOffset, { x: 76, y: 0 });
assert.strictEqual(
  expandedRight.bounds.x + expandedRight.bounds.width / 2 + expandedRight.contentOffset.x,
  restingBounds.x + restingBounds.width / 2,
  'right-edge clamping must not move the visible pet',
);

assert.deepStrictEqual(
  normalizeHitRegions(
    [
      { x: 90.5, y: 195.25, width: 120, height: 120 },
      { x: -50, y: -40, width: 30, height: 20 },
      { x: 10, y: 10, width: 0, height: 8 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
    ],
    { width: 320, height: 340 },
  ),
  [{ x: 74, y: 179, width: 153, height: 153 }],
  'native Windows hit regions must be padded, integer, clamped and validated',
);
assert.ok(expandedRight.bounds.x >= workArea.x);
assert.ok(expandedRight.bounds.x + expandedRight.bounds.width <= workArea.x + workArea.width);

const collapsedRight = resizePetLayout(
  expandedRight.bounds,
  { width: 320, height: 340 },
  workArea,
  expandedRight.contentOffset,
);
assert.deepStrictEqual(
  collapsedRight.bounds,
  restingBounds,
  'closing the popup must restore the exact dragged resting bounds',
);
assert.deepStrictEqual(collapsedRight.contentOffset, { x: 0, y: 0 });

const leftResting = { x: 24, y: 676, width: 320, height: 340 };
const expandedLeft = resizePetLayout(leftResting, { width: 520, height: 520 }, workArea);
assert.deepStrictEqual(expandedLeft.bounds, { x: 0, y: 496, width: 520, height: 520 });
assert.deepStrictEqual(expandedLeft.contentOffset, { x: -76, y: 0 });
assert.strictEqual(
  expandedLeft.bounds.x + expandedLeft.bounds.width / 2 + expandedLeft.contentOffset.x,
  leftResting.x + leftResting.width / 2,
  'left-edge clamping must not move the visible pet',
);
assert.ok(expandedLeft.bounds.x >= workArea.x);
assert.ok(expandedLeft.bounds.x + expandedLeft.bounds.width <= workArea.x + workArea.width);

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert(/window\.pet\.beginWinDrag\(\)/.test(renderer), 'renderer must begin drag in the main process');
assert(/window\.pet\.updateWinDrag\(\)/.test(renderer), 'renderer must use the main process as cursor authority');
assert(!/window\.pet\.setWinPos\(/.test(renderer), 'renderer must not mix DOM screen coordinates with BrowserWindow bounds');
assert(/beginWinDrag:/.test(preload) && /endWinDrag:/.test(preload), 'preload must expose the drag lifecycle');
assert(/screen\.getCursorScreenPoint\(\)/.test(main), 'main process must sample the cursor in BrowserWindow DIP space');
assert(/if \(st\.drag\) \{ st\.resizeAfterDrag = true; return; \}/.test(main), 'popup resize must be deferred while dragging');
assert(/resizePetLayout\(/.test(main), 'main process must clamp popup windows and calculate a pet offset');
assert(/pet:content-offset/.test(main) && /pet:content-offset/.test(preload), 'pet offset must cross the preload boundary');
assert(/ipcMain\.on\('pet-hit-regions'/.test(main) && /w\.setShape\(shape\)/.test(main),
  'Windows must use a native shaped hit region instead of forwarded transparent-window mousemove');
assert(/process\.platform === 'win32'[\s\S]*w\.setIgnoreMouseEvents\(false\)/.test(main),
  'Windows must keep the shaped window mouse-enabled');
assert(/setHitRegions:/.test(preload) && /window\.pet\.setHitRegions\(regions\)/.test(renderer),
  'visible renderer rectangles must cross the preload boundary');
assert(/new MutationObserver\(schedulePetHitRegions\)/.test(renderer),
  'popup/skin changes must refresh the native shape');
assert(/\.pet-anchor/.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.css'), 'utf8')),
  'renderer must apply the visual pet offset separately from popup layout');

console.log('window drag checks passed');
