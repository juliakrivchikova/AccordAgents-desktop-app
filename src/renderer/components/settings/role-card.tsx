import { UsersRound } from "lucide-react";
import type { ChatParticipantConfig, ChatRoleConfig } from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { avatarForChatParticipant } from "../chat/chat-avatars";
import { RoleKindBadge, roleSummary } from "./role-settings-utils";

export function RoleCard(props: {
  role: ChatRoleConfig;
  savedParticipants: ChatParticipantConfig[];
  onOpen: () => void;
}): JSX.Element {
  const shownParticipants = props.savedParticipants.slice(0, 3);
  const remaining = props.savedParticipants.length - shownParticipants.length;
  return (
    <button
      type="button"
      className="roles-card"
      data-testid={`settings-role-card-${props.role.id}`}
      onClick={props.onOpen}
    >
      <span className="roles-card-head">
        <span className="roles-card-title-row">
          <strong>{props.role.label}</strong>
          <RoleKindBadge builtIn={Boolean(props.role.builtIn)} />
        </span>
        {props.savedParticipants.length > 0 && (
          <span className="roles-card-participant-count" title={`${props.savedParticipants.length} saved participant preset${props.savedParticipants.length === 1 ? "" : "s"}`}>
            {props.savedParticipants.length}
          </span>
        )}
      </span>
      <span className="roles-card-summary">{roleSummary(props.role)}</span>
      {props.savedParticipants.length > 0 ? (
        <span className="roles-card-participants">
          <span className="roles-avatar-stack" aria-hidden>
            {shownParticipants.map((participant) => (
              <span className="roles-avatar-stack-item" key={participant.id}>
                <Avatar
                  className="roles-mini-avatar"
                  spec={avatarForChatParticipant(participant, `@${participant.handle}`)}
                  tooltip={null}
                />
              </span>
            ))}
          </span>
          {remaining > 0 && <span className="roles-avatar-more">+{remaining}</span>}
        </span>
      ) : (
        <span className="roles-no-participants">
          <UsersRound size={15} aria-hidden />
          No saved presets
        </span>
      )}
    </button>
  );
}

