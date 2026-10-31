/**
 * What a cloud machine may change through the User's server: what concerns
 * the members that run on it, and nothing that would let it reach the
 * members that run elsewhere (the User's computer, another machine) further
 * than a member on the computer reaches them through the app.
 *
 * A machine runs agents with shell access; an agent that was tricked by what
 * it read can read the machine's own key and write to the server directly,
 * around the app. Through the app, a member on a machine changes exactly
 * what a member on the computer changes, under the same rules of the User;
 * these rules make the same hold for a write that goes around it. The server
 * knows which device wrote what, so it holds every machine to them; nothing
 * the machine says about itself counts:
 *
 * - members that run elsewhere stay as the server has them (their
 *   permissions, mode, tools, home), except that `/accord` gives the member
 *   it names leave to ask other members;
 * - a member that runs on the machine stays on it, keeps its role and its
 *   right to manage members, and gets leave to ask other members only as
 *   the app gives it: the User's "Allow for this chat" on its request, or
 *   `/accord` naming it;
 * - a rule that lets a member act without a card ("Allow for this chat") is
 *   added only where the User answered so, for the machine's own members,
 *   and goes with a member removed;
 * - a member is added as the app adds one: by a member there that may manage
 *   members without a card under her rules (her computer publishes them,
 *   HubMemberRules), or as she approved it on a card;
 * - the chat's project folder and other shared fields are not the machine's
 *   to change; its title only as the app names a new chat (once, by the
 *   member that answers first).
 *
 * A machine asks a member that runs elsewhere (machineMayAsk) as a member
 * asks another through the app: with leave to ask, or with the User's
 * approval of that request.
 *
 * Applied to every machine's `conversation.update` before it is kept, so a
 * machine with an old copy of the chat cannot write other members' old
 * values back either. Pure: the server's copy, what the User approved and
 * her rules in, the change it may make out.
 */

import {
  chatParticipantRequestPermissionExceeds,
  chatParticipantRequestPermissionRank,
  normalizeChatAgentMode,
  normalizeChatAgentPermissions,
  normalizeChatParticipantRequestPermission,
  resolveChatManageRolesParticipantsPermission
} from "../shared/agentPermissions";
import { APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROSTER_REQUEST_CHANGE_TOOL } from "../shared/appMcpToolContracts";
import type { HubCard, HubUserApproval } from "../shared/hubOps";
import type { HubMemberRules } from "../shared/hubProtocol";
import type {
  ChatAgentMode,
  ChatAgentPermissions,
  ChatAppToolApproval,
  ChatAppToolApprovalPolicy,
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestPermission,
  Conversation
} from "../shared/types";

type Update = { title?: string; repoPath?: string | null; metadata?: Record<string, unknown>; removedMetadataKeys?: string[] };

/** Where a member runs: what decides which device takes its turns. */
const HOME_FIELDS = ["homeMachineId", "cloudRun", "remoteExecution"] as const;

export interface MachineScopedUpdate {
  update: Update;
  /** What was left out, for the server's log. */
  refused: string[];
  /** What gave a lasting change here (an approval, an `/accord`): each gives
   *  it once, so the server notes it as used (grant keys, grantKey()). */
  used: string[];
}

/** What the machine's write is held to besides the chat itself. */
export interface MachineScopeContext {
  /** What the User approved on the cards this machine raised in the chat. */
  approvals?: HubUserApproval[];
  /** What already gave its lasting change (grant keys). */
  used?: ReadonlySet<string>;
  /** Her rules for members, as her computer last published them. */
  rules?: HubMemberRules;
}

/** How a used approval or `/accord` is noted on the server. */
export function approvalGrantKey(answerOpId: string): string {
  return `approval:${answerOpId}`;
}

function askGrantKey(answerOpId: string, participantId: string): string {
  return `ask:${answerOpId}:${participantId}`;
}

function accordGrantKey(messageId: string, participantId: string): string {
  return `accord:${messageId}:${participantId}`;
}

function participantsOf(value: unknown): ChatParticipant[] {
  return Array.isArray(value) ? value.filter((item): item is ChatParticipant => Boolean(item) && typeof (item as { id?: unknown }).id === "string") : [];
}

function policiesOf(value: unknown): ChatAppToolApprovalPolicy[] {
  return Array.isArray(value) ? value.filter((item): item is ChatAppToolApprovalPolicy => Boolean(item) && typeof (item as { id?: unknown }).id === "string") : [];
}

