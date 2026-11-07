import { Fragment } from "react";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { accordLaunchTitleAndBody, parseAccordLaunchCard, type AccordLaunchCard } from "../../../shared/accordLaunchCard";
import { Avatar, avatarForParticipant } from "../avatar/avatar";
import { AccordMergeIcon } from "./accord-merge-icon";
import { avatarForChatParticipant } from "./chat-avatars";

/** The card for a message that starts an Accord; anything else keeps the
 *  message row. A message carrying pictures or file references is never one
 *  the app wrote, and the card would hide them, so it stays a row. */
export function accordLaunchCardForMessage(message: Pick<ChatMessage, "role" | "content" | "metadata">): AccordLaunchCard | undefined {
  if (message.role !== "user" || (message.metadata?.imageAttachments?.length ?? 0) > 0 || (message.metadata?.repoFileMentions?.length ?? 0) > 0) {
    return undefined;
  }
  return parseAccordLaunchCard(message.content);
}

function AccordMember(props: { handle: string; participants?: ChatParticipant[] }): JSX.Element {
  const label = `@${props.handle}`;
  const wanted = props.handle.toLowerCase();
  // A member removed since keeps its handle, on the stand-in picture.
  const participant = props.participants?.find((item) => item.handle.toLowerCase() === wanted);
  const avatar = participant ? avatarForChatParticipant(participant, label) : avatarForParticipant(label);
  return (
    <span className="chat-accord-launch-member">
      {/* The handle beside it names the member; the picture is not read out again. */}
      <span aria-hidden="true" className="chat-accord-launch-avatar-slot">
        <Avatar className="chat-accord-launch-avatar" spec={avatar} tooltip={null} />
      </span>
      <span className="chat-mention">{label}</span>
    </span>
  );
}

// The User's Accord launch: her message (avatar, "You", time, its controls,
// reactions and thread) whose content is this card instead of the launch
// prompt. The card has the artifact notes' shape with the Start Accord icon:
// the subject in her own words, then that it is an Accord, who leads it and
// who is in it.
export function ChatAccordLaunchCard(props: {
  card: AccordLaunchCard;
  participants?: ChatParticipant[];
}): JSX.Element {
  const { card } = props;
  const { title, body } = accordLaunchTitleAndBody(card.subject);
  return (
    <div className="chat-accord-launch-card">
      <span className="chat-accord-launch-icon" aria-hidden="true">
        <AccordMergeIcon className="chat-accord-launch-glyph" />
      </span>
      <span className="chat-accord-launch-text">
        <span className="chat-accord-launch-title">{title}</span>
        {body && <span className="chat-accord-launch-body">{body}</span>}
        <span className="chat-accord-launch-meta">
          <span className="chat-accord-launch-kind">Accord</span>
          <span className="chat-accord-launch-fact">
            led by <AccordMember handle={card.facilitator} participants={props.participants} />
          </span>
          <span className="chat-accord-launch-fact chat-accord-launch-with">
            with{" "}
            {card.members.map((handle, index) => (
              <Fragment key={handle}>
                {index > 0 && ", "}
                <AccordMember handle={handle} participants={props.participants} />
              </Fragment>
            ))}
          </span>
        </span>
      </span>
    </div>
  );
}
