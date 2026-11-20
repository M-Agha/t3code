#!/bin/bash
# Fork-only (FORK.md, "Installing"). Installs the fork's macOS build beside the official T3 Code apps,
# and seeds its t3 runtime into the T3 home for the background service.
#
# The fork shares ~/.t3 with them, and its first start migrates that database one way. So this script
# refuses while any T3 Code app or the background service runs, copies the live database to
# ~/.claude/trash first (SQLite's online backup), checks the copy, and only then installs.
# It never overwrites an app: an existing "T3 Code (Fork).app" is moved to ~/.claude/trash first, and
# put back if the new one cannot be put in place.
# T3_FORK_APPLICATIONS_DIR replaces /Applications, for forkServiceRuntime.test.ts.
# macOS only. Written for /bin/bash 3.2.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
apps_dir="${T3_FORK_APPLICATIONS_DIR:-/Applications}"
app_name="T3 Code (Fork).app"
dest="$apps_dir/$app_name"
trash="$HOME/.claude/trash"
stamp="$(date +%Y%m%d_%H%M%S)"
# The launch agent `t3 service install` writes (bootService.ts, BOOT_SERVICE_LAUNCHD_LABEL).
service_label="com.t3tools.t3code.service"
service_target="gui/$(id -u)/$service_label"

fail() { echo "install: $*" >&2; exit 1; }

t3_home="$HOME/.t3"
# The app's launcher. Messages name it by path: a bare `t3` may be another install's.
shim="$t3_home/bin/t3"
plist="$HOME/Library/LaunchAgents/$service_label.plist"

# Between moving the old app aside and recording the new runtime's launcher, a failure or interrupt
# puts the previous app back. The launcher then names the previous runtime unless `t3 install` already
# ran; a new runtime that nothing names is pruned like any other unused runtime.
aside=""
moved_in=""
# The owner may have stopped the service for this run (below); a run that does not finish says how
# to start it again, on the runtime it ran before. Only a failure reaches this: success clears the trap.
on_exit() {
  if [ -n "$moved_in" ] && [ -e "$dest" ]; then
    mv "$dest" "$staging/not-installed.app" || echo "install: could not move $dest out of the way." >&2
  fi
  if [ -n "$aside" ] && [ -e "$aside" ]; then
    if mv "$aside" "$dest"; then
      echo "install: put the previous fork app back at $dest." >&2
    else
      echo "install: the previous fork app is at $aside; move it back to $dest." >&2
    fi
  fi
  if [ -f "$plist" ] && ! launchctl print "$service_target" >/dev/null 2>&1; then
    echo "install: the background service is stopped. To start it again, run: \"$shim\" service restart" >&2
  fi
}
trap on_exit EXIT

[ "$(uname -s)" = "Darwin" ] || fail "macOS only."
# An app opened from Finder does not see the shell's T3CODE_HOME and uses ~/.t3, so the backup must be
# of ~/.t3's database, and the runtime must go where its service install looks. Ceiling: other homes
# are unsupported; the upgrade path is resolving the app's own home.
[ -z "${T3CODE_HOME:-}" ] || [ "$T3CODE_HOME" = "$t3_home" ] ||
  fail "this script installs for ~/.t3 only; unset T3CODE_HOME (it is $T3CODE_HOME)."
# The repo's node, as build.sh runs it: seed-runtime.sh renames with it.
node="node@$(jq -r .engines.node "$repo/package.json")"
db="$t3_home/userdata/statev2.sqlite"

zip="$(ls -t "$repo"/release/T3-Code-*-arm64.zip 2>/dev/null | head -1 || true)"
[ -n "$zip" ] || fail "no build in $repo/release; run: scripts/fork/build.sh"

# Any T3 Code app (official or fork) holding the database would race the backup and the migration.
# The pattern avoids `+` and `\(`: macOS pgrep does not read them as an extended regex would.
running='\.app/Contents/MacOS/T3 Code'
if pgrep -f "$running" >/dev/null; then
  pgrep -fl "$running" | cut -c1-120 | sed 's/^/  running: /' >&2
  fail "quit every T3 Code app first, then run this again."
fi
# So does the background service, and the backup must hold what `t3 service install` then migrates.
# T3 has no `t3 service stop`; this is the stop step of its own install (bootService.ts), and
# `t3 service install` starts the service again. Loaded is running here: the unit keeps it alive.
if launchctl print "$service_target" >/dev/null 2>&1; then
  fail "the background service is running and holds the database. Stop it with: launchctl bootout $service_target
Then run this again. If you do not go ahead, \"$shim\" service restart starts it again."
fi

