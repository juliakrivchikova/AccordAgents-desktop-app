import type { AppSettings } from "../../shared/types";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS } from "../../shared/cliAgentRunSettings";
import { CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT } from "../../shared/chatParticipantRequests";

export const DEFAULT_SETTINGS: AppSettings = {
  roundLimitDefault: 2,
  cliAgentRunTimeoutMs: CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
  chatParticipantRequestMaxDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
  providers: [],
  chatRoleConfigs: [],
  chatBehaviorRules: [],
  chatSavedPrompts: [],
  chatParticipantConfigs: []
};

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "accordagents.sidebarCollapsed";
export const LAST_VIEWED_AT_STORAGE_KEY = "accordagents.lastViewedAt";
export const DISMISSED_WARNINGS_STORAGE_KEY = "accordagents.dismissedWarnings.v1";
export const GLOBAL_WARNING_DISMISS_SCOPE = "__global__";
export const NO_PROJECT_GROUP_KEY = "__no_project__";
