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

import type { ChatMessage, ChatParticipant, Conversation, ReviewProgress } from "./types";

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
  type: "machine.hello";
  deviceId: string;
  machineName: string;
  appVersion: string;
  platform: string;
  providers: Array<{ kind: string; installed: boolean; version?: string }>;
}

export interface MachineHelloAckBody {
  type: "machine.hello.ack";
  desktopDeviceId: string;
  appVersion: string;
}

export interface MachineSettingsSyncBody {
  type: "machine.settings.sync";
  snapshot: MachineSettingsSnapshot;
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

export interface MachineTurnFinishedBody {
  type: "machine.turn.finished";
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

export interface MachineApprovalDecisionBody {
  type: "machine.approval.decision";
  conversationId: string;
  messageId: string;
  decision: "approved" | "denied";
  scope?: string;
  decidedAt: string;
}

export interface MachineChoiceAnswerBody {
  type: "machine.choice.answer";
  conversationId: string;
  messageId: string;
  optionId: string;
  answeredAt: string;
}

export type MachineLinkMessage =
  | MachineHelloBody
  | MachineHelloAckBody
  | MachineSettingsSyncBody
  | MachineConversationSyncBody
  | MachineConversationDeltaBody
  | MachineTurnRequestBody
  | MachineTurnCancelBody
  | MachineTurnProgressBody
  | MachineTurnFinishedBody
  | MachineConversationBackDeltaBody
  | MachineApprovalDecisionBody
  | MachineChoiceAnswerBody;

export type MachineLinkMessageType = MachineLinkMessage["type"];

const MESSAGE_TYPES: ReadonlySet<string> = new Set<MachineLinkMessageType>([
  "machine.hello",
  "machine.hello.ack",
  "machine.settings.sync",
  "machine.conversation.sync",
  "machine.conversation.delta",
  "machine.turn.request",
  "machine.turn.cancel",
  "machine.turn.progress",
  "machine.turn.finished",
  "machine.conversation.backdelta",
  "machine.approval.decision",
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
}