mkdir -p "$trash"
if [ -f "$db" ]; then
  backup="$trash/statev2.sqlite_$stamp"
  # Read-write, not -readonly: with every app quit SQLite has removed the WAL's -shm file, and a read-only
  # connection cannot recreate it ("unable to open database file", 2026-11-15). No app and no service
  # holds the database here (checked above), so a writable connection only replays the WAL into what
  # it copies.
  if ! sqlite3 "$db" ".backup '$backup'"; then
    rm -f "$backup"
    fail "could not back up $db; nothing was installed."
  fi
  chmod "$(stat -f %Lp "$db")" "$backup"
  check="$(sqlite3 "file:$backup?immutable=1" "pragma integrity_check" 2>&1)"
  [ "$check" = "ok" ] || fail "backup at $backup failed its integrity check: $check"
  echo "Backed up the live database to $backup (integrity ok)."
else
  echo "No live database at $db; nothing to back up."
fi

staging="$(mktemp -d "$trash/t3-fork-staging_$stamp.XXXX")"
ditto -x -k "$zip" "$staging"
built="$(find "$staging" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$built" ] || fail "no .app inside $zip"
[ "$(basename "$built")" = "$app_name" ] || fail "expected $app_name in $zip, found $(basename "$built"); rebuild from fork/main"
# A build made without the repo's .env has T3 Connect switched off, and the app then cannot reach
# machines linked through T3's relay (the work Mac, 2026-11-17). Official builds embed the same public
# Clerk key; FORK.md, "Rebasing onto upstream", has the build steps.
if ! LC_ALL=C grep -a -q -r -E 'pk_live_[A-Za-z0-9]+' "$built/Contents/Resources"; then
  fail "$(basename "$zip") was built without T3 Connect: run 'cp .env.example .env' in $repo, rebuild, then run this again."
fi
# A build without the fork version reports package.json's older one, and linked clients then call this
# server out of date (2026-11-17). scripts/fork/build.sh stamps it from the upstream tag.
built_version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$built/Contents/Info.plist")"
# FORK.md's fork version rule (forkLeaveGuard.ts).
[[ $built_version =~ ^[^-+]+-fork\. ]] ||
  fail "$(basename "$zip") has version $built_version, not a fork version: build with scripts/fork/build.sh."
# `t3 service install` pins a runtime at the app's exact version and downloads it from upstream, which
# has no fork release (404, 2026-11-20); build.sh builds it beside the app, and this puts it where the
# service install finds it first (FORK.md, "Background service").
runtime="$repo/release/t3-$built_version-darwin-arm64.tar.gz"
[ -f "$runtime" ] || fail "no runtime archive $(basename "$runtime") beside $(basename "$zip"): rebuild with scripts/fork/build.sh."
# The seed adds a runtime beside the service's and never touches the one it runs.
mise exec "$node" -- "$repo/scripts/fork/seed-runtime.sh" "$built_version" "$runtime"

if [ -e "$dest" ]; then
  # Named first, so an interrupt right after the move still finds it.
  aside="$trash/${app_name%.app}_$stamp.app"
  mv "$dest" "$aside"
fi
moved_in=yes
mv "$built" "$dest"
# Keeps the new runtime from prune (FORK.md, "Background service", "Kept from prune").
runtime_t3="$t3_home/runtime/versions/$built_version/t3"
fork_bin="$t3_home/runtime/fork-bin"
out="$(T3CODE_INSTALL_BIN_DIR="$fork_bin" "$runtime_t3" install 2>&1)" ||
  fail "$runtime_t3 install failed, so prune could remove that runtime: $out"
# `t3 install` only warns when it cannot record its launcher, and an unrecorded one keeps nothing.
grep -Fqx "$(cd "$fork_bin" && pwd -P)/t3" "$t3_home/runtime/launchers" 2>/dev/null ||
  fail "$runtime_t3 install did not record $fork_bin/t3 in $t3_home/runtime/launchers, so prune could remove that runtime: $out"
# Installed: nothing below can fail, and nothing is put back from here on.
trap - EXIT
[ -z "$aside" ] || echo "Moved the previous fork app to $aside."
rmdir "$staging" 2>/dev/null || true
echo "Installed $dest from $(basename "$zip")."
echo "Run one T3 Code app at a time: they share ~/.t3."

# A service already on this build (the same build installed again) answers `service install` with
# "already installed" and stays stopped; `service restart` starts it.
service_cmd=install
if [ -f "$plist" ] &&
  [ "$(jq -r '.activeVersion // empty' "$t3_home/runtime/service-state.json" 2>/dev/null)" = "$built_version" ]; then
  service_cmd=restart
fi
start="\"$shim\" service $service_cmd"
# Every packaged T3 Code app points $t3_home/bin/t3 at its own CLI when it starts, so after an official
# app ran, `t3` is upstream's: it would move the service off the fork, and it has no guard against that
# (FORK.md, "Leaving the fork"). Only this build's own CLI may be told to install the service.
shim_version="$("$shim" --version 2>/dev/null || true)"
echo
[ ! -f "$plist" ] || echo "The background service is stopped."
if [ "${shim_version##*[[:space:]]}" != "v$built_version" ]; then
  echo "$shim is not this build's CLI: it reports '${shim_version:-nothing}', not v$built_version."
  echo "Open T3 Code (Fork) once, then run: $start"
else
  echo "To run the background service on this build, run: $start"
fi
