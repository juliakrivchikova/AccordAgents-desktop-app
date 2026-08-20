import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatAgentMode, ChatAgentPermissions, ChatAppToolCapability } from "../../shared/types";
import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../shared/appTools";

import {
  APP_ROSTER_REQUEST_CHANGE_TOOL,
  APP_ROSTER_DESCRIBE_OPTIONS_TOOL,
  APP_ROLES_REQUEST_CHANGE_TOOL,
  APP_ROLES_DESCRIBE_OPTIONS_TOOL,
  APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
  APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL,
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
  APP_TOOL_PERMISSION_TOOL,
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
  APP_CHAT_REQUEST_COMPACTION_TOOL,
  APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL,
  APP_CHAT_GET_CONTEXT_TOOL,
  APP_CHAT_GET_PARTICIPANTS_TOOL,
  APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL,
  APP_CHAT_READ_MESSAGES_TOOL,
  APP_CHAT_LIST_ATTACHMENTS_TOOL,
  APP_CHAT_READ_ATTACHMENT_TOOL,
  APP_CHAT_EXPORT_ATTACHMENT_TOOL,
  APP_CHAT_REACT_TOOL,
  APP_CHAT_SEND_MESSAGE_TOOL,
  APP_CHAT_SET_TITLE_TOOL,
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
  APP_ARTIFACT_PUBLISH_TOOL,
  APP_ARTIFACT_TOOL_NAMES,
  APP_MCP_TOOL_POLICIES,
  appMcpToolDefinitionsForCapabilities
} from "../../shared/appMcpToolContracts";
export * from "../../shared/appMcpToolContracts";

export interface AppMcpActor {
  conversationId: string;
  participantId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  capabilities: ChatAppToolCapability[];
  clientGenerationId?: string;
  expectedToolNames?: string[];
  triggerMessageId?: string;
  triggerThreadId?: string;
  triggerParentMessageId?: string;
  triggerChatThreadRootId?: string;
  snapshotMaxSequence?: number;
  continuation?: boolean;
  runId?: string;
  turnSegmentId?: string;
  participantRequestDepth?: number;
  participantRequestBatchId?: string;
  chainRootId?: string;
  historyMarkdownPath?: string;
  historyJsonPath?: string;
  agentMode?: ChatAgentMode;
  runPermissions?: ChatAgentPermissions;
}

export interface AppMcpConnection {
  url: string;
  token: string;
}

export interface AppMcpTokenGrant extends AppMcpActor {}

export interface AppMcpClientStatus {
  clientGenerationId: string;
  initialized: boolean;
  listedTools: boolean;
  requiredToolsPresent: boolean;
  missingToolNames: string[];
  errored: boolean;
  errorMessage?: string;
  updatedAt: string;
}

interface AppMcpClientState extends AppMcpClientStatus {
  expectedToolNames: string[];
  listedToolNames: string[];
}

interface AppMcpDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

type AppRosterChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppRosterOptionsHandler = (actor: AppMcpActor) => Promise<unknown>;
type AppRoleChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppRoleOptionsHandler = (actor: AppMcpActor) => Promise<unknown>;
type AppParticipantChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppParticipantOptionsHandler = (actor: AppMcpActor) => Promise<unknown>;
type AppPermissionChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppToolPermissionHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatContextHandler = (actor: AppMcpActor) => Promise<unknown>;
type AppChatParticipantsHandler = (actor: AppMcpActor) => Promise<unknown>;
type AppChatParticipantActivityHandler = (actor: AppMcpActor) => Promise<unknown>;
type AppChatMessagesHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatAttachmentListHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatAttachmentReadHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatAttachmentExportHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatParticipantRequestHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatCompactionRequestHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatParticipantRequestStatusHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatReactHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatSendMessageHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatSetTitleHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppArtifactToolHandler = (actor: AppMcpActor, toolName: string, request: unknown) => Promise<unknown>;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_MCP_BODY_BYTES = 1_000_000;

