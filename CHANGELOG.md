# Changelog

## 0.1.1 — deep runtime hardening + CodeWhale catalog v2 + models.dev sync (2026-07-20)

### CodeWhale catalog v2 + live sync

- Expanded `backend/model-catalog.bundled.json` from 31 to **49 entries**, now covering every model registered in CodeWhale's `crates/agent/src/lib.rs` ModelRegistry: added `deepseek-chat`, `deepseek-reasoner`, `kimi-k3`, `moonshotai/kimi-k3`, `glm-5.1`, `glm-5-turbo`, `z-ai/glm-5.1`, `z-ai/glm-5-turbo`, `gpt-5.5`, `gpt-5.5-pro`, `grok-4.5`, `grok-4.3`, `grok-build`, `grok-composer-2.5-fast`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `LongCat-2.0`, `longcat-2.0`, `minimax-m3`.
- Added vendor-published `cache_read_usd_per_million` / `cache_write_usd_per_million` fields per catalog entry. Previously the metering code used a single `0.1× input / 1.25× input` heuristic for all models; vendor reality differs significantly:
  - Xiaomi MiMo: cache_read ≈ 2% of input (heuristic over-charged 5×)
  - Z.AI GLM-5.x: cache_read ≈ 18.6% of input
  - xAI Grok: cache_read 15-20% of input
  - Meta Muse Spark: cache_read 12% of input
  - MiniMax M3: cache_read 20% of input
  - Meituan LongCat-2.0: cache_read 2% of input
  - Xiaomi MiMo / Z.AI GLM-5.x cache_write: vendor-limited-time-free ($0)
- Fixed wrong prices:
  - `deepseek-v4-pro` was $2/$8 (CNY misread as USD) → correct $0.435/$0.87 per DeepSeek's official pricing page + models.dev catalog
  - `deepseek-v4-flash` was $0.5/$2 → correct $0.14/$0.28
  - `gpt-5.6-terra` was $3/$20 → correct $2.50/$15 per OpenAI pricing page
  - `gpt-5.6-luna` was $2/$10 → correct $1/$6
- Fixed wrong context windows: `grok-build` was 512K (correct 256K, official SKU `grok-build-0.1`), `grok-4.20-0309-reasoning/non-reasoning` were 2M (correct 1M per xAI docs).
- **New: Models.dev live catalog sync** (`backend/models-dev-sync.js`). Mirrors CodeWhale upstream's `crates/tui/src/models_dev_live.rs` design:
  - Background async fetch from `https://models.dev/catalog.json` (MIT-licensed, ~3 MB, 5000+ models)
  - 24-hour TTL, 15-second timeout, 64 MiB response cap, no credentials/cookies
  - Atomic write to `~/.octopus/catalog/models-dev.json` (0600 permissions)
  - Three-layer lookup: live cache > bundled seed > null (token-only)
  - Official-provider priority: when multiple providers serve the same model id (e.g. `deepseek-v4-pro` is served by both `deepseek` at $0.435/$0.87 and aggregator `frogbot` at $1.74/$3.48), the official provider wins
  - Graceful degradation: failure to fetch falls back to stale cache or bundled seed; never blocks startup
  - Env knobs: `OCTOPUS_MODELS_DEV_URL`, `OCTOPUS_MODELS_DEV_PATH`, `OCTOPUS_DISABLE_MODELS_DEV_FETCH`, `OCTOPUS_NO_NET`
  - Schema validation: rejects absurd prices (>$1000/M), oversized context (>100M), malformed JSON; preserves `null` distinct from `0` (free)
  - HTTPS-only (refuses http:// URLs to prevent MITM)

### Metering behavior

- Removed `DEFAULT_FALLBACK` ($1/$5 fabricated estimate) for unknown models. `priceFor()` now returns `null`, the metering records tokens honestly with `cost=0`, and the per-model daily aggregate carries an `unknownPrice` counter so the UI can show an "unknown price" badge instead of implying the user spent $0.
- Removed the parallel `FALLBACK_PRICING` table; the catalog is now the single source of truth. Previously a fallback table could silently mask data loss if the catalog lost an entry.
- Cache pricing now uses vendor-published rates when available and only falls back to the 10%/1.25× heuristic when the vendor truly doesn't publish (e.g. Arcee Trinity, grok-composer).
- Fixed `loadCatalog` to preserve `null` cache_write/cache_read distinct from explicit `0` (free) — previous code coerced `Number(null)` to `0`, hiding the "vendor doesn't publish" signal.

### Security

- Upgraded Electron from 33.x to 43.1.1 and enabled renderer sandboxing, context isolation, web security, restrictive CSP, sender-validated IPC, navigation/webview/window blocking, download denial and deny-by-default browser permissions.
- Added a cryptographically random per-launch token to all local hook/server routes, private runtime-file permissions, constant-time token comparison, slow-body timeouts and HTTP connection/header limits.
- Reworked permission bridges to fail closed to `ask`, bounded pending/duplicate queues and made CodeWhale batch approval session-scoped with inactivity expiry and lifecycle cleanup.
- Hardened all persisted metering data against prototype-pollution keys, malformed maps, non-finite numbers and unbounded collections; private file modes are restored after atomic rename.
- Added bounded startup JSON/TOML readers, shell-safe command quoting and strict transcript/session path, symlink and size checks.

### Performance and reliability

- Replaced whole-unread-transcript allocation with 4 MiB fixed-memory JSONL chunks, a 32 MiB per-scan global budget, round-robin progress, a 5000-file cap and oversized-line forward progress.
- Cached unchanged transcript tails, capped live sessions at 256, bounded startup/backfill scans and limited CodeWhale session-list parsing to 100 candidates / 64 MiB total.
- Changed periodic stats refresh to non-overlapping one-shot scheduling, bounded asynchronous logging, added HTTP recovery after incomplete requests and retried hook installation during slow startup.
- Repaired pet/panel bounds after monitor removal or resolution changes; panel opens on the pet's display.
- Fixed model aliases with missing catalog prices, Unix CLI discovery, quoting of paths with spaces, Windows Node-mode hook uninstall and default `--no-sandbox` packaging regressions.

### Packaging, tests and documentation

- Added missing provider/runtime files to package manifests, retained production dependencies in Windows portable builds and kept the Chromium sandbox enabled unless an explicit diagnostic environment variable is set.
- Expanded the core suite to **20 files** (was 18), 60+ file syntax traversal and 92 Windows assertions; added security, oversized-input, persistence, package-consistency, models.dev sync (unit + integration), and stress tests.
- New test files:
  - `test/models-dev-sync.js`: unit tests for transform/validate/cache logic (20+ assertions, includes live fetch verification)
  - `test/models-dev-sync-integration.js`: end-to-end tests covering bundled-only, live-override, stale-cache, corrupted-cache, live-fetch, non-blocking, env-override scenarios (8 tests)
- Updated `CODEWHALE.md` §Token 计量与花费 with the new pricing model, vendor cache rate table, models.dev sync architecture, and the list of price corrections.
- Updated README "CodeWhale 一等公民支持" section to highlight the catalog v2 upgrade and models.dev sync.
- Added `MODEL-PRICING-RESEARCH.md` and `MODEL-PRICE-SYNC-RESEARCH.md` (shipped with source tarball, not in portable zip) documenting every price's vendor URL, access date, and the sync design rationale.
- All 20 core tests pass; all 92 Windows adaptation assertions pass.

## 0.1.0 — initial audited fork

- Initial Claude Code / CodeWhale desktop pet fork and first-round upstream synchronization.
