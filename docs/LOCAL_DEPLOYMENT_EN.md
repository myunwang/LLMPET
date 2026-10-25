# Deploy LLMPET locally

This guide covers running and testing LLMPET from source and creating packages for local development validation.

## Supported targets

| Platform | From source | Notes |
| --- | --- | --- |
| macOS Apple Silicon | Supported | Patrol requires Accessibility permission |
| Windows x64 | Supported | Session focus, patrol, Codex pet loot and memes supported |
| Linux | Not officially supported | Window focusing is not implemented |

Claude Code and/or OpenAI Codex must already be installed and used at least once.

## First launch

- Claude Code hooks are merged into `~/.claude/settings.json`; existing hooks are preserved.
- Codex configuration is not modified. LLMPET read-only tails `~/.codex/sessions/YYYY/MM/DD/*.jsonl`.
- LLMPET configuration and usage history live in `~/.octopus/`.
- Logs are written to `~/.octopus/octopus.log`.

## Run from source

Requirements: Git, preferably Node.js 22 (22.12.0 or a newer 22.x), and Claude Code and/or OpenAI Codex. `.nvmrc`, Electron installation checks, and release builds use Node.js 22.

```bash
git clone https://github.com/myunwang/LLMPET.git
cd LLMPET
npm ci
npm run install:electron
npm test
npm start
```

`npm ci` installs the dependency versions pinned in `package-lock.json`. `npm run install:electron` explicitly installs the desktop runtime. `npm start` runs LLMPET in the foreground. `npm run test:electron` requires a graphical session and checks real windows, IPC, permissions, and completion bubbles.

Runtime maintenance (#31): Electron is pinned to **44.9.3** and electron-builder to **26.18.0**. Startup logs include the actual Electron, Chromium, and embedded Node versions. As of 2026-10-24, Electron 44 is a [supported branch](https://releases.electronjs.org/); recheck support when updating. Run `npm audit` (including dev dependencies), `npm test`, and `npm run test:electron` before rebuilding platform packages. Set `LLMPET_SMOKE_OUTPUT` to save desktop screenshots and runtime versions. Desktop tests use temporary data.

Useful launch variants:

```bash
OCTOPUS_NO_HOOKS=1 npm start  # do not modify Claude settings
OCTOPUS_NO_NET=1 npm start    # disable the optional pricing download
```

PowerShell:

```powershell
$env:OCTOPUS_NO_HOOKS='1'
npm start
```

If Electron downloads are slow:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run install:electron
```

PowerShell:

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci
npm run install:electron
```

### Incomplete Electron installation or startup failure

Windows + Node.js 26 has a startup failure report in [#28](https://github.com/myunwang/LLMPET/issues/28); the reporter recovered with Node.js 20. The locked `@electron/rebuild` packaging dependency requires Node.js ≥22.12.0, so prefer 22.x for both installation and packaging. CI uses Node.js 22/24 and separately tests Electron installation and desktop behavior on macOS and Windows.

Electron 33 reports `Electron failed to install correctly` when its generated `path.txt` is missing. Failed downloads, disabled install scripts, or `ELECTRON_SKIP_BINARY_DOWNLOAD` can cause this state; the message alone does not establish a Node.js 26 incompatibility.

1. Switch to Node.js 22 (22.12.0+) and confirm with `node --version` in a new terminal. With nvm on macOS/Linux, run `nvm install` and `nvm use` in the repository to use `.nvmrc`; on Windows, switch with your Node version manager.
2. Reinstall from the project directory (`npm ci` recreates dependencies and preserves the lockfile):

   ```bash
   npm ci --foreground-scripts
   npm run install:electron
   npm run check:electron
   npm start
   ```

3. Electron 44 downloads its binary on demand; `npm ci` alone does not install it. Run the explicit installer below and retry it on network failures without deleting the lockfile. Diagnostics intentionally avoid loading the Electron entry point so checks never initiate a download:

   ```bash
   npm run install:electron
   npm run check:electron
   ```

4. For network timeouts or connection failures, configure the mirror shown above and retry, retaining the installation log.

`npm start` performs the same check first and prints recovery steps if the package, installation record, or executable is missing. The check does not download files, launch LLMPET, or modify agent settings.

## Create a local package

Run tests first:

```bash
npm ci
npm run install:electron
npm test
```

For a local ad-hoc-signed macOS package:

```bash
npm run package:mac:dev
```

This produces `dist/LLMPET Dev.app` and `dist/LLMPET-<version>-mac-<arch>-dev-unsigned.zip`. The development app uses the isolated `com.octopus.pet.dev` bundle id, so a branch build cannot be confused with the verified `/Applications/LLMPET.app`; only the guarded three-piece workflow may update that canonical path. The ad-hoc-signed package is for local development validation only and is not a public distribution. `npm run package:mac` is the fail-closed public release path and requires Apple Developer ID and notarization credentials; see [macOS release signing and notarization](MACOS_RELEASE.md).

On Windows x64:

```powershell
npm run package:win
```

The NSIS installer and portable ZIP are written to `dist/`.

## Uninstall

Before uninstalling, remove Claude hooks from the tray or from a source checkout:

```bash
npm run uninstall:hooks
```

Then quit LLMPET. Remove `~/.octopus/` only if you also want to delete configuration, usage history, and logs.

## Troubleshooting

- **Patrol cannot move another pet:** grant the Electron process Accessibility permission and restart LLMPET.
- **No sessions appear:** start a new Claude Code or Codex session after LLMPET, then inspect `~/.octopus/octopus.log`.
