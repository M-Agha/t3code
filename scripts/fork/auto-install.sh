#!/bin/bash
# Fork-only (FORK.md, "Installing"). install.sh without the owner at the keyboard: an agent inside T3
# starts it at the end of /t3code-fork upgrade or ship. It waits until no run is active (`busy`
# below), quits every T3 Code app, reads once more that no run started meanwhile (else it waits
# again), stops the background service, and runs install.sh --service-stopped, which moves the
# service to the new build and opens T3 Code (Fork). When anything fails, it opens T3 Code (Fork)
# again itself, whichever version is installed then (after a rollback too), unless a T3 Code app
# runs by then. It polls every `poll` seconds for at most `wait_max`, gives an app a minute to quit,
# and logs to $logs/auto-install_<stamp>.log, whose last line starts "auto-install: SUCCESS" or
# "auto-install: FAILED".
#
# Usage: auto-install.sh [--role <r>]                hands the work to launchd (below) and returns at once
#        auto-install.sh --run <label> [--role <r>]  the work, as launchd runs it
# --role (upgrader or installer) goes on to install.sh, which records it (its header says how).
#
# Why launchd: the agent that starts this runs inside T3, under the app or under the background
# service's launchd job. Quitting the app ends what it started, and install.sh's `launchctl bootout`
# ends every process of the service's job (inferred from launchd's documented process-group
# cleanup; not measured). `nohup … &` stays in that process group and session, and macOS has no
# setsid(1). A job launchd starts from its own plist is launchd's child, in no app's tree and no
# other job, so neither reaches it. The plist sets KeepAlive false: `launchctl submit`'s job is kept
# alive and would run the install again after it exits. The job removes itself at the end.
#
# Apps quit through osascript's `quit` by bundle ID, as the Dock's Quit does; nothing is killed.
# T3_FORK_APPLICATIONS_DIR (install.sh's), T3_FORK_AUTO_INSTALL_POLL and T3_FORK_AUTO_INSTALL_WAIT
# are for forkServiceRuntime.test.ts. macOS only. Written for /bin/bash 3.2.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
apps_dir="${T3_FORK_APPLICATIONS_DIR:-/Applications}"
fork_app="$apps_dir/T3 Code (Fork).app"
logs="$HOME/Library/Logs/T3 Code (Fork)"
# A symlink naming its holder's pid, made in one step, so it never exists without one. Ceiling: a
# lock left by a crash whose pid was reused by a live process refuses until removed by hand.
lock="$logs/auto-install.lock"
db="$HOME/.t3/userdata/statev2.sqlite"
settings="$HOME/.t3/userdata/settings.json"
poll="${T3_FORK_AUTO_INSTALL_POLL:-15}"
wait_max="${T3_FORK_AUTO_INSTALL_WAIT:-3600}"
# The official builds (T3 Code, T3 Code (Nightly)) share one bundle ID; the fork has its own.
bundles="com.t3tools.t3code com.t3tools.t3code.fork"
# install.sh's pattern: it also finds an app's Electron helpers, which can outlive the app.
running='\.app/Contents/MacOS/T3 Code'
uid="$(id -u)"
service_target="gui/$uid/com.t3tools.t3code.service"

