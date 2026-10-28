/**
 * Canonical chat actions as events, and the projection that folds them.
 *
 * Messages already travel as events. A participant request's lifecycle
 * (opened, answered) is an action on its target, and until now it lived only
 * as metadata a machine rewrote locally. Two machines that acted while
 * disconnected simply overwrote each other, and nobody was told. (Documents,
 * answers to the cards a member waits on — permissions, choices, mentions —
 * and Stop are not chat actions any more: they are operations on the User's
 * server, which owns them and decides every change, agreement Д9. Nor does a
 * receipt of an execution travel as one: the device that applied an answer
 * settles its card on the server.)
 *
 * This uses the SAME envelope, ordering and gap handling as the conversation
 * projection (`orderVisibleChatEvents`); it is not a second protocol. What it
 * adds is the part the signed resolution calls out as new work:
 *
 *   - **Preconditions.** An action states what it expected to be true. Folded
 *     in total order, an action whose expectation no longer holds is not
 *     silently dropped: it is applied nowhere and reported as superseded, with
 *     the event that won.
 *
 * Idempotency is by `operationId`: the same operation arriving twice is folded
 * once and reported as a duplicate, never as a conflict.
 */

import type { ChatEventEnvelope } from "./chatEvents";
import {
  orderVisibleChatEvents,
  type ChatConversationFoldOptions,
  type ChatEventForkConflict,
  type ChatEventVisibleScopeGap
} from "./chatEventProjection";

/** The log scope canonical actions are appended to. One scope, so gap repair
 *  and ordering treat every action of an origin as one contiguous run. */
export const CHAT_ACTION_LOG_SCOPE = "chat:actions";

export type ChatActionKind =
  | "participant.request.opened"
  | "participant.request.answered";

export const CHAT_ACTION_KINDS: readonly ChatActionKind[] = [
  "participant.request.opened",
  "participant.request.answered"
];

/** What an action expected to be true when it was made. Absent means the
 *  action is unconditional (opening a request). */
export interface ChatActionPrecondition {
  /** The target's state id the author read: a decision revision, a request
   *  lifecycle state. */
  expectedStateId?: string;
  /** The exact content the author acted on, when content matters. */
  expectedContentHash?: string;
}

export interface ChatActionPayload {
  /** Idempotency key. The same operation folded twice changes nothing. */
  operationId: string;
  /** What is being acted on: `request:<id>`. */
  targetKey: string;
  precondition?: ChatActionPrecondition;
  /** The state id this action establishes when it applies. */
  stateId?: string;
  contentHash?: string;
  /** Free-form action detail; the projection never interprets it beyond the
   *  fields above, so a new action kind does not need a new projection. */
  detail?: Record<string, unknown>;
}

export type ChatActionEventEnvelope = ChatEventEnvelope<ChatActionPayload> & { kind: ChatActionKind };

export interface ChatActionApplied {
  eventId: string;
  kind: ChatActionKind;
  targetKey: string;
  stateId?: string;
}

export type ChatActionSupersedeReason =
  | "state-changed"
  | "content-changed";

export interface ChatActionSuperseded {
  eventId: string;
  kind: ChatActionKind;
  targetKey: string;
  reason: ChatActionSupersedeReason;
  /** The event that held the target when this one was evaluated. */
  supersededBy?: string;
  /** What the author expected, so the surface can say why. */
  expectedStateId?: string;
  actualStateId?: string;
}

export interface ChatActionTargetState {
  targetKey: string;
  stateId?: string;
  contentHash?: string;
  /** The event that established the current state. */
  stateEventId?: string;
}

export interface ChatActionFoldResult {
  targets: ChatActionTargetState[];
  applied: ChatActionApplied[];
  superseded: ChatActionSuperseded[];
  /** Events folded away because their operation had already been folded. */
  duplicates: string[];
  gaps: ChatEventVisibleScopeGap[];
  forks: ChatEventForkConflict[];
}

export function isChatActionKind(kind: string): kind is ChatActionKind {
  return (CHAT_ACTION_KINDS as readonly string[]).includes(kind);
}

/**
 * Folds action events into per-target state. Every peer that holds the same
 * events produces the same result, including the same supersede marks, because
 * the order and the precondition rules are the same everywhere.
 */
export function foldChatActionEvents(
  events: ChatEventEnvelope[],
  options: ChatConversationFoldOptions = {}
): ChatActionFoldResult {
  const ordered = orderVisibleChatEvents(events.filter((event) => isChatActionKind(event.kind)), options);
  const targets = new Map<string, ChatActionTargetState>();
  const seenOperations = new Set<string>();
  const applied: ChatActionApplied[] = [];
  const superseded: ChatActionSuperseded[] = [];
  const duplicates: string[] = [];

  for (const event of ordered.events) {
    const payload = event.payload as ChatActionPayload | undefined;
    if (!isActionPayload(payload)) continue;
    const kind = event.kind as ChatActionKind;
    const operationKey = `${payload.targetKey}\0${payload.operationId}`;
    if (seenOperations.has(operationKey)) {
      duplicates.push(event.eventId);
      continue;
    }
    seenOperations.add(operationKey);
    const target: ChatActionTargetState = targets.get(payload.targetKey) ?? { targetKey: payload.targetKey };
    targets.set(payload.targetKey, target);

    const mismatch = precondition(target, payload);
    if (mismatch) {
      superseded.push({
        eventId: event.eventId,
        kind,
        targetKey: payload.targetKey,
        reason: mismatch,
        supersededBy: target.stateEventId,
        expectedStateId: payload.precondition?.expectedStateId,
        actualStateId: target.stateId
      });
      continue;
    }

    if (payload.stateId) {
      target.stateId = payload.stateId;
      target.contentHash = payload.contentHash;
      target.stateEventId = event.eventId;
    }
    applied.push({ eventId: event.eventId, kind, targetKey: payload.targetKey, stateId: payload.stateId });
  }

  return {
    targets: [...targets.values()].sort((left, right) => left.targetKey.localeCompare(right.targetKey)),
    applied,
    superseded,
    duplicates,
    gaps: ordered.gaps,
    forks: ordered.forks
  };
}

function precondition(
  target: ChatActionTargetState,
  payload: ChatActionPayload
): ChatActionSupersedeReason | undefined {
  const expected = payload.precondition;
  if (!expected) return undefined;
  if (expected.expectedStateId !== undefined && expected.expectedStateId !== (target.stateId ?? "")) {
    return "state-changed";
  }
  if (expected.expectedContentHash !== undefined && expected.expectedContentHash !== (target.contentHash ?? "")) {
    return "content-changed";
  }
  return undefined;
}

function isActionPayload(value: unknown): value is ChatActionPayload {
  const payload = value as Partial<ChatActionPayload> | undefined;
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload)
    && typeof payload.operationId === "string" && payload.operationId
    && typeof payload.targetKey === "string" && payload.targetKey);
}
