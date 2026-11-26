export const APP_ARTIFACT_CREATE_TOOL = "app_artifact_create";
export const APP_ARTIFACT_DIFF_TOOL = "app_artifact_diff";
export const APP_ARTIFACT_DRAFT_LIST_TOOL = "app_artifact_draft_list";
export const APP_ARTIFACT_DRAFT_READ_TOOL = "app_artifact_draft_read";
export const APP_ARTIFACT_DRAFT_REPLACE_TOOL = "app_artifact_draft_replace";
export const APP_ARTIFACT_DRAFT_SAVE_TOOL = "app_artifact_draft_save";
export const APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL = "app_artifact_draft_set_roster";
export const APP_ARTIFACT_DRAFT_SUBMIT_TOOL = "app_artifact_draft_submit";
export const APP_ARTIFACT_DRAFT_WITHDRAW_TOOL = "app_artifact_draft_withdraw";
export const APP_ARTIFACT_LIST_TOOL = "app_artifact_list";
export const APP_ARTIFACT_PUBLISH_TOOL = "app_artifact_publish";
export const APP_ARTIFACT_READ_TOOL = "app_artifact_read";
export const APP_ARTIFACT_RENAME_TOOL = "app_artifact_rename";
export const APP_ARTIFACT_REVISE_TOOL = "app_artifact_revise";
export const APP_ARTIFACT_SET_ACCESS_TOOL = "app_artifact_set_access";
export const APP_ARTIFACT_SET_ARCHIVED_TOOL = "app_artifact_set_archived";
export const APP_ARTIFACT_SIGN_TOOL = "app_artifact_sign";
export const APP_CHAT_COMPACT_PARTICIPANT_TOOL = "app_chat_compact_participant";
export const APP_CHAT_DELEGATE_TASK_TOOL = "app_chat_delegate_task";
export const APP_CHAT_EXPORT_ATTACHMENT_TOOL = "app_chat_export_attachment";
export const APP_CHAT_GET_CONTEXT_TOOL = "app_chat_get_context";
export const APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL = "app_chat_get_participant_activity";
export const APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL = "app_chat_get_participant_request_status";
export const APP_CHAT_GET_PARTICIPANTS_TOOL = "app_chat_get_participants";
export const APP_CHAT_LIST_ATTACHMENTS_TOOL = "app_chat_list_attachments";
export const APP_CHAT_REACT_TOOL = "app_chat_react";
export const APP_CHAT_READ_ATTACHMENT_TOOL = "app_chat_read_attachment";
export const APP_CHAT_READ_MESSAGES_TOOL = "app_chat_read_messages";
export const APP_CHAT_REQUEST_COMPACTION_TOOL = "app_chat_request_compaction";
export const APP_CHAT_REQUEST_PARTICIPANTS_TOOL = "app_chat_request_participants";
export const APP_CHAT_SEND_MESSAGE_TOOL = "app_chat_send_message";
export const APP_CHAT_SET_TITLE_TOOL = "app_chat_set_title";
export const APP_CHAT_START_ACCORD_TOOL = "app_chat_start_accord";
export const APP_CONNECTOR_SIGN_IN_TOOL = "app_connector_sign_in";
export const APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL = "app_participants_describe_options";
export const APP_PARTICIPANTS_REQUEST_CHANGE_TOOL = "app_participants_request_change";
export const APP_PERMISSIONS_REQUEST_CHANGE_TOOL = "app_permissions_request_change";
export const APP_ROLES_DESCRIBE_OPTIONS_TOOL = "app_roles_describe_options";
export const APP_ROLES_REQUEST_CHANGE_TOOL = "app_roles_request_change";
export const APP_ROSTER_DESCRIBE_OPTIONS_TOOL = "app_roster_describe_options";
export const APP_ROSTER_REQUEST_CHANGE_TOOL = "app_roster_request_change";
export const APP_TOOL_PERMISSION_TOOL = "app_tool_permission";

/** How long a member's permission card waits for the User (Claude Code's
 *  permission prompt): the app denies it after that, and the CLI is told to
 *  wait at least as long for the app's answer (cliAgents claudeMcpConfigJson). */
export const APP_TOOL_PERMISSION_WAIT_MS = 30 * 60_000;

export const APP_SCRIPTS_REQUEST_CHANGE_TOOL = "app_scripts_request_change";
export const APP_SCRIPTS_LIST_TOOL = "app_scripts_list";
export const APP_SCRIPTS_READ_RUNS_TOOL = "app_scripts_read_runs";
export const APP_MEMORY_SEARCH_TOOL = "app_memory_search";
export const APP_MEMORY_READ_TOOL = "app_memory_read";
export const APP_MEMORY_WRITE_TOOL = "app_memory_write";
export const APP_MEMORY_ARCHIVE_TOOL = "app_memory_archive";
export const APP_MEMORY_TAGS_TOOL = "app_memory_tags";

/** Reaching the User outside the app when something urgent happens
 *  (shared/urgentAlerts.ts). */
export const APP_URGENT_ALERT_TOOL = "app_urgent_alert";

export const APP_MEMORY_TOOL_NAMES = [
  APP_MEMORY_SEARCH_TOOL,
  APP_MEMORY_TAGS_TOOL,
  APP_MEMORY_READ_TOOL,
  APP_MEMORY_WRITE_TOOL,
  APP_MEMORY_ARCHIVE_TOOL
] as const;

export const APP_SCRIPT_TOOL_NAMES = [
  APP_SCRIPTS_REQUEST_CHANGE_TOOL,
  APP_SCRIPTS_LIST_TOOL,
  APP_SCRIPTS_READ_RUNS_TOOL
] as const;

export const APP_ARTIFACT_TOOL_NAMES = [
  APP_ARTIFACT_LIST_TOOL,
  APP_ARTIFACT_READ_TOOL,
  APP_ARTIFACT_DIFF_TOOL,
  APP_ARTIFACT_CREATE_TOOL,
  APP_ARTIFACT_REVISE_TOOL,
  APP_ARTIFACT_RENAME_TOOL,
  APP_ARTIFACT_SIGN_TOOL,
  APP_ARTIFACT_SET_ACCESS_TOOL,
  APP_ARTIFACT_SET_ARCHIVED_TOOL,
  APP_ARTIFACT_DRAFT_LIST_TOOL,
  APP_ARTIFACT_DRAFT_READ_TOOL,
  APP_ARTIFACT_DRAFT_SAVE_TOOL,
  APP_ARTIFACT_DRAFT_SUBMIT_TOOL,
  APP_ARTIFACT_DRAFT_REPLACE_TOOL,
  APP_ARTIFACT_DRAFT_WITHDRAW_TOOL,
  APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL,
  APP_ARTIFACT_PUBLISH_TOOL
] as const;
