'use strict';

const assert = require('assert');
const geometry = require('../shared/pet-geometry');

const workArea = { x: 0, y: 24, width: 1440, height: 876 };

assert.deepStrictEqual(
  geometry.safeNativeWindowPoint({
    x: 620.4, y: 300.6, current: { x: 0, y: 24 }, maxStep: 32768,
  }),
  { x: 620, y: 301 },
  'an ordinary edge-to-centre drag must remain a valid native position',
);
assert.deepStrictEqual(
  geometry.safeNativeWindowPoint({
    x: -1600, y: 240, current: { x: -1200, y: 220 }, maxStep: 32768,
  }),
  { x: -1600, y: 240 },
  'negative coordinates on a left-hand display must remain valid',
);
assert.strictEqual(
  geometry.safeNativeWindowPoint({ x: 0, y: 2147483648 }),
  null,
  'a finite coordinate outside the native signed-integer range must be rejected',
);
assert.strictEqual(
  geometry.safeNativeWindowPoint({ x: 0, y: Number.MAX_VALUE }),
  null,
  'a huge finite Chromium sentinel must be rejected',
);
assert.strictEqual(
  geometry.safeNativeWindowPoint({
    x: 50000, y: 240, current: { x: 1200, y: 220 }, maxStep: 32768,
  }),
  null,
  'an implausible single pointer-frame jump must not move the native window',
);

assert.deepStrictEqual(
  geometry.correctStalePetAnchor({
    screenX: 1410, screenY: 601, windowX: 1010, windowY: 404,
    width: 120, height: 120, xAlign: 'right', yAlign: 'bottom', xOffset: 0, yOffset: 23,
  }, { x: 810, y: 404, width: 520, height: 340 }),
  {
    screenX: 1210, screenY: 601, windowX: 1010, windowY: 404,
    width: 120, height: 120, xAlign: 'right', yAlign: 'bottom', xOffset: 0, yOffset: 23,
  },
  'a second popup measurement must correct a stale renderer window origin instead of pushing the pet 200px',
);
assert.deepStrictEqual(
  geometry.correctStalePetAnchor({
    screenX: 1263, screenY: 509, windowX: 1123, windowY: 372,
    windowWidth: 320, windowHeight: 340,
    width: 180, height: 180, xAlign: 'right', yAlign: 'bottom', xOffset: 0, yOffset: 23,
  }, { x: 923, y: 372, width: 520, height: 340 }),
  {
    screenX: 1263, screenY: 509, windowX: 1123, windowY: 372,
    windowWidth: 320, windowHeight: 340,
    width: 180, height: 180, xAlign: 'right', yAlign: 'bottom', xOffset: 0, yOffset: 23,
  },
  'a stale compact right-aligned snapshot must not double-count the 200px popup expansion',
);
assert.deepStrictEqual(
  geometry.correctStalePetAnchor({
    screenX: 873, screenY: 620, windowX: 803, windowY: 544,
    windowWidth: 320, windowHeight: 340,
    width: 180, height: 180, xAlign: 'center', yAlign: 'bottom', xOffset: 0, yOffset: 23,
  }, { x: 703, y: 260, width: 520, height: 624 }),
  {
    screenX: 873, screenY: 620, windowX: 803, windowY: 544,
    windowWidth: 320, windowHeight: 340,
    width: 180, height: 180, xAlign: 'center', yAlign: 'bottom', xOffset: 0, yOffset: 23,
  },
  'centre/bottom popup expansion must cancel matching origin and inner-layout changes on both axes',
);
assert.deepStrictEqual(
  geometry.correctStalePetAnchor({ screenX: 80, screenY: 100 }, { x: 20, y: 30 }),
  { screenX: 80, screenY: 100 },
  'legacy anchors without a renderer window snapshot remain backward compatible',
);

