export const DEFAULT_NAVIGATION_PANE_WIDTH = 320;
export const MIN_APP_SIDEBAR_WIDTH = 220;
export const MAX_APP_SIDEBAR_WIDTH = 420;
export const MIN_APP_WORKSPACE_WIDTH = 360;

export function normalizeAppSidebarWidth(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_NAVIGATION_PANE_WIDTH;
  }
  return Math.min(MAX_APP_SIDEBAR_WIDTH, Math.max(MIN_APP_SIDEBAR_WIDTH, Math.round(numericValue)));
}

export function maxAppSidebarWidthForContainer(containerWidth: number): number {
  return Math.max(
    MIN_APP_SIDEBAR_WIDTH,
    Math.min(MAX_APP_SIDEBAR_WIDTH, Math.floor(containerWidth - MIN_APP_WORKSPACE_WIDTH))
  );
}
