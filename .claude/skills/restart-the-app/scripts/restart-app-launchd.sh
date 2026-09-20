#!/bin/bash

set -eu

LABEL="${1:-com.accordagents.restart}"
if [ "$#" -gt 0 ]; then
  shift
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SCRIPT_DIR/../../../.." && pwd)
BIN="$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
BIN_PATTERN="^${BIN//./\\.}( |$)"
STATE_DIR="$REPO/.scratch"
PENDING="$STATE_DIR/restart-app.$LABEL.pending"
LOG="$STATE_DIR/restart-app.log"
APP_LOG="$STATE_DIR/app.log"

mkdir -p "$STATE_DIR"

remove_job() {
  launchctl remove "$LABEL" >/dev/null 2>&1 || true
}
trap remove_job EXIT

if [ ! -f "$PENDING" ]; then
  echo "=== restart skipped: no pending request $(date -u +%FT%TZ) ===" >> "$LOG"
  exit 0
fi
rm -f "$PENDING"

{
  echo "=== restart requested (launchd) $(date -u +%FT%TZ) ==="
  sleep 25
  if pkill -f "$BIN_PATTERN"; then
    for _ATTEMPT in 1 2 3 4 5 6 7 8 9 10; do
      if ! pgrep -f "$BIN_PATTERN" >/dev/null; then
        break
      fi
      sleep 1
    done
    if pgrep -f "$BIN_PATTERN" >/dev/null; then
      echo "electron did not stop within 10 seconds"
      exit 1
    fi
    echo "electron stopped"
  else
    echo "no electron matched"
  fi
  echo "relaunching detached..."
} >> "$LOG" 2>&1

REPO="$REPO" BIN="$BIN" APP_LOG="$APP_LOG" python3 - "$@" <<'PY'
import os
import subprocess
import sys
import time

repo = os.environ["REPO"]
binary = os.environ["BIN"]
app_log = os.environ["APP_LOG"]
electron_args = sys.argv[1:]

child_pid = os.fork()
if child_pid == 0:
    os.setsid()
    with open(app_log, "ab") as log, open("/dev/null", "rb") as devnull:
        log.write(f"=== app start {time.strftime('%FT%TZ', time.gmtime())} ===\n".encode())
        log.flush()
        subprocess.Popen(
            [binary, ".", *electron_args],
            cwd=repo,
            stdout=log,
            stderr=log,
            stdin=devnull,
        )
    os._exit(0)

_, child_status = os.waitpid(child_pid, 0)
if not os.WIFEXITED(child_status) or os.WEXITSTATUS(child_status) != 0:
    raise RuntimeError("detached Electron launch failed")
PY

echo "=== app spawned in its own session $(date -u +%FT%TZ) ===" >> "$LOG"
