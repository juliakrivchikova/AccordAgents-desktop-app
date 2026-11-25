import {
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_PERMISSIONS_REQUEST_CHANGE_TOOL, APP_TOOL_PERMISSION_TOOL
} from "../../shared/appMcpToolContracts";
import { isClaudePlanApprovalRequest } from "../../shared/claudePlanApproval";
import type { HubCard, HubUserApproval } from "../../shared/hubOps";
import { chatViewFor, mainSessionParticipantId } from "../../shared/mainSession";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, ChatParticipantRequestPermission, Conversation } from "../../shared/types";
import { requestRight } from "./askRights";
import { memberChangeTool } from "./memberChanges";
import { handleKey, participantsOf, rank, withoutCode } from "./records";
import type { Approved, Leave } from "./types";

/** How a used approval or `/accord` is noted on the server. */
export function approvalGrantKey(answerOpId: string): string {
  return `approval:${answerOpId}`;
}

export function askGrantKey(answerOpId: string, participantId: string): string {
  return `ask:${answerOpId}:${participantId}`;
}

function accordGrantKey(messageId: string, participantId: string): string {
  return `accord:${messageId}:${participantId}`;
}

/** Approvals on permission and roster cards, for the member each waits on.
 *  One she answered again later (refused it, say) no longer counts; `used`
 *  leaves out those that already gave their lasting change. */
export function approvedRequests(approvals: HubUserApproval[] | undefined, used?: ReadonlySet<string>): Approved[] {
  return (approvals ?? []).flatMap((card) => {
    if (card.superseded || !card.answerOpId) return [];
    const key = approvalGrantKey(card.answerOpId);
    if (used?.has(key)) return [];
    if (card.cardKind !== "permission" && card.cardKind !== "roster") return [];
    const answer = (card.answer ?? {}) as { approve?: unknown; scope?: unknown; draftOverride?: unknown; auto?: unknown };
    const approval = (card.card as { approval?: ChatAppToolApproval } | undefined)?.approval;
    if (answer.approve !== true || answer.auto === true || !approval || typeof approval !== "object") return [];
    if (!card.participantId || approval.requesterParticipantId !== card.participantId) return [];
    const request = (answer.draftOverride && typeof answer.draftOverride === "object" ? answer.draftOverride : approval.request) as Record<string, unknown> | undefined;
    if (!request || typeof request !== "object") return [];
    return [{ card, approval, request, scope: answer.scope === "chat" ? "chat" : "once", key }];
  });
}

// --- leave to ask other members -----------------------------------------------

const ACCORD = /(^|\s)\/accord\b/i;

