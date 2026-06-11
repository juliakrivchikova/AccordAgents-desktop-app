# Handoff: AccordAgents — Chat Workspace

## Overview
AccordAgents is a local-first macOS desktop app where named AI participants (backed by
**Codex CLI**, **Claude Code**, and **Gemini**) respond inside **one shared project chat**.
This handoff covers the **chat workspace screen**: a three-region desktop layout (left
project sidebar, center conversation stream + composer, optional right thread panel) plus
the specialized message cards the product depends on — **permission requests**, **multiple-
choice decisions**, **live agent runs**, and **resolved-action system lines**.

The design is delivered light-theme-first with a full dark theme, and a single **lilac**
brand accent.

---

## About the Design Files
The files in this bundle are **design references created in HTML/CSS + inline-Babel React**.
They are prototypes that demonstrate the intended **look, layout, and interaction** — they are
**not production code to copy verbatim**.

Your task is to **recreate these designs in the target codebase's environment** (the
AccordAgents desktop app is an Electron + React renderer, per the in-mock copy) using its
established component patterns, state management, and styling approach. If no front-end
environment exists yet, pick the most appropriate framework for the app (React strongly
implied by the source) and implement there.

Treat the inline-Babel/`window`-global wiring in the prototype as a **prototyping convenience
only** — re-express it as real components and real state in your stack.

---

## Fidelity
**High-fidelity (hifi).** Colors, typography, spacing, radii, and interaction states are final
and intentional. Recreate the UI pixel-accurately using the codebase's libraries, mapping the
design tokens below onto the app's real token system. Exact values are provided throughout.

---

## ✅ Production configuration — build EXACTLY this (do not ask)
The prototype exposes a "Tweaks" panel (message style, avatar mode, density, provider-accent).
**That panel is a prototyping tool, not a product feature.** Ship the single configuration
below and **do not build any user-facing tweak controls** for these:

| Setting | Ship this | Notes |
|---|---|---|
| **Message style** | **`flat`** only | Avatar + left-aligned content using the available stream width. Do NOT build the `hybrid` or `bubble` variants. |
| **Avatars** | **`animal`** (image avatars) | Agents use the provided avatar images; the **user** avatar is the in-code grey silhouette on a light chip. Do NOT build the monogram-only mode. |
| **Provider accent** | **OFF** | No colored provider rail on messages and no provider-tinted participant names. Names render in `--app-text-strong`; provider identity shows only via the avatar + the small "Codex CLI / Claude Code / Gemini" label. (The colored-rail styling exists in the CSS but is disabled — leave it out of the build.) |
| **Density** | **Comfortable / fixed** | Bake these exact values; do NOT build a density slider: body font **15px**, message vertical gap **18px**, meta margin-bottom **5px**, content gap **9px**, bubble pad (unused in flat) `11px 14px`. |
| **Theme** | **Light default, KEEP the dark toggle** | Light/dark is a **real product feature** (the moon/sun button in the top bar) — keep it. Only the four rows above are prototype-only. |

In short: one flat, image-avatar, light-default (dark-capable), comfortably-spaced layout with
no tweak UI. Everything else in this README still applies.

---

## Design Language (read first)

- **Light-first dev tool** aesthetic: near-white surfaces, hairline 1px borders, soft
  low-spread shadows, one lilac accent.
- **Three type families** (loaded from Google Fonts; self-host for offline):
  - **Space Grotesk** — display / brand wordmark / thread-panel titles.
  - **Hanken Grotesk** — all UI + body text (this is `--font-sans`, the default).
  - **JetBrains Mono** — `@handles`, `#paths`, commands, code, timers, key tokens.
- **No all-caps / no uppercase labels.** Sentence case everywhere (this was an explicit
  design decision — do not `text-transform: uppercase` section labels, eyebrows, or badges).
- **No emoji** in product UI.
- **Provider identity** = Codex (teal), Claude (clay), Gemini (periwinkle). Used only as a
  thin left "rail" on agent messages and as the avatar monogram tint — never as fills.
- **Icons:** Lucide-style line icons, 1.75px stroke, `currentColor`. Sizes 13–18px.

---

## Design Tokens

