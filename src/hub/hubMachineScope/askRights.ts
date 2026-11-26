import { chatParticipantRequestPermissionExceeds, normalizeChatParticipantRequestPermission } from "../../shared/agentPermissions";
import { APP_CHAT_REQUEST_PARTICIPANTS_TOOL } from "../../shared/appMcpToolContracts";
import type { HubUserApproval } from "../../shared/hubOps";
import { mainSessionParticipantId } from "../../shared/mainSession";
import type { ChatMessage, ChatParticipant, ChatParticipantRequestPermission, Conversation } from "../../shared/types";
import { approvedRequests, askGrantKey } from "./grants";
import { handleKey, lowerRight, participantsOf, permissionsOf, rank, requestRight, runsOnMachine } from "./records";
import type { Leave } from "./types";

export function withRequestRight(member: ChatParticipant, right: ChatParticipantRequestPermission | undefined): ChatParticipant {
  const permissions = { ...permissionsOf(member) };
  if (right === undefined) delete permissions.requestParticipants;
  else permissions.requestParticipants = right;
  return { ...member, permissions: permissions as unknown as ChatParticipant["permissions"] };
}

/** The member with its leave to ask other members as the server has it,
 *  raised only as far as the app would have raised it; what gave it is noted
 *  in `noted`, so it gives it once. */
export function keepRequestRight(next: ChatParticipant, current: ChatParticipant, given: () => Leave | undefined, noted: Set<string>): ChatParticipant {
  const asked = requestRight(next);
  const had = requestRight(current);
  if (!chatParticipantRequestPermissionExceeds(asked, had)) return next;
  const leave = given();
  const allowed = leave ? lowerRight(asked, leave.cap) : had;
  if (rank(allowed) > rank(had)) noted.add(leave!.key);
  if (allowed === asked) return next;
  return withRequestRight(next, rank(allowed) > rank(had) ? allowed : permissionsOf(current).requestParticipants as ChatParticipantRequestPermission | undefined);
}

/**
 * Whether a machine may ask a member that runs elsewhere to answer a message
 * of one of its own members: as the app lets that member ask another — with
 * its leave to ask other members (as the server holds it), or with the
 * User's approval of this very request to this member, while the request
 * still reads as it did when she approved it (`contentHash`, the message's
 * content now, against the one kept with her approval).
 */
export function machineMayAsk(conversation: Conversation, machineId: string | undefined, message: ChatMessage, targetId: string, approvals: HubUserApproval[] | undefined, contentHash: string,
  used: ReadonlySet<string> = new Set()): boolean | { grant: string } {
  const members = participantsOf(conversation.metadata?.participants);
  const requester = members.find((member) => member.id === message.participantId);
  const target = members.find((member) => member.id === targetId);
  if (!requester || !target || !runsOnMachine(requester, machineId)) return false;
  if (askRight(conversation, requester) === "allow") return true;
  const handle = handleKey(target.handle);
  // Her approval runs the member it names once, as in the app.
  const answer = (approvals ?? []).find((card) => {
    if (card.superseded || !card.answerOpId || card.participantId !== requester.id || card.messageHash !== contentHash) return false;
    if (used.has(askGrantKey(card.answerOpId, target.id))) return false;
    const answer = (card.answer ?? {}) as { approve?: unknown; auto?: unknown; targetParticipantIds?: unknown };
    if (answer.approve !== true || answer.auto === true) return false;
    if (card.cardKind === "mention") {
      const source = (card.card as { sourceMessageId?: unknown } | undefined)?.sourceMessageId;
      return (card.messageId === message.id || source === message.id) &&
        Array.isArray(answer.targetParticipantIds) && answer.targetParticipantIds.includes(target.id);
    }
    return approvedRequests([card]).some((item) => item.approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
      item.request.requestMessageId === message.id &&
      Array.isArray(item.request.requests) && (item.request.requests as Array<{ target?: unknown }>).some((entry) => handleKey(entry?.target) === handle));
  });
  return answer ? { grant: askGrantKey(answer.answerOpId!, target.id) } : false;
}

/** Whether a machine's ask needs the User's approvals at all (its member
 *  has no leave to ask of its own). */
export function askNeedsApproval(conversation: Conversation, message: ChatMessage): boolean {
  const requester = participantsOf(conversation.metadata?.participants).find((member) => member.id === message.participantId);
  return !requester || askRight(conversation, requester) !== "allow";
}

/**
 * Whether a machine may name the chat's main session as the one compacting a
 * member (app_chat_compact_participant; the User, 2026-11-26), wherever that
 * member runs: only when the main session runs on that machine and compacts
 * without asking (its `requestCompaction` as the server holds it), never for
 * itself, and never with a member's own going on after it (`resume` starts a
 * turn of the member, which a compaction is not). The computer compacts any
 * member, as it always could.
 */
export function machineMayCompact(conversation: Conversation, machineId: string | undefined, targetId: string, request: Record<string, unknown> | undefined): boolean {
  const members = participantsOf(conversation.metadata?.participants);
  const mainId = mainSessionParticipantId(conversation.metadata);
  const main = mainId ? members.find((member) => member.id === mainId) : undefined;
  if (!main || !runsOnMachine(main, machineId) || request?.requestedByParticipantId !== main.id || targetId === main.id) return false;
  if (request.resume !== undefined) return false;
  if (!members.some((member) => member.id === targetId)) return false;
  return normalizeChatParticipantRequestPermission(permissionsOf(main).requestCompaction as ChatParticipantRequestPermission | undefined) === "allow";
}

/** A member's leave to ask other members as the app holds it at its turn: a
 *  member added without a card in a chat with a main session has no more
 *  than the main session has now (chat.ts delegatedMemberCeiling). */
function askRight(conversation: Conversation, member: ChatParticipant): ChatParticipantRequestPermission {
  const own = requestRight(member);
  const mainId = member.delegatedByParticipantId ? mainSessionParticipantId(conversation.metadata) : undefined;
  const main = mainId && mainId !== member.id ? participantsOf(conversation.metadata?.participants).find((item) => item.id === mainId) : undefined;
  return main ? lowerRight(own, requestRight(main)) : own;
}
