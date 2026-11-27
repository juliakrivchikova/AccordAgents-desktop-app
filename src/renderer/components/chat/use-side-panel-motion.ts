import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type SidePanelMotion = "opening" | "closing";

/** The slide's length: --ui-duration-slow, as the sidebar's (shell.css). */
const SIDE_PANEL_MOTION_MS = 240;

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The chat's right side moves as the left sidebar does (the User,
 * 2026-11-26): opened, it slides in and fades in; closed, what it showed
 * stays while it slides out over the timeline, then goes. Switching from one
 * panel to another while the side is open does not move it.
 */
export function useSidePanelMotion(content: ReactNode | null): { content: ReactNode | null; motion?: SidePanelMotion } {
  const shown = content !== null;
  const lastShown = useRef<ReactNode | null>(content);
  const [state, setState] = useState<{ shown: boolean; motion?: SidePanelMotion }>({ shown });
  if (state.shown !== shown) {
    setState({ shown, motion: prefersReducedMotion() ? undefined : shown ? "opening" : "closing" });
  }
  useLayoutEffect(() => {
    // Kept only while it slides out: once gone, nothing of it is held.
    lastShown.current = shown ? content : state.motion === "closing" ? lastShown.current : null;
  });
  useEffect(() => {
    if (!state.motion) return undefined;
    const timer = window.setTimeout(() => setState({ shown: state.shown }), SIDE_PANEL_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  return { content: shown ? content : state.motion === "closing" ? lastShown.current : null, motion: state.motion };
}