export function runsOnMachine(participant: Pick<ChatParticipant, "homeMachineId"> | undefined, machineId: string | undefined): boolean {
  return Boolean(machineId && participant && typeof participant.homeMachineId === "string" && participant.homeMachineId === machineId);
}

function handleKey(handle: unknown): string {
  return typeof handle === "string" ? handle.trim().replace(/^@/, "").toLowerCase() : "";
}

function permissionsOf(participant: Pick<ChatParticipant, "permissions">): Record<string, unknown> {
  return participant.permissions && typeof participant.permissions === "object" ? participant.permissions as unknown as Record<string, unknown> : {};
}

function rank(value: ChatParticipantRequestPermission | undefined): number {
  return chatParticipantRequestPermissionRank(normalizeChatParticipantRequestPermission(value));
}

// --- what the User approved ---------------------------------------------------

interface Approved {
  card: HubUserApproval;
  approval: ChatAppToolApproval;
  /** What she approved: the request as she may have edited it. */
  request: Record<string, unknown>;
  scope: "once" | "chat";
  /** How the server notes it used. */
  key: string;
}

/** Approvals on permission and roster cards, for the member each waits on.
 *  One she answered again later (refused it, say) no longer counts; `used`
 *  leaves out those that already gave their lasting change. */
function approvedRequests(approvals: HubUserApproval[] | undefined, used?: ReadonlySet<string>): Approved[] {
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

function withoutCode(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\r\n]*`/g, "");
}

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
 *  as themselves (a machine writes those too). The message's id. */
function accordNaming(conversation: Conversation, member: ChatParticipant, used: ReadonlySet<string>): string | undefined {
  return conversation.messages.find((message) => {
    if (message.role !== "user" && message.role !== "participant") return false;
    if (message.role === "participant" && message.participantId === member.id) return false;
    if (message.metadata?.hiddenFromTimeline === true) return false;
    if (used.has(accordGrantKey(message.id, member.id))) return false;
    const skills = (message.metadata as { skillMentions?: unknown } | undefined)?.skillMentions;
    const accord = ACCORD.test(withoutCode(message.content ?? "")) ||
      (Array.isArray(skills) && skills.some((skill) => (skill as { frontmatterName?: unknown } | undefined)?.frontmatterName === "accord"));
    return accord && names(message, member);
  })?.id;
}

/** Whether the app would have given this member leave to ask other members:
 *  the User's "Allow for this chat" on a request it made (a request inferred
 *  from its reply only ever gets a one-time approval), or `/accord` naming
 *  it. What gave it is noted in `noted`, so it gives it once. */
function leaveGiven(conversation: Conversation, member: ChatParticipant, approved: Approved[], used: ReadonlySet<string>, noted: Set<string>): boolean {
  const answer = approved.find((item) => item.scope === "chat" && item.approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
    item.card.participantId === member.id && item.request.source !== "inferred");
  if (answer) {
    noted.add(answer.key);
    return true;
  }
  const accord = accordNaming(conversation, member, used);
  if (accord) noted.add(accordGrantKey(accord, member.id));
  return Boolean(accord);
}

function requestRight(participant: Pick<ChatParticipant, "permissions">): ChatParticipantRequestPermission {
  return normalizeChatParticipantRequestPermission(permissionsOf(participant).requestParticipants);
}

/** The member with its leave to ask other members as the server has it,
 *  unless the app would have given it the leave the machine asks for. */
function keepRequestRight(next: ChatParticipant, current: ChatParticipant, given: () => boolean): ChatParticipant {
  if (!chatParticipantRequestPermissionExceeds(requestRight(next), requestRight(current)) || given()) return next;
  const permissions = { ...permissionsOf(next) };
  const had = permissionsOf(current).requestParticipants;
  if (had === undefined) delete permissions.requestParticipants;
  else permissions.requestParticipants = had;
  return { ...next, permissions: permissions as unknown as ChatParticipant["permissions"] };
}

// --- its own members ----------------------------------------------------------

function keepHome(next: ChatParticipant, current: ChatParticipant): ChatParticipant {
  const merged = { ...next } as Record<string, unknown>;
  for (const field of HOME_FIELDS) {
    const value = (current as unknown as Record<string, unknown>)[field];
    if (value === undefined) delete merged[field];
    else merged[field] = value;
  }
  return merged as unknown as ChatParticipant;
}

/** A member keeps the role and the right to manage members the User gave it:
 *  the app never changes either on a machine. */
function keepRole(next: ChatParticipant, current: ChatParticipant): ChatParticipant {
  // Its name too: the app never renames a member on a machine, and a name
  // taken from another member would speak for that one.
  const named = next.handle === current.handle ? next : { ...next, handle: current.handle };
  const kept = named.roleConfigId === current.roleConfigId ? named : { ...named, roleConfigId: current.roleConfigId };
  const had = permissionsOf(current).manageRolesParticipants;
  if (permissionsOf(next).manageRolesParticipants === had) return kept;
  const permissions = { ...permissionsOf(next) };
  if (had === undefined) delete permissions.manageRolesParticipants;
  else permissions.manageRolesParticipants = had;
  return { ...kept, permissions: permissions as unknown as ChatParticipant["permissions"] };
}

/** A member that runs elsewhere, as the server has it; given leave to ask
 *  other members when `/accord` names it (and only that). */
function keepElsewhere(conversation: Conversation, next: ChatParticipant, current: ChatParticipant, used: ReadonlySet<string>, noted: Set<string>): ChatParticipant {
  if (requestRight(next) === "allow" && requestRight(current) !== "allow") {
    const accord = accordNaming(conversation, current, used);
    if (accord) {
      noted.add(accordGrantKey(accord, current.id));
      return { ...current, permissions: { ...permissionsOf(current), requestParticipants: "allow" } as unknown as ChatParticipant["permissions"] };
    }
  }
  return current;
}

// --- members it adds and removes ----------------------------------------------

/** The Chat Assistant's role (chat.ts CHAT_ADMINISTRATOR_ROLE_ID): every chat
 *  keeps it. */
const CHAT_ASSISTANT_ROLE_ID = "administrator";

type RoleRule = HubMemberRules["roles"][string];

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
function managesWithoutCard(member: ChatParticipant, rules: HubMemberRules | undefined, policies: ChatAppToolApprovalPolicy[]): boolean {
  const right = manageRight(rules?.roles[member.roleConfigId], member.permissions).effective;
  if (right === "allow") return true;
  if (right === "deny") return false;
  return policies.some((policy) => isRosterPolicy(policy, member));
}

/** The rights a member starts with when added without its own: its role's. */
function startingPermissions(rule: RoleRule | undefined, permissions: unknown): ChatAgentPermissions {
  const normalized = normalizeChatAgentPermissions(permissions);
  if (permissions !== undefined) return normalized;
  return {
    ...normalized,
    ...(rule?.requestParticipants ? { requestParticipants: rule.requestParticipants } : {}),
    requestCompaction: normalizeChatParticipantRequestPermission(rule?.requestCompaction)
  };
}

/** A member as an approved addition adds it. */
interface ApprovedMember {
  /** The approval and its operation: each adds one member. */
  claim: string;
  approval: Approved;
  handle: string;
  /** Its role; `newRole` when the same request makes the role (its id is
   *  given when it is made). */
  roleConfigId?: string;
  newRole?: boolean;
  homeMachineId?: string;
  agentMode: ChatAgentMode;
  permissions: ChatAgentPermissions;
  role?: RoleRule;
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

function memberChangeTool(toolName: string): boolean {
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

/** Whether a member's permissions give it nothing beyond `allowed`. */
function permissionsWithin(actual: ChatAgentPermissions, allowed: ChatAgentPermissions): boolean {
  if ((actual.repoRead && !allowed.repoRead) || (actual.workspaceWrite && !allowed.workspaceWrite) || (actual.webAccess && !allowed.webAccess)) return false;
  if (actual.shell.enabled && !allowed.shell.enabled) return false;
  const allowedRules = new Set(allowed.shell.rules.map((rule) => JSON.stringify(rule)));
  if (actual.shell.rules.some((rule) => rule.action !== "deny" && !allowedRules.has(JSON.stringify(rule)))) return false;
  if (actual.providerNative && JSON.stringify(actual.providerNative) !== JSON.stringify(allowed.providerNative)) return false;
  return rank(actual.requestParticipants) <= rank(allowed.requestParticipants) && rank(actual.requestCompaction) <= rank(allowed.requestCompaction);
}

/** Whether a member added is the one an approved addition adds: its name,
 *  role, place and mode, with no right beyond what was approved. */
function isApprovedMember(member: ChatParticipant, approved: ApprovedMember, rules: HubMemberRules | undefined): boolean {
  if (handleKey(member.handle) !== approved.handle) return false;
  // The role she saw: one she has (the member takes exactly it), or one the
  // same request makes (a role her published rules do not know yet).
  if (approved.newRole ? !rules || Boolean(rules.roles[member.roleConfigId]) : approved.roleConfigId === undefined || member.roleConfigId !== approved.roleConfigId) return false;
  if ((member.homeMachineId || undefined) !== approved.homeMachineId) return false;
  if (normalizeChatAgentMode(member.agentMode) === "auto" && approved.agentMode !== "auto") return false;
  if (!permissionsWithin(normalizeChatAgentPermissions(member.permissions), approved.permissions)) return false;
  // Managing members as its role gives it now, never beyond what she saw.
  const actual = Math.max(rank(manageRight(rules?.roles[member.roleConfigId], member.permissions).effective),
    rank(manageRight(approved.role, member.permissions).effective));
  return actual <= rank(manageRight(approved.role, approved.permissions).effective);
}

/** What a machine's member changes are held to, for one write. */
interface MemberChanges {
  machineMembers: ChatParticipant[];
  policies: ChatAppToolApprovalPolicy[];
  approved: Approved[];
  rules: HubMemberRules | undefined;
  /** Approved additions already taken by a member in this write. */
  claimed: Set<string>;
  noted: Set<string>;
}

/** Whether the app would have added this member for one of the machine's
 *  members: one that may change members without a card (unless the new
 *  member would manage members beyond its role), or the User's approval of
 *  this very addition — one member for each she approved. */
function additionAllowed(member: ChatParticipant, changes: MemberChanges): boolean {
  const { rules } = changes;
  const role = rules?.roles[member.roleConfigId];
  const preset = member.participantConfigId ? rules?.presets[member.participantConfigId] : undefined;
  const escalates = manageRight(role, member.permissions).exceedsRoleDefault ||
    (preset !== undefined && chatParticipantRequestPermissionExceeds(manageRight(role, member.permissions).effective, manageRight(role, preset.permissions).effective));
  if (!escalates && changes.machineMembers.some((requester) => managesWithoutCard(requester, rules, changes.policies))) return true;
  for (const item of changes.approved) {
    if (!changes.machineMembers.some((requester) => requester.id === item.card.participantId)) continue;
    const match = approvedMembers(item, rules).find((candidate) => !changes.claimed.has(candidate.claim) && isApprovedMember(member, candidate, rules));
    if (match) {
      changes.claimed.add(match.claim);
      changes.noted.add(item.key);
      return true;
    }
  }
  return false;
}

/** Whether the app would have taken this member out for one of the
 *  machine's members: one that may change members without a card, or the
 *  User's approval of its removal. */
function removalAllowed(member: ChatParticipant, changes: MemberChanges): boolean {
  // The Chat Assistant stays, as in the app.
  if (member.roleConfigId === CHAT_ASSISTANT_ROLE_ID) return false;
  if (changes.machineMembers.some((requester) => managesWithoutCard(requester, changes.rules, changes.policies))) return true;
  const answer = changes.approved.find((item) => changes.machineMembers.some((requester) => requester.id === item.card.participantId) &&
    approvedRemovals(item).includes(member.id));
  if (answer) changes.noted.add(answer.key);
  return Boolean(answer);
}

/** Whether a rule to act without a card is the one the app keeps for the
 *  User's "Allow for this chat" on this approval (chat.ts
 *  upsertRosterChatPolicy, and the tool permission branch of
 *  respondToAppToolApproval). */
function isPolicyFor(policy: ChatAppToolApprovalPolicy, item: Approved): boolean {
  const approval = item.approval;
  if (item.scope !== "chat" || policy.scope !== "chat" || policy.targetParticipantId) return false;
  if (policy.participantId !== approval.requesterParticipantId || policy.roleConfigId !== approval.requesterRoleConfigId) return false;
  if (policy.toolName !== approval.toolName || policy.capability !== approval.capability) return false;
  if (approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL) return !policy.targetToolName;
  // The other tools that get such a rule are tool permissions, named by the
  // tool they allow; member and member-request tools never do.
  if (approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL || approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL) return false;
  const tool = (approval.request as { toolName?: unknown } | undefined)?.toolName;
  return typeof tool === "string" && policy.targetToolName === tool;
}

// --- the chat's name ----------------------------------------------------------

/** The app names a new chat once, from the first member's answer: a machine
 *  whose member answered first names it the same way. */
function namesNewChat(conversation: Conversation, update: Update, machineMembers: ChatParticipant[]): boolean {
  const current = (conversation.metadata ?? {}) as Record<string, unknown>;
  if (current.autoTitle !== undefined) return false;
  const named = update.metadata?.autoTitle as { source?: unknown; title?: unknown; participantId?: unknown } | undefined;
  return Boolean(named) && named!.source === "first-agent" && named!.title === update.title &&
    machineMembers.some((member) => member.id === named!.participantId);
}

// --- a machine's change -------------------------------------------------------

/** Whether a machine's change touches the members or the rules (only then
 *  are the User's approvals and rules read). */
export function changesMembers(update: Update): boolean {
  return update.metadata?.participants !== undefined || update.metadata?.appToolApprovalPolicies !== undefined ||
    Boolean(update.removedMetadataKeys?.some((key) => key === "participants" || key === "appToolApprovalPolicies"));
}

export function scopeMachineConversationUpdate(conversation: Conversation, update: Update, machineId: string | undefined, context: MachineScopeContext = {}): MachineScopedUpdate {
  const refused: string[] = [];
  const scoped: Update = {};
  const current = (conversation.metadata ?? {}) as Record<string, unknown>;
  const before = participantsOf(current.participants);
  const beforeById = new Map(before.map((participant) => [participant.id, participant]));
  const ownBefore = before.filter((participant) => runsOnMachine(participant, machineId));
  const naming = update.title !== undefined && update.title !== conversation.title && namesNewChat(conversation, update, ownBefore);
  if (naming) scoped.title = update.title;
  else if (update.title !== undefined && update.title !== conversation.title) refused.push("title");
  if (update.repoPath !== undefined && (update.repoPath ?? undefined) !== conversation.repoPath) refused.push("repoPath");
  const metadata: Record<string, unknown> = { ...(update.metadata ?? {}) };
  const next: Record<string, unknown> = {};
  if (naming) next.autoTitle = metadata.autoTitle;
  for (const key of Object.keys(metadata)) {
    if (key === "participants" || key === "appToolApprovalPolicies" || (key === "autoTitle" && naming)) continue;
    if (JSON.stringify(metadata[key]) !== JSON.stringify(current[key])) refused.push(key);
  }
  // A key taken away is a list emptied: the rules a machine may drop (its own
  // members') go; anything else it takes away stays.
  const removed = new Set(update.removedMetadataKeys ?? []);
  for (const key of removed) if (key !== "appToolApprovalPolicies") refused.push(`-${key}`);
  if (removed.has("appToolApprovalPolicies") && metadata.appToolApprovalPolicies === undefined) metadata.appToolApprovalPolicies = [];

  // A lasting change comes from an approval or an `/accord` once: a later
  // write citing it again (an old copy, or a write around the app after the
  // User took the right back) does not count.
  const used = context.used ?? new Set<string>();
  const beforePolicies = policiesOf(current.appToolApprovalPolicies);
  const changes: MemberChanges = {
    machineMembers: ownBefore, policies: beforePolicies, approved: approvedRequests(context.approvals, used), rules: context.rules,
    claimed: new Set(), noted: new Set()
  };
  let members = before;
  if (metadata.participants !== undefined) {
    const proposed = participantsOf(metadata.participants);
    const proposedIds = new Set(proposed.map((participant) => participant.id));
    const taken: ChatParticipant[] = [];
    members = proposed.flatMap((participant) => {
      const existing = beforeById.get(participant.id);
      if (!existing) {
        // A name another member has would speak for that one.
        const clash = [...beforeById.values(), ...taken].some((other) => other.id !== participant.id && handleKey(other.handle) === handleKey(participant.handle));
        if (!clash && additionAllowed(participant, changes)) {
          taken.push(participant);
          return [participant];
        }
        refused.push(`participants.${participant.id}.added`);
        return [];
      }
      if (runsOnMachine(existing, machineId)) {
        const kept = keepRequestRight(keepRole(keepHome(participant, existing), existing), existing, () => leaveGiven(conversation, existing, changes.approved, used, changes.noted));
        if (JSON.stringify(kept) !== JSON.stringify(participant)) refused.push(`participants.${participant.id}.rights`);
        return [kept];
      }
      const kept = keepElsewhere(conversation, participant, existing, used, changes.noted);
      if (JSON.stringify(kept) !== JSON.stringify(participant)) refused.push(`participants.${participant.id}`);
      return [kept];
    });
    // A member left out (taken out, or missing from an old copy) goes only
    // as the app takes one out; otherwise it stays.
    for (const participant of before) {
      if (proposedIds.has(participant.id) || removalAllowed(participant, changes)) continue;
      refused.push(`participants.${participant.id}.removed`);
      members.push(participant);
    }
    // The last member stays, as in the app.
    if (!members.length && before.length) {
      refused.push("participants.last");
      members = before;
    }
    next.participants = members;
  }

  if (metadata.appToolApprovalPolicies !== undefined || metadata.participants !== undefined) {
    const present = new Set(members.map((participant) => participant.id));
    const own = (policy: ChatAppToolApprovalPolicy) => runsOnMachine(members.find((participant) => participant.id === policy.participantId), machineId);
    // A rule goes with a member removed (the app removes the rules it owns
    // and those aimed at it).
    const stays = (policy: ChatAppToolApprovalPolicy) => present.has(policy.participantId) && (!policy.targetParticipantId || present.has(policy.targetParticipantId));
    // A rule is the User's "Allow for this chat" on one of the member's
    // requests, as the app keeps it: one the machine adds without it, or
    // shaped otherwise, does not count. (The same answer that added members
    // in this write keeps the rule it gives.)
    const answered = (policy: ChatAppToolApprovalPolicy) => {
      if (beforePolicies.some((item) => item.id === policy.id && JSON.stringify(item) === JSON.stringify(policy))) return true;
      const answer = changes.approved.find((item) => isPolicyFor(policy, item));
      if (answer) changes.noted.add(answer.key);
      return Boolean(answer);
    };
    if (metadata.appToolApprovalPolicies !== undefined) {
      const proposed = policiesOf(metadata.appToolApprovalPolicies);
      const kept = [
        ...proposed.filter((policy) => own(policy) && stays(policy) && answered(policy)),
        ...beforePolicies.filter((policy) => !own(policy) && stays(policy))
      ];
      for (const policy of proposed) {
        if (!kept.includes(policy) && !beforePolicies.some((item) => item.id === policy.id && JSON.stringify(item) === JSON.stringify(policy))) refused.push(`appToolApprovalPolicies.${policy.id}`);
      }
      next.appToolApprovalPolicies = kept;
    } else {
      // Members removed without the rules in the same write: their rules go
      // anyway, so a member added again later does not find them waiting.
      const pruned = beforePolicies.filter(stays);
      if (pruned.length !== beforePolicies.length) next.appToolApprovalPolicies = pruned;
    }
  }

  if (Object.keys(next).length) scoped.metadata = next;
  return { update: scoped, refused, used: [...changes.noted] };
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
  if (requestRight(requester) === "allow") return true;
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
  return !requester || requestRight(requester) !== "allow";
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
 *  requests, member changes and mentions as she saw them; for a tool
 *  permission she allowed for the chat, only which tool (its input, a file's
 *  content say, is not needed); nothing else. */
export function keptApproval(card: HubCard): HubCard | undefined {
  if (card.cardKind === "mention") return card;
  if (card.cardKind !== "permission" && card.cardKind !== "roster") return undefined;
  const approval = (card.card as { approval?: ChatAppToolApproval } | undefined)?.approval;
  if (!approval || typeof approval !== "object") return undefined;
  if (approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL || memberChangeTool(approval.toolName)) return card;
  if ((card.answer as { scope?: unknown } | undefined)?.scope !== "chat") return undefined;
  const tool = (approval.request as { toolName?: unknown } | undefined)?.toolName;
  const { draftOverride: _draft, ...answer } = (card.answer ?? {}) as Record<string, unknown>;
  return {
    ...card,
    answer,
    card: { approval: { ...approval, request: (typeof tool === "string" ? { toolName: tool } : {}) as ChatAppToolApproval["request"] } }
  };
}
