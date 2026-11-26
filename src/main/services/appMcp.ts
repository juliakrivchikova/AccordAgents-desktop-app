import type {
  AppArtifactToolHandler, AppChatAttachmentExportHandler, AppChatAttachmentListHandler, AppChatAttachmentReadHandler,
  AppChatCompactionRequestHandler, AppChatCompactParticipantHandler, AppChatContextHandler, AppChatDelegateTaskHandler, AppChatMessagesHandler,
  AppChatParticipantActivityHandler, AppChatParticipantRequestHandler, AppChatParticipantRequestStatusHandler,
  AppChatParticipantsHandler, AppChatReactHandler, AppChatSendMessageHandler, AppChatSetTitleHandler, AppChatStartAccordHandler,
  AppMemoryToolHandler, AppParticipantChangeHandler, AppParticipantOptionsHandler, AppPermissionChangeHandler,
  AppRoleChangeHandler, AppRoleOptionsHandler, AppRosterChangeHandler, AppRosterOptionsHandler, AppScriptToolHandler,
  AppToolPermissionHandler, AppUrgentAlertToolHandler, AppWaitingToolHandler, ScriptApiHandler
} from "./appMcp/handlerTypes";
import type { AppMcpClientStatus, AppMcpConnection, AppMcpDebugLogger, AppMcpTokenGrant, ScriptApiContext } from "./appMcp/types";
import { createAppMcpModules, type AppMcpModules } from "./appMcp/modules";

export type { AppMcpActor, AppMcpConnection, AppMcpTokenGrant, AppMcpClientStatus, ScriptApiContext } from "./appMcp/types";
export * from "../../shared/appMcpToolContracts";

/** The app tools members call. The work is done by the parts in ./appMcp. */
export class AppMcpService {
  private readonly modules: AppMcpModules;

  constructor(
    debugLogs?: AppMcpDebugLogger
  ) {
    this.modules = createAppMcpModules({ debugLogs });
  }

  setRosterChangeHandler(handler: AppRosterChangeHandler): void {
    this.modules.toolHandlers.setRosterChangeHandler(handler);
  }

  setRosterOptionsHandler(handler: AppRosterOptionsHandler): void {
    this.modules.toolHandlers.setRosterOptionsHandler(handler);
  }

  setRoleChangeHandler(handler: AppRoleChangeHandler): void {
    this.modules.toolHandlers.setRoleChangeHandler(handler);
  }

  setRoleOptionsHandler(handler: AppRoleOptionsHandler): void {
    this.modules.toolHandlers.setRoleOptionsHandler(handler);
  }

  setParticipantChangeHandler(handler: AppParticipantChangeHandler): void {
    this.modules.toolHandlers.setParticipantChangeHandler(handler);
  }

  setParticipantOptionsHandler(handler: AppParticipantOptionsHandler): void {
    this.modules.toolHandlers.setParticipantOptionsHandler(handler);
  }

  setPermissionChangeHandler(handler: AppPermissionChangeHandler): void {
    this.modules.toolHandlers.setPermissionChangeHandler(handler);
  }

  setToolPermissionHandler(handler: AppToolPermissionHandler): void {
    this.modules.toolHandlers.setToolPermissionHandler(handler);
  }

  /** The member asks the User to sign in to an MCP server its task needs. */
  setConnectorSignInHandler(handler: AppWaitingToolHandler): void {
    this.modules.toolHandlers.setConnectorSignInHandler(handler);
  }

  setChatContextHandler(handler: AppChatContextHandler): void {
    this.modules.toolHandlers.setChatContextHandler(handler);
  }

  setChatParticipantsHandler(handler: AppChatParticipantsHandler): void {
    this.modules.toolHandlers.setChatParticipantsHandler(handler);
  }

  setChatParticipantActivityHandler(handler: AppChatParticipantActivityHandler): void {
    this.modules.toolHandlers.setChatParticipantActivityHandler(handler);
  }

  setChatMessagesHandler(handler: AppChatMessagesHandler): void {
    this.modules.toolHandlers.setChatMessagesHandler(handler);
  }

