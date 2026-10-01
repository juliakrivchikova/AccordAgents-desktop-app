// The only cap on a side panel (thread or artifact) is the room the main
// timeline needs. 400px is the narrowest width at which every timeline card
// still lays out: below it the approval card's Input column collapses and its
// JSON breaks letter by letter. It is --chat-main-min-width in
// chat-conversation.css; a view with more timeline padding raises the variable
// and the limits below read it from the element (chatMainMinWidth).
export const CHAT_MAIN_MIN_WIDTH = 400;
export const CHAT_SIDE_PANEL_MIN_WIDTH = 300;
export const CHAT_SIDE_PANEL_FLOOR_WIDTH = 220;
// A container too narrow for the main minimum plus the floor splits instead:
// the panel takes this share, and the CSS grid lets the main column shrink to
// the rest with min(var(--chat-main-min-width), calc(55% - 1px)).
export const CHAT_SIDE_PANEL_FALLBACK_SHARE = 0.45;
export const CHAT_SPLIT_RESIZER_WIDTH = 1;
export const CHAT_SPLIT_WORKSPACE_MIN_WIDTH = CHAT_MAIN_MIN_WIDTH + CHAT_SIDE_PANEL_MIN_WIDTH + CHAT_SPLIT_RESIZER_WIDTH;
export const CHAT_THREAD_DEFAULT_WIDTH = 430;
export const ARTIFACT_PANEL_DEFAULT_WIDTH = 460;

export interface ChatSidePanelWidthLimits {
  min: number;
  max: number;
}

/** The main timeline minimum in force for this chat view (its CSS variable). */
export function chatMainMinWidth(view: Element | null | undefined): number {
  if (!view) {
    return CHAT_MAIN_MIN_WIDTH;
  }
  const value = Number.parseFloat(getComputedStyle(view).getPropertyValue("--chat-main-min-width"));
  return Number.isFinite(value) && value > 0 ? value : CHAT_MAIN_MIN_WIDTH;
}

export function chatSidePanelWidthLimits(
  containerWidth: number,
  options: {
    reserveWidth?: number;
    minWidth?: number;
    mainMinWidth?: number;
  } = {}
): ChatSidePanelWidthLimits {
  const reserveWidth = options.reserveWidth ?? 0;
  const preferredMin = options.minWidth ?? CHAT_SIDE_PANEL_MIN_WIDTH;
  const mainMinWidth = options.mainMinWidth ?? CHAT_MAIN_MIN_WIDTH;
  const availableAfterMain = Math.floor(containerWidth - mainMinWidth - reserveWidth);
  const available = availableAfterMain >= CHAT_SIDE_PANEL_FLOOR_WIDTH
    ? availableAfterMain
    : Math.max(160, Math.floor((containerWidth - reserveWidth) * CHAT_SIDE_PANEL_FALLBACK_SHARE));
  const min = Math.min(preferredMin, available);
  const max = Math.max(min, available);
  return { min, max };
}

export function clampChatSidePanelWidth(width: number, limits: ChatSidePanelWidthLimits): number {
  return Math.round(Math.min(limits.max, Math.max(limits.min, width)));
}
