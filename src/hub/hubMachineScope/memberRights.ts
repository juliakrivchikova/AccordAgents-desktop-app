import {
  chatAgentModeForKind, chatAgentPermissionsFromAgent, chatAgentPermissionsWithin, normalizeChatAgentMode,
  normalizeChatAgentPermissions, normalizeChatParticipantRequestPermission, normalizeChatShellPermissionRules,
  normalizeProviderNativeAllowedTools
} from "../../shared/agentPermissions";
import {
  APP_CHAT_REQUEST_COMPACTION_TOOL, APP_PERMISSIONS_REQUEST_CHANGE_TOOL, APP_TOOL_PERMISSION_TOOL
} from "../../shared/appMcpToolContracts";
import { claudePlanApprovalOption, claudePlanModeSettings, isClaudePlanApprovalRequest } from "../../shared/claudePlanApproval";
import type { ChatAgentMode, ChatAgentPermissions, ChatParticipant } from "../../shared/types";
import { lowerRight } from "./askRights";
import { permissionsOf, rank } from "./records";
import type { Approved, RoleRule } from "./types";

const MODE_RANK: Record<ChatAgentMode, number> = { plan: 0, default: 1, auto: 2, "full-access": 3 };

function shellRuleKey(rule: { action: string; match: string; pattern: string }): string {
  return `${rule.action}\0${rule.match}\0${rule.pattern}`;
}

/** What a permission change she approved for the chat adds (chat.ts
 *  applyPermissionChangeToPermissions). */
function withGrant(permissions: ChatAgentPermissions, request: Record<string, unknown>): ChatAgentPermissions {
  if (request.kind === "shellRules") {
    const rules = normalizeChatShellPermissionRules(request.rules);
    const seen = new Set(permissions.shell.rules.map(shellRuleKey));
    return { ...permissions, shell: { enabled: true, rules: [...permissions.shell.rules, ...rules.filter((rule) => !seen.has(shellRuleKey(rule)))] } };
  }
  if (request.kind === "providerNative") {
    const tools = [...new Set([...(permissions.providerNative?.["claude-code"]?.allowedTools ?? []), ...normalizeProviderNativeAllowedTools(request.allowedTools)])];
    return tools.length ? { ...permissions, providerNative: { "claude-code": { allowedTools: tools } } } : permissions;
  }
  if (request.kind === "portable" || Array.isArray(request.permissions)) {
    const granted = Array.isArray(request.permissions) ? request.permissions : [];
    return {
      ...permissions,
      repoRead: permissions.repoRead || granted.includes("repoRead"),
      workspaceWrite: permissions.workspaceWrite || granted.includes("workspaceWrite"),
      webAccess: permissions.webAccess || granted.includes("webAccess")
    };
  }
  return permissions;
}

/** What of `wanted` goes beyond `had` (leave to ask and managing members
 *  aside: keepRequestRight and keepRole hold those). A deny rule taken away
 *  goes beyond too. */
function rightsBeyond(wanted: ChatAgentPermissions, had: ChatAgentPermissions): boolean {
  if ((wanted.repoRead && !had.repoRead) || (wanted.workspaceWrite && !had.workspaceWrite) || (wanted.webAccess && !had.webAccess)) return true;
  if (wanted.shell.enabled && !had.shell.enabled) return true;
  // Running in its CLI's own mode, asking the User for what it is not
  // granted, is a right of its own (the app's chatAgentPermissionsWithin).
  if (wanted.cliApprovals && !had.cliApprovals) return true;
  // Creating scheduled tasks without a card: hers to give, never raised.
  if (wanted.scheduleWithoutAsking && !had.scheduleWithoutAsking) return true;
  const hadRules = new Set(had.shell.rules.map(shellRuleKey));
  if (wanted.shell.rules.some((rule) => rule.action !== "deny" && !hadRules.has(shellRuleKey(rule)))) return true;
  const wantedRules = new Set(wanted.shell.rules.map(shellRuleKey));
  if (had.shell.rules.some((rule) => rule.action === "deny" && !wantedRules.has(shellRuleKey(rule)))) return true;
  const hadTools = new Set(had.providerNative?.["claude-code"]?.allowedTools ?? []);
  if ((wanted.providerNative?.["claude-code"]?.allowedTools ?? []).some((tool) => !hadTools.has(tool))) return true;
  return rank(normalizeChatParticipantRequestPermission(wanted.requestCompaction)) > rank(normalizeChatParticipantRequestPermission(had.requestCompaction));
}

