'use strict';

// Cross-platform tray icon resolver. (W5: Windows adaptation enhancement.)
//
// - darwin/linux: returns assets/tray.png (darwin sets template image in main.js).
// - win32: generates a multi-size tray.ico from assets/tray@2x.png on first run,
//   caches it in Electron's userData dir, returns the .ico path. Falls back to
//   tray.png on any error (graceful degradation).
//
// Why .ico on Windows: the Windows taskbar auto-adapts .ico to light/dark mode
// and renders crisply at all DPI scales. A plain PNG works but looks
// inconsistent across themes and DPI settings.
//
// Why runtime generation (not build-time): avoids a packaging step; the .ico
// is regenerated automatically if tray@2x.png changes (mtime check). This
// keeps the source-of-truth as a single PNG.
//
// png-to-ico v3 API note: the package is ESM-transpiled, so
// `require('png-to-ico')` returns `{ __esModule, default, imagesToIco }`.
// We use `.default` (falls back to the module itself for older versions).
// A single square PNG input auto-generates 4 sizes (48/32/16/256) — we don't
// need to pre-resize with nativeImage. tray@2x.png is 36x36 square, png-to-ico
// resizes to 256 internally then derives the smaller sizes.

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const PNG_PATH = path.join(ASSETS_DIR, 'tray.png');
const SRC_HQ_PATH = path.join(ASSETS_DIR, 'tray@2x.png'); // 36x36 square source

// png-to-ico's default size set (for documentation; the library generates
// these automatically from a single square input).
const ICO_SIZES = [16, 32, 48, 256];

// Synchronous: returns the best icon path for the current platform RIGHT NOW.
// If win32 and a valid cached .ico exists, returns its path; otherwise returns
// the PNG path (and the caller should kick off ensureTrayIcon() to make the
// .ico available for next time / live-swap).
function getTrayIconPath() {
  if (process.platform !== 'win32') return PNG_PATH;
  try {
    const { app } = require('electron');
    const icoPath = path.join(app.getPath('userData'), 'tray.ico');
    if (icoIsFresh(icoPath)) return icoPath;
  } catch {}
  return PNG_PATH;
}

// Asynchronous: makes sure the .ico exists and is up-to-date. Resolves to the
// .ico path on success, or null on failure (caller falls back to PNG).
// Safe to call multiple times; coalesces concurrent calls via the in-flight
// promise cache.
let inflight = null;
function ensureTrayIcon() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const mod = require('png-to-ico');
      const pngToIco = mod.default || mod;
      const { app } = require('electron');
      const userDataDir = app.getPath('userData');
      const icoPath = path.join(userDataDir, 'tray.ico');
      if (!fs.existsSync(SRC_HQ_PATH)) return null;
      if (icoIsFresh(icoPath)) return icoPath; // fresh cache
      // Single square PNG → pngToIco auto-generates 4 sizes (48/32/16/256).
      const srcBuf = fs.readFileSync(SRC_HQ_PATH);
      const icoBuf = await pngToIco(srcBuf);
      if (!Buffer.isBuffer(icoBuf) || icoBuf.length < 100) return null;
      fs.mkdirSync(userDataDir, { recursive: true });
      // Atomic write: tmp + rename.
      const tmp = path.join(userDataDir, `.tray.${process.pid}.${Date.now()}.ico.tmp`);
      fs.writeFileSync(tmp, icoBuf);
      fs.renameSync(tmp, icoPath);
      return icoPath;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function icoIsFresh(icoPath) {
  try {
    if (!fs.existsSync(icoPath)) return false;
    if (!fs.existsSync(SRC_HQ_PATH)) return false;
    return fs.statSync(icoPath).mtimeMs >= fs.statSync(SRC_HQ_PATH).mtimeMs;
  } catch {
    return false;
  }
}

module.exports = { getTrayIconPath, ensureTrayIcon, ICO_SIZES, PNG_PATH, SRC_HQ_PATH };