holder() { readlink "$lock" 2>/dev/null || true; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

# Checked here, so a bad role fails before launchd is involved.
usage="usage: auto-install.sh [--run <label>] [--role upgrader|installer]"
label=""
role=""
while [ $# -gt 0 ]; do
  case "$1" in
    --run)
      [ -n "${2:-}" ] || { echo "$usage" >&2; exit 2; }
      label="$2"
      shift
      ;;
    --role)
      case "${2:-}" in upgrader | installer) role="$2" ;; *) echo "$usage" >&2; exit 2 ;; esac
      shift
      ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$label" ]; then
  [ "$(uname -s)" = Darwin ] || { echo "auto-install: macOS only." >&2; exit 1; }
  # The runs it waits on, and the database install.sh backs up, are ~/.t3's (install.sh says why).
  [ -z "${T3CODE_HOME:-}" ] || [ "$T3CODE_HOME" = "$HOME/.t3" ] || {
    echo "auto-install: install.sh installs for ~/.t3 only; unset T3CODE_HOME (it is $T3CODE_HOME)." >&2
    exit 1
  }
  pid="$(holder)"
  if alive "$pid"; then
    echo "auto-install: another one runs (pid $pid, holding $lock); its log is in $logs. If pid $pid is not an auto-install, remove $lock." >&2
    exit 1
  fi
  stamp="$(date +%Y%m%d_%H%M%S)"
  label="com.t3tools.t3code.fork.auto-install.$stamp.$$"
  log="$logs/auto-install_$stamp.log"
  plist="$logs/$label.plist"
  mkdir -p "$logs"
  # Only what install.sh needs: the caller's PATH (mise, jq, sqlite3) and HOME. Not T3's own
  # variables (T3CODE_HOME, T3CODE_PORT, …), which belong to the T3 that is about to quit.
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$repo/scripts/fork/auto-install.sh</string><string>--run</string><string>$label</string>${role:+<string>--role</string><string>$role</string>}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$PATH</string>
    <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
  </dict>
</dict>
</plist>
EOF
  # The values above go in unescaped: a PATH, HOME or repo path with & or < makes it invalid XML.
  plutil -lint -s "$plist" || { echo "auto-install: wrote an invalid $plist" >&2; exit 1; }
  launchctl bootstrap "gui/$uid" "$plist" || { echo "auto-install: launchctl could not start $plist" >&2; exit 1; }
  echo "Started $label. Once no run is active (it waits up to ${wait_max}s), every T3 Code app quits,"
  echo "the fork installs, and T3 Code (Fork) opens again. Log: $log"
  exit 0
fi

say() { echo "[$(date '+%F %T')] $*"; }

