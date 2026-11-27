import { createContext, useContext } from "react";

import { chatActivityStandsAlone } from "../../../shared/processingTranscript";
import type { AgentRunProgress, ChatAgentActivityEvent } from "../../../shared/types";

/**
 * Whether members' actions (their tool calls and commands) are listed inside
 * their replies: Settings → General → Show members’ actions (the User,
 * 2026-11-27, docs/parity-requirements.md). The chat view provides it; on
 * by default, as each CLI shows them. Off takes only the actions away: the
 * reply's words, its notices about the run (chatActivityStandsAlone), its
 * cards, errors and running state stay.
 */
export const ChatMemberActionsContext = createContext(true);

export function useChatMemberActionsShown(): boolean {
  return useContext(ChatMemberActionsContext);
}

const NO_ACTIONS: ChatAgentActivityEvent[] = [];
/** The notices of each events array, kept so a reply drawn again gets the
 *  same array and its memoized parts do not draw again. */
const noticesOf = new WeakMap<readonly ChatAgentActivityEvent[], ChatAgentActivityEvent[]>();

function notices(events: ChatAgentActivityEvent[]): ChatAgentActivityEvent[] {
  let kept = noticesOf.get(events);
  if (!kept) {
    const found = events.filter(chatActivityStandsAlone);
    kept = found.length > 0 ? found : NO_ACTIONS;
    noticesOf.set(events, kept);
  }
  return kept;
}

/** A reply's events as the chat shows them: only its notices while actions are hidden. */
export function shownMemberActions(events: ChatAgentActivityEvent[] | undefined, shown: boolean): ChatAgentActivityEvent[] | undefined {
  return shown || !events ? events : notices(events);
}

/** A running reply's live progress as the chat shows it: without its actions
 *  while they are hidden (the list, and the line naming the step in
 *  progress, unless that step is a notice). */
export function shownLiveProgress(progress: AgentRunProgress | undefined, shown: boolean): AgentRunProgress | undefined {
  if (shown || !progress || (!progress.activity && !progress.activityEvents)) return progress;
  const events = progress.activityEvents;
  const newest = events?.[events.length - 1];
  const noticeInProgress = Boolean(newest && chatActivityStandsAlone(newest) && newest.label.trim() === progress.activity?.trim());
  return { ...progress, activity: noticeInProgress ? progress.activity : undefined, activityEvents: events && notices(events) };
}