/** `wanted`, with nothing beyond `ceiling`: what goes beyond it is taken
 *  back to what `had` (the server's) has. */
function rightsWithin(wanted: ChatAgentPermissions, ceiling: ChatAgentPermissions): Partial<ChatAgentPermissions> {
  const ceilingRules = new Set(ceiling.shell.rules.map(shellRuleKey));
  const kept = wanted.shell.rules.filter((rule) => rule.action === "deny" || ceilingRules.has(shellRuleKey(rule)));
  const keptKeys = new Set(kept.map(shellRuleKey));
  const rules = [...kept, ...ceiling.shell.rules.filter((rule) => rule.action === "deny" && !keptKeys.has(shellRuleKey(rule)))];
  const ceilingTools = new Set(ceiling.providerNative?.["claude-code"]?.allowedTools ?? []);
  const tools = (wanted.providerNative?.["claude-code"]?.allowedTools ?? []).filter((tool) => ceilingTools.has(tool));
  const compaction = normalizeChatParticipantRequestPermission(wanted.requestCompaction);
  const compactionCeiling = normalizeChatParticipantRequestPermission(ceiling.requestCompaction);
  return {
    repoRead: wanted.repoRead && ceiling.repoRead,
    workspaceWrite: wanted.workspaceWrite && ceiling.workspaceWrite,
    webAccess: wanted.webAccess && ceiling.webAccess,
    requestCompaction: lowerRight(compaction, compactionCeiling),
    shell: { enabled: wanted.shell.enabled && ceiling.shell.enabled, rules },
    providerNative: tools.length ? { "claude-code": { allowedTools: tools } } : undefined,
    cliApprovals: wanted.cliApprovals && ceiling.cliApprovals ? true : undefined,
    scheduleWithoutAsking: wanted.scheduleWithoutAsking && ceiling.scheduleWithoutAsking ? true : undefined
  };
}

/** Its own member's mode and rights, never beyond what the server has for
 *  it (what the User set) but for what she granted it for the chat on its
 *  permission cards (app_permissions_request_change) and its compaction
 *  cards (app_chat_request_compaction, "Don't ask again"): the app on a machine
 *  raises neither otherwise, and a write around it could raise them and then
 *  add members as broad (docs/main-session.md). Less is always fine. A grant
 *  this write uses is noted, so it gives its change once. */
export function keepRights(next: ChatParticipant, current: ChatParticipant, approved: Approved[], noted: Set<string>): ChatParticipant {
  return keepAntigravityMode(keepGrantedRights(next, current, approved, noted), current);
}

/** Antigravity's own mode (`cliApprovals`) is what holds it back: without
 *  it, granted edits or Auto skip every agy confirmation (geminiExec.ts). A
 *  write that drops it while edits or Auto stay is broader, not less: the
 *  mode stays as the server has it (the app's clampChatAgentAccess). */
function keepAntigravityMode(next: ChatParticipant, current: ChatParticipant): ChatParticipant {
  if (current.kind !== "gemini-cli" || next.kind !== "gemini-cli") return next;
  const had = normalizeChatAgentPermissions(current.permissions);
  const wanted = normalizeChatAgentPermissions(next.permissions);
  if (!had.cliApprovals || wanted.cliApprovals || (!wanted.workspaceWrite && chatAgentModeForKind("gemini-cli", next.agentMode) !== "auto")) return next;
  return { ...next, permissions: { ...permissionsOf(next), cliApprovals: true } as unknown as ChatParticipant["permissions"] };
}

/** Claude Code's plan approvals she answered Yes on this member's cards:
 *  the CLI then moves the member into the mode she picked itself, and the
 *  app's mode follows it (the User, 2026-11-22). Each lets that mode be
 *  written once, and only the member's latest answered plan card counts
 *  (latestPlanAnswersOnly): an older one cannot raise a mode she lowered. */
function planModeGrants(approved: Approved[], member: ChatParticipant): Array<{ key: string; agentMode: ChatAgentMode; workspaceWrite?: boolean }> {
  return approved.flatMap((item) => {
    if (item.card.participantId !== member.id || item.approval.toolName !== APP_TOOL_PERMISSION_TOOL || !isClaudePlanApprovalRequest(item.approval.request)) return [];
    const decision = (item.card.answer as { planDecision?: { optionId?: unknown } } | undefined)?.planDecision;
    const option = claudePlanApprovalOption(item.approval.request.planApproval, typeof decision?.optionId === "string" ? decision.optionId : undefined);
    return option?.mode ? [{ key: item.key, ...claudePlanModeSettings(option.mode) }] : [];
  });
}

