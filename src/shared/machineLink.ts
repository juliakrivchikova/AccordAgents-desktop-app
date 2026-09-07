/**
 * Machine link — sealed messages between a desktop and a machine that hosts
 * participants (machines transport, work items 3–5). Every message travels as
 * one sealed relay logical message (same sealing as the phone pairing) inside
 * the machine's own relay room, targeted with the room's device ids.
 *
 * This is the first, direct form of the contract in
 * docs/machines/02-event-contract.md: conversation state is replicated to the
 * machine as messages and settings snapshots, a turn is requested by id, and the
 * machine answers with progress and the finished participant messages.
 */

import type {
  ChatAppToolApprovalRequest, ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatMessage, ChatParticipant, Conversation, ReviewProgress } from "./types";
import type { MachineProgressFrame } from "./machineProgress";

export const MACHINE_LINK_PROTOCOL = "accord-machine-link-v1";

export interface MachineLinkEnvelope<Body = MachineLinkMessage> {
  protocol: typeof MACHINE_LINK_PROTOCOL;
  /** Unique per message; the receiver dedupes on it. */
  messageId: string;
  sentAt: string;
  body: Body;
}

/** Settings a machine needs to run a participant exactly like the desktop
 *  would: the same roles, rules, saved prompts, participant presets and
 *  environment variables. Secrets travel sealed and are stored with the
 *  machine's own secret store. */
export interface MachineSettingsSnapshot {
  version: 1;
  exportedAt: string;
  /** JSON of the desktop's stored settings with secrets removed. */
  settingsJson: string;
  agentEnvironment: Array<{ key: string; value: string }>;
}

export interface MachineHelloBody {
  idleStopWarning?: string;
  type: "machine.hello";
  deviceId: string;
  machineName: string;
  appVersion: string;
  platform: string;
  providers: Array<{ kind: string; installed: boolean; version?: string }>;
  /** Bound to deviceId; exchanged inside the enrolled sealed room. */
  publicKeyDerBase64?: string;
  /** Runs still executing on the machine (reconnect reconciliation). */
  activeRunIds?: string[];
  /** Finished runs whose result the desktop has not acknowledged yet. */
  pendingTerminalRunIds?: string[];
  /** Random id of this runtime process; changes when the machine restarts,
   *  so the desktop can tell a restart from a reconnect. */
  instanceId?: string;
  /** When this runtime process started; a hello from an older instance that
   *  arrives late is ignored by the desktop. */
  instanceStartedAt?: string;
  /** Monotonic start counter kept by the machine on disk; preferred over the
   *  wall-clock start time for ordering instances. Absent when the machine
   *  could not read or advance it reliably. */
  instanceSequence?: number;
  /** Set when the machine cannot keep its outbox on disk: results are held
   *  in memory only and would not survive a restart of the runtime. */
  outboxError?: string;
}

export interface MachineHelloAckBody {
  type: "machine.hello.ack";
  desktopDeviceId: string;
  appVersion: string;
  /** The desktop's record id for this machine: the value members carry as
   *  `homeMachineId`, so the runtime knows which members are its own. */
  machineId?: string;
}

export interface MachineSettingsSyncBody {
  type: "machine.settings.sync";
  snapshot: MachineSettingsSnapshot;
}

export interface MachineSettingsSealedBody {
  type: "machine.settings.sealed";
  /** Device settings stream, not a user's conversation. */
  conversationId: string;
  ciphertext: string;
}

/** Full copy of a conversation, sent once per machine and after any gap. */
export interface MachineConversationSyncBody {
  type: "machine.conversation.sync";
  conversation: Conversation;
}

/** Messages created or updated since the previous sync; the machine upserts
 *  them by id and replaces metadata when present. */
export interface MachineConversationDeltaBody {
  type: "machine.conversation.delta";
  conversationId: string;
  messages: ChatMessage[];
  metadata?: Conversation["metadata"];
  removedMessageIds?: string[];
  updatedAt: string;
}

export interface MachineTurnRequestBody {
  type: "machine.turn.request";
  conversationId: string;
  participantId: string;
  participant: ChatParticipant;
  messageId: string;
  runId: string;
  pendingMessageId: string;
  requestedAt: string;
  /** Sealed before entering the immutable log: environment values must not
   * become plaintext chat history or blob fragments on either endpoint. */
  sealedSettings?: string;
}

export interface MachineTurnCancelBody {
  type: "machine.turn.cancel";
  conversationId: string;
  runId: string;
}

export interface MachineTurnProgressBody {
  type: "machine.turn.progress";
  conversationId: string;
  runId: string;
  progress: ReviewProgress;
}

export interface MachineTurnStartedBody {
  type: "machine.turn.started";
  conversationId: string;
  runId: string;
  startedAt: string;
}

