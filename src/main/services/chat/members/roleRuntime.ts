import { createHash, randomUUID } from "node:crypto";
import type {
  ChatAgentMode, ChatAgentPermissions, ChatBehaviorRuleSnapshot, ChatMessage, ChatParticipant, ChatParticipantRequestPermission,
  ChatParticipantSession, ChatProviderKind, ChatRoleConfig, ChatRoleRuntime, Conversation, ParticipantConfig
} from "../../../../shared/types";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import {
  effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions,
  resolveChatManageRolesParticipantsPermission
} from "../../../../shared/agentPermissions";
import { chatAppToolCapabilitiesEqual, normalizeChatAppToolCapabilities } from "../../../../shared/appTools";
import { normalizeBehaviorRuleIds, normalizedModel, participantHostDefaultModel } from "./identity";
import type { ResolvedChatParticipantRole } from "../types";

/** 23: the session's instructions carry everything said once (how messages
 *  arrive, handle rules, Claude's execution model, access) and Claude Code
 *  gets them as its appended system prompt on every launch; a session made
 *  before is given them once in its next message. 24: a message's app notes
 *  and whatever someone other than User wrote stand in blocks carrying the
 *  message's nonce, and the instructions say only text outside them is
 *  User's (buildPromptParts). 25: User's preferences go into the shared
 *  memory as well as the CLI's own (MEMBER_MEMORY_INSTRUCTIONS). 26: a
 *  member starts an Accord with app_chat_start_accord when it has the tool
 *  (Settings → General → "Any agent can start an Accord"), else asks the main
 *  session (mainSessionMemberRules). */
const CHAT_ROLE_RUNTIME_CONFIG_VERSION = 26;

export function memoryIndexKey(conversationId: string, participantId: string): string {
  return `${conversationId}\u0000${participantId}`;
}

export function manageRolesParticipantsPermissionForSession(session: ChatParticipantSession): ChatParticipantRequestPermission {
  return resolveChatManageRolesParticipantsPermission(
    session.roleParticipantDefaults?.manageRolesParticipants,
    session.participantPermissions?.manageRolesParticipants
  ).effective;
}

export function appMcpClientGenerationIdFor(
  conversation: Conversation,
  participant: ChatParticipant,
  session: ChatParticipantSession,
  appMcpToolInventoryKey: string
): string {
  return [
    conversation.id,
    participant.id,
    appMcpToolInventoryKey,
    session.appMcpClientGeneration ?? 0
  ].join(":");
}

