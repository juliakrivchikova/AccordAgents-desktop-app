/**
 * Canonical chat actions as events, and the projection that folds them.
 *
 * Messages already travel as events. Everything else a member or a device does
 * — revising an artifact, signing one, answering a permission, answering a
 * choice, opening or answering a participant request, asking for a Stop — is
 * an action on some target, and until now those lived only as metadata a
 * machine rewrote locally. Two machines that acted while disconnected simply
 * overwrote each other, and nobody was told.
 *
 * This uses the SAME envelope, ordering and gap handling as the conversation
 * projection (`orderVisibleChatEvents`); it is not a second protocol. What it
 * adds is the part the signed resolution calls out as new work:
 *
 *   - **Preconditions.** An action states what it expected to be true. Folded
 *     in total order, an action whose expectation no longer holds is not
 *     silently dropped: it is applied nowhere and reported as superseded, with
 *     the event that won.
 *   - **Immutable execution receipts.** A receipt records that something
 *     happened outside this process — a tool ran, a permission was answered to
 *     a provider, a file was written. Re-projection never repeats it and never
 *     erases it. A decision that sorts earlier than a receipt it contradicts is
 *     shown beside it as a conflict; the receipt stands, because the action
 *     really happened.
 *   - **Signatures bound to what was signed.** A signature names the revision
 *     id and content hash it was made on. When a competing revision wins the
 *     race, the signature stays attached to the revision it actually read and
 *     does not move to, or count toward, the winner.
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
  | "artifact.revision.created"
  | "artifact.signature.added"
  | "permission.decided"
  | "choice.answered"
  | "participant.request.opened"
  | "participant.request.answered"
  | "turn.stop.requested"
  | "execution.receipt";

export const CHAT_ACTION_KINDS: readonly ChatActionKind[] = [
  "artifact.revision.created",
  "artifact.signature.added",
  "permission.decided",
  "choice.answered",
  "participant.request.opened",
  "participant.request.answered",
  "turn.stop.requested",
  "execution.receipt"
];

/** What an action expected to be true when it was made. Absent means the
 *  action is unconditional (opening a request, asking for a Stop). */
export interface ChatActionPrecondition {
  /** The target's state id the author read: an artifact revision id, a
   *  decision revision, a request lifecycle state. */
  expectedStateId?: string;
  /** The exact content the author acted on, when content matters. */
  expectedContentHash?: string;
}

export interface ChatActionPayload {
  /** Idempotency key. The same operation folded twice changes nothing. */
  operationId: string;
  /** What is being acted on: `artifact:<id>`, `approval:<cardId>`,
   *  `choice:<messageId>`, `request:<id>`, `run:<runId>`. */
  targetKey: string;
  precondition?: ChatActionPrecondition;
  /** The state id this action establishes when it applies. */
  stateId?: string;
  contentHash?: string;
  /** The body this state is, when the action carries it. */
  revision?: ChatRevisionContent;
  /** Free-form action detail; the projection never interprets it beyond the
   *  fields above, so a new action kind does not need a new projection. */
  detail?: Record<string, unknown>;
}

/**
 * The immutable body a revision event carries, so a peer that does not hold the
 * revision can apply it instead of waiting for it forever.
 *
 * It travels as part of the event payload, which means it goes through the same
 * preparation, fragmentation and size limits as any other payload; a body large
 * enough becomes fragments the receiver assembles before the event is applied.
 * The hash is checked against the content before anything is stored, so a body
 * that does not match its identity is refused rather than written.
 */
export interface ChatRevisionContent {
  content: string;
  author: string;
  note?: string;
  createdAt: string;
  version: number;
  /** Enough to create the artifact on a peer that has never seen it. */
  artifact?: {
    name: string;
    owner: string;
    contributors: string[];
    requiredSigners: string[];
    labels: string[];
    createdAt: string;
  };
}

/** A signature binds to the revision it read, by id and by content hash. */
export interface ChatSignaturePayload extends ChatActionPayload {
  signer: string;
  signedStateId: string;
  signedContentHash: string;
}