### Color — Light theme (default)
| Token | Value | Use |
|---|---|---|
| `--app-bg` | `#f6f7f9` | App background (behind everything) |
| `--app-sidebar` | `#f1f2f5` | Left sidebar background |
| `--app-surface` | `#ffffff` | Cards, composer, stream, top bar |
| `--app-surface-2` | `#f7f8fa` | Sunken surfaces (code blocks, avatars, run blocks) |
| `--app-surface-hover` | `#f1f3f6` | Hover bed for rows/options/buttons |
| `--app-border` | `#e7e9ee` | Default hairline border |
| `--app-border-strong` | `#d7dae1` | Hover/emphasis border |
| `--app-text-strong` | `#16191f` | Primary ink / headings / dark "Submit" button bg |
| `--app-text` | `#424955` | Body text |
| `--app-muted` | `#868d9b` | Secondary / meta / muted text & icons |
| `--app-accent` | `#7d5fd3` | **Lilac brand accent** — handles, links, focus, selected, spinner |
| `--app-accent-soft` | `#efebfb` | Accent tint (badges, soft beds, focus ring) |
| `--app-user-bub` | `#eceff3` | User bubble fill (bubble message style) |
| `--app-warning` | `#c98a13` | Warning text |
| `--app-warning-soft` | `#fbf4e2` | Warning bed |
| `--app-warning-border` | `#ecd9a8` | Warning border |
| `--app-shadow` | `rgba(18,24,40,0.10)` | Card/shadow color |

### Color — Dark theme (`[data-theme="dark"]`)
| Token | Value |
|---|---|
| `--app-bg` | `#0d0f13` |
| `--app-sidebar` | `#121419` |
| `--app-surface` | `#181b21` |
| `--app-surface-2` | `#1d2128` |
| `--app-surface-hover` | `#222732` |
| `--app-border` | `#282d36` |
| `--app-border-strong` | `#353c47` |
| `--app-text-strong` | `#f1f3f7` |
| `--app-text` | `#c1c7d2` |
| `--app-muted` | `#7f8794` |
| `--app-accent` | `#b39ef0` (brighter lilac) |
| `--app-accent-soft` | `rgba(179,158,240,0.16)` |
| `--app-user-bub` | `#232a35` |
| `--app-shadow` | `rgba(0,0,0,0.45)` |

### Provider colors
| Provider | Light | Light soft | Dark | Dark soft |
|---|---|---|---|---|
| Codex (teal) | `#0ea5a5` | `#e3f6f6` | `#2dc4c4` | `rgba(14,165,165,0.20)` |
| Claude (clay) | `#d97757` | `#fbeee8` | `#e8896b` | `rgba(217,119,87,0.20)` |
| Gemini (periwinkle) | `#6e8bf0` | (tint) | `#8ba2f6` | `rgba(110,139,240,0.22)` |

### Type families
```
--font-display: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
--font-sans:    'Hanken Grotesk', ui-sans-serif, system-ui, -apple-system, sans-serif;
--font-mono:    'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
```
Google Fonts import:
`Space Grotesk 400;500;600;700` · `Hanken Grotesk 400;450;500;600;700` · `JetBrains Mono 400;500;600`

### Type scale (observed, in the chat UI)
| Role | Size / weight / tracking | Family |
|---|---|---|
| Brand wordmark | 14.5px / 600 / -0.01em | display |
| Top-bar title | 15px / 600 / -0.005em | sans |
| Sidebar section label ("Projects") | 11.5px / 600 / +0.01em (sentence case) | sans |
| Agent name (`@handle`) | 14px / 600 / -0.005em | sans |
| Provider label ("Codex CLI") | 11.5px / 500 | sans |
| Timestamp | 11.5px / muted / tabular-nums | sans |
| Body / message text | ~15px (density var `--d-font`) / 1.6 lh | sans |
| Composer textarea | 14.5px / 1.5 lh | sans |
| Permission/choice question | 14.5px / 600 / -0.01em | sans |
| Option title | 13.5px / 600 | sans |
| Option description | 12px / 1.4 lh / muted | sans |
| Inline `@handle` / `#path` / commands | 0.86–0.9em / 500–600 | mono |
| "Recommended" badge | 11px / 600 (sentence case) | sans |

