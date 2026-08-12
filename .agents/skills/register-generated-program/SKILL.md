---
name: register-generated-program
description: Register a project in LLMPET's generated-program launcher after Codex or Claude Code has created or modified something the user can run. Use when a website, app, demo, server, CLI, or other executable deliverable has passed a real launch check. Do not register source-only libraries, incomplete scaffolds, build-only outputs, or anything that has not actually launched successfully.
---

# Register Generated Program

Add a shortcut to LLMPET only after proving the deliverable really runs.

## Workflow

1. Identify the user-facing launch path. Prefer the same command or file a user should run later.
2. Run it in the real target environment. A compile, lint, or unit test alone is not a launch check.
3. Confirm observable startup success. If startup fails or remains unverified, do not register it.
4. Run exactly one registration form using LLMPET's user-level registrar (LLMPET installs it on startup):

```sh
node "$HOME/.octopus/bin/register-generated-program.js" --verified \
  --name "Program name" \
  --description "What the shortcut opens" \
  --cwd "/absolute/project/path" \
  --command "npm" --arg "run" --arg "dev" \
  --provider codex
```

For an app bundle or directly openable file:

```sh
node "$HOME/.octopus/bin/register-generated-program.js" --verified \
  --name "Program name" \
  --cwd "/absolute/project/path" \
  --open "/absolute/project/path/Program.app" \
  --provider claude
```

5. Use `codex` or `claude` for `--provider` according to the agent that produced the runnable result. Add `--icon /absolute/path` only when a suitable local icon already exists.
6. Check that the command prints JSON with `"ok": true`. Report the shortcut as registered only after that output.

## Boundaries

- Use absolute paths.
- If the registrar is missing, start LLMPET once. Do not recreate its registry format manually.
- Pass executable arguments as repeated `--arg` values. Do not join a shell pipeline into `--command`.
- Register the canonical project once; rerunning with the same path and launch command updates the existing shortcut.
- Never pass `--verified` before a real launch succeeds.
- Registration changes only LLMPET's local shortcut index. It does not copy, deploy, publish, or delete the project.
