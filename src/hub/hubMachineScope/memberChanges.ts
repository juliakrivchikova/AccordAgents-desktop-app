import {
  chatAgentModeWithin, chatAgentPermissionsWithin, chatParticipantRequestPermissionExceeds,
  effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions,
  resolveChatManageRolesParticipantsPermission
} from "../../shared/agentPermissions";
import { MAIN_SESSION_ROLE_ID } from "../../shared/mainSession";
import {
  chatToolPermissionIsScoped, chatToolPermissionScopesEqual, normalizeChatToolPermissionScope
} from "../../shared/toolPermissionScope";
import {
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROSTER_REQUEST_CHANGE_TOOL
} from "../../shared/appMcpToolContracts";
import type { HubMemberRules } from "../../shared/hubProtocol";
import type { ChatAgentPermissions, ChatAppToolApprovalPolicy, ChatParticipant } from "../../shared/types";
import { permissionsWithin, startingPermissions } from "./memberRights";
import { CHAT_ASSISTANT_ROLE_ID, handleKey, rank } from "./records";
import type { Approved, ApprovedMember, MemberChanges, RoleRule, Update } from "./types";

function manageRight(rule: RoleRule | undefined, permissions: unknown) {
  return resolveChatManageRolesParticipantsPermission(rule?.manageRolesParticipants,
    (permissions as { manageRolesParticipants?: unknown } | undefined)?.manageRolesParticipants);
}

/** The rule the app keeps for "Allow for this chat" on member requests:
 *  roster requests by this member in its role. */
function isRosterPolicy(policy: ChatAppToolApprovalPolicy, member: ChatParticipant): boolean {
  return policy.participantId === member.id && policy.roleConfigId === member.roleConfigId && policy.scope === "chat" &&
    policy.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL && policy.capability === "participants.manage" &&
    !policy.targetParticipantId && !policy.targetToolName;
}

/** Whether a member may change the chat's members without a card, under the
 *  User's rules: its right to manage members (its role's, or its own), or her
 *  "Allow for this chat" on its roster requests (chat.ts
 *  matchingAppToolApprovalPolicy); never when it may not manage them at all. */
function managesWithoutCard(member: ChatParticipant, rules: HubMemberRules | undefined, policies: ChatAppToolApprovalPolicy[], mainSession?: ChatParticipant): boolean {
  let right = manageRight(rules?.roles[member.roleConfigId], member.permissions).effective;
  // A member added without a card in a chat with a main session manages
  // members no more freely than the main session as the server has it before
  // this write (chat.ts requireParticipantManager): lowering the main
  // session's right lowers its members' too, whatever they keep stored.
  if (member.delegatedByParticipantId && mainSession && mainSession.id !== member.id) {
    const mainRight = manageRight(rules?.roles[mainSession.roleConfigId], mainSession.permissions).effective;
    if (rank(mainRight) < rank(right)) right = mainRight;
  }
  if (right === "allow") return true;
  if (right === "deny") return false;
  return policies.some((policy) => isRosterPolicy(policy, member));
}

function roleRuleFrom(defaults: unknown): RoleRule {
  const record = (defaults && typeof defaults === "object" ? defaults : {}) as Record<string, unknown>;
  const perm = (value: unknown) => value === "allow" || value === "ask" || value === "deny" ? value : undefined;
  return {
    manageRolesParticipants: perm(record.manageRolesParticipants) ?? "deny",
    ...(perm(record.requestParticipants) ? { requestParticipants: perm(record.requestParticipants) } : {}),
    ...(perm(record.requestCompaction) ? { requestCompaction: perm(record.requestCompaction) } : {})
  };
}

export function memberChangeTool(toolName: string): boolean {
  return toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL || toolName === APP_ROSTER_REQUEST_CHANGE_TOOL;
}