export interface MachineTurnFinishedBody {
  type: "machine.turn.finished";
  /** Identifies this immutable result, including native continuations of a run. */
  receiptId?: string;
  conversationId: string;
  runId: string;
  participantId: string;
  status: "completed" | "interrupted" | "failed";
  messages: ChatMessage[];
  warnings: string[];
  error?: string;
  finishedAt: string;
}

/** Conversation changes made on the machine while it hosts a turn (pending
 *  approval cards, participant requests, reactions). The desktop upserts them. */
export interface MachineConversationBackDeltaBody {
  type: "machine.conversation.backdelta";
  conversationId: string;
  messages: ChatMessage[];
  updatedAt: string;
}

/** An app-tool approval (permission, Codex approval, participant request)
 *  raised by a member on the machine; the desktop shows the same card. */
export interface MachineApprovalRequestedBody {
  type: "machine.approval.requested";
  conversationId: string;
  approval: ChatAppToolApproval;
}

/** The machine answered or timed out an approval; carries the machine's
 *  chat-wide policies so a "for this chat" grant reaches the desktop. */
export interface MachineApprovalUpdatedBody {
  type: "machine.approval.updated";
  conversationId: string;
  approval: ChatAppToolApproval;
  policies?: ChatAppToolApprovalPolicy[];
}

export interface MachineApprovalDecisionBody {
  type: "machine.approval.decision";
  decisionId?: string;
  conversationId: string;
  approvalId: string;
  approve: boolean;
  scope?: "once" | "chat";
  /** The card's edited proposal (Codex approvals) and native decision id,
   *  exactly as the desktop's own approval path receives them. */
  draftOverride?: ChatAppToolApprovalRequest;
  codexDecisionId?: string;
  decidedAt: string;
}

/** Machine -> desktop: outcome of applying a decision (the desktop's card
 *  call resolves or fails with it). */
export interface MachineApprovalResultBody {
  type: "machine.approval.result";
  decisionId?: string;
  uncertain?: boolean;
  conversationId: string;
  approvalId: string;
  ok: boolean;
  error?: string;
  /** The approval as the machine holds it after applying the decision, and
   *  the chat-wide policies; the desktop stores both before the card call
   *  returns. */
  approval?: ChatAppToolApproval;
  policies?: ChatAppToolApprovalPolicy[];
}

/** Desktop -> machine: a desktop that just connected asks the machine to
 *  greet it (hello), because a relay may seat a restarted desktop in place
 *  of the old one without telling the machine that anything changed. */
export interface MachineHelloRequestBody {
  type: "machine.hello.request";
  desktopDeviceId: string;
}

/** Desktop -> machine: does this runtime still hold this run (running, or a
 *  result waiting in its outbox)? Answered with machine.turn.unknown when
 *  not; silence otherwise (progress or the result follows). Sent after a
 *  hello for every turn the desktop still waits on, so lost turns are
 *  closed without guessing at process order. */
export interface MachineTurnQueryBody {
  type: "machine.turn.query";
  conversationId: string;
  runId: string;
}

/** Machine -> desktop: a stop (or any command) named a run this runtime does
 *  not know: it is not running here and no result is waiting. Whether its
 *  processes are gone is not verified (a restarted runtime does not know). */
export interface MachineTurnUnknownBody {
  type: "machine.turn.unknown";
  conversationId: string;
  runId: string;
}

/** Machine -> desktop: a batch of the first copy could not be stored; the
 *  desktop sends the whole copy again. */
export interface MachineConversationResyncBody {
  type: "machine.conversation.resync";
  conversationId: string;
}

/** Desktop -> machine: the first copy of a chat (shell plus every batch) has
 *  been sent in full; the machine may now compare its own rows against what
 *  the desktop holds. */
export interface MachineConversationSyncDoneBody {
  type: "machine.conversation.sync.done";
  conversationId: string;
}

/** Desktop -> machine: the finished turn has been applied on the desktop;
 *  the machine may drop it from its outbox. */
export interface MachineTurnFinishedAckBody {
  type: "machine.turn.finished.ack";
  conversationId: string;
  runId: string;
  receiptId?: string;
  finishedAt: string;
}

export interface MachineChoiceAnswerBody {
  type: "machine.choice.answer";
  conversationId: string;
  messageId: string;
  optionId: string;
  answeredAt: string;
}

/**
 * A member running on this machine asked other members to answer.
 *
 * Routing belongs to the desktop, which owns the roster: it runs each target
 * where that member lives — locally, or on the machine that member calls home
 * — and the answers reach this machine with the conversation like any other
 * message. A machine never runs a member that is not its own.
 */
export interface MachineParticipantsDelegateBody {
  type: "machine.participants.delegate";
  conversationId: string;
  requestMessageId: string;
  batchId: string;
  depth: number;
}