export class AppMcpService {
  private server?: http.Server;
  private url?: string;
  private readonly tokens = new Map<string, AppMcpActor>();
  private readonly clientStates = new Map<string, AppMcpClientState>();
  private rosterChangeHandler?: AppRosterChangeHandler;
  private rosterOptionsHandler?: AppRosterOptionsHandler;
  private roleChangeHandler?: AppRoleChangeHandler;
  private roleOptionsHandler?: AppRoleOptionsHandler;
  private participantChangeHandler?: AppParticipantChangeHandler;
  private participantOptionsHandler?: AppParticipantOptionsHandler;
  private permissionChangeHandler?: AppPermissionChangeHandler;
  private toolPermissionHandler?: AppToolPermissionHandler;
  private chatContextHandler?: AppChatContextHandler;
  private chatParticipantsHandler?: AppChatParticipantsHandler;
  private chatParticipantActivityHandler?: AppChatParticipantActivityHandler;
  private chatMessagesHandler?: AppChatMessagesHandler;
  private chatAttachmentListHandler?: AppChatAttachmentListHandler;
  private chatAttachmentReadHandler?: AppChatAttachmentReadHandler;
  private chatAttachmentExportHandler?: AppChatAttachmentExportHandler;
  private chatParticipantRequestHandler?: AppChatParticipantRequestHandler;
  private chatCompactionRequestHandler?: AppChatCompactionRequestHandler;
  private chatParticipantRequestStatusHandler?: AppChatParticipantRequestStatusHandler;
  private chatReactHandler?: AppChatReactHandler;
  private chatSendMessageHandler?: AppChatSendMessageHandler;
  private chatSetTitleHandler?: AppChatSetTitleHandler;
  private artifactToolHandler?: AppArtifactToolHandler;

  constructor(private readonly debugLogs?: AppMcpDebugLogger) {}

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

