#!/bin/bash
# Fork-only (FORK.md, "Rebasing onto upstream", step 7). Builds the fork's macOS arm64 app into release/.
#
# The version is the upstream nightly tag the fork sits on, with "nightly" swapped for "fork":
# v0.1.11-nightly.20261117.4825 -> 0.1.11-fork.20261117.4825. Without it the build carried package.json's
# 0.1.10, and a client on 0.1.11 judged this server out of date ("Update the desktop app on that machine",
# 2026-11-17). A "-nightly." version is not an option: the build script reads it as an official Nightly
# and names the app "T3 Code (Nightly)" (resolveDesktopProductName).
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
case "$version" in
  *-fork.*) ;;
  *) fail "could not derive a fork version from tag $tag" ;;
esac

old="$(ls release/T3-Code-*-arm64.* 2>/dev/null || true)"
if [ -n "$old" ]; then
  mkdir -p "$trash/t3-fork-release_$stamp"
  mv $old "$trash/t3-fork-release_$stamp/"
  echo "Moved the previous build to $trash/t3-fork-release_$stamp."
fi

node="node@$(jq -r .engines.node package.json)"
echo "Building T3 Code (Fork) $version from $tag with $node."
# No update feed: an inherited repository variable would give the fork an updater pointed at upstream.
exec env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY T3CODE_DESKTOP_VERSION="$version" \
  mise exec "$node" -- node_modules/.bin/vp run dist:desktop:dmg:arm64
