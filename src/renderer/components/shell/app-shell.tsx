import * as React from "react";

import { cn } from "@/lib/utils";
import {
  MAX_APP_SIDEBAR_WIDTH,
  MIN_APP_SIDEBAR_WIDTH,
  MIN_APP_WORKSPACE_WIDTH,
  maxAppSidebarWidthForContainer,
  normalizeAppSidebarWidth
} from "../../lib/sidebar-sizing";

export interface AppShellProps {
  topStrip: React.ReactNode;
  rail: React.ReactNode;
  sidebar: React.ReactNode;
  topBar: React.ReactNode;
  children: React.ReactNode;
  sidebarCollapsed?: boolean;
  sidebarHidden?: boolean;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
  minWorkspaceWidth?: number;
  className?: string;
}

export const AppShell = ({
  topStrip,
  rail,
  sidebar,
  topBar,
  children,
  sidebarCollapsed = false,
  sidebarHidden = false,
  sidebarWidth,
  onSidebarWidthChange,
  minWorkspaceWidth = MIN_APP_WORKSPACE_WIDTH,
  className
}: AppShellProps): JSX.Element => {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const cleanupResizeRef = React.useRef<(() => void) | null>(null);
  const previousSidebarHiddenRef = React.useRef(sidebarHidden);
  const [isResizingSidebar, setIsResizingSidebar] = React.useState(false);
  const [rootMetrics, setRootMetrics] = React.useState<{ width: number; railWidth: number } | undefined>();
  const normalizedSidebarWidth = normalizeAppSidebarWidth(sidebarWidth);
  const secondarySidebarCollapsed = sidebarCollapsed || sidebarHidden;
  const sidebarVisibilityChanged = previousSidebarHiddenRef.current !== sidebarHidden;
  const effectiveSidebarMax = rootMetrics
    ? maxAppSidebarWidthForContainer(rootMetrics.width - rootMetrics.railWidth, minWorkspaceWidth)
    : MAX_APP_SIDEBAR_WIDTH;
  const effectiveSidebarWidth = secondarySidebarCollapsed || !rootMetrics
    ? normalizedSidebarWidth
    : Math.min(normalizedSidebarWidth, effectiveSidebarMax);

  // Tear down any in-flight drag listeners if the shell unmounts mid-resize.
  React.useEffect(() => () => cleanupResizeRef.current?.(), []);
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return undefined;
    }
    const updateMetrics = (): void => {
      const nextMetrics = {
        width: root.getBoundingClientRect().width,
        railWidth: appRailWidth(root)
      };
      setRootMetrics((current) => {
        if (current?.width === nextMetrics.width && current.railWidth === nextMetrics.railWidth) {
          return current;
        }
        return nextMetrics;
      });
    };
    updateMetrics();
    const resizeObserver = new ResizeObserver(updateMetrics);
    resizeObserver.observe(root);
    window.addEventListener("resize", updateMetrics);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateMetrics);
    };
  }, []);
  React.useLayoutEffect(() => {
    previousSidebarHiddenRef.current = sidebarHidden;
  }, [sidebarHidden]);

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
    const maxWidth = maxAppSidebarWidthForContainer(rect.width - railWidth, minWorkspaceWidth);

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
      style={{ "--app-sidebar-width": `${effectiveSidebarWidth}px` } as React.CSSProperties}
      className={cn(
        "app-shell-root grid h-full min-h-0 text-foreground",
        isResizingSidebar && "resizing-sidebar",
        sidebarVisibilityChanged && "switching-sidebar-visibility",
        className
      )}
    >
      <div data-shell="top-strip" className="app-shell-top-strip">
        {topStrip}
      </div>
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
          aria-valuemax={effectiveSidebarMax}
          aria-valuenow={effectiveSidebarWidth}
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
