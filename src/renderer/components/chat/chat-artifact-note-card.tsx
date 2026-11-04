import { useContext } from "react";
import { FileBox } from "lucide-react";
import { ARTIFACT_USER_MEMBER, type ChatMessage } from "../../../shared/types";
import { ARTIFACT_NOTE_MESSAGE_SOURCE, artifactSummaryStatusLabel } from "../../../shared/artifacts";
import { artifactNoteActorLabel, artifactNoteVerb, parseArtifactNoteCard, type ArtifactNoteCard } from "../../../shared/artifactNoteCard";
import { CHAT_REACTION_EMOJIS } from "../../../shared/chatReactions";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { ChatMessageReactionList } from "./chat-message-reactions";
import { ChatMessageWhen } from "./chat-streaming";

/** The card for a message that is an artifact note; anything else keeps the message row. */
export function artifactNoteCardForMessage(message: Pick<ChatMessage, "role" | "content" | "metadata">): ArtifactNoteCard | undefined {
  if (message.role !== "system" || message.metadata?.appMessageSource !== ARTIFACT_NOTE_MESSAGE_SOURCE) {
    return undefined;
  }
  return parseArtifactNoteCard(message.content);
}

// An artifact note on the timeline: a card with no avatar or author line —
// who did what sits inside it. The title is the artifact's current name, so a
// rename shows everywhere at once; activating the card opens the artifact.
// Reactions members left on the note stay under it, as under any message.
export function ChatArtifactNoteCard(props: {
  message: Pick<ChatMessage, "id" | "createdAt" | "metadata">;
  card: ArtifactNoteCard;
  onToggleReaction: (messageId: string, emoji: string) => void;
}): JSX.Element {
  const { card, message } = props;
  const artifacts = useContext(ArtifactsContext);
  const summary = artifacts?.byId.get(card.artifactId);
  const name = summary?.name ?? card.label;
  const actorClass = card.actor === ARTIFACT_USER_MEMBER ? "chat-artifact-note-actor" : "chat-artifact-note-actor chat-mention";
  const reactions = CHAT_REACTION_EMOJIS
    .map((emoji) => ({ emoji, reactors: message.metadata?.reactions?.[emoji] ?? [] }))
    .filter((entry) => entry.reactors.length > 0);
  return (
    <article data-message-id={message.id} className="chat-artifact-note">
      <button
        type="button"
        className="chat-artifact-note-card"
        title={summary ? `Open artifact "${name}" · ${artifactSummaryStatusLabel(summary)}` : `Open artifact "${name}"`}
        onClick={() => artifacts?.openArtifact(card.artifactId)}
      >
        <span className="chat-artifact-note-icon" aria-hidden="true">
          <FileBox size={20} strokeWidth={2} />
        </span>
        <span className="chat-artifact-note-text">
          <span className="chat-artifact-note-title">{name}</span>
          <span className="chat-artifact-note-meta">
            <span className={actorClass}>{artifactNoteActorLabel(card.actor)}</span> {artifactNoteVerb(card.action)}
            {card.details.map((detail) => <span key={detail}>{` · ${detail}`}</span>)}
            {" · "}
            <ChatMessageWhen createdAt={message.createdAt} />
          </span>
          {card.note && <span className="chat-artifact-note-body">{card.note}</span>}
        </span>
      </button>
      <ChatMessageReactionList reactions={reactions} onToggleReaction={(emoji) => props.onToggleReaction(message.id, emoji)} />
    </article>
  );
}
