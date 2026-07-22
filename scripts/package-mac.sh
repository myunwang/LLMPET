#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/LLMPET.app"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
ARCH="$(node -p "process.arch")"
ZIP="$DIST/LLMPET-$VERSION-mac-$ARCH.zip"
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

# 第一阶段正常深签 Electron 的全部嵌套 Framework/Helper；第二阶段只重签顶层
# LLMPET 并写入稳定 designated requirement。不能把自定义 requirement 和
# --deep 放在同一条命令里，否则它会错误套到所有 Electron 子组件上。
codesign --force --deep --sign - "$APP"
# ad-hoc 默认 requirement 是每次构建都变化的 CDHash，导致辅助功能列表虽然
# 仍显示已勾选，新包却被 TCC 当成另一个应用。固定顶层 Bundle ID 后只需授权一次。
codesign --force --sign - \
  --requirements '=designated => identifier "com.octopus.pet"' "$APP"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
echo "$APP"
echo "$ZIP"
