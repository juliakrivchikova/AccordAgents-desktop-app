---
name: design-diff
description: >
  Compare a live AccordAgents UI component against its design handoff and get a
  computed-style delta table (radius, padding, gap, font, color) plus side-by-side
  screenshots. Use when implementing or verifying UI that has a handoff in
  design_handoff_accordagents_chat, before declaring the work done.
---

# Design Diff

Catch where an implementation drifts from the design handoff without hand-eyeballing
screenshots. The engine renders the handoff bundle headless, captures the **real live**
component over CDP, prints a per-property computed-style delta table, flags elements
present on one side but missing on the other, and writes a screenshot of each side
(`design-diff.design.png` / `design-diff.live.png`) so structural drift the table can't
measure is still reviewable.

## The one rule

**A green verdict requires a REAL capture of the live component.** The tool will not
fake one. If the component isn't actually rendered in the debuggable app, the run
**fails** — it never silently substitutes a fixture and reports "ok".

## Verify against the real app (required workflow)

Sign-off means measuring the **real** component in the **real** running app. This is
**generic** — there are no per-component helpers and no fixtures. You launch a separate
instance, **work out from the code how that screen renders, reproduce that flow**, then
capture. The render step is the work; don't skip it and don't fall back to `--inject`.

1. **Launch a separate debuggable instance** with the **`/electron-desktop-qa`** skill
   (never reuse or kill the user's running app; pick a free `--remote-debugging-port`,
   e.g. 9222). Follow that skill's retry/escalation before ever declaring blocked.
2. **Work out how the component renders — from the code.** Find the `appRoot` in
   `src/renderer`, then trace *what puts it on screen*: the user action, route, or app
   state behind it. Components are usually conditional — e.g. an approval card only renders
   when a pending approval exists, so read **who creates that state and from what input**
   (search the renderer + the relevant service). Output of this step: the exact screen and
   the concrete sequence to reach it.
3. **Reproduce that flow** in your instance over CDP — navigate, click, type, or drive the
   app to create the required state (e.g. start a chat and have a participant trigger the
   action that creates the pending approval) until the `appRoot` selector is genuinely on
   screen. **Verify it's present** before capturing.
4. **Capture for real** (no `--inject`):
   ```bash
   node scripts/design-diff.cjs <component> --app-port 9222
   ```
   Prints `VERDICT: N to review · M ok` + a table, and writes both screenshots.
5. **Require exit 0** and run the fix → re-verify loop below. If you genuinely cannot
   reproduce the screen, **report blocked with what you tried** — never fall back to a
   fixture and call it done.

```bash
# ENGINE smoke check ONLY (proves the engine runs; NOT your UI; always exits 3):
# attach to your already-launched instance and mount the fixture:
node scripts/design-diff.cjs <component> --app-port 9222 --inject
```

A smoke run prints `VERDICT: SMOKE — not a real result` and exits 3 — it is never
sign-off, no matter how clean the table looks.

If the engine looks absent (only this SKILL.md, no `scripts/design-diff.cjs`), you are
in a worktree/checkout that lacks it — `cd` to the dev checkout. Do NOT report "engine
not installed." Sanity check: `ls scripts/design-diff.cjs`.

## When to use

- You implemented or changed a UI component that has a design handoff.
- Before declaring UI work done, to self-check against the design.
- To turn "what's different from the design?" into a deterministic table + screenshots
  instead of asking the user to eyeball it again.

## Prerequisites

