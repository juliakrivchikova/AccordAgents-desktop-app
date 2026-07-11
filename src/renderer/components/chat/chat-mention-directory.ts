import { formatContextUsageLabel } from "../../../shared/agentContext";
import { chatReasoningEffortLabel } from "../../../shared/reasoningEffort";
import type {
  AgentContextUsage,
  ChatParticipant,
  ChatParticipantSession,
  ChatProviderKind,
  ChatRoleConfig
} from "../../../shared/types";
import type { ParticipantProfile } from "../content/participant-hover-card";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";
import { chatParticipantPermissionSummary } from "./chat-participant-drafts";
import { displayChatRoleLabel } from "./chat-role-labels";

export function chatRoleLabel(roles: ChatRoleConfig[], participant: Pick<ChatParticipant, "roleConfigId">): string {
  return displayChatRoleLabel(
    roles.find((role) => role.id === participant.roleConfigId),
    participant.roleConfigId
  );
}

export function chatMentionDirectory(
  participants: ChatParticipant[],
  roles: ChatRoleConfig[],
  sessions: Map<string, ChatParticipantSession>,
  contextUsage: Map<string, AgentContextUsage>
): Map<string, ParticipantProfile> {
  const directory = new Map<string, ParticipantProfile>();
  for (const participant of participants) {
    const providerValue = [
      participantProviderLabel(participant.kind),
      participant.model,
      participant.reasoningEffort ? `reasoning ${chatReasoningEffortLabel(participant.reasoningEffort)}` : ""
    ].filter(Boolean).join(" · ");
    const rows: ParticipantProfile["rows"] = [
      { label: "Role", value: chatRoleLabel(roles, participant) },
      { label: "Provider", value: providerValue },
      { label: "Mode", value: chatParticipantPermissionSummary(participant) }
    ];
    const usage = contextUsage.get(participant.id);
    if (usage) {
      rows.push({ label: "Context", value: formatContextUsageLabel(usage) });
    }
    directory.set(participant.handle.toLowerCase(), {
      participantId: participant.id,
      handle: chatParticipantDisplayName(participant),
      rows,
      sessionId: sessions.get(participant.id)?.sessionId,
      avatar: avatarForChatParticipant(participant)
    });
  }
  return directory;
}

export function providerLabel(providerKind: ChatProviderKind): string {
  return providerKind === "codex-cli" ? "Codex" : providerKind === "gemini-cli" ? "Gemini" : "Claude";
}

export function participantProviderLabel(providerKind: ChatProviderKind): string {
  return providerKind === "codex-cli" ? "Codex CLI" : providerKind === "gemini-cli" ? "Gemini CLI" : "Claude Code";
}
