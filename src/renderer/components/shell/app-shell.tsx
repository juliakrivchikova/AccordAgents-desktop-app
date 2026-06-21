import * as React from "react";

import { cn } from "@/lib/utils";

export interface AppShellProps {
  sidebar: React.ReactNode;
  topBar: React.ReactNode;
  children: React.ReactNode;
  sidebarCollapsed?: boolean;
  className?: string;
}

export const AppShell = ({ sidebar, topBar, children, sidebarCollapsed = false, className }: AppShellProps): JSX.Element => (
  <div
    data-shell="root"
    data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined}
    className={cn(
      "app-shell-root grid h-full min-h-0 bg-[var(--app-workspace-bg)] text-foreground",
      className
    )}
  >
    {/* The sidebar stays mounted while collapsed so the slot width can animate
        and its scroll/expansion state survives a hide/show. */}
    <div data-shell="sidebar-slot" className="app-shell-sidebar-slot" aria-hidden={sidebarCollapsed || undefined}>
      {sidebar}
    </div>
    <main
      data-shell="workspace"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {topBar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </main>
  </div>
);
