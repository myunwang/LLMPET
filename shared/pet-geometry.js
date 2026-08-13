'use strict';

// Pure geometry shared by the renderer and regression tests. Keeping the
// decisions here makes the edge cases (top/left/corners) testable without an
// Electron desktop.
(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PetGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function normalizeRect(rect) {
    const x = Number(rect && rect.x) || 0;
    const y = Number(rect && rect.y) || 0;
    const width = Math.max(0, Number(rect && rect.width) || 0);
    const height = Math.max(0, Number(rect && rect.height) || 0);
    return { x, y, width, height, right: x + width, bottom: y + height };
  }

  function chooseRestingLayout({
    workArea,
    windowRect,
    petRect,
    current,
    threshold = 168,
    inferVerticalFrameClamp = true,
    inferHorizontalFrameClamp = true,
  }) {
    const wa = normalizeRect(workArea);
    const wr = normalizeRect(windowRect);
    const pr = normalizeRect(petRect);
    const pet = {
      x: wr.x + pr.x,
      y: wr.y + pr.y,
      width: pr.width,
      height: pr.height,
    };
    pet.right = pet.x + pet.width;
    pet.bottom = pet.y + pet.height;

    const prior = current || { vertical: 'above', horizontal: 'center' };
    // "below" is exclusively a top-edge accommodation. Do not keep it as a
    // sticky historical state after the pet has returned to the desktop: all
    // bubbles/status chips belong above the pet everywhere else.
    let vertical = 'above';
    let horizontal = ['left', 'right'].includes(prior.horizontal) ? prior.horizontal : 'center';

    // The second half of each test catches the old failure mode: macOS has
    // already clamped the transparent window to the work-area edge, while the
    // visible pet is still stranded well inside that window.
    if (pet.y - wa.y <= threshold
      || (inferVerticalFrameClamp && wr.y <= wa.y + 3 && pr.y > 18)) vertical = 'below';

    if (pet.x - wa.x <= threshold
      || (inferHorizontalFrameClamp && wr.x <= wa.x + 3 && pr.x > 18)) horizontal = 'left';
    else if (wa.right - pet.right <= threshold
      || (inferHorizontalFrameClamp && wr.right >= wa.right - 3 && wr.width - pr.right > 18)) horizontal = 'right';
    else if (pet.x - wa.x > threshold * 2 && wa.right - pet.right > threshold * 2) horizontal = 'center';

    return { vertical, horizontal };
  }

  function choosePopupLayout({
    workArea,
    windowRect,
    petRect,
    current,
    popupHeight = 140,
    inferVerticalFrameClamp = true,
    inferHorizontalFrameClamp = true,
  }) {
    const wa = normalizeRect(workArea);
    const wr = normalizeRect(windowRect);
    const pr = normalizeRect(petRect);
    const petTop = wr.y + pr.y;
    const above = Math.max(0, petTop - wa.y);
    const need = Math.max(80, Number(popupHeight) || 0);
    const resting = chooseRestingLayout({
      workArea: wa,
      windowRect: wr,
      petRect: pr,
      current,
      inferVerticalFrameClamp,
      inferHorizontalFrameClamp,
    });

    // 单一规则：只有桌宠本体上方放不下完整卡片时才向下翻；除此之外
    // 一律向上。不要把下方剩余空间、历史方向或当前透明窗口高度掺进来。
    const vertical = above < need ? 'below' : 'above';
    return { vertical, horizontal: resting.horizontal };
  }

  function chooseDragVerticalLayout({
    current,
    workArea,
    targetWindowY,
    petScreenY,
    abovePetOffset,
    boundarySlack = 2,
  }) {
    const wa = normalizeRect(workArea);
    const vertical = current === 'below' ? 'below' : 'above';
    const edgeY = wa.y + Math.max(0, Number(boundarySlack) || 0);
    if (vertical === 'above') {
      return Number(targetWindowY) <= edgeY ? 'below' : 'above';
    }
    const normalWindowY = Number(petScreenY) - Math.max(0, Number(abovePetOffset) || 0);
    return normalWindowY >= edgeY ? 'above' : 'below';
  }

  function chooseDragHorizontalLayout({
    current,
    workArea,
    targetWindowX,
    windowWidth,
    petScreenX,
    centeredPetOffset,
    boundarySlack = 2,
  }) {
    const wa = normalizeRect(workArea);
    const horizontal = ['left', 'right'].includes(current) ? current : 'center';
    const slack = Math.max(0, Number(boundarySlack) || 0);
    const width = Math.max(1, Number(windowWidth) || 1);
    if (horizontal === 'center') {
      if (Number(targetWindowX) <= wa.x + slack) return 'left';
      if (Number(targetWindowX) + width >= wa.right - slack) return 'right';
      return 'center';
    }
    const centeredWindowX = Number(petScreenX) - Math.max(0, Number(centeredPetOffset) || 0);
    if (horizontal === 'left') return centeredWindowX >= wa.x + slack ? 'center' : 'left';
    return centeredWindowX + width <= wa.right - slack ? 'center' : 'right';
  }

  function windowFitsWorkArea(windowRect, workArea, slack = 1) {
    const wr = normalizeRect(windowRect);
    const wa = normalizeRect(workArea);
    const s = Math.max(0, Number(slack) || 0);
    return wr.x >= wa.x - s && wr.y >= wa.y - s
      && wr.right <= wa.right + s && wr.bottom <= wa.bottom + s;
  }

  function adornmentPosition({
    petRect,
    viewport,
    preferred = 'left',
    size = 28,
    gap = 5,
    edgePad = 4,
  }) {
    const pet = normalizeRect(petRect);
    const frame = normalizeRect(viewport);
    const adornmentSize = Math.max(12, Number(size) || 28);
    const space = Math.max(0, Number(gap) || 0);
    const pad = Math.max(0, Number(edgePad) || 0);
    const leftRoom = pet.x - frame.x - pad;
    const rightRoom = frame.right - pet.right - pad;
    let side = preferred === 'right' ? 'right' : 'left';
    const needed = adornmentSize + space;
    if (side === 'left' && leftRoom < needed && rightRoom > leftRoom) side = 'right';
    if (side === 'right' && rightRoom < needed && leftRoom > rightRoom) side = 'left';

    const rawX = side === 'left'
      ? pet.x - space - adornmentSize
      : pet.right + space;
    // Tool props sit by the pet's temple rather than at a percentage of the
    // transparent BrowserWindow. This remains close even when a popup widens
    // the frame or the pet is anchored against a side edge.
    const rawY = pet.y + Math.min(24, Math.max(5, pet.height * 0.18));
    return {
      side,
      x: clamp(rawX, frame.x + pad, frame.right - adornmentSize - pad),
      y: clamp(rawY, frame.y + pad, frame.bottom - adornmentSize - pad),
    };
  }

  const ARCS = {
    // A real 180-degree fan. The previous 156-degree arcs compressed eight
    // 46px controls until they overlapped into a heart-shaped cluster.
    above: { start: 180, end: 360 },
    below: { start: 0, end: 180 },
    right: { start: -90, end: 90 },
    left: { start: 90, end: 270 },
  };

  function arcPoints(direction, count, center, radius) {
    const arc = ARCS[direction];
    const points = [];
    for (let i = 0; i < count; i++) {
      const ratio = count === 1 ? 0.5 : i / (count - 1);
      const angle = (arc.start + (arc.end - arc.start) * ratio) * Math.PI / 180;
      points.push({
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      });
    }
    return points;
  }

  function radialLayout({ count, center, safeRect, preferred = [], radius = 106, itemRadius = 23 }) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return { direction: 'above', radius, points: [] };
    const safe = normalizeRect(safeRect);
    const directions = [...new Set([...preferred, 'above', 'below', 'right', 'left'])]
      .filter((direction) => ARCS[direction]);
    const radii = [...new Set([radius, 100, 94, 88, 80, 72].map((r) => Math.max(48, Number(r) || 0)))];
    let best = null;

    for (const direction of directions) {
      for (const candidateRadius of radii) {
        const adjustedCenter = { x: center.x, y: center.y };
        // At a left/right edge a full semicircle needs its two end buttons to
        // fit vertically. Move only the fan's centre line, never the pet or
        // the fan's inward-facing x anchor.
        if (direction === 'left' || direction === 'right') {
          adjustedCenter.y = clamp(
            adjustedCenter.y,
            safe.y + itemRadius + candidateRadius,
            safe.bottom - itemRadius - candidateRadius,
          );
        }
        const raw = arcPoints(direction, n, adjustedCenter, candidateRadius);
        let overflow = 0;
        for (const point of raw) {
          overflow += Math.max(0, safe.x + itemRadius - point.x);
          overflow += Math.max(0, point.x - (safe.right - itemRadius));
          overflow += Math.max(0, safe.y + itemRadius - point.y);
          overflow += Math.max(0, point.y - (safe.bottom - itemRadius));
        }
        const candidate = { direction, radius: candidateRadius, center: adjustedCenter, raw, overflow };
        if (!best || candidate.overflow < best.overflow) best = candidate;
        if (overflow === 0) {
          return { direction, radius: candidateRadius, center: adjustedCenter, points: raw };
        }
      }
    }

    const points = (best ? best.raw : []).map((point) => ({
      x: clamp(point.x, safe.x + itemRadius, safe.right - itemRadius),
      y: clamp(point.y, safe.y + itemRadius, safe.bottom - itemRadius),
    }));
    return {
      direction: best ? best.direction : directions[0],
      radius: best ? best.radius : radius,
      center: best ? best.center : center,
      points,
    };
  }

  return {
    chooseRestingLayout,
    choosePopupLayout,
    chooseDragVerticalLayout,
    chooseDragHorizontalLayout,
    windowFitsWorkArea,
    adornmentPosition,
    radialLayout,
  };
});
