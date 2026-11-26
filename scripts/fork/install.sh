#!/bin/bash
# Fork-only (FORK.md, "Installing"). Installs the fork's macOS build beside the official T3 Code apps,
# and seeds its t3 runtime into the T3 home for the background service.
#
# The fork shares ~/.t3 with them, and its first start migrates that database one way. So this script
# refuses while any T3 Code app runs, and again before it replaces the app, stops the background
# service if it runs, copies the live database to ~/.claude/trash first (SQLite's online backup),
# checks the copy, and only then installs.
# It never overwrites an app: an existing "T3 Code (Fork).app" is moved to ~/.claude/trash first, and
# put back if the new one cannot be put in place; a service it stopped is started again then.
# Installed, it registers the app with LaunchServices, copies the daily upgrade workflow into
# ~/.t3/workflows (a differing copy goes to the trash first), moves a service it stopped to this
# build through this build's own runtime (a failure there starts the unit on disk again; an app
# started meanwhile leaves it stopped), opens T3 Code (Fork), and runs the dotfiles doctor's T3 Code
# step when ~/.config is a dotfiles checkout.
#
# Usage: install.sh [--service-stopped] [--role upgrader|installer]
#   --service-stopped  the caller (auto-install.sh) stopped the service, and this run treats it as one
#                      it stopped
#   --role             this machine's part in the daily upgrade workflow (FORK.md, "Roles"), recorded
#                      beside its copy and kept by every later install that does not name one; with
#                      none ever named the workflow is not copied
# T3_FORK_APPLICATIONS_DIR replaces /Applications and T3_FORK_LSREGISTER the system's lsregister,
# for forkServiceRuntime.test.ts.
# macOS only. Written for /bin/bash 3.2.
set -euo pipefail
usage="usage: install.sh [--service-stopped] [--role upgrader|installer]"
# A failure starts again only a service this run (or its caller) stopped: one the owner stopped
# stays stopped.
stopped=""
role=""
while [ $# -gt 0 ]; do
  case "$1" in
    --service-stopped) stopped=yes ;;
    --role)
      case "${2:-}" in upgrader | installer) role="$2" ;; *) echo "$usage" >&2; exit 2 ;; esac
      shift
      ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  shift
done

repo="$(cd "$(dirname "$0")/../.." && pwd)"
apps_dir="${T3_FORK_APPLICATIONS_DIR:-/Applications}"
app_name="T3 Code (Fork).app"
dest="$apps_dir/$app_name"
lsregister="${T3_FORK_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
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
# A failure starts a service it stopped again from the unit on disk, or says how to. The unit runs
# the launcher, which runs service-state.json's activeVersion (serviceLauncher.ts).
restart_service() {
  if [ ! -f "$plist" ] || launchctl print "$service_target" >/dev/null 2>&1; then return 0; fi
  if [ -n "$stopped" ] && launchctl bootstrap "gui/$(id -u)" "$plist"; then
    echo "install: started the background service again; it runs t3 $(jq -r '.activeVersion // "(no activeVersion)"' "$t3_home/runtime/service-state.json" 2>/dev/null || echo "(service-state.json unread)")." >&2
  else
    echo "install: the background service is stopped. To start it again, run: \"$shim\" service restart" >&2
  fi
}
# Only a failure reaches this: once the app is in place the trap is restart_service alone.
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
  restart_service
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
apps_running() {
  pgrep -f "$running" >/dev/null || return 1
  pgrep -fl "$running" | cut -c1-120 | sed 's/^/  running: /' >&2
}
apps_running && fail "quit every T3 Code app first, then run this again."
# So does the background service, and the backup must hold what `t3 service install` then migrates.
# T3 has no `t3 service stop`; this is the stop step of its own install (bootService.ts), and
# `t3 service install` starts the service again. Loaded is running here: the unit keeps it alive.
if launchctl print "$service_target" >/dev/null 2>&1; then
  launchctl bootout "$service_target" || fail "could not stop the background service ($service_target)."
  stopped=yes
  echo "Stopped the background service for this install."
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
  # Named first, so an interrupt right after the move still finds it. A folder of its own: two
  # installs in one second share the stamp, and `mv` onto an existing app moves into it.
  aside="$(mktemp -d "$trash/${app_name%.app}_$stamp.XXXX")/$app_name"
  mv "$dest" "$aside"
fi
# One can start while the backup and the seed run: checked again where it would race.
apps_running && fail "a T3 Code app started during the install; quit it, then run this again."
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
# Installed: nothing is put back from here on. A failure of the service step below starts the
# service it stopped again.
trap restart_service EXIT
[ -z "$aside" ] || echo "Moved the previous fork app to $aside."
rmdir "$staging" 2>/dev/null || true
echo "Installed $dest from $(basename "$zip")."
# Registered now, so Spotlight and launchers find the new app before Finder scans it (MAIN-128).
"$lsregister" -f -R -trusted "$dest" ||
  echo "install: could not register $dest with LaunchServices; Spotlight may not find it until Finder sees it." >&2
echo "Run one T3 Code app at a time: they share ~/.t3."

# The daily upgrade workflow, as a copy, so switching the checkout's branch never changes what runs
# (FORK.md, "The daily upgrade workflow"). A copy that differs (an edit in the Workflows page) goes
# to the trash first. The server reloads it by itself, once Settings → Labs → Workflows is on; it
# loads only .ts files there, so the role file beside it is the workflow's alone. The role goes in
# first, and no role means no copy: a machine that upgraded by default would race the one upgrader
# to force-push fork/main.
flow="$repo/evals/fork/upstream-upgrade.ts"
flows="$t3_home/workflows"
role_file="$flows/upstream-upgrade.role"
recorded="$(cat "$role_file" 2>/dev/null || true)"
if [ -n "$role" ] && [ "$recorded" != "$role" ]; then
  if mkdir -p "$flows" && printf '%s\n' "$role" >"$role_file"; then
    echo "Recorded this machine's upgrade workflow role: $role."
  else
    echo "install: could not record the role $role in $role_file, so the upgrade workflow was not copied; run: mkdir -p \"$flows\" && echo $role >\"$role_file\" && cp \"$flow\" \"$flows/\"" >&2
    flow=""
  fi
