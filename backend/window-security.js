'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

function localFileMatches(url, expectedPath) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.host) return false;
    return path.resolve(fileURLToPath(parsed)) === path.resolve(expectedPath);
  } catch {
    return false;
  }
}

function trustedIpcEvent(event, windows) {
  if (!event || !event.sender || !event.senderFrame) return false;
  const frameUrl = event.senderFrame.url;
  for (const item of windows) {
    if (!item || !item.win || item.win.isDestroyed()) continue;
    if (event.sender !== item.win.webContents) continue;
    if (localFileMatches(frameUrl, item.file)) return true;
  }
  return false;
}

function clampBoundsToWorkArea(bounds, workArea) {
  const width = Math.max(1, Math.min(Math.round(bounds.width), Math.max(1, workArea.width)));
  const height = Math.max(1, Math.min(Math.round(bounds.height), Math.max(1, workArea.height)));
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  return {
    x: Math.min(Math.max(Math.round(bounds.x), workArea.x), maxX),
    y: Math.min(Math.max(Math.round(bounds.y), workArea.y), maxY),
    width,
    height,
  };
}

module.exports = { localFileMatches, trustedIpcEvent, clampBoundsToWorkArea };
