import { usageRoleChosen } from "../../../../shared/usageSignals";
import type { ChatParticipantConfig } from "../../../../shared/types";

/** What a settings save did that the computer's usage signals count. */
export type SettingsUsageEvent =
  | { kind: "role-created" }
  | { kind: "member-saved"; roleChosen: boolean; rulesAdded: boolean };

/** A saved member's change as the usage signals see it: a role someone
 *  chose that it did not have before, and rules it did not have before. */
export function memberUsageEvent(previous: ChatParticipantConfig | undefined, next: ChatParticipantConfig): SettingsUsageEvent {
  const chosen = usageRoleChosen(next.roleConfigId);
  const previousRules = new Set(previous?.behaviorRuleIds ?? []);
  return {
    kind: "member-saved",
    roleChosen: chosen && previous?.roleConfigId !== next.roleConfigId,
    rulesAdded: (next.behaviorRuleIds ?? []).some((id) => !previousRules.has(id))
  };
}
