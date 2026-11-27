import { createContext, useContext } from "react";

import type { AgentRunProgress, ChatAgentActivityEvent } from "../../../shared/types";

/**
 * Whether members' actions (their tool calls and commands) are listed inside
 * their replies: Settings → General → Show members’ actions (the User,
 * 2026-11-27, docs/parity-requirements.md). The chat view provides it; on
 * by default, as each CLI shows them. Off takes only the actions away: the
 * reply's words, its cards, errors and its running state stay.
 */
export const ChatMemberActionsContext = createContext(true);

export function useChatMemberActionsShown(): boolean {
  return useContext(ChatMemberActionsContext);
}

const NO_ACTIONS: ChatAgentActivityEvent[] = [];

/** A reply's actions as the chat shows them: none while they are hidden. */
export function shownMemberActions(events: ChatAgentActivityEvent[] | undefined, shown: boolean): ChatAgentActivityEvent[] | undefined {
  return shown ? events : events && NO_ACTIONS;
}

/** A running reply's live progress as the chat shows it: without its actions
 *  (the list, and the line naming the one in progress) while they are hidden. */
export function shownLiveProgress(progress: AgentRunProgress | undefined, shown: boolean): AgentRunProgress | undefined {
  if (shown || !progress || (!progress.activity && !progress.activityEvents)) return progress;
  return { ...progress, activity: undefined, activityEvents: progress.activityEvents && NO_ACTIONS };
}
