'use strict';

// Fail-closed recognizer for auto-approving a SINGLE read-only command.
// Deliberately NOT a shell parser: anything with shell grammar, any option
// that can execute a program or write a file, or any mutating subcommand
// falls back to the agent's own permission prompt.
//
// Bypasses explicitly closed here (each was reachable through an earlier
// prefix-only check or a first-draft recognizer):
//   `env rm -rf /`        — env EXECUTES its first non-assignment argument
//   `git branch -D work`  — branch is not always a listing; -D/-d/-m mutate
//   `git remote add …`    — remote add/rename/remove/set-url mutate config
//   `git diff --output=f` — writes a patch to an arbitrary path
//   `git diff --ext-diff` — runs the diff.external command from gitconfig
//   `rg --pre cmd`        — runs a preprocessor command on each file
//   `fd -x cmd`/`-X cmd`  — executes per-match / batch commands
//   `date -s …`           — sets the system clock
//   `tree -o file`        — writes the listing to a file (tree dropped)
//
// Intentional usability costs (documented trade-offs, security first):
//   `grep -c pat file`    — blocked by the generic `-c` deny (interpreters'
//                           `-c` is the dangerous form; we fail closed)
//   `du -x` / `ls -X`     — allowed: the `-x`/`-X` deny is scoped to `fd`,
//                           the only SAFE command whose short flags execute

const SAFE_PLAIN = /^(?:ls|cat|head|tail|wc|pwd|date|whoami|uname|which|type|du|df|printenv|arch)(?:\s|$)/;
const SAFE_SEARCH = /^(?:grep|rg|ag|fd|locate)(?:\s|$)/;
// git read-only subcommands. `branch` and `remote` have mutating forms and are
// matched by their listing-only shapes below, never by this prefix.
const SAFE_GIT = /^git\s+(?:status|log|diff|show|describe|rev-parse|help)(?:\s|$)/;
// `git branch` with listing flags only: -a/-v/-vv/-r combos, --list/--all/
// --remotes/--show-current/--verbose. Creating/renaming/deleting a branch
// takes a free-form argument or -d/-D/-m/-e and no longer matches.
const SAFE_GIT_BRANCH = /^git\s+branch(?:\s+(?:-[avVr]+|--list|--all|--remotes|--show-current|--verbose))*$/;
// `git remote` bare (list) or with -v (verbose list). add/rename/remove/
// set-url/set-head take a subcommand word and do not match.
const SAFE_GIT_REMOTE = /^git\s+remote(?:\s+-v)?$/;

// Shell grammar that could chain a second command, substitute output, or
// redirect. Control characters (except tab, a legal separator) are included:
// they have no business in a one-shot read command and have smuggled payloads
// past naive splitters before.
const SHELL_GRAMMAR = /(?:\r|\n|[;&|<>`]|\$\(|\$\{|\(\s*\)|\\[\r\n]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f])/;
// Options that execute a program or write a file on at least one SAFE command.
// Applied to the whole command line: no SAFE utility needs these.
const EXEC_OR_WRITE_OPTIONS = /(?:^|\s)(?:-exec|-execdir|-ok|-okdir|--exec|--command|-c|--pre|--output|--ext-diff)(?:\s|=|$)/i;
// `date -s`/`--set` rewrites the system clock (needs privileges, still a
// mutation — fail closed).
const DATE_MUTATION = /^date\s+(?:-s|--set)(?:\s|=|$)/;
// `fd -x CMD` / `fd -X CMD` execute commands. Scoped to fd: `du -x`
// (one filesystem) and `ls -X` (sort by extension) are harmless look-alikes.
const FD_EXEC = /(?:^|\s)(?:-x|-X)(?:\s|=|$)/;

function startsWithFd(command) {
  return /^fd(?:\s|$)/.test(command);
}

function isSafeReadOnlyCommand(value) {
  if (typeof value !== 'string') return false;
  const command = value.trim();
  if (!command || command.length > 4096) return false;
  if (SHELL_GRAMMAR.test(command)) return false;
  if (EXEC_OR_WRITE_OPTIONS.test(command)) return false;
  if (DATE_MUTATION.test(command)) return false;
  if (startsWithFd(command) && FD_EXEC.test(command)) return false;
  return SAFE_PLAIN.test(command)
    || SAFE_SEARCH.test(command)
    || SAFE_GIT.test(command)
    || SAFE_GIT_BRANCH.test(command)
    || SAFE_GIT_REMOTE.test(command);
}

module.exports = { isSafeReadOnlyCommand };
