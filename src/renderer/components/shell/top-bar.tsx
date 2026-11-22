import * as React from "react";

import { cn } from "@/lib/utils";

export interface TopBarProps {
  title?: React.ReactNode;
  tabs?: React.ReactNode;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const TopBar = ({ title, tabs, leading, actions, className }: TopBarProps): JSX.Element => (
  <header
    data-shell="topbar"
    data-titlebar
    className={cn(
      "flex h-[var(--app-header-height)] shrink-0 items-center justify-between gap-2 border-b border-ui-border-subtle bg-ui-bg pr-2",
      className
    )}
  >
    <div className="flex min-w-0 items-center gap-2">
      {leading}
      {tabs ? (
        tabs
      ) : title ? (
        typeof title === "string" || typeof title === "number" ? (
          <div className="truncate text-ui-13 font-semibold text-ui-text">{title}</div>
        ) : (
          <div className="min-w-0">{title}</div>
        )
      ) : null}
    </div>
    <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
  </header>
);
