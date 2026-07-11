#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/Octopus.app"
ZIP="$DIST/Octopus-mac-arm64.zip"
ELECTRON_APP="$ROOT/node_modules/electron/dist/Electron.app"
RESOURCES="$APP/Contents/Resources"

if [[ ! -d "$ELECTRON_APP" ]]; then
  echo "Electron runtime not found. Run npm install first." >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$DIST"
cp -R "$ELECTRON_APP" "$APP"
rm -rf "$RESOURCES/app"
mkdir -p "$RESOURCES/app"

rsync -a \
  --exclude '.git' \
  --exclude 'dist' \
  --exclude 'node_modules' \
  --exclude 'test' \
  --exclude 'scripts' \
  "$ROOT/" "$RESOURCES/app/"

/usr/bin/swiftc -O "$ROOT/backend/drag-window.swift" -o "$RESOURCES/drag-window"
chmod +x "$RESOURCES/drag-window"
cp "$ROOT/assets/icon.icns" "$RESOURCES/icon.icns"

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Octopus" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Octopus" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.octopus.pet" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.1.0" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 1" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon.icns" "$PLIST"
if ! /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST" 2>/dev/null; then
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"
fi

codesign --force --deep --sign - "$APP"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
echo "$APP"
echo "$ZIP"
