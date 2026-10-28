/**
 * The User's server owns every chat (agreements Д1–Д13, artifact
 * "Сервер — хозяин переписки"). Devices write to it with operations and read
 * what it accepted, in its order, from a feed. This file is the wire format
 * both sides share; the phone bundles it too, so nothing here may import
 * Node modules.
 *
 * An operation carries an id its writer chose. The server answers each one:
 * accepted (with its place in the server's order), a duplicate of one it
 * already accepted (the same place), or rejected with a reason. "Accepted" is
 * what a device shows as "sent" (Д3). Rights are the server's to decide, by
 * rules that are the same for every device (Д2); no record is signed by its
 * device any more (Д10), only the request that carries it.
 */

import type { ArtifactResult, ChatMessage, ChatMessageReactions, ChatReactor } from "./types";

/** Protocol version of operations and the feed. A device that speaks an older
 *  one is told to update; it never writes in the old way. */
export const HUB_OPS_PROTOCOL = 3;

export const HUB_OPS_PATH = "/v3/ops";
export const HUB_FEED_PATH = "/v3/feed";
export const HUB_CHATS_PATH = "/v3/chats";
export const HUB_CHAT_PATH = "/v3/chat";
/** Turns waiting for the asking device's members (after a restart), and
 *  the ones it took and never finished. */
export const HUB_TURNS_PATH = "/v3/turns";

/** Operations in one request. */
export const HUB_OPS_MAX_PER_REQUEST = 100;
/** One operation's JSON: the largest message the User has is about half a
 *  megabyte, so a message of a few megabytes still fits. */
export const HUB_OP_MAX_BYTES = 4 * 1024 * 1024;
/** Entries one feed read returns at most, and their JSON at most. */
export const HUB_FEED_PAGE_MAX = 500;
export const HUB_FEED_PAGE_BYTES = 4 * 1024 * 1024;
/** How long a feed read may wait for something new. */
export const HUB_FEED_WAIT_MAX_MS = 25_000;
/** Messages one chat page returns at most. */
export const HUB_CHAT_PAGE_MESSAGES = 200;

/** What a member or the User does to a chat's documents (artifacts): each is
 *  decided by the server, by the same rules for every device (Д1, Д2, Д9). */
export type HubArtifactOpKind =
  | "artifact.create"
  | "artifact.revise"
  | "artifact.rename"
  | "artifact.sign"
  | "artifact.access"
  | "artifact.archive"
  | "artifact.draft.save"
  | "artifact.draft.submit"
  | "artifact.draft.replace"
  | "artifact.draft.withdraw"
  | "artifact.roster"
  | "artifact.publish";

export const HUB_ARTIFACT_OP_KINDS: readonly HubArtifactOpKind[] = [
  "artifact.create",
  "artifact.revise",
  "artifact.rename",
  "artifact.sign",
  "artifact.access",
  "artifact.archive",
  "artifact.draft.save",
  "artifact.draft.submit",
  "artifact.draft.replace",
  "artifact.draft.withdraw",
  "artifact.roster",
  "artifact.publish"
];

export function isHubArtifactOpKind(value: unknown): value is HubArtifactOpKind {
  return (HUB_ARTIFACT_OP_KINDS as readonly unknown[]).includes(value);
}

export type HubOpKind =
  | "conversation.create"
  | "conversation.update"
  | "conversation.delete"
  | "message.create"
  | "message.update"
  | "message.react"
  | "message.remove"
  | "turn.request"
  | "turn.claim"
  | "turn.stop"
  | "turn.finish"
  | "chat.import"
  | "card.raise"
  | "card.answer"
  | "card.settle"
  | HubArtifactOpKind
  | "artifact.import";

export const HUB_OP_KINDS: readonly HubOpKind[] = [
  "conversation.create",
  "conversation.update",
  "conversation.delete",
  "message.create",
  "message.update",
  "message.react",
  "message.remove",
  "turn.request",
  "turn.claim",
  "turn.stop",
  "turn.finish",
  "chat.import",
  "card.raise",
  "card.answer",
  "card.settle",
  ...HUB_ARTIFACT_OP_KINDS,
  "artifact.import"
];

/** The chat's own fields, as a device writes them. */
export interface HubConversationFields {
  title: string;
  kind: "chat";
  createdAt: string;
  repoPath?: string;
  /** Only the shared keys (members, auto title, approval policies, archive,
   *  residency); everything else on a chat is a device's own bookkeeping. */
  metadata: Record<string, unknown>;
}

