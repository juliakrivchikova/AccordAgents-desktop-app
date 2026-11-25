import type { ChatAgentMode, ChatAgentPermissions, ChatAppToolCapability } from "../../../shared/types";

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

export interface AppMcpClientState extends AppMcpClientStatus {
  expectedToolNames: string[];
  listedToolNames: string[];
}

export interface AppMcpDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

/** A scheduled script's run, identified by its per-run script token. */
export interface ScriptApiContext {
  scriptId: string;
  runId: string;
}

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}
