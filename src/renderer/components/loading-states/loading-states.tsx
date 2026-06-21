import { BarChart3, Clock3, Loader2 } from "lucide-react";
import type { CSSProperties } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import "./loading-states.css";

export interface AppLoadingStateProps {
  title?: string;
  description?: string;
}

export function AppLoadingState({
  title = "Preparing workspace",
  description = "Loading settings, agents, and recent consensus history."
}: AppLoadingStateProps): JSX.Element {
  return (
    <div className="app-loading-state" role="status" aria-live="polite">
      <div className="app-loading-state__panel">
        <div className="loading-state-icon">
          <Loader2 aria-hidden />
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

export function HistoryLoadingState(): JSX.Element {
  return (
    <div className="history-loading-state" role="status" aria-live="polite" aria-label="Loading history">
      <div className="history-loading-state__label">
        <Clock3 aria-hidden />
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
          <BarChart3 aria-hidden />
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
