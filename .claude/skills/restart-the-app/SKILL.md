---
name: restart-the-app
description: >
  Restart the AccordAgents desktop app so a built main-process change goes
  live. Use after changing src/main, when the user says "restart the app",
  "рестартуй", or "перезапусти", or before verifying a change through the live
  Electron surface.
---

# Restart AccordAgents safely

The app being restarted may host the current conversation. Schedule exactly
one delayed restart, let the current reply reach the user, and ensure the new
Electron process is detached from the agent session.

## Restart

Run from the repository root:

```bash
/bin/bash .claude/skills/restart-the-app/scripts/restart-app.sh
```

Then send the reply. The helper waits 25 seconds before replacing Electron, so
the reply can reach the user first.

The scheduler builds first and clears the marker if submission fails. The
pending marker is a safety latch: one submission can perform at most one
restart. The helper consumes it before touching Electron and removes its own
launchd job on every exit path. If launchd ever retries the helper, the retry
must skip the restart because the marker is gone.

## Verify on the next turn

First prove the transient job is gone. A still-loaded job is a failure because
`launchctl submit` creates an inferred KeepAlive job on this machine:

```bash
TASK_UID=$(id -u)
if launchctl print "gui/$TASK_UID/com.accordagents.restart" >/dev/null 2>&1; then
  echo "ERROR: restart job is still loaded"
  launchctl remove com.accordagents.restart
  exit 1
fi
```

Then prove that exactly one current Electron main process exists, started after
the request and detached from the agent process tree:

```bash
REPO=$(git rev-parse --show-toplevel)
APP_BIN="$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
APP_PIDS=$(ps -axo pid=,command= | awk -v bin="$APP_BIN" '$2 == bin { print $1 }')
set -- $APP_PIDS
if [ "$#" -ne 1 ]; then
  echo "ERROR: expected one Electron process, found $#"
  exit 1
fi
ps -o pid=,ppid=,lstart=,command= -p "$1"
```

There must be exactly one match and its PPID must be `1`. Confirm the real
renderer through the repo's `electron-desktop-qa` workflow before calling a
main-process change verified.

## Failure handling

- If the job remains loaded, remove it immediately and do not resubmit it until
  the cleanup failure is understood.
- If the app did not return, inspect `.scratch/app.log`; do not claim success or
  start a second instance against the same user-data directory.
- Never use a broad `pkill Electron`. The helper matches only this repository's
  Electron binary.
- Never restart before a successful build.

## Why the helper detaches Electron

Commands backgrounded directly from an agent turn can die when that turn ends.
The helper uses launchd only for the delayed handoff, then double-forks Electron
into its own session so the app is reparented to PID 1 before the transient job
removes itself.

## After the restart

The first cloud run after a restart can still pay one-time costs such as a cold
session or stale worker address. Measure timing from the second run.
