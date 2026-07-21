#!/usr/bin/env bash
# Windows packaging for Octopus desktop pet.
# Builds a portable .zip that runs on Windows 10 1809+ / Windows 11 x64.
#
# Approach: download the official win32-x64 Electron zip from the npm mirror,
# drop our app code into resources/app, add a launcher .bat, and zip it up.
# (We can't produce a signed .exe installer on Linux, but a portable zip is
# fully runnable on Windows — users just unzip and double-click run.bat.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APPNAME="Octopus"
VERSION=$(node -e 'console.log(require(process.argv[1]).version)' "$ROOT/package.json")
ELECTRON_VER=$(node -e 'console.log(require(process.argv[1]).version)' "$ROOT/node_modules/electron/package.json")
WIN_DIR="$DIST/$APPNAME-win-x64-$VERSION"
ZIP="$DIST/$APPNAME-win-x64-$VERSION.zip"
ELECTRON_ZIP_CACHE="$DIST/electron-v$ELECTRON_VER-win32-x64.zip"
WIN_ELECTRON_URL="https://npmmirror.com/mirrors/electron/$ELECTRON_VER/electron-v$ELECTRON_VER-win32-x64.zip"

echo "==> Octopus Windows x64 build (Electron $ELECTRON_VER, app $VERSION)"

# --- 1. obtain win32 electron zip (cache to avoid re-downloading 100MB) -----
if [[ ! -f "$ELECTRON_ZIP_CACHE" ]]; then
  echo "==> Downloading win32-x64 Electron $ELECTRON_VER (~100MB)"
  echo "    from $WIN_ELECTRON_URL"
  mkdir -p "$DIST"
  curl -fL --progress-bar -o "$ELECTRON_ZIP_CACHE" "$WIN_ELECTRON_URL"
else
  echo "==> Using cached Electron zip: $ELECTRON_ZIP_CACHE"
fi
if [[ ! -s "$ELECTRON_ZIP_CACHE" ]]; then
  echo "Download failed — $ELECTRON_ZIP_CACHE is empty" >&2
  exit 1
fi

# --- 2. clean & extract -----------------------------------------------------
echo "==> Cleaning previous build"
rm -rf "$WIN_DIR"
mkdir -p "$WIN_DIR"

echo "==> Extracting Electron runtime"
# Electron win32 zip layout: electron.exe, resources/default_app.asar, *.dll,
# locales/, etc. — all at the archive root.
unzip -q "$ELECTRON_ZIP_CACHE" -d "$WIN_DIR"

# Verify electron.exe landed at top level
if [[ ! -f "$WIN_DIR/electron.exe" ]]; then
  echo "electron.exe not found after extraction — archive layout changed?" >&2
  ls -la "$WIN_DIR" | head
  exit 1
fi

# Remove the default app so our app takes over
rm -f "$WIN_DIR/resources/default_app.asar"

# --- 2b. rename electron.exe → Octopus.exe (branded executable) --------------
# Electron supports renaming its exe — the app name comes from package.json,
# not the binary name. A renamed exe still loads resources/app/main.js.
# This gives users a proper "Octopus.exe" in Task Manager / file explorer
# instead of the generic "electron.exe". (User request: "构建完整的exe")
echo "==> Renaming electron.exe → Octopus.exe"
mv "$WIN_DIR/electron.exe" "$WIN_DIR/Octopus.exe"

# --- 2c. set the exe icon to the octopus mascot (W16/W20) -------------------
# Generate a square mascot icon (256x256 center-crop of mascot.png) for use
# as the app icon. The square PNG is used at runtime via BrowserWindow's icon
# option (shows octopus in the taskbar). We also generate an app.ico and bundle
# it — on Windows the user can right-click Octopus.exe → Properties → Change
# Icon to apply it if they want the Explorer icon too.
#
# Note: embedding the icon directly into the 188MB Octopus.exe via resedit
# requires loading the entire PE into memory (OOM-killed on this Linux box).
# On a real Windows build machine, `rcedit Octopus.exe --set-icon app.ico`
# would do this in one shot. We ship app.ico so the user/machine can do it.
APP_ICO="$WIN_DIR/resources/app.ico"
SQUARE_PNG="$ROOT/assets/mascot-icon.png"

# mascot-icon.png is a tracked 256x256 build input. Failing explicitly is
# preferable to a hidden optional `sharp` dependency that was absent from the lockfile.
if [[ ! -f "$SQUARE_PNG" ]]; then
  echo "Missing required build asset: $SQUARE_PNG" >&2
  exit 1
fi

# Generate app.ico from the square PNG and bundle it alongside the exe.
node -e "
const pngToIco = require('png-to-ico').default || require('png-to-ico');
const fs = require('fs');
const src = fs.readFileSync('$SQUARE_PNG');
pngToIco(src).then(buf => {
  fs.writeFileSync('$APP_ICO', buf);
  console.log('app.ico bundled:', buf.length, 'bytes');
}).catch(e => { console.error('ico gen failed:', e.message); });
" || echo "==> (warning) app.ico generation skipped"

# --- 3. install application code -------------------------------------------
echo "==> Installing application code into resources/app"
mkdir -p "$WIN_DIR/resources/app"
# Same explicit manifest as package-linux.sh / package-mac.sh.
for item in main.js preload.js package.json package-lock.json backend renderer assets shared hook providers; do
  if [[ -e "$ROOT/$item" ]]; then
    cp -R "$ROOT/$item" "$WIN_DIR/resources/app/"
  fi