function names(message: ChatMessage, member: ChatParticipant): boolean {
  const handle = handleKey(member.handle);
  if (!handle) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|[^\\w@])@${escaped}(?![\\w-])`, "i").test(withoutCode(message.content ?? ""))) return true;
  const targets = (message.metadata as { deliveryTargets?: unknown } | undefined)?.deliveryTargets;
  return Array.isArray(targets) && targets.includes(member.id);
}

/** `/accord` naming the member, not used yet: the app gives the member it
 *  names (its facilitator) leave to ask other members, once — named in the
 *  User's own message or another member's reply, as the chat shows them;
 *  never by the member's own reply, a hidden message or a line no one wrote
 *  as themselves (a machine writes those too). In a chat with a main session
 *  only the User and the main session start an Accord (docs/main-session.md),
 *  so another member's reply gives no leave, and the main session's gives no
 *  more than its own (as the app's startAccord does), as the server has it.
 *  The one that gives the most. */
export function accordNaming(conversation: Conversation, member: ChatParticipant, used: ReadonlySet<string>): Leave | undefined {
  const mainSessionId = mainSessionParticipantId(conversation.metadata);
  const mainSession = mainSessionId ? participantsOf(conversation.metadata?.participants).find((item) => item.id === mainSessionId) : undefined;
  const sessionsView = chatViewFor(conversation.metadata) === "sessions";
  let best: Leave | undefined;
  for (const message of conversation.messages) {
    if (message.role !== "user" && message.role !== "participant") continue;
    if (message.role === "participant" && message.participantId === member.id) continue;
    if (message.role === "participant" && mainSessionId && message.participantId !== mainSessionId) continue;
    if (message.metadata?.hiddenFromTimeline === true) continue;
    if (used.has(accordGrantKey(message.id, member.id))) continue;
    const skills = (message.metadata as { skillMentions?: unknown } | undefined)?.skillMentions;
    const accord = ACCORD.test(withoutCode(message.content ?? "")) ||
      (Array.isArray(skills) && skills.some((skill) => (skill as { frontmatterName?: unknown } | undefined)?.frontmatterName === "accord"));
    if (!accord || !names(message, member)) continue;
    const byMainSession = message.role === "participant" && Boolean(mainSessionId) && message.participantId === mainSessionId;
    if (byMainSession && !mainSession) continue;
    // In the sessions view a mention in a reply starts nobody: the main
    // session names a facilitator only by starting an Accord with the app
    // tool (its launch message), as the app gives that leave.
    if (byMainSession && sessionsView && message.metadata?.accordLaunchByMainSession !== true) continue;
    const cap: ChatParticipantRequestPermission = byMainSession ? requestRight(mainSession!) : "allow";
    if (!best || rank(cap) > rank(best.cap)) best = { cap, key: accordGrantKey(message.id, member.id) };
  }
  return best;
}

/** The leave to ask other members the app would have given this member: the
 *  User's "Allow for this chat" on a request it made (a request inferred from
 *  its reply only ever gets a one-time approval), or `/accord` naming it. */
export function leaveGiven(conversation: Conversation, member: ChatParticipant, approved: Approved[], used: ReadonlySet<string>): Leave | undefined {
  const answer = approved.find((item) => item.scope === "chat" && item.approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
    item.card.participantId === member.id && item.request.source !== "inferred");
  if (answer) return { cap: "allow", key: answer.key };
  return accordNaming(conversation, member, used);
}

/** The message an approval is about (a member request's, or a mention's),
 *  whose content is kept with her approval. */
export function approvedMessageId(card: HubCard): string | undefined {
  if (card.cardKind === "mention") {
    const source = (card.card as { sourceMessageId?: unknown } | undefined)?.sourceMessageId;
    return typeof source === "string" && source ? source : card.messageId;
  }
  const approval = (card.card as { approval?: ChatAppToolApproval } | undefined)?.approval;
  const id = approval?.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL ? (approval.request as { requestMessageId?: unknown } | undefined)?.requestMessageId : undefined;
  return typeof id === "string" && id ? id : undefined;
}

/** What of an approved card the server keeps to hold a machine to: member
 *  requests, member changes and mentions as she saw them; a right she
 *  granted a member for the chat; for a tool
 *  permission she allowed for the chat, only which tool (its input, a file's
 *  content say, is not needed); nothing else. */
export function keptApproval(card: HubCard): HubCard | undefined {
  if (card.cardKind === "mention") return card;
  if (card.cardKind !== "permission" && card.cardKind !== "roster") return undefined;
  const approval = (card.card as { approval?: ChatAppToolApproval } | undefined)?.approval;
  if (!approval || typeof approval !== "object") return undefined;
  if (approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL || memberChangeTool(approval.toolName)) return card;
  // A plan she approved: which rows it offered and the one she picked, so
  // the machine may write the mode the CLI then moved to, once (the plan
  // itself is not needed).
  if (approval.toolName === APP_TOOL_PERMISSION_TOOL && isClaudePlanApprovalRequest(approval.request)) {
    const { plan: _plan, ...asked } = approval.request.planApproval;
    const { draftOverride: _override, ...planAnswer } = (card.answer ?? {}) as Record<string, unknown>;
    return {
      ...card,
      answer: planAnswer,
      card: { approval: { ...approval, request: { kind: "toolPermission", toolName: approval.request.toolName, planApproval: asked } } }
    };
  }
  if ((card.answer as { scope?: unknown } | undefined)?.scope !== "chat") return undefined;
  // A right she granted for the chat: what it grants, so the machine may
  // write it into its member's rights once (keepRights).
  if (approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL) return card;
  const tool = (approval.request as { toolName?: unknown } | undefined)?.toolName;
  const { draftOverride: _draft, ...answer } = (card.answer ?? {}) as Record<string, unknown>;
  return {
    ...card,
    answer,
    card: { approval: { ...approval, request: (typeof tool === "string" ? { toolName: tool } : {}) as ChatAppToolApproval["request"] } }
  };
}
