import type { ChatMessage, ChatParticipant, Conversation, ConversationSummary } from "../../shared/types";
import { chatMessageHiddenFromTimeline } from "../../shared/chatParticipantRequestThreads";
import type { MobileControlCard } from "../../shared/mobileControlCards";
import { phoneActivityEvents, timelineEventsFromSnapshot, type MobileChatListItem, type MobileTimelinePage } from "./mobileTimeline";

/** The phone's chat list and a chat's page, built from the server's copy of
 *  the chats, so the phone shows the same thing the desktop does. */

/** Chats the phone lists, newest first. */
export const MOBILE_CHAT_LIST_LIMIT = 100;
/** The newest messages read per listed chat for its last line. */
export const MOBILE_CHAT_LIST_SNIPPET_WINDOW = 10;
/** Messages per page of a chat. */
export const MOBILE_TIMELINE_PAGE_SIZE = 80;

/** The store reads the builders need. */
export interface MobileCatalogStore {
  listConversations(): Promise<ConversationSummary[]>;
  openConversation(id: string, limit?: number, page?: { beforeMessageId?: string }): Promise<{ conversation: Conversation; messagePage: { hasMoreBefore: boolean } } | undefined>;
}

export interface MobileChatListOptions {
  /** Role labels by role config id; an unknown role shows its id. */
  roleLabels: Map<string, string>;
  /** Machine names by machine id. */
  machineNames: Map<string, string>;
  /** Every card still waiting for the User in a chat, as the server holds
   *  them (its cards, Д9). The phone drops a pending card that a listed set
   *  leaves out, so it is the whole set or nothing (undefined: the phone
   *  keeps what it holds). The chat is the one the list read for its row. */
  pendingCardsFor?: (conversationId: string, conversation: Conversation | undefined) => MobileControlCard[] | undefined;
  /** A summary that cannot say whether a member is running (the server's
   *  copy) is answered from the chat's newest messages instead. */
  runningFromMessages?: boolean;
  /** Only chats this returns true for are listed (a pairing's scope). */
  include?: (summary: ConversationSummary) => boolean;
  /** The chat summaries when the caller already read them. */
  summaries?: ConversationSummary[];
}

export async function buildMobileChatList(store: MobileCatalogStore, options: MobileChatListOptions): Promise<MobileChatListItem[]> {
  const summaries = options.summaries ?? await store.listConversations();
  const listed = summaries
    .filter((summary) => summary.kind === "chat" && summary.archived !== true && (options.include?.(summary) ?? true))
    .slice(0, MOBILE_CHAT_LIST_LIMIT);
  const items: MobileChatListItem[] = [];
  for (const summary of listed) {
    // The list needs each chat's members and its last line, not its
    // history. Reading whole conversations here pulled the newest hundred
    // chats' messages — tens of megabytes on the User's data — through the
    // sqlite CLI on every list request, and the phone asks for the list on
    // every return to the foreground and every pull to refresh.
    const opened = await store.openConversation(summary.id, MOBILE_CHAT_LIST_SNIPPET_WINDOW);
    const conversation = opened?.conversation;
    // The last line the User can see, not the last line stored: an internal
    // system trigger is hidden on the desktop and must not become the
    // phone's preview of the chat. When the whole window is internal, a
    // member's own words the desktop merely tidies away (a waiting status)
    // may stand in; a system trigger or a control message never does.
    const newest = conversation?.messages.slice().reverse().filter((message) => message.content.trim()) ?? [];
    const lastMessage = newest.find((message) => !chatMessageHiddenFromTimeline(conversation as Conversation, message)) ??
      newest.find((message) => message.role === "participant" && message.metadata?.hiddenFromTimeline !== true);
    const members = mobileChatMembers(conversation);
    const pendingCards = options.pendingCardsFor?.(summary.id, conversation);
    const activity = conversation ? phoneActivityEvents(conversation) : [];
    items.push({
      id: summary.id,
      title: summary.title || "Chat",
      group: mobileChatGroupLabel(summary.repoPath),
      snippet: mobileSnippet(lastMessage?.content),
      who: mobileWhoLabel(lastMessage),
      updatedAt: summary.updatedAt,
      running: summary.running === true ||
        (options.runningFromMessages === true && (conversation?.messages ?? []).some((message) => message.role === "participant" && message.status === "pending")),
      participants: (summary.chatParticipants ?? [])
        .map((participant) => participant.handle.startsWith("@") ? participant.handle : `@${participant.handle}`)
        .slice(0, 4),
      ...(pendingCards ? { pendingCards } : {}),
      ...(activity.length ? { activity } : {}),
      members: members.map((participant) => ({
        id: participant.id,
        handle: participant.handle,
        mentionHandle: mobileParticipantMentionHandle(participant, members),
        displayName: mobileParticipantDisplayName(participant),
        roleLabel: options.roleLabels.get(participant.roleConfigId) ?? participant.roleConfigId,
        // What the phone resolves a draft's member with, as the desktop does.
        roleConfigId: participant.roleConfigId,
        kind: participant.kind,
        ...(participant.avatarId ? { avatarId: participant.avatarId } : {}),
        ...(mobileParticipantIsAssistant(participant) ? { isAssistant: true } : {}),
        // A member that lives on a machine travels with what that machine
        // needs to run it, so the phone can ask the machine itself when the
        // desktop is closed. Local members carry nothing extra.
        ...(participant.homeMachineId
          ? {
            homeMachineId: participant.homeMachineId,
            ...(options.machineNames.get(participant.homeMachineId)
              ? { homeMachineName: options.machineNames.get(participant.homeMachineId) }
              : {}),
            participant
          }
          : {})
      }))
    });
  }
  return items;
}

