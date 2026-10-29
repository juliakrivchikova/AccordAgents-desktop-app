/**
 * Machine link: live, unstored control between a computer and a cloud machine
 * it set up, in that machine's room on the User's server. Nothing here is
 * durable and nothing here is chat content: chats, members' turns, Stops,
 * compactions and settings are the User's server's (agreements Д1, Д4, Д9),
 * which every device reads and writes alike. The room carries only what
 * matters while both ends are there: the machine's greeting and status,
 * its scheduled scripts, a picture a member reads, background-task labels,
 * next-prompt suggestions and live progress for the computer's window.
 *
 * Every message is signed by its sender and sealed for its one recipient
 * (machineControlAuthentication, machineChannelSealing).
 */

import type { ChatMessage } from "./types";
import type { MachineProgressFrame } from "./machineProgress";
import type { TrustedDeviceRecord } from "./machineTrust";

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
 *  environment variables. Published by the computer on the User's server,
 *  sealed for that machine alone; stored with the machine's own secret store. */
export interface MachineSettingsSnapshot {
  version: 1;
  exportedAt: string;
  /** JSON of the desktop's stored settings with secrets removed. */
  settingsJson: string;
  agentEnvironment: Array<{ key: string; value: string }>;
}

/** What the computer publishes for one machine on the User's server, sealed
 *  for that machine alone (the server never opens it). */
export interface MachineSettingsDocument {
  version: 1;
  settings: MachineSettingsSnapshot;
  /** Where each of the computer's projects lives on this machine, by the
   *  computer's path: the folder a member here works in for a chat whose
   *  project is that path. */
  projects: Record<string, string>;
}

export function isMachineSettingsDocument(value: unknown): value is MachineSettingsDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<MachineSettingsDocument>;
  return document.version === 1 && Boolean(document.settings) && typeof document.settings === "object" &&
    Boolean(document.projects) && typeof document.projects === "object" && !Array.isArray(document.projects) &&
    Object.entries(document.projects as Record<string, unknown>).every(([source, local]) => typeof source === "string" && typeof local === "string" && local.startsWith("/"));
}

export interface MachineHelloBody {
  idleStopWarning?: string;
  /** The User's automatic-stop switch as the machine has it; absent from
   *  runtimes before 1.11.1, which always stop when idle. */
  autoStopEnabled?: boolean;
  type: "machine.hello";
  deviceId: string;
  machineName: string;
  appVersion: string;
  platform: string;
  providers: Array<{ kind: string; installed: boolean; version?: string }>;
  /** Bound to deviceId; exchanged inside the enrolled sealed room. */
  publicKeyDerBase64?: string;
  /** Runs executing on the machine now (an update waits for none). */
  activeRunIds?: string[];
  /** Random id of this runtime process; changes when the machine restarts,
   *  so the desktop can tell a restart from a reconnect. */
  instanceId?: string;
  /** When this runtime process started. */
  instanceStartedAt?: string;
  /** Monotonic start counter kept by the machine on disk; a hello from an
   *  older instance that arrives late is ignored by the desktop. Absent when
   *  the machine could not read or advance it reliably. */
  instanceSequence?: number;
  /** What this machine wrote that the User's server has not taken yet (a
   *  reply, a turn's end), and why it has not: shown on the desktop. */
  unsentWarning?: string;
  /** This runtime hosts scheduled scripts (absent before scripts existed). */
  scriptsSupported?: boolean;
  /** An enabled scheduled script keeps this machine from stopping when idle.
   *  Not a run: the desktop's update gate does not wait on it. */
  keepAwake?: boolean;
  /** How many switched-on scripts keep it awake ("Kept on by 2 scheduled scripts"). */
  keepAwakeScripts?: number;
}

export interface MachineHelloAckBody {
  type: "machine.hello.ack";
  desktopDeviceId: string;
  appVersion: string;
  /** The desktop's record id for this machine (the roster on the User's
   *  server says the same: it is what decides which members are its own). */
  machineId?: string;
  /** The name the User gave this machine on the desktop, so what the machine
   *  writes about itself (a script card's "Runs on") uses the same name. */
  machineName?: string;
}

/** The outcome line a compaction of `runId` wrote for this member. */
export function isMachineCompactionLine(message: ChatMessage | undefined, runId: string, participantId: string): boolean {
  return Boolean(message) && typeof message!.id === "string" && message!.role === "system" &&
    message!.metadata?.runId === runId && message!.metadata?.compaction?.participantId === participantId;
}