done

# drag-window.swift is macOS-only (territory) — drop it for Windows.
rm -f "$WIN_DIR/resources/app/backend/drag-window.swift"

# Install the production dependency graph into the portable app. In particular,
# png-to-ico is required at runtime for Windows tray icon generation; omitting
# node_modules made the packaged build silently fall back to PNG.
echo "==> Installing production runtime dependencies"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$WIN_DIR/resources/app"

# Strip stray test files (defensive)
find "$WIN_DIR/resources/app" -name "*.test.js" -delete 2>/dev/null || true

# --- 4. launcher .bat -------------------------------------------------------
echo "==> Writing launcher (run.bat)"
cat > "$WIN_DIR/run.bat" <<'BAT'
@echo off
REM Octopus desktop pet - Windows launcher
REM Runs in portable mode: app code lives in resources\app next to Octopus.exe.
setlocal
cd /d "%~dp0"
set "SANDBOX_ARG="
if "%OCTOPUS_DISABLE_CHROMIUM_SANDBOX%"=="1" (
  echo WARNING: Chromium sandbox disabled for this run.
  set "SANDBOX_ARG=--no-sandbox"
)
start "" Octopus.exe %SANDBOX_ARG% resources\app\main.js %*
endlocal
BAT

# --- 4b. create-desktop-shortcut.bat (optional, sets octopus icon) ----------
# Creates a desktop shortcut to Octopus.exe with the octopus icon. Users who
# want the octopus icon in Explorer/Start Menu can run this once.
echo "==> Writing create-desktop-shortcut.bat"
cat > "$WIN_DIR/create-desktop-shortcut.bat" <<'BAT'
@echo off
REM Creates a desktop shortcut to Octopus with the octopus icon.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Octopus.lnk'); $lnk.TargetPath='%~dp0Octopus.exe'; $lnk.Arguments='resources\app\main.js'; $lnk.IconLocation='%~dp0resources\app.ico'; $lnk.WorkingDirectory='%~dp0'; $lnk.Description='Octopus desktop pet'; $lnk.Save(); Write-Host 'Desktop shortcut created with octopus icon.'"
endlocal
BAT

# --- 4c. uninstall-hooks.bat ------------------------------------------------
echo "==> Writing uninstall-hooks.bat"
cat > "$WIN_DIR/uninstall-hooks.bat" <<'BAT'
@echo off
REM Run the bundled Electron executable in Node mode so the CLI script executes
REM without starting a GUI instance.
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=1
Octopus.exe resources\app\backend\hookinstall.js --uninstall
set "RC=%ERRORLEVEL%"
set ELECTRON_RUN_AS_NODE=
exit /b %RC%
BAT

# --- 5. README for Windows users -------------------------------------------
cat > "$WIN_DIR/README-WINDOWS.txt" <<'README'
Octopus - Desktop Pet (Windows x64 portable build)
===================================================

REQUIREMENTS
- Windows 10 1809+ or Windows 11, x64
- ~250 MB free disk
- Claude Code (npm install -g @anthropic-ai/claude-code) and/or CodeWhale
  (npm install -g codewhale) - the pet watches these via their hook interfaces.

RUN
  Double-click run.bat
  (or from PowerShell/cmd: .\Octopus.exe resources\app\main.js)

ICON (optional)
  The taskbar icon shows the octopus mascot automatically (via Electron's
  runtime icon option). To also get the octopus icon on your desktop /
  Start Menu, run create-desktop-shortcut.bat once — it creates a shortcut
  pointing to Octopus.exe with the bundled app.ico (octopus mascot).

FIRST RUN
- A tray icon appears (multi-size .ico auto-generated from assets/tray@2x.png).
- Hooks are registered into %USERPROFILE%\.claude\settings.json (merge-safe).
- If you enable the CodeWhale provider, hooks go into
  %USERPROFILE%\.codewhale\config.toml.

KNOWN WINDOWS LIMITATIONS (by design - see WINDOWS.md in source)
- Focus tracking ("go to reply" terminal focus): not implemented on Windows.
  Use Alt+Tab to switch to the terminal manually.
- Territory patrol (pushing rival desktop pets): macOS-only.
- Everything else (status icons, speech bubbles, permission prompts, token
  metering, session list, tray menu, provider switching) works fully.

UNINSTALL HOOKS
- Right-click tray icon -> "卸载所有钩子" (uninstall all hooks), or run:
    uninstall-hooks.bat

SANDBOX TROUBLESHOOTING
- Chromium's sandbox is enabled by default. Only for diagnosis, set
  OCTOPUS_DISABLE_CHROMIUM_SANDBOX=1 before run.bat. Do not use routinely.

BUILD FROM SOURCE
  The source release (Octopus-*-src.tar.gz) lets you build natively:
  npm ci && npm start         (development)
  On macOS: npm run package:mac
  On Linux:  bash scripts/package-linux.sh
README

# --- 6. zip it up -----------------------------------------------------------
echo "==> Building portable zip: $ZIP"
rm -f "$ZIP"
# -X skips extra file attributes (cleaner on Windows extraction).
( cd "$DIST" && zip -qr -X "$ZIP" "$(basename "$WIN_DIR")" )

echo ""
echo "==> DONE"
echo "    Windows portable: $ZIP"
echo ""
echo "==> Size:"
du -h "$ZIP" 2>/dev/null || ls -lh "$ZIP"
