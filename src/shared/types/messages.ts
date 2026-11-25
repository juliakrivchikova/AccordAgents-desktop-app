import type { DeviceEventBlobReference } from "../deviceEventBlobs";
import type { UrgentAlertView } from "../urgentAlerts";
import type { ChatCardRefusal, ChatPendingChoice, ChatPendingMention, ChatServerCardMark } from "./cards";
import type { ChatParticipantRequestBatch } from "./memberRequests";
import type { ChatMessageSessionCut, ChatStaleRunRecovery } from "./members";
import type { RepoFileMention } from "./repositories";
import type { ChatRosterChangeOutcome } from "./rosterChanges";
import type { ChatSkillMention } from "./skills";

export type ChatReactionActorKind = "user" | "participant";

export interface ChatReactor {
  actorId: string;
  actorLabel: string;
  actorKind: ChatReactionActorKind;
  at: string;
}

export type ChatMessageReactions = Record<string, ChatReactor[]>;

/** A chat member's live background work (Claude Code `run_in_background`),
 *  by task name; an empty list means none is running any more. */
export interface ChatBackgroundTasksEvent {
  conversationId: string;
  participantId: string;
  labels: string[];
}

/** What a member wrote during its turn with app_chat_send_message, kept in
 *  its running reply (shared/interimPosts.ts): shown inside the reply, in
 *  order, like the text a CLI writes between its tool calls. */
export interface ChatInterimPost {
  id: string;
  content: string;
  createdAt: string;
  /** Where the turn's streamed text stood when it was posted (its length),
   *  and the newest activity of the turn then, so a running reply shows the
   *  post in order with them. */
  afterContentLength?: number;
  afterActivitySequence?: number;
  /** Its pictures, among the reply's imageAttachments. */
  attachmentIds?: string[];
}

/** The reply a turn-finished note points at, and the member who wrote it. */
export interface ChatTurnFinishedNoteMetadata {
  messageId: string;
  participantId: string;
  participantLabel: string;
}

/** Where the work a reply stopped for its member's own compaction stands:
 *  waiting for the User's card, compacting (or behind another turn), gone on,
 *  or ended there, with why. It only moves down this list. */
export interface ChatSelfCompactionMark {
  state: "card" | "waiting" | "ended" | "resumed";
  /** ended: a Stop; cut short (a quit, a restart); its next turn could not
   *  start (`error`); or there was nothing to go on with any more. */
  reason?: "stopped" | "interrupted" | "failed" | "not-continued";
  error?: string;
}