### Radii
- Buttons / inputs / option rows: **8–10px**
- Cards (permission, choice, composer shell): **12–14px**
- Avatars: brand mark **6px**; agent/user avatars **7–10px**; thread avatars **6px**
- Pills (run chip, "Worked for", provider tints): **999px** (full)

### Spacing
- 4px grid. Component gaps 6–15px. Message vertical rhythm `--d-msg-gap` default **20px**
  (driven by a Density tweak, 1–5).
- Stream uses the available center panel width. Stream padding `18px 28px 8px`.
- Composer padding `10px 28px 18px`.

### Layout widths
- Sidebar: `--side-w: 266px` (collapsible).
- Thread panel: `--thread-w: 430px` (opens on the right when a thread is viewed).

### Shadows
- Cards at rest: `0 1px 2px var(--app-shadow)`.
- Floating menus (mention popover): `0 12px 32px var(--app-shadow)`.
- Hover-action toolbar / composer: `0 2px 10px var(--app-shadow)`.

### Motion
- Fast, subtle. Transitions `.12s–.15s`. Press = `scale(0.98)`.
- Spinner: `aa-spin` 0.7s linear infinite. Typing dots: `aa-typing` 1.2s staggered.
- All motion gated behind `@media (prefers-reduced-motion: reduce)` (disable animations).

---

## Screens / Views

### 1. App shell (3 regions)
- **Grid:** `[sidebar 266px] [main 1fr]`. Main is a column: top bar (auto) + main-row (1fr).
  Main-row is `[center 1fr] [thread 430px?]`. Center is a grid `[stream 1fr] [composer auto]`.
- Collapsing the sidebar hides it and shifts a `side-collapsed` modifier onto the app root.

### 2. Left sidebar
- **macOS traffic lights** (3 dots) top-left.
- **Brand row:** swirl mark (`assets/mark.png`, 22px, 6px radius) + "AccordAgents" wordmark
  (Space Grotesk 600) + a collapse button (rounded panel icon, `rx=5`).
- **New chat** row: ghost row, left-aligned, pencil icon tinted with the lilac accent, label
  in sans 500. Lightens to `--app-surface-hover` on hover. (No border, no shadow — deliberately
  not a heavy button.)
- **Project groups:** collapsible. Group header label "Projects" etc. in **sentence case**
  (11.5px/600). Chat rows show title + relative time; the active chat row is filled; a live
  chat shows a small lilac dot with a soft ring.
- **Settings** row pinned bottom.
- NOTE: a Search row previously existed and was **removed** — do not reintroduce it.

### 3. Top bar
- Left: conversation title (15px/600) + rename (pencil) button.
- Right: a **roster** cluster (overlapping participant avatars + count), then icon buttons:
  theme toggle (moon/sun), settings, refresh.

### 4. Conversation stream (message list)
Full-width stream with normal page gutters so flat message content can use the available
row. Message layout has three style modes (a "Message style" tweak): **flat**
(default — avatar + left-aligned content, optional provider rail), **hybrid**, and **bubble**.
**For production, ship `flat` only** (see Production configuration above). Each message:
- **Avatar** (38px flat / 36px bubble). Agent avatars are images (animal set) or provider-tinted
  monogram chips. The **user avatar** is a light `--app-surface-2` chip with a grey person
  silhouette — **no border/ring** (must visually match agent avatars).
- **Meta row:** name (`@handle` for agents, "You" for user), provider label, timestamp.
- **Body:** rich blocks — paragraphs with inline `@handle`/`#path`/`code` mono tokens, code
  blocks, a "Referenced file" footer, an expandable **"Worked for 1m 57s"** run summary pill.
- **Hover action toolbar** (floats top-right of the message column): **Copy**, **React**
  (smiley/emoji icon — NOT a thumbs-up), **Reply-in-thread**. For a **running** message a
  **Stop** (✕) icon is prepended and the toolbar is always visible. (A "Branch" icon previously
  existed and was **removed**.)
- **Thread pill:** if a message has replies, a pill shows stacked reply avatars + "N replies ·
  Last reply HH:MM"; clicking opens the right thread panel.

### 5. Composer (bottom of center)
- Rounded shell (`--app-surface`, 1px border, soft shadow); focus-within shows a lilac border +
  3px `--app-accent-soft` ring.
