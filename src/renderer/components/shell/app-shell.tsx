import * as React from "react";

import { cn } from "@/lib/utils";
import {
  MAX_APP_SIDEBAR_WIDTH,
  MIN_APP_SIDEBAR_WIDTH,
  maxAppSidebarWidthForContainer,
  normalizeAppSidebarWidth
} from "../../lib/sidebar-sizing";

export interface AppShellProps {
  rail: React.ReactNode;
  sidebar: React.ReactNode;
  topBar: React.ReactNode;
  children: React.ReactNode;
  sidebarCollapsed?: boolean;
  sidebarHidden?: boolean;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
  className?: string;
}

export const AppShell = ({
  rail,
  sidebar,
  topBar,
  children,
  sidebarCollapsed = false,
  sidebarHidden = false,
  sidebarWidth,
  onSidebarWidthChange,
  className
}: AppShellProps): JSX.Element => {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const cleanupResizeRef = React.useRef<(() => void) | null>(null);
  const [isResizingSidebar, setIsResizingSidebar] = React.useState(false);
  const normalizedSidebarWidth = normalizeAppSidebarWidth(sidebarWidth);
  const secondarySidebarCollapsed = sidebarCollapsed || sidebarHidden;

  // Tear down any in-flight drag listeners if the shell unmounts mid-resize.
  React.useEffect(() => () => cleanupResizeRef.current?.(), []);

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>): void {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingSidebar(true);
    const rect = root.getBoundingClientRect();
    const railWidth = appRailWidth(root);
    const minWidth = MIN_APP_SIDEBAR_WIDTH;
    const maxWidth = maxAppSidebarWidthForContainer(rect.width - railWidth);

    const move = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.round(moveEvent.clientX - rect.left - railWidth);
      onSidebarWidthChange(Math.min(maxWidth, Math.max(minWidth, nextWidth)));
    };
    const stop = (): void => {
      setIsResizingSidebar(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      cleanupResizeRef.current = null;
    };
    cleanupResizeRef.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  return (
    <div
      data-shell="root"
      data-sidebar-collapsed={secondarySidebarCollapsed ? "true" : undefined}
      data-sidebar-hidden={sidebarHidden ? "true" : undefined}
      ref={rootRef}
      style={{ "--app-sidebar-width": `${normalizedSidebarWidth}px` } as React.CSSProperties}
      className={cn(
        "app-shell-root grid h-full min-h-0 bg-[var(--app-workspace-bg)] text-foreground",
        isResizingSidebar && "resizing-sidebar",
        className
      )}
    >
      <div data-shell="rail-slot" className="app-shell-rail-slot">
        {rail}
      </div>
      {/* The sidebar stays mounted while collapsed so the slot width can animate
          and its scroll/expansion state survives a hide/show. */}
      <div data-shell="sidebar-slot" className="app-shell-sidebar-slot" aria-hidden={secondarySidebarCollapsed || undefined}>
        {sidebar}
      </div>
      {!secondarySidebarCollapsed && (
        <div
          className="app-shell-sidebar-resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_APP_SIDEBAR_WIDTH}
          aria-valuemax={MAX_APP_SIDEBAR_WIDTH}
          aria-valuenow={normalizedSidebarWidth}
          onPointerDown={startSidebarResize}
        />
      )}
      <main
        data-shell="workspace"
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
      >
        {topBar}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </main>
    </div>
  );
};

function appRailWidth(root: HTMLElement): number {
  const value = getComputedStyle(root).getPropertyValue("--app-rail-width");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 90;
}