export interface ChatMessageMetadata {
  /** The launch of an Accord the chat's main session started
   *  (app_chat_start_accord, docs/main-session.md): written as its message,
   *  read as an Accord card like the User's own launch (accordLaunchCard.ts). */
  accordLaunchByMainSession?: boolean;
  /** An urgent alert a member raised (shared/urgentAlerts.ts): the User's
   *  server writes this message and keeps the alert's state in it. */
  urgentAlert?: UrgentAlertView;
  /** A machine member could not start because the machine's copy of the
   *  project is gone: the computer that made the copy forgets it, so the
   *  next message copies it again. */
  missingProjectCopy?: { machineId: string; sourcePath: string };
  /** A reply that ended for the compaction its member asked for
   *  (app_chat_request_compaction): the member goes on by itself after it, in
   *  a turn of its own (SelfCompactionResumes.continueAfterSelfCompaction). Written by
   *  the member's device and read by the one that waits for its answer. */
  selfCompaction?: ChatSelfCompactionMark;
  /** The message's place in the User's server's order (agreement Д1): set
   *  by the server when it accepted the message, the same on every device. */
  serverSeq?: number;
  /** The device that wrote the message on the server, the only one that may
   *  change it (agreement Д2). */
  serverWriter?: string;
  /** This device's view of the turns the message asked for, by member (who
   *  took each, whether it was asked to stop). Never sent to the server. */
  serverTurns?: Record<string, { runId: string; state: "requested" | "claimed" | "stopped" | "finished"; executorDeviceId?: string; stopRequested?: boolean; outcome?: "done" | "error" | "stopped" | "interrupted" }>;
  /** A bubble shown here for a member that runs on another device, until that
   *  device writes the real one. Never sent to the server. */
  serverPlaceholder?: boolean;
  /** The User's server refused this message, with its reason (agreement Д3:
   *  shown instead of "sent"). Never sent to the server. */
  serverRejected?: string;
  /** This device's view of a card the message's member waits on that runs
   *  on another device: answered (from any device), and not applied there
   *  yet. Shown as answered and waiting; never sent to the server. */
  serverCard?: ChatServerCardMark;
  /** Answers to this message's mention approvals its device could not apply
   *  (the last few), shown with the card asked again. */
  mentionCardRefusals?: ChatCardRefusal[];
  rosterChange?: ChatRosterChangeOutcome;
  /** Machines transport, Rule 2: a Stop was requested but the member's
   *  machine has not confirmed it yet (shown honestly instead of "stopped");
   *  kept apart from the content so delivered text is never overwritten. */
  stopPending?: { machineName: string; at: string };
  machinePending?: { machineName: string; at: string; reason?: string };
  /** Machines transport: this member's turn never left the desktop (stopped
   *  while preparing, or refused before it was sent), so the desktop, not the
   *  member's home machine, settles the bubble. */
  machineTurnNotSent?: boolean;
  cloudRunPreparation?: import("../cloudRunPreparation").CloudRunPreparationProgress;
  /** Machines transport: the result already folded into this bubble
   *  (identified by the machine's finishedAt), so a redelivery of the same
   *  result is applied once while a real result still replaces a provisional
   *  desktop-side outcome such as a timeout. */
  machineOutcome?: { runId: string; status: string; finishedAt?: string; receiptId?: string };
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
  reactions?: ChatMessageReactions;
  staleRunRecovery?: ChatStaleRunRecovery;
  /** "stop-unconfirmed": machines transport, Rule 2 — a Stop the member's
   *  machine never confirmed; shown as such, never as "stopped by user". */
  terminalReason?: "user-stopped" | "stop-unconfirmed";
  mentions?: string[];
  skillMentions?: ChatSkillMention[];
  repoFileMentions?: RepoFileMention[];
  imageAttachments?: ChatImageAttachment[];
  pendingMentions?: ChatPendingMention[];
  pendingChoice?: ChatPendingChoice;
  participantRequest?: ChatParticipantRequestBatch;
  hiddenFromTimeline?: boolean;
  sourceMessageId?: string;
  requesterParticipantId?: string;
  requesterContinuationRequested?: boolean;
  approvedContinuation?: boolean;
  syncedThroughMessageId?: string;
  runId?: string;
  mobileEventId?: string;
  turnSegmentId?: string;
  participantRequestDepth?: number;
  participantRequestBatchId?: string;
  participantRequestChainRootId?: string;
  nativeCommand?: {
    name: "goal";
    objective: string;
  };
  compaction?: {
    triggeredBy: "user" | "agent";
    participantId: string;
    outcome: "completed" | "failed" | "no-active-session";
    instructionsProvided: boolean;
  };
  /** A machine's hidden answer to a `session.export` turn: where it put the
   *  member's session on the User's server for its move. */
  memberSessionExport?: import("../memberSessionMove").MemberSessionExportReport;
  /** A machine's hidden word that it took the session its member was handed. */
  memberSessionTaken?: import("../memberSessionMove").MemberSessionTakenReport;
  /** The computer's hidden word that a move it asked a machine for was not
   *  made: the machine lets the member's held turns go. */
  memberMoveCancelled?: { participantId: string; runId: string };
  workedMs?: number;
  /** Not the end of its turn: Claude Code handed the User's next message to
   *  the step this reply was answering, and the turn went on in that
   *  message's reply. As in the CLI's transcript, it has no "Worked for" of
   *  its own and its steps stay open; the turn's "Worked for" is on its last
   *  part (counted from the turn's start, turnStartedAt). */
  turnContinues?: true;
  /** A member's reply that ended a turn: where its CLI session stood then,
   *  so Fork to new chat copies the session up to it. Written by the device
   *  that ran the turn, when its CLI said (Claude Code's stream, Codex's
   *  turn). */
  sessionCut?: ChatMessageSessionCut;
  queuedBehind?: { handle: string };
  /** The reply waits behind its member's turn before it: the shared word
   *  of `queuedBehind` (which stays on the device), so the phone shows it
   *  queued, with no clock. */
  turnQueued?: true;
  /** The User took a waiting message back before its member took it: on the
   *  reply that never began, or on the line that stands in its place. No
   *  later turn is given that message (chat/turns/takenBackMessages.ts). */
  takenBack?: { participantId: string; messageId: string };
  /** When a reply that waited behind its member's turn before it began its
   *  own turn: its "Working for …" counts from here, not from when it was
   *  queued (desktop and phone). */
  turnStartedAt?: string;
  appMessageSource?: string;
  /** Set on messages a scheduled script posted. */
  scriptId?: string;
  scriptName?: string;
  artifactEventId?: string;
  /** An artifact note: the Accord launch message its document belongs to, so
   *  that Accord's card shows the step instead of a card of its own. */
  accordLaunchMessageId?: string;
  /** Who leads that Accord and who is in it, as its launch names them, so the
   *  Accord's card can be drawn when the launch itself is not loaded. */
  accordLaunch?: { facilitator: string; members: string[] };
  /** On the line a closed Accord leaves in the chat (appMessageSource
   *  ACCORD_CLOSED_SOURCE): the launch message of the Accord it folds. */
  accordClosed?: { launchMessageId: string; title?: string };
  /** On a turn-finished note (appMessageSource TURN_FINISHED_NOTE_SOURCE): the
   *  member's reply it points at, which had other messages below it when the
   *  turn ended. */
  turnFinishedNote?: ChatTurnFinishedNoteMetadata;
  /** A member's reply: what it posted during its turn, oldest first. */
  interimPosts?: ChatInterimPost[];
  activityEvents?: ChatAgentActivityEvent[];
  processingTranscript?: ChatProcessingTranscript;
  remoteRunStatus?: ChatRemoteRunStatus;
  executionLease?: ChatExecutionLeaseMetadata;
  executionLeaseSuperseded?: boolean;
  accordResolution?: ChatAccordResolutionMetadata;
  autoWatchTrigger?: {
    participantId: string;
    reason: string;
    messageIds: string[];
  };
  /** A User's message: every member it asks, as the device it was written on
   *  resolved them, including those that device asks itself later (a cloud
   *  member whose machine still gets the project, an Accord's facilitator).
   *  A member watching the chat is not woken for it: its own turn answers it.
   *  Unlike deliveryTargets it asks the server for nothing. */
  askedParticipantIds?: string[];
}

