/**
 * Machines transport — event kinds and payloads (docs/machines/02-event-contract.md §3).
 *
 * Every chat action between devices and machines is one of these events in the
 * sealed `ChatEventEnvelope`. Payloads are deliberately small: bodies, attachments,
 * and context travel as content-addressed fragments (`blob.fragment`).
 */

import type { ChatEventEnvelope } from "./chatEvents";

export type MachineTurnStatus = "completed" | "interrupted" | "failed" | "uncertain";

export type NativeReceiptPhase = "started" | "completed";

export type NativeReceiptItemKind =
  | "command"
  | "fileChange"
  | "mcpToolCall"
  | "permissionAnswered"
  | "userInputAnswered"
  | "turn";

export const MACHINE_EVENT_KINDS = [
  "turn.requested",
  "turn.started",
  "turn.progress",
  "turn.finished",
  "turn.cancel.requested",
  "receipt.native",
  "permission.requested",
  "permission.decided",
  "choice.requested",
  "choice.answered",
  "request.created",
  "request.answered",
  "request.cancelled",
  "artifact.created",
  "artifact.revised",
  "artifact.published",
  "artifact.signed",
  "artifact.access.changed",
  "artifact.draft.saved",
  "artifact.draft.submitted",
  "artifact.draft.withdrawn",
  "blob.fragment",
  "ack",
  "sync.resend.requested"
] as const;

export type MachineEventKind = (typeof MACHINE_EVENT_KINDS)[number];

const MACHINE_EVENT_KIND_SET: ReadonlySet<string> = new Set(MACHINE_EVENT_KINDS);

export function isMachineEventKind(value: string): value is MachineEventKind {
  return MACHINE_EVENT_KIND_SET.has(value);
}

/** Ask the participant's home machine to run one turn for a user message
 *  (or to steer the running turn when `steerOfTurnId` is set). */
export interface TurnRequestedPayload {
  commandId: string;
  participantId: string;
  homeOriginId: string;
  messageId: string;
  steerOfTurnId?: string;
  requestedBy: string;
  requestedAt: string;
}

export interface TurnStartedPayload {
  turnId: string;
  commandId: string;
  participantId: string;
  executorGeneration: number;
  sessionId?: string;
  providerTurnId?: string;
  startedAt: string;
}

export interface TurnProgressActivity {
  itemId: string;
  label: string;
  status: "running" | "completed" | "failed";
  detail?: string;
}

/** Streamed progress; text deltas are coalesced by the emitter (≤ 100 ms).
 *  Activity rows that name a tool, an approval, or a terminal state are never
 *  dropped by coalescing. */
export interface TurnProgressPayload {
  turnId: string;
  participantId: string;
  seq: number;
  textDelta?: string;
  activity?: TurnProgressActivity[];
  emittedAt: string;
}

export interface TurnFinishedPayload {
  turnId: string;
  participantId: string;
  status: MachineTurnStatus;
  messageId?: string;
  content?: string;
  sessionId?: string;
  contextUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; contextWindow?: number };
  warnings?: string[];
  error?: string;
  finishedAt: string;
}

export interface TurnCancelRequestedPayload {
  commandId: string;
  turnId: string;
  participantId: string;
  requestedBy: string;
  requestedAt: string;
}

/** Immutable fact recorded by the machine that performed the native action.
 *  Never superseded; re-projection never repeats the action. */
export interface NativeReceiptPayload {
  turnId: string;
  participantId: string;
  executorGeneration: number;
  itemId: string;
  itemKind: NativeReceiptItemKind;
  phase: NativeReceiptPhase;
  outcome?: string;
  requestId?: string;
  recordedAt: string;
}

export interface PermissionRequestedPayload {
  requestId: string;
  turnId: string;
  participantId: string;
  executorGeneration: number;
  provider: "codex-cli" | "claude-code" | "gemini-cli";
  title: string;
  detail?: string;
  options: Array<{ id: string; label: string; scope?: string }>;
  expiresAt?: string;
  requestedAt: string;
}

export interface PermissionDecidedPayload {
  requestId: string;
  decisionRevision: number;
  optionId: string;
  decidedBy: string;
  decidedAt: string;
}

export interface ChoiceRequestedPayload {
  choiceId: string;
  participantId: string;
  turnId?: string;
  title?: string;
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  recommendedOptionId?: string;
  requestedAt: string;
}

export interface ChoiceAnsweredPayload {
  choiceId: string;
  optionId: string;
  answeredBy: string;
  answeredAt: string;
}

export interface ParticipantRequestLifecyclePayload {
  requestId: string;
  requesterParticipantId?: string;
  targetParticipantId?: string;
  prompt?: string;
  reason?: string;
  replyMessageId?: string;
  at: string;
}

