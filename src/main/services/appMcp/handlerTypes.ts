import type { AppMcpActor, ScriptApiContext } from "./types";

export type AppRosterChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppRosterOptionsHandler = (actor: AppMcpActor) => Promise<unknown>;

export type AppRoleChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppRoleOptionsHandler = (actor: AppMcpActor) => Promise<unknown>;

export type AppParticipantChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppParticipantOptionsHandler = (actor: AppMcpActor) => Promise<unknown>;

export type AppPermissionChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppToolPermissionHandler = (actor: AppMcpActor, request: unknown, signal?: AbortSignal) => Promise<unknown>;

/** A tool call that waits for the User: given a signal that aborts when the
 *  member's CLI gives up on the call. */
export type AppWaitingToolHandler = (actor: AppMcpActor, request: unknown, signal?: AbortSignal) => Promise<unknown>;

export type AppChatContextHandler = (actor: AppMcpActor) => Promise<unknown>;

export type AppChatParticipantsHandler = (actor: AppMcpActor) => Promise<unknown>;

export type AppChatParticipantActivityHandler = (actor: AppMcpActor) => Promise<unknown>;

export type AppChatMessagesHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatAttachmentListHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatAttachmentReadHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatAttachmentExportHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatParticipantRequestHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatCompactionRequestHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatParticipantRequestStatusHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatReactHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatSendMessageHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatSetTitleHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatDelegateTaskHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppChatStartAccordHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

/** The main session compacts another member (app_chat_compact_participant). */
export type AppChatCompactParticipantHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

export type AppArtifactToolHandler = (actor: AppMcpActor, toolName: string, request: unknown) => Promise<unknown>;

export type AppScriptToolHandler = (actor: AppMcpActor, toolName: string, request: unknown) => Promise<unknown>;

export type AppMemoryToolHandler = (actor: AppMcpActor, toolName: string, request: unknown) => Promise<unknown>;

export type AppUrgentAlertToolHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

/** Answers the plain-HTTP script API; a thrown error with a numeric
 *  `status` becomes that HTTP status. */
export type ScriptApiHandler = (context: ScriptApiContext, route: "messages", body: unknown) => Promise<unknown>;
