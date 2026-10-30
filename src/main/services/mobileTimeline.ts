import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import {
  chatMessageHiddenFromTimeline,
  chatMessageVisualThreadRootId,
  chatParticipantRequestReplyRootMap
} from "../../shared/chatParticipantRequestThreads";
import type { MobileControlCard } from "../../shared/mobileControlCards";

/**
 * What the phone reads of the chats, as the User's server answers it: the
 * chat list, a chat's timeline rows (projected from the server's copy the
 * same way the desktop renders them), and the composer's options.
 */

export interface MobileChatListItem {
  id: string;
  title: string;
  group: string;
  snippet: string;
  who?: string;
  updatedAt: string;
  running: boolean;
  participants: string[];
  members?: MobileChatMember[];
  /** What Activity shows for this chat (phoneActivityEvents): runs going on
   *  and members' replies of the last week, without the phone reading the
   *  chat's pages. Absent when there is none. */
  activity?: MobileTimelineEvent[];
  /** The cards still waiting for the User in this chat, as the server holds
   *  them now. The phone drops a pending card it holds that is not here: the
   *  batch that closed it can be lost, and nothing else would ever say so. */
  pendingCards?: MobileControlCard[];
}

export interface MobileChatMember {
  id: string;
  handle: string;
  mentionHandle: string;
  displayName: string;
  roleLabel: string;
  kind: "claude-code" | "codex-cli" | "gemini-cli";
  avatarId?: string;
  /** The chat assistant, which shows the app mark rather than a member avatar. */
  isAssistant?: boolean;
  /** The machine this member runs on, when it is not this desktop. Carried so
   *  the phone can reach that machine itself with the desktop closed. */
  homeMachineId?: string;
  /** That machine's name, as Settings shows it, for the phone's member list. */
  homeMachineName?: string;
  /** A Cloud run member whose machine is not chosen yet: not local. */
  cloudRun?: boolean;
  /** The member's role, which the phone resolves a draft's administrator by. */
  roleConfigId?: string;
  /** The member record a machine needs to run a turn. Sent only for members
   *  with a home machine, so the list does not grow for every local member. */
  participant?: ChatParticipant;
}

export interface MobileTimelinePage {
  events: MobileTimelineEvent[];
  /** Whether the desktop holds messages before this page. */
  hasMoreBefore: boolean;
  /** The oldest message of this page, visible on the phone or not. The next
   *  page is asked before it; asking before the oldest *visible* row could
   *  return the same page forever when the page had nothing to show. */
  beforeMessageId?: string;
}

export interface MobileTimelineAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
}

export interface MobileTimelineEvent {
  id: string;
  role: "you" | "participant" | "system";
  participantLabel?: string;
  content: string;
  attachments?: MobileTimelineAttachment[];
  status: "pending" | "done" | "error";
  createdAt: string;
  runId?: string;
  messageId?: string;
  mobileEventId?: string;
  /** Id of the message this one is filed under, so the phone can collapse
   *  replies exactly the way the desktop does. Absent on main-timeline rows. */
  threadRootId?: string;
  /** A member's message the desktop keeps off its timeline (a waiting status,
   *  an inferred request carrier). It still travels because it can be the end
   *  of a run: the phone settles the run's pending row on it and stores no
   *  bubble. Internal system and user rows are not sent at all. */
  hidden?: true;
  /** The member that wrote it, so the phone resolves an unaddressed draft to
   *  the last member that spoke, as the desktop does. */
  participantId?: string;
  /** The message's own thread (the desktop's reply context). */
  threadId?: string;
  /** A member's message: the message its turn answers. With the run id and
   *  the member it names the turn on the server, which a Stop names. */
  sourceMessageId?: string;
  /** The User's message: each member it asked a turn of, and where that turn
   *  stands on the server (the phone shows a member's waiting row until the
   *  member's own device took it). */
  turns?: MobileTimelineTurn[];
}

export interface MobileTimelineTurn {
  participantId: string;
  runId: string;
  state: "requested" | "claimed" | "stopped" | "finished";
}

