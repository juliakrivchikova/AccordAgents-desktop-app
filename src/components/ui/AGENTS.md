# UI kit rules

This folder is the UI kit: domain-agnostic components built on shadcn and Radix (`radix-ui`), styled only with the app's tokens. Every renderer screen is composed from it. Read this file before adding or changing anything here, and before building UI in a feature. The process for writing renderer code is the `renderer-ui-code` skill.

## Where things live

- `src/components/ui/*`: the kit. One component per job (`Button`, `Select`, `Dialog`, `Popover`, `Tooltip`, `Switch`, `Spinner`, `LoadingBar`, `Delayed`...). No imports from features, `src/shared` or the IPC bridge, and no props named after business entities.
- `src/renderer/components/primitives/*`: app-level compositions of the kit that every feature shares (`AppSelect`, `IconButton`, `SidePanelIcon`, `Notice`, `EmptyState`, `FormRow`...). Import them from `../primitives` (the index).
- `src/renderer/components/<feature>/*`: domain components, composed from the two above.
- Tokens: `src/renderer/styles/app-theme.css` (`--ui-*`, light in `:root`, dark in `.dark`, exposed to Tailwind through `@theme inline`). The `--app-*` names are legacy aliases: read them, do not add new ones.

## Extending the kit

1. Look for an existing component first (`grep -rn "@/components/ui/<name>" src`). A variant of the same job is a new `variant` or `size`, a slot or `children`, never a behavior-changing boolean flag. A different job is a new kit component.
2. New props are optional with defaults, so no consumer changes by accident. Before changing a default or a style, list every consumer and check them; a kit change is a change to every screen.
3. Design the API for the use case in front of you; generalize when a second real use appears.
4. Keep the shadcn file shape (`data-slot`, `cn()`, `cva` variants) so upstream updates stay mergeable.

## Tokens only

- Colors: `bg-ui-*`, `text-ui-*`, `border-ui-*`, or `var(--ui-*)` in CSS. No hex, `rgb()` or `hsl()` in features; `make lint-colors` enforces it.
- Text: `text-ui-11/12/13/14/16/20`. Body and controls are 13, chat text and the composer 14, view titles 16, a screen's one heading 20. Weights 400, 500 for labels and buttons, 600 for headings.
- Radii: `rounded-ui-8` for every control, row, list item, menu item, icon button, option and card; `rounded-ui-12` for overlays (popover, context menu, select content, dialog) and the composer; `rounded-ui-6` only for a segmented tab inside an 8px track. Small marks (code, kbd, avatars) keep their own.
- Motion: `duration-120 ease-ui-out` for hover and press. No decorative entrance animations. The global reduced-motion rule stays in force.

## Sizes

- 28px (`h-7`, `size="sm"`, `IconButton` default) for toolbars, settings rows, list rows and selects; 24px (`xs`) for dense rows; 32px (`default`) for dialog actions.
- Icons: 14px in 28px controls, 16px in headers and empty states, 12px in list marks.
- Title rows are `--app-header-height` tall (46px in the window, 34px inside the inset workspace) so their middle stays level with the macOS traffic lights.

## Hover, selection, focus

- Hover on rows, list items, menu items and ghost buttons: `hover:bg-ui-row-hover`, a soft brand tint. Never a gray hover.
- Selected: `bg-ui-row-active text-ui-select-fg`. Cards: `--ui-card-hover-bg` and `--ui-card-hover-border` on hover.
- Focus: `focus-visible:ring-2 focus-visible:ring-ui-focus-ring`, with `ring-offset-2 ring-offset-ui-bg` on filled controls.
- The composer is the exception: no border or ring while typing, the caret is enough.

## Icons

- Phosphor only (`@phosphor-icons/react`, the `...Icon` names), regular weight; `fill` marks a pressed or open state. No `lucide-react`.
- The side panel toggle is `SidePanelIcon`; reuse it rather than mirroring an icon again.

## Popups and tooltips

- Tooltips are the kit `Tooltip` (provider delay 600ms, 300ms between neighbours). Pass `tooltip` to `IconButton` when a label needs one.
- No native `title` on interactive controls: it shows at once and looks foreign. Hover cards open after 500ms.
- Every popup is delayed; nothing pops up on a pointer passing by.

## Select

One select everywhere: the kit `Select` (shadcn on our tokens). Features use `AppSelect` from primitives: options with an optional icon, `size="sm"` in settings rows, content opens under the trigger at its width, radius 12, and the chosen item shows only a check. Do not build dropdown menus out of buttons for a choice of values.

## Loading and layout stability

The User finds flicker and jumping unacceptable (2026-11-22). The rules:

- No loading card or "Loading…" text over content. Opening something keeps the old content on screen until the new one is in.
- A wait shows nothing for its first `LOADING_DELAY_MS` (400ms). Wrap any loading mark (a spinner in a button, a "Loading" line, a placeholder) in `Delayed`, or use `useDelayedFlag`.
- An area that loads for longer gets `LoadingBar`: a thin moving line along its top edge.
- A click never adds a mark that pushes text aside. Marks sit after the title (a row's spinner and dots are at its end), and a control keeps its position across states (the sidebar toggle stands in the same place open and closed).
- Show a press at once through the control itself (selected row, disabled button), not through a new element.

## Spinner

- Only the kit `Spinner`: the six-ray star the User chose (variant B). All spinners share one phase.
- Its color comes from where it sits: the link color in text and rows, the button's color inside a button. Sizes: 12 in list rows, 14 in buttons and status lines, 16 on its own.
- Give it `label` when it is the only sign of the state; otherwise it is hidden from screen readers.
- It is for work that is going on (a running chat, a long install), not for a quick request; wrap the quick case in `Delayed`.

## Scrollbars

Scrollbars are hidden until their area is hovered (global rule in `app-foundation.css`). Do not restyle them per component, and do not set `scrollbar-width`: it makes macOS show classic, always-visible bars.

## Copy

UI text is English. No em dashes and no middle dots as separators: use commas, colons, parentheses or separate elements.

## Before a kit change is done

`make typecheck`, `make lint-colors`, `make lint-lines`, `make lint-unused`, `make build`, the renderer tests that cover the consumers, then a live look at every consumer in light and dark through the `electron-desktop-qa` skill. No tests that pin class names, copy or snapshots.
