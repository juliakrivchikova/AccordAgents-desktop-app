import { memberHasFinishedReply } from "../../../../shared/forkToNewChat";
import { cliProviderMetadata } from "../../../../shared/cliReadiness";
import type {
  ChatMessage, ChatParticipant, ChatParticipantSession, ChatParticipantForkOrigin, ChatSessionForkSource, Conversation
} from "../../../../shared/types";
import { forkCopyNotMade } from "../../cliAgents";
import type { ParticipantRunResult } from "../../providers";
import { chatParticipants, mainSessionHandleForMember } from "../members/identity";
import { normalizedLastMessageByParticipant } from "../store/lastMessages";
import { mainSessionMemberRules } from "../turns/promptSections";

/**
 * What a member made as a fork of another member's session is told before
 * its task: both CLIs keep the source's system and developer instructions
 * in a fork (Claude Code 2.1.329, Codex 0.155.1), so the copy would
 * otherwise go on as the main session. Its messages carry the whole note
 * with its role's instructions until a turn of it succeeded (`firstTurn`).
 */
export function forkedMemberIdentityNote(
  conversation: Conversation,
  participant: ChatParticipant,
  session: ChatParticipantSession,
  firstTurn: boolean
): string | undefined {
  // Said once, with the fork's first message: it stays in the copy's
  // context, and once the CLI compacts it renders the system prompt again
  // from the member's own instructions (Claude Code 2.1.330), so later
  // messages carry no reminder.
  const sourceId = session.forkFrom?.participantId ?? session.forkedFromParticipantId;
  if (!sourceId || !firstTurn) {
    return undefined;
  }
  const origin = otherChatForkOrigin(conversation, participant, sourceId);
  if (origin) {
    return forkedMainSessionIdentityNote(conversation, participant, session, origin);
  }
  const source = chatParticipants(conversation).find((item) => item.id === sourceId);
  const sourceName = source ? `@${source.handle}` : "the main session";
  const mainSessionHandle = mainSessionHandleForMember(conversation, participant);
  return [
    `You were forked from ${sourceName}'s session: you keep everything it knew, but from now on you are a different member of this chat.`,
    `- You are @${participant.handle}, role: ${session.roleLabel}. You are not the main session; the instructions this session started with for ${sourceName} no longer apply to you.`,
    "- Do only the task in the request below and report the result in your reply; it goes back to the member that gave you the task.",
    "- Do not create members or give work to other members unless your task says so.",
    ...(mainSessionHandle ? mainSessionMemberRules(mainSessionHandle) : []),
    "",
    "Your role instructions:",
    session.roleInstructions
  ].join("\n");
}

/** The main session of a chat made by Fork to new chat, when its session
 *  was (or is to be) copied from this member of another chat. */
export function otherChatForkOrigin(conversation: Conversation, participant: ChatParticipant, sourceId: string | undefined): ChatParticipantForkOrigin | undefined {
  const origin = participant.forkOrigin;
  return origin && sourceId && origin.participantId === sourceId && origin.conversationId !== conversation.id ? origin : undefined;
}

/**
 * What the main session of a chat made by Fork to new chat is told: it
 * keeps what the member it was copied from knew, but it is this chat's
 * main session now, with the main session's role (both CLIs keep the
 * source's system and developer instructions in a fork). Its first turn
 * gets the whole note with its role's instructions, once.
 */
function forkedMainSessionIdentityNote(
  conversation: Conversation,
  participant: ChatParticipant,
  session: ChatParticipantSession,
  origin: ChatParticipantForkOrigin
): string {
  const sourceName = forkOriginSessionName(origin);
  return [
    `You were forked from ${sourceName}: you keep everything it knew, but from now on you are the main session of a new chat, "${conversation.title}".`,
    `- You are @${participant.handle}, role: ${session.roleLabel}. The instructions this session started with for @${origin.handle} no longer apply to you; your role instructions are below.`,
    "- The earlier chat is not this one: its members are not here, and the app's chat tools read and write this chat only.",
    "- User talks to you here: a message without an addressee comes to you, and you create members and give them tasks as your role instructions say.",
    "",
    "Your role instructions:",
    session.roleInstructions
  ].join("\n");
}

/** What a member made as a fork is told when the CLI could not copy the
 *  source session and starts it clean from the saved chat context: who it
 *  is and what it does, as the fork would have been told, without saying
 *  it knows what the source knew. Its role's instructions come with it. */
