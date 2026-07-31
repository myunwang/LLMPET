# 🐙 LLMPET — A Desktop Pet for Claude Code and Codex

[简体中文](README.md) | **English** | [日本語](README_JA.md)

LLMPET is a desktop companion that makes **Claude Code and OpenAI Codex** visible at a glance. Its expression changes while your agent is thinking, using tools, waiting for you, celebrating a completed turn, or taking a nap. It can surface the agent's latest reply in a speech bubble and show sessions, context usage, rate limits, estimated Claude cost, and usage history in a compact dashboard.

The interface is available in **Simplified Chinese, English, and Japanese**. Switch languages instantly from the tray menu under `Settings → Language`; no restart is required.

## What it does

- **Live agent state** — see thinking, working, parallel subagents, context cleanup, waiting, errors, completion, and idle time as pet animations.
- **Claude Code approvals** — allow or deny a Claude Code permission request directly from the pet.
- **Claude Code + Codex sessions** — one pet can watch both backends, or you can enable separate Claude and Codex pets with independent skins and positions.
- **Session manager** — search and filter sessions, pin important work, archive noise, inspect context usage, and bring the selected terminal or desktop session forward.
- **Meme actions** — send a GIF + voice line to the pet and continue the selected session with the corresponding structured prompt.
- **Travel Frog** — send the selected Claude or Codex pet on an isolated, read-only project expedition and receive a local postcard when it returns.
- **Usage dashboard** — inspect real token trends, model breakdowns, Claude API-price-equivalent estimates, a local Codex token ledger, rate-limit windows, diagnostics, and live operations.
- **Three skins** — Octopus 🐙, Pixel Monster 👾, and Salary Cat 🐱.
- **Patrol mode on macOS** — LLMPET can detect supported rival desktop pets, stay above them, and attempt to push their windows to the nearest screen edge.

LLMPET's state machine, metering, permission flow, process reconciliation, and desktop UI are implemented in this repository. Claude Code and current Codex builds connect through their public hook systems; legacy Codex rollout files remain a read-only fallback and metering source.

## Salary Cat states

| Animation | State | When it appears |
|:---:|:---|:---|
| <img src="assets/cat/cat-working.gif" width="72" alt="Working"> <img src="assets/cat/cat-working-2.gif" width="72" alt="Working variation"> | 🛠️ **Working** | Running tools, editing files, or executing commands |
| <img src="assets/cat/cat-thinking.gif" width="72" alt="Thinking"> <img src="assets/cat/cat-thinking-2.gif" width="72" alt="Thinking variation"> | 🤔 **Thinking** | Reasoning before the first tool call |
| <img src="assets/cat/cat-talking.gif" width="72" alt="Replying"> | 💬 **Replying** | Producing the assistant response |
| <img src="assets/cat/cat-juggling.gif" width="72" alt="Parallel tasks"> | 🤹 **Parallel tasks** | Subagents are working in parallel |
| <img src="assets/cat/cat-waiting.gif" width="72" alt="Waiting for approval"> | ✋ **Waiting** | Claude Code needs approval |
| <img src="assets/cat/cat-needsinput.gif" width="72" alt="Waiting for input"> | ❓ **Needs input** | The agent needs an answer or selection |
| <img src="assets/cat/cat-happy.gif" width="72" alt="Completed"> | 🎉 **Completed** | A turn has finished |
| <img src="assets/cat/cat-error.gif" width="72" alt="Error"> | 💥 **Error** | A command or API request failed |
| <img src="assets/cat/cat-loafing.gif" width="72" alt="Loafing"> | 🍦 **Loafing** | The previous step ended and nothing new is happening |
| <img src="assets/cat/cat-roam.gif" width="72" alt="Traveling"> | 🧳 **Traveling** | A Travel Frog read-only expedition is in progress |
| <img src="assets/cat/cat-sleeping.gif" width="72" alt="Sleeping"> | 😴 **Sleeping** | The session ended or has been inactive for a while |

Salary Cat assets are credited to Douyin creator **@月薪喵**. See [`assets/cat/CREDITS.md`](assets/cat/CREDITS.md).

## Run from source

For source deployment, local packaging, permissions, and troubleshooting, see [Deploy LLMPET locally](docs/LOCAL_DEPLOYMENT_EN.md).

Requirements:

- macOS or Windows
- Node.js 18 or newer
- Claude Code and/or OpenAI Codex installed and used at least once

```bash
git clone https://github.com/myunwang/LLMPET.git
cd LLMPET
npm ci
npm start
```

Useful commands:

```bash
npm test                 # full headless regression suite
npm run package:mac:dev  # local ad-hoc-signed macOS package
npm run package:win      # Windows installer + portable ZIP
npm run uninstall:hooks  # remove LLMPET's Claude/Codex hooks safely
```

## How the integrations work

### Claude Code

LLMPET registers merge-safe lifecycle and permission hooks in `~/.claude/settings.json`.