/** The members an approved member request adds, as the app adds each. */
function approvedMembers(item: Approved, rules: HubMemberRules | undefined): ApprovedMember[] {
  if (!memberChangeTool(item.approval.toolName)) return [];
  const request = item.request as { kind?: unknown; operations?: unknown; participantRequest?: { operations?: unknown }; roleRequest?: { operations?: unknown } };
  const combined = request.kind === "role_participant_change";
  const operations = combined ? request.participantRequest?.operations : request.operations;
  // Roles the same request makes (their members start with their defaults)
  // or edits (the role stays the one named, with its new defaults).
  const madeRoles = new Map<string, RoleRule>();
  const editedRoles = new Map<string, RoleRule>();
  if (combined && Array.isArray(request.roleRequest?.operations)) {
    for (const operation of request.roleRequest.operations as Array<{ type?: unknown; role?: Record<string, unknown> }>) {
      if (!operation?.role) continue;
      const rule = roleRuleFrom(operation.role.participantDefaults);
      if (operation.type === "create_role") {
        for (const key of [operation.role.draftRoleRef, operation.role.roleConfigId]) {
          if (typeof key === "string" && key && !rules?.roles[key]) madeRoles.set(key, rule);
        }
      } else if (operation.type === "edit_role" && typeof operation.role.roleConfigId === "string") {
        editedRoles.set(operation.role.roleConfigId, rule);
      }
    }
  }
  if (!Array.isArray(operations)) return [];
  return (operations as Array<Record<string, unknown>>).flatMap((operation, index): ApprovedMember[] => {
    const claim = `${item.key}#${index}`;
    if ((operation?.type === "add_new_participant_to_chat" || operation?.type === "add") && operation.participant && typeof operation.participant === "object") {
      const participant = operation.participant as Record<string, unknown>;
      const roleConfigId = typeof participant.roleConfigId === "string" ? participant.roleConfigId : undefined;
      const made = roleConfigId ? madeRoles.get(roleConfigId) : undefined;
      const role = made ?? (roleConfigId ? editedRoles.get(roleConfigId) ?? rules?.roles[roleConfigId] : undefined);
      return [{
        claim, approval: item,
        handle: handleKey(participant.handle),
        ...(made ? { newRole: true } : roleConfigId ? { roleConfigId } : {}),
        ...(typeof participant.homeMachineId === "string" && participant.homeMachineId ? { homeMachineId: participant.homeMachineId } : {}),
        agentMode: normalizeChatAgentMode(participant.agentMode),
        permissions: startingPermissions(role, participant.permissions),
        ...(role ? { role } : {})
      }];
    }
    if (operation?.type === "add_existing_participant_to_chat" && typeof operation.participantConfigId === "string") {
      const preset = rules?.presets[operation.participantConfigId];
      // A saved member the server does not know of: nothing to hold it to.
      if (!preset) return [];
      const overrides = (operation.overrides && typeof operation.overrides === "object" ? operation.overrides : {}) as Record<string, unknown>;
      const role = editedRoles.get(preset.roleConfigId) ?? rules?.roles[preset.roleConfigId];
      const home = "homeMachineId" in overrides
        ? (typeof overrides.homeMachineId === "string" && overrides.homeMachineId.trim() ? overrides.homeMachineId.trim() : undefined)
        : preset.homeMachineId;
      return [{
        claim, approval: item,
        handle: handleKey(preset.handle),
        roleConfigId: preset.roleConfigId,
        ...(home ? { homeMachineId: home } : {}),
        agentMode: normalizeChatAgentMode("agentMode" in overrides ? overrides.agentMode : preset.agentMode),
        permissions: startingPermissions(role, "permissions" in overrides ? overrides.permissions : preset.permissions),
        ...(role ? { role } : {})
      }];
    }
    return [];
  });
}

/** The members an approved removal takes out, by id. */
function approvedRemovals(item: Approved): string[] {
  if (item.approval.toolName !== APP_PARTICIPANTS_REQUEST_CHANGE_TOOL || item.request.kind !== "participant_removal" || !Array.isArray(item.request.operations)) return [];
  return (item.request.operations as Array<{ type?: unknown; participantId?: unknown }>)
    .flatMap((operation) => operation?.type === "remove_participant_from_chat" && typeof operation.participantId === "string" ? [operation.participantId] : []);
}

