---
name: design-diff-generic
description: >
  Compare a Claude-produced design HTML file against a live web app (or another
  project's UI) and get a computed-style delta table. Use when verifying any
  non-AccordAgents implementation against a Claude design file, or when you only
  have a design screenshot and an implementation screenshot.
---

# Design Diff (generic)

The portable sibling of `design-diff`. Same engine, same fix → re-verify loop — but the
design side is any Claude-produced design HTML (same self-unpacking bundle format)
and the live side is a web app reached by URL (headless browser) instead of the
AccordAgents Electron app.

If the engine looks absent (you see only this SKILL.md, no `scripts/design-diff.cjs`),
you are in a checkout that lacks it — `cd` to one that has it. Don't report
"engine not installed."

## What it compares (read this)

The COMPUTED STYLE of ONE representative element per mapped type — a chip, a row, the
submit button. It does NOT compare text, values, or the NUMBER of repeated items
(rows / chips / pills). Different data, a 1-row vs 3-row table, 2 chips vs 12,
different copy — all expected and ignored.

## Usage (deterministic mode — preferred)

```bash
node scripts/design-diff.cjs <component> \
  --design <path/to/claude-design.html> \
  --live-url <http://localhost:3000/your/page> \
  --map <path/to/your-map.json>
```

Output: a VERDICT line (`N to review · M ok`) then a compact per-property table; act
on `DELTA` rows. Also writes `design-diff-report.json`.

## Map schema

Use `scripts/design-diff.map.json` as the worked example. Each component:

```json
{
  "components": {
    "<name>": {
      "designRoot": "<design root selector>",
      "appRoot": "<live root selector>",
      "elements": [
        { "name": "panel",  "design": "<design sel>", "app": "<live sel>", "props": ["borderRadius","padding","gap","backgroundColor"] },
        { "name": "row",    "design": "<design sel>", "app": "<live sel>", "props": ["padding","fontSize","color"] },
        { "name": "submit", "design": "<design sel>", "app": "<live sel>", "props": ["backgroundColor","color","borderRadius"], "composed": true }
      ]
    }
  }
}
```

Pick ONE representative element per type. Selectors differ between the two systems —
map by role/structure, not by shared class names. `props` accept friendly names
(`borderRadius`, `padding`, `gap`, `margin`) that expand to longhands. Mark composed
components (e.g. a styled button) `"composed": true`.

## Vision fallback (screenshots only)

When there's no renderable design file or live URL — just a design screenshot and an
implementation screenshot — compare by eye:

- IGNORE content, data values, and the quantity of repeated items.
- COMPARE styling (radius, spacing, weight, color, alignment), structure, hierarchy,
  and the presence/absence of *kinds* of UI affordances (e.g. brand icons missing).
- Produce the same categorized list, then converge per the fix loop below: **Missing**
  (in design, not impl) → add; **Extra** (in impl, not design) → remove; **Wrong-style** →
  fix to the design; shared/pre-existing primitive → ask. You're not done until the impl
  matches the design (or only shared-element asks remain).

## Fix → re-verify loop (this IS the job — fix inconsistencies, don't just report)

Running design-diff means **driving the implementation into full alignment with the
design** — not handing back a report. **The design is the source of truth.** Loop until clean:

1. Run a **real** capture (`--live-url` against the running app; screenshots-only → the
   vision fallback above).
2. Act on **every** non-`ok` row, then re-run — by what the element **is**:
   - **Unique to this component/screen** (the thing you're aligning) → **converge it to the
     design, no asking:**
     - `DELTA` (radius / padding / gap / font / color) → fix the styling to the design value.
     - `ABSENT IN IMPL` (design has it, impl lacks it) → **add it** to the impl.
     - `ABSENT IN DESIGN` (impl has it, design doesn't) → **remove it.** An element that is
       not in the design must not be in the implementation — delete the arbitrary extra.
   - **Shared / pre-existing element** — a reused primitive (a Cancel / Save / submit Button,
     a shared input) or anything not unique to this screen — that diverges → **STOP and ask
     the user.** Changing it ripples across the app; never silently reshape a shared
     component to one screen. (Composed / `delta (low-conf)` rows are usually this case.)
   One correctness check before acting on a structural row: rule out a **stale map selector**
   (if the selector is wrong the row is a measurement bug — fix the map, not the UI).
   Otherwise the row is real — act on it. List what you added/removed in your summary.
3. Re-run after each fix. **Repeat until `VERDICT: 0 to review` and exit `0`.**

**A final answer that still has owned `DELTA` / `ABSENT IN DESIGN` / `ABSENT IN IMPL` rows is
INCOMPLETE — you have not done the job.** Done = a real run exits `0`, the only possible
leftovers being shared/pre-existing elements parked on a user decision.

> Audit-only exception: if the user explicitly asked you to *audit/report* (not
> align/implement), a table + read is the right output. Absent that, running design-diff
> means fixing to green.

## Limitations

- Composed components only report faithful geometry from a real rendered element.
- Design files are self-unpacking bundles; the engine waits for unpack.
- Matching is map-driven; no automatic component discovery.