export interface HubReactionAdded {
  emoji: string;
  reactor: ChatReactor;
}

export interface HubReactionRemoved {
  emoji: string;
  actorId: string;
}

export type HubTurnOutcome = "done" | "error" | "stopped" | "interrupted";

export type HubOpBody =
  | { kind: "conversation.create"; conversation: HubConversationFields }
  | { kind: "conversation.update"; title?: string; repoPath?: string | null; metadata?: Record<string, unknown>; removedMetadataKeys?: string[] }
  | { kind: "conversation.delete" }
  | { kind: "message.create"; message: ChatMessage }
  | { kind: "message.update"; message: ChatMessage }
  | { kind: "message.react"; messageId: string; added: HubReactionAdded[]; removed: HubReactionRemoved[] }
  | { kind: "message.remove"; messageId: string }
  | { kind: "turn.request"; runId: string; messageId: string; participantId: string; pendingMessageId?: string; request?: Record<string, unknown> }
  | { kind: "turn.claim"; runId: string; messageId: string; participantId: string }
  | { kind: "turn.stop"; runId: string; messageId: string; participantId: string }
  /** `contextUsage`: the member's context use as its CLI reported it after
   *  the turn, which every device shows as it shows a local member's. */
  | { kind: "turn.finish"; runId: string; outcome: HubTurnOutcome; contextUsage?: Record<string, unknown> }
  /** Moving to the server (one time, by the computer that held the chats):
   *  the chat's fields and a page of its messages, oldest pages first; the
   *  last page names the order of every message the computer held. */
  | { kind: "chat.import"; conversation?: HubConversationFields & { updatedAt?: string }; messages: ChatMessage[]; order?: string[] }
  /** A card a member waits on (a permission, a choice, a roster change),
   *  raised by the device the member runs on; raised again while pending
   *  replaces what it shows. */
  | { kind: "card.raise"; cardId: string; cardKind: HubCardKind; participantId?: string; messageId?: string; card: Record<string, unknown> }
  /** The User's answer, from any device (Д2); the first answer is the one. */
  | { kind: "card.answer"; cardId: string; answer: Record<string, unknown> }
  /** What the member's device did with the answer (or that the card is gone). */
  | { kind: "card.settle"; cardId: string; outcome: Record<string, unknown> }
  /** A document action, as the acting member (or "user") asked it: the same
   *  request a tool call or the User's window makes. The server decides it
   *  and answers with the result the tool returns. */
  | { kind: HubArtifactOpKind; actor: string; request: Record<string, unknown> }
  /** Moving documents to the server (one time, by the computer that held
   *  them): a page of one chat's document rows, kept as they are. */
  | { kind: "artifact.import"; rows: HubArtifactImportRows };

export type HubOp = HubOpBody & {
  /** Chosen by the writer; a repeat with the same id is the same operation. */
  opId: string;
  conversationId: string;
};

export type HubCardKind = "permission" | "choice" | "mention" | "roster";
export type HubCardState = "pending" | "answered" | "settled";

/** A card on the server: what it asks, the answer it got, and what came of it. */
export interface HubCard {
  cardId: string;
  conversationId: string;
  cardKind: HubCardKind;
  participantId?: string;
  messageId?: string;
  /** The device that raised it (the member's own): it applies the answer. */
  raisedBy: string;
  raisedAt: string;
  card: Record<string, unknown>;
  state: HubCardState;
  answer?: Record<string, unknown>;
  answeredBy?: string;
  answeredAt?: string;
  outcome?: Record<string, unknown>;
  settledAt?: string;
}

/** Where a turn stands on the server. "claimed" is the second mark a message
 *  shows: the device its member runs on has taken it (Д5). */
export type HubTurnState = "requested" | "claimed" | "stopped" | "finished";

