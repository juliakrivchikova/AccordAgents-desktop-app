import type { ChatCodexApprovalRequest } from "../../../shared/types";

/**
 * What the runner knew when Codex acknowledged a decision. A Guardian denial
 * does not block the provider turn: Codex injects a decision into the turn
 * that raised it when that turn is still running (`inject_no_new_turn`), and
 * only records it in the thread history when the turn has already ended.
 */
export interface CodexServerRequestDelivery {
  turnActive: boolean;
}

export interface CodexInboundServerRequest {
  id: string | number;
  method: string;
  params: unknown;
  signal: AbortSignal;
  responseDelivered: Promise<CodexServerRequestDelivery>;
}

export interface CodexApprovalCorrelation {
  threadId: string;
  turnId?: string;
  itemId: string;
  approvalId?: string;
}

export interface PreparedCodexApproval {
  request: ChatCodexApprovalRequest;
  responseByOptionId: ReadonlyMap<string, unknown>;
}
