---
name: restart-the-app
description: >
  Restart the AccordAgents desktop app so a main-process change goes live. Use
  whenever a fix needs to be running rather than merely built — after editing
  anything under src/main, or when User says "рестартуй", "перезапусти",
  "restart the app". Also use before claiming a change is verified in the live
  app.
---

# Restarting the app that hosts this chat

The app being restarted is the one running this conversation. That single fact
decides everything below.

## The proven way

```bash
cd /Users/ysvetlichnaya/IdeaProjects/AccordAgents
npm run build:main                       # main-process changes only take effect from dist
launchctl remove com.accordagents.restart 2>/dev/null
launchctl submit -l com.accordagents.restart -- \
  /Users/ysvetlichnaya/IdeaProjects/AccordAgents/.scratch/restart-app-launchd.sh
tail -2 .scratch/restart-app.log         # must show "restart requested (launchd) <ts>"
```

Then send the reply. The script sleeps 25 seconds first, so the message
announcing the restart reaches User before the app goes down.

## Why launchd, and why the app must leave the job

A plain `nohup ./script &` is killed when the turn ends, so the restart silently
never happens: on 2026-08-20 the app kept running the old build for three
exchanges while the reply claimed it had been restarted. `launchctl submit`
hands the job to launchd, outside the agent's process tree, so it survives.

But that is only half of it, and the other half caused a real outage the same
day. If the job keeps the app inside its own process tree (`make start` in the
foreground of the job), the app's life is tied to the agent's session: when the
turn ended, launchd tore the job down and SIGTERMed the app with it. The app
died at 12:19 and stayed dead until someone restarted it by hand two hours
later. The log shows it plainly — `make: *** [start] Terminated: 15` and
`Electron exited with signal SIGTERM`.

So the job spawns the app in its OWN session and exits immediately. **macOS has
no `setsid(1)`** — `nohup setsid ...` fails and nothing starts at all — so the
script forks and calls `os.setsid()` from python3. Verified 2026-08-20: a
process spawned this way has PPID 1 and survives `launchctl remove` of the job
that started it.

## Never

- **Never `pkill Electron` broadly.** Other Electron apps run on this machine,
  and this one hosts the chat. The script matches only this repo's own Electron
  binary path.
- **Never restart without building first.** The running process loaded its code
  at startup; editing `src/` or even rebuilding `dist` changes nothing until the
  process is replaced.
- **Never report "restarted" without checking.** See below.

## Verify in the next turn

```bash
ps -eo pid,lstart,command | grep "electron \." | grep -v grep | head -2
```

The start time must be later than the moment the restart was requested. If it
still shows the old time, the restart did not happen — say so plainly instead of
proceeding as if the fix were live.

Also confirm the app is nobody's child, or it will die with the next turn:

```bash
ps -o pid=,ppid= -p "$(pgrep -f 'electron \.' | head -1)"
```

PPID must be `1`. Anything else means the app is still inside a process tree
that gets torn down.

For a main-process change, also confirm the new code is in `dist`:

```bash
grep -c "<some symbol from the change>" dist/main/main/services/<file>.js
```

## After the restart

The app takes ~30 seconds to build and come back. The first cloud run after a
restart can still pay one-time costs (a worker address recorded before the
change, a cold session), so measure from the second run when timing anything.
