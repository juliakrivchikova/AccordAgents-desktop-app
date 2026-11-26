import { chatParticipantRequestPermissionExceeds } from "../../shared/agentPermissions";
import { APP_TOOL_PERMISSION_TOOL } from "../../shared/appMcpToolContracts";
import { isClaudePlanApprovalRequest } from "../../shared/claudePlanApproval";
import type { HubUserApproval } from "../../shared/hubOps";
import type { HubMemberRules } from "../../shared/hubProtocol";
import type { ChatAppToolApproval, ChatParticipant, Conversation } from "../../shared/types";
import { withRequestRight } from "./askRights";
import { accordNaming } from "./grants";
import { HOME_FIELDS, lowerRight, permissionsOf, rank, requestRight } from "./records";
import type { Approved, Update } from "./types";

// --- its own members ----------------------------------------------------------

/** A member a machine adds without what only the computer writes: a
 *  session handed over, a forked main session's origin and an imported
 *  one's; `removed` names the fields it brought. */
export function withoutComputerOnlyFields(member: ChatParticipant): { member: ChatParticipant; removed: string[] } {
  const removed = (["sessionHandoff", "forkOrigin", "importOrigin"] as const).filter((field) => field in member);
  if (removed.length === 0) return { member, removed };
  const { sessionHandoff: _handoff, forkOrigin: _origin, importOrigin: _imported, ...rest } = member;
  return { member: rest, removed };
}

export function keepHome(next: ChatParticipant, current: ChatParticipant): ChatParticipant {
  const merged = { ...next } as Record<string, unknown>;
  for (const field of HOME_FIELDS) {
    const value = (current as unknown as Record<string, unknown>)[field];
    if (value === undefined) delete merged[field];
    else merged[field] = value;
  }
  return merged as unknown as ChatParticipant;
}

/** A member keeps the role and the right to manage members the User gave it:
 *  the app never changes either on a machine. Nor which member added it
 *  without a card (what holds it to the main session's rights). */
export function keepRole(next: ChatParticipant, current: ChatParticipant): ChatParticipant {
  // Its name too: the app never renames a member on a machine, and a name
  // taken from another member would speak for that one.
  const named = next.handle === current.handle ? next : { ...next, handle: current.handle };
  const roled = named.roleConfigId === current.roleConfigId ? named : { ...named, roleConfigId: current.roleConfigId };
  const delegated = roled.delegatedByParticipantId === current.delegatedByParticipantId ? roled : withDelegator(roled, current.delegatedByParticipantId);
  // Nor the title it is named by in the sessions view: a title taken from
  // another member would speak for that one, as a name would.
  const kept = delegated.taskTitle === current.taskTitle ? delegated : withTaskTitle(delegated, current.taskTitle);
  const had = permissionsOf(current).manageRolesParticipants;
  if (permissionsOf(next).manageRolesParticipants === had) return kept;
  const permissions = { ...permissionsOf(next) };
  if (had === undefined) delete permissions.manageRolesParticipants;
  else permissions.manageRolesParticipants = had;
  return { ...kept, permissions: permissions as unknown as ChatParticipant["permissions"] };
}

function withTaskTitle(member: ChatParticipant, taskTitle: string | undefined): ChatParticipant {
  const { taskTitle: _title, ...rest } = member;
  return taskTitle === undefined ? rest : { ...rest, taskTitle };
}

export function withDelegator(member: ChatParticipant, delegatorId: string | undefined): ChatParticipant {
  const { delegatedByParticipantId: _delegator, ...rest } = member;
  return delegatorId === undefined ? rest : { ...rest, delegatedByParticipantId: delegatorId };
}

/** Approvals with only each member's latest answered plan card among its
 *  plan approvals: the latest of all she answered (a "No, keep planning",
 *  one already used, any), so an older Yes never gives its mode again. */
export function latestPlanAnswersOnly(approved: Approved[], approvals: HubUserApproval[] | undefined): Approved[] {
  const isPlan = (approval: ChatAppToolApproval | undefined): boolean =>
    Boolean(approval && approval.toolName === APP_TOOL_PERMISSION_TOOL && isClaudePlanApprovalRequest(approval.request));
  const latest = new Map<string, { at: string; answerOpId: string }>();
  for (const card of approvals ?? []) {
    if (card.superseded || !card.answerOpId || !card.participantId) continue;
    if (!isPlan((card.card as { approval?: ChatAppToolApproval } | undefined)?.approval)) continue;
    const at = card.answeredAt ?? card.raisedAt;
    const seen = latest.get(card.participantId);
    if (!seen || at > seen.at) latest.set(card.participantId, { at, answerOpId: card.answerOpId });
  }
  return approved.filter((item) => !isPlan(item.approval) || latest.get(item.card.participantId ?? "")?.answerOpId === item.card.answerOpId);
}

/** A member that runs elsewhere, as the server has it; given leave to ask
 *  other members when `/accord` names it (and only that, as far as it
 *  gives). */
export function keepElsewhere(
  conversation: Conversation,
  next: ChatParticipant,
  current: ChatParticipant,
  used: ReadonlySet<string>,
  noted: Set<string>,
  rules?: Pick<HubMemberRules, "accordFromAnySession">
): ChatParticipant {
  const had = requestRight(current);
  if (!chatParticipantRequestPermissionExceeds(requestRight(next), had)) return current;
  const accord = accordNaming(conversation, current, used, rules);
  if (!accord) return current;
  const allowed = lowerRight(requestRight(next), accord.cap);
  if (rank(allowed) <= rank(had)) return current;
  noted.add(accord.key);
  return withRequestRight(current, allowed);
}

// --- the chat's name ----------------------------------------------------------

/** The app names a new chat once, from the first member's answer: a machine
 *  whose member answered first names it the same way. */
export function namesNewChat(conversation: Conversation, update: Update, machineMembers: ChatParticipant[]): boolean {
  const current = (conversation.metadata ?? {}) as Record<string, unknown>;
  if (current.autoTitle !== undefined) return false;
  const named = update.metadata?.autoTitle as { source?: unknown; title?: unknown; participantId?: unknown } | undefined;
  return Boolean(named) && named!.source === "first-agent" && named!.title === update.title &&
    machineMembers.some((member) => member.id === named!.participantId);
}
