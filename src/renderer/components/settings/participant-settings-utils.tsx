import type { AppSettings, ChatParticipantConfig, ChatProviderKind } from "../../../shared/types";
import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../shared/agentPermissions";
import { participantProviderLabel } from "../chat/chat-conversation-data";
import type { ChatParticipantDraft } from "../chat/chat-participant-drafts";
import { chatParticipantConfigToDraft, defaultChatParticipantDraft } from "../chat/chat-participant-drafts";

export interface ParticipantRoleGroup {
  id: string;
  label: string;
  participants: ChatParticipantConfig[];
}

export type ParticipantEditorState =
  | { type: "new" }
  | { type: "edit"; participant: ChatParticipantConfig };

export function participantRoleGroups(settings: AppSettings): ParticipantRoleGroup[] {
  const roleOrder = new Map(settings.chatRoleConfigs.map((role, index) => [role.id, index]));
  const labels = new Map(settings.chatRoleConfigs.map((role) => [role.id, role.label]));
  const groups = new Map<string, ParticipantRoleGroup>();
  for (const participant of settings.chatParticipantConfigs) {
    const id = participant.roleConfigId;
    const existing = groups.get(id);
    if (existing) {
      existing.participants.push(participant);
      continue;
    }
    groups.set(id, {
      id,
      label: labels.get(id) ?? id,
      participants: [participant]
    });
  }
  return Array.from(groups.values()).sort((left, right) => {
    const leftIndex = roleOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = roleOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex === rightIndex ? left.label.localeCompare(right.label) : leftIndex - rightIndex;
  });
}

export function participantMatchesQuery(
  participant: ChatParticipantConfig,
  roleLabel: string,
  query: string
): boolean {
  return [participant.handle, roleLabel, participantProviderLabel(participant.kind), participant.model ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

export function providerSummary(participants: ChatParticipantConfig[]): string {
  const counts = new Map<string, number>();
  for (const participant of participants) {
    const label = participantProviderLabel(participant.kind);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");
}

export function participantModeLabel(participant: ChatParticipantConfig): string {
  switch (normalizeChatAgentMode(participant.agentMode)) {
    case "plan":
      return "Plan";
    case "auto":
      return "Auto-review";
    case "default":
    default:
      return "Custom Access";
  }
}

export function participantRules(settings: AppSettings, participant: ChatParticipantConfig): Array<{ id: string; label: string }> {
  const selected = new Set(participant.behaviorRuleIds ?? []);
  return settings.chatBehaviorRules
    .filter((rule) => selected.has(rule.id))
    .map((rule) => ({ id: rule.id, label: rule.label }));
}

export function participantPermissionChips(participant: ChatParticipantConfig): Array<{ key: string; label: string }> {
  const mode = normalizeChatAgentMode(participant.agentMode);
  if (mode !== "default") {
    return [];
  }
  const permissions = effectiveChatAgentPermissionsForProvider(
    participant.kind,
    mode,
    normalizeChatAgentPermissions(participant.permissions)
  );
  const nativeToolCount = permissions.providerNative?.["claude-code"]?.allowedTools.length ?? 0;
  return [
    permissions.repoRead ? { key: "repo", label: "repo read" } : undefined,
    permissions.workspaceWrite ? { key: "edit", label: "edit files" } : undefined,
    permissions.shell.enabled ? { key: "shell", label: permissions.shell.rules.length > 0 ? "shell rules" : "shell" } : undefined,
    permissions.webAccess ? { key: "web", label: "web access" } : undefined,
    nativeToolCount > 0 ? { key: "native", label: "native tools" } : undefined
  ].filter((item): item is { key: string; label: string } => Boolean(item));
}

export function initialDraft(
  settings: AppSettings,
  participant: ChatParticipantConfig | undefined,
  existingHandles: Set<string>
): ChatParticipantDraft {
  return participant ? chatParticipantConfigToDraft(participant) : defaultChatParticipantDraft(settings, existingHandles);
}

export function ParticipantEditorHandleField(props: { handle: string; onChange: (handle: string) => void }): JSX.Element {
  return (
    <span className="chat-app-tool-inline-handle participants-editor-handle-field">
      <span aria-hidden>@</span>
      <input
        value={props.handle}
        aria-label="Participant handle"
        spellCheck={false}
        size={Math.max(props.handle.length + 1, 4)}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </span>
  );
}

export function ParticipantEditorSwitch(props: {
  label: string;
  description?: string;
  checked: boolean;
  className?: string;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className={`participants-editor-toggle ${props.className ?? ""}`}>
      <span className="participants-editor-toggle-text">
        <strong>{props.label}</strong>
        {props.description?.trim() && <small>{props.description}</small>}
      </span>
      <span className="participants-editor-switch">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <span aria-hidden />
      </span>
    </label>
  );
}

export function providerClass(kind: ChatProviderKind): string {
  return kind === "codex-cli" ? "is-codex" : "is-claude";
}
