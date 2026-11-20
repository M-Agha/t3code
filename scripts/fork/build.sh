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

tag="$(git describe --tags --abbrev=0 --match 'v*-nightly.*' HEAD)" || fail "no upstream nightly tag below HEAD."
version="${tag#v}"
version="${version/-nightly./-fork.}"
# FORK.md's fork version rule (forkLeaveGuard.ts).
[[ $version =~ ^[^-+]+-fork\. ]] || fail "could not derive a fork version from tag $tag"
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
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
last="$(cat "$counter" 2>/dev/null || echo 0)"
# A count with letters in it fails the arithmetic, which ends the script.
build=$((10#$last + 1))
floor="$(date -u +%Y%m%d%H%M%S)"
[ "$build" -ge "$((10#$floor))" ] || build=$((10#$floor))
printf '%s\n' "$build" >"$counter.new"
mv -f "$counter.new" "$counter"
rmdir "$lock"
trap - EXIT
version="$version.$build"

old="$(ls release/T3-Code-*-arm64.* release/t3-*-darwin-arm64.tar.gz 2>/dev/null || true)"
if [ -n "$old" ]; then
  mkdir -p "$trash/t3-fork-release_$stamp"
  mv $old "$trash/t3-fork-release_$stamp/"
  echo "Moved the previous build to $trash/t3-fork-release_$stamp."
fi

node="node@$(jq -r .engines.node package.json)"
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
trap 'rm -rf "$work"' EXIT
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