export interface ChatExecutionLeaseMetadata {
  conversationId: string;
  participantId: string;
  participantSessionId: string;
  leaseId: string;
  holderId: string;
  generation: number;
  status: "active" | "released" | "reclaimed" | "conflict";
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export type ChatRemoteRunPhase =
  | "preparing-worker"
  | "syncing-files"
  | "launching-session"
  | "waiting-for-runner"
  | "waiting-for-response"
  | "processing-request"
  | "waiting-for-approval"
  | "terminal";

export interface ChatRemoteRunStatus {
  phase: ChatRemoteRunPhase;
  label: string;
  detail?: string;
  startedAt: string;
  updatedAt: string;
  processingStartedAt?: string;
}

export type ChatAgentActivityKind = "tool" | "command" | "file-edit" | "web" | "approval" | "status";

export interface ChatAgentActivityEvent {
  id: string;
  sequence: number;
  itemId?: string;
  kind: ChatAgentActivityKind;
  label: string;
  detail?: string;
  createdAt: string;
  status?: "started" | "completed" | "failed";
  afterContentLength?: number;
}

export interface ChatProcessingTranscript {
  content: string;
  capturedAt: string;
  originalLength: number;
  retainedStart?: number;
  truncated?: boolean;
  omittedActivityEventCount?: number;
}

export interface ChatLastMessageByParticipantEntry {
  messageId: string;
  sequence: number;
  // ISO timestamp of the pointed message. This — not `sequence` — is the authoritative
  // recency key: the array index is window-relative under pagination and not comparable
  // across opens, so ordering by it froze pointers on stale messages.
  createdAt?: string;
  threadRootId?: string;
}

export type ChatLastMessageByParticipant = Record<string, ChatLastMessageByParticipantEntry>;

export interface ChatPromptContextPointerEntry {
  messageId: string;
  sequence: number;
  createdAt?: string;
  /** The newest post of a reply still being written that the member has
   *  read (pendingReplyPostsForPromptContext), when newer than the message
   *  above: its next turn reads only posts made after it. */
  postsReadThrough?: string;
  /** When this device wrote the pointer: a member's context that started
   *  over (forgottenAt) keeps only pointers written after it. */
  committedAt?: string;
}

export type ChatPromptContextPointerScope =
  | { type: "timeline" }
  | { type: "thread"; threadRootId: string };

export interface ChatPromptContextPointerAdvance {
  scope: ChatPromptContextPointerScope;
  entry: ChatPromptContextPointerEntry;
}

export interface ChatPromptContextParticipantPointers {
  timeline?: ChatPromptContextPointerEntry;
  threads?: Record<string, ChatPromptContextPointerEntry>;
  /** The member's chat context started over at this time (its session
   *  started clean): a pointer to a message from before it, held by a copy
   *  of the chat read earlier, is not taken back when copies are merged. */
  forgottenAt?: string;
}

export type ChatPromptContextPointers = Record<string, ChatPromptContextParticipantPointers>;

// Lightweight, optional metadata a facilitator can attach to a canonical /accord
// resolution message for verification/debugging. This is NOT an app-state decision
// engine — approval authority remains the `✅` reactor set on the canonical message.
export interface ChatAccordResolutionMetadata {
  version?: number;
  sourceMessageId?: string;
  selectedParticipantIds?: string[];
  requiredApproverIds?: string[];
  supersedesMessageId?: string;
  status?: string;
}

export type ChatImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface ChatImageInput {
  filename?: string;
  mimeType: string;
  dataBase64: string;
}

export interface ChatImageAttachment {
  id: string;
  filename: string;
  mimeType: ChatImageMimeType;
  sizeBytes: number;
  width: number;
  height: number;
  storageKey: string;
  createdAt: string;
  /** The picture's bytes on the User's server, put there by the device that
   *  made it (the phone, the computer or a machine) before its message, so
   *  every other device reads it from there. Absent on pictures made before
   *  devices put their pictures on the server. */
  hubBlob?: DeviceEventBlobReference;
}

export interface ReviewProgress {
  runId: string;
  phase: "initial" | "extract" | "arbiter" | "decisions" | "debate" | "summary" | "done" | "cancelled" | "error";
  message: string;
  participantLabel?: string;
  agentProgress?: AgentRunProgress;
  findingTitle?: string;
  completed?: number;
  total?: number;
  /** A member's restart: the members list shows it (and a machine's wait)
   *  on that member's row until it ends. */
  memberRestart?: { participantId: string; waiting?: boolean };
  createdAt: string;
}

export interface AgentRunProgress {
  participantId?: string;
  participantLabel: string;
  state: "running" | "finished";
  activity?: string;
  activityEvents?: ChatAgentActivityEvent[];
  messageId?: string;
  partialContent?: string;
  remoteRunStatus?: ChatRemoteRunStatus;
  /** The mobile event id of the phone-sent message this run is answering.
   *  The phone keys its in-progress row by this id while the run itself gets
   *  a fresh id, so live frames must carry it or a watcher can never bind
   *  them to the row it follows. */
  mobileEventId?: string;
}

export interface ChatMessage {
  id: string;
  /** "script": posted by a scheduled script the User approved; its name is
   *  in participantLabel and metadata.scriptName. */
  role: "user" | "participant" | "system" | "summary" | "script";
  participantId?: string;
  participantLabel?: string;
  content: string;
  createdAt: string;
  status?: "pending" | "done" | "error";
  progressPhase?: ReviewProgress["phase"];
  metadata?: ChatMessageMetadata;
}
