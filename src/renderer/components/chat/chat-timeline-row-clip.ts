import { measureElement, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";

const measuredKeysByVirtualizer = new WeakMap<object, Set<VirtualItem["key"]>>();
// Far enough out that nothing a row draws outside its box (the hover toolbar above it,
// the jump highlight around it) is cut while the clip is on.
const CLIP_OUTSET_PX = 4096;

/**
 * The virtualizer's measureElement option: measures as it always does and remembers
 * that the row has been measured, which `unmeasuredRowClip` needs. When the row turns
 * out exactly as tall as it was laid out, its clip is taken off right away; otherwise
 * the render that lays it out at its real height takes it off.
 */
export function measureRowAndRemember(
  element: Element,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLDivElement, Element>
): number {
  const size = measureElement(element, entry, instance);
  const index = instance.indexFromElement(element);
  const key = instance.options.getItemKey(index);
  let measured = measuredKeysByVirtualizer.get(instance);
  if (!measured) {
    measured = new Set();
    measuredKeysByVirtualizer.set(instance, measured);
  }
  measured.add(key);
  const item = instance.measurementsCache[index];
  if (item?.key === key && Math.abs(item.size - size) < 1 && element instanceof HTMLElement) {
    element.style.clipPath = "";
  }
  return size;
}

/**
 * A row is laid out at its estimated height until the virtualizer has measured it,
 * which for a row mounted during a scroll happens after the frame is painted. A long
 * message drawn in that frame spilled over the rows under it; clipping what it draws
 * below its estimated height hides the spill until the measured layout arrives.
 * clip-path leaves the row's own size, which is what gets measured, untouched, and
 * popovers render outside the row.
 */
export function unmeasuredRowClip(virtualizer: Virtualizer<HTMLDivElement, Element>, item: VirtualItem): { clipPath?: string } {
  // The last row has nothing under it to spill over: a reply arriving at the bottom
  // shows in full at once.
  if (item.index >= virtualizer.options.count - 1 || measuredKeysByVirtualizer.get(virtualizer)?.has(item.key)) {
    return {};
  }
  const out = CLIP_OUTSET_PX;
  return {
    clipPath: `polygon(-${out}px -${out}px, calc(100% + ${out}px) -${out}px, calc(100% + ${out}px) ${item.size}px, -${out}px ${item.size}px)`
  };
}
