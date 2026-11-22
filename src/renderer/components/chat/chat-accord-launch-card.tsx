import { Fragment } from "react";
import type { ChatParticipant } from "../../../shared/types";
import { accordLaunchCardForMessage, accordLaunchTitleAndBody, type AccordLaunchCard } from "../../../shared/accordLaunchCard";
import { avatarForParticipant } from "../avatar/avatar";
import { AccordMergeIcon } from "./accord-merge-icon";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatMemberMark } from "./chat-member-mark";
import { useSessionsViewLabel } from "./chat-sessions-links";

// Read the same way by the desktop, the phone and the main process.
export { accordLaunchCardForMessage };

function AccordMember(props: { handle: string; participants?: ChatParticipant[] }): JSX.Element {
  const label = `@${props.handle}`;
  const wanted = props.handle.toLowerCase();
  // A member removed since keeps its handle, on the stand-in picture.
  const participant = props.participants?.find((item) => item.handle.toLowerCase() === wanted);
  const avatar = participant ? avatarForChatParticipant(participant, label) : avatarForParticipant(label);
  // The sessions view names a member by its task, the main session by
  // nothing (its logo alone).
  const name = useSessionsViewLabel()(label);
  return (
    <span className="chat-accord-launch-member">
      {/* The handle beside it names the member; the picture is not read out
          again. The sessions view shows the provider's logo instead. */}
      <span aria-hidden="true" className="chat-accord-launch-avatar-slot">
        <ChatMemberMark className="chat-accord-launch-avatar" markClassName="is-chip" avatar={avatar} member={participant} tooltip={null} />
      </span>
      {name && <span className="chat-mention">{name}</span>}
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
