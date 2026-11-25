import type { ChatRoleParticipantDefaults } from "../../../../shared/types";

export const CHAT_ROLE_LABEL_MAX_CHARS = 80;
export const CHAT_ROLE_INSTRUCTIONS_MAX_CHARS = 40_000;
export const GENERIC_PARTICIPANT_ROLE_ID = "generic-participant";
export const WORKFLOW_MANAGER_ROLE_ID = "workflow-manager";

export const DEFAULT_ROLE_PARTICIPANT_DEFAULTS: ChatRoleParticipantDefaults = {
  autoWatch: false,
  requestParticipants: "ask",
  requestCompaction: "ask",
  manageRolesParticipants: "deny"
};
