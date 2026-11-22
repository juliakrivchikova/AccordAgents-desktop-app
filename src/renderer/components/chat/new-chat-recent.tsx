import { useMemo } from "react";
import { ChatCircleIcon } from "@phosphor-icons/react";

import type { ConversationSummary } from "../../../shared/types";
import { formatCompactRelativeTime } from "../../app/compact-relative-time";
import { projectChatSummaries } from "../../app/conversation-summaries";

const RECENT_LIMIT = 3;

interface NewChatRecentProps {
  summaries: ConversationSummary[];
  repoPath: string;
  onOpen: (conversationId: string) => void;
}

/** The folder's latest chats under New chat's heading, to go on with one in
 *  a click (the User chose this layout, "B + C", 2026-11-22). */
export const NewChatRecent = ({ summaries, repoPath, onOpen }: NewChatRecentProps): JSX.Element | null => {
  // Not again on every keystroke in the composer.
  const recent = useMemo(() => projectChatSummaries(summaries, repoPath, RECENT_LIMIT), [summaries, repoPath]);
  if (recent.length === 0) return null;
  return (
    <div className="new-chat-recent" role="list" aria-label="Recent chats in this folder" data-testid="new-chat-recent">
      {recent.map((summary) => (
        <button key={summary.id} type="button" role="listitem" className="new-chat-recent-row" onClick={() => onOpen(summary.id)}>
          <ChatCircleIcon size={14} aria-hidden />
          <span className="new-chat-recent-title">{summary.title}</span>
          <span className="new-chat-recent-time">{formatCompactRelativeTime(summary.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
};
