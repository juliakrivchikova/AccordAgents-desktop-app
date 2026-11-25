import {
  codexApprovalCancellationResult, isCodexApprovalMethod, validateCodexApprovalCorrelation, type CodexApprovalCorrelation,
  type CodexServerRequestDelivery
} from "../../../codexApprovals";
import type { CodexAppServerPendingTurn } from "../types";
import { MAX_CLI_ERROR_CHARS } from "../../constants";
import { emitLiveOutput, errorText, truncateText } from "../../runs/outputText";
import { asRecord, stringField } from "../../runs/records";
import type { AppServerModules } from "./modules";

interface CodexAppServerPendingInboundRequest {
  id: string | number;
  key: string;
  method: string;
  controller: AbortController;
  turn: CodexAppServerPendingTurn;
  answered: boolean;
  correlation: CodexApprovalCorrelation;
}

/** What the app-server asks before it acts, answered through the chat. */
export class AppServerApprovals {
  readonly pendingInboundRequests = new Map<string, CodexAppServerPendingInboundRequest>();
  readonly pendingFileChangeSummaries = new Map<string, Array<Record<string, unknown>>>();

  constructor(private readonly server: Pick<AppServerModules, "connection" | "turns">) {}

  private inboundRequestKey(id: string | number): string {
    return `${typeof id}:${String(id)}`;
  }

  private itemCorrelationKey(thread: string, turn: string, item: string): string {
    return `${thread}:${turn}:${item}`;
  }

  private async finishPendingInboundRequest(
    request: CodexAppServerPendingInboundRequest,
    message: Record<string, unknown>): Promise<boolean> {
    const current = this.pendingInboundRequests.get(request.key);
    if (!current || current !== request || request.answered) {
      return false;
    }
    request.answered = true;
    this.pendingInboundRequests.delete(request.key);
    request.turn.outstandingServerRequestIds.delete(request.key);
    try {
      await this.server.connection.writeServerMessage(message);
    } finally {
      this.server.turns.resumePendingTurnTimer(request.turn);
    }
    return true;
  }

  private answerPendingInboundRequest(
    request: CodexAppServerPendingInboundRequest,
    result: unknown): Promise<boolean> {
    return this.finishPendingInboundRequest(request, { id: request.id, result });
  }

  private rejectPendingInboundRequest(
    request: CodexAppServerPendingInboundRequest,
    code: number,
    message: string): Promise<boolean> {
    return this.finishPendingInboundRequest(request, {
    id: request.id,
    error: { code, message: truncateText(message, MAX_CLI_ERROR_CHARS) }
  });
  }

