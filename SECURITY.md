# Security policy and local threat model

Octopus is a local Electron desktop application. It receives lifecycle and permission events from Claude Code and CodeWhale hooks, reads local transcript metadata for usage metering, and renders status/permission UI.

## Trust boundary

- The HTTP server listens only on `127.0.0.1` and requires a cryptographically random per-launch token. The token is stored in `~/.octopus/runtime.json` with user-only permissions and is embedded only in Octopus-managed hooks. This blocks browser-originated and accidental local calls, but it does not defend against malware already running as the same fully compromised OS account.
- `/state` can influence decorative state and bubbles but cannot execute an agent command.
- `/permission` and `/codewhale-permission` return a decision only to their own held request. Permission failures, malformed replies, overload and lost identity all fail closed to the agent's native `ask` path.
- Local configuration, hook files, transcripts, and session files are trusted only to the extent of the current OS user account. Protecting a compromised user account is outside the project threat model.

## Enforced controls

### Local transport

- Bind to IPv4 loopback only and reject non-loopback sockets.
- Validate `Host`; reject browser-originated cross-site requests through `Origin` / `Referer` checks.
- Require a constant-time-checked per-launch token on every state, permission and debug request; add an Octopus identity response header so hooks reject an unrelated service occupying the same port.
- Bound request bodies: state requests are limited to 16 KiB; permission requests to 1 MiB. Incomplete bodies time out after 10 seconds; connection count, request headers and keep-alive lifetime are bounded.
- Reject malformed JSON, `null`, arrays, and other non-object route payloads.

### Permission bridge

- CodeWhale failures return `ask`: unavailable server, timeout, bad identity header, malformed response, invalid decision, queue pressure, duplicate pressure, and do-not-disturb mode all fall back to the agent's native prompt.
- Batch authorization is scoped to one CodeWhale session, expires after 30 minutes of inactivity, and is cleared at session end or server shutdown.
- Pending permission requests and duplicate requests are bounded.
- No permission rule is persisted to disk by Octopus.

### Files and hooks

- TOML hook installation edits complete `[[hooks.hooks]]` entries, quotes command paths, writes atomically, preserves file mode/newline style, is idempotent, and removes only Octopus-owned entries.
- CodeWhale transcript paths must remain inside the configured session directory. Symlinks and files larger than 16 MiB are rejected. Session listing parses at most 100 candidates and 64 MiB total on the Electron main thread.
- Claude metering uses 4 MiB fixed-memory chunks, a 32 MiB per-tick global budget, round-robin progress and a 5000-file cap. Oversized single JSONL records are skipped without stalling later records.
- JSON/TOML startup inputs are size-bounded. Configuration, usage, runtime, hook and pricing-cache writes use private modes and same-directory temporary-file rename. Metering maps reject prototype keys and non-finite/unbounded metrics.

### Electron renderer

- `sandbox`, `contextIsolation` and `webSecurity` are enabled; `nodeIntegration` and `webviewTag` are disabled. DevTools are disabled unless `OCTOPUS_DEVTOOLS=1`.
- A restrictive CSP allows only packaged scripts and images; renderer network connections, objects, frames, forms and base-URL changes are blocked.
- Navigation, frame navigation, webviews, `window.open`, downloads and all browser permission/device requests are denied.
- Every IPC channel validates both the exact `webContents` sender and the expected local file URL. The preload exposes a narrow API and returns unsubscribe functions for event listeners.
- Provider/session/tool strings inserted into HTML are escaped; assistant text is length-bounded and control characters are removed. Removed/disconnected displays trigger window-bounds repair.

## Privacy

- Usage metering reads token counts, model identifiers, and timestamps from local transcripts.
- The local message bubble may read the final assistant text segment. It is truncated and cleaned before display and is not uploaded by Octopus.
- The optional price refresh downloads a public LiteLLM price list. Set `OCTOPUS_NO_NET=1` to disable it.
- Debug endpoints are disabled unless `OCTOPUS_DEBUG=1` is set.

## Release security checklist

1. Run `npm ci` from the committed lock file.
2. Run `npm run test:all` plus the runtime stress test documented in `DEEP_AUDIT_REPORT.md`.
3. Run `npm audit` and `npm ls --all`; keep Electron on a currently supported stable release and review its security advisories before each release.
4. Build and launch on each target OS; verify tray, transparent window, permission round-trip, hook install/uninstall, and process exit.
5. Inspect the generated package and confirm `providers/`, `hook/`, production dependencies, and required assets are present.
6. Sign/notarize distributables used for public release. The repository scripts currently produce unsigned/ad-hoc portable builds.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository rather than publishing exploit details in a public issue. Include the affected version/commit, operating system, reproduction steps, impact, and any suggested mitigation.
