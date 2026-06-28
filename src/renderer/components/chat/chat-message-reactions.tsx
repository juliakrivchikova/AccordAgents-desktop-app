import type { ChatReactor } from "../../../shared/types";

export function ChatMessageReactionList(props: {
  reactions: Array<{ emoji: string; reactors: ChatReactor[] }>;
  onToggleReaction: (emoji: string) => void;
}): JSX.Element | null {
  if (props.reactions.length === 0) {
    return null;
  }
  return (
    <div className="chat-message-reactions" aria-label="Message reactions">
      {props.reactions.map((entry) => {
        const userReacted = entry.reactors.some((reactor) => reactor.actorKind === "user" && reactor.actorId === "user");
        const actorLabels = entry.reactors.map((reactor) => reactor.actorLabel).join(", ");
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