/** Whether a member added is the one an approved addition adds: its name,
 *  role, place and mode, with no right beyond what was approved. */
function isApprovedMember(member: ChatParticipant, approved: ApprovedMember, rules: HubMemberRules | undefined): boolean {
  if (handleKey(member.handle) !== approved.handle) return false;
  // The role she saw: one she has (the member takes exactly it), or one the
  // same request makes (a role her published rules do not know yet).
  if (approved.newRole ? !rules || Boolean(rules.roles[member.roleConfigId]) : approved.roleConfigId === undefined || member.roleConfigId !== approved.roleConfigId) return false;
  if ((member.homeMachineId || undefined) !== approved.homeMachineId) return false;
  // A mode that skips asking (Auto, Codex's Full Access) only as far as she approved.
  const memberMode = normalizeChatAgentMode(member.agentMode);
  if ((memberMode === "auto" || memberMode === "full-access") && !chatAgentModeWithin(memberMode, approved.agentMode)) return false;
  // Added in its CLI's own mode (a chat with a main session: ChatService
  // inCliOwnModeInMainSessionChat), it asks about what it was not granted
  // instead of being refused it: not a right beyond what she approved.
  const { cliApprovals: _ownMode, codexPlanMode: _plan, ...rights } = normalizeChatAgentPermissions(member.permissions);
  const memberRights = normalizeChatAgentPermissions(member.permissions).cliApprovals && !normalizeChatAgentPermissions(approved.permissions).cliApprovals
    ? rights as ChatAgentPermissions
    : normalizeChatAgentPermissions(member.permissions);
  if (!permissionsWithin(memberRights, approved.permissions)) return false;
  // Managing members as its role gives it now, never beyond what she saw.
  const actual = Math.max(rank(manageRight(rules?.roles[member.roleConfigId], member.permissions).effective),
    rank(manageRight(approved.role, member.permissions).effective));
  return actual <= rank(manageRight(approved.role, approved.permissions).effective);
}

/** Whether the app would have added this member for one of the machine's
 *  members, and how: one that may change members without a card (unless the
 *  new member would manage members beyond its role) — in a chat with a main
 *  session, with nothing beyond its own rights and the main session's, as
 *  the server has them before this write, wherever the new member runs —
 *  or the User's approval of this very addition, one member for each she
 *  approved ("card"). */
export function additionAllowed(member: ChatParticipant, changes: MemberChanges): ChatParticipant | "card" | undefined {
  const { rules, mainSession } = changes;
  const role = rules?.roles[member.roleConfigId];
  const preset = member.participantConfigId ? rules?.presets[member.participantConfigId] : undefined;
  const escalates = manageRight(role, member.permissions).exceedsRoleDefault ||
    (preset !== undefined && chatParticipantRequestPermissionExceeds(manageRight(role, member.permissions).effective, manageRight(role, preset.permissions).effective));
  if (!escalates) {
    // Codex's Full Access and scheduled tasks without a card only by the
    // User's choice: without a main session whose own they are (the app
    // hands a main session's mode and rights to the members it makes), a
    // member in Full Access is added only on her card, and one with that
    // right not at all (no card gives it).
    const adders = changes.machineMembers.filter((requester) => managesWithoutCard(requester, rules, changes.policies, mainSession) &&
      (!mainSession
        ? normalizeChatAgentMode(member.agentMode) !== "full-access" && !normalizeChatAgentPermissions(member.permissions).scheduleWithoutAsking
        : withinMember(member, requester, rules) && withinMember(member, mainSession, rules)));
    // The member the machine names as the one that added it, when it is one.
    const named = adders.find((requester) => requester.id === member.delegatedByParticipantId);
    if (named ?? adders[0]) return named ?? adders[0];
  }
  for (const item of changes.approved) {
    if (!changes.machineMembers.some((requester) => requester.id === item.card.participantId)) continue;
    const match = approvedMembers(item, rules).find((candidate) => !changes.claimed.has(candidate.claim) && isApprovedMember(member, candidate, rules));
    if (match) {
      changes.claimed.add(match.claim);
      changes.noted.add(item.key);
      return "card";
    }
  }
  return undefined;
}

