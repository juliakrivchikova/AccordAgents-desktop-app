import { ChartBarIcon, ClockIcon } from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import "./loading-states.css";
import { Spinner } from "@/components/ui/spinner";
import { useDelayedFlag } from "@/components/ui/delayed";

export interface AppLoadingStateProps {
  title?: string;
  description?: ReactNode;
  /** The wait before it shows (LOADING_DELAY_MS); 0 when the wait has
   *  already been sat through elsewhere. */
  delayMs?: number;
}

export function AppLoadingState({
  title = "Preparing workspace",
  description = "Loading settings, agents, and recent consensus history.",
  delayMs
}: AppLoadingStateProps): JSX.Element {
  // A quick load shows an empty area, not a loader that flashes.
  if (!useDelayedFlag(true, delayMs)) return <div className="app-loading-state" aria-busy="true" />;
  return (
    <div className="app-loading-state" role="status" aria-live="polite">
      <div className="app-loading-state__panel">
        <div className="loading-state-icon">
          <Spinner />
        </div>
        <div className="app-loading-state__copy">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="app-loading-state__skeleton" aria-hidden>
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      </div>
    </div>
  );
}

export function HistoryLoadingState(): JSX.Element | null {
  if (!useDelayedFlag(true)) return null;
  return (
    <div className="history-loading-state" role="status" aria-live="polite" aria-label="Loading history">
      <div className="history-loading-state__label">
        <ClockIcon aria-hidden />
        <span>Syncing history</span>
      </div>
      {Array.from({ length: 7 }, (_, index) => (
        <div className="history-loading-state__row" key={index} aria-hidden>
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-2.5 w-2/5" />
        </div>
      ))}
    </div>
  );
}

export interface ChartLoadingStateProps {
  title?: string;
  description?: string;
}

export function ChartLoadingState({
  title = "Building point map",
  description = "Consensus points will populate as agents finish their passes."
}: ChartLoadingStateProps): JSX.Element {
  return (
    <div className="chart-loading-state" role="status" aria-live="polite">
      <div className="chart-loading-state__header">
        <div className="loading-state-icon">
          <ChartBarIcon aria-hidden />
        </div>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="chart-loading-state__bars" aria-hidden>
        {[62, 84, 46, 72].map((height, index) => (
          <span key={index} style={{ "--bar-height": `${height}%` } as CSSProperties} />
        ))}
      </div>
      <div className="chart-loading-state__rows" aria-hidden>
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
