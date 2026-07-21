# LLMPET / Octopus audit report

> **后续报告：** 本文记录第一轮审计（0.1.0）。0.1.1 的运行期安全、性能与体验加固请以 [`DEEP_AUDIT_REPORT.md`](DEEP_AUDIT_REPORT.md) 为准。


**Audit date:** 2026-07-20  
**Audited input:** `Octopus-0.1.0-src.tar.gz`  
**Baseline package version:** `0.1.0`  
**Scope:** source comparison, dependency/lock consistency, static review, headless dynamic tests, hook and local HTTP behavior, packaging manifests, CI, and documentation.

## 1. Executive result

The uploaded source contained the intended CodeWhale integration but was not a complete snapshot of the current fork. The public fork already sits one custom commit above the current upstream head, so there was no newer upstream commit to merge at audit time. Work therefore focused on selectively restoring useful fork files and fixing hidden security, correctness, portability, packaging, and test-coverage issues.

The highest-impact fixes are:

1. CodeWhale permission failures now return `ask`, and batch rules are session-scoped and expiring.
2. TOML hook installation no longer corrupts the final existing hook entry and is byte-restoring on uninstall.
3. HTTP routes reject malformed/non-object input and enforce bounded bodies.
4. CodeWhale transcript access is constrained to the expected directory and rejects symlinks/oversized files.
5. macOS and Windows packaging manifests now contain required providers/runtime dependencies.
6. Dynamic HTML values are escaped, and Unix CodeWhale executable discovery works correctly.
7. A previously fragmented test set is now a single reproducible core suite plus Windows checks.

## 2. Upstream and fork comparison

Repositories reviewed:

- Upstream: `myunwang/LLMPET`
- User fork: `purrfecto114-lgtm/LLMPET`

At audit time, the fork's CodeWhale commit (`09cc6d8`) was directly above upstream's current latest commit (`d51311e`). The preceding upstream history already included the Windows-support merge (`f3cd14c`). Therefore, no upstream commit was missing from the current public fork.

The uploaded archive nevertheless differed from the public fork. In particular, it lacked or diverged from packaging/configuration/documentation files advertised by the fork, and its `package.json`/lock-file relationship did not support blindly copying the remote build configuration.

### Selectively synchronized

- Restored a tracked 256×256 icon build asset.
- Added a concise Windows installation guide.
- Added compatible `dist:*` aliases while retaining the repository's existing explicit packaging scripts.
- Reconciled documentation with the actual CodeWhale/Windows implementation.

### Deliberately not copied verbatim

- `electron-builder.yml`, `electron-builder`, and `sharp` were not adopted as the active build path. The uploaded lock file did not contain the declared remote dependencies, and the generated system-Node TOML hook path needs an explicit packaged-layout design before moving code into ASAR.
- A duplicate top-level TOML helper was not added; the canonical implementation remains `backend/toml-hooks.js`.

This is a compatibility decision, not a rejection of electron-builder in principle. A later migration should first define an unpacked hook location, update hook commands, lock dependencies, and add packaged-artifact launch tests.

## 3. Findings and remediation

| Severity | Finding | Consequence | Remediation |
|---|---|---|---|
| High | CodeWhale unavailable/malformed responses could rely on permissive or empty-output semantics | Authorization could become broader than the UI implied | Explicit `ask` fallback, identity/status/decision validation, one-shot response |
| High | “Always allow this tool” was process-wide rather than session-scoped | A rule could affect unrelated sessions | Session-keyed rules, 30-minute sliding expiry, SessionEnd/shutdown cleanup |
| High | TOML insertion occurred immediately after the final table header | Existing final hook entry could be split/corrupted | Complete-entry parser, exact owned-entry removal, atomic idempotent rewrite |
| High | macOS package manifest omitted `providers/` | Packaged app could fail at main-process startup | Added providers to every platform manifest and consistency test |
| Medium | Windows portable package omitted production dependencies | Tray icon/runtime feature could silently degrade/fail | Copy lock file and run production-only `npm ci` inside package |
| Medium | Route code assumed parsed JSON was an object | `null`/array input could crash or produce invalid state | Plain-object validation and route-specific safe responses |
| Medium | Permission/state bodies and hook stdin were unbounded | Local memory exhaustion | 16 KiB/1 MiB limits and bounded stdin reads |
| Medium | Transcript API accepted arbitrary absolute paths/symlinks | Same-user caller could read unintended local files through the provider | Canonical directory containment, regular-file/no-symlink and 16 MiB checks |
| Medium | Unix discovery invoked `command` as an executable | PATH-installed CodeWhale could be reported missing | Execute shell `command -v` and test with a temporary executable |
| Medium | Dynamic provider/session values reached `innerHTML` | Local stored/reflected HTML injection in renderer | Central escaping at affected render sites |
| Medium | Security/TOML tests were absent from `npm test`; three TOML scripts had bad imports | Green default tests did not represent repository health | 16-file core runner, fixed imports, CI and repository consistency checks |
| Low | Documentation overstated Windows focus support and understated transcript text access | Users could make incorrect privacy/feature assumptions | Corrected README, CodeWhale and Windows documentation |

