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
9. Stop any Electron process or tool session you started.

## Blocked Standard

Only report `BLOCKED` for live desktop QA after all are true:

- Existing CDP check failed.
- Separate production Electron launch failed, or launched but CDP could not be
  reached.
- The failed localhost or launch command was retried with escalation/approval.
- The final report names the exact commands tried and the exact errors.

If this standard is not met, keep working the CDP launch path instead of
substituting another browser or saying visual QA is impossible.