/** Whether a member added without a card has nothing beyond `main`'s rights
 *  (the app's clampChatAgentPermissions and additionsExceedMainSession): its
 *  mode, what it may do in that mode, and its right to manage members. */
function withinMember(member: ChatParticipant, main: ChatParticipant, rules: HubMemberRules | undefined): boolean {
  const mainMode = normalizeChatAgentMode(main.agentMode);
  const memberMode = normalizeChatAgentMode(member.agentMode);
  if (!chatAgentModeWithin(memberMode, mainMode)) return false;
  const ceiling = effectiveChatAgentPermissionsForProvider(main.kind, mainMode, normalizeChatAgentPermissions(main.permissions));
  if (!chatAgentPermissionsWithin(effectiveChatAgentPermissionsForProvider(member.kind, memberMode, normalizeChatAgentPermissions(member.permissions)), ceiling)) return false;
  return rank(manageRight(rules?.roles[member.roleConfigId], member.permissions).effective) <=
    rank(manageRight(rules?.roles[main.roleConfigId], main.permissions).effective);
}

/** Whether the app would have taken this member out for one of the
 *  machine's members: one that may change members without a card, or the
 *  User's approval of its removal. */
export function removalAllowed(member: ChatParticipant, changes: MemberChanges, mainSessionId: unknown): boolean {
  // The Chat Assistant stays, as in the app, and so does the main session.
  if (member.roleConfigId === CHAT_ASSISTANT_ROLE_ID) return false;
  if (member.roleConfigId === MAIN_SESSION_ROLE_ID || member.id === mainSessionId) return false;
  if (changes.machineMembers.some((requester) => managesWithoutCard(requester, changes.rules, changes.policies, changes.mainSession))) return true;
  const answer = changes.approved.find((item) => changes.machineMembers.some((requester) => requester.id === item.card.participantId) &&
    approvedRemovals(item).includes(member.id));
  if (answer) changes.noted.add(answer.key);
  return Boolean(answer);
}

/** Whether a rule to act without a card is the one the app keeps for the
 *  User's "Allow for this chat" on this approval (chat.ts
 *  upsertRosterChatPolicy, and the tool permission branch of
 *  respondToAppToolApproval). */
export function isPolicyFor(policy: ChatAppToolApprovalPolicy, item: Approved): boolean {
  const approval = item.approval;
  if (item.scope !== "chat" || policy.scope !== "chat" || policy.targetParticipantId) return false;
  if (policy.participantId !== approval.requesterParticipantId || policy.roleConfigId !== approval.requesterRoleConfigId) return false;
  if (policy.toolName !== approval.toolName || policy.capability !== approval.capability) return false;
  if (approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL) return !policy.targetToolName;
  // The other tools that get such a rule are tool permissions, named by the
  // tool they allow; member and member-request tools never do.
  if (approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL || approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL) return false;
  const request = approval.request as { toolName?: unknown; chatScope?: unknown } | undefined;
  const tool = request?.toolName;
  if (typeof tool !== "string" || policy.targetToolName !== tool) return false;
  // Scoped as the card the User answered was (a command prefix, a domain, a
  // folder; src/shared/toolPermissionScope.ts): never broader, and never the
  // whole of a tool whose answer is scoped.
  const scope = normalizeChatToolPermissionScope(request?.chatScope);
  if (chatToolPermissionIsScoped(tool)) return Boolean(scope) && chatToolPermissionScopesEqual(policy.targetToolScope, scope);
  return policy.targetToolScope === undefined;
}

// --- a machine's change -------------------------------------------------------

/** Whether a machine's change touches the members or the rules (only then
 *  are the User's approvals and rules read). */
export function changesMembers(update: Update): boolean {
  return update.metadata?.participants !== undefined || update.metadata?.appToolApprovalPolicies !== undefined ||
    Boolean(update.removedMetadataKeys?.some((key) => key === "participants" || key === "appToolApprovalPolicies"));
}
