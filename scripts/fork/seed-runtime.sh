#!/bin/bash
# Fork-only (FORK.md, "Background service"). Puts the fork's t3 runtime where `t3 service install`
# looks before it downloads one: ~/.t3/runtime/versions/<version>/, with the executable and an
# .install-complete naming the version (installPinnedRuntime in apps/server/src/cloud/pinnedRuntime.ts).
#
# Usage: seed-runtime.sh <version> <archive>
#
# It never replaces or removes a runtime: every fork build has its own version (build.sh), so a
# version already seeded is the same build, and is left as it is.
# Written for /bin/bash 3.2.
set -euo pipefail

fail() { echo "seed-runtime: $*" >&2; exit 1; }

[ $# -eq 2 ] || fail "usage: seed-runtime.sh <version> <archive>"
version="$1"
archive="$2"
# FORK.md's fork version rule (forkLeaveGuard.ts); no `/`, since it names a directory.
[[ $version =~ ^[^-+]+-fork\. ]] && [[ $version != */* ]] || fail "'$version' is not a fork version."
[ -f "$archive" ] || fail "no runtime archive at $archive: build with scripts/fork/build.sh."
command -v node >/dev/null || fail "needs node on PATH, for a rename that never clobbers."

versions="$HOME/.t3/runtime/versions"
target="$versions/$version"
complete() { [ "$(cat "$1/.install-complete" 2>/dev/null)" = "$version" ] && [ -x "$1/t3" ]; }

if [ -e "$target" ] || [ -L "$target" ]; then
  complete "$target" || fail "$target exists but is not a complete $version runtime; it was not written by this script. Look at it, move it away, and run this again."
  echo "The t3 $version runtime is already seeded at $target."
  exit 0
fi

# Staged beside the target so the final move is a rename. It only ever holds the new runtime, so
# removing it on any exit loses nothing. A SIGKILL skips this and leaves it (FORK.md).
mkdir -p "$versions"
staging="$(mktemp -d "$versions/.fork-seed.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
mkdir "$staging/new"
tar -xzf "$archive" -C "$staging/new" --strip-components=1
printf '%s\n' "$version" >"$staging/new/.install-complete"
complete "$staging/new" || fail "$archive holds no executable t3; rebuild with scripts/fork/build.sh."
# No clobbering: rename(2) takes the name only when nothing or an empty directory holds it, and fails
# on anything else (ENOTEMPTY, ENOTDIR). `mv` cannot do this: onto an existing directory it moves the
# runtime inside it and exits 0. Two seeds at once: one wins here.
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staging/new" "$target" ||
  fail "could not move the runtime into $target: something took that name while seeding; look at it, then run this again."
echo "Seeded the t3 $version runtime at $target."
