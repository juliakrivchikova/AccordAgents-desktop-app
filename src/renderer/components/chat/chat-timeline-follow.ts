// Scrolling down to closer than this to the end follows the chat again.
const NEAR_BOTTOM_PX = 96;
// The end itself, give or take rounding.
const AT_BOTTOM_PX = 1;
// Smaller moves than this are rounding (fractional positions on HiDPI screens).
export const SUBPIXEL_PX = 0.5;

/** The keys that scroll a focused scroller: pressing one is the User scrolling. */
export function isScrollKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp" || key === "End" || key === "Home" ||
    key === "PageDown" || key === "PageUp" || key === " ";
}

/**
 * Whether a chat follows its newest message after a scroll.
 *
 * Any scroll up by the User leaves the end at once, even inside the last
 * NEAR_BOTTOM_PX. Counting that strip as the end re-pinned the chat on every
 * small trackpad step, and the next streamed chunk pulled the view back down:
 * the timeline jumped between her position and the end until she escaped the
 * strip in one flick. Only the User scrolling down into the strip, or the view
 * reaching the very end (a row collapsed under it), follows again.
 *
 * `moved` is the User's own move since the previous scroll event: the caller
 * leaves out the positions the app writes itself (pinning to the end, keeping a
 * row in place while rows above are measured), or a row growing above her would
 * read as a scroll down and re-pin the chat.
 */
export function followsLatestAfterScroll(scroll: {
  distanceFromBottom: number;
  moved: number;
  /** The content got shorter since the previous scroll event: a move up may be
   *  the browser clamping the view to the new end, not the User. */
  contentShrank: boolean;
  userScrolling: boolean;
  following: boolean;
}): boolean {
  // Even a pixel up from the very end: on a slow trackpad every step is that small.
  if (scroll.userScrolling && scroll.moved < 0 && !scroll.contentShrank) {
    return false;
  }
  if (scroll.distanceFromBottom <= AT_BOTTOM_PX) {
    return true;
  }
  if (!scroll.userScrolling) {
    return scroll.following;
  }
  if (scroll.moved < 0) {
    return false;
  }
  // Only a real move down: a sub-pixel jitter (HiDPI rounding) is no move.
  return scroll.moved > SUBPIXEL_PX ? scroll.distanceFromBottom < NEAR_BOTTOM_PX : scroll.following;
}
