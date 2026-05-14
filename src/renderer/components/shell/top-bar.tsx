import * as React from "react";

import { cn } from "@/lib/utils";

export interface TopBarProps {
  title?: React.ReactNode;
  tabs?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const TopBar = ({ title, tabs, actions, className }: TopBarProps): JSX.Element => (
  <header
    data-shell="topbar"
    className={cn(
      "flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-[var(--app-surface)] px-3",
      className
    )}
  >
    <div className="flex min-w-0 items-center gap-2">
      {tabs ? (
        tabs
      ) : title ? (
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
      ) : null}
    </div>
    <div className="flex shrink-0 items-center gap-1">{actions}</div>
  </header>
);