result="FAILED: stopped before it finished; read the lines above"
# Set once this run quits an app, and when install.sh fails: T3 Code (Fork) then opens again on the
# way out. An install.sh that succeeds opens it itself.
reopen=""
locked=""
# Every way out: the apps this run quit open again, the lock goes, the last line says how it went,
# and the job removes itself (launchd then stops this process, which has nothing left to do).
finish() {
  local apps
  if [ -n "$reopen" ]; then
    # A second app beside one that started meanwhile would be two writers of ~/.t3.
    apps="$(apps_running)"
    if [ -n "$apps" ]; then
      result="$result; did not open $(basename "$fork_app"), as a T3 Code app runs:$apps"
    elif [ -d "$fork_app" ] && open "$fork_app"; then
      result="$result; opened $(basename "$fork_app") $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$fork_app/Contents/Info.plist" 2>/dev/null || echo '(version unread)')"
    else
      result="$result; could not open $fork_app"
    fi
  fi
  [ -z "$locked" ] || rm -f "$lock"
  echo "auto-install: $result"
  rm -f "$logs/$label.plist"
  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
}
app_running() { [ "$(osascript -e "application id \"$1\" is running")" = true ]; }
# What install.sh refuses on: each bundle ID that runs, and the pids of any T3 Code app's
# processes, helpers included. Only read: nothing is killed by name.
apps_running() {
  local id list="" pids
  for id in $bundles; do app_running "$id" && list="$list $id"; done
  pids="$(pgrep -f "$running" | tr '\n' ' ' || true)"
  [ -z "$pids" ] || list="$list pids ${pids% }"
  echo "$list"
}
trap finish EXIT

mkdir -p "$logs"
if ! ln -s "$$" "$lock" 2>/dev/null; then
  pid="$(holder)"
  if alive "$pid"; then
    result="FAILED: another auto-install runs (pid $pid, holding $lock); this one changed nothing. If pid $pid is not an auto-install, remove $lock"
    exit 1
  fi
  say "Removing a lock left by pid ${pid:-?}, which no longer runs."
  rm -f "$lock"
  ln -s "$$" "$lock" 2>/dev/null || { result="FAILED: could not take $lock; this one changed nothing"; exit 1; }
fi
locked=yes

t3_running() {
  local id
  for id in $bundles; do app_running "$id" && return 0; done
  launchctl print "$service_target" >/dev/null 2>&1
}
# The threads a quit or a service stop would cut off, read-only, as `<id> "<title>"` (plus
# " (archived)") joined by ", "; empty when none. A run counts while upstream's thread shell shows it
# as activity (ProjectionStore, isActivityRunForShell): `waiting` is a turn whose checkpoint is not
# captured yet. Background work counts whatever its run's status, as a completed run's work goes on,
# unless upstream lets it complete (backgroundWorkHoldsCompletion); a missing or unknown kind decodes
# to background_task, which holds. The work is what the thread shell reads
# (derivePendingBackgroundWork). Pull request watches live on the thread and are not cut off. A
# payload that is not JSON fails the read, which counts as active while T3 runs. Ceiling: work
# upstream passes over (a turn item a provider task already names) counts too: busy by mistake,
# never idle.
active_threads() {
  sqlite3 -readonly -cmd ".timeout 5000" "$db" "SELECT group_concat(name, ', ') FROM (
    SELECT t.thread_id || ' \"' || replace(t.title, char(10), ' ') || '\"'
        || CASE WHEN t.archived_at IS NULL THEN '' ELSE ' (archived)' END AS name
      FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads p,
            json_each(p.payload_json, '\$.pendingBackgroundTasks') task
          WHERE p.thread_id = t.thread_id
            AND (t.active_provider_thread_id IS NULL OR p.provider_thread_id = t.active_provider_thread_id)
            AND (json_type(task.value, '\$.awaited') = 'true'
              OR COALESCE(json_extract(task.value, '\$.kind'), '') NOT IN ('command', 'monitor')))
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items i
          LEFT JOIN orchestration_v2_projection_runs ir ON ir.run_id = i.run_id
          WHERE i.thread_id = t.thread_id
            AND i.status IN ('pending', 'running', 'waiting')
            AND (i.type = 'subagent'
              OR i.type = 'dynamic_tool' AND json_type(i.payload_json, '\$.input.persistent') IS NOT 'true')
            AND (i.run_id IS NULL OR ir.status <> 'rolled_back')))
      ORDER BY t.thread_id)"
}
# The workflow runs a quit would cut off mid-step, read-only, as `workflow <name> run <id>
# "<title>"` joined by ", "; empty when none. A run counts only while code of it runs: the run is
# `running`, or a plain `step` of it runs beside an agent or a question (the run then shows
# `waiting`). One that only waits on an agent, a question, a signal or a sleep is resumed by the
# next server as it is (its agent's thread counts above), and counting it would let one daily run
# hold the install forever. So the upgrade workflow's own launch step
# (evals/fork/upstream-upgrade.ts), which starts this, holds it only until it returns and its run
# ends. While workflows are off no run executes, whatever its row says; only a missing settings.json
# means off, and one that cannot be read (no jq, a file half written) counts as busy. A database
# from before upstream's migration 110 has no runs.
active_runs() {
  local enabled tables
  [ -e "$settings" ] || return 0
  enabled="$(jq -r '.workflowsEnabled == true' "$settings" 2>&1)" || { echo "$settings: $enabled"; return 1; }
  [ "$enabled" = true ] || return 0
  tables="$(sqlite3 -readonly -cmd ".timeout 5000" "$db" "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'")" || return 1
  [ "$tables" = 1 ] || return 0
  sqlite3 -readonly -cmd ".timeout 5000" "$db" "SELECT group_concat(name, ', ') FROM (
    SELECT 'workflow ' || r.workflow || ' run ' || r.run_id || ' \"' || replace(r.title, char(10), ' ') || '\"' AS name
      FROM workflow_runs r
      WHERE r.ended_at IS NULL AND (r.status = 'running' OR EXISTS (SELECT 1 FROM workflow_steps s
        WHERE s.run_id = r.run_id AND s.status = 'running' AND s.kind = 'step'))
      ORDER BY r.run_id)"
}
# One read: true while a thread or a workflow run is active, and `last` holds what it read (`none`
# when nothing runs).
# With no app and no service nothing can run, whatever the database says (a run a crash left
# `running`, or no -shm file for a read-only connection, which SQLite removes with the last writer).
# Unreadable while T3 runs counts as active.
last=""
busy() {
  local threads runs
  if ! t3_running; then
    [ "$last" = none ] || say "No T3 Code app or service runs, so no run is active."
    last=none
    return 1
  fi
  if threads="$(active_threads 2>&1)" && runs="$(active_runs 2>&1)"; then
    [ -z "$runs" ] || threads="${threads:+$threads, }$runs"
    [ -z "$threads" ] || [ "$threads" = "$last" ] || say "Active: $threads."
    last="$threads"
    [ -n "$threads" ]
  else
    say "Could not read $db or $settings while T3 runs: ${runs:-$threads}"
    last=""
  fi
}
waited=0
pause() {
  if [ "$waited" -ge "$wait_max" ]; then
    result="FAILED: threads/background work still active after ${wait_max}s: ${last:-(unread)}; nothing was installed"
    exit 1
  fi
  sleep "$poll"
  waited=$((waited + poll))
}

