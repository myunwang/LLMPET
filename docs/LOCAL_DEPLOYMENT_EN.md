# Deploy LLMPET locally

This guide covers running and testing LLMPET from source and creating packages for local development validation.

## Supported targets

| Platform | From source | Notes |
| --- | --- | --- |
| macOS Apple Silicon | Supported | Patrol mode is macOS-only |
| Windows x64 | Supported | Session focusing supports common terminals |
| Linux | Not officially supported | Window focusing is not implemented |

Claude Code and/or OpenAI Codex must already be installed and used at least once.

## First launch

- Claude Code hooks are merged into `~/.claude/settings.json`; existing hooks are preserved.
- Codex configuration is not modified. LLMPET read-only tails `~/.codex/sessions/YYYY/MM/DD/*.jsonl`.
- LLMPET configuration and usage history live in `~/.octopus/`.
- Logs are written to `~/.octopus/octopus.log`.

## Run from source

Requirements: Git, Node.js 18 or newer (CI uses Node.js 20), and Claude Code and/or OpenAI Codex.

```bash
git clone https://github.com/myunwang/LLMPET.git
cd LLMPET
npm ci
npm test
npm start
```

`npm ci` installs the dependency versions pinned in `package-lock.json`. `npm start` runs LLMPET in the foreground.

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
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci
```

PowerShell:

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci
```

## Create a local package

Run tests first:

```bash
npm ci
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