export function roleRuntimeName(participant: ChatParticipant, session: ChatParticipantSession): string {
  const base = `accordagents-${participant.handle}-${session.roleConfigId}-${participant.id.slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return base || `accordagents-${participant.id.slice(0, 8)}`;
}

export function refreshExistingSessionForParticipant(
  existing: ChatParticipantSession,
  participant: ChatParticipant,
  role: ResolvedChatParticipantRole | undefined,
  runtimeConfigVersion: number
): ChatParticipantSession {
  const participantKind = existing.participantKind ?? participant.kind;
  return {
    ...existing,
    executionSessionId: existing.executionSessionId?.trim() || randomUUID(),
    roleConfigVersion: role?.version ?? existing.roleConfigVersion,
    roleAppToolCapabilities: role
      ? normalizeChatAppToolCapabilities(role.appToolCapabilities)
      : normalizeChatAppToolCapabilities(existing.roleAppToolCapabilities),
    roleParticipantDefaults: role?.participantDefaults ?? existing.roleParticipantDefaults,
    // A Claude Code or Codex session that fell back to instructions in its
    // messages tries its CLI's own mechanism again when the instructions
    // change shape (its messages no longer repeat them; the fallback marks
    // it again if the CLI still refuses).
    roleRuntime: isKnownRoleRuntime(existing.roleRuntime) &&
      !(existing.roleRuntime === "prompt-fallback" && participantKind !== "gemini-cli" && existing.runtimeConfigVersion !== runtimeConfigVersion)
      ? existing.roleRuntime
      : preferredRoleRuntimeForKind(participantKind),
    participantKind,
    participantModel: normalizedModel(participant.model) || undefined,
    participantReasoningEffort: normalizeChatReasoningEffort(participant.reasoningEffort, participantKind),
    participantBehaviorRules: role?.behaviorRules ?? existing.participantBehaviorRules ?? [],
    // Adopt the participant's current launch settings so a mode/permission change
    // takes effect on the next turn. We keep resuming the session (no reset): the
    // provider re-asserts the profile on resume — the Codex app-server resume params
    // and the one-shot `exec resume` both send sandbox/approval/web from these.
    participantAgentMode: normalizeChatAgentMode(participant.agentMode),
    participantPermissions: normalizeChatAgentPermissions(participant.permissions),
    runtimeConfigVersion,
    roleLabel: role?.label ?? existing.roleLabel,
    roleInstructions: role?.instructions ?? existing.roleInstructions,
    updatedAt: new Date().toISOString()
  };
}

export function roleSnapshotChanged(session: ChatParticipantSession, role: ResolvedChatParticipantRole): boolean {
  return (
    session.roleConfigVersion !== role.version ||
    session.roleLabel !== role.label ||
    session.roleInstructions !== role.instructions ||
    !chatAppToolCapabilitiesEqual(session.roleAppToolCapabilities, role.appToolCapabilities) ||
    JSON.stringify(session.roleParticipantDefaults ?? {}) !== JSON.stringify(role.participantDefaults ?? {}) ||
    !behaviorRuleSnapshotsEqual(session.participantBehaviorRules, role.behaviorRules)
  );
}

export function runtimeConfigVersionFor(_participant: ChatParticipant): number {
  return CHAT_ROLE_RUNTIME_CONFIG_VERSION;
}

export function preferredRoleRuntimeFor(participant: ChatParticipant): ChatRoleRuntime {
  return preferredRoleRuntimeForKind(participant.kind);
}

function preferredRoleRuntimeForKind(kind: ChatProviderKind): ChatRoleRuntime {
  if (kind === "claude-code") {
    return "claude-agent";
  }
  // Antigravity print mode has no native role/agent registration; roles are
  // delivered through the prompt on the session's first turn.
  if (kind === "gemini-cli") {
    return "prompt-fallback";
  }
  return "codex-developer-instructions";
}

export function isKnownRoleRuntime(value: ChatRoleRuntime | undefined): value is ChatRoleRuntime {
  return value === "claude-agent" || value === "codex-developer-instructions" || value === "prompt-fallback";
}

export function agentModeForSession(session: ChatParticipantSession, participant: ChatParticipant): ChatAgentMode {
  return normalizeChatAgentMode(session.participantAgentMode ?? participant.agentMode);
}

export function cliParticipantForSession(participant: ChatParticipant, session: ChatParticipantSession): ParticipantConfig {
  return {
    id: participant.id,
    kind: session.participantKind ?? participant.kind,
    label: `@${participant.handle}`,
    // A member on an added provider never inherits the CLI's default model:
    // that alias (e.g. "opus[1m]") only exists on the first-party side.
    model: normalizedModel(session.participantModel) || participantHostDefaultModel(participant),
    reasoningEffort: normalizeChatReasoningEffort(session.participantReasoningEffort, session.participantKind ?? participant.kind)
  };
}

export function runPathForParticipant(
  conversation: Conversation,
  participant: ChatParticipant,
  workspacePath: string,
  agentMode: ChatAgentMode,
  runPermissions: ChatAgentPermissions
): string {
  const permissions = effectiveChatAgentPermissionsForProvider(participant.kind, agentMode, runPermissions);
  return permissions.repoRead && conversation.repoPath ? conversation.repoPath : workspacePath;
}

export function warmAgentContextKey(
  conversation: Conversation,
  participant: ChatParticipant,
  session: ChatParticipantSession,
  runPath: string,
  workspacePath: string,
  runPermissions: ChatAgentPermissions,
  appMcpToolInventoryKey: string
): string {
  const participantKind = session.participantKind ?? participant.kind;
  // Scheduled tasks without a card is the app's own right: no process
  // starts anew for it.
  const { scheduleWithoutAsking: _appRight, ...permissions } = normalizeChatAgentPermissions(runPermissions);
  // In Claude Code's own modes the process is the same in every mode (only
  // --permission-mode differs, cliAgents claudeToolConfig): a new mode
  // (Manual and Accept edits differ only in the file-edit right) is set in
  // the live process, as Shift+Tab sets it in the CLI, instead of starting
  // a new one, which would lose its background work.
  const modeInProcess = participantKind === "claude-code" && permissions.cliApprovals === true;
  const { workspaceWrite: _modeRight, ...permissionsBesideMode } = permissions;
  return JSON.stringify({
    conversationId: conversation.id,
    participantId: participant.id,
    participantKind,
    participantModel: normalizedModel(session.participantModel),
    participantReasoningEffort: normalizeChatReasoningEffort(session.participantReasoningEffort, participantKind),
    ...(modeInProcess ? {} : { participantAgentMode: agentModeForSession(session, participant) }),
    participantPermissions: modeInProcess ? permissionsBesideMode : permissions,
    roleConfigId: session.roleConfigId,
    roleConfigVersion: session.roleConfigVersion,
    roleInstructionsHash: shortHash(session.roleInstructions),
    roleAppToolCapabilities: normalizeChatAppToolCapabilities(session.roleAppToolCapabilities),
    roleParticipantDefaults: session.roleParticipantDefaults ?? {},
    roleRuntime: session.roleRuntime ?? "",
    participantBehaviorRules: (session.participantBehaviorRules ?? []).map((rule) => ({
      id: rule.id,
      version: rule.version
    })),
    runtimeConfigVersion: session.runtimeConfigVersion ?? 0,
    appMcpClientGeneration: session.appMcpClientGeneration ?? 0,
    appMcpToolInventoryKey,
    runPath,
    workspacePath
  });
}

export function behaviorRuleSnapshotsForParticipant(
  participant: ChatParticipant,
  rules: Array<{ id: string; label: string; instructions: string; version: number }>
): ChatBehaviorRuleSnapshot[] {
  const selectedIds = normalizeBehaviorRuleIds(participant.behaviorRuleIds);
  return selectedIds
    .map((id) => rules.find((rule) => rule.id === id))
    .filter((rule): rule is ChatBehaviorRuleSnapshot => Boolean(rule))
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      instructions: rule.instructions,
      version: rule.version
    }));
}

export function roleInstructionsWithBehaviorRules(roleInstructions: string, behaviorRules: ChatBehaviorRuleSnapshot[]): string {
  if (behaviorRules.length === 0) {
    return roleInstructions;
  }
  return [
    roleInstructions,
    "",
    "## Participant Behavior Rules",
    "",
    "Apply these reusable behavior rules in addition to the role above. If a behavior rule conflicts with the user's current explicit request or higher-priority system/developer instructions, follow the higher-priority instruction.",
    "",
    ...behaviorRules.flatMap((rule) => [
      `### ${rule.label}`,
      rule.instructions,
      ""
    ])
  ].join("\n").trimEnd();
}

