---
name: electron-desktop-qa
description: >
  Inspect, screenshot, click, type, or QA the live AccordAgents Electron desktop
  app through Chrome DevTools Protocol. Use this before declaring desktop UI QA
  blocked, especially after localhost, Vite, or CDP commands fail in a sandbox.
---

# Electron Desktop QA

Use this skill for AccordAgents renderer QA, UI bug reproduction, visual checks,
and any task that asks you to see, screenshot, click, type into, scroll, or read
DOM/CSS state in the desktop app.

## Rules

- The Electron renderer via CDP is the source of truth.
- Do not use plain `http://127.0.0.1:5173/` as desktop validation. It lacks the
  Electron preload and can crash or differ from the real app.
- Do not use macOS screenshots, AppleScript, window-focus tricks, or a generic
  browser as a substitute.
- Do not report desktop UI QA as blocked until the escalated CDP path below has
  been attempted and failed.

## Workflow

1. Read `docs/inspecting-the-desktop-app.md` if you need details beyond this
   checklist.
2. Check whether a debuggable app is already available:

   ```bash
   curl -s --max-time 2 http://127.0.0.1:9222/json/version
   ```

3. If localhost access fails with `Operation not permitted`, or Vite fails with
   `listen EPERM`, rerun the same important command with the provider's
   escalation or approval mechanism. For Codex, use
   `sandbox_permissions: "require_escalated"` with a concrete justification.
4. Prefer a separate production Electron launch before using Vite:

   ```bash
   npm run build
   node_modules/.bin/electron . --remote-debugging-port=9222
   ```

   Keep the Electron command running while you test. If port 9222 is occupied,
   use another port such as 9223 and pass that port to `attach({ port: 9223 })`.
   When the user asks for an instance that must survive the turn, use the
   detached `launchctl` recipe below instead of `nohup`.

5. Verify attachment and capture proof:

   ```bash
   curl -s --max-time 2 http://127.0.0.1:9222/json/version
   node scripts/screenshot.cjs qa-initial.png
   ```

6. Inspect the live renderer with `scripts/cdp.cjs`, not source guesses:

   ```js
   const { attach } = require("./scripts/cdp.cjs");

   (async () => {
     const app = await attach();
     const state = await app.evaluate(`(() => ({
       title: document.title,
       text: document.body.innerText.slice(0, 4000),
       buttons: [...document.querySelectorAll("button")].map((b, i) => ({
         i,
         text: b.innerText,
         aria: b.getAttribute("aria-label"),
         title: b.getAttribute("title"),
         disabled: b.disabled,
         cls: b.className
       })).slice(0, 100)
     }))()`);
     console.log(JSON.stringify(state.result.value, null, 2));
     app.close();
   })();
   ```

7. Drive the behavior under test through visible UI flows. It is fine to use CDP
   JavaScript to click and fill elements, but do not bypass the workflow you are
   trying to prove.
8. Save screenshots under `screenshots/qa-*.png` and inspect them before
   reporting.
9. Stop only temporary Electron processes or tool sessions you started. Leave
   a user-requested detached instance running and report its label, PID, port,
   profile directory, and log path.

## Worktree Electron Check

Before launching a fresh worktree on macOS, require both files:

```bash
test -f node_modules/electron/path.txt
test -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
codesign --verify --deep --strict --verbose=2 \
  node_modules/electron/dist/Electron.app
```

An npm 11 `allowScripts` warning is advisory; it does not prove that Electron's
postinstall was skipped. When the binary is missing or incomplete, rebuild once
with visible script output, then repeat all three checks:

```bash
npm rebuild electron --foreground-scripts
```

Do not trust the success line without the file and signature checks. If the
worktree binary is still incomplete, follow the same-version fallback in
`docs/inspecting-the-desktop-app.md` instead of looping on rebuild.

## Detached macOS Instance

When the user needs to keep using a separate instance after the agent shell
exits, use a named `launchd` job:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
QA_DIR="$(mktemp -d /private/tmp/accordagents-qa.XXXXXX)"
QA_PORT=9340 # Choose a port not used by any existing AccordAgents instance.
QA_LABEL="com.accordagents.qa-$QA_PORT"
QA_LOG="$QA_DIR/electron.log"
NODE_BIN="$(command -v node)"
ELECTRON_CLI="${ELECTRON_CLI:-$REPO_ROOT/node_modules/electron/cli.js}"
test -f "$ELECTRON_CLI"
```

Before submitting, require both the CDP port and launchd label to be unused.
Both checks below must fail with connection-refused/not-found. If either
succeeds, choose another pair; never remove a job you did not start.

```bash
curl -fsS --max-time 2 "http://127.0.0.1:$QA_PORT/json/version"
launchctl print "gui/$(id -u)/$QA_LABEL"
```

Then submit the job:

```bash
launchctl submit -l "$QA_LABEL" -o "$QA_LOG" -e "$QA_LOG" -- \
  /usr/bin/env ACCORDAGENTS_USER_DATA_DIR="$QA_DIR" \
  "$NODE_BIN" "$ELECTRON_CLI" \
  --remote-debugging-port="$QA_PORT" "$REPO_ROOT" \
  --user-data-dir="$QA_DIR" \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling
```

Never pass `node_modules/.bin/electron` to `launchctl`: its
`#!/usr/bin/env node` wrapper fails under launchd's restricted `PATH`. `nohup`
is also not sufficient under provider session cleanup.

Verify `launchctl print "gui/$(id -u)/$QA_LABEL"`, the CDP version endpoint,
and an `AccordAgents` page target before reporting success. A submitted job can
respawn after its process is closed or killed, so those actions do not stop it.
Stop a temporary job only with `launchctl remove "$QA_LABEL"`; never use broad
Electron kills.

## Blocked Standard

Only report `BLOCKED` for live desktop QA after all are true:

- Existing CDP check failed.
- Separate production Electron launch failed, or launched but CDP could not be
  reached.
- The failed localhost or launch command was retried with escalation/approval.
- Worktree Electron installation was verified or repaired using the file checks
  above.
- The final report names the exact commands tried and the exact errors.

If this standard is not met, keep working the CDP launch path instead of
substituting another browser or saying visual QA is impossible.