function keepGrantedRights(next: ChatParticipant, current: ChatParticipant, approved: Approved[], noted: Set<string>): ChatParticipant {
  let kept = next;
  const had = normalizeChatAgentPermissions(current.permissions);
  const wanted = normalizeChatAgentPermissions(next.permissions);
  const wantedMode = normalizeChatAgentMode(next.agentMode);
  const raisesMode = MODE_RANK[wantedMode] > MODE_RANK[normalizeChatAgentMode(current.agentMode)];
  const raisesEdits = wanted.workspaceWrite && !had.workspaceWrite;
  // A plan she approved: the mode she picked (Accept edits with its
  // file-edit right), the one that covers this write best.
  const plans = raisesMode || raisesEdits ? planModeGrants(approved, current) : [];
  const covers = (grant: { agentMode: ChatAgentMode; workspaceWrite?: boolean }): boolean =>
    (!raisesMode || MODE_RANK[grant.agentMode] >= MODE_RANK[wantedMode]) && (!raisesEdits || grant.workspaceWrite === true);
  const plan = plans.find(covers) ?? plans.find((grant) => raisesMode && MODE_RANK[grant.agentMode] >= MODE_RANK[wantedMode]);
  const planMode = Boolean(plan && raisesMode && MODE_RANK[plan.agentMode] >= MODE_RANK[wantedMode]);
  const planEdits = Boolean(plan && raisesEdits && plan.workspaceWrite === true);
  if (plan && (planMode || planEdits)) noted.add(plan.key);
  if (raisesMode && !planMode) {
    const { agentMode: _mode, ...rest } = kept;
    kept = current.agentMode === undefined ? rest : { ...rest, agentMode: current.agentMode };
  }
  const base = planEdits ? { ...had, workspaceWrite: true } : had;
  if (!rightsBeyond(wanted, base)) return kept;
  // Her "for the chat" answers on its own cards: a permission card grants
  // what it asked; a compaction card ("Don't ask again in this chat") lets
  // it compact without asking, and nothing else.
  const grants = approved.filter((item) => item.scope === "chat" && item.card.participantId === current.id &&
    (item.approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL || item.approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL));
  let ceiling = base;
  for (const grant of grants) {
    const raised = grant.approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL
      ? { ...ceiling, requestCompaction: "allow" as const }
      : withGrant(ceiling, grant.request);
    // Noted only when this write takes something it gives.
    if (rightsBeyond(raised, ceiling) && rightsBeyond(normalizeChatAgentPermissions({ ...rightsWithin(wanted, raised) }), ceiling)) noted.add(grant.key);
    ceiling = raised;
  }
  if (!rightsBeyond(wanted, ceiling)) return kept;
  const within = rightsWithin(wanted, ceiling);
  const permissions: Record<string, unknown> = { ...permissionsOf(next), ...within };
  if (!within.providerNative) delete permissions.providerNative;
  if (!within.cliApprovals) delete permissions.cliApprovals;
  if (!within.scheduleWithoutAsking) delete permissions.scheduleWithoutAsking;
  return { ...kept, permissions: permissions as unknown as ChatParticipant["permissions"] };
}

/** The rights a member starts with when added without its own: its role's. */
export function startingPermissions(rule: RoleRule | undefined, permissions: unknown): ChatAgentPermissions {
  const normalized = chatAgentPermissionsFromAgent(permissions);
  if (permissions !== undefined) return normalized;
  return {
    ...normalized,
    ...(rule?.requestParticipants ? { requestParticipants: rule.requestParticipants } : {}),
    requestCompaction: normalizeChatParticipantRequestPermission(rule?.requestCompaction)
  };
}

/** Whether a member's permissions give it nothing beyond `allowed` (the
 *  same rule the app holds a member the main session makes to,
 *  clampChatAgentPermissions). */
export function permissionsWithin(actual: ChatAgentPermissions, allowed: ChatAgentPermissions): boolean {
  return chatAgentPermissionsWithin(actual, allowed);
}
