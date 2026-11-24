#!/bin/bash
# Fork-only. Builds the fork's macOS arm64 app into release/, and beside it the t3 runtime archive that
# `t3 service install` pins, both at one version: the upstream nightly tag's with "nightly" swapped for
# "fork", plus a build number. FORK.md, "Rebasing onto upstream" step 7 and "Background service", says why.
# macOS only. Written for /bin/bash 3.2.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
trash="$HOME/.claude/trash"
stamp="$(date +%Y%m%d_%H%M%S)"

fail() { echo "build: $*" >&2; exit 1; }

cd "$repo"
# The repo's .env carries T3 Connect's public identifiers; without it the app cannot reach linked machines.
grep -q -E '^[A-Z0-9_]*=pk_live_' .env 2>/dev/null || fail "no T3 Connect key in $repo/.env: run 'cp .env.example .env' first."

# One build at a time in this checkout, for the whole run: the workflow starts this detached, so a
# build can outlive the server that started it, and a replay would start a second on the same
# release/. auto-install.sh's lock: a symlink naming its holder's pid, and the same ceiling.
running="$(git rev-parse --path-format=absolute --git-dir)/fork-build.running"
if ! ln -s "$$" "$running" 2>/dev/null; then
  pid="$(readlink "$running" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    fail "another build runs in $repo (pid $pid, holding $running). If pid $pid is not a build, remove $running."
  fi
  echo "Removing a build lock left by pid ${pid:-?}, which no longer runs."
  rm -f "$running"
  ln -s "$$" "$running" 2>/dev/null || fail "could not take $running"
fi
work=""
on_exit() { rm -f "$running"; [ -z "$work" ] || rm -rf "$work"; }
trap on_exit EXIT

tag="$(git describe --tags --abbrev=0 --match 'v*-nightly.*' HEAD)" || fail "no upstream nightly tag below HEAD."
# The commit this build is of, read with its version (recorded at the end).
head="$(git rev-parse HEAD)"
version="${tag#v}"
version="${version/-nightly./-fork.}"
# FORK.md's fork version rule (forkLeaveGuard.ts).
[[ $version =~ ^[^-+]+-fork\. ]] || fail "could not derive a fork version from tag $tag"

node="node@$(jq -r .engines.node package.json)"
# The dependencies of the commit being built (a checkout moved to a new fork/main has its old ones),
# before a build number is taken or release/ is touched, so a failure here leaves both. vp i is pnpm
# install: --frozen-lockfile refuses rather than rewrite pnpm-lock.yaml, and CI=true is how pnpm
# purges an outdated node_modules without asking, which with no terminal it would refuse.
CI=true mise exec "$node" -- node_modules/.bin/vp i --frozen-lockfile

# The build number is kept in the git common dir, so every worktree of this clone draws from one count,
# and taken under a lock, so two builds at once cannot share one. It is the last number plus one, or
# the UTC time as a number if that is larger: the clock alone repeats within a second and goes back
# when it is set back, and the time keeps a fresh clone above the builds before it (whose numbers
# were the time).
counter="$(git rev-parse --path-format=absolute --git-common-dir)/fork-build-number"
lock="$counter.lock"
mkdir "$lock" 2>/dev/null ||
  fail "$lock is held: another build is taking a number. If none is, remove it and run this again."
# Only now: a run that gave up above must not remove the lock another build holds.
trap 'rmdir "$lock" 2>/dev/null || true; on_exit' EXIT
last="$(cat "$counter" 2>/dev/null || echo 0)"
# A count with letters in it fails the arithmetic, which ends the script.
build=$((10#$last + 1))
floor="$(date -u +%Y%m%d%H%M%S)"
[ "$build" -ge "$((10#$floor))" ] || build=$((10#$floor))
printf '%s\n' "$build" >"$counter.new"
mv -f "$counter.new" "$counter"
rmdir "$lock"
trap on_exit EXIT
version="$version.$build"

old="$(ls release/T3-Code-*-arm64.* release/t3-*-darwin-arm64.tar.gz 2>/dev/null || true)"
if [ -n "$old" ]; then
  mkdir -p "$trash/t3-fork-release_$stamp"
  mv $old "$trash/t3-fork-release_$stamp/"
  echo "Moved the previous build to $trash/t3-fork-release_$stamp."
fi

echo "Building T3 Code (Fork) $version from $tag with $node."
# No update feed: an inherited repository variable would give the fork an updater pointed at upstream.
env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY T3CODE_DESKTOP_VERSION="$version" \
  mise exec "$node" -- node_modules/.bin/vp run dist:desktop:dmg:arm64

# The background service's runtime (FORK.md, "Background service"). APP_VERSION stamps the executable
# (apps/server/vite.config.ts), so `t3 --version` reports the app's version. The scripts spawn `vp`,
# which must be the repo's own: mise's shim has no version set.
echo "Building the t3 $version runtime archive."
runtime="t3-$version-darwin-arm64.tar.gz"
work="$(mktemp -d)"
mkdir -p "$work/monitor/darwin-arm64" "$work/out"
cp native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor "$work/monitor/darwin-arm64/"
PATH="$repo/node_modules/.bin:$PATH" APP_VERSION="$version" \
  mise exec "$node" -- node apps/server/scripts/cli.ts build-exe
PATH="$repo/node_modules/.bin:$PATH" mise exec "$node" -- node scripts/build-cli-archive.ts \
  --platform mac --arch arm64 --version "$version" --resource-monitor-dir "$work/monitor" --output-dir "$work/out"
# Unpacks it and runs --version, the service launcher and serve, as upstream's release does. Only an
# archive that passes reaches release/, where install.sh looks for it.
mise exec "$node" -- node scripts/smoke-cli-archive.ts --archive "$work/out/$runtime" --expect-version "$version"
mv "$work/out/$runtime" "release/$runtime"
echo "Built release/$runtime."
# The commit each version was built from, keyed by the version the installed app itself reports, so the
# upgrade workflow's installer role (FORK.md, "The daily upgrade workflow") can tell whether the Fork app
# is fork/main's head. Beside the build number, so every worktree adds to one list, and only for a build
# that finished. Ceiling: a build of a dirty tree is recorded as HEAD; the installer role builds only a
# clean checkout.
printf '%s %s\n' "$version" "$head" >>"$(dirname "$counter")/fork-builds"
