import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatAgentPermissions, ChatAppToolCapability } from "../../shared/types";
import { normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../shared/appTools";
import { CHAT_REACTION_EMOJIS } from "../../shared/chatReactions";

export const APP_ROSTER_REQUEST_CHANGE_TOOL = "app_roster_request_change";
export const APP_ROSTER_DESCRIBE_OPTIONS_TOOL = "app_roster_describe_options";
export const APP_ROLES_REQUEST_CHANGE_TOOL = "app_roles_request_change";
export const APP_ROLES_DESCRIBE_OPTIONS_TOOL = "app_roles_describe_options";
export const APP_PARTICIPANTS_REQUEST_CHANGE_TOOL = "app_participants_request_change";
export const APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL = "app_participants_describe_options";
export const APP_PERMISSIONS_REQUEST_CHANGE_TOOL = "app_permissions_request_change";
export const APP_TOOL_PERMISSION_TOOL = "app_tool_permission";
export const APP_CHAT_REQUEST_PARTICIPANTS_TOOL = "app_chat_request_participants";
export const APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL = "app_chat_get_participant_request_status";
export const APP_CHAT_GET_CONTEXT_TOOL = "app_chat_get_context";
export const APP_CHAT_GET_PARTICIPANTS_TOOL = "app_chat_get_participants";
export const APP_CHAT_READ_MESSAGES_TOOL = "app_chat_read_messages";
export const APP_CHAT_LIST_ATTACHMENTS_TOOL = "app_chat_list_attachments";
export const APP_CHAT_READ_ATTACHMENT_TOOL = "app_chat_read_attachment";
export const APP_CHAT_EXPORT_ATTACHMENT_TOOL = "app_chat_export_attachment";
export const APP_CHAT_REACT_TOOL = "app_chat_react";
export const APP_CHAT_SEND_MESSAGE_TOOL = "app_chat_send_message";
export const APP_CHAT_SET_TITLE_TOOL = "app_chat_set_title";

const CHAT_AGENT_PERMISSION_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    repoRead: { type: "boolean" },
    workspaceWrite: { type: "boolean" },
    webAccess: { type: "boolean" },
    requestParticipants: {
      type: "string",
      enum: ["ask", "allow", "deny"]
    },
    manageRolesParticipants: {
      type: "string",
      enum: ["ask", "allow", "deny"],
      description: "Participant-specific role/member management behavior. Omit to inherit the selected role default."
    },
    shell: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        rules: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", enum: ["allow", "ask", "deny"] },
              pattern: { type: "string" },
              match: { type: "string", enum: ["exact", "prefix"] }
            },
            required: ["action", "pattern", "match"]
          }
        }
      }
    },
    providerNative: {
      type: "object",
      additionalProperties: true
    }
  }
} as const;

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
  participantRequestDepth?: number;
  participantRequestBatchId?: string;
  chainRootId?: string;
  historyMarkdownPath?: string;
  historyJsonPath?: string;
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
type AppChatMessagesHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatAttachmentListHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatAttachmentReadHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatAttachmentExportHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatParticipantRequestHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatParticipantRequestStatusHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatReactHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatSendMessageHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatSetTitleHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

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
  private chatMessagesHandler?: AppChatMessagesHandler;
  private chatAttachmentListHandler?: AppChatAttachmentListHandler;
  private chatAttachmentReadHandler?: AppChatAttachmentReadHandler;
  private chatAttachmentExportHandler?: AppChatAttachmentExportHandler;
  private chatParticipantRequestHandler?: AppChatParticipantRequestHandler;
  private chatParticipantRequestStatusHandler?: AppChatParticipantRequestStatusHandler;
  private chatReactHandler?: AppChatReactHandler;
  private chatSendMessageHandler?: AppChatSendMessageHandler;
  private chatSetTitleHandler?: AppChatSetTitleHandler;

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
      participantRequestDepth: grant.participantRequestDepth,
      participantRequestBatchId: grant.participantRequestBatchId,
      chainRootId: grant.chainRootId,
      historyMarkdownPath: grant.historyMarkdownPath,
      historyJsonPath: grant.historyJsonPath,
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
    const tools: unknown[] = [
      {
        name: APP_TOOL_PERMISSION_TOOL,
        title: "Handle CLI Tool Permission",
        description:
          "Claude Code permission-prompt bridge. Claude Code calls this MCP tool when a CLI tool request needs approval in a non-interactive chat run. The app shows the request to the User and returns a permission decision.",
        inputSchema: {
          type: "object",
          additionalProperties: true,
          properties: {
            tool_name: {
              type: "string",
              description: "Canonical tool name requesting permission, for example Bash, Write, or mcp__server__tool."
            },
            toolName: {
              type: "string",
              description: "Alternate camelCase tool name field."
            },
            input: {
              type: "object",
              additionalProperties: true,
              description: "Tool input parameters."
            },
            tool_input: {
              type: "object",
              additionalProperties: true,
              description: "Alternate snake_case tool input field."
            },
            reason: {
              type: "string",
              description: "Optional reason or explanation for the requested tool call."
            },
            suggestions: {
              type: "array",
              description: "Optional permission-update suggestions from Claude Code."
            }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_GET_CONTEXT_TOOL,
        title: "Get Chat Context",
        description:
          "Return the current chat conversation, requesting participant, active turn metadata, and available context sources. This is read-only and scoped to the issued app token.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {}
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_GET_PARTICIPANTS_TOOL,
        title: "Get Chat Participants",
        description:
          "Return the current chat roster, role labels, provider details, and safe participant capabilities for this chat. This is read-only.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {}
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL,
        title: "Get Participant Request Status",
        description:
          "Return current status and available replies/errors for a previous participant request. Use this to recover after timeout, interruption, approval delay, or session resume.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            requestId: {
              type: "string",
              description: "Optional participant request batch id. If omitted, returns recent requests made by this participant."
            }
          }
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_READ_MESSAGES_TOOL,
        title: "Read Chat Messages",
        description:
          "Read paginated chat messages from the current conversation, optionally filtered to one thread. Use this instead of rereading full history files when you need prior chat context.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            messageId: {
              type: "string",
              description: "Optional message id. When set, returns only that single message (with metadata.reactions) if it is visible to this turn; other filters are ignored. Use this to read the exact canonical message under approval."
            },
            threadId: {
              type: "string",
              description: "Optional thread id to read only messages from one chat thread."
            },
            beforeSequence: {
              type: "integer",
              minimum: 0,
              description: "Optional exclusive upper sequence bound. Returns messages with sequence lower than this value."
            },
            afterSequence: {
              type: "integer",
              minimum: 0,
              description: "Optional exclusive lower sequence bound. Returns messages with sequence greater than this value."
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 200,
              description: "Maximum number of messages to return. Defaults to recent focused context."
            }
          }
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_LIST_ATTACHMENTS_TOOL,
        title: "List Chat Attachments",
        description:
          "List image attachments visible to the current app token. Use this to discover attachment IDs, filenames, MIME types, dimensions, and source message IDs before reading image bytes.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            messageId: {
              type: "string",
              description: "Optional source message id. If omitted, returns visible attachments from the current conversation snapshot."
            },
            threadId: {
              type: "string",
              description: "Optional chat thread id to list attachments from one thread."
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              description: "Maximum number of attachment records to return. Defaults to 50."
            }
          }
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_READ_ATTACHMENT_TOOL,
        title: "Read Chat Attachment",
        description:
          "Read one visible image attachment by attachmentId. The result includes metadata plus image content; use this when a message says it has an attached screenshot or image.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            attachmentId: {
              type: "string",
              description: "Attachment id from app_chat_list_attachments or message metadata."
            }
          },
          required: ["attachmentId"]
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_EXPORT_ATTACHMENT_TOOL,
        title: "Export Chat Attachment",
        description:
          "Copy one visible image attachment into the selected repository using a repository-relative targetPath. Requires workspace write permission for this participant run.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            attachmentId: {
              type: "string",
              description: "Attachment id from app_chat_list_attachments or message metadata."
            },
            targetPath: {
              type: "string",
              description: "Repository-relative destination file path, for example screenshots/example.png. Absolute paths and traversal are rejected."
            },
            overwrite: {
              type: "boolean",
              description: "When true, replace an existing regular file. Existing symlinks and directories are always rejected."
            }
          },
          required: ["attachmentId", "targetPath"]
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_REACT_TOOL,
        title: "React To Chat Message",
        description:
          "Add or toggle an emoji reaction on a specific message. To react, call this with the message id from app_chat_read_messages and an allowed emoji.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            messageId: {
              type: "string",
              description: "Message id returned by app_chat_read_messages."
            },
            emoji: {
              type: "string",
              enum: [...CHAT_REACTION_EMOJIS],
              description: "Allowed reaction emoji."
            }
          },
          required: ["messageId", "emoji"]
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_SEND_MESSAGE_TOOL,
        title: "Send Chat Message",
        description:
          "Post a participant message authored by you IMMEDIATELY, so other participants and User can see and react to it before your turn ends, and return its messageId and sequence. Use this ONLY when you need a message visible mid-turn — for example to publish something others will react to during this same turn (a canonical resolution) and you need its messageId now. Do NOT use this for an ordinary answer or reply: your normal turn response is already shared with everyone when your turn ends, so sending it with this tool just duplicates it and leaves your turn with nothing to say. The returned messageId can be passed to app_chat_react. Optional image attachments are imported from sourcePath files inside the selected repository when this run has repoRead; v1 accepts only PNG, JPEG, and WebP images.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            content: {
              type: "string",
              description: "Message content. Must be non-empty after trimming unless attachments contains at least one image."
            },
            attachments: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              description: "Optional image attachments to import from files visible to this run. V1 accepts PNG, JPEG, and WebP only.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: {
                    type: "string",
                    enum: ["image"],
                    description: "Attachment kind. V1 supports image only."
                  },
                  sourcePath: {
                    type: "string",
                    description: "Absolute or repository-relative path to an image file inside the selected repository."
                  },
                  filename: {
                    type: "string",
                    description: "Optional display filename. The app normalizes the filename and extension."
                  },
                  mimeType: {
                    type: "string",
                    enum: ["image/png", "image/jpeg", "image/webp"],
                    description: "Optional expected MIME type. The app validates this against the image bytes."
                  }
                },
                required: ["kind", "sourcePath"]
              }
            },
            threadId: {
              type: "string",
              description: "Optional visible thread id to post into. Defaults to the active turn's thread."
            },
            parentMessageId: {
              type: "string",
              description: "Optional visible parent message id (e.g. User's original request). Must be visible to this turn."
            },
            chatThreadRootId: {
              type: "string",
              description: "Optional visible thread root message id. Must be visible to this turn."
            },
            accordResolution: {
              type: "object",
              additionalProperties: false,
              description: "Optional lightweight metadata for verification/debugging of an /accord resolution. Not an approval engine; the canonical approval is the ✅ reactor set.",
              properties: {
                version: { type: "integer", minimum: 1 },
                sourceMessageId: { type: "string" },
                selectedParticipantIds: { type: "array", items: { type: "string" } },
                requiredApproverIds: { type: "array", items: { type: "string" } },
                supersedesMessageId: { type: "string" },
                status: { type: "string" }
              }
            }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: APP_CHAT_SET_TITLE_TOOL,
        title: "Set Chat Title",
        description:
          "Set a concise title for this chat. Intended for the first eligible participant turn only; the backend validates eligibility, sanitizes the title, applies the first accepted title, and ignores later or ineligible calls.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: {
              type: "string",
              description: "Concise title based on the user's intent. Omit participant handles, slash commands, model/provider names, and generic words like Chat."
            }
          },
          required: ["title"]
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      }
    ];
    if (hasChatAppToolCapability(actor.capabilities, "participants.request")) {
      tools.push({
        name: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
        title: "Request Chat Participants",
        description:
          "Ask one or more current chat participants to respond to a concrete prompt. The app validates policy, may request User approval, runs approved participants, and either auto-resumes the requester or returns inline replies when requested.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            requests: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  target: {
                    type: "string",
                    description: "Target participant handle, with or without @."
                  },
                  prompt: {
                    type: "string",
                    description: "Concrete question or task for the target participant."
                  },
                  reason: {
                    type: "string",
                    description: "Optional brief reason this participant input is needed."
                  }
                },
                required: ["target", "prompt"]
              }
            },
            timeoutMs: {
              type: "integer",
              minimum: 1000,
              maximum: 300000,
              description: "Optional bounded wait for replies. Defaults to 120000ms."
            },
            resumeRequester: {
              type: "boolean",
              description: "Whether the app should return control in a fresh requester turn. Defaults to true and also applies when replies finish before timeout. Set false to receive completed replies inline."
            }
          },
          required: ["requests"]
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      });
    }
    if (hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
      tools.push({
        name: APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
        title: "Request Chat Permission Change",
        description:
          "Request a permission change for this chat participant, or pass a prior requestId to recover its status idempotently. Use portable for repoRead/workspaceWrite/webAccess, shellRules for command-specific shell rules, providerNative for Claude Code allowedTools tokens, or githubApp for GitHub App repository permissions. Provider-native grants are rejected unless the requester is a Claude Code participant. The app validates the request and may return already_granted (the capability is already available for this run) or pending_user_approval for User approval.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            requestId: {
              type: "string",
              description: "Stable permission request id returned by an earlier call. When present, the tool returns that request's current status instead of creating a new request."
            },
            kind: {
              type: "string",
              enum: ["portable", "shellRules", "providerNative", "githubApp"],
              description: "Permission request kind."
            },
            reason: {
              type: "string",
              description: "Brief reason the participant needs the requested permission."
            },
            permissions: {
              type: "array",
              minItems: 1,
              items: {
                type: "string"
              },
              description: "Portable grants repoRead/workspaceWrite/webAccess when kind is portable, or GitHub App permission tokens such as contents:write when kind is githubApp."
            },
            rules: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  action: {
                    type: "string",
                    enum: ["allow", "ask", "deny"]
                  },
                  match: {
                    type: "string",
                    enum: ["exact", "prefix"]
                  },
                  pattern: {
                    type: "string",
                    description: "Literal shell command pattern, such as git status or git diff."
                  }
                },
                required: ["action", "match", "pattern"]
              },
              description: "Command-specific shell rules to request when kind is shellRules."
            },
            provider: {
              type: "string",
              enum: ["claude-code"],
              description: "Provider for provider-native grants."
            },
            allowedTools: {
              type: "array",
              minItems: 1,
              items: {
                type: "string"
              },
              description: "Literal Claude Code allowedTools tokens to request when kind is providerNative."
            },
            repository_full_name: {
              type: "string",
              description: "GitHub repository full name, owner/repo, when kind is githubApp."
            }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      });
    }
    if (hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
      tools.push(
        {
          name: APP_ROLES_DESCRIBE_OPTIONS_TOOL,
          title: "Describe Chat Roles",
          description:
            "Return available AccordAgents chat roles, including built-in roles and custom roles. This is read-only.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {}
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        },
        {
          name: APP_ROLES_REQUEST_CHANGE_TOOL,
          title: "Request Role Change",
          description:
            "Request creation, editing, or deletion of AccordAgents chat roles. Roles are reusable definitions separate from participants. To delete a custom role, send type \"archive_role\" with role.roleConfigId; built-in roles cannot be deleted and a role still used by saved participants cannot be deleted.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reason: { type: "string" },
              operations: {
                type: "array",
                minItems: 1,
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: { type: "string", enum: ["create_role", "edit_role", "archive_role"] },
                    role: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        roleConfigId: { type: "string", description: "Required for edit_role and archive_role: the id of the existing role." },
                        draftRoleRef: {
                          type: "string",
                          description: "Temporary role reference for pending grouped-review create_role operations. Use it in a following participant request only when the role request response is pending_user_approval; auto_applied responses return a persisted roleConfigId instead."
                        },
                        label: { type: "string" },
                        instructions: { type: "string" },
                        participantDefaults: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            autoWatch: { type: "boolean" },
                            requestParticipants: {
                              type: "string",
                              enum: ["ask", "allow", "deny"]
                            },
                            manageRolesParticipants: {
                              type: "string",
                              enum: ["ask", "allow", "deny"]
                            }
                          },
                          description: "Default member behavior for participants using this role. manageRolesParticipants controls whether members with this role can manage roles and chat members."
                        }
                      }
                      // Per-type field requirements (create_role/edit_role need label+instructions;
                      // archive_role needs roleConfigId) are enforced by ChatService.normalizeRoleChangeRequest.
                    }
                  },
                  required: ["type", "role"]
                }
              }
            },
            required: ["operations"]
          },
          annotations: {
            readOnlyHint: false,
            // This tool only creates an AccordAgents approval card. Marking it
            // destructive can cause provider-side MCP confirmation to block before
            // the app approval exists; the eventual delete is gated in-app.
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
          }
        },
        {
          name: APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL,
          title: "Describe Chat Participants",
          description:
            "Return saved participant presets, current chat participants, available roles, CLI providers, model options, and validation rules. This is read-only.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {}
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        },
        {
          name: APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
          title: "Request Participant Change",
          description:
            "Request adding a new participant to the current chat, optionally saving it as a reusable preset, or adding an existing saved participant preset to the chat.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reason: { type: "string" },
              operations: {
                type: "array",
                minItems: 1,
                maxItems: 12,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: {
                      type: "string",
                      enum: ["add_new_participant_to_chat", "add_existing_participant_to_chat"]
                    },
                    saveAsPreset: { type: "boolean" },
                    participantConfigId: { type: "string" },
                    participant: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        handle: { type: "string" },
                        roleConfigId: { type: "string" },
                        kind: { type: "string", enum: ["codex-cli", "claude-code", "gemini-cli"] },
                        model: { type: "string" },
                        reasoningEffort: {
                          type: "string",
                          enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
                        },
                        avatarId: { type: "string" },
                        agentMode: { type: "string", enum: ["default", "plan", "auto"] },
                        permissions: CHAT_AGENT_PERMISSION_INPUT_SCHEMA
                      },
                      required: ["handle", "roleConfigId", "kind"]
                    }
                  },
                  required: ["type"]
                }
              }
            },
            required: ["operations"]
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
          }
        },
        {
          name: APP_ROSTER_DESCRIBE_OPTIONS_TOOL,
          title: "Describe Chat Roster Options",
          description:
            "Return the roles, CLI providers, configured models, current roster, and validation rules available for AccordAgents chat roster changes. This is read-only.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {}
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        },
        {
          name: APP_ROSTER_REQUEST_CHANGE_TOOL,
          title: "Request Chat Roster Change",
          description:
            "Request an AccordAgents chat roster change. The app validates the request and asks User to approve it unless this administrator is already trusted for roster changes in this chat.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reason: {
                type: "string",
                description: "Brief reason for the roster change."
              },
              operations: {
                type: "array",
                minItems: 1,
                maxItems: 12,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: {
                      type: "string",
                      enum: ["add"]
                    },
                    participant: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        handle: { type: "string" },
                        roleConfigId: { type: "string" },
                        kind: { type: "string", enum: ["codex-cli", "claude-code", "gemini-cli"] },
                        model: { type: "string" },
                        reasoningEffort: {
                          type: "string",
                          enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
                        },
                        avatarId: { type: "string" },
                        agentMode: { type: "string", enum: ["default", "plan", "auto"] },
                        permissions: CHAT_AGENT_PERMISSION_INPUT_SCHEMA
                      },
                      required: ["handle", "roleConfigId", "kind"]
                    }
                  },
                  required: ["type", "participant"]
                }
              }
            },
            required: ["operations"]
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
          }
        }
      );
    }
    return tools;
  }

  private async callTool(actor: AppMcpActor, params: unknown): Promise<unknown> {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("Tool call params are required.");
    }
    const record = params as { name?: unknown; arguments?: unknown };
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
      record.name !== APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL &&
      record.name !== APP_CHAT_GET_CONTEXT_TOOL &&
      record.name !== APP_CHAT_GET_PARTICIPANTS_TOOL &&
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
        throw new Error("This participant is not allowed to request tool permissions.");
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
        throw new Error("Chat participant discovery is not available.");
      }
      return this.toolTextResult(await this.chatParticipantsHandler(actor));
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
        throw new Error("This participant is not allowed to request other participants.");
      }
      if (!this.chatParticipantRequestHandler) {
        throw new Error("Chat participant request handling is not available.");
      }
      return this.toolTextResult(await this.chatParticipantRequestHandler(actor, record.arguments));
    }
    if (record.name === APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL) {
      if (!this.chatParticipantRequestStatusHandler) {
        throw new Error("Chat participant request status is not available.");
      }
      return this.toolTextResult(await this.chatParticipantRequestStatusHandler(actor, record.arguments));
    }
    if (record.name === APP_PERMISSIONS_REQUEST_CHANGE_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
        throw new Error("This participant is not allowed to request permission changes.");
      }
      if (!this.permissionChangeHandler) {
        throw new Error("Permission request handling is not available.");
      }
      return this.toolTextResult(await this.permissionChangeHandler(actor, record.arguments));
    }
    if (record.name === APP_ROSTER_DESCRIBE_OPTIONS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This participant is not allowed to manage chat participants.");
      }
      if (!this.rosterOptionsHandler) {
        throw new Error("Roster option discovery is not available.");
      }
      return this.toolTextResult(await this.rosterOptionsHandler(actor));
    }
    if (record.name === APP_ROLES_DESCRIBE_OPTIONS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This participant is not allowed to manage chat participants.");
      }
      if (!this.roleOptionsHandler) {
        throw new Error("Role option discovery is not available.");
      }
      return this.toolTextResult(await this.roleOptionsHandler(actor));
    }
    if (record.name === APP_ROLES_REQUEST_CHANGE_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This participant is not allowed to manage chat participants.");
      }
      if (!this.roleChangeHandler) {
        throw new Error("Role management is not available.");
      }
      return this.toolTextResult(await this.roleChangeHandler(actor, record.arguments));
    }
    if (record.name === APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This participant is not allowed to manage chat participants.");
      }
      if (!this.participantOptionsHandler) {
        throw new Error("Participant option discovery is not available.");
      }
      return this.toolTextResult(await this.participantOptionsHandler(actor));
    }
    if (record.name === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL) {
      if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
        throw new Error("This participant is not allowed to manage chat participants.");
      }
      if (!this.participantChangeHandler) {
        throw new Error("Participant management is not available.");
      }
      return this.toolTextResult(await this.participantChangeHandler(actor, record.arguments));
    }
    if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
      throw new Error("This participant is not allowed to manage chat participants.");
    }
    if (!this.rosterChangeHandler) {
      throw new Error("Roster management is not available.");
    }
    return this.toolTextResult(await this.rosterChangeHandler(actor, record.arguments));
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