/** The newest page of a chat, or the page before a message the phone
 *  already holds. The cursor is the oldest stored message of the page, not
 *  the oldest visible row: a page of rows the phone does not show would
 *  otherwise be asked for again and again. */
export async function buildMobileTimelinePage(store: MobileCatalogStore, conversationId: string, options: { beforeMessageId?: string } = {}): Promise<MobileTimelinePage & { conversation?: Conversation }> {
  const opened = await store.openConversation(conversationId, MOBILE_TIMELINE_PAGE_SIZE, options.beforeMessageId
    ? { beforeMessageId: options.beforeMessageId }
    : undefined);
  if (!opened) {
    return { events: [], hasMoreBefore: false };
  }
  const oldest = opened.conversation.messages[0];
  return {
    events: timelineEventsFromSnapshot(opened.conversation, MOBILE_TIMELINE_PAGE_SIZE),
    hasMoreBefore: opened.messagePage.hasMoreBefore,
    ...(oldest ? { beforeMessageId: oldest.id } : {}),
    // The page itself, for a reader that needs more of it than the events
    // (the server's cards); never sent as it is.
    conversation: opened.conversation
  };
}

export function mobileChatMembers(conversation: Conversation | undefined): ChatParticipant[] {
  const participants = conversation?.metadata.participants;
  return Array.isArray(participants)
    ? participants.filter((participant): participant is ChatParticipant => Boolean(
      participant &&
      typeof participant === "object" &&
      typeof participant.id === "string" &&
      typeof participant.handle === "string" &&
      typeof participant.roleConfigId === "string" &&
      (participant.kind === "claude-code" || participant.kind === "codex-cli" || participant.kind === "gemini-cli")
    ))
    : [];
}

export function mobileParticipantIsAssistant(participant: Pick<ChatParticipant, "handle" | "roleConfigId">): boolean {
  return participant.roleConfigId === "administrator" ||
    participant.handle.trim().replace(/^@/, "").toLowerCase() === "admin";
}

export function mobileParticipantMentionHandle(
  participant: Pick<ChatParticipant, "handle" | "roleConfigId">,
  participants: Array<Pick<ChatParticipant, "handle" | "roleConfigId">>
): string {
  if (!mobileParticipantIsAssistant(participant)) {
    return participant.handle;
  }
  const normalizedHandle = participant.handle.trim().replace(/^@/, "").toLowerCase();
  const assistantAliasTaken = participants.some((item) =>
    item !== participant &&
    item.handle.trim().replace(/^@/, "").toLowerCase() === "assistant" &&
    item.roleConfigId !== "administrator"
  );
  return normalizedHandle === "admin" && !assistantAliasTaken ? "assistant" : participant.handle;
}

export function mobileParticipantDisplayName(participant: Pick<ChatParticipant, "handle" | "roleConfigId">): string {
  return mobileParticipantIsAssistant(participant) ? "Chat Assistant" : `@${participant.handle}`;
}

/** The project's folder name. Split on either separator: the server reads
 *  paths the desktop wrote, whatever system that is. */
export function mobileChatGroupLabel(repoPath: string | undefined): string {
  if (!repoPath) {
    return "AccordAgents";
  }
  const parts = repoPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "AccordAgents";
}

export function mobileSnippet(content: string | undefined): string {
  const normalized = content?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) {
    return "No messages yet";
  }
  return normalized.length > 84 ? `${normalized.slice(0, 81)}...` : normalized;
}

export function mobileWhoLabel(message: ChatMessage | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  if (message.role === "user") {
    return "you:";
  }
  if (message.participantLabel) {
    return `${message.participantLabel.replace(/^@/, "")}:`;
  }
  return message.role === "system" ? "system:" : undefined;
}
