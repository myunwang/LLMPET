'use strict';

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function beginDrag(windowBounds, cursorPoint, intendedSize) {
  if (!finitePoint(windowBounds) || !finitePoint(cursorPoint)) {
    throw new TypeError('window bounds and cursor point must be finite');
  }
  if (!intendedSize || !Number.isFinite(intendedSize.width) || !Number.isFinite(intendedSize.height)) {
    throw new TypeError('intended window size must be finite');
  }
  return {
    originX: windowBounds.x,
    originY: windowBounds.y,
    cursorX: cursorPoint.x,
    cursorY: cursorPoint.y,
    width: Math.max(1, Math.round(intendedSize.width)),
    height: Math.max(1, Math.round(intendedSize.height)),
    lastX: null,
    lastY: null,
  };
}

// Electron reports cursor points and BrowserWindow bounds in DIP coordinates.
// Re-submit the intended logical size instead of recycling getBounds() dimensions:
// on Windows with a fractional display scale, the rounded dimensions can grow by
// one pixel every time they pass through setBounds().
function nextDragBounds(drag, cursorPoint) {
  if (!drag || !finitePoint(cursorPoint)) return null;
  const x = Math.round(drag.originX + cursorPoint.x - drag.cursorX);
  const y = Math.round(drag.originY + cursorPoint.y - drag.cursorY);
  if (x === drag.lastX && y === drag.lastY) return null;
  drag.lastX = x;
  drag.lastY = y;
  return { x, y, width: drag.width, height: drag.height };
}

module.exports = { beginDrag, nextDragBounds };
