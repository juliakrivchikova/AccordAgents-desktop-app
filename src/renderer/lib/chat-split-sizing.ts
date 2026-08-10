export const CHAT_MAIN_MIN_WIDTH = 320;
export const CHAT_SIDE_PANEL_MIN_WIDTH = 300;
export const CHAT_SIDE_PANEL_FLOOR_WIDTH = 220;
export const CHAT_SIDE_PANEL_MAX_WIDTH = 760;
export const CHAT_SPLIT_RESIZER_WIDTH = 1;
export const CHAT_SPLIT_WORKSPACE_MIN_WIDTH = CHAT_MAIN_MIN_WIDTH + CHAT_SIDE_PANEL_MIN_WIDTH + CHAT_SPLIT_RESIZER_WIDTH;
export const CHAT_THREAD_DEFAULT_WIDTH = 430;
export const ARTIFACT_PANEL_DEFAULT_WIDTH = 460;

export interface ChatSidePanelWidthLimits {
  min: number;
  max: number;
}

export function chatSidePanelWidthLimits(
  containerWidth: number,
  options: {
    reserveWidth?: number;
    minWidth?: number;
    maxWidth?: number;
  } = {}
): ChatSidePanelWidthLimits {
  const reserveWidth = options.reserveWidth ?? 0;
  const preferredMin = options.minWidth ?? CHAT_SIDE_PANEL_MIN_WIDTH;
  const preferredMax = options.maxWidth ?? CHAT_SIDE_PANEL_MAX_WIDTH;
  const availableAfterMain = Math.floor(containerWidth - CHAT_MAIN_MIN_WIDTH - reserveWidth);
  const available = availableAfterMain >= CHAT_SIDE_PANEL_FLOOR_WIDTH
    ? availableAfterMain
    : Math.max(160, Math.floor((containerWidth - reserveWidth) * 0.45));
  const min = Math.min(preferredMin, available);
  const max = Math.max(min, Math.min(preferredMax, available));
  return { min, max };
}

export function clampChatSidePanelWidth(width: number, limits: ChatSidePanelWidthLimits): number {
  return Math.round(Math.min(limits.max, Math.max(limits.min, width)));
}
