import { chatParticipantRequestPermissionRank, normalizeChatParticipantRequestPermission } from "../../shared/agentPermissions";
import type { ChatAppToolApprovalPolicy, ChatParticipant, ChatParticipantRequestPermission } from "../../shared/types";

/** Where a member runs: what decides which device takes its turns, the
 *  session it is handed when it moves, and the member of another chat a
 *  forked main session copies (only the computer writes any of them). */
export const HOME_FIELDS = ["homeMachineId", "cloudRun", "remoteExecution", "sessionHandoff", "forkOrigin"] as const;

export function participantsOf(value: unknown): ChatParticipant[] {
  return Array.isArray(value) ? value.filter((item): item is ChatParticipant => Boolean(item) && typeof (item as { id?: unknown }).id === "string") : [];
}

export function policiesOf(value: unknown): ChatAppToolApprovalPolicy[] {
  return Array.isArray(value) ? value.filter((item): item is ChatAppToolApprovalPolicy => Boolean(item) && typeof (item as { id?: unknown }).id === "string") : [];
}

export function runsOnMachine(participant: Pick<ChatParticipant, "homeMachineId"> | undefined, machineId: string | undefined): boolean {
  return Boolean(machineId && participant && typeof participant.homeMachineId === "string" && participant.homeMachineId === machineId);
}

export function handleKey(handle: unknown): string {
  return typeof handle === "string" ? handle.trim().replace(/^@/, "").toLowerCase() : "";
}

export function permissionsOf(participant: Pick<ChatParticipant, "permissions">): Record<string, unknown> {
  return participant.permissions && typeof participant.permissions === "object" ? participant.permissions as unknown as Record<string, unknown> : {};
}

export function rank(value: ChatParticipantRequestPermission | undefined): number {
  return chatParticipantRequestPermissionRank(normalizeChatParticipantRequestPermission(value));
}

export function withoutCode(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\r\n]*`/g, "");
}

// --- members it adds and removes ----------------------------------------------

/** The Chat Assistant's role (chat.ts CHAT_ADMINISTRATOR_ROLE_ID): every chat
 *  keeps it. */
export const CHAT_ASSISTANT_ROLE_ID = "administrator";