- Lifecycle events such as `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `SubagentStart` are sent to a local server bound to `127.0.0.1`.
- Permission requests stay open until the user chooses allow or deny.
- Local transcripts are scanned incrementally for token counts, model IDs, and timestamps. Streamed usage snapshots are merged by positive delta, and 5-minute / 1-hour cache writes are priced separately. Assistant text is only read when needed for the short reply bubble.

### OpenAI Codex

LLMPET merge-safely registers documented lifecycle hooks in `~/.codex/hooks.json`. Other applications' handlers are preserved, and uninstall removes only LLMPET entries after making a backup. When Codex marks the new command for review, run `/hooks` and trust LLMPET's `octopus-hook.js` handler.

For older Codex builds, LLMPET still incrementally and read-only tails:

```text
~/.codex/sessions/YYYY/MM/DD/*.jsonl
```

Hook and rollout events map into the same state machine and are deduplicated across sources. The rollout fallback filters internal subagent threads, restores long-running sessions without replaying old events, and builds a persistent local token ledger from each event's `last_token_usage`. Codex rate-limit windows remain separate; local history is not presented as an OpenAI bill.

## Travel Frog

Click **🧳** beside a session to send that session's Claude Code or Codex agent on a separate expedition in the same project directory. Choose Project scout, Bug hunt, Idea trail, or write a custom mission.

- **🐱 Wander** at the bottom of the session panel is deliberately unrelated to every session and project. Without asking the user for a destination, it randomly chooses a real-world route such as A faraway window, A living craft, or A strange corner of Earth, then opens a visible Claude or Codex CLI and completes at least three legs before returning.
- Wander exposes only public web search and page reading. It has no file, shell, login, form, or upload capability. If the selected CLI presents its native web-access approval, the user can allow or deny it in the visible terminal; a denial is not bypassed and does not lead to a request for broader access. Each trip leaves from its own retained footprint under `~/.octopus/wander-home/trips/`; recent routes and memories help prevent repetitive outings.
- One trip can run at a time. It is cancellable and limited to 30 minutes.
- The returned postcard, status, and exact invocation usage stay in `~/.octopus/travel.json` with `0600` permissions.
- Every 10,000 travel tokens earns one leaf; 4 leaves become a star, 4 stars a moon, and 4 moons a sun.
- LLMPET never starts a trip automatically. Only pressing **Depart** sends the mission and relevant project context through the selected agent's CLI to Anthropic or OpenAI.

## Meme actions

Each meme is stored as structured data under:

```text
assets/memes/<meme-id>/
  visual.gif
  voice.mp3
```

The catalog keeps the label, description, playback behavior, pet reaction, prompt version, localized prompt, and source/licensing status together. GIF/MP3 formats and size limits are validated, while content hashes make resource replacements visible without restarting. See [`assets/memes/README.md`](assets/memes/README.md).

The localized prompts are adapted to the culture of each language rather than translated word for word. For example, the Chinese “你这瓜保熟吗？” challenge becomes **“Source: trust me bro?”** in English because both jokes serve the same purpose: demanding proof instead of an unverified claim.

## macOS patrol mode

From the pet's context menu, choose **Patrol now**, or enable automatic patrol from the tray.

1. **Paw stays on top:** when a supported rival pet is detected, LLMPET reasserts its topmost window level.
2. **Push to the edge:** with Accessibility permission, LLMPET approaches the rival and attempts to move it to the nearest horizontal edge.

The drag helper avoids acting while the user is actively using the mouse. Global input fallback is guarded by idle checks and restores mouse state on completion or failure.

Patrol mode is currently macOS-only.

## Privacy and security

- The HTTP server binds only to `127.0.0.1`; write endpoints require a random per-run token in addition to loopback, Host, and browser-origin checks.
- Session data, configuration, and usage history stay on the local machine.
- Codex lifecycle hooks post only to LLMPET's loopback server; legacy rollout access is read-only.
- Background network access is limited to the optional daily LiteLLM pricing download. A Travel Frog run contacts Anthropic or OpenAI only after you explicitly press **Depart**; `OCTOPUS_NO_NET=1` disables LLMPET's pricing fetch, but does not override a CLI trip you explicitly start.
- Electron runs with `contextIsolation` enabled and `nodeIntegration` disabled.
- Claude hook installation is merge-safe, atomic, reversible, and backed up before uninstall.

## Configuration and development flags

- `OCTOPUS_NO_HOOKS=1 npm start` — launch without changing Claude or Codex hook settings.
- `OCTOPUS_ALLOW_MULTI=1 npm start` — bypass single-instance protection for development.
- `OCTOPUS_NO_NET=1 npm start` — disable all external network requests.
- `OCTOPUS_DEBUG=1 npm start` — expose the local `/debug` endpoint.
- `LLMPET_NO_CODEX=1 npm start` — disable Codex monitoring.
- `LLMPET_CODEX_DIR=<dir> npm start` — use a custom rollout directory for testing.

## Contributors

- [@james6666-max](https://github.com/james6666-max) contributed Windows session focusing, terminal PID-chain resolution and caching, electron-builder packaging, and the Windows CI test matrix in [PR #6](https://github.com/myunwang/LLMPET/pull/6).
- [@purrfecto114-lgtm](https://github.com/purrfecto114-lgtm) submitted an extensive audit and improvement proposal covering CodeWhale integration, runtime security, persistence hardening, and testing in [PR #10](https://github.com/myunwang/LLMPET/pull/10). The PR was not merged, but the audit and design effort are still appreciated.
- [@andglf](https://github.com/andglf) diagnosed and fixed permission requests being incorrectly denied when parallel subagents shared a session, backed by runtime evidence and a regression test, in [PR #13](https://github.com/myunwang/LLMPET/pull/13).

Contributions and issue reports are welcome.