1. A **separate** debuggable instance you launched (not the user's running app), driven
   until the component is **actually on screen** — then `--app-port`. Launch the instance
   yourself via `/electron-desktop-qa`; the engine only attaches over CDP, it does not
   start the app for you, so you still do step 2 of the workflow above.
2. Google Chrome installed (renders the handoff headless). Override with `CHROME_BIN`.

## Usage

```bash
node scripts/design-diff.cjs <component> [--app-port 9222 [--app-title <re>] | --live-url <url>] [--design <html>] [--inject]
```

- `--app-port` — attach to a running debuggable app over CDP (default 9222). The repo map
  sets `appTitle: "AccordAgents"`, so it picks the right window automatically.
- `--app-title <re>` — pick the CDP window by title/url regex when several are open.
- `--live-url` — instead render a web URL headless (used by design-diff-generic).
- `--design <html>` — override the handoff file (e.g. point at a newer export).
- `--inject` — SMOKE ONLY. Mounts the map's hand-written `fixtureHtml` instead of the
  live component. Always a SMOKE run: never a pass, exits 3, must not be reported as
  sign-off. Use it only to check the engine itself.
- Outputs: the table, `design-diff-report.json`, and `design-diff.{design,live}.png`.

**Exit codes:** `0` real capture + 0 deltas · `1` real capture with deltas to review
(or a hard error) · `3` SMOKE run. Only `0` is a pass.

## What it compares (read this)

- **Computed style** of ONE representative element per mapped type (a chip, a row, the
  submit): radius / padding / gap / font / color.
- **Presence**: a mapped element found on one side but absent on the other is a
  structural delta — `ABSENT IN IMPL` (impl dropped it) or `ABSENT IN DESIGN` (impl
  added something not in the design). This is how "I put something that isn't in the
  design" gets caught for mapped elements.
- It does **not** compare text or the NUMBER of repeated items (rows/chips/pills) —
  differing content and counts are expected.
- For anything **not in the map**, open the two screenshots and compare by eye. The
  table can't see structure it wasn't told about; the screenshots can.

## Fix → re-verify loop (this IS the job — fix inconsistencies, don't just report)

Running design-diff means **driving the component into full alignment with the design** —
not handing back a report. **The design is the source of truth.** Loop until clean:

1. Run a **real** capture (workflow above; never `--inject`).
2. Act on **every** non-`ok` row, then re-run — by what the element **is**:
   - **Unique to this component/screen** (the thing you're aligning) → **converge it to the
     design, no asking:**
     - `DELTA` (radius / padding / gap / font / color) → fix the styling to the design value.
     - `ABSENT IN IMPL` (design has it, impl lacks it) → **add it** to the impl.
     - `ABSENT IN DESIGN` (impl has it, design doesn't) → **remove it.** An element that is
       not in the design must not be in the implementation — delete the arbitrary extra.
   - **Shared / pre-existing element** — a reused primitive (a Cancel / Save / submit Button,
     a shared input) or anything not unique to this screen — that diverges → **STOP and ask
     the user.** Changing it ripples app-wide; never silently reshape a shared component to
     one screen. (Composed / `delta (low-conf)` rows, e.g. a shadcn Button, are usually this.)
   One correctness check before acting on a structural row: rule out a **stale map selector**
   (dump `[class*="aa-"]`; if the selector is wrong the row is a measurement bug — fix the
   map, not the UI). Otherwise the row is real — act on it. List what you added/removed in
   your summary.
3. Re-run after each fix. **Repeat until `VERDICT: 0 to review` and exit `0`.**
4. A `SMOKE` run (exit 3) is never done — render the real card and re-run without `--inject`.
5. Glance at `design-diff.{design,live}.png` for anything the table can't measure.

**A final answer that still has owned `DELTA` / `ABSENT IN DESIGN` / `ABSENT IN IMPL` rows is
INCOMPLETE — you have not done the job.** Done = a real run exits `0`, the only possible
leftovers being shared/pre-existing elements parked on a user decision.

> Note: if you were asked only to *audit* a component (not implement it), reporting the
> table + your read is the correct output — the loop above is for when you own the code.

## Adding / fixing a component

Edit `scripts/design-diff.map.json` only. Add an entry with `designFile`, `designRoot`,
`appRoot`, and `elements` of `{ name, design, app, props }`. Mark composed components
(e.g. shadcn Button) `"composed": true`.

**Build selectors from the ACTUAL bundle, not guessed names.** Render the handoff and
dump its real classes (the `.aa-*` set) and the live component's classes, then map by
role/structure — the two systems share no class names. A guessed design selector that
doesn't exist now shows up loudly as `ABSENT IN DESIGN`, so a clean run also means your
map is honest.

## Limitations

- The live component must be genuinely rendered; the tool can only diff what it can see.
- A `--inject` smoke run reflects a hand-written fixture, not the real component — never
  sign-off.
- Handoff files are self-unpacking bundles; the engine waits for unpack.
- Matching is map-driven; no automatic component discovery.