## 4. Static checks

- Reviewed process spawning, shell use, hook command construction, HTTP routes, filesystem paths, `innerHTML`, JSON/TOML writes, and packaging copy manifests.
- Verified root `package.json` dependencies exactly match `package-lock.json`.
- Verified shell packaging scripts with `bash -n`.
- Added syntax traversal for production and test JavaScript.
- Performed dependency-tree validation with `npm ls`.
- Offline production dependency audit reported no known vulnerabilities in the locally available advisory data.

Static analysis cannot prove absence of vulnerabilities. In particular, loopback HTTP remains reachable by other same-user processes and should not be described as authenticated IPC.

## 5. Dynamic checks

The headless test suite covers:

- state-machine behavior and smoke scenarios;
- pricing, adaptive polling, territory logic, lazy providers, and renderer cleanup;
- provider validation and Unix executable discovery;
- TOML install → reinstall → uninstall round trip;
- malformed, null, cross-origin, oversized, and permission HTTP requests;
- permission queue/duplicate pressure, expiration, session cleanup, and fail-safe decisions;
- CodeWhale hook identity, malformed response, server absence, and oversized stdin;
- transcript path containment, symlink rejection, file-size cap, and bounded/sorted session lists;
- lock-file/build-manifest/document consistency;
- Windows adaptation assertions.

See the validation section below for the exact final command results recorded for this audited tree.

## 6. Packaging review

- **macOS:** `providers/` is now included. The script creates an `.app` plus zip and performs ad-hoc signing. It still requires a real macOS host for Swift compilation, TCC/focus testing, and release signing/notarization.
- **Linux:** the explicit runtime directory and tarball layout are internally consistent. A true package launch requires the Electron runtime binary.
- **Windows:** the portable build now installs locked production dependencies inside `resources/app`. A real Windows host is still required to verify tray/transparent-window behavior, hook console flashing, shortcut icon behavior, and launch/exit.

## 7. Validation record

This section is generated from the final local verification run:

- `npm ci --ignore-scripts`: passed; locked JavaScript dependencies installed.
- `npm ls --all`: passed with no dependency-tree errors.
- `npm run test:all`: passed — 16/16 core files, JavaScript syntax traversal over 54 files, and 92/92 Windows adaptation assertions.
- `npm audit --offline --omit=dev`: passed with 0 known vulnerabilities in the locally available advisory data (6 production, 72 development, 22 optional dependency records; 77 total unique installed packages reported by npm metadata).
- Online registry audit: unavailable during this audit because the npm audit endpoint returned an upstream/network error.
- Electron runtime installation/package launch: not completed because the execution environment could not resolve/download Electron from GitHub or the configured mirror. Consequently, no claim is made that macOS/Windows GUI packages were dynamically launched.

## 8. Residual risks and recommended next gates

1. **Resolved in 0.1.1:** loopback mutation routes now require a per-run unguessable bearer token. OS IPC remains a possible future hardening step if stronger same-user isolation is required.
2. Run Electron end-to-end tests on macOS, Windows 10/11, and at least one X11 and Wayland Linux environment.
3. Sign and notarize public builds; add provenance/SBOM and release checksums.
4. Add a packaged-artifact smoke test that verifies hook command paths after any future ASAR/electron-builder migration.
5. Re-run online dependency audit and refresh dependencies when registry connectivity is available.
6. Consider removing or formally completing the unregistered Aider scaffold to avoid presenting an unsupported provider in UI constants.
