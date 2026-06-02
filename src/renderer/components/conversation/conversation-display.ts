import type { Conversation, ConversationKind } from "../../../shared/types";

export function authorForMessage(message: Conversation["messages"][number], kind: ConversationKind): string {
  if (message.role === "user") {
    return "You";
  }
  if (kind === "implementation-plan" && (message.role === "system" || message.role === "summary" || message.participantId?.startsWith("arbiter:"))) {
    return "Planner";
  }
  if (message.role === "system") {
    return kind === "chat" ? "@admin" : "Arbiter";
  }
  if (message.participantLabel?.toLowerCase().includes("(arbiter)") || message.participantLabel?.toLowerCase().includes("(planner)")) {
    return "Arbiter";
  }
  return message.participantLabel || labelForRole(message.role);
}

function labelForRole(role: string): string {
  if (role === "system") {
    return "Consensus engine";
  }
  if (role === "summary") {
    return "Final summary";
  }
  return role;
}
