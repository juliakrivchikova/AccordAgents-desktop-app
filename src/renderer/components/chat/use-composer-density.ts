import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * How compact a composer's controls are drawn so they fit its row, as T3
 * Code fits its composer footer (composerFooterLayout.ts) and Claude's
 * desktop app its narrow composers: never a one-letter stub ("D…"), each
 * control either shows its full value or turns into an icon whose tooltip
 * and menu name the value; the model keeps its name longest. Each level
 * keeps the ones below it.
 */
export const COMPOSER_DENSITY = {
  /** Where it runs as an icon. */
  runsOnIcon: 1,
  /** Codex's Plan mode as an icon. */
  planIcon: 2,
  /** The permission mode as an icon. */
  modeIcon: 3,
  /** The effort as an icon. */
  effortIcon: 4,
  /** The model without its provider's glyph. */
  modelWithoutGlyph: 5,
  /** The model's name shortened with an ellipsis (never under a few
   *  letters). */
  modelShortened: 6
} as const;

const COMPOSER_DENSITY_MAX = COMPOSER_DENSITY.modelShortened;

/** The row a composer's controls live in: its width is the composer's, never
 *  the controls' own. */
const ROW_SELECTOR = ".chat-composer-toolbar, .new-chat-toolbar";

/**
 * The density at which `ref`'s controls fit (they overflow their own box,
 * which shrinks with the row, when they do not). Measured before paint each
 * time the row's width or what the controls say (`contentKey`) changes:
 * from the fullest form, one step at a time. Nothing else measures: reading
 * the controls' size forces the browser to lay the page out, and the
 * composer renders again for every streamed token of a running turn.
 */
export function useComposerDensity(ref: RefObject<HTMLElement>, contentKey: string): number {
  const [density, setDensity] = useState(0);
  // Bumped to measure again even when the density is already 0 (a row that
  // narrowed from its fullest form renders nothing new by itself).
  const [measure, setMeasure] = useState(0);
  const measured = useRef<{ key: string; width: number }>({ key: contentKey, width: -1 });

  // New content starts from its fullest form again.
  if (measured.current.key !== contentKey) {
    measured.current = { key: contentKey, width: measured.current.width };
    if (density !== 0) setDensity(0);
  }

  // Once the controls say something new, the row's width changed, or a step
  // was just taken: one step more compact while the controls overflow.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || density >= COMPOSER_DENSITY_MAX) return;
    if (overflows(element)) {
      setDensity((current) => Math.min(COMPOSER_DENSITY_MAX, current + 1));
    }
  }, [ref, density, contentKey, measure]);

  // The row grew or shrank: measure again from the fullest form, before the
  // browser paints the controls at the old density.
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver !== "function" || typeof element.closest !== "function") return;
    const row = element.closest(ROW_SELECTOR) ?? element.parentElement;
    if (!row) return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[entries.length - 1]?.contentRect.width ?? row.getBoundingClientRect().width);
      if (width === measured.current.width) return;
      const first = measured.current.width < 0;
      measured.current = { ...measured.current, width };
      if (first) return;
      flushSync(() => {
        setDensity(0);
        setMeasure((count) => count + 1);
      });
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [ref]);

  return density;
}

/** Whether the controls do not fit their box: more than it scrolls to, or a
 *  control outside it on either side. */
function overflows(element: HTMLElement): boolean {
  if (element.scrollWidth > element.clientWidth + 0.5) return true;
  if (typeof element.getBoundingClientRect !== "function") return false;
  const box = element.getBoundingClientRect();
  const first = element.firstElementChild?.getBoundingClientRect();
  const last = element.lastElementChild?.getBoundingClientRect();
  return Boolean(first && first.left < box.left - 0.5) || Boolean(last && last.right > box.right + 0.5);
}
