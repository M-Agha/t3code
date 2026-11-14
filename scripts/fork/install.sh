#!/bin/bash
# Fork-only (FORK.md, "Installing"). Installs the fork's macOS build beside the official T3 Code apps.
#
# The fork shares ~/.t3 with them, and its first start migrates that database one way. So this script
# refuses while any T3 Code app runs, copies the live database to ~/.claude/trash first (SQLite's online
# backup, so a running writer can never leave a torn copy), checks the copy, and only then installs.
# It never overwrites an app: an existing "T3 Code (Fork).app" is moved to ~/.claude/trash first.
# macOS only. Written for /bin/bash 3.2.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
db="$HOME/.t3/userdata/statev2.sqlite"
app_name="T3 Code (Fork).app"
trash="$HOME/.claude/trash"
stamp="$(date +%Y%m%d_%H%M%S)"

fail() { echo "install: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "macOS only."
zip="$(ls -t "$repo"/release/T3-Code-*-arm64.zip 2>/dev/null | head -1 || true)"
[ -n "$zip" ] || fail "no build in $repo/release; run: vp run dist:desktop:dmg:arm64"

# Any T3 Code app (official or fork) holding the database would race the backup and the migration.
# The pattern avoids `+` and `\(`: macOS pgrep does not read them as an extended regex would.
running='\.app/Contents/MacOS/T3 Code'
if pgrep -f "$running" >/dev/null; then
  pgrep -fl "$running" | cut -c1-120 | sed 's/^/  running: /' >&2
  fail "quit every T3 Code app first, then run this again."
fi

mkdir -p "$trash"
if [ -f "$db" ]; then
  backup="$trash/statev2.sqlite_$stamp"
  sqlite3 -readonly "$db" ".backup '$backup'"
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

if [ -e "/Applications/$app_name" ]; then
  mv "/Applications/$app_name" "$trash/${app_name%.app}_$stamp.app"
  echo "Moved the previous fork app to $trash/${app_name%.app}_$stamp.app."
fi
mv "$built" "/Applications/$app_name"
rmdir "$staging" 2>/dev/null || true
echo "Installed /Applications/$app_name from $(basename "$zip")."
echo "Run one T3 Code app at a time: they share ~/.t3."
