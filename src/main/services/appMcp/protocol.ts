import http from "node:http";
import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../shared/agentPermissions";
import {
  APP_TOOL_PERMISSION_TOOL, APP_CONNECTOR_SIGN_IN_TOOL, appMcpToolDefinitionsForCapabilities
} from "../../../shared/appMcpToolContracts";
import { MAX_MCP_BODY_BYTES, MCP_PROTOCOL_VERSION } from "./constants";
import type { AppMcpActor, AppMcpClientState, AppMcpClientStatus, AppMcpTokenGrant, JsonRpcRequest, JsonRpcResponse } from "./types";

export function actorFromGrant(grant: AppMcpTokenGrant): AppMcpActor {
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

export function missingToolNames(expectedToolNames: string[], listedToolNames: Set<string> | string[] | undefined): string[] {
  const listed = listedToolNames instanceof Set ? listedToolNames : new Set(listedToolNames ?? []);
  return expectedToolNames.filter((toolName) => !listed.has(toolName));
}

export function publicClientStatus(state: AppMcpClientState): AppMcpClientStatus {
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

export function initializeResult(): unknown {
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

export function toolsForActor(actor: AppMcpActor): unknown[] {
  return appMcpToolDefinitionsForCapabilities(actor.capabilities);
}

export function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
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

export function rpcResult(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: unknown, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

/** A call of a tool that waits for the User (a sign-in card, Claude
 *  Code's permission prompt). */
export function isWaitingToolCall(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const request = payload as JsonRpcRequest;
  const params = request.params && typeof request.params === "object" ? request.params as { name?: unknown } : undefined;
  return request.method === "tools/call" && request.id !== undefined &&
    (params?.name === APP_CONNECTOR_SIGN_IN_TOOL || params?.name === APP_TOOL_PERMISSION_TOOL);
}

export function writeJson(response: http.ServerResponse, payload: unknown): void {
  writeHttp(response, 200, "application/json", JSON.stringify(payload));
}

export function writeHttp(response: http.ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(body);
}