say "Waiting until no run is active (polling every ${poll}s, for at most ${wait_max}s)."
while :; do
  # Idle is two reads in a row, `poll` seconds apart, that find no active run: a run that just
  # ended may hand over to a queued one. With nothing running at all, no run can hand over.
  idle=0
  while :; do
    if busy; then idle=0; elif [ "$last" = none ]; then break; else idle=$((idle + 1)); fi
    [ "$idle" -lt 2 ] || break
    pause
  done

  for id in $bundles; do
    app_running "$id" || continue
    say "Quitting $id."
    reopen=yes
    osascript -e "tell application id \"$id\" to quit" ||
      { result="FAILED: $id did not take the quit (osascript failed); nothing was installed"; exit 1; }
  done
  # An app asked to quit can still be saving, and its helpers can outlive it; install.sh refuses
  # while either runs. Only watched: nothing is killed by name.
  for _ in $(seq 60); do
    still="$(apps_running)"
    [ -n "$still" ] || break
    sleep 1
  done
  if [ -n "$still" ]; then
    result="FAILED: still running after 60s:$still; nothing was installed"
    exit 1
  fi

  # A run can start while the apps quit (a queued one, or one on the service, which needs no app):
  # one more read right before the service stops, and back to waiting if one did.
  if busy; then
    say "A run started while the apps quit; waiting again."
    pause
    continue
  fi
  stopped=""
  if launchctl print "$service_target" >/dev/null 2>&1; then
    launchctl bootout "$service_target" ||
      { result="FAILED: could not stop the background service ($service_target); nothing was installed"; exit 1; }
    stopped=yes
    say "Stopped the background service."
  fi
  break
done

say "Running install.sh."
status=0
"$repo/scripts/fork/install.sh" ${stopped:+--service-stopped} ${role:+--role "$role"} || status=$?
if [ "$status" -eq 0 ]; then
  result="SUCCESS: install.sh finished"
  # install.sh copies the workflow only once a role is recorded, and says so in the lines above.
  [ -s "$HOME/.t3/workflows/upstream-upgrade.role" ] ||
    result="$result; the upgrade workflow was not copied: no role (install again with --role upgrader|installer)"
  reopen=""
else
  result="FAILED: install.sh exited $status; read its lines above"
  # T3 Code (Fork) opens again whatever install.sh did: the new build, or the one it put back.
  reopen=yes
fi