- Auto-growing textarea (min 24px, max 160px). Placeholder: "Mention participants with @name,
  skills with /name, or repo files with #path". **Enter** sends, **Shift+Enter** newlines.
- **Footer bar:** an attach/image icon on the left; a flexible spacer; the **send** button on
  the right (34px lilac circle, white up-arrow, disabled/greyed when empty).
  - (Plus button, mic button, and an "Auto-review" model dropdown were all **removed** — keep
    the footer minimal: attach + send only, plus the run chip below.)
- **Active-run chip** (see component 9) sits inline on the footer bar next to the attach icon.

### 6. Mention / command popover
Triggered by typing `@`, `/`, or `#` in the composer. Floating card above the composer with a
sentence-case label ("Participants" / "Skills" / "Repository files") and rows: an avatar or
glyph + the mono name + a muted sub-label. Click to insert.

### 7. Thread panel (right)
430px panel, slides in from the right when a thread is opened. Header: root message author
(Space Grotesk) + reply count + close button. Body: the root message, a "N replies" divider,
then each reply rendered as a flat message.

---

## Specialized message cards (the important ones)

### 8. Permission request card — `ApprovalCard`
A Codex-style approval prompt rendered inside an agent message.
- **Container:** `max-width 600px`, 1px border, **14px radius**, `--app-surface`, `0 1px 2px`
  shadow, `padding 15px 17px 13px`, `gap 13px`. Focusable (`tabIndex=0`); focus shows lilac
  border + soft ring.
- **Question:** "Do you want to allow `@handle` to {action}?" — 14.5px/600, `@handle` rendered
  as a mono accent token.
- **Command preview:** monospace, 12.5px, 1.7 lh, muted, clamped to ~5 lines with a bottom
  fade mask; an **Expand / Collapse** text toggle (justified right) reveals the full text.
- **Numbered options** (role=listbox): each row `1.` + label, hover/selected → `--app-surface-
  hover` bed + strong text; the selected row shows ↑/↓ key-hint glyphs. Default options:
  "Yes, allow once" / "Yes, allow for this chat" / "No, and tell @handle what to do differently".
- **Footer:** right-aligned **Skip** (ghost text) + **Submit ↵** (dark `--app-text-strong`
  pill, white text, return-key icon).
- **Keyboard:** ↑/↓ move selection, number keys 1–9 jump, Enter/Submit confirms the highlighted
  option. Hover also moves selection; clicking an option selects it (does not immediately submit).

### 9. Choice / decision card — `ChoiceCard`
Visually **identical language to the permission card** (it reuses the `aa-perm*` styles) because
both are "pick a variant" prompts.
- **No eyebrow/kicker** above the title (a "Needs your input" eyebrow was **removed**).
- **Title** (the question) + optional muted **sub-text** body.
- **Numbered options with title + description stacked** (title on its own line, description
  below — never inline). The recommended option is pre-selected and shows a sentence-case
  **"Recommended"** badge (lilac text on `--app-accent-soft`, 5px radius).
- Same keyboard model as the permission card; **Skip** + **Submit ↵** footer.
- **Answered state:** collapses to the title + the single chosen option with a lilac check, and
  a muted "Answered" label (sentence case). Driven by an `answeredDefault` in data for the demo.

### 10. Active-run chip (composer) — `ActiveRunBar`
Compact pill on the composer footer next to the attach icon: a small **lilac spinner** + "N
active run(s)" + an **✕**. 999px radius, 1px border, transparent bg, no-wrap text. Clicking the
pill (or its ✕) stops all runs and the chip disappears. (This started as a large banner at the
top of the stream and was deliberately moved here to reclaim vertical space — keep it compact
and in the composer.)

### 11. Live agent run (in timeline) — `RunningRow`
Renders inside an in-progress agent message as a **plain, message-like** line — **no bubble, no
colored card**:
- Animated **typing dots** (3 muted dots, staggered `aa-typing`) + run title (e.g. "Production
  build", 14px) + a **live mm:ss timer** (mono, muted, ticks every second) + an optional muted
  **mono preview** line (e.g. `vite build --mode production · bundling 1,284 modules…`).
- **Stop** is the **✕ icon in the message's action toolbar** (always visible for running
  messages, turns red/`--app-danger` on hover) — NOT an inline text button.