export interface HubTurn {
  runId: string;
  conversationId: string;
  messageId: string;
  participantId: string;
  state: HubTurnState;
  /** Asked for by a device for a member that runs elsewhere, or by the
   *  server for each member a User's message names (deliveryTargets). */
  requestedAt?: string;
  requestedBy?: string;
  /** The id the member's reply bubble takes, chosen by the device that asked
   *  (so its placeholder becomes the real bubble). */
  pendingMessageId?: string;
  /** What kind of turn, for the device that runs it (a continuation, a
   *  compaction, a request from another member…). */
  request?: Record<string, unknown>;
  /** The device that took it (absent while it was stopped before anyone did). */
  executorDeviceId?: string;
  claimedAt?: string;
  /** Asked to stop while it was taken: its executor stops it. */
  stopRequestedAt?: string;
  finishedAt?: string;
  outcome?: HubTurnOutcome;
  /** The member's context use after the turn, as its device said when it
   *  finished it (carried in the feed; not kept with the turn). */
  contextUsage?: Record<string, unknown>;
}

/** What an accepted operation did, as every device applies it to its copy. */
export type HubOpEffect =
  | { kind: "conversation.create"; conversation: HubConversationFields; updatedAt: string }
  | { kind: "conversation.update"; title?: string; repoPath?: string | null; metadata?: Record<string, unknown>; removedMetadataKeys?: string[]; updatedAt: string }
  | { kind: "conversation.delete" }
  | { kind: "message.create"; message: ChatMessage; turns?: HubTurn[] }
  | { kind: "message.update"; message: ChatMessage }
  | { kind: "message.react"; messageId: string; reactions: ChatMessageReactions | null }
  | { kind: "message.remove"; messageId: string }
  | { kind: "turn.request"; turn: HubTurn }
  | { kind: "turn.claim"; turn: HubTurn }
  | { kind: "turn.stop"; turn: HubTurn }
  | { kind: "turn.finish"; turn: HubTurn }
  /** The chat changed as a whole (moved to the server): read it again. */
  | { kind: "chat.import"; last: boolean }
  | { kind: "card.raise"; card: HubCard }
  | { kind: "card.answer"; card: HubCard }
  | { kind: "card.settle"; card: HubCard }
  /** A document changed: every device reads it again (HUB_ARTIFACT_PATH).
   *  `note` is the chat note the device that acted writes into the chat. */
  | { kind: HubArtifactOpKind; artifactId: string; note?: HubArtifactNote }
  /** Documents moved to the server: every device reads these again. */
  | { kind: "artifact.import"; artifactIds: string[] };

/** The brief line a document change shows in the chat ("@gera revised
 *  [Plan](#artifact:…) · v3"). Its id keeps it from being written twice. */
export interface HubArtifactNote {
  eventId: string;
  content: string;
}

/** The server's answer to a document action: the document it concerns and
 *  the result the tool or the window shows (absent only for an answer the
 *  server could not keep, which the device then reads from its copy). */
export interface HubArtifactAnswer {
  artifactId?: string;
  draftId?: string;
  result?: ArtifactResult<unknown>;
}

/** How a claim came out, for the device that asked. */
export type HubClaimOutcome = "claimed" | "already-yours" | "taken" | "stopped" | "finished";

export type HubOpResult =
  | { opId: string; status: "accepted" | "duplicate"; seq: number; claim?: HubClaimOutcome; turn?: HubTurn; card?: HubCard; artifact?: HubArtifactAnswer }
  | { opId: string; status: "rejected"; reason: string; artifact?: HubArtifactAnswer };

export interface HubOpsRequest {
  ops: HubOp[];
}

export interface HubOpsResponse {
  results: HubOpResult[];
  /** The newest place in the server's order after this request. */
  head: number;
}

export interface HubFeedEntry {
  seq: number;
  opId: string;
  deviceId: string;
  conversationId: string;
  acceptedAt: string;
  effect: HubOpEffect;
}

export interface HubFeedResponse {
  entries: HubFeedEntry[];
  head: number;
  /** More entries wait after the last one returned. */
  more: boolean;
}

/** The feed no longer holds what comes right after `after`: the device reads
 *  the chats it holds again (HUB_CHATS_PATH / HUB_CHAT_PATH) and continues
 *  from `head`. */
export interface HubFeedGone {
  ok: false;
  error: string;
  gone: true;
  head: number;
}

export interface HubCardsResponse {
  /** Cards not settled yet in a chat (or every chat), oldest first. */
  cards: HubCard[];
  head: number;
}

export const HUB_CARDS_PATH = "/v3/cards";

export interface HubTurnsResponse {
  /** Turns asked for this device's members that nobody took yet. */
  turns: HubTurn[];
  /** Turns this device took and never finished (it stopped or restarted
   *  while they ran): it closes them, as nothing runs them any more. */
  claimed?: HubTurn[];
  head: number;
}

