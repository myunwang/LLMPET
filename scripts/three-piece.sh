#!/usr/bin/env bash
set -Eeuo pipefail

# LLMPET 三件套：合并到本地 main -> 打包并更新同一个本地 App -> 推送 GitHub main。
# 为避免把别人的未提交工作一起带走，本脚本只接受已经提交、工作区干净的分支。

die() {
  printf 'three-piece: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '\n==> %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage: npm run three-piece -- [source-branch]

The source branch defaults to the currently checked-out branch.

Environment variables:
  LLMPET_REMOTE=origin              Git remote to update
  LLMPET_MAIN_BRANCH=main           Main branch name
  LLMPET_INSTALL_APP=/Applications/LLMPET.app
  LLMPET_SKIP_TESTS=1               Skip npm test (not recommended)
  LLMPET_NO_RELAUNCH=1              Do not reopen LLMPET after success
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

command -v git >/dev/null 2>&1 || die 'git is required.'
command -v npm >/dev/null 2>&1 || die 'npm is required.'
[[ "$(uname -s)" == "Darwin" ]] || die 'The local App packaging step currently requires macOS.'

SOURCE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die 'Run this inside the LLMPET repository.'
CURRENT_BRANCH="$(git -C "$SOURCE_ROOT" branch --show-current)"
SOURCE_BRANCH="${1:-$CURRENT_BRANCH}"
REMOTE="${LLMPET_REMOTE:-origin}"
MAIN_BRANCH="${LLMPET_MAIN_BRANCH:-main}"
INSTALL_APP="${LLMPET_INSTALL_APP:-/Applications/LLMPET.app}"

[[ -n "$SOURCE_BRANCH" ]] || die 'Detached HEAD is not a valid source; pass a local branch name.'
git -C "$SOURCE_ROOT" show-ref --verify --quiet "refs/heads/$SOURCE_BRANCH" \
  || die "Local source branch '$SOURCE_BRANCH' does not exist."
git -C "$SOURCE_ROOT" show-ref --verify --quiet "refs/heads/$MAIN_BRANCH" \
  || die "Local main branch '$MAIN_BRANCH' does not exist."
git -C "$SOURCE_ROOT" remote get-url "$REMOTE" >/dev/null 2>&1 \
  || die "Git remote '$REMOTE' does not exist."

if [[ -n "$(git -C "$SOURCE_ROOT" status --porcelain)" ]]; then
  die 'Source worktree is not clean. Commit the intended changes first; the script never auto-commits arbitrary files.'
fi

find_worktree_for_branch() {
  git -C "$SOURCE_ROOT" worktree list --porcelain | awk -v wanted="refs/heads/$1" '
    /^worktree / { path = substr($0, 10) }
    /^branch / && substr($0, 8) == wanted { print path; exit }
  '
}

note "1/3 Preparing local $MAIN_BRANCH from $SOURCE_BRANCH"
git -C "$SOURCE_ROOT" fetch "$REMOTE" "$MAIN_BRANCH"

REMOTE_REF="$REMOTE/$MAIN_BRANCH"
git -C "$SOURCE_ROOT" rev-parse --verify "$REMOTE_REF" >/dev/null 2>&1 \
  || die "Remote branch '$REMOTE_REF' is unavailable after fetch."

COUNTS="$(git -C "$SOURCE_ROOT" rev-list --left-right --count "$MAIN_BRANCH...$REMOTE_REF")"
LOCAL_ONLY="${COUNTS%%[[:space:]]*}"
REMOTE_ONLY="${COUNTS##*[[:space:]]}"
if [[ "$LOCAL_ONLY" -gt 0 ]]; then
  die "Local $MAIN_BRANCH contains $LOCAL_ONLY commit(s) not on $REMOTE_REF. Resolve them explicitly before publishing."
fi

MAIN_WORKTREE="$(find_worktree_for_branch "$MAIN_BRANCH")"
if [[ -n "$MAIN_WORKTREE" && -n "$(git -C "$MAIN_WORKTREE" status --porcelain)" ]]; then
  die "The $MAIN_BRANCH worktree is dirty: $MAIN_WORKTREE"
fi

if [[ "$REMOTE_ONLY" -gt 0 ]]; then
  if [[ -n "$MAIN_WORKTREE" ]]; then
    git -C "$MAIN_WORKTREE" merge --ff-only "$REMOTE_REF"
  else
    git -C "$SOURCE_ROOT" branch -f "$MAIN_BRANCH" "$REMOTE_REF"
  fi
fi

STAMP="$(date +%Y%m%d%H%M%S)-$$"
INTEGRATION_BRANCH="llmpet-three-piece/$STAMP"
INTEGRATION_WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/llmpet-three-piece.XXXXXX")"
# git worktree wants to create the final directory itself.
rmdir "$INTEGRATION_WORKTREE"
KEEP_WORKTREE=1

cleanup_success() {
  rm -f "$INTEGRATION_WORKTREE/node_modules"
  git -C "$SOURCE_ROOT" worktree remove "$INTEGRATION_WORKTREE"
  # The temporary merge commit is promoted to main, not to the source branch
  # from which this script is running, so normal `branch -d` checks the wrong
  # HEAD. The exact temporary branch is safe to force-delete after promotion.
  git -C "$SOURCE_ROOT" branch -D "$INTEGRATION_BRANCH" >/dev/null
  KEEP_WORKTREE=0
}

report_failure() {
  if [[ "$KEEP_WORKTREE" -eq 1 ]]; then
    printf '\nthree-piece stopped before publishing. Inspection worktree kept at:\n  %s\n' "$INTEGRATION_WORKTREE" >&2
  fi
}
trap report_failure EXIT

git -C "$SOURCE_ROOT" worktree add -b "$INTEGRATION_BRANCH" "$INTEGRATION_WORKTREE" "$MAIN_BRANCH"
if ! git -C "$INTEGRATION_WORKTREE" merge --no-ff "$SOURCE_BRANCH" -m "Merge branch '$SOURCE_BRANCH'"; then
  die 'Merge conflict detected. No local main or GitHub main update was performed.'
fi

DEPENDENCY_ROOT=''
while IFS= read -r candidate; do
  if [[ -d "$candidate/node_modules/electron" ]]; then
    DEPENDENCY_ROOT="$candidate/node_modules"
    break
  fi
done < <(git -C "$SOURCE_ROOT" worktree list --porcelain | awk '/^worktree / { print substr($0, 10) }')

if [[ -n "$DEPENDENCY_ROOT" ]]; then
  note "Reusing installed dependencies from $(dirname "$DEPENDENCY_ROOT")"
  ln -s "$DEPENDENCY_ROOT" "$INTEGRATION_WORKTREE/node_modules"
else
  note 'No reusable Electron dependencies found; installing the lockfile dependencies'
  npm --prefix "$INTEGRATION_WORKTREE" ci
fi

if [[ "${LLMPET_SKIP_TESTS:-0}" != "1" ]]; then
  note 'Validating the integrated main candidate'
  npm --prefix "$INTEGRATION_WORKTREE" test
fi

note '2/3 Building and replacing the local LLMPET.app'
npm --prefix "$INTEGRATION_WORKTREE" run package:mac:dev
BUILT_APP="$INTEGRATION_WORKTREE/dist/LLMPET.app"
[[ -d "$BUILT_APP" ]] || die "Packaging completed without producing $BUILT_APP"
/usr/bin/codesign --verify --deep --strict "$BUILT_APP"

INSTALL_PARENT="$(dirname "$INSTALL_APP")"
INSTALL_STAGE="$INSTALL_PARENT/.LLMPET.app.new.$STAMP"
INSTALL_OLD="$INSTALL_PARENT/.LLMPET.app.old.$STAMP"
mkdir -p "$INSTALL_PARENT"
rm -rf "$INSTALL_STAGE" "$INSTALL_OLD"
/usr/bin/ditto "$BUILT_APP" "$INSTALL_STAGE"

# Stop the previous installed instance before atomically replacing the same app path.
/usr/bin/osascript -e 'tell application id "com.octopus.pet" to quit' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  /usr/bin/pgrep -x LLMPET >/dev/null 2>&1 || break
  sleep 0.2
done
if [[ -e "$INSTALL_APP" ]]; then mv "$INSTALL_APP" "$INSTALL_OLD"; fi
if ! mv "$INSTALL_STAGE" "$INSTALL_APP"; then
  [[ -e "$INSTALL_OLD" ]] && mv "$INSTALL_OLD" "$INSTALL_APP"
  die 'Could not install the newly built app; the previous app was restored.'
fi
rm -rf "$INSTALL_OLD"

INSTALLED_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INSTALL_APP/Contents/Info.plist")"
[[ "$INSTALLED_ID" == 'com.octopus.pet' ]] || die "Unexpected installed bundle id: $INSTALLED_ID"

# Promote only the already-tested integration commit to the real local main.
INTEGRATION_COMMIT="$(git -C "$INTEGRATION_WORKTREE" rev-parse HEAD)"
if [[ -n "$MAIN_WORKTREE" ]]; then
  git -C "$MAIN_WORKTREE" merge --ff-only "$INTEGRATION_COMMIT"
else
  git -C "$SOURCE_ROOT" branch -f "$MAIN_BRANCH" "$INTEGRATION_COMMIT"
fi

note "3/3 Pushing and verifying $REMOTE/$MAIN_BRANCH"
git -C "$SOURCE_ROOT" push "$REMOTE" "$MAIN_BRANCH:$MAIN_BRANCH"
git -C "$SOURCE_ROOT" fetch "$REMOTE" "$MAIN_BRANCH"
LOCAL_MAIN="$(git -C "$SOURCE_ROOT" rev-parse "$MAIN_BRANCH")"
REMOTE_MAIN="$(git -C "$SOURCE_ROOT" rev-parse "$REMOTE_REF")"
[[ "$LOCAL_MAIN" == "$REMOTE_MAIN" ]] \
  || die "Verification failed: local $MAIN_BRANCH ($LOCAL_MAIN) != $REMOTE_REF ($REMOTE_MAIN)."

cleanup_success
trap - EXIT

if [[ "${LLMPET_NO_RELAUNCH:-0}" != "1" ]]; then
  /usr/bin/open "$INSTALL_APP"
fi

printf '\nThree-piece complete.\n'
printf '  local main:  %s\n' "$LOCAL_MAIN"
printf '  remote main: %s\n' "$REMOTE_MAIN"
printf '  local app:   %s\n' "$INSTALL_APP"
