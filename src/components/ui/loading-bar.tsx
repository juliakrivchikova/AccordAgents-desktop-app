import { cn } from "@/lib/utils";
import { useDelayedFlag } from "./delayed";

export interface LoadingBarProps {
  /** What is loading, for screen readers ("Loading chat"). */
  label: string;
  /** Placement; the bar sits at the top of its positioned container. */
  className?: string;
  /** The wait before it shows (LOADING_DELAY_MS); 0 when the wait has
   *  already been sat through elsewhere. */
  delayMs?: number;
}

/** The quiet mark for an area that is loading: a thin moving line along its
 *  top edge, shown only once the wait lasts (LOADING_DELAY_MS), in place of a
 *  loading card or text over the content (the User, 2026-11-22). */
export const LoadingBar = ({ label, className, delayMs }: LoadingBarProps): JSX.Element | null =>
  useDelayedFlag(true, delayMs) ? <div className={cn("aa-loading-bar", className)} role="progressbar" aria-label={label} /> : null;
