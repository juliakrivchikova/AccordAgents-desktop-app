import { hasChatAppToolCapability } from "../../../shared/appTools";
import {
  APP_ROSTER_REQUEST_CHANGE_TOOL, APP_ROSTER_DESCRIBE_OPTIONS_TOOL, APP_ROLES_REQUEST_CHANGE_TOOL,
  APP_ROLES_DESCRIBE_OPTIONS_TOOL, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL,
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL, APP_TOOL_PERMISSION_TOOL, APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
  APP_CHAT_REQUEST_COMPACTION_TOOL, APP_CONNECTOR_SIGN_IN_TOOL, APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL,
  APP_CHAT_GET_CONTEXT_TOOL, APP_CHAT_GET_PARTICIPANTS_TOOL, APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL, APP_CHAT_READ_MESSAGES_TOOL,
  APP_CHAT_LIST_ATTACHMENTS_TOOL, APP_CHAT_READ_ATTACHMENT_TOOL, APP_CHAT_EXPORT_ATTACHMENT_TOOL, APP_CHAT_REACT_TOOL,
  APP_CHAT_SEND_MESSAGE_TOOL, APP_CHAT_SET_TITLE_TOOL, APP_CHAT_DELEGATE_TASK_TOOL, APP_CHAT_START_ACCORD_TOOL,
  APP_CHAT_COMPACT_PARTICIPANT_TOOL,
  APP_ARTIFACT_TOOL_NAMES, APP_SCRIPT_TOOL_NAMES, APP_MEMORY_TOOL_NAMES, APP_URGENT_ALERT_TOOL
} from "../../../shared/appMcpToolContracts";
import { appToolPolicyDenialCode, diagnosticToolName, structuredToolDenialCode, toolImageResult, toolTextResult } from "./toolResults";
import type { AppMcpActor } from "./types";
import type { AppMcpModules } from "./modules";
import type { AppMcpDependencies } from "./dependencies";

/** Calls the tool a member asked for. */
export class ToolCalls {
  constructor(
    private readonly mcp: Pick<AppMcpModules, "toolHandlers">,
    private readonly deps: Pick<AppMcpDependencies, "debugLogs">
  ) {}

  async callTool(actor: AppMcpActor, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const toolName = diagnosticToolName(params);
    try {
      const result = await this.callToolUnchecked(actor, params, signal);
      const denialCode = structuredToolDenialCode(result);
      if (denialCode) {
        this.logToolDenial(actor, toolName, "first-party-app-server-policy", denialCode);
      }
      return result;
    } catch (error) {
      const denialCode = appToolPolicyDenialCode(error);
      if (denialCode) {
        this.logToolDenial(actor, toolName, "first-party-app-server-policy", denialCode);
      } else {
        this.logToolDenial(
          actor,
          toolName,
          "unknown-provider-or-runtime-behavior",
          "APP_TOOL_UNCLASSIFIED_FAILURE",
          ["stable app error code"]
        );
      }
      throw error;
    }
  }

