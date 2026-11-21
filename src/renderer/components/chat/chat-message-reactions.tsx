import type { ChatReactor } from "../../../shared/types";
import { useSessionsViewLabel } from "./chat-sessions-links";

export function ChatMessageReactionList(props: {
  reactions: Array<{ emoji: string; reactors: ChatReactor[] }>;
  onToggleReaction: (emoji: string) => void;
}): JSX.Element | null {
  // The sessions view names a member by its task and the main session by
  // nothing.
  const nameOf = useSessionsViewLabel();
  if (props.reactions.length === 0) {
    return null;
  }
  return (
    <div className="chat-message-reactions" aria-label="Message reactions">
      {props.reactions.map((entry) => {
        const userReacted = entry.reactors.some((reactor) => reactor.actorKind === "user" && reactor.actorId === "user");
        const actorLabels = entry.reactors.map((reactor) => nameOf(reactor.actorLabel)).filter(Boolean).join(", ");
        return (
          <button
            type="button"
            className={`chat-reaction-chip ${userReacted ? "selected" : ""}`}
            title={actorLabels}
            aria-label={`${entry.emoji} reaction by ${actorLabels}`}
            onClick={() => props.onToggleReaction(entry.emoji)}
            key={entry.emoji}
          >
            <span>{entry.emoji}</span>
            <strong>{entry.reactors.length}</strong>
          </button>
        );
      })}
    </div>
  );
}
