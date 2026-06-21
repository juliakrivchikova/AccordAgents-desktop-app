import { ShieldCheck } from "lucide-react";
import type { ChatAppToolApproval, ChatRoleConfig, ChatRosterChangeOperation, ChatRosterChangeParticipantInput } from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { chatParticipantDisplayName, chatParticipantReference } from "../conversation/conversation-display";
import { chatReasoningEffortLabel } from "../../../shared/reasoningEffort";
import { avatarForChatParticipant } from "./chat-avatars";
import { participantProviderLabel } from "./chat-conversation-data";
import { rosterPermissionGrantLabels } from "./chat-participant-config-panel";

export function rosterApprovalQuestion(approval: ChatAppToolApproval, added: ChatRosterChangeOperation[]): string {
  const requester = chatParticipantReference(approval.requesterHandle);
  return `${requester} wants to add ${added.length === 1 ? "a participant" : "participants"} to this chat`;
}

export function RosterApprovalTitle({ requesterHandle, added }: { requesterHandle: string; added: ChatRosterChangeOperation[] }): JSX.Element {
  return (
    <>
      <span className="chat-app-tool-approval-title-handle">{chatParticipantReference(requesterHandle)}</span>{" "}
      wants to add {added.length === 1 ? "a participant" : "participants"} to this chat
    </>
  );
}

export function ChatAppToolRosterOperation({ operation, roles }: { operation: ChatRosterChangeOperation; roles: ChatRoleConfig[] }): JSX.Element {
  const participant = operation.participant;
  const label = chatParticipantDisplayName(participant);
  const details = [
    participantProviderLabel(participant.kind),
    participant.model,
    participant.reasoningEffort ? `reasoning ${chatReasoningEffortLabel(participant.reasoningEffort)}` : "",
    roleLabelForRosterParticipant(participant, roles)
  ].filter(Boolean);
  const avatar = avatarForChatParticipant(
    {
      id: participant.handle,
      handle: participant.handle,
      kind: participant.kind,
      avatarId: participant.avatarId
    },
    label
  );

  return (
    <div className="chat-app-tool-roster-participant">
      <Avatar className="chat-app-tool-roster-avatar" spec={avatar} />
      <div className="chat-app-tool-roster-participant-info">
        <strong>{label}</strong>
        <span>{details.join(" · ")}</span>
      </div>
    </div>
  );
}

export function ChatAppToolRosterPermissionEnvelope({ operations }: { operations: ChatRosterChangeOperation[] }): JSX.Element | null {
  const labels = uniqueLabels(operations.flatMap((operation) => rosterPermissionGrantLabels(operation.participant)));
  if (labels.length === 0) {
    return null;
  }
  return (
    <div className="chat-app-tool-roster-envelope">
      <span className="chat-app-tool-roster-envelope-label">Permission envelope on join</span>
      <div className="chat-app-tool-roster-grants">
        {labels.map((label) => (
          <span className="chat-app-tool-roster-grant" key={label}>
            <ShieldCheck size={12} aria-hidden />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function roleLabelForRosterParticipant(participant: ChatRosterChangeParticipantInput, roles: ChatRoleConfig[]): string {
  return roles.find((role) => role.id === participant.roleConfigId)?.label ?? participant.roleConfigId;
}

export function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    if (seen.has(label)) {
      return false;
    }
    seen.add(label);
    return true;
  });
}

export function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}
