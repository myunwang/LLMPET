---
name: register-generated-program
description: Register a runnable project created or modified by Claude Code in LLMPET Launcher after it passes a real launch check. Use for websites, apps, demos, servers, CLIs, and other executable deliverables. Do not use for source-only libraries, incomplete scaffolds, build-only outputs, or anything that has not actually launched successfully.
---

# Register Claude Code Program

Add a Claude Code-created shortcut to LLMPET Launcher only after proving the deliverable really runs.

## Workflow

1. Identify the user-facing launch path. Prefer the same command or file the user should run later.
2. Launch it in the real target environment. Compilation, lint, or unit tests alone do not count.
3. Confirm an observable successful startup. If that remains unverified, do not register anything.
4. Use exactly one of the following forms. Keep `--provider claude`; this skill must never attribute a program to Codex.

For a command:

```sh
node "$HOME/.octopus/bin/register-generated-program.js" --verified \
  --name "Program name" \
  --description "What the shortcut opens" \
  --cwd "/absolute/project/path" \
  --command "npm" --arg "run" --arg "dev" \
  --provider claude
```

For an app bundle or directly openable file:

```sh
node "$HOME/.octopus/bin/register-generated-program.js" --verified \
  --name "Program name" \
  --cwd "/absolute/project/path" \
  --open "/absolute/project/path/Program.app" \
  --provider claude
```

5. Add `--icon /absolute/path` only when a suitable local icon already exists.
6. Report registration only after the command prints JSON with `"ok": true`.

## Boundaries

- Use absolute paths.
- If the registrar is missing, ask the user to open LLMPET Workbench → Generated Programs and authorize the Claude Code skill. Do not recreate LLMPET's registry format manually.
- Pass arguments as repeated `--arg` values. Do not embed shell pipelines in `--command`.
- Register the canonical project once; the same path and launch command update the existing shortcut.
- Never pass `--verified` before a real launch succeeds.
- Registration changes only LLMPET's local shortcut index. It does not copy, deploy, publish, or delete the project.