/** Desktop -> machine: a desktop that just connected asks the machine to
 *  greet it (hello), because the server may seat a restarted desktop in place
 *  of the old one without telling the machine that anything changed. */
export interface MachineHelloRequestBody {
  type: "machine.hello.request";
  desktopDeviceId: string;
}

/** Desktop -> machine: take no new turns from the User's server for now (its
 *  runtime is about to be replaced); turns asked meanwhile wait there for the
 *  runtime that takes them. Lapses by itself at `until`, so a desktop that went
 *  away never leaves the machine idle; sent again while it holds. */
export interface MachineTurnsHoldBody {
  type: "machine.turns.hold";
  reason: string;
  until: string;
}

/** Desktop -> machine: the hold is over; take the turns that waited. */
export interface MachineTurnsReleaseBody {
  type: "machine.turns.release";
}

/** Machine -> desktop: the bytes of a picture this chat carries.
 *
 *  The server's copy of a chat carries an attachment's metadata; a picture
 *  attached on the computer stays there (one the phone sent is a blob on the
 *  server, read from it). Fetched on demand rather than with the chat: a
 *  chat's pictures are far larger than its text and a member usually needs
 *  none of them. */
export interface MachineAttachmentRequestBody {
  type: "machine.attachment.request";
  requestId: string;
  conversationId: string;
  attachmentId: string;
}

/** Desktop -> machine: the answer to one machine.attachment.request. `ok`
 *  false carries why, so the member is told the picture is unavailable rather
 *  than waiting for bytes that will never come. */
export interface MachineAttachmentResultBody {
  type: "machine.attachment.result";
  requestId: string;
  conversationId: string;
  attachmentId: string;
  ok: boolean;
  /** Base64 of this part of the file, present only when ok. */
  dataBase64?: string;
  /** Which part this is, 0-based, and how many the picture has: one frame in
   *  the server's rooms is bounded. Absent on a refusal. */
  part?: number;
  parts?: number;
  mediaType?: string;
  fileName?: string;
  error?: string;
}

/** Raw bytes per machine.attachment.result part: ~2.8 MiB once base64-encoded
 *  and sealed, under the 4 MiB limit of a frame in the server's rooms, and short
 *  enough that the link's other traffic is not held behind one picture. */
export const MACHINE_ATTACHMENT_PART_BYTES = 1_572_864;

/** A member hosted on this machine started or ended background work (Claude
 *  Code `run_in_background`); the full current list, empty when none is left.
 *  Live only, like the CLI's own status line: sent on every change, with a
 *  full list after each hello (see the snapshot below), and dropped by the
 *  desktop when the machine goes away. */
export interface MachineMemberBackgroundBody {
  type: "machine.member.background";
  conversationId: string;
  participantId: string;
  labels: string[];
}

/** Every member hosted on this machine with background work running now, as
 *  one list that replaces what the machine reported before. Sent after each
 *  hello and when the desktop asks (it reconnected), so nothing that ended or
 *  died meanwhile stays shown. */
export interface MachineMemberBackgroundSnapshotBody {
  type: "machine.member.background.snapshot";
  members: Array<{ conversationId: string; participantId: string; labels: string[] }>;
}

/** The desktop is back on the link and asks for that list. */
export interface MachineMemberBackgroundRequestBody {
  type: "machine.member.background.request";
}

/** A Claude Code member's next-prompt suggestion, sent by its CLI after a
 *  reply that ran on this machine. Live only: one lost on the way is simply
 *  not offered, as a suggestion the CLI skipped. */
export interface MachineTurnSuggestionBody {
  type: "machine.turn.suggestion";
  conversationId: string;
  runId: string;
  participantId: string;
  suggestion: string;
}

/** One operation on this machine's scheduled scripts, asked by the desktop
 *  that enrolled it. Ephemeral and addressed to one machine: a key value in
 *  setSecret never enters the server, a mailbox or settings. */
export type MachineScriptsOperation =
  | { op: "list" }
  | { op: "revision"; scriptId: string; revisionId?: string }
  | { op: "runs"; scriptId: string }
  | { op: "setSecret"; scriptId: string; name: string; value: string }
  | { op: "deleteSecret"; scriptId: string; name: string }
  | { op: "setEnabled"; scriptId: string; enabled: boolean }
  | { op: "runNow"; scriptId: string }
  | { op: "delete"; scriptId: string }
  | { op: "releaseHeld"; scriptId: string }
  | { op: "discardHeld"; scriptId: string };

