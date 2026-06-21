---
name: design-diff-generic
description: >
  Compare a Claude-produced design HTML file against a live web app (or another
  project's UI) and get a computed-style delta table. Use when verifying any
  non-AccordAgents implementation against a Claude design file, or when you only
  have a design screenshot and an implementation screenshot.
---

# Design Diff (generic)

The portable sibling of `design-diff`. Same engine, same decision tree — but the
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
- Produce the same categorized list (Missing / Wrong-style / Extra / Content), then
  apply the decision tree.

## How to act on a DELTA (decision tree)

1. **Unambiguous miss you introduced** → fix it, then re-run until clean.
2. **Pre-existing element that already differs** → ask the user; don't change it silently.
3. **Design conflicts with an established in-app pattern** (possibly wrong/stale) → ask
   the user whether the design is intentional; don't align to it.
4. **Deliberate deviation** → leave it; note it.

Surface only the leftover ambiguous cases, not the whole table.

## Limitations

- Composed components only report faithful geometry from a real rendered element.
- Design files are self-unpacking bundles; the engine waits for unpack.
- Matching is map-driven; no automatic component discovery.
