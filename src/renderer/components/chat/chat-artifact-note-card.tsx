import { useContext } from "react";
import { FileBox } from "lucide-react";
import { ARTIFACT_USER_MEMBER, type ChatMessage } from "../../../shared/types";
import { ARTIFACT_NOTE_MESSAGE_SOURCE } from "../../../shared/artifacts";
import { artifactNoteActorLabel, artifactNoteVerb, parseArtifactNoteCard, type ArtifactNoteCard } from "../../../shared/artifactNoteCard";
import { ArtifactsContext } from "../artifacts/artifacts-context";
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
export function ChatArtifactNoteCard(props: {
  messageId: string;
  createdAt: string;
  card: ArtifactNoteCard;
}): JSX.Element {
  const { card } = props;
  const artifacts = useContext(ArtifactsContext);
  const name = artifacts?.byId.get(card.artifactId)?.name ?? card.label;
  const actorClass = card.actor === ARTIFACT_USER_MEMBER ? "chat-artifact-note-actor" : "chat-artifact-note-actor chat-mention";
  const actor = <span className={actorClass}>{artifactNoteActorLabel(card.actor)}</span>;
  return (
    <article data-message-id={props.messageId} className="chat-artifact-note">
      <button
        type="button"
        className="chat-artifact-note-card"
        title={`Open artifact "${name}"`}
        onClick={() => artifacts?.openArtifact(card.artifactId)}
      >
        <span className="chat-artifact-note-icon" aria-hidden="true">
          <FileBox size={20} strokeWidth={2} />
        </span>
        <span className="chat-artifact-note-text">
          <span className="chat-artifact-note-title">{name}</span>
          <span className="chat-artifact-note-meta">
            {actor} {artifactNoteVerb(card.action)}
            {card.details.map((detail) => <span key={detail}>{` · ${detail}`}</span>)}
            {" · "}
            <ChatMessageWhen createdAt={props.createdAt} />
          </span>
          {card.note && <span className="chat-artifact-note-body">{card.note}</span>}
        </span>
      </button>
    </article>
  );
}
