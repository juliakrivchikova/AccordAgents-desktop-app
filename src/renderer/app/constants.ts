import type { AppSettings } from "../../shared/types";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS } from "../../shared/cliAgentRunSettings";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT
} from "../../shared/chatParticipantRequests";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT } from "../../shared/chatAutoWatch";
import {
  AWS_WORKER_INSTANCE_TYPE_DEFAULT,
  AWS_WORKER_ROOT_VOLUME_SIZE_GB_DEFAULT
} from "../../shared/cloudRuns";

export const DEFAULT_SETTINGS: AppSettings = {
  roundLimitDefault: 2,
  cliAgentRunTimeoutMs: CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
  chatParticipantRequestMaxDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
  chatParticipantRequestPromptMaxChars: CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
  chatAutoWatchWakeLimit: CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT,
  chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT,
  cloudRuns: {
    enabled: false,
    mode: "ssh",
    worker: {},
    hasAwsCredentials: false,
    awsInstanceType: AWS_WORKER_INSTANCE_TYPE_DEFAULT,
    awsRootVolumeSizeGb: AWS_WORKER_ROOT_VOLUME_SIZE_GB_DEFAULT,
    maxRuntimeMs: 24 * 60 * 60_000,
    pollIntervalMs: 2_500
  },
  providers: [],
  chatRoleConfigs: [],
  chatBehaviorRules: [],
  chatSavedPrompts: [],
  chatParticipantConfigs: []
};

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "accordagents.sidebarCollapsed";
export const LEGACY_SIDEBAR_WIDTH_STORAGE_KEY = "accordagents.sidebarWidth";
export const CHAT_SIDEBAR_WIDTH_STORAGE_KEY = "accordagents.chatSidebarWidth.v2";
export const SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY = "accordagents.settingsSidebarWidth.v2";
export const LEGACY_ACTIVITY_LIST_WIDTH_STORAGE_KEY = "accordagents-activity-list-width";
export const ACTIVITY_LIST_WIDTH_STORAGE_KEY = "accordagents.activityListWidth.v2";
export const LAST_VIEWED_AT_STORAGE_KEY = "accordagents.lastViewedAt";
export const DISMISSED_WARNINGS_STORAGE_KEY = "accordagents.dismissedWarnings.v1";
export const ACCORD_LAUNCHER_STORAGE_KEY = "accordagents.accordLauncher.v1";
export const GLOBAL_WARNING_DISMISS_SCOPE = "__global__";
export const NO_PROJECT_GROUP_KEY = "__no_project__";