export interface ArtifactVersionPayload {
  artifactId: string;
  /** Equals this event's id for created/revised/published; the immutable
   *  identity a signature binds to. */
  versionEventId: string;
  contentHash: string;
  contentBlobHash?: string;
  name?: string;
  note?: string;
  expectedHeadVersionEventId?: string;
  requiredSigners?: string[];
  author: string;
  at: string;
}

export interface ArtifactSignedPayload {
  artifactId: string;
  versionEventId: string;
  contentHash: string;
  signer: string;
  at: string;
}

export interface ArtifactAccessChangedPayload {
  artifactId: string;
  expectedHeadVersionEventId: string;
  contributors?: string[];
  requiredSigners?: string[];
  labels?: string[];
  archived?: boolean;
  at: string;
}

export interface ArtifactDraftPayload {
  artifactId: string;
  draftId: string;
  operationId: string;
  author: string;
  readers?: string[];
  contentBlobHash?: string;
  editRevision?: number;
  at: string;
}

export const BLOB_FRAGMENT_MAX_BYTES = 384 * 1024;

export interface BlobFragmentPayload {
  blobHash: string;
  index: number;
  total: number;
  /** base64 of at most BLOB_FRAGMENT_MAX_BYTES bytes. */
  bytesBase64: string;
  mediaType?: string;
}

/** Acknowledgement by one machine that it stored (and folded) an origin's
 *  events up to `upToOriginSeq` in `logScopeId`. Drives outbox retention. */
export interface AckPayload {
  forOriginId: string;
  logScopeId: string;
  upToOriginSeq: number;
  /** Outcome of precondition-bearing events in the acknowledged range, so the
   *  emitter can show "applied" or "superseded" on its own surface. */
  outcomes?: Array<{ eventId: string; outcome: "applied" | "superseded"; supersededBy?: string }>;
  ackedAt: string;
}

export interface SyncResendRequestedPayload {
  forOriginId: string;
  logScopeId: string;
  fromSeq: number;
  toSeq: number;
  requestedBy: string;
  requestedAt: string;
}

export interface MachineEventPayloadByKind {
  "turn.requested": TurnRequestedPayload;
  "turn.started": TurnStartedPayload;
  "turn.progress": TurnProgressPayload;
  "turn.finished": TurnFinishedPayload;
  "turn.cancel.requested": TurnCancelRequestedPayload;
  "receipt.native": NativeReceiptPayload;
  "permission.requested": PermissionRequestedPayload;
  "permission.decided": PermissionDecidedPayload;
  "choice.requested": ChoiceRequestedPayload;
  "choice.answered": ChoiceAnsweredPayload;
  "request.created": ParticipantRequestLifecyclePayload;
  "request.answered": ParticipantRequestLifecyclePayload;
  "request.cancelled": ParticipantRequestLifecyclePayload;
  "artifact.created": ArtifactVersionPayload;
  "artifact.revised": ArtifactVersionPayload;
  "artifact.published": ArtifactVersionPayload;
  "artifact.signed": ArtifactSignedPayload;
  "artifact.access.changed": ArtifactAccessChangedPayload;
  "artifact.draft.saved": ArtifactDraftPayload;
  "artifact.draft.submitted": ArtifactDraftPayload;
  "artifact.draft.withdrawn": ArtifactDraftPayload;
  "blob.fragment": BlobFragmentPayload;
  "ack": AckPayload;
  "sync.resend.requested": SyncResendRequestedPayload;
}

export type MachineEvent<Kind extends MachineEventKind = MachineEventKind> = ChatEventEnvelope<MachineEventPayloadByKind[Kind]> & {
  kind: Kind;
};

export function isMachineEvent(event: ChatEventEnvelope): event is MachineEvent {
  return isMachineEventKind(event.kind) && Boolean(event.payload) && typeof event.payload === "object";
}

export function machineEventOfKind<Kind extends MachineEventKind>(event: ChatEventEnvelope, kind: Kind): event is MachineEvent<Kind> {
  return event.kind === kind && Boolean(event.payload) && typeof event.payload === "object";
}

/** Events that carry a precondition and can therefore be superseded at apply
 *  time; everything else is append-only and commutative. */
export const PRECONDITION_EVENT_KINDS: ReadonlySet<MachineEventKind> = new Set<MachineEventKind>([
  "turn.requested",
  "permission.decided",
  "choice.answered",
  "request.answered",
  "request.cancelled",
  "artifact.revised",
  "artifact.published",
  "artifact.signed",
  "artifact.access.changed",
  "artifact.draft.saved",
  "artifact.draft.submitted",
  "artifact.draft.withdrawn"
]);

/** Events that are immutable facts and are never superseded. */
export const RECEIPT_EVENT_KINDS: ReadonlySet<MachineEventKind> = new Set<MachineEventKind>(["receipt.native"]);
