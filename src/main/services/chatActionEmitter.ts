/**
 * Turning what the User does into chat actions, and recording what actually
 * happened.
 *
 * Every control that answers something a member is waiting on - a permission
 * card, a user choice, a participant request, Stop - goes through here, so the
 * decision is a durable event before the native side is told about it, and so
 * the same decision arriving twice (a retry, a reconnect, a restart) does not
 * answer the provider twice.
 *
 * The once-only rule is per TARGET, not per operation. A card answered "allow"
 * and then "deny" from another device produces two decisions, and both stay
 * visible, but only the first is executed: the provider was already told, and
 * a second answer cannot un-tell it. `beginExecution` is the guard, and it is
 * durable, so it still holds after a restart.
 */

import type { ChatActionKind, ChatActionPayload } from "../../shared/chatActionEvents";

export interface ChatActionEmission {
  conversationId: string;
  kind: ChatActionKind;
  payload: ChatActionPayload;
}

export interface ChatActionEmitterDeps {
  /** Appends the event locally and queues it for every peer that holds the
   *  chat. Must be durable before it resolves. */
  publish(action: ChatActionEmission): Promise<void>;
  /** True when this event id is already in the log. */
  hasEvent(eventId: string): Promise<boolean>;
  /** Identifies the machine that performed an effect. */
  executedBy: string;
  now?(): string;
  logger?(event: string, payload: Record<string, unknown>): void;
}

export const CHAT_ACTION_EVENT_PREFIX = "chat-action:";

export function chatActionEventId(operationId: string): string {
  return `${CHAT_ACTION_EVENT_PREFIX}${operationId}`;
}

/** One receipt per target: the first effect on it is the one that happened. */
export function chatActionReceiptEventId(targetKey: string): string {
  return `${CHAT_ACTION_EVENT_PREFIX}receipt:${targetKey}`;
}

export function approvalTarget(approvalId: string): string {
  return `approval:${approvalId}`;
}

export function choiceTarget(choiceId: string): string {
  return `choice:${choiceId}`;
}

export function participantRequestTarget(requestId: string): string {
  return `request:${requestId}`;
}

export function runTarget(runId: string): string {
  return `run:${runId}`;
}

export class ChatActionEmitter {
  constructor(private readonly deps: ChatActionEmitterDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  /**
   * The User answered a permission card. Emitted before the provider is told,
   * so a crash between the two leaves the decision recorded rather than lost.
   */
  async permissionDecided(request: {
    conversationId: string;
    approvalId: string;
    approve: boolean;
    scope?: string;
    decisionId?: string;
  }): Promise<string> {
    const targetKey = approvalTarget(request.approvalId);
    const operationId = `permission:${request.approvalId}:${request.approve ? "allow" : "deny"}`;
    await this.emit({
      conversationId: request.conversationId,
      kind: "permission.decided",
      payload: {
        operationId,
        targetKey,
        stateId: request.approve ? "approved" : "denied",
        detail: {
          approve: request.approve,
          ...(request.scope ? { scope: request.scope } : {}),
          ...(request.decisionId ? { decisionId: request.decisionId } : {})
        }
      }
    });
    return targetKey;
  }

  async choiceAnswered(request: {
    conversationId: string;
    choiceId: string;
    sourceMessageId: string;
    selectedOptionId?: string;
    customAnswer?: string;
    cancel?: boolean;
  }): Promise<string> {
    const targetKey = choiceTarget(request.choiceId);
    const answer = request.cancel
      ? "cancelled"
      : request.selectedOptionId ?? (request.customAnswer ? "custom" : "empty");
    await this.emit({
      conversationId: request.conversationId,
      kind: "choice.answered",
      payload: {
        operationId: `choice:${request.choiceId}:${answer}`,
        targetKey,
        stateId: answer,
        detail: {
          sourceMessageId: request.sourceMessageId,
          ...(request.selectedOptionId ? { selectedOptionId: request.selectedOptionId } : {}),
          ...(request.customAnswer ? { hasCustomAnswer: true } : {}),
          ...(request.cancel ? { cancel: true } : {})
        }
      }
    });
    return targetKey;
  }

  async participantRequestOpened(request: {
    conversationId: string;
    requestId: string;
    from: string;
    to: string;
  }): Promise<string> {
    const targetKey = participantRequestTarget(request.requestId);
    await this.emit({
      conversationId: request.conversationId,
      kind: "participant.request.opened",
      payload: {
        operationId: `request:${request.requestId}:opened`,
        targetKey,
        stateId: "open",
        detail: { from: request.from, to: request.to }
      }
    });
    return targetKey;
  }

  async participantRequestAnswered(request: {
    conversationId: string;
    requestId: string;
    by: string;
  }): Promise<string> {
    const targetKey = participantRequestTarget(request.requestId);
    await this.emit({
      conversationId: request.conversationId,
      kind: "participant.request.answered",
      payload: {
        operationId: `request:${request.requestId}:answered`,
        targetKey,
        stateId: "answered",
        // The request must have been open here; a peer that never saw it
        // opened folds this as superseded instead of inventing the request.
        precondition: { expectedStateId: "open" },
        detail: { by: request.by }
      }
    });
    return targetKey;
  }

  /** Stop is unconditional: it never waits on a precondition, because a
   *  request to stop is valid whatever state the run is believed to be in. */
  async stopRequested(request: { conversationId: string; runId: string; by?: string }): Promise<string> {
    const targetKey = runTarget(request.runId);
    await this.emit({
      conversationId: request.conversationId,
      kind: "turn.stop.requested",
      payload: {
        operationId: `stop:${request.runId}`,
        targetKey,
        stateId: "stop-requested",
        detail: request.by ? { by: request.by } : {}
      }
    });
    return targetKey;
  }

  /**
   * Claims the right to perform the external effect for a target.
   *
   * Returns false when a receipt for that target is already in the log: the
   * provider has been told, and the caller must not tell it again. Durable, so
   * a restart between the decision and the effect does not answer twice.
   */
  async beginExecution(targetKey: string): Promise<boolean> {
    const already = await this.deps.hasEvent(chatActionReceiptEventId(targetKey));
    if (already) {
      this.deps.logger?.("chat.action.execution-skipped", { targetKey });
      return false;
    }
    return true;
  }

  /**
   * Records that the effect happened. Immutable: re-projection never repeats
   * it, and a later contradicting decision is shown beside it.
   *
   * `uncertain` is for the case the executor could not prove it completed —
   * reported as such, never as success and never as "did not happen".
   */
  async recordExecution(request: {
    conversationId: string;
    targetKey: string;
    effect: string;
    uncertain?: boolean;
  }): Promise<void> {
    await this.emit({
      conversationId: request.conversationId,
      kind: "execution.receipt",
      payload: {
        operationId: `receipt:${request.targetKey}`,
        targetKey: request.targetKey,
        effect: request.effect,
        executedBy: this.deps.executedBy,
        executedAt: this.now(),
        ...(request.uncertain ? { uncertain: true } : {})
      } as ChatActionPayload
    });
  }

  /** A publish failure is reported and never undoes what the User did. */
  private async emit(action: ChatActionEmission): Promise<void> {
    try {
      await this.deps.publish(action);
    } catch (error) {
      this.deps.logger?.("chat.action.emit-failed", {
        conversationId: action.conversationId,
        kind: action.kind,
        targetKey: action.payload.targetKey,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
