#!/usr/bin/env bash
# Linux packaging for Octopus desktop pet.
# Produces a portable tar.gz that runs on any x86-64 Linux with glibc >= 2.27.
# (macOS native packaging uses scripts/package-mac.sh — not runnable on Linux.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APPNAME="Octopus"
VERSION=$(node -e 'console.log(require(process.argv[1]).version)' "$ROOT/package.json")
APPDIR="$DIST/$APPNAME-linux-x64-$VERSION"
TARGZ="$DIST/$APPNAME-linux-x64-$VERSION.tar.gz"
SRC_TARGZ="$DIST/$APPNAME-$VERSION-src.tar.gz"
ELECTRON_DIST="$ROOT/node_modules/electron/dist"

if [[ ! -d "$ELECTRON_DIST" ]]; then
  echo "Electron runtime not found. Run 'npm ci' first." >&2
  exit 1
fi

echo "==> Cleaning previous build"
rm -rf "$APPDIR" "$TARGZ" "$SRC_TARGZ"
mkdir -p "$DIST"

echo "==> Copying Electron runtime (linux x64)"
mkdir -p "$APPDIR"
# Copy electron runtime; exclude default_app.asar (we ship our own app code)
cp -R "$ELECTRON_DIST/." "$APPDIR/"
rm -f "$APPDIR/resources/default_app.asar"

echo "==> Installing application code into resources/app"
mkdir -p "$APPDIR/resources/app"
# Explicit manifest copy (same list as package-mac.sh) — avoids accidentally
# shipping docs/test/scripts added later.
for item in main.js preload.js package.json backend renderer assets shared hook providers; do
  if [[ -e "$ROOT/$item" ]]; then
    cp -R "$ROOT/$item" "$APPDIR/resources/app/"
  fi
done

# Linux does not use drag-window.swift (territory is macOS-only); drop it to slim the package.
rm -f "$APPDIR/resources/app/backend/drag-window.swift"

# Strip test files if any leaked in via backend (defensive)
find "$APPDIR/resources/app" -name "*.test.js" -delete 2>/dev/null || true

echo "==> Writing launcher script"
cat > "$APPDIR/run.sh" <<'LAUNCH'
#!/usr/bin/env bash
# Octopus desktop pet — Linux launcher
DIR="$(cd "$(dirname "$0")" && pwd)"
export ELECTRON_RUN_AS_NODE=0
ARGS=()
# Keep Chromium's process sandbox enabled by default. A user who is diagnosing
# a distro-specific sandbox setup failure may explicitly opt out for that run.
if [[ "${OCTOPUS_DISABLE_CHROMIUM_SANDBOX:-0}" == "1" ]]; then
  echo "WARNING: Chromium sandbox disabled for this run." >&2
  ARGS+=(--no-sandbox)
fi
exec "$DIR/electron" "${ARGS[@]}" "$DIR/resources/app/main.js" "$@"
LAUNCH
chmod +x "$APPDIR/run.sh"

echo "==> Writing .desktop entry (for desktop integration)"
cat > "$APPDIR/$APPNAME.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Octopus
Comment=Desktop pet that watches your coding agent
Exec=./run.sh
Icon=resources/app/assets/mascot.png
Terminal=false
Categories=Utility;
DESKTOP

echo "==> Writing README"
cat > "$APPDIR/README-LINUX.txt" <<'README'
Octopus — Desktop Pet (Linux x64 build)
========================================

REQUIREMENTS
- x86-64 Linux, glibc >= 2.27 (Ubuntu 18.04+, Debian 10+, Fedora 30+, Arch)
- X11 or Wayland with XWayland
- ~250 MB free disk

RUN
  ./run.sh

NOTES
- This Linux build runs the core desktop pet (status icons, speech bubbles,
  tray menu, provider abstraction for Claude Code / CodeWhale).
- Territory patrol (pushing rival windows like ChatGPT) is macOS-only and
  disabled on Linux.
- Window dragging uses native mouse events (no macOS SkyLight helper needed).
- Chromium's sandbox is enabled by default. For diagnosis only, set
  OCTOPUS_DISABLE_CHROMIUM_SANDBOX=1 before ./run.sh; do not use this routinely.

PACKAGING SOURCE
  The source release (Octopus-*-src.tar.gz) builds a native .app on macOS via
  `npm ci && npm run package:mac`.
README

echo "==> Building portable tarball: $TARGZ"
tar -czf "$TARGZ" -C "$DIST" "$(basename "$APPDIR")"

echo "==> Building source release: $SRC_TARGZ"
# Source release for users who want to build natively on macOS/Windows.
tar -czf "$SRC_TARGZ" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  -C "$(dirname "$ROOT")" \
  "$(basename "$ROOT")"

echo ""
echo "==> DONE"
echo "    Linux runtime: $TARGZ"
echo "    Source release: $SRC_TARGZ"
echo ""
echo "==> Sizes:"
du -h "$TARGZ" "$SRC_TARGZ" 2>/dev/null || ls -lh "$TARGZ" "$SRC_TARGZ"