  setArtifactToolHandler(handler: AppArtifactToolHandler): void {
    this.artifactToolHandler = handler;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => {
        this.server?.off("error", reject);
        const address = this.server?.address() as AddressInfo | null;
        if (!address) {
          reject(new Error("App MCP server did not expose a listen address."));
          return;
        }
        this.url = `http://127.0.0.1:${address.port}/mcp`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    this.tokens.clear();
    this.clientStates.clear();
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  issueToken(grant: AppMcpTokenGrant): AppMcpConnection | undefined {
    if (!this.url) {
      return undefined;
    }
    const token = randomUUID();
    const actor = this.actorFromGrant(grant);
    this.tokens.set(token, actor);
    this.ensureClientState(actor);
    return { url: this.url, token };
  }

  updateToken(token: string, grant: AppMcpTokenGrant): AppMcpConnection | undefined {
    if (!this.url || !this.tokens.has(token)) {
      return undefined;
    }
    const actor = this.actorFromGrant(grant);
    this.tokens.set(token, actor);
    this.ensureClientState(actor);
    return { url: this.url, token };
  }

  clientStatus(clientGenerationId: string): AppMcpClientStatus | undefined {
    const state = this.clientStates.get(clientGenerationId);
    return state ? this.publicClientStatus(state) : undefined;
  }

  private actorFromGrant(grant: AppMcpTokenGrant): AppMcpActor {
    return {
      conversationId: grant.conversationId,
      participantId: grant.participantId,
      roleConfigId: grant.roleConfigId,
      roleConfigVersion: grant.roleConfigVersion,
      capabilities: [...grant.capabilities],
      clientGenerationId: grant.clientGenerationId,
      expectedToolNames: Array.from(new Set(grant.expectedToolNames ?? [])).sort(),
      triggerMessageId: grant.triggerMessageId,
      triggerThreadId: grant.triggerThreadId,
      triggerParentMessageId: grant.triggerParentMessageId,
      triggerChatThreadRootId: grant.triggerChatThreadRootId,
      snapshotMaxSequence: grant.snapshotMaxSequence,
      continuation: grant.continuation,
      runId: grant.runId,
      turnSegmentId: grant.turnSegmentId,
      participantRequestDepth: grant.participantRequestDepth,
      participantRequestBatchId: grant.participantRequestBatchId,
      chainRootId: grant.chainRootId,
      historyMarkdownPath: grant.historyMarkdownPath,
      historyJsonPath: grant.historyJsonPath,
      agentMode: grant.agentMode ? normalizeChatAgentMode(grant.agentMode) : undefined,
      runPermissions: grant.runPermissions ? normalizeChatAgentPermissions(grant.runPermissions) : undefined
    };
  }

  private async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const pathname = request.url?.split("?")[0];
    if (request.method !== "POST" || pathname !== "/mcp") {
      this.writeHttp(response, 404, "text/plain", "Not found");
      return;
    }

    const actor = this.actorFromRequest(request);
    if (!actor) {
      this.writeHttp(response, 401, "application/json", JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let payload: unknown;
    try {
      payload = await this.readJsonBody(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeJson(response, this.rpcError(null, -32700, message));
      return;
    }

    const requests = Array.isArray(payload) ? payload : [payload];
    const results: JsonRpcResponse[] = [];
    for (const item of requests) {
      const result = await this.handleRpcRequest(actor, item);
      if (result) {
        results.push(result);
      }
    }
    if (results.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    this.writeJson(response, Array.isArray(payload) ? results : results[0]);
  }

  private async handleRpcRequest(actor: AppMcpActor, raw: unknown): Promise<JsonRpcResponse | undefined> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return this.rpcError(null, -32600, "Invalid JSON-RPC request.");
    }
    const request = raw as JsonRpcRequest;
    const id = request.id;
    const method = typeof request.method === "string" ? request.method : "";
    const isNotification = id === undefined;

    try {
      if (method === "initialize") {
        this.markClientInitialized(actor);
        return isNotification ? undefined : this.rpcResult(id, this.initializeResult());
      }
      if (method === "notifications/initialized") {
        return undefined;
      }
      if (method === "tools/list") {
        const tools = this.toolsForActor(actor);
        this.markClientToolsListed(actor, tools);
        return isNotification ? undefined : this.rpcResult(id, { tools });
      }
      if (method === "tools/call") {
        return isNotification ? undefined : this.rpcResult(id, await this.callTool(actor, request.params));
      }
      return isNotification ? undefined : this.rpcError(id, -32601, `Unsupported MCP method: ${method || "unknown"}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (method === "initialize" || method === "tools/list") {
        this.markClientError(actor, message);
      }
      return isNotification ? undefined : this.rpcError(id, -32603, message);
    }
  }

  private ensureClientState(actor: AppMcpActor): AppMcpClientState | undefined {
    const clientGenerationId = actor.clientGenerationId;
    if (!clientGenerationId) {
      return undefined;
    }
    const expectedToolNames = Array.from(new Set(actor.expectedToolNames ?? [])).sort();
    const existing = this.clientStates.get(clientGenerationId);
    if (existing) {
      existing.expectedToolNames = expectedToolNames;
      existing.missingToolNames = this.missingToolNames(expectedToolNames, existing.listedToolNames);
      existing.requiredToolsPresent = existing.missingToolNames.length === 0;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }
    const state: AppMcpClientState = {
      clientGenerationId,
      expectedToolNames,
      listedToolNames: [],
      initialized: false,
      listedTools: false,
      requiredToolsPresent: expectedToolNames.length === 0,
      missingToolNames: expectedToolNames,
      errored: false,
      updatedAt: new Date().toISOString()
    };
    this.clientStates.set(clientGenerationId, state);
    return state;
  }

  private markClientInitialized(actor: AppMcpActor): void {
    const state = this.ensureClientState(actor);
    if (!state) {
      return;
    }
    state.initialized = true;
    state.updatedAt = new Date().toISOString();
  }

  private markClientToolsListed(actor: AppMcpActor, tools: unknown[]): void {
    const state = this.ensureClientState(actor);
    if (!state) {
      return;
    }
    const listedToolNames = new Set(tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
        return [];
      }
      const name = (tool as { name?: unknown }).name;
      return typeof name === "string" ? [name] : [];
    }));
    state.listedTools = true;
    state.listedToolNames = Array.from(listedToolNames).sort();
    state.missingToolNames = this.missingToolNames(state.expectedToolNames, listedToolNames);
    state.requiredToolsPresent = state.missingToolNames.length === 0;
    state.updatedAt = new Date().toISOString();
  }

  private markClientError(actor: AppMcpActor, message: string): void {
    const state = this.ensureClientState(actor);
    if (!state) {
      return;
    }
    state.errored = true;
    state.errorMessage = message.slice(0, 240);
    state.updatedAt = new Date().toISOString();
  }

  private missingToolNames(expectedToolNames: string[], listedToolNames: Set<string> | string[] | undefined): string[] {
    const listed = listedToolNames instanceof Set ? listedToolNames : new Set(listedToolNames ?? []);
    return expectedToolNames.filter((toolName) => !listed.has(toolName));
  }

  private publicClientStatus(state: AppMcpClientState): AppMcpClientStatus {
    return {
      clientGenerationId: state.clientGenerationId,
      initialized: state.initialized,
      listedTools: state.listedTools,
      requiredToolsPresent: state.requiredToolsPresent,
      missingToolNames: [...state.missingToolNames],
      errored: state.errored,
      errorMessage: state.errorMessage,
      updatedAt: state.updatedAt
    };
  }

  private initializeResult(): unknown {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "accordagents-app",
        version: "0.1.0"
      }
    };
  }

  private toolsForActor(actor: AppMcpActor): unknown[] {
    return appMcpToolDefinitionsForCapabilities(actor.capabilities);
  }

  private async callTool(actor: AppMcpActor, params: unknown): Promise<unknown> {
    const toolName = this.diagnosticToolName(params);
    try {
      const result = await this.callToolUnchecked(actor, params);
      const denialCode = this.structuredToolDenialCode(result);
      if (denialCode) {
        this.logToolDenial(actor, toolName, "first-party-app-server-policy", denialCode);
      }
      return result;
    } catch (error) {
      const denialCode = this.appToolPolicyDenialCode(error);
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

  private async callToolUnchecked(actor: AppMcpActor, params: unknown): Promise<unknown> {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("Tool call params are required.");
    }
    const record = params as { name?: unknown; arguments?: unknown };
    if (typeof record.name === "string" && (APP_ARTIFACT_TOOL_NAMES as readonly string[]).includes(record.name)) {
      if (!this.artifactToolHandler) {
        throw new Error("Artifact tools are not available.");
      }
      return this.toolTextResult(await this.artifactToolHandler(actor, record.name, record.arguments));
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
      record.name !== APP_CHAT_SET_TITLE_TOOL
    ) {
      throw new Error(`Unknown app tool: ${String(record.name ?? "")}.`);
    }
    if (record.name === APP_TOOL_PERMISSION_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
        throw new Error("This member is not allowed to request tool permissions.");
      }
      if (!this.toolPermissionHandler) {
        throw new Error("Tool permission handling is not available.");
      }
      return this.toolTextResult(await this.toolPermissionHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_GET_CONTEXT_TOOL) {
      if (!this.chatContextHandler) {
        throw new Error("Chat context discovery is not available.");
      }
      return this.toolTextResult(await this.chatContextHandler(actor));
    }
    if (record.name === APP_CHAT_GET_PARTICIPANTS_TOOL) {
      if (!this.chatParticipantsHandler) {
        throw new Error("Chat member discovery is not available.");
      }
      return this.toolTextResult(await this.chatParticipantsHandler(actor));
    }
    if (record.name === APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL) {
      if (!this.chatParticipantActivityHandler) {
        throw new Error("Chat member activity is not available.");
      }
      return this.toolTextResult(await this.chatParticipantActivityHandler(actor));
    }
    if (record.name === APP_CHAT_READ_MESSAGES_TOOL) {
      if (!this.chatMessagesHandler) {
        throw new Error("Chat message reading is not available.");
      }
      return this.toolTextResult(await this.chatMessagesHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_LIST_ATTACHMENTS_TOOL) {
      if (!this.chatAttachmentListHandler) {
        throw new Error("Chat attachment listing is not available.");
      }
      return this.toolTextResult(await this.chatAttachmentListHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_READ_ATTACHMENT_TOOL) {
      if (!this.chatAttachmentReadHandler) {
        throw new Error("Chat attachment reading is not available.");
      }
      return this.toolImageResult(await this.chatAttachmentReadHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_EXPORT_ATTACHMENT_TOOL) {
      if (!this.chatAttachmentExportHandler) {
        throw new Error("Chat attachment exporting is not available.");
      }
      return this.toolTextResult(await this.chatAttachmentExportHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_REACT_TOOL) {
      if (!this.chatReactHandler) {
        throw new Error("Chat reaction handling is not available.");
      }
      return this.toolTextResult(await this.chatReactHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_SEND_MESSAGE_TOOL) {
      if (!this.chatSendMessageHandler) {
        throw new Error("Chat message sending is not available.");
      }
      return this.toolTextResult(await this.chatSendMessageHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_SET_TITLE_TOOL) {
      if (!this.chatSetTitleHandler) {
        throw new Error("Chat title setting is not available.");
      }
      return this.toolTextResult(await this.chatSetTitleHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_REQUEST_PARTICIPANTS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.request")) {
        throw new Error("This member is not allowed to request other members.");
      }
      if (!this.chatParticipantRequestHandler) {
        throw new Error("Chat member request handling is not available.");
      }
      return this.toolTextResult(await this.chatParticipantRequestHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_REQUEST_COMPACTION_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "compaction.request")) {
        throw new Error("This member is not allowed to request context compaction.");
      }
      if (!this.chatCompactionRequestHandler) {
        throw new Error("Chat compaction request handling is not available.");
      }
      return this.toolTextResult(await this.chatCompactionRequestHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL) {
      if (!this.chatParticipantRequestStatusHandler) {
        throw new Error("Chat member request status is not available.");
      }
      return this.toolTextResult(await this.chatParticipantRequestStatusHandler(actor, record.arguments));
    }
    if (record.name === APP_PERMISSIONS_REQUEST_CHANGE_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
        throw new Error("This member is not allowed to request permission changes.");
      }
      if (!this.permissionChangeHandler) {
        throw new Error("Permission request handling is not available.");
      }
      return this.toolTextResult(await this.permissionChangeHandler(actor, record.arguments));
    }
    if (record.name === APP_ROSTER_DESCRIBE_OPTIONS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.rosterOptionsHandler) {
        throw new Error("Roster option discovery is not available.");
      }
      return this.toolTextResult(await this.rosterOptionsHandler(actor));
    }
    if (record.name === APP_ROLES_DESCRIBE_OPTIONS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.roleOptionsHandler) {
        throw new Error("Role option discovery is not available.");
      }
      return this.toolTextResult(await this.roleOptionsHandler(actor));
    }
    if (record.name === APP_ROLES_REQUEST_CHANGE_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.roleChangeHandler) {
        throw new Error("Role management is not available.");
      }
      return this.toolTextResult(await this.roleChangeHandler(actor, record.arguments));
    }
    if (record.name === APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.participantOptionsHandler) {
        throw new Error("Member option discovery is not available.");
      }
      return this.toolTextResult(await this.participantOptionsHandler(actor));
    }
    if (record.name === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This member is not allowed to manage chat members.");
      }
      if (!this.participantChangeHandler) {
        throw new Error("Member management is not available.");
      }
      return this.toolTextResult(await this.participantChangeHandler(actor, record.arguments));
    }
    if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
      throw new Error("This member is not allowed to manage chat members.");
    }
    if (!this.rosterChangeHandler) {
      throw new Error("Roster management is not available.");
    }
    return this.toolTextResult(await this.rosterChangeHandler(actor, record.arguments));
  }

  private diagnosticToolName(params: unknown): string {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return "unknown-tool";
    }
    const name = (params as { name?: unknown }).name;
    return typeof name === "string" && APP_MCP_TOOL_POLICIES.some((policy) => policy.name === name)
      ? name
      : "unknown-tool";
  }

  private structuredToolDenialCode(result: unknown): string | undefined {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return undefined;
    }
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return undefined;
    }
    const text = content.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const value = (item as { text?: unknown }).text;
      return typeof value === "string" ? [value] : [];
    })[0];
    if (!text) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { ok?: unknown }).ok !== false) {
        return undefined;
      }
      const error = (parsed as { error?: unknown }).error;
      const code = error && typeof error === "object" && !Array.isArray(error)
        ? (error as { code?: unknown }).code
        : undefined;
      return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(code)
        ? code
        : "APP_TOOL_REQUEST_DENIED";
    } catch {
      return undefined;
    }
  }

  private appToolPolicyDenialCode(error: unknown): string | undefined {
    const message = error instanceof Error ? error.message : String(error);
    if (/not allowed/i.test(message)) {
      return "APP_TOOL_CAPABILITY_DENIED";
    }
    if (/unauthorized/i.test(message)) {
      return "APP_TOOL_UNAUTHORIZED";
    }
    return undefined;
  }

  private logToolDenial(
    actor: AppMcpActor,
    toolName: string,
    layer: "first-party-app-server-policy" | "unknown-provider-or-runtime-behavior",
    code: string,
    missingEvidence: string[] = []
  ): void {
    void this.debugLogs?.write("app.mcp.denial", {
      layer,
      code,
      toolName,
      conversationId: actor.conversationId,
      participantId: actor.participantId,
      runId: actor.runId ?? null,
      missingEvidence
    });
  }

  private toolTextResult(result: unknown): unknown {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  private toolImageResult(result: unknown): unknown {
    const record = result && typeof result === "object" && !Array.isArray(result)
      ? result as { attachment?: unknown; dataBase64?: unknown }
      : {};
    const attachment = record.attachment && typeof record.attachment === "object" && !Array.isArray(record.attachment)
      ? record.attachment as { mimeType?: unknown }
      : undefined;
    const data = typeof record.dataBase64 === "string" ? record.dataBase64 : "";
    const mimeType = typeof attachment?.mimeType === "string" ? attachment.mimeType : "image/png";
    const summary = {
      ...record,
      dataBase64: data ? "[omitted: returned as MCP image content]" : undefined
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(summary, null, 2)
        },
        ...(data
          ? [{
              type: "image",
              data,
              mimeType
            }]
          : [])
      ]
    };
  }

  private actorFromRequest(request: http.IncomingMessage): AppMcpActor | undefined {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return undefined;
    }
    return this.tokens.get(match[1].trim());
  }

  private readJsonBody(request: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = "";
      let bytes = 0;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_MCP_BODY_BYTES) {
          reject(new Error("MCP request body is too large."));
          request.destroy();
          return;
        }
        body += chunk;
      });
      request.on("error", reject);
      request.on("end", () => {
        try {
          resolve(body.trim() ? JSON.parse(body) : {});
        } catch {
          reject(new Error("Invalid JSON body."));
        }
      });
    });
  }

  private rpcResult(id: unknown, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private rpcError(id: unknown, code: number, message: string): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message
      }
    };
  }

  private writeJson(response: http.ServerResponse, payload: unknown): void {
    this.writeHttp(response, 200, "application/json", JSON.stringify(payload));
  }

  private writeHttp(response: http.ServerResponse, statusCode: number, contentType: string, body: string): void {
    response.writeHead(statusCode, {
      "content-type": contentType,
      "cache-control": "no-store"
    });
    response.end(body);
  }
}