  setChatAttachmentListHandler(handler: AppChatAttachmentListHandler): void {
    this.modules.toolHandlers.setChatAttachmentListHandler(handler);
  }

  setChatAttachmentReadHandler(handler: AppChatAttachmentReadHandler): void {
    this.modules.toolHandlers.setChatAttachmentReadHandler(handler);
  }

  setChatAttachmentExportHandler(handler: AppChatAttachmentExportHandler): void {
    this.modules.toolHandlers.setChatAttachmentExportHandler(handler);
  }

  setChatParticipantRequestHandler(handler: AppChatParticipantRequestHandler): void {
    this.modules.toolHandlers.setChatParticipantRequestHandler(handler);
  }

  setChatCompactionRequestHandler(handler: AppChatCompactionRequestHandler): void {
    this.modules.toolHandlers.setChatCompactionRequestHandler(handler);
  }

  setChatParticipantRequestStatusHandler(handler: AppChatParticipantRequestStatusHandler): void {
    this.modules.toolHandlers.setChatParticipantRequestStatusHandler(handler);
  }

  setChatReactHandler(handler: AppChatReactHandler): void {
    this.modules.toolHandlers.setChatReactHandler(handler);
  }

  setChatSendMessageHandler(handler: AppChatSendMessageHandler): void {
    this.modules.toolHandlers.setChatSendMessageHandler(handler);
  }

  setChatSetTitleHandler(handler: AppChatSetTitleHandler): void {
    this.modules.toolHandlers.setChatSetTitleHandler(handler);
  }

  setChatDelegateTaskHandler(handler: AppChatDelegateTaskHandler): void {
    this.modules.toolHandlers.setChatDelegateTaskHandler(handler);
  }

  setChatStartAccordHandler(handler: AppChatStartAccordHandler): void {
    this.modules.toolHandlers.setChatStartAccordHandler(handler);
  }

  setChatCompactParticipantHandler(handler: AppChatCompactParticipantHandler): void {
    this.modules.toolHandlers.setChatCompactParticipantHandler(handler);
  }

  setArtifactToolHandler(handler: AppArtifactToolHandler): void {
    this.modules.toolHandlers.setArtifactToolHandler(handler);
  }

  setUrgentAlertToolHandler(handler: AppUrgentAlertToolHandler | undefined): void {
    this.modules.toolHandlers.setUrgentAlertToolHandler(handler);
  }

  setMemoryToolHandler(handler: AppMemoryToolHandler | undefined): void {
    this.modules.toolHandlers.setMemoryToolHandler(handler);
  }

  setScriptToolHandler(handler: AppScriptToolHandler | undefined): void {
    this.modules.toolHandlers.setScriptToolHandler(handler);
  }

  setScriptApiHandler(handler: ScriptApiHandler | undefined): void {
    this.modules.toolHandlers.setScriptApiHandler(handler);
  }

  /** Base URL of the script API, e.g. http://127.0.0.1:PORT/script-api. */
  scriptApiUrl(): string | undefined {
    return this.modules.accessTokens.scriptApiUrl();
  }

  issueScriptToken(context: ScriptApiContext): string {
    return this.modules.accessTokens.issueScriptToken(context);
  }

  revokeScriptToken(token: string): void {
    this.modules.accessTokens.revokeScriptToken(token);
  }

  start(): Promise<void> {
    return this.modules.mcpServer.start();
  }

  stop(): Promise<void> {
    return this.modules.mcpServer.stop();
  }

  issueToken(grant: AppMcpTokenGrant): AppMcpConnection | undefined {
    return this.modules.accessTokens.issueToken(grant);
  }

  updateToken(token: string, grant: AppMcpTokenGrant): AppMcpConnection | undefined {
    return this.modules.accessTokens.updateToken(token, grant);
  }

  clientStatus(clientGenerationId: string): AppMcpClientStatus | undefined {
    return this.modules.clientStates.clientStatus(clientGenerationId);
  }
}