  async cancelPendingInboundApprovals(turn: CodexAppServerPendingTurn, reason: string): Promise<void> {
    const requests = [...this.pendingInboundRequests.values()].filter((request) => request.turn === turn);
    const refusals: Array<Promise<boolean>> = [];
    for (const request of requests) {
      if (!isCodexApprovalMethod(request.method)) {
        continue;
      }
      request.controller.abort(new Error(reason));
      refusals.push(this.answerPendingInboundRequest(request, codexApprovalCancellationResult(request.method)));
    }
    const results = await Promise.allSettled(refusals);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more Codex approval refusal frames could not be written.");
    }
  }

  handleServerRequestResolved(record: Record<string, unknown>): boolean {
    if (stringField(record, "method") !== "serverRequest/resolved") {
      return false;
    }
    const params = asRecord(record.params);
    const notificationThreadId = stringField(params ?? {}, "threadId");
    const id = params && (typeof params.requestId === "string" || typeof params.requestId === "number")
      ? params.requestId
      : undefined;
    if (id === undefined || !notificationThreadId) {
      return true;
    }
    const request = this.pendingInboundRequests.get(this.inboundRequestKey(id));
    if (!request) {
      return true;
    }
    if (notificationThreadId !== request.correlation.threadId) {
      const message = `Ignored serverRequest/resolved for thread ${notificationThreadId}; request ${String(id)} belongs to ${request.correlation.threadId}.`;
      emitLiveOutput(request.turn.onOutput, "tool", `${message}\n`, undefined, {
        activityKind: "approval",
        activityStatus: "failed",
        activityDetail: message
      });
      return true;
    }
    this.pendingInboundRequests.delete(request.key);
    request.answered = true;
    request.turn.outstandingServerRequestIds.delete(request.key);
    request.controller.abort(new Error("Codex resolved this approval request before the user answered."));
    this.server.turns.resumePendingTurnTimer(request.turn);
    return true;
  }

  handleServerRequest(record: Record<string, unknown>): void {
    const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : undefined;
    const method = stringField(record, "method");
    if (id === undefined || !method) {
      return;
    }
    if (method === "currentTime/read") {
      void this.server.connection.writeServerMessage({ id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } })
        .catch((error) => this.server.turns.rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    if (!isCodexApprovalMethod(method)) {
      // Codex 0.146's account/read contract says managed authentication uses
      // the CLI's normal refresh-token flow; this callback belongs to clients
      // that supplied external chatgptAuthTokens through account/login/start.
      // AccordAgents never performs that login variant, so receiving it is
      // authentication-contract drift rather than a recoverable refresh ask.
      const message = method === "account/chatgptAuthTokens/refresh"
        ? "This app-server was launched with Codex CLI-managed authentication, but Codex requested a client-managed token refresh. AccordAgents did not supply external ChatGPT tokens; re-authenticate the Codex CLI and retry."
        : `AccordAgents does not support the Codex client request ${method}.`;
      emitLiveOutput(this.server.turns.pendingTurn?.onOutput, "tool", `${message}\n`, undefined, {
        activityKind: "status",
        activityStatus: "failed",
        activityDetail: message
      });
      void this.server.connection.writeServerMessage({ id, error: { code: method === "account/chatgptAuthTokens/refresh" ? -32001 : -32601, message } })
        .catch((error) => this.server.turns.rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    const turn = this.server.turns.pendingTurn;
    if (!turn?.onCodexServerRequest) {
      const message = "This Codex transport cannot present interactive approvals.";
      void this.server.connection.writeServerMessage({ id, error: { code: -32601, message } })
        .catch((error) => this.server.turns.rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    let correlation: CodexApprovalCorrelation;
    try {
      correlation = validateCodexApprovalCorrelation(method, record.params, turn.threadId, turn.turnId);
    } catch (error) {
      const message = errorText(error);
      void this.server.connection.writeServerMessage({ id, error: { code: -32602, message: truncateText(message, MAX_CLI_ERROR_CHARS) } })
        .catch((writeError) => this.server.turns.rejectPendingTurn(writeError instanceof Error ? writeError : new Error(String(writeError))));
      emitLiveOutput(turn.onOutput, "tool", `Rejected malformed Codex approval request: ${message}\n`, undefined, {
        activityKind: "approval",
        activityStatus: "failed",
        activityDetail: message
      });
      return;
    }
    if (!turn.turnId && correlation.turnId) turn.turnId = correlation.turnId;
    turn.acceptedByProvider = true;
    const key = this.inboundRequestKey(id);
    if (this.pendingInboundRequests.has(key)) {
      const message = `Codex reused an active JSON-RPC request id (${String(id)}).`;
      void this.server.connection.writeServerMessage({ id, error: { code: -32600, message } })
        .catch((error) => this.server.turns.rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    const controller = new AbortController();
    const request: CodexAppServerPendingInboundRequest = {
      id,
      key,
      method,
      controller,
      turn,
      answered: false,
      correlation
    };
    this.pendingInboundRequests.set(key, request);
    turn.outstandingServerRequestIds.add(key);
    this.server.turns.pausePendingTurnTimer(turn);
    let resolveDelivery!: (delivery: CodexServerRequestDelivery) => void;
    let rejectDelivery!: (error: Error) => void;
    const responseDelivered = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    void responseDelivered.catch(() => undefined);
    const correlatedParams = method === "item/fileChange/requestApproval" && correlation.turnId
      ? {
          ...(asRecord(record.params) ?? {}),
          fileChanges: this.pendingFileChangeSummaries.get(this.itemCorrelationKey(correlation.threadId, correlation.turnId, correlation.itemId))
        }
      : record.params;
    void turn.onCodexServerRequest({ id, method, params: correlatedParams, signal: controller.signal, responseDelivered })
      .then(async (result) => {
        try {
          const delivered = await this.answerPendingInboundRequest(request, result);
          if (!delivered) {
            throw new Error("The Codex approval request was resolved before this decision could be delivered.");
          }
          // The turn blocks on this request, so an answered request always
          // lands inside the running turn.
          resolveDelivery({ turnActive: true });
        } catch (error) {
          const deliveryError = error instanceof Error ? error : new Error(String(error));
          rejectDelivery(deliveryError);
          throw deliveryError;
        }
      })
      .catch((error) => {
        rejectDelivery(error instanceof Error ? error : new Error(String(error)));
        if (!this.pendingInboundRequests.has(key)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        return this.rejectPendingInboundRequest(request, -32000, message);
      })
      .catch((error) => this.server.turns.rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
  }

  handleFileChangePatchUpdated(record: Record<string, unknown>): boolean {
    if (stringField(record, "method") !== "item/fileChange/patchUpdated") return false;
    const params = asRecord(record.params);
    const notificationThreadId = stringField(params ?? {}, "threadId");
    const notificationTurnId = stringField(params ?? {}, "turnId");
    const itemId = stringField(params ?? {}, "itemId");
    const turn = this.server.turns.pendingTurn;
    if (
      !params || !notificationThreadId || !notificationTurnId || !itemId || !Array.isArray(params.changes) ||
      !turn || notificationThreadId !== turn.threadId || (turn.turnId && notificationTurnId !== turn.turnId)
    ) {
      return true;
    }
    if (!turn.turnId) turn.turnId = notificationTurnId;
    const summaries = params.changes.flatMap((value): Array<Record<string, unknown>> => {
      const change = asRecord(value);
      const pathValue = stringField(change ?? {}, "path");
      const kind = asRecord(change?.kind);
      const kindType = stringField(kind ?? {}, "type");
      if (!pathValue || (kindType !== "add" && kindType !== "delete" && kindType !== "update")) return [];
      return [{ path: pathValue, kind: { type: kindType } }];
    });
    if (summaries.length !== params.changes.length) {
      const message = "Ignored malformed item/fileChange/patchUpdated notification.";
      emitLiveOutput(turn.onOutput, "tool", `${message}\n`, undefined, {
        activityKind: "approval",
        activityStatus: "failed",
        activityDetail: message
      });
      return true;
    }
    this.pendingFileChangeSummaries.set(this.itemCorrelationKey(notificationThreadId, notificationTurnId, itemId), summaries);
    return true;
  }

  handleItemCompletedApprovalRetirement(record: Record<string, unknown>): boolean {
    if (stringField(record, "method") !== "item/completed") return false;
    const params = asRecord(record.params);
    const item = asRecord(params?.item);
    const notificationThreadId = stringField(params ?? {}, "threadId");
    const notificationTurnId = stringField(params ?? {}, "turnId");
    const itemId = stringField(item ?? {}, "id");
    if (!notificationThreadId || !notificationTurnId || !itemId) return true;
    for (const [requestKey, request] of this.pendingInboundRequests) {
      if (
        request.correlation.threadId !== notificationThreadId ||
        request.correlation.turnId !== notificationTurnId ||
        request.correlation.itemId !== itemId
      ) {
        continue;
      }
      this.pendingInboundRequests.delete(requestKey);
      request.answered = true;
      request.turn.outstandingServerRequestIds.delete(request.key);
      request.controller.abort(new Error("Codex completed the item before the approval was answered."));
      this.server.turns.resumePendingTurnTimer(request.turn);
    }
    this.pendingFileChangeSummaries.delete(this.itemCorrelationKey(notificationThreadId, notificationTurnId, itemId));
    return true;
  }
}
