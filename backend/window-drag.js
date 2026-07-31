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

// Popups temporarily grow the transparent BrowserWindow around the pet. The
// outer window must remain inside the display work area, while a renderer-side
// content offset keeps the visible pet anchored at the same screen-space
// center and bottom. Carrying the previous offset makes expand -> collapse
// exactly reversible even when the expanded window was clamped at an edge.
function resizePetLayout(windowBounds, intendedSize, workArea, contentOffset = { x: 0, y: 0 }) {
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

  let width = Math.max(1, Math.round(intendedSize.width));
  let height = Math.max(1, Math.round(intendedSize.height));
  const offsetX = Number.isFinite(contentOffset.x) ? contentOffset.x : 0;
  const offsetY = Number.isFinite(contentOffset.y) ? contentOffset.y : 0;
  const centerX = windowBounds.x + windowBounds.width / 2 + offsetX;
  const bottom = windowBounds.y + windowBounds.height + offsetY;

  const validWorkArea = (
    workArea
    && finitePoint(workArea)
    && Number.isFinite(workArea.width)
    && Number.isFinite(workArea.height)
    && workArea.width > 0
    && workArea.height > 0
  );
  if (validWorkArea) {
    width = Math.min(width, Math.round(workArea.width));
    height = Math.min(height, Math.round(workArea.height));
  }

  const idealX = Math.round(centerX - width / 2);
  const idealY = Math.round(bottom - height);
  let x = idealX;
  let y = idealY;
  if (validWorkArea) {
    x = Math.min(
      Math.max(x, Math.round(workArea.x)),
      Math.round(workArea.x + workArea.width - width),
    );
    y = Math.min(
      Math.max(y, Math.round(workArea.y)),
      Math.round(workArea.y + workArea.height - height),
    );
  }

  return {
    bounds: { x, y, width, height },
    contentOffset: { x: idealX - x, y: idealY - y },
  };
}

function resizePetBounds(windowBounds, intendedSize, workArea) {
  return resizePetLayout(windowBounds, intendedSize, workArea).bounds;
}

module.exports = { beginDrag, nextDragBounds, resizePetLayout, resizePetBounds };
