import * as React from "react";

/** How long a wait goes unmarked. Most waits in the app (opening a chat,
 *  loading a panel, a quick save) end well within it, and a loader that
 *  shows for a moment only flickers and shifts what is around it (the User,
 *  2026-11-22). */
export const LOADING_DELAY_MS = 400;

/** True once `active` has stayed true for `delayMs`; false again as soon as
 *  it ends. A delay of 0 or less is true at once. */
export function useDelayedFlag(active: boolean, delayMs: number = LOADING_DELAY_MS): boolean {
  const [elapsed, setElapsed] = React.useState(false);
  React.useEffect(() => {
    setElapsed(false);
    if (!active || delayMs <= 0) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && (delayMs <= 0 || elapsed);
}

export interface DelayedProps {
  children: React.ReactNode;
  /** Defaults to LOADING_DELAY_MS. */
  delayMs?: number;
}

/** Shows its children only once they have been on screen for a while: the
 *  wrapper for every loading mark (a spinner, a "Loading…" line), so a wait
 *  that ends quickly shows nothing at all. */
export const Delayed = ({ children, delayMs }: DelayedProps): JSX.Element | null => {
  const shown = useDelayedFlag(true, delayMs);
  return shown ? <>{children}</> : null;
};
