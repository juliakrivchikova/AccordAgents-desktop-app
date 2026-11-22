---
name: renderer-ui-code
description: >
  How to write, change and review React/TypeScript renderer code and UI in
  AccordAgents: the UI kit and its tokens, component structure, state and
  effects placement, pure functions, DRY without speculative abstraction,
  loading and layout stability, types instead of tests, and the checks that
  close a change. Use it whenever code under src/renderer or src/components
  is written, changed, refactored or reviewed: a new screen or component, a
  CSS or Tailwind tweak, a hook, a kit change, a UI bug fix, a design review,
  including requests in Russian («сделай экран», «поправь вёрстку»,
  «отрефактори компонент», «проверь UI»). Runs inside implement-change, which
  still owns tests, review and end-to-end QA.
---

# Writing renderer UI code

The rules below come from the User's code style (`~/.agents/AGENTS.md`, "React / TypeScript code style") and from decisions made on this app. Read `src/components/ui/AGENTS.md` (the kit rules) before touching UI, and `docs/parity-requirements.md` before changing what a single participant shows. Project conventions win over generic advice; the User's decisions recorded here win over both.

## 1. Find before you write (DRY)

- Search for what already does the job: a kit component (`src/components/ui`), a primitive (`src/renderer/components/primitives`), a hook in `src/renderer/app` or next to the feature, a pure function in `src/shared` or the feature. Reuse it, extend it with a variant, or extract it; do not write a second one.
- One implementation per concern: one select, one spinner, one hover color, one loading rule, one way to format a time. A copy that differs a little is still a copy; the next fix lands in one of them only.
- Extract at the second real use, not before. No layers, options, fallbacks or "generic" helpers for a case that does not exist yet.
- A general rule beats per-case code: a token instead of a value at each site, a kit behavior instead of the same three lines in every feature (the 400ms loading delay lives in `Delayed`, not in each screen).

## 2. Components

- Arrow functions: `const Component = () => {}`. Props as an explicit `interface`, only the props the component uses, primitives rather than whole objects where practical.
- Composition over flags: small pieces, `children`, compound components (`Card.Header`). Many props or behavior-changing booleans mean the component should be split.
- Presentational components stay presentational: calculations go to pure functions, state and effects to hooks. Container and presentational parts are separate for complex features.
- Always handle loading and error states, by the loading rules in the kit file: nothing for a quick wait, `LoadingBar` or a delayed mark for a long one, the old content kept on screen meanwhile.
- Files stay under 400 lines (`make lint-lines`); split and group related components in a directory.
- Comment only a non-obvious why. A decision the User made gets a short note with the date, so nobody undoes it as a bug.

## 3. UI kit

- Build from the kit and primitives; never raw `<select>`, hand-made dropdowns, tooltips, dialogs or spinners in a feature.
- Colors, sizes, radii, spacing and motion come from tokens only (see the kit file). No hex or `rgb()` in features.
- Kit components stay domain-agnostic. A kit change touches every consumer: optional props with defaults, every usage checked, a live look at them.
- Look and behavior the User chose are fixed until the User changes them: the brand-tint hover (no gray hovers), radius 8 for controls and 12 for overlays, the star spinner, delayed popups and no native `title`, the inset workspace panel, scrollbars hidden until hover, no brand name beside the traffic lights.

## 4. State and effects

Put each kind of state where it belongs; the lower it lives, the fewer re-renders.

- Server and main-process data: the app's data paths (`window.consensus` calls in hooks under `src/renderer/app`, snapshots from `onConversationUpdated`), not ad hoc `useEffect` + `useState` copies.
- Shared client state: the app state and its refs; components subscribe to the slice they read. No frequently changing objects in context.
- Local UI state: as close to its use as possible.
- Derived values: computed during render (`useMemo` if expensive), never `useEffect` + `setState`.
- Reactions to user actions: in the event handler, not an effect watching a flag.
- Sync with external systems (timers, listeners, sockets, DOM APIs): a hook with cleanup. This is the legitimate use of `useEffect`.
- `memo`, `useMemo` and `useCallback` only after a Profiler measurement, and only with referentially stable inputs.

## 5. Pure functions

- Business logic, formatting, validation and data mapping are pure functions at module level or in their own file, tested without React.
- Never mutate props, state or arguments; return new objects and arrays. Rendering has no side effects.

## 6. Types and tests: smart, not hard

- What TypeScript can enforce gets a type, not a test: props, discriminated unions with exhaustive switches, `Record<Union, ...>` and `satisfies` for exhaustive maps, typed IPC in `src/shared/types.ts`.
- Before adding a test, name the regression it catches. Test user flows, pure functions with real branching, races and cancellation, and one regression test per fixed bug, proved to fail on the old code.
- No tests that pin copy, class names or snapshots, and no `vi.mock` of the project's own modules with call assertions. Test code stays around 15 to 20% of production code.

## 7. Stability and feel

- A press shows at once through the control itself; a wait shows nothing for 400ms; a long wait shows a quiet mark. Never a card or text flashing for a tenth of a second.
- Nothing jumps: marks go after the text they annotate, controls keep their place across states, a spinner never appears in front of a title on a quick action.
- Check alignment by measuring (`getBoundingClientRect` over CDP), not by eye: centers of a row's parts, the title rows against the traffic lights, the same control in both states.
- Before a large visual change, show the User mockups built on the real tokens (several variants while the direction is open) and wait for a choice.

## 8. Closing a change

Run once for the coherent batch: `make typecheck`, `make lint-colors`, `make lint-lines`, `make lint-unused`, the renderer tests that cover the change (`npm run test:renderer-components` and the focused suites), `make build`. Then a live pass in the running app with the `electron-desktop-qa` skill, light and dark, at the minimum window size (1080x720). Report what was measured, what was only looked at, and what was not checked.

For a review of renderer code, walk `references/review-checklist.md` and report findings in its format.
