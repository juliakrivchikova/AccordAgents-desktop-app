/**
 * Chat actions as durable events: what remains of them here are a member
 * request's lifecycle (opened, answered). Answers to the cards a member waits
 * on (permissions, choices, mentions) and Stop travel as operations on the
 * User's server (agreement Д9; ChatService answerServerCard, turn.stop), not
 * as chat actions; artifacts keep their own actions (artifactStateEvents).
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
  logger?(event: string, payload: Record<string, unknown>): void;
}

export const CHAT_ACTION_EVENT_PREFIX = "chat-action:";

export function chatActionEventId(operationId: string): string {
  return `${CHAT_ACTION_EVENT_PREFIX}${operationId}`;
}

/** The operation a chat action event was recorded under; undefined for any other event. */
export function chatActionOperationId(eventId: string): string | undefined {
  return eventId.startsWith(CHAT_ACTION_EVENT_PREFIX) ? eventId.slice(CHAT_ACTION_EVENT_PREFIX.length) : undefined;
}

export function participantRequestTarget(requestId: string): string {
  return `request:${requestId}`;
}

export class ChatActionEmitter {
  constructor(private readonly deps: ChatActionEmitterDeps) {}

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

  /** A failed local commit must stop the caller before it performs an effect.
   * Relay delivery is asynchronous; failure here means the durable decision
   * itself was not recorded, rather than an offline peer. */
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
      throw error;
    }
  }
}
