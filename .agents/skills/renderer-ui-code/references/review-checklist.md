# Renderer review checklist

Symptoms to look for in renderer code, by tier. Search hints only locate candidates: read the code before recording a finding, and skip anything the kit file or the User's decisions make the rule.

## Tier 1: behavior and performance

- **Fetching in effects.** `useEffect` calls `window.consensus.*` and stores the result with `setState` where an app hook or snapshot already carries the data.
- **Derived state via effect.** `useEffect(() => setX(f(y)), [y])`, or state copied from props and kept in sync. Compute during render; reset with `key`.
- **Event logic in effects.** A handler sets a flag and an effect reacts to it. Do the work in the handler.
- **Missing cleanup.** `addEventListener`, `setInterval`, `setTimeout`, a subscription opened in an effect without a cleanup.
- **Unstable context or broad subscriptions.** A provider value built every render, or a component reading a whole object for one field.
- **Mutations.** `.push/.splice/.sort/.reverse` or property assignment on props, state or arguments. Search: `\.(push|splice|sort|reverse)\(`.
- **Side effects during render.** IPC calls, storage writes or ref writes in the component body.
- **Concurrency.** A late reply replacing what the User opened since; a second press joining the first; Stop that does not stop. Chat writes go through the main process mutation queue.

## Tier 2: UI consistency and feel

- **Bypassing the kit.** Raw `<button>` styled by hand, `<select>`, hand-made menus, tooltips, dialogs or spinners in a feature. Search: `<select`, `animate-spin`, `Loader2`, `lucide-react`, `role="menu"` outside the kit.
- **Raw values.** Hex, `rgb()`, `hsl()`, px font sizes, shadows or radii in feature code and CSS where a token exists. Search: `#[0-9a-fA-F]{3,8}\b`, `rgba?\(` under `src/renderer`.
- **Wrong radius or size.** A control or row not on radius 8, an overlay not on 12, a toolbar control not 28px.
- **Gray hovers.** `hover:bg-` with a neutral fill on rows, items or ghost buttons instead of `hover:bg-ui-row-hover`.
- **Native tooltips.** `title=` on buttons and links. Search: `title=\{|title="` in `.tsx`.
- **Flashing loaders.** A spinner, "Loading" text or loading card shown without `Delayed`; content cleared while the next loads.
- **Layout jumps.** A mark inserted before a title, a control that moves between states, a button that widens on a quick press.
- **Copy.** Em dashes or middle dots used as separators in UI text.

## Tier 3: structure

- Files over 400 lines; logic and markup mixed in one component; helpers inside components that close over nothing; prop drilling through three or more levels; whole objects passed for one or two fields.
- Duplicates: two implementations of one concern (two selects, two time formatters, two hover colors).
- Tests that do the compiler's job or pin wiring, copy or class names.

## Tier 4: style (only in touched files)

- `function Component()` instead of `const Component = () =>`; props typed inline or with `type`; comments that restate the code.

## Finding format

One line per finding:

```
- [T2][kit] src/renderer/components/foo/bar.tsx:42: raw <select> duplicates AppSelect → use AppSelect size="sm". Risk: med ⚠ visual. Effort: S.
```

Tier and category (`effects`, `state`, `mutation`, `kit`, `tokens`, `feel`, `structure`, `pure`, `props`, `tests`, `style`), `file:line`, problem → fix, risk (`low`, `med`, `high`; add `⚠ behavior` or `⚠ visual`), effort (`S`, `M`, `L`).
