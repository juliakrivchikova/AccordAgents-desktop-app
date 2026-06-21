import { useState } from "react";
import type React from "react";
import { AtSign, ChevronDown, Minimize2, Trash2 } from "lucide-react";

import type {
  ChatParticipant
} from "../../../shared/types";
import { IconButton } from "../primitives";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { ParticipantRuntimeControls } from "./chat-participant-runtime-controls";
import { RosterStatusIndicator, type ChatParticipantRosterStatus } from "./chat-roster-status";

export function ChatParticipantRosterRow(props: {
  participant: ChatParticipant;
  removeDisabledReason: string | undefined;
  isRunning: boolean;
  status: ChatParticipantRosterStatus;
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  participantRoleArchived: (participant: ChatParticipant) => boolean;
  onInsertMention: (participant: ChatParticipant) => void;
  onJumpToLastMessage: (participant: ChatParticipant) => void;
  onUpdateParticipantRuntime: (
    participantId: string,
    patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions">
  ) => void;
  onCompactParticipant: (participantId: string) => void;
  onRemoveParticipant: (participantId: string) => void;
}): JSX.Element {
  const displayName = chatParticipantDisplayName(props.participant);
  const roleLabel = props.participantRoleLabel(props.participant);
  const roleArchived = props.participantRoleArchived(props.participant);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="chat-participant-row grid gap-2 rounded-md px-2 py-1.5">
      <div className="chat-participant-row-main">
        <button
          type="button"
          onClick={() => props.onJumpToLastMessage(props.participant)}
          className="grid min-h-9 w-full grid-cols-[32px_minmax(0,1fr)] items-center gap-2 rounded-md text-left text-sm text-[var(--app-text)] transition-colors hover:bg-[var(--app-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {props.renderParticipantAvatar(props.participant)}
          <span className="grid min-w-0 gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <strong className="min-w-0 truncate text-[var(--app-text-strong)]">{displayName}</strong>
              <span className="flex-[0_0_auto]">
                <RosterStatusIndicator status={props.status} />
              </span>
            </span>
            <span className="chat-participant-role-line">
              <span className="chat-participant-role-label">{roleLabel}</span>
              {roleArchived && <span className="chat-participant-role-archived">Archived role</span>}
            </span>
          </span>
        </button>
        <IconButton
          className="chat-participant-row-action"
          size="xs"
          icon={AtSign}
          label={`Mention ${displayName}`}
          tooltip="Mention in draft"
          onClick={() => props.onInsertMention(props.participant)}
        />
        <IconButton
          className="chat-participant-row-action chat-participant-row-disclosure"
          size="xs"
          icon={ChevronDown}
          iconClassName={expanded ? undefined : "-rotate-90"}
          label={expanded ? `Collapse ${displayName} settings` : `Expand ${displayName} settings`}
          tooltip={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        />
        <IconButton
          className="chat-participant-row-action"
          size="xs"
          icon={Minimize2}
          label={`Compact ${displayName} context`}
          tooltip="Compact context"
          disabled={props.isRunning}
          onClick={() => props.onCompactParticipant(props.participant.id)}
        />
        <IconButton
          className="chat-participant-row-action is-danger"
          size="xs"
          icon={Trash2}
          label={`Remove ${displayName} from chat`}
          tooltip={props.removeDisabledReason ?? "Remove from chat"}
          disabled={Boolean(props.removeDisabledReason)}
          onClick={() => props.onRemoveParticipant(props.participant.id)}
        />
      </div>
      {expanded && (
        <ParticipantRuntimeControls
          participant={props.participant}
          disabled={props.isRunning}
          onUpdate={props.onUpdateParticipantRuntime}
        />
      )}
    </div>
  );
}
