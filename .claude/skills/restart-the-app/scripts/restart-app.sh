#!/bin/bash

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SCRIPT_DIR/../../../.." && pwd)
LABEL="com.accordagents.restart"
PENDING="$REPO/.scratch/restart-app.$LABEL.pending"
HELPER="$SCRIPT_DIR/restart-app-launchd.sh"

clear_pending() {
  rm -f "$PENDING"
}
trap clear_pending EXIT
trap 'exit 1' INT TERM

cd "$REPO"
npm run build
launchctl remove "$LABEL" 2>/dev/null || true
mkdir -p .scratch
rm -f "$PENDING"
touch "$PENDING"

if ! launchctl submit -l "$LABEL" -- /bin/bash "$HELPER" "$LABEL" "$@"; then
  exit 1
fi
trap - EXIT INT TERM

tail -2 .scratch/restart-app.log