function behaviorRuleSnapshotsEqual(left: ChatBehaviorRuleSnapshot[] | undefined, right: ChatBehaviorRuleSnapshot[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function manageRolesParticipantsResolutionForRole(
  role: ChatRoleConfig | undefined,
  permissions: unknown
) {
  return resolveChatManageRolesParticipantsPermission(
    role?.participantDefaults?.manageRolesParticipants,
    normalizeChatAgentPermissions(permissions).manageRolesParticipants
  );
}

/** A Claude Code member takes the User's new messages while it works (see
 *  reserveParticipantTurn), wherever it runs. A native goal runs in a process
 *  of its own on the member's session, so it stays exclusive. */
export function participantTurnMode(participant: ChatParticipant, triggerMessage: ChatMessage): "exclusive" | "shared" {
  // A request asked with `deliver: "now"` goes into a Claude Code member's
  // live CLI as a message typed there mid-turn does (TurnQueue `live`).
  if (participant.kind === "claude-code" && deliversNow(triggerMessage, participant.id)) {
    return "shared";
  }
  // Only the User's own messages: a request from another member, a resume
  // after an approval or a continuation is not something the User types
  // into the CLI, and it still waits for the member's running turn.
  if (participant.kind !== "claude-code" || triggerMessage.role !== "user") {
    return "exclusive";
  }
  return triggerMessage.metadata?.nativeCommand?.name === "goal" ? "exclusive" : "shared";
}

/** A member request asked with `deliver: "now"` (app_chat_request_participants):
 *  the member takes it at once, even in the middle of a turn. */
export function deliversNow(triggerMessage: ChatMessage, participantId: string, mainSessionId?: string): boolean {
  const batch = triggerMessage.metadata?.participantRequest;
  // Only the chat's main session delivers now, checked again where the turn
  // runs (a copy from another device included).
  if (mainSessionId !== undefined && batch?.requesterParticipantId !== mainSessionId) return false;
  return batch?.items.some((item) => item.targetParticipantId === participantId && item.deliver === "now") === true;
}

/** How a busy member takes a message delivered now, as its dedicated CLI
 *  takes one typed mid-turn: Claude Code into its running turn (its queue
 *  hands it to the running step at the next tool result, and its send-now
 *  makes that happen now); Codex steers its running turn with it (Enter
 *  mid-turn in its CLI, `turn/steer`); a CLI that cannot take a message in
 *  the middle of a turn (Antigravity runs a process per turn) has the turn
 *  cut as Stop cuts it, and goes on with the message at once in the same
 *  session. */
export type DeliveryWay = "into-running-turn" | "interrupt-and-restart";

export function memberDeliveryWay(participant: Pick<ChatParticipant, "kind">): DeliveryWay {
  return participant.kind === "claude-code" || participant.kind === "codex-cli" ? "into-running-turn" : "interrupt-and-restart";
}
