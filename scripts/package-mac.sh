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

# 显式清单拷贝(而非"整仓排除法"):仓库里以后加的文档/素材目录不会被误打进 app。
# hook/ 是安装进 ~/.claude/settings.json 的钩子脚本,shared/ 是主/渲染两端共用的状态表。
for item in main.js preload.js package.json backend renderer assets shared hook; do
  cp -R "$ROOT/$item" "$RESOURCES/app/"
done

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