export interface MachineScriptsRequestBody {
  type: "machine.scripts.request";
  requestId: string;
  /** The runtime instance the desktop last heard from (hello `instanceId`):
   *  the machine refuses a request made for an earlier run of itself. */
  instanceId?: string;
  /** When the desktop stops waiting. The machine refuses the request after
   *  this, so a change the User was told timed out never happens later. */
  expiresAt?: string;
  operation: MachineScriptsOperation;
}

export interface MachineScriptsResultBody {
  type: "machine.scripts.result";
  requestId: string;
  ok: boolean;
  error?: string;
  result?: unknown;
}

/** Machine -> desktop: its scheduled scripts changed; ask for the list again. */
export interface MachineScriptsChangedBody {
  type: "machine.scripts.changed";
}

/** Everything the room carries. Live progress is a MachineProgressFrame
 *  ("machine.turn.progress.delta"): one stream per run and connection, the
 *  first frame whole. */
export type MachineLinkMessage =
  | MachineScriptsRequestBody
  | MachineScriptsResultBody
  | MachineScriptsChangedBody
  | MachineHelloBody
  | MachineHelloAckBody
  | MachineHelloRequestBody
  | MachineTurnsHoldBody
  | MachineTurnsReleaseBody
  | MachineProgressFrame
  | MachineAttachmentRequestBody
  | MachineAttachmentResultBody
  | MachineTurnSuggestionBody
  | MachineMemberBackgroundBody
  | MachineMemberBackgroundSnapshotBody
  | MachineMemberBackgroundRequestBody;

export type MachineLinkMessageType = MachineLinkMessage["type"];

/** Every message the link accepts. Typed as a table over the union so that a
 *  body added to `MachineLinkMessage` without a row here is a compile error,
 *  not a message both sides silently drop on receipt. */
const MESSAGE_TYPE_TABLE: Record<MachineLinkMessageType, true> = {
  "machine.hello": true,
  "machine.hello.ack": true,
  "machine.hello.request": true,
  "machine.turns.hold": true,
  "machine.turns.release": true,
  "machine.turn.progress.delta": true,
  "machine.attachment.request": true,
  "machine.attachment.result": true,
  "machine.turn.suggestion": true,
  "machine.scripts.request": true,
  "machine.scripts.result": true,
  "machine.scripts.changed": true,
  "machine.member.background": true,
  "machine.member.background.snapshot": true,
  "machine.member.background.request": true,
};

const MESSAGE_TYPES: ReadonlySet<string> = new Set<string>(Object.keys(MESSAGE_TYPE_TABLE));

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
  /** A condition on the machine the User should know about (for example
   *  what it wrote that the server has not taken yet). */
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

/** What the Machines screen shows about trust: this desktop's own identity,
 *  which is what another device needs to be let in, and the devices that are
 *  already allowed to use this desktop's machines. */
export interface MachineTrustedDevicesResult {
  thisDevice: TrustedDeviceRecord;
  devices: TrustedDeviceRecord[];
}

export interface SaveTrustedDeviceRequest {
  deviceId: string;
  publicKeyDerBase64: string;
  role: "desktop" | "phone";
  name: string;
}

export interface MachineEnrollmentRequest {
  id: string;
}

export interface RemoveMachineRequest {
  id: string;
}

/** A machine that has not been active for 10 days or more. While it is kept,
 *  the desktop keeps every chat change for it, so the User is asked whether it
 *  is still in use. */
export interface MachineInactivityQuestion {
  machineId: string;
  name: string;
  inactiveDays: number;
}

export interface AnswerMachineInactivityRequest {
  machineId: string;
  answer: "keep" | "remove";
}

/** An enrolled machine as the desktop stores it. The pairing package carries
 *  the relay room, the seal key, and the capability fingerprint. */
/** The key a machine signs with: from its hello, or recorded at setup
 *  before it first connected. */
export function machineSigningKey(record: Pick<MachineRecord, "lastHello" | "devicePublicKeyDerBase64">): string | undefined {
  return record.lastHello?.publicKeyDerBase64 ?? record.devicePublicKeyDerBase64;
}

export interface MachineRecord {
  id: string;
  name: string;
  /** Stable association with the existing AWS instance; survives setup retries. */
  awsInstanceId?: string;
  /** Relay device id of the machine (its chat-event origin id) once it has
   *  connected; empty until the first hello. */
  deviceId: string;
  /** The key the machine signs with, recorded at setup: the User's hub admits
   *  the machine by it before its first hello. */
  devicePublicKeyDerBase64?: string;
  pairingKey: string;
  createdAt: string;
  lastSeenAt?: string;
  lastHello?: Omit<MachineHelloBody, "type">;
}