/** Something that happened outside this process. Never superseded. */
export interface ChatExecutionReceiptPayload extends ChatActionPayload {
  /** What was executed, for the surface that shows it happened. */
  effect: string;
  /** The machine that performed it. */
  executedBy: string;
  executedAt: string;
  /** Set when the executor could not prove the effect completed. */
  uncertain?: boolean;
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

export interface ChatSignatureProjection {
  eventId: string;
  signer: string;
  signedStateId: string;
  signedContentHash: string;
  /** False when the revision this signature was made on lost the race. It
   *  stays bound to what it signed and never counts toward the winner. */
  countsTowardCurrent: boolean;
}

export interface ChatExecutionReceiptProjection extends ChatExecutionReceiptPayload {
  eventId: string;
}

/** A decision that contradicts an effect that already happened. */
export interface ChatReceiptConflict {
  targetKey: string;
  receiptEventId: string;
  conflictingEventId: string;
  detail: string;
}

export interface ChatActionTargetState {
  targetKey: string;
  stateId?: string;
  contentHash?: string;
  /** The event that established the current state. */
  stateEventId?: string;
  signatures: ChatSignatureProjection[];
  receipts: ChatExecutionReceiptProjection[];
}

export interface ChatActionFoldResult {
  targets: ChatActionTargetState[];
  applied: ChatActionApplied[];
  superseded: ChatActionSuperseded[];
  /** Events folded away because their operation had already been folded. */
  duplicates: string[];
  conflicts: ChatReceiptConflict[];
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
  const conflicts: ChatReceiptConflict[] = [];

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
    const target = targets.get(payload.targetKey) ?? {
      targetKey: payload.targetKey,
      signatures: [],
      receipts: []
    };
    targets.set(payload.targetKey, target);

    // A receipt is a fact, not a proposal: it is never checked against a
    // precondition and never superseded.
    if (kind === "execution.receipt" && isReceiptPayload(payload)) {
      target.receipts.push({ ...payload, eventId: event.eventId });
      applied.push({ eventId: event.eventId, kind, targetKey: payload.targetKey });
      continue;
    }

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
      // An action that lost the race can still contradict something that has
      // already been executed; the surface shows both.
      noteReceiptConflict(conflicts, target, event.eventId, kind);
      continue;
    }

    if (kind === "artifact.signature.added" && isSignaturePayload(payload)) {
      target.signatures.push({
        eventId: event.eventId,
        signer: payload.signer,
        signedStateId: payload.signedStateId,
        signedContentHash: payload.signedContentHash,
        countsTowardCurrent: target.stateId === payload.signedStateId && target.contentHash === payload.signedContentHash
      });
      applied.push({ eventId: event.eventId, kind, targetKey: payload.targetKey, stateId: payload.signedStateId });
      continue;
    }

    if (payload.stateId) {
      target.stateId = payload.stateId;
      target.contentHash = payload.contentHash;
      target.stateEventId = event.eventId;
      // A signature made on a revision that has just been replaced stays bound
      // to the content it read; it does not follow the target forward.
      for (const signature of target.signatures) {
        signature.countsTowardCurrent =
          signature.signedStateId === target.stateId && signature.signedContentHash === target.contentHash;
      }
    }
    noteReceiptConflict(conflicts, target, event.eventId, kind);
    applied.push({ eventId: event.eventId, kind, targetKey: payload.targetKey, stateId: payload.stateId });
  }

  return {
    targets: [...targets.values()].sort((left, right) => left.targetKey.localeCompare(right.targetKey)),
    applied,
    superseded,
    duplicates,
    conflicts,
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

/** A permission answered the other way, after the provider already acted on
 *  the first answer, is a visible conflict — never a reason to undo the act. */
function noteReceiptConflict(
  conflicts: ChatReceiptConflict[],
  target: ChatActionTargetState,
  eventId: string,
  kind: ChatActionKind
): void {
  if (kind !== "permission.decided" && kind !== "choice.answered") return;
  for (const receipt of target.receipts) {
    conflicts.push({
      targetKey: target.targetKey,
      receiptEventId: receipt.eventId,
      conflictingEventId: eventId,
      detail: `${receipt.effect} already happened on ${receipt.executedBy}; this answer cannot undo it.`
    });
  }
}

function isActionPayload(value: unknown): value is ChatActionPayload {
  const payload = value as Partial<ChatActionPayload> | undefined;
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload)
    && typeof payload.operationId === "string" && payload.operationId
    && typeof payload.targetKey === "string" && payload.targetKey);
}

function isSignaturePayload(value: ChatActionPayload): value is ChatSignaturePayload {
  const payload = value as Partial<ChatSignaturePayload>;
  return typeof payload.signer === "string" && typeof payload.signedStateId === "string"
    && typeof payload.signedContentHash === "string";
}

function isReceiptPayload(value: ChatActionPayload): value is ChatExecutionReceiptPayload {
  const payload = value as Partial<ChatExecutionReceiptPayload>;
  return typeof payload.effect === "string" && typeof payload.executedBy === "string"
    && typeof payload.executedAt === "string";
}
