#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/LLMPET.app"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
ARCH="$(node -p "process.arch")"
SIGN_MODE="${LLMPET_MAC_SIGN_MODE:-release}"
if [[ "$SIGN_MODE" == "release" ]]; then
  ZIP="$DIST/LLMPET-$VERSION-mac-$ARCH.zip"
  # Fail before doing expensive work. A public release must never silently
  # fall back to an ad-hoc signature when Apple credentials are missing.
  node "$ROOT/scripts/sign-notarize-mac.js" --check-env
elif [[ "$SIGN_MODE" == "adhoc" ]]; then
  ZIP="$DIST/LLMPET-$VERSION-mac-$ARCH-unsigned.zip"
else
  echo "Unknown LLMPET_MAC_SIGN_MODE: $SIGN_MODE (expected release or adhoc)" >&2
  exit 2
fi
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
for item in main.js preload.js package.json backend renderer assets shared hook .agents .claude; do
  cp -R "$ROOT/$item" "$RESOURCES/app/"
done
mkdir -p "$RESOURCES/app/scripts"
cp "$ROOT/scripts/register-generated-program.js" "$RESOURCES/app/scripts/"

/usr/bin/swiftc -O "$ROOT/backend/drag-window.swift" \
  -F /System/Library/PrivateFrameworks \
  -framework SkyLight \
  -framework ApplicationServices \
  -framework AppKit \
  -o "$RESOURCES/drag-window"
chmod +x "$RESOURCES/drag-window"
cp "$ROOT/assets/icon.icns" "$RESOURCES/icon.icns"

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName LLMPET" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName LLMPET" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.octopus.pet" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon.icns" "$PLIST"
if ! /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST" 2>/dev/null; then
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"
fi

if [[ "$SIGN_MODE" == "release" ]]; then
  # @electron/osx-sign signs nested Electron components in the required order,
  # enables Hardened Runtime and uses a Developer ID Application identity.
  # @electron/notarize then waits for Apple and staples the returned ticket.
  node "$ROOT/scripts/sign-notarize-mac.js"
else
  # Local development only. The -unsigned filename prevents this artifact from
  # matching the GitHub Release upload pattern.
  codesign --force --deep --sign - "$APP"
  codesign --force --sign - \
    --requirements '=designated => identifier "com.octopus.pet"' "$APP"
fi
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
echo "$APP"
echo "$ZIP"