- When stopped, the row collapses to a muted "Stopped · {title}" line.

### 12. Resolved-action system line — `ApprovalResolvedLine`
A one-line, full-width system row (not a card): a small dot + "Granted {grant} to `@handle` for
this chat." with a right-aligned timestamp and an **Undo** link. Used to show a previously
granted/denied permission compactly in the timeline.

---

## Interactions & Behavior
- **Send message:** Enter sends, Shift+Enter newline; send disabled when empty.
- **Permission/choice selection:** mouse hover or click selects; ↑/↓ and number keys navigate;
  Enter or Submit confirms. Resolving swaps the card to its resolved/answered state.
- **Stop a run:** clickable from (a) the composer run chip (stops all) or (b) the running
  message's toolbar ✕ (stops that run). Both are wired to the **same source of truth** — a list
  of running message IDs — so stopping in one place updates the other and the row collapses to
  "Stopped".
- **Threads:** clicking a thread pill opens the 430px right panel; close returns to two-region.
- **Sidebar collapse:** toggles via the brand-row panel icon.
- **Theme:** moon/sun toggle flips `[data-theme="dark"]` on the root.
- **Density:** a tweak (1–5) drives CSS vars `--d-font`, `--d-msg-gap`, `--d-meta-mb`,
  `--d-content-gap`, `--d-bub-pad` to tighten/loosen the whole stream.
- **Reduced motion:** all spinners/dots/transitions disabled under `prefers-reduced-motion`.

## State Management
Model these as real state in your stack (the prototype keeps them in React state on the root):
- `activeChat` — selected conversation id.
- `runningIds: string[]` — message ids of in-progress agent runs (drives BOTH the timeline
  `RunningRow` and the composer active-run chip). Stop removes an id (or clears all).
- `resolved: Record<msgId, outcome>` — permission cards resolved to "once" | "chat" | "deny".
- `answered: Record<msgId, optionId>` — choice cards answered to a chosen option.
- `threadRoot` — the message whose thread panel is open (or null).
- `collapsed` — sidebar collapsed boolean.
- UI tweaks (message style, avatar mode, provider-accent, density, theme) — app preferences.

## Assets
- `assets/mark.png` — AccordAgents brand swirl mark (user-supplied app icon; replaces the old
  placeholder `mark.svg`). Use the real app icon if you have a vector.
- `assets/avatars/*.png` — agent avatar images (animal set: claude-bunny/cat/dog,
  codex-frog/hamster/dog). The **user avatar is drawn in code** (grey silhouette SVG on a light
  chip) — no image asset.
- `assets/colors_and_type.css` — the AccordAgents design-system token + type stylesheet (source
  of `--font-*`, provider colors, type scale). The chat screen layers app-specific `--app-*`
  tokens on top (in the HTML `<style>`).
- Icons are inline Lucide-style SVGs defined in `aa-components.jsx` (the `Ic` map) — swap for
  your Lucide (or equivalent) icon library, 1.75px stroke.

## Files (in this bundle)
- `AccordAgents Chat.html` — the full screen: token layer (`--app-*`), all component CSS, app
  shell render, and density/tweak wiring. **Start here.**
- `aa-components.jsx` — all React components: `Avatar`, `Message`, `MsgActions`, `Sidebar`,
  `TopBar`, `Composer`, `ThreadPanel`, `ApprovalCard`, `ChoiceCard`, `RunningRow`, `WorkedRow`,
  `ApprovalResolvedLine`, `ActiveRunBar`, and the `Ic` icon set.
- `aa-data.jsx` — the sample roster (`PARTICIPANTS`), projects, and the scripted "Skill
  Post-Merge Fix" conversation (shows every card type). This is **demo content** — replace with
  real data models, but it documents the expected data shapes.
- `tweaks-panel.jsx` — prototype-only tweak panel (message style / avatars / density / theme).
  Not part of the product; ignore for production.
- `assets/` — `mark.png`, `avatars/`, `colors_and_type.css` (+ the old `mark.svg`/`threads.svg`
  placeholders, unused by the chat).