/** Who the asking device is on the server's roster (GET). A machine learns
 *  here which members are its own (its `machineId` is their `homeMachineId`). */
export const HUB_ME_PATH = "/v3/me";

export interface HubMe {
  deviceId: string;
  role: "owner" | "desktop" | "machine" | "phone";
  machineId?: string;
  name: string;
}

/**
 * A machine's settings, as the computer that set it up published them for it
 * (PUT, owner only; GET, the machine reads its own). Sealed for that machine
 * alone: the server keeps and hands over the sealed text and never reads it.
 * A PUT is told to the machine on its live socket (HubLiveSettings).
 */
export const HUB_MACHINE_SETTINGS_PATH = "/v3/machine-settings";

export interface HubMachineSettingsPut {
  machineId: string;
  sealed: string;
}

export interface HubMachineSettings {
  /** Absent while the computer has published nothing for this machine. */
  sealed?: string;
  /** When the server took it: a read `?since=` it answers `unchanged`. */
  updatedAt?: string;
  unchanged?: boolean;
}

/** The live socket's word to a machine that its settings changed. */
export interface HubLiveSettings {
  type: "settings";
}

export interface HubChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  deleted?: boolean;
}

export interface HubChatsResponse {
  chats: HubChatSummary[];
  head: number;
}

/** One page of a chat as the server holds it: the chat's fields, its newest
 *  messages before `before` (oldest first) and the turns those messages name. */
export interface HubChatPage {
  conversationId: string;
  conversation: HubConversationFields & { updatedAt: string };
  messages: ChatMessage[];
  turns: HubTurn[];
  /** Older messages remain: ask again with `before` = the first id here. */
  more: boolean;
  head: number;
}

// --- documents (artifacts) as the server holds them ------------------------

/** A chat's documents, without revision bodies (GET ?conversationId). */
export const HUB_ARTIFACTS_PATH = "/v3/artifacts";
/** One document (GET ?artifactId), or one revision's body (&revision=<id>). */
export const HUB_ARTIFACT_PATH = "/v3/artifact";

