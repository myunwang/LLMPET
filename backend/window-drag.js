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

// Popups temporarily grow the transparent BrowserWindow around the pet. Keep
// the visible pet anchored at the same screen-space center and bottom instead
// of clamping the whole transparent rectangle into the work area: near the
// right edge that clamp pulled the pet left on every status bubble.
function resizePetBounds(windowBounds, intendedSize, workArea) {
  if (
    !finitePoint(windowBounds)
    || !Number.isFinite(windowBounds.width)
    || !Number.isFinite(windowBounds.height)
    || !intendedSize
    || !Number.isFinite(intendedSize.width)
    || !Number.isFinite(intendedSize.height)
  ) {
    throw new TypeError('window bounds and intended size must be finite');
  }

  const width = Math.max(1, Math.round(intendedSize.width));
  let height = Math.max(1, Math.round(intendedSize.height));
  const centerX = windowBounds.x + windowBounds.width / 2;
  const bottom = windowBounds.y + windowBounds.height;
  let y = Math.round(bottom - height);

  if (
    workArea
    && finitePoint(workArea)
    && Number.isFinite(workArea.width)
    && Number.isFinite(workArea.height)
    && workArea.width > 0
    && workArea.height > 0
  ) {
    height = Math.min(height, Math.round(workArea.height));
    y = Math.round(bottom - height);
    y = Math.min(
      Math.max(y, Math.round(workArea.y)),
      Math.round(workArea.y + workArea.height - height),
    );
  }

  return {
    x: Math.round(centerX - width / 2),
    y,
    width,
    height,
  };
}

module.exports = { beginDrag, nextDragBounds, resizePetBounds };
