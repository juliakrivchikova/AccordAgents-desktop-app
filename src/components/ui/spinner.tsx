import * as React from "react";

import { cn } from "@/lib/utils";

const RAY_ANGLES = [0, 60, 120, 180, 240, 300] as const;

export interface SpinnerProps {
  /** Side in pixels; the star scales with it (12 in rows, 14 in buttons). */
  size?: number;
  className?: string;
  /** Read out as a status; without it the spinner is decoration. */
  label?: string;
}

/**
 * The app's one spinner (the User, 2026-11-22): a six-ray star whose rays
 * shrink in a wave around it while it turns, drawn in the current color.
 * Every spinner on screen runs in one phase: each starts at the document's
 * time origin, so one shown later joins the others mid-turn.
 */
export const Spinner = ({ size = 16, className, label }: SpinnerProps): JSX.Element => {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    if (ref.current) syncSpinner(ref.current);
    watchWindowFocus();
  }, []);
  return (
    <span
      ref={ref}
      className={cn("aa-spinner", className)}
      style={{ "--aa-spinner-size": `${size}px` } as React.CSSProperties}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {RAY_ANGLES.map((angle) => (
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <line x1="12" y1="3.5" x2="12" y2="10" />
          </g>
        ))}
      </svg>
    </span>
  );
};

function syncSpinner(element: Element): void {
  if (typeof element.getAnimations !== "function") return;
  for (const animation of element.getAnimations({ subtree: true })) animation.startTime = 0;
}

// Spinners pause while the window is in the background (.app-inactive) and
// resume where they stopped: on return they are put back in one phase.
let watchingFocus = false;
function watchWindowFocus(): void {
  if (watchingFocus || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  watchingFocus = true;
  window.addEventListener("focus", () => {
    window.requestAnimationFrame(() => document.querySelectorAll(".aa-spinner").forEach(syncSpinner));
  });
}
