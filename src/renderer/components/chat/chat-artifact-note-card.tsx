import { createContext, useContext } from "react";
import { BadgeCheck, FileBox, FileText } from "lucide-react";
import { ARTIFACT_USER_MEMBER, type ChatMessage } from "../../../shared/types";
import { ARTIFACT_NOTE_MESSAGE_SOURCE, artifactSummaryStatusLabel } from "../../../shared/artifacts";
import { artifactNoteActorLabel, artifactNoteVerb, parseArtifactNoteCard, type ArtifactNoteCard } from "../../../shared/artifactNoteCard";
import type { ArtifactNoteProgress } from "../../../shared/artifactNoteProgress";
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

/** The marks each artifact note shows, by message id, for the chat on screen. */
export const ArtifactNoteProgressContext = createContext<ReadonlyMap<string, ArtifactNoteProgress> | undefined>(undefined);

/** The version a note announces, shown as a tag: "published v1", "revised v2". */
function versionTagOf(card: ArtifactNoteCard): string | undefined {
  return card.action === "published" || card.action === "revised" ? card.details.find((detail) => /^v\d+$/.test(detail)) : undefined;
}

function ArtifactNoteMarks(props: { progress: ArtifactNoteProgress }): JSX.Element {
  const { progress } = props;
  const Icon = progress.kind === "drafts" ? FileText : BadgeCheck;
  const noun = progress.kind === "drafts" ? "Draft" : "Signature";
  const slots = Array.from({ length: progress.total }, (_, index) => progress.done[index]);
  const summary = progress.kind === "drafts"
    ? `Drafts ${progress.done.length} of ${progress.total}`
    : `Signed ${progress.done.length} of ${progress.total}`;
  return (
    <span className={`chat-artifact-note-marks${progress.total > 4 ? " is-many" : ""}`} role="img" aria-label={summary}>
      {slots.map((actor, index) => {
        const given = actor !== undefined;
        const state = given ? (progress.complete ? "is-complete" : "is-given") : "";
        const who = given && actor ? artifactNoteActorLabel(actor) : undefined;
        return (
          <span
            className={`chat-artifact-note-mark ${state}`}
            title={given ? `${noun}${who ? ` · ${who}` : ""}` : `${noun} · waiting`}
            key={index}
          >
            <Icon size={16} strokeWidth={2} aria-hidden />
          </span>
        );
      })}
    </span>
  );
}

// An artifact note on the timeline: a card with no avatar or author line —
// who did what leads it, the artifact's current name and the time follow, so
// a rename shows everywhere at once; activating the card opens the artifact.
// On the right, one mark per member whose draft or signature it waits for.
// Reactions members left on the note stay under it, as under any message.
export function ChatArtifactNoteCard(props: {
  message: Pick<ChatMessage, "id" | "createdAt" | "metadata">;
  card: ArtifactNoteCard;
  onToggleReaction: (messageId: string, emoji: string) => void;
}): JSX.Element {
  const { card, message } = props;
  const artifacts = useContext(ArtifactsContext);
  const progress = useContext(ArtifactNoteProgressContext)?.get(message.id);
  const summary = artifacts?.byId.get(card.artifactId);
  const name = summary?.name ?? card.label;
  const actorClass = card.actor === ARTIFACT_USER_MEMBER ? "chat-artifact-note-actor" : "chat-artifact-note-actor chat-mention";
  const versionTag = versionTagOf(card);
  const details = versionTag ? card.details.filter((detail) => detail !== versionTag) : card.details;
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
          <span className="chat-artifact-note-title">
            <span className={actorClass}>{artifactNoteActorLabel(card.actor)}</span> {artifactNoteVerb(card.action)}
            {versionTag && <span className="chat-artifact-note-version">{versionTag}</span>}
            {details.map((detail) => <span key={detail}>{` · ${detail}`}</span>)}
          </span>
          <span className="chat-artifact-note-meta">
            {name}
            {" · "}
            <ChatMessageWhen createdAt={message.createdAt} />
          </span>
          {card.note && <span className="chat-artifact-note-body">{card.note}</span>}
        </span>
        {progress && <ArtifactNoteMarks progress={progress} />}
      </button>
      <ChatMessageReactionList reactions={reactions} onToggleReaction={(emoji) => props.onToggleReaction(message.id, emoji)} />
    </article>
  );
}
