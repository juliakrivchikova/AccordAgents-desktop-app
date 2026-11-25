import type {
  AppArtifactToolHandler, AppChatAttachmentExportHandler, AppChatAttachmentListHandler, AppChatAttachmentReadHandler,
  AppChatCompactionRequestHandler, AppChatContextHandler, AppChatDelegateTaskHandler, AppChatMessagesHandler,
  AppChatParticipantActivityHandler, AppChatParticipantRequestHandler, AppChatParticipantRequestStatusHandler,
  AppChatParticipantsHandler, AppChatReactHandler, AppChatSendMessageHandler, AppChatSetTitleHandler, AppChatStartAccordHandler,
  AppMemoryToolHandler, AppParticipantChangeHandler, AppParticipantOptionsHandler, AppPermissionChangeHandler,
  AppRoleChangeHandler, AppRoleOptionsHandler, AppRosterChangeHandler, AppRosterOptionsHandler, AppScriptToolHandler,
  AppToolPermissionHandler, AppUrgentAlertToolHandler, AppWaitingToolHandler, ScriptApiHandler
} from "./handlerTypes";

/** Who answers each app tool. */
export class ToolHandlers {
  rosterChangeHandler?: AppRosterChangeHandler;
  rosterOptionsHandler?: AppRosterOptionsHandler;
  roleChangeHandler?: AppRoleChangeHandler;
  roleOptionsHandler?: AppRoleOptionsHandler;
  participantChangeHandler?: AppParticipantChangeHandler;
  participantOptionsHandler?: AppParticipantOptionsHandler;
  permissionChangeHandler?: AppPermissionChangeHandler;
  toolPermissionHandler?: AppToolPermissionHandler;
  connectorSignInHandler?: AppWaitingToolHandler;
  chatContextHandler?: AppChatContextHandler;
  chatParticipantsHandler?: AppChatParticipantsHandler;
  chatParticipantActivityHandler?: AppChatParticipantActivityHandler;
  chatMessagesHandler?: AppChatMessagesHandler;
  chatAttachmentListHandler?: AppChatAttachmentListHandler;
  chatAttachmentReadHandler?: AppChatAttachmentReadHandler;
  chatAttachmentExportHandler?: AppChatAttachmentExportHandler;
  chatParticipantRequestHandler?: AppChatParticipantRequestHandler;
  chatCompactionRequestHandler?: AppChatCompactionRequestHandler;
  chatParticipantRequestStatusHandler?: AppChatParticipantRequestStatusHandler;
  chatReactHandler?: AppChatReactHandler;
  chatSendMessageHandler?: AppChatSendMessageHandler;
  chatSetTitleHandler?: AppChatSetTitleHandler;
  chatDelegateTaskHandler?: AppChatDelegateTaskHandler;
  chatStartAccordHandler?: AppChatStartAccordHandler;
  artifactToolHandler?: AppArtifactToolHandler;
  scriptToolHandler?: AppScriptToolHandler;
  memoryToolHandler?: AppMemoryToolHandler;
  urgentAlertToolHandler?: AppUrgentAlertToolHandler;
  scriptApiHandler?: ScriptApiHandler;

  setRosterChangeHandler(handler: AppRosterChangeHandler): void {
    this.rosterChangeHandler = handler;
  }

  setRosterOptionsHandler(handler: AppRosterOptionsHandler): void {
    this.rosterOptionsHandler = handler;
  }

  setRoleChangeHandler(handler: AppRoleChangeHandler): void {
    this.roleChangeHandler = handler;
  }

  setRoleOptionsHandler(handler: AppRoleOptionsHandler): void {
    this.roleOptionsHandler = handler;
  }

  setParticipantChangeHandler(handler: AppParticipantChangeHandler): void {
    this.participantChangeHandler = handler;
  }

  setParticipantOptionsHandler(handler: AppParticipantOptionsHandler): void {
    this.participantOptionsHandler = handler;
  }

  setPermissionChangeHandler(handler: AppPermissionChangeHandler): void {
    this.permissionChangeHandler = handler;
  }

  setToolPermissionHandler(handler: AppToolPermissionHandler): void {
    this.toolPermissionHandler = handler;
  }

  /** The member asks the User to sign in to an MCP server its task needs. */
  setConnectorSignInHandler(handler: AppWaitingToolHandler): void {
    this.connectorSignInHandler = handler;
  }

  setChatContextHandler(handler: AppChatContextHandler): void {
    this.chatContextHandler = handler;
  }

  setChatParticipantsHandler(handler: AppChatParticipantsHandler): void {
    this.chatParticipantsHandler = handler;
  }

  setChatParticipantActivityHandler(handler: AppChatParticipantActivityHandler): void {
    this.chatParticipantActivityHandler = handler;
  }

  setChatMessagesHandler(handler: AppChatMessagesHandler): void {
    this.chatMessagesHandler = handler;
  }

  setChatAttachmentListHandler(handler: AppChatAttachmentListHandler): void {
    this.chatAttachmentListHandler = handler;
  }

  setChatAttachmentReadHandler(handler: AppChatAttachmentReadHandler): void {
    this.chatAttachmentReadHandler = handler;
  }

  setChatAttachmentExportHandler(handler: AppChatAttachmentExportHandler): void {
    this.chatAttachmentExportHandler = handler;
  }

  setChatParticipantRequestHandler(handler: AppChatParticipantRequestHandler): void {
    this.chatParticipantRequestHandler = handler;
  }

  setChatCompactionRequestHandler(handler: AppChatCompactionRequestHandler): void {
    this.chatCompactionRequestHandler = handler;
  }

  setChatParticipantRequestStatusHandler(handler: AppChatParticipantRequestStatusHandler): void {
    this.chatParticipantRequestStatusHandler = handler;
  }

  setChatReactHandler(handler: AppChatReactHandler): void {
    this.chatReactHandler = handler;
  }

  setChatSendMessageHandler(handler: AppChatSendMessageHandler): void {
    this.chatSendMessageHandler = handler;
  }

  setChatSetTitleHandler(handler: AppChatSetTitleHandler): void {
    this.chatSetTitleHandler = handler;
  }

  setChatDelegateTaskHandler(handler: AppChatDelegateTaskHandler): void {
    this.chatDelegateTaskHandler = handler;
  }

  setChatStartAccordHandler(handler: AppChatStartAccordHandler): void {
    this.chatStartAccordHandler = handler;
  }

  setArtifactToolHandler(handler: AppArtifactToolHandler): void {
    this.artifactToolHandler = handler;
  }

  setUrgentAlertToolHandler(handler: AppUrgentAlertToolHandler | undefined): void {
    this.urgentAlertToolHandler = handler;
  }

  setMemoryToolHandler(handler: AppMemoryToolHandler | undefined): void {
    this.memoryToolHandler = handler;
  }

  setScriptToolHandler(handler: AppScriptToolHandler | undefined): void {
    this.scriptToolHandler = handler;
  }

  setScriptApiHandler(handler: ScriptApiHandler | undefined): void {
    this.scriptApiHandler = handler;
  }
}