elif [ -z "$role" ] && [ -z "$recorded" ]; then
  echo "install: this machine has no upgrade workflow role, so the workflow was not copied; install again with --role upgrader (the one machine that upgrades fork/main) or --role installer (every other): scripts/fork/auto-install.sh --role installer" >&2
  flow=""
  # A copy from before roles reads no role file and upgrades: it goes too.
  if [ -e "$flows/upstream-upgrade.ts" ]; then
    if mv "$flows/upstream-upgrade.ts" "$trash/upstream-upgrade.ts_$stamp"; then
      echo "install: moved the workflow copy that has no role to $trash/upstream-upgrade.ts_$stamp." >&2
    else
      echo "install: could not move $flows/upstream-upgrade.ts, which upgrades with no role; remove it by hand." >&2
    fi
  fi
fi
if [ -z "$flow" ]; then
  :
elif cmp -s "$flow" "$flows/upstream-upgrade.ts"; then
  :
elif mkdir -p "$flows" &&
  { [ ! -e "$flows/upstream-upgrade.ts" ] || cp -p "$flows/upstream-upgrade.ts" "$trash/upstream-upgrade.ts_$stamp"; } &&
  cp "$flow" "$flows/upstream-upgrade.ts"; then
  echo "Copied the upgrade workflow to $flows."
else
  echo "install: could not copy the upgrade workflow; copy it by hand: cp \"$flow\" \"$flows/\"" >&2
fi

# The service this run stopped moves to this build, through this build's own CLI: ~/.t3/bin/t3 is
# whichever packaged app started last, and upstream's would move the service off the fork with no
# guard against it (FORK.md, "Leaving the fork"). A service already on this build (the same build
# installed again) answers `service install` with "already installed" and stays stopped; `service
# restart` starts it. One the owner had stopped stays stopped.
service_cmd=install
allow=""
active="$(jq -r '.activeVersion // empty' "$t3_home/runtime/service-state.json" 2>/dev/null || true)"
if [ "$active" = "$built_version" ]; then
  service_cmd=restart
# Semver puts "fork" below "nightly", so `service install` refuses to move a service from upstream's
# Nightly to a fork build of it as a downgrade (the work Mac's first install, 2026-11-25). Allowed
# only from an upstream nightly whose number is at or below the one this fork build is of.
elif [[ $active =~ ^[^-+]+-nightly\.[0-9]+\.([0-9]+)$ ]]; then
  nightly="${BASH_REMATCH[1]}"
  if [[ $built_version =~ ^[^-+]+-fork\.[0-9]+\.([0-9]+)\.[0-9]+$ ]] &&
    [ "$((10#$nightly))" -le "$((10#${BASH_REMATCH[1]}))" ]; then
    allow=--allow-downgrade
  fi
fi
# A command printed for later carries no flag: the service may have moved by the time it runs.
start="\"$runtime_t3\" service $service_cmd"
note=""
[ -z "$allow" ] || note="If it refuses to replace t3@$active, add --allow-downgrade: this build is of that nightly or a later one."
echo
if [ -n "$stopped" ]; then
  # Not started again here: an app that hosts its own server would share the database with it.
  if apps_running; then
    trap - EXIT
    fail "a T3 Code app started during the install, which is done; the background service stays stopped. Quit the app, then run: $start${note:+ $note}"
  fi
  if ! out="$("$runtime_t3" service "$service_cmd" ${allow:+"$allow"} 2>&1)"; then
    printf '%s\n' "$out" >&2
    # A real downgrade (BootServiceDowngradeRefusedError): running it again is refused again.
    case "$out" in
      *"Refusing to replace t3@"*)
        fail "the background service runs t3@$active, newer than this build ($built_version): build from a later fork/main, or to move it back knowingly run: $start --allow-downgrade" ;;
    esac
    fail "$start failed; run it again to move the service to this build.${note:+ $note}"
  fi
  [ -z "$out" ] || printf '%s\n' "$out"
  echo "The background service runs on this build ($built_version)."
elif [ -f "$plist" ]; then
  echo "The background service was not running, and is left so. To run it on this build, run: $start"
  [ -z "$note" ] || echo "$note"
else
  echo "No background service is installed. To run one on this build: turn Local environment off in"
  echo "Settings → Environments (the first time only), then run: $start"
  [ -z "$note" ] || echo "$note"
fi
trap - EXIT
# Before the doctor, so T3 is back while it runs.
open "$dest" || echo "install: could not open $dest; open it by hand." >&2

# The dotfiles doctor's T3 Code step, where ~/.config is a dotfiles checkout (FORK.md, "Installing").
# Doctor runs every step; only that one is shown, and it never fails the install.
dotfiles="$(cd -P "$HOME/.config" 2>/dev/null && cd .. && pwd)" || dotfiles=""
echo
if [ -n "$dotfiles" ] && [ -x "$dotfiles/doctor.sh" ]; then
  echo "The dotfiles doctor's T3 Code step:"
  "$dotfiles/doctor.sh" 2>&1 | awk '/^[^[:space:]]+ T3 Code([[:space:]]|$)/ { on = 1; print; next } on && /^[[:space:]]/ { print; next } { on = 0 }' || true
else
  echo "No dotfiles checkout behind ~/.config: doctor's T3 Code step not run."
fi