/** A document's own fields. */
export interface HubArtifactRecord {
  id: string;
  conversationId: string;
  name: string;
  owner: string;
  contributors: string[];
  requiredSigners: string[];
  labels: string[];
  lifecycle: "collecting_drafts" | "published";
  allowedDraftAuthors: string[];
  requiredDraftAuthors: string[];
  audiencePolicyByAuthor: Record<string, { allowedReaders: string[]; requiredReaders: string[] }>;
  draftRosterRevision: number;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

/** One immutable revision, without its body. `originalVersion` is the number
 *  it was written as; the projection says which number it shows. */
export interface HubArtifactRevisionMeta {
  artifactId: string;
  versionEventId: string;
  originalVersion: number;
  baseVersionEventId?: string;
  contentHash: string;
  author: string;
  note?: string;
  createdAt: string;
}

export interface HubArtifactRevision extends HubArtifactRevisionMeta {
  content: string;
}

export interface HubArtifactProjectionRow {
  version: number;
  versionEventId: string;
}

/** A member's signature, bound to the revision (and body) it was made on. */
export interface HubArtifactSignatureRow {
  versionEventId: string;
  contentHash: string;
  signer: string;
  signedAt: string;
}

export interface HubArtifactSourceRow {
  versionEventId: string;
  draftId: string;
  author: string;
  submittedAt: string;
  contentHash: string;
  disposition: "considered" | "excluded";
  exclusionRationale?: string;
}

export interface HubArtifactDraftRow {
  id: string;
  artifactId: string;
  author: string;
  state: "editing" | "submitted" | "superseded" | "withdrawn";
  content: string;
  readers: string[];
  editRevision: number;
  supersedesDraftId?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
}

/** A document whole, except its revisions' bodies (each read once, by id:
 *  a revision never changes). */
export interface HubArtifactState {
  record: HubArtifactRecord;
  revisions: HubArtifactRevisionMeta[];
  projection: HubArtifactProjectionRow[];
  signatures: HubArtifactSignatureRow[];
  sources: HubArtifactSourceRow[];
  drafts: HubArtifactDraftRow[];
}

/** A member's earlier draft or publication operation, kept so the same
 *  operation id asked again returns the same answer. */
export interface HubArtifactOperationRow {
  artifactId?: string;
  actor: string;
  operationKind: string;
  operationId: string;
  requestHash: string;
  resultJson: string;
  createdAt: string;
}

/** One page of a chat's documents moving to the server. */
export interface HubArtifactImportRows {
  artifacts?: HubArtifactRecord[];
  revisions?: HubArtifactRevision[];
  projection?: Array<HubArtifactProjectionRow & { artifactId: string }>;
  signatures?: Array<HubArtifactSignatureRow & { artifactId: string }>;
  sources?: Array<HubArtifactSourceRow & { artifactId: string }>;
  drafts?: HubArtifactDraftRow[];
  operations?: HubArtifactOperationRow[];
}

export interface HubArtifactsResponse {
  artifacts: HubArtifactState[];
  head: number;
}

/** `artifact` is absent when the server has no such document (deleted with
 *  its chat): a device drops its copy only on this answer, never on a
 *  request that failed (a server without this route answers 404). */
export interface HubArtifactResponse {
  artifact?: HubArtifactState;
  head: number;
}

/** `revision` is absent when the server has no such revision. */
export interface HubArtifactRevisionResponse {
  revision?: HubArtifactRevision;
}

/** The turn a User's message asks of a member it names: one per message and
 *  member, the same on every device. Other turns take any `turn-` id. */
export function hubTurnRunId(messageId: string, participantId: string): string {
  return `turn-${messageId}-${participantId}`;
}

export function isHubTurnRunId(value: unknown): value is string {
  return isHubOpId(value) && value.startsWith("turn-");
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function isHubOpId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export function isHubChatId(value: unknown): value is string {
  return typeof value === "string" && CHAT_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isMessage(value: unknown): value is ChatMessage {
  return isRecord(value) && isHubOpId(value.id) &&
    (value.role === "user" || value.role === "participant" || value.role === "system" || value.role === "summary" || value.role === "script") &&
    typeof value.content === "string" && typeof value.createdAt === "string" && !CONTROL.test(value.createdAt) &&
    (value.participantId === undefined || (typeof value.participantId === "string" && value.participantId.length <= 256)) &&
    (value.status === undefined || value.status === "pending" || value.status === "done" || value.status === "error") &&
    (value.metadata === undefined || isRecord(value.metadata));
}

function isReactor(value: unknown): value is ChatReactor {
  return isRecord(value) && typeof value.actorId === "string" && value.actorId.length > 0 && value.actorId.length <= 256;
}

/** Why an operation is malformed, or undefined when its shape is right. The
 *  server checks rights separately; this is only the shape. */
export function hubOpShapeProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "An operation must be an object.";
  if (!isHubOpId(value.opId)) return "The operation id is missing or invalid.";
  if (!(HUB_OP_KINDS as readonly unknown[]).includes(value.kind)) return "Unknown operation kind.";
  if (!isHubChatId(value.conversationId)) return "The chat id is missing or invalid.";
  switch (value.kind as HubOpKind) {
    case "conversation.create": {
      const conversation = value.conversation;
      if (!isRecord(conversation) || !isText(conversation.title, 2_000) || conversation.kind !== "chat" ||
          typeof conversation.createdAt !== "string" || !isRecord(conversation.metadata) ||
          (conversation.repoPath !== undefined && !isText(conversation.repoPath, 4_096))) return "Invalid chat fields.";
      return undefined;
    }
    case "conversation.update":
      if ((value.title !== undefined && !isText(value.title, 2_000)) ||
          (value.repoPath !== undefined && value.repoPath !== null && !isText(value.repoPath, 4_096)) ||
          (value.metadata !== undefined && !isRecord(value.metadata)) ||
          (value.removedMetadataKeys !== undefined && (!Array.isArray(value.removedMetadataKeys) || !value.removedMetadataKeys.every((key) => isText(key, 128))))) {
        return "Invalid chat change.";
      }
      return undefined;
    case "conversation.delete":
      return undefined;
    case "message.create":
    case "message.update":
      return isMessage(value.message) ? undefined : "Invalid message.";
    case "message.react":
      if (!isHubOpId(value.messageId) || !Array.isArray(value.added) || !Array.isArray(value.removed) ||
          !value.added.every((entry) => isRecord(entry) && isText(entry.emoji, 64) && (entry.emoji as string).length > 0 && isReactor(entry.reactor)) ||
          !value.removed.every((entry) => isRecord(entry) && isText(entry.emoji, 64) && typeof entry.actorId === "string")) {
        return "Invalid reaction change.";
      }
      return undefined;
    case "message.remove":
      return isHubOpId(value.messageId) ? undefined : "Invalid message id.";
    case "turn.request":
      if ((value.pendingMessageId !== undefined && !isHubOpId(value.pendingMessageId)) || (value.request !== undefined && !isRecord(value.request))) {
        return "Invalid turn request.";
      }
      return isHubTurnRunId(value.runId) && isHubOpId(value.messageId) && typeof value.participantId === "string" &&
        value.participantId.length > 0 && value.participantId.length <= 256 ? undefined : "Invalid turn.";
    case "turn.claim":
    case "turn.stop":
      return isHubTurnRunId(value.runId) && isHubOpId(value.messageId) && typeof value.participantId === "string" &&
        value.participantId.length > 0 && value.participantId.length <= 256 ? undefined : "Invalid turn.";
    case "card.raise":
      if (!isHubOpId(value.cardId) || !["permission", "choice", "mention", "roster"].includes(value.cardKind as string) || !isRecord(value.card) ||
          (value.participantId !== undefined && !isText(value.participantId, 256)) || (value.messageId !== undefined && !isHubOpId(value.messageId))) {
        return "Invalid card.";
      }
      return undefined;
    case "card.answer":
      return isHubOpId(value.cardId) && isRecord(value.answer) ? undefined : "Invalid answer.";
    case "card.settle":
      return isHubOpId(value.cardId) && isRecord(value.outcome) ? undefined : "Invalid card outcome.";
    case "chat.import": {
      const conversation = value.conversation;
      if (conversation !== undefined && (!isRecord(conversation) || !isText(conversation.title, 2_000) || conversation.kind !== "chat" ||
          typeof conversation.createdAt !== "string" || !isRecord(conversation.metadata))) return "Invalid chat fields.";
      if (!Array.isArray(value.messages) || !value.messages.every(isMessage)) return "Invalid messages.";
      if (value.order !== undefined && (!Array.isArray(value.order) || !value.order.every(isHubOpId))) return "Invalid message order.";
      return undefined;
    }
    case "turn.finish":
      if (value.contextUsage !== undefined && (!isRecord(value.contextUsage) || JSON.stringify(value.contextUsage).length > 4_096)) return "Invalid context use.";
      return isHubTurnRunId(value.runId) && (value.outcome === "done" || value.outcome === "error" || value.outcome === "stopped" || value.outcome === "interrupted")
        ? undefined : "Invalid turn outcome.";
    case "artifact.import":
      return artifactImportProblem(value.rows);
    default:
      if (isHubArtifactOpKind(value.kind)) {
        if (typeof value.actor !== "string" || value.actor.trim().length === 0 || value.actor.length > 256 || CONTROL.test(value.actor)) return "Invalid acting member.";
        return artifactRequestProblem(value.request, value.conversationId as string);
      }
      return "Unknown operation kind.";
  }
}

/** Whether any text in a value holds a NUL, which the server cannot store. */
function hasNul(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasNul(item, depth + 1));
  return Object.entries(value).some(([key, item]) => key.includes("\u0000") || hasNul(item, depth + 1));
}

/** A document action's request: only what the server's rules could not
 *  read at all is refused here (a request field of the wrong kind); every
 *  rule itself, with its own message, is the server's (the same as the
 *  rules a device applied before). */
function artifactRequestProblem(value: unknown, conversationId: string): string | undefined {
  if (!isRecord(value)) return "A document request must be an object.";
  if (value.conversationId !== conversationId) return "The document request names another chat.";
  if (hasNul(value)) return "Text with a NUL character cannot be stored.";
  for (const field of ["draftId", "supersedesDraftId"]) {
    const item = value[field];
    if (item !== undefined && item !== null && (typeof item !== "string" || item.length > 256)) return `Invalid ${field}.`;
  }
  const sources = value.sources;
  if (sources !== undefined && sources !== null && Array.isArray(sources) &&
      !sources.every((source) => isRecord(source) && (source.draftId === undefined || typeof source.draftId === "string"))) {
    return "Invalid sources.";
  }
  return undefined;
}

function isStringList(value: unknown, max = 256): value is string[] {
  return Array.isArray(value) && value.length <= 1_000 && value.every((item) => typeof item === "string" && item.length <= max);
}

function isOptionalText(value: unknown, max: number): boolean {
  return value === undefined || isText(value, max);
}

function isArtifactRecord(value: unknown): value is HubArtifactRecord {
  if (!isRecord(value)) return false;
  const policy = value.audiencePolicyByAuthor;
  return isHubOpId(value.id) && typeof value.conversationId === "string" && isText(value.name, 1_000) && isText(value.owner, 256) &&
    isStringList(value.contributors) && isStringList(value.requiredSigners) && isStringList(value.labels) &&
    (value.lifecycle === "published" || value.lifecycle === "collecting_drafts") &&
    isStringList(value.allowedDraftAuthors) && isStringList(value.requiredDraftAuthors) &&
    isRecord(policy) && Object.values(policy).every((entry) => isRecord(entry) && isStringList(entry.allowedReaders) && isStringList(entry.requiredReaders)) &&
    Number.isSafeInteger(value.draftRosterRevision) && Number.isSafeInteger(value.headVersion) &&
    isText(value.createdAt, 64) && isText(value.updatedAt, 64) && isOptionalText(value.archivedAt, 64);
}

function isArtifactRevision(value: unknown): value is HubArtifactRevision {
  return isRecord(value) && isHubOpId(value.artifactId) && isText(value.versionEventId, 256) && (value.versionEventId as string).length > 0 &&
    Number.isSafeInteger(value.originalVersion) && isOptionalText(value.baseVersionEventId, 256) && isText(value.contentHash, 128) &&
    typeof value.content === "string" && isText(value.author, 256) && isOptionalText(value.note, 4_096) && isText(value.createdAt, 64);
}

function isArtifactDraft(value: unknown): value is HubArtifactDraftRow {
  return isRecord(value) && isText(value.id, 256) && (value.id as string).length > 0 && isHubOpId(value.artifactId) && isText(value.author, 256) &&
    ["editing", "submitted", "superseded", "withdrawn"].includes(value.state as string) && typeof value.content === "string" &&
    isStringList(value.readers) && Number.isSafeInteger(value.editRevision) && isOptionalText(value.supersedesDraftId, 256) &&
    isText(value.createdAt, 64) && isText(value.updatedAt, 64) && isOptionalText(value.submittedAt, 64);
}

/** A page of documents moving to the server: rows of the right kind, each. */
function artifactImportProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "Invalid document rows.";
  if (hasNul(value)) return "Text with a NUL character cannot be stored.";
  const list = (key: string) => value[key] === undefined || Array.isArray(value[key]);
  if (!["artifacts", "revisions", "projection", "signatures", "sources", "drafts", "operations"].every(list)) return "Invalid document rows.";
  const rows = value as HubArtifactImportRows;
  if (!(rows.artifacts ?? []).every(isArtifactRecord)) return "Invalid document.";
  if (!(rows.revisions ?? []).every(isArtifactRevision)) return "Invalid document revision.";
  if (!(rows.projection ?? []).every((row) => isRecord(row) && isHubOpId(row.artifactId) && Number.isSafeInteger(row.version) && isText(row.versionEventId, 256))) {
    return "Invalid document version.";
  }
  if (!(rows.signatures ?? []).every((row) => isRecord(row) && isHubOpId(row.artifactId) && isText(row.versionEventId, 256) &&
      isText(row.contentHash, 128) && isText(row.signer, 256) && isText(row.signedAt, 64))) return "Invalid document signature.";
  if (!(rows.sources ?? []).every((row) => isRecord(row) && isHubOpId(row.artifactId) && isText(row.versionEventId, 256) && isText(row.draftId, 256) &&
      isText(row.author, 256) && isText(row.submittedAt, 64) && isText(row.contentHash, 128) &&
      (row.disposition === "considered" || row.disposition === "excluded") && isOptionalText(row.exclusionRationale, 4_096))) return "Invalid document source.";
  if (!(rows.drafts ?? []).every(isArtifactDraft)) return "Invalid document draft.";
  if (!(rows.operations ?? []).every((row) => isRecord(row) && (row.artifactId === undefined || isHubOpId(row.artifactId)) && isText(row.actor, 256) &&
      isText(row.operationKind, 64) && isText(row.operationId, 256) && isText(row.requestHash, 128) && typeof row.resultJson === "string" &&
      isText(row.createdAt, 64))) return "Invalid document operation.";
  return undefined;
}