// Old saved positions put the transparent window at the top while the visible
// pet remained around its bottom. That must be interpreted as a top-edge drag.
assert.deepStrictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 900, y: 24, width: 320, height: 340 },
    petRect: { x: 100, y: 160, width: 120, height: 140 },
    current: { vertical: 'above', horizontal: 'center' },
  }),
  { vertical: 'below', horizontal: 'center' },
  'top-clamped legacy positions must move the visible pet to the window top',
);

assert.strictEqual(
  geometry.choosePopupLayout({
    workArea,
    windowRect: { x: 900, y: 24, width: 320, height: 340 },
    petRect: { x: 100, y: 0, width: 120, height: 140 },
    current: { vertical: 'below', horizontal: 'center' },
    popupHeight: 360,
  }).vertical,
  'below',
  'a popup opened at the top edge must grow below the pet',
);

assert.strictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 900, y: 280, width: 320, height: 340 },
    petRect: { x: 100, y: 0, width: 120, height: 140 },
    current: { vertical: 'below', horizontal: 'center' },
  }).vertical,
  'above',
  'leaving the top zone must restore bubbles and status above the pet',
);

assert.strictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 900, y: 190, width: 320, height: 340 },
    petRect: { x: 100, y: 0, width: 120, height: 140 },
    current: { vertical: 'below', horizontal: 'center' },
    threshold: 216,
  }).vertical,
  'below',
  'pointerup must not restore the above layout before its real inset fits',
);

assert.deepStrictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 460, y: 24, width: 520, height: 760 },
    petRect: { x: 200, y: 480, width: 120, height: 120 },
    current: { vertical: 'above', horizontal: 'center' },
    threshold: 218,
    inferVerticalFrameClamp: false,
    inferHorizontalFrameClamp: false,
  }),
  { vertical: 'above', horizontal: 'center' },
  'a tall popup clamped to the screen top must not masquerade as a pet edge drag',
);

assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    current: 'above', workArea, targetWindowY: 24, petScreenY: 204, abovePetOffset: 180,
  }),
  'below',
  'dragging the transparent frame into the top boundary must switch before pointerup',
);

assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    current: 'below', workArea, targetWindowY: 80, petScreenY: 80, abovePetOffset: 180,
  }),
  'below',
  'the top layout stays below while a normal above frame would still be off-screen',
);

assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    current: 'below', workArea, targetWindowY: 220, petScreenY: 220, abovePetOffset: 180,
  }),
  'above',
  'dragging back into the desktop restores the normal above layout during the gesture',
);

assert.strictEqual(
  geometry.chooseDragHorizontalLayout({
    current: 'center', workArea, targetWindowX: -1, windowWidth: 520,
    petScreenX: 199, centeredPetOffset: 200,
  }),
  'left',
  'a wide popup must switch to its left anchor before the frame is clipped',
);

assert.strictEqual(
  geometry.chooseDragHorizontalLayout({
    current: 'left', workArea, targetWindowX: 140, windowWidth: 520,
    petScreenX: 340, centeredPetOffset: 200,
  }),
  'center',
  'moving away from the left edge restores the centered popup during the gesture',
);

assert.strictEqual(
  geometry.chooseDragHorizontalLayout({
    current: 'center', workArea, targetWindowX: 921, windowWidth: 520,
    petScreenX: 1121, centeredPetOffset: 200,
  }),
  'right',
  'a wide popup must switch to its right anchor before the frame is clipped',
);

assert.strictEqual(
  geometry.chooseDragHorizontalLayout({
    current: 'right', workArea, targetWindowX: 760, windowWidth: 520,
    petScreenX: 960, centeredPetOffset: 200,
  }),
  'center',
  'moving away from the right edge restores the centered popup during the gesture',
);

assert.strictEqual(
  geometry.windowFitsWorkArea({ x: 460, y: 24, width: 520, height: 624 }, workArea),
  true,
  'a fully visible popup frame is settled',
);
assert.strictEqual(
  geometry.windowFitsWorkArea({ x: -120, y: 24, width: 520, height: 624 }, workArea),
  false,
  'a same-sized popup frame that moved off-screen still needs re-anchoring',
);