export type MachineLinkMessage =
  | MachineHelloBody
  | MachineHelloAckBody
  | MachineSettingsSyncBody
  | MachineSettingsSealedBody
  | MachineConversationSyncBody
  | MachineConversationDeltaBody
  | MachineTurnRequestBody
  | MachineTurnCancelBody
  | MachineTurnProgressBody
  | MachineProgressFrame
  | MachineTurnStartedBody
  | MachineTurnFinishedBody
  | MachineConversationBackDeltaBody
  | MachineApprovalRequestedBody
  | MachineApprovalUpdatedBody
  | MachineApprovalDecisionBody
  | MachineApprovalResultBody
  | MachineTurnFinishedAckBody
  | MachineTurnUnknownBody
  | MachineTurnQueryBody
  | MachineHelloRequestBody
  | MachineConversationSyncDoneBody
  | MachineConversationResyncBody
  | MachineParticipantsDelegateBody
  | MachineChoiceAnswerBody;

export type MachineLinkMessageType = MachineLinkMessage["type"];

export function isMachineReplicationMessage(body: MachineLinkMessage): boolean {
  return body.type === "machine.conversation.sync" || body.type === "machine.conversation.delta" ||
    body.type === "machine.conversation.sync.done" || body.type === "machine.conversation.backdelta";
}

export function isMachineDurableMessage(body: MachineLinkMessage): boolean {
  return isMachineReplicationMessage(body) || body.type === "machine.turn.finished" || body.type === "machine.turn.finished.ack" ||
    body.type === "machine.turn.request" || body.type === "machine.turn.cancel" || body.type === "machine.settings.sealed" || body.type === "machine.turn.started" ||
    body.type === "machine.approval.requested" || body.type === "machine.approval.updated" || body.type === "machine.approval.decision" || body.type === "machine.approval.result" ||
    body.type === "machine.turn.progress.delta" || body.type === "machine.participants.delegate";
}

export function machineCommandId(runId: string): string { return `machine-command:${runId}`; }
export function machineCommandTerminalId(runId: string): string { return `machine-terminal:${machineCommandId(runId)}`; }

const MESSAGE_TYPES: ReadonlySet<string> = new Set<MachineLinkMessageType>([
  "machine.hello",
  "machine.hello.ack",
  "machine.settings.sync",
  "machine.settings.sealed",
  "machine.conversation.sync",
  "machine.conversation.delta",
  "machine.turn.request",
  "machine.turn.cancel",
  "machine.turn.progress",
  "machine.turn.progress.delta",
  "machine.participants.delegate",
  "machine.turn.started",
  "machine.turn.finished",
  "machine.conversation.backdelta",
  "machine.approval.requested",
  "machine.approval.updated",
  "machine.approval.decision",
  "machine.approval.result",
  "machine.turn.finished.ack",
  "machine.turn.unknown",
  "machine.turn.query",
  "machine.hello.request",
  "machine.conversation.sync.done",
  "machine.conversation.resync",
  "machine.choice.answer"
]);

export function isMachineLinkEnvelope(value: unknown): value is MachineLinkEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<MachineLinkEnvelope>;
  return record.protocol === MACHINE_LINK_PROTOCOL &&
    typeof record.messageId === "string" &&
    record.messageId.trim().length > 0 &&
    typeof record.sentAt === "string" &&
    Boolean(record.body) &&
    typeof record.body === "object" &&
    typeof (record.body as { type?: unknown }).type === "string" &&
    MESSAGE_TYPES.has((record.body as { type: string }).type);
}

export interface MachineLinkStatus {
  machineId: string;
  name: string;
  connected: boolean;
  deviceId?: string;
  lastSeenAt?: string;
  lastHello?: MachineRecord["lastHello"];
  /** A condition on the machine the User should know about (for example an
   *  outbox that cannot be written). */
  warning?: string;
}

export interface MachineListResult {
  machines: MachineRecord[];
  status: MachineLinkStatus[];
}

export interface CreateMachineRequest {
  name: string;
}

export interface CreateMachineResult {
  machine: MachineRecord;
  /** The enrollment file contents for the machine runtime (`--enrollment`). */
  enrollmentJson: string;
}

export interface MachineEnrollmentRequest {
  id: string;
}

export interface RemoveMachineRequest {
  id: string;
}

/** An enrolled machine as the desktop stores it. The pairing package carries
 *  the relay room, the seal key, and the capability fingerprint. */
export interface MachineRecord {
  id: string;
  name: string;
  /** Relay device id of the machine (its chat-event origin id) once it has
   *  connected; empty until the first hello. */
  deviceId: string;
  pairingKey: string;
  createdAt: string;
  lastSeenAt?: string;
  lastHello?: Omit<MachineHelloBody, "type">;
  /** Stops requested while the machine was unreachable (Rule 2): kept until
   *  the machine confirms, across desktop restarts. */
  pendingCancels?: Array<{ runId: string; conversationId: string }>;
  /** Turns dispatched to the machine whose result has not been stored here
   *  yet: kept across desktop restarts, so a restarted desktop asks the
   *  machine about them instead of leaving their bubbles pending forever. */
  pendingRuns?: Array<{ runId: string; conversationId: string }>;
}
