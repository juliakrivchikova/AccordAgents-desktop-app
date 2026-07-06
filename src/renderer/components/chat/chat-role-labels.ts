import type { ChatRoleConfig } from "../../../shared/types";

export function displayChatRoleLabel(
  role: Pick<ChatRoleConfig, "id" | "label"> | undefined,
  fallback = ""
): string {
  if (!role) {
    return fallback;
  }
  if (role.id === "generic-participant" && role.label === "Generic Participant") {
    return "Generic Member";
  }
  return role.label || fallback;
}