assert.deepStrictEqual(
  geometry.adornmentPosition({
    petRect: { x: 880, y: 440, width: 120, height: 120 },
    viewport: { x: 0, y: 0, width: 1040, height: 680 },
    preferred: 'left', size: 28,
  }),
  { side: 'left', x: 847, y: 461.6 },
  'a widened transparent window must keep the tool prop beside the visible pet, not at 15% of the frame',
);

assert.deepStrictEqual(
  geometry.adornmentPosition({
    petRect: { x: 0, y: 140, width: 120, height: 120 },
    viewport: { x: 0, y: 0, width: 520, height: 620 },
    preferred: 'left', size: 28,
  }),
  { side: 'right', x: 125, y: 161.6 },
  'a left-edge pet must flip the prop to its visible right side',
);

assert.strictEqual(
  geometry.choosePopupLayout({
    workArea,
    windowRect: { x: 900, y: 560, width: 320, height: 340 },
    petRect: { x: 100, y: 180, width: 120, height: 140 },
    current: { vertical: 'above', horizontal: 'center' },
    popupHeight: 360,
  }).vertical,
  'above',
  'a popup opened at the bottom edge must stay above the pet',
);

assert.strictEqual(
  geometry.choosePopupLayout({
    workArea,
    windowRect: { x: 700, y: 24, width: 520, height: 624 },
    petRect: { x: 200, y: 309, width: 120, height: 120 },
    current: { vertical: 'above', horizontal: 'center' },
    popupHeight: 310,
  }).vertical,
  'below',
  'one pixel less than the fixed panel height must flip the panel below',
);

assert.strictEqual(
  geometry.choosePopupLayout({
    workArea,
    windowRect: { x: 700, y: 24, width: 520, height: 624 },
    petRect: { x: 200, y: 310, width: 120, height: 120 },
    current: { vertical: 'below', horizontal: 'center' },
    popupHeight: 310,
  }).vertical,
  'above',
  'at exactly one panel height from the top, the panel must return above',
);

function assertMenuInside(label, options) {
  const result = geometry.radialLayout(options);
  assert.strictEqual(result.points.length, options.count, `${label}: every item must receive a position`);
  const safe = options.safeRect;
  for (const point of result.points) {
    assert(point.x >= safe.x + 23 && point.x <= safe.x + safe.width - 23, `${label}: x must be visible`);
    assert(point.y >= safe.y + 23 && point.y <= safe.y + safe.height - 23, `${label}: y must be visible`);
  }
}

function assertSemicircle(label, direction, options) {
  const result = geometry.radialLayout({ ...options, preferred: [direction] });
  assert.strictEqual(result.direction, direction, `${label}: fan must face inward`);
  const first = result.points[0];
  const last = result.points[result.points.length - 1];
  const span = Math.hypot(last.x - first.x, last.y - first.y);
  assert(Math.abs(span - result.radius * 2) < 0.01, `${label}: endpoints must span a full diameter`);
  for (let i = 1; i < result.points.length; i++) {
    const prev = result.points[i - 1];
    const point = result.points[i];
    assert(Math.hypot(point.x - prev.x, point.y - prev.y) >= 46,
      `${label}: neighbouring 46px controls must not overlap`);
  }
}

assertMenuInside('top-left menu', {
  count: 8,
  center: { x: 62, y: 72 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
  preferred: ['right', 'below'],
});

assertSemicircle('left-edge menu', 'right', {
  count: 8,
  center: { x: 62, y: 268 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
});

assertSemicircle('right-edge menu', 'left', {
  count: 8,
  center: { x: 258, y: 268 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
});

assertMenuInside('bottom-right menu', {
  count: 8,
  center: { x: 258, y: 268 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
  preferred: ['above', 'left'],
});

console.log('pet edge geometry checks passed');