export function forkStartedCleanIdentityNote(conversation: Conversation, participant: ChatParticipant, session: ChatParticipantSession): string {
  const sourceId = session.forkFrom?.participantId ?? session.forkedFromParticipantId;
  const origin = otherChatForkOrigin(conversation, participant, sourceId);
  if (origin) {
    return [
      `You were to start from a copy of ${forkOriginSessionName(origin)}, but it could not be copied: you start a new session with the chat context below.`,
      `- You are @${participant.handle}, role: ${session.roleLabel}: the main session of this chat. User talks to you here; you create members and give them tasks as your role instructions say.`
    ].join("\n");
  }
  const source = sourceId ? chatParticipants(conversation).find((item) => item.id === sourceId) : undefined;
  const sourceName = source ? `@${source.handle}'s` : "the main session's";
  const mainSessionHandle = mainSessionHandleForMember(conversation, participant);
  return [
    `You were to start from a copy of ${sourceName} session, but it could not be copied: you start a new session with the chat context below. Read the chat through the app's chat tools for anything earlier you need.`,
    `- You are @${participant.handle}, role: ${session.roleLabel}. You are not the main session.`,
    "- Do only the task in the request below and report the result in your reply; it goes back to the member that gave you the task.",
    "- Do not create members or give work to other members unless your task says so.",
    ...(mainSessionHandle ? mainSessionMemberRules(mainSessionHandle) : [])
  ].join("\n");
}

/** The chat's line that a fork could not copy its source's session and
 *  started a clean session in that turn ("now": the CLI started it clean
 *  itself, Claude Code's one-shot start). */
export function forkStartedCleanNotice(conversation: Conversation, participant: ChatParticipant, forkSource: ChatSessionForkSource, when: "now" | "turn"): string {
  const origin = otherChatForkOrigin(conversation, participant, forkSource.participantId);
  const source = origin ? undefined : chatParticipants(conversation).find((item) => item.id === forkSource.participantId);
  const sessionName = origin ? forkOriginSessionName(origin) : source ? `@${source.handle}'s session` : "the session it was forked from";
  return when === "now"
    ? `@${participant.handle} could not start from a copy of ${sessionName}, so it started a clean session from the saved chat context.`
    : `@${participant.handle} could not start from a copy of ${sessionName}, so this turn started a clean session.`;
}

/** A fork's run that failed while its CLI made the copy (no session of its
 *  own exists): the CLI said the source is gone, or failed before it took
 *  the message. Not a Stop, nor a start the CLI already made clean. */
export function forkCopyFailed(result: ParticipantRunResult, signal: AbortSignal | undefined): boolean {
  return !signal?.aborted && !result.ok && !result.sessionRestarted && forkCopyNotMade(result);
}

/** Whether the member has a finished reply in this chat (a reply still
 *  being written, or a placeholder for one, does not count). The chat's
 *  messages can be a window: its newest message outside it was finished. */
export function participantHasAnswered(conversation: Conversation, participantId: string): boolean {
  return memberHasFinishedReply(normalizedLastMessageByParticipant(conversation.metadata.lastMessageByParticipant), participantId, conversation.messages);
}

/** The session a main session made by Fork to new chat was copied from,
 *  as the chat and the main session are told: "@x's session in the chat
 *  "Title"". */
export function forkOriginSessionName(origin: ChatParticipantForkOrigin): string {
  return `@${origin.handle}'s session in the chat "${origin.conversationTitle}"`;
}

/** The line: "@main's copy of @x's session may include what @x did after
 *  you tapped Fork: <why>." Short enough for any chat's notices whatever
 *  the source chat's title (the new chat is named after it). */
export function forkCutNoteText(participant: ChatParticipant, reason: string): string | undefined {
  const origin = participant.forkOrigin;
  return origin ? `@${participant.handle}'s copy of @${origin.handle}'s session may include what @${origin.handle} did after you tapped Fork: ${reason}.` : undefined;
}

/** A reply that ended a turn records where its CLI session stood then
 *  (ChatMessageMetadata.sessionCut), so Fork to new chat can copy the
 *  session up to it. */
export function recordReplySessionCut(message: ChatMessage, result: Pick<ParticipantRunResult, "sessionId" | "sessionCut">): void {
  const sessionId = result.sessionId?.trim();
  const at = result.sessionCut?.trim();
  if (!sessionId || !at) return;
  message.metadata = { ...message.metadata, sessionCut: { sessionId, at } };
}

/** An imported thread's session at its first turn in the chat
 *  (importIntroPending): told where it is now, once, with the chat's full
 *  instructions above it. */
export function importedMainSessionNote(participant: ChatParticipant): string | undefined {
  const origin = participant.importOrigin;
  if (!origin) return undefined;
  const label = cliProviderMetadata(origin.kind).label;
  return [
    `This session is the User's own ${label} thread, now imported into an AccordAgents chat: everything before this message happened in ${label} itself, and the chat shows it as its history.`,
    `- You are @${participant.handle}, this chat's main session. The AccordAgents session instructions above apply from now on.`
  ].join("\n");
}
