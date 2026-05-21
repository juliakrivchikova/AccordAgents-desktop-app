import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatAppToolCapability } from "../../shared/types";
import { hasChatAppToolCapability } from "../../shared/appTools";

export const APP_ROSTER_REQUEST_CHANGE_TOOL = "app_roster_request_change";
export const APP_ROSTER_DESCRIBE_OPTIONS_TOOL = "app_roster_describe_options";
export const APP_PERMISSIONS_REQUEST_CHANGE_TOOL = "app_permissions_request_change";
export const APP_CHAT_REQUEST_PARTICIPANTS_TOOL = "app_chat_request_participants";
export const APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL = "app_chat_get_participant_request_status";
export const APP_CHAT_GET_CONTEXT_TOOL = "app_chat_get_context";
export const APP_CHAT_GET_PARTICIPANTS_TOOL = "app_chat_get_participants";
export const APP_CHAT_READ_MESSAGES_TOOL = "app_chat_read_messages";
export const APP_CHAT_LIST_ATTACHMENTS_TOOL = "app_chat_list_attachments";
export const APP_CHAT_READ_ATTACHMENT_TOOL = "app_chat_read_attachment";

export interface AppMcpActor {
  conversationId: string;
  participantId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  capabilities: ChatAppToolCapability[];
  triggerMessageId?: string;
  triggerThreadId?: string;
  triggerParentMessageId?: string;
  triggerChatThreadRootId?: string;
  snapshotMaxSequence?: number;
  continuation?: boolean;
  runId?: string;
  participantRequestDepth?: number;
  participantRequestBatchId?: string;
  historyMarkdownPath?: string;
  historyJsonPath?: string;
}

export interface AppMcpConnection {
  url: string;
  token: string;
}

export interface AppMcpTokenGrant extends AppMcpActor {}

type AppRosterChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppRosterOptionsHandler = (actor: AppMcpActor) => Promise<unknown>;
type AppPermissionChangeHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatContextHandler = (actor: AppMcpActor) => Promise<unknown>;
type AppChatParticipantsHandler = (actor: AppMcpActor) => Promise<unknown>;
type AppChatMessagesHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatAttachmentListHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatAttachmentReadHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatParticipantRequestHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;
type AppChatParticipantRequestStatusHandler = (actor: AppMcpActor, request: unknown) => Promise<unknown>;

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
  private rosterChangeHandler?: AppRosterChangeHandler;
  private rosterOptionsHandler?: AppRosterOptionsHandler;
  private permissionChangeHandler?: AppPermissionChangeHandler;
  private chatContextHandler?: AppChatContextHandler;
  private chatParticipantsHandler?: AppChatParticipantsHandler;
  private chatMessagesHandler?: AppChatMessagesHandler;
  private chatAttachmentListHandler?: AppChatAttachmentListHandler;
  private chatAttachmentReadHandler?: AppChatAttachmentReadHandler;
  private chatParticipantRequestHandler?: AppChatParticipantRequestHandler;
  private chatParticipantRequestStatusHandler?: AppChatParticipantRequestStatusHandler;

  setRosterChangeHandler(handler: AppRosterChangeHandler): void {
    this.rosterChangeHandler = handler;
  }

  setRosterOptionsHandler(handler: AppRosterOptionsHandler): void {
    this.rosterOptionsHandler = handler;
  }

  setPermissionChangeHandler(handler: AppPermissionChangeHandler): void {
    this.permissionChangeHandler = handler;
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

  setChatParticipantRequestHandler(handler: AppChatParticipantRequestHandler): void {
    this.chatParticipantRequestHandler = handler;
  }

  setChatParticipantRequestStatusHandler(handler: AppChatParticipantRequestStatusHandler): void {
    this.chatParticipantRequestStatusHandler = handler;
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
    this.tokens.set(token, this.actorFromGrant(grant));
    return { url: this.url, token };
  }

  updateToken(token: string, grant: AppMcpTokenGrant): AppMcpConnection | undefined {
    if (!this.url || !this.tokens.has(token)) {
      return undefined;
    }
    this.tokens.set(token, this.actorFromGrant(grant));
    return { url: this.url, token };
  }

  private actorFromGrant(grant: AppMcpTokenGrant): AppMcpActor {
    return {
      conversationId: grant.conversationId,
      participantId: grant.participantId,
      roleConfigId: grant.roleConfigId,
      roleConfigVersion: grant.roleConfigVersion,
      capabilities: [...grant.capabilities],
      triggerMessageId: grant.triggerMessageId,
      triggerThreadId: grant.triggerThreadId,
      triggerParentMessageId: grant.triggerParentMessageId,
      triggerChatThreadRootId: grant.triggerChatThreadRootId,
      snapshotMaxSequence: grant.snapshotMaxSequence,
      continuation: grant.continuation,
      runId: grant.runId,
      participantRequestDepth: grant.participantRequestDepth,
      participantRequestBatchId: grant.participantRequestBatchId,
      historyMarkdownPath: grant.historyMarkdownPath,
      historyJsonPath: grant.historyJsonPath
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
        return isNotification ? undefined : this.rpcResult(id, this.initializeResult());
      }
      if (method === "notifications/initialized") {
        return undefined;
      }
      if (method === "tools/list") {
        return isNotification ? undefined : this.rpcResult(id, { tools: this.toolsForActor(actor) });
      }
      if (method === "tools/call") {
        return isNotification ? undefined : this.rpcResult(id, await this.callTool(actor, request.params));
      }
      return isNotification ? undefined : this.rpcError(id, -32601, `Unsupported MCP method: ${method || "unknown"}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return isNotification ? undefined : this.rpcError(id, -32603, message);
    }
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
        name: "ai-consensus-app",
        version: "0.1.0"
      }
    };
  }

  private toolsForActor(actor: AppMcpActor): unknown[] {
    const tools: unknown[] = [
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
        name: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
        title: "Request Chat Participants",
        description:
          "Ask one or more current chat participants to respond to a concrete prompt. The app validates policy, may request User approval, runs approved participants, and can return replies if they finish before timeout.",
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
              description: "Whether the app should return control to the requester if replies arrive after this tool call returns. Defaults to true."
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
      }
    ];
    if (hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
      tools.push({
        name: APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
        title: "Request Chat Permission Change",
        description:
          "Request User approval to grant this chat participant more capability. Use portable for repoRead/workspaceWrite/webAccess, shellRules for command-specific shell rules, or providerNative for Claude Code allowedTools tokens. Provider-native grants are rejected unless the requester is a Claude Code participant. The app validates the request and shows an approval item; this tool never grants permissions directly.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: {
              type: "string",
              enum: ["portable", "shellRules", "providerNative"],
              description: "Permission request kind."
            },
            reason: {
              type: "string",
              description: "Brief reason the participant needs the requested permission."
            },
            permissions: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "string",
                enum: ["repoRead", "workspaceWrite", "webAccess"]
              },
              description: "Portable permission grants to request when kind is portable."
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
            }
          },
          required: ["kind"]
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
          name: APP_ROSTER_DESCRIBE_OPTIONS_TOOL,
          title: "Describe Chat Roster Options",
          description:
            "Return the roles, CLI providers, configured models, current roster, and validation rules available for AI Consensus chat roster changes. This is read-only.",
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
            "Request an AI Consensus chat roster change. The app validates the request and asks User to approve it unless this administrator is already trusted for roster changes in this chat.",
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
                        kind: { type: "string", enum: ["codex-cli", "claude-code"] },
                        model: { type: "string" },
                        avatarId: { type: "string" },
                        agentMode: { type: "string", enum: ["default", "plan", "auto"] },
                        permissions: { type: "object" }
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
      record.name !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
      record.name !== APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
      record.name !== APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL &&
      record.name !== APP_CHAT_GET_CONTEXT_TOOL &&
      record.name !== APP_CHAT_GET_PARTICIPANTS_TOOL &&
      record.name !== APP_CHAT_READ_MESSAGES_TOOL &&
      record.name !== APP_CHAT_LIST_ATTACHMENTS_TOOL &&
      record.name !== APP_CHAT_READ_ATTACHMENT_TOOL
    ) {
      throw new Error(`Unknown app tool: ${String(record.name ?? "")}.`);
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
    if (record.name === APP_CHAT_REQUEST_PARTICIPANTS_TOOL) {
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