/** How far back a finished reply still counts as activity on the phone. */
export const PHONE_ACTIVITY_DONE_MS = 7 * 24 * 60 * 60_000;
/** A reply's text as Activity shows it (the page holds the whole). */
export const PHONE_ACTIVITY_CONTENT_CHARS = 880;
/** At most this many of a chat's messages travel for Activity, the newest. */
export const PHONE_ACTIVITY_PER_CHAT = 8;

/**
 * What the phone's Activity shows for a chat, from the newest messages the
 * chat list already reads (no page of any chat is read for it): each run
 * still going, each member's newest finished reply of the last week, and
 * the reply a member's open question belongs to. Members' messages only,
 * never hidden ones; text cut short, no pictures; the newest few.
 */
export function phoneActivityEvents(conversation: Conversation, now = Date.now()): MobileTimelineEvent[] {
  const threadRoots = chatParticipantRequestReplyRootMap(conversation);
  const pendingByRun = new Map<string, MobileTimelineEvent>();
  const doneByMember = new Map<string, MobileTimelineEvent>();
  const askingByMember = new Map<string, MobileTimelineEvent>();
  for (const message of conversation.messages) {
    if (message.role !== "participant" || !messageTravelsToPhone(conversation, message) || messageIsHiddenOnPhone(conversation, message)) continue;
    const status = message.status ?? "done";
    if (status === "done" && !(now - Date.parse(message.createdAt) <= PHONE_ACTIVITY_DONE_MS)) continue;
    if (status !== "pending" && status !== "done") continue;
    const { attachments: _attachments, ...event } = timelineEventFromMessage(message, message.id, conversation, threadRoots);
    const short = { ...event, content: event.content.slice(0, PHONE_ACTIVITY_CONTENT_CHARS) };
    // Messages are oldest first: a later one of the same run or member wins.
    const member = message.participantId ?? message.participantLabel ?? short.id;
    // A reply that asks the User something is listed with its card (as the
    // desktop does), so it travels as well as the member's previous reply,
    // which stays its finished one.
    const asking = (message.metadata?.pendingChoice as { status?: unknown } | undefined)?.status === "pending";
    if (status === "pending") pendingByRun.set(short.runId ?? short.id, short);
    else if (asking) askingByMember.set(member, short);
    else doneByMember.set(member, short);
  }
  return [...pendingByRun.values(), ...askingByMember.values(), ...doneByMember.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-PHONE_ACTIVITY_PER_CHAT);
}

export function timelineEventsFromSnapshot(conversation: Conversation, limit = 40): MobileTimelineEvent[] {
  const threadRoots = chatParticipantRequestReplyRootMap(conversation);
  return conversation.messages
    .filter((message) => message.role !== "summary" && messageTravelsToPhone(conversation, message))
    .slice(-limit)
    .map((message) => timelineEventFromMessage(message, message.id, conversation, threadRoots));
}

/** Waiting for the first token is visible work, just like an image without a
 *  caption is still a message. Both must survive a timeline reload. */
function messageIsVisibleOnPhone(message: ChatMessage): boolean {
  return Boolean(message.content.trim()) || timelineAttachmentsFromMessage(message).length > 0 ||
    (message.role === "participant" && message.status === "pending");
}

/** What the desktop keeps off its timeline — internal system triggers such as
 *  "Auto-resumed @x after member request", control text, waiting statuses,
 *  inferred request carriers — is off the phone's too, by the same rule; only
 *  artifact notes among system messages are the User's to see. A hidden
 *  member message still travels, flagged: it can be the message that ends a
 *  run, and without it the phone's pending row for that run never settles. */
export function messageIsHiddenOnPhone(conversation: Pick<Conversation, "messages">, message: ChatMessage): boolean {
  // The flag is honoured on its own as well: the shared rule lets an inferred
  // request carrier's hidden-ness depend on its trigger being in the message
  // list, and the phone's projections read pages, so at a page boundary the
  // same carrier would otherwise flip between hidden and shown.
  return message.metadata?.hiddenFromTimeline === true || chatMessageHiddenFromTimeline(conversation, message);
}

function messageTravelsToPhone(conversation: Pick<Conversation, "messages">, message: ChatMessage): boolean {
  if (!messageIsVisibleOnPhone(message)) {
    return false;
  }
  return message.role === "participant" || !messageIsHiddenOnPhone(conversation, message);
}