  private async callToolUnchecked(actor: AppMcpActor, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("Tool call params are required.");
    }
    const record = params as { name?: unknown; arguments?: unknown };
    if (typeof record.name === "string" && (APP_ARTIFACT_TOOL_NAMES as readonly string[]).includes(record.name)) {
      if (!this.mcp.toolHandlers.artifactToolHandler) {
        throw new Error("Artifact tools are not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.artifactToolHandler(actor, record.name, record.arguments));
    }
    if (record.name === APP_URGENT_ALERT_TOOL) {
      if (!this.mcp.toolHandlers.urgentAlertToolHandler) {
        throw new Error("Urgent alerts are not available on this host yet.");
      }
      return toolTextResult(await this.mcp.toolHandlers.urgentAlertToolHandler(actor, record.arguments));
    }
    if (typeof record.name === "string" && (APP_MEMORY_TOOL_NAMES as readonly string[]).includes(record.name)) {
      if (!this.mcp.toolHandlers.memoryToolHandler) {
        throw new Error("Memory is not available on this host yet.");
      }
      return toolTextResult(await this.mcp.toolHandlers.memoryToolHandler(actor, record.name, record.arguments));
    }
    if (typeof record.name === "string" && (APP_SCRIPT_TOOL_NAMES as readonly string[]).includes(record.name)) {
      if (!this.mcp.toolHandlers.scriptToolHandler) {
        throw new Error("Scheduled tasks are not available on this host yet.");
      }
      return toolTextResult(await this.mcp.toolHandlers.scriptToolHandler(actor, record.name, record.arguments));
    }
    if (
      record.name !== APP_ROSTER_DESCRIBE_OPTIONS_TOOL &&
      record.name !== APP_ROSTER_REQUEST_CHANGE_TOOL &&
      record.name !== APP_ROLES_DESCRIBE_OPTIONS_TOOL &&
      record.name !== APP_ROLES_REQUEST_CHANGE_TOOL &&
      record.name !== APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL &&
      record.name !== APP_PARTICIPANTS_REQUEST_CHANGE_TOOL &&
      record.name !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
      record.name !== APP_TOOL_PERMISSION_TOOL &&
      record.name !== APP_CONNECTOR_SIGN_IN_TOOL &&
      record.name !== APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
      record.name !== APP_CHAT_REQUEST_COMPACTION_TOOL &&
      record.name !== APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL &&
      record.name !== APP_CHAT_GET_CONTEXT_TOOL &&
      record.name !== APP_CHAT_GET_PARTICIPANTS_TOOL &&
      record.name !== APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL &&
      record.name !== APP_CHAT_READ_MESSAGES_TOOL &&
      record.name !== APP_CHAT_LIST_ATTACHMENTS_TOOL &&
      record.name !== APP_CHAT_READ_ATTACHMENT_TOOL &&
      record.name !== APP_CHAT_EXPORT_ATTACHMENT_TOOL &&
      record.name !== APP_CHAT_REACT_TOOL &&
      record.name !== APP_CHAT_SEND_MESSAGE_TOOL &&
      record.name !== APP_CHAT_SET_TITLE_TOOL &&
      record.name !== APP_CHAT_DELEGATE_TASK_TOOL &&
      record.name !== APP_CHAT_START_ACCORD_TOOL &&
      record.name !== APP_CHAT_COMPACT_PARTICIPANT_TOOL
    ) {
      throw new Error(`Unknown app tool: ${String(record.name ?? "")}.`);
    }
    if (record.name === APP_TOOL_PERMISSION_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
        throw new Error("This member is not allowed to request tool permissions.");
      }
      if (!this.mcp.toolHandlers.toolPermissionHandler) {
        throw new Error("Tool permission handling is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.toolPermissionHandler(actor, record.arguments, signal));
    }
    if (record.name === APP_CONNECTOR_SIGN_IN_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
        throw new Error("This member is not allowed to ask for sign-ins.");
      }
      if (!this.mcp.toolHandlers.connectorSignInHandler) {
        throw new Error("Connector sign-in is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.connectorSignInHandler(actor, record.arguments, signal));
    }
    if (record.name === APP_CHAT_GET_CONTEXT_TOOL) {
      if (!this.mcp.toolHandlers.chatContextHandler) {
        throw new Error("Chat context discovery is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatContextHandler(actor));
    }
    if (record.name === APP_CHAT_GET_PARTICIPANTS_TOOL) {
      if (!this.mcp.toolHandlers.chatParticipantsHandler) {
        throw new Error("Chat member discovery is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatParticipantsHandler(actor));
    }
    if (record.name === APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL) {
      if (!this.mcp.toolHandlers.chatParticipantActivityHandler) {
        throw new Error("Chat member activity is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatParticipantActivityHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_READ_MESSAGES_TOOL) {
      if (!this.mcp.toolHandlers.chatMessagesHandler) {
        throw new Error("Chat message reading is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatMessagesHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_LIST_ATTACHMENTS_TOOL) {
      if (!this.mcp.toolHandlers.chatAttachmentListHandler) {
        throw new Error("Chat attachment listing is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatAttachmentListHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_READ_ATTACHMENT_TOOL) {
      if (!this.mcp.toolHandlers.chatAttachmentReadHandler) {
        throw new Error("Chat attachment reading is not available.");
      }
      return toolImageResult(await this.mcp.toolHandlers.chatAttachmentReadHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_EXPORT_ATTACHMENT_TOOL) {
      if (!this.mcp.toolHandlers.chatAttachmentExportHandler) {
        throw new Error("Chat attachment exporting is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatAttachmentExportHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_REACT_TOOL) {
      if (!this.mcp.toolHandlers.chatReactHandler) {
        throw new Error("Chat reaction handling is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatReactHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_SEND_MESSAGE_TOOL) {
      if (!this.mcp.toolHandlers.chatSendMessageHandler) {
        throw new Error("Chat message sending is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatSendMessageHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_SET_TITLE_TOOL) {
      if (!this.mcp.toolHandlers.chatSetTitleHandler) {
        throw new Error("Chat title setting is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatSetTitleHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_DELEGATE_TASK_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.delegate")) {
        throw new Error("Only the chat's main session can delegate tasks to new members.");
      }
      if (!this.mcp.toolHandlers.chatDelegateTaskHandler) {
        throw new Error("Task delegation is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatDelegateTaskHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_START_ACCORD_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "accord.start")) {
        throw new Error("Only the chat's main session can start an Accord; ask it to.");
      }
      if (!this.mcp.toolHandlers.chatStartAccordHandler) {
        throw new Error("Starting an Accord is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatStartAccordHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_COMPACT_PARTICIPANT_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.compact")) {
        throw new Error("Only the chat's main session compacts other members, and only while it compacts without asking.");
      }
      if (!this.mcp.toolHandlers.chatCompactParticipantHandler) {
        throw new Error("Compacting another member is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatCompactParticipantHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_REQUEST_PARTICIPANTS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.request")) {
        throw new Error("This member is not allowed to request other members.");
      }
      if (!this.mcp.toolHandlers.chatParticipantRequestHandler) {
        throw new Error("Chat member request handling is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatParticipantRequestHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_REQUEST_COMPACTION_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "compaction.request")) {
        throw new Error("This member is not allowed to request context compaction.");
      }
      if (!this.mcp.toolHandlers.chatCompactionRequestHandler) {
        throw new Error("Chat compaction request handling is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatCompactionRequestHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL) {
      if (!this.mcp.toolHandlers.chatParticipantRequestStatusHandler) {
        throw new Error("Chat member request status is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.chatParticipantRequestStatusHandler(actor, record.arguments));
    }
    if (record.name === APP_PERMISSIONS_REQUEST_CHANGE_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
        throw new Error("This member is not allowed to request permission changes.");
      }
      if (!this.mcp.toolHandlers.permissionChangeHandler) {
        throw new Error("Permission request handling is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.permissionChangeHandler(actor, record.arguments));
    }
    if (record.name === APP_ROSTER_DESCRIBE_OPTIONS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.mcp.toolHandlers.rosterOptionsHandler) {
        throw new Error("Roster option discovery is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.rosterOptionsHandler(actor));
    }
    if (record.name === APP_ROLES_DESCRIBE_OPTIONS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.mcp.toolHandlers.roleOptionsHandler) {
        throw new Error("Role option discovery is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.roleOptionsHandler(actor));
    }
    if (record.name === APP_ROLES_REQUEST_CHANGE_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.mcp.toolHandlers.roleChangeHandler) {
        throw new Error("Role management is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.roleChangeHandler(actor, record.arguments));
    }
    if (record.name === APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.mcp.toolHandlers.participantOptionsHandler) {
        throw new Error("Member option discovery is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.participantOptionsHandler(actor));
    }
    if (record.name === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.mcp.toolHandlers.participantChangeHandler) {
        throw new Error("Member management is not available.");
      }
      return toolTextResult(await this.mcp.toolHandlers.participantChangeHandler(actor, record.arguments));
    }
    if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
      throw new Error("This member is not allowed to manage chat members.");
    }
    if (!this.mcp.toolHandlers.rosterChangeHandler) {
      throw new Error("Roster management is not available.");
    }
    return toolTextResult(await this.mcp.toolHandlers.rosterChangeHandler(actor, record.arguments));
  }

  private logToolDenial(
    actor: AppMcpActor,
    toolName: string,
    layer: "first-party-app-server-policy" | "unknown-provider-or-runtime-behavior",
    code: string,
    missingEvidence: string[] = []
  ): void {
    void this.deps.debugLogs?.write("app.mcp.denial", {
      layer,
      code,
      toolName,
      conversationId: actor.conversationId,
      participantId: actor.participantId,
      runId: actor.runId ?? null,
      missingEvidence
    });
  }
}