function pendingParticipantContent(participantLabel?: string): string {
  return participantLabel?.trim() ? `${participantLabel.trim()} is running...` : "Running...";
}

function timelineAttachmentsFromMessage(message: ChatMessage): MobileTimelineAttachment[] {
  const attachments = message.metadata?.imageAttachments;
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .filter((attachment) => attachment && typeof attachment.id === "string" && attachment.id.trim().length > 0)
    // storageKey stays on the desktop: it is a local path, and the phone has no
    // use for one.
    .map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      width: attachment.width,
      height: attachment.height
    }));
}

function timelineEventFromMessage(
  message: ChatMessage,
  fallbackRunId: string,
  conversation?: Conversation,
  threadRoots?: ReturnType<typeof chatParticipantRequestReplyRootMap>
): MobileTimelineEvent {
  const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId : fallbackRunId;
  const mobileEventId = mobileEventIdFromMessage(message, runId) ?? mobileEventIdFromSourceMessage(message, conversation);
  // Same helper the desktop renders with, so the two cannot drift apart.
  const threadRootId = conversation
    ? chatMessageVisualThreadRootId(conversation, message, threadRoots)
    : undefined;
  const attachments = timelineAttachmentsFromMessage(message);
  const hidden = conversation && message.role === "participant" && messageIsHiddenOnPhone(conversation, message);
  return {
    id: message.id,
    ...(threadRootId && threadRootId !== message.id ? { threadRootId } : {}),
    ...(hidden ? { hidden: true as const } : {}),
    // A scheduled script's message is not the User's: the phone has no script
    // author, so it shows as an author named after the script.
    role: message.role === "participant" || message.role === "script" ? "participant" : message.role === "system" ? "system" : "you",
    ...(message.participantLabel ? { participantLabel: message.participantLabel } : {}),
    ...(message.role === "participant" && message.participantId ? { participantId: message.participantId } : {}),
    ...(typeof message.metadata?.threadId === "string" && message.metadata.threadId !== message.id ? { threadId: message.metadata.threadId } : {}),
    ...(message.role === "participant" && typeof message.metadata?.sourceMessageId === "string" && message.metadata.sourceMessageId
      ? { sourceMessageId: message.metadata.sourceMessageId } : {}),
    content: message.content.trim() || message.role !== "participant" || message.status !== "pending"
      ? message.content
      : pendingParticipantContent(message.participantLabel),
    ...(attachments.length > 0 ? { attachments } : {}),
    status: message.status ?? "done",
    createdAt: message.createdAt,
    runId,
    messageId: message.id,
    ...(mobileEventId ? { mobileEventId } : {})
  };
}

function mobileEventIdFromMessage(message: ChatMessage, runId: string): string | undefined {
  const explicit = message.metadata?.mobileEventId;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const sourceMessageId = message.metadata?.sourceMessageId;
  if (typeof sourceMessageId === "string" && sourceMessageId.trim() && runId === `mobile-${sourceMessageId.trim()}`) {
    return sourceMessageId.trim();
  }
  return undefined;
}

/** A participant answer to a phone-sent message runs under a fresh fan-out
 *  run id the phone has never heard of, while the phone's in-progress
 *  placeholder row is keyed by the ingest run (`mobile-<eventId>`) and the
 *  mobile event id. The answer's terminal must therefore carry the source
 *  message's mobile event id, or the placeholder outlives the answer — a
 *  "Thinking" row that never clears. Terminals only: a pending event
 *  carrying the id would let the phone's superseded-pending filter eat the
 *  live row it belongs to. */
function mobileEventIdFromSourceMessage(message: ChatMessage, conversation?: Conversation): string | undefined {
  if (message.role !== "participant" || (message.status ?? "done") === "pending" || !conversation) {
    return undefined;
  }
  const sourceMessageId = typeof message.metadata?.sourceMessageId === "string" ? message.metadata.sourceMessageId.trim() : "";
  if (!sourceMessageId) {
    return undefined;
  }
  const source = conversation.messages.find((candidate) => candidate.id === sourceMessageId);
  if (!source) {
    return undefined;
  }
  const sourceRunId = typeof source.metadata?.runId === "string" ? source.metadata.runId : "";
  return mobileEventIdFromMessage(source, sourceRunId);
}
