import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../shared/agentPermissions";
import { chatReasoningEffortLabel, normalizeChatReasoningEffort, reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import type { ChatAgentMode, ChatExistingParticipantOverrides, ChatParticipantChangeRequest, ChatParticipantConfig, ChatProviderKind, ChatRoleConfig, ChatRosterChangeParticipantInput } from "../../../shared/types";
import { Avatar, avatarForParticipant } from "../avatar/avatar";
import { chatParticipantDisplayName, chatParticipantReference } from "../conversation/conversation-display";
import { avatarForChatParticipant, mapChatAvatarIdToKind } from "./chat-avatars";
import { CHAT_AGENT_MODE_OPTIONS, chatAgentModeLabel } from "./chat-participant-drafts";
import { ChatParticipantAvatarField as ChatAppToolAvatarField, ChatParticipantInlineAutoWatchRow as ChatAppToolInlineAutoWatchRow, ChatParticipantInlineModelRow as ChatAppToolInlineModelRow, ChatParticipantInlinePermissionsRow as ChatAppToolInlinePermissionsRow, ChatParticipantInlineRequestParticipantsRow as ChatAppToolInlineRequestParticipantsRow, ChatParticipantInlineSelectRow as ChatAppToolInlineSelectRow, ChatParticipantSpecRow, rosterPermissionGrantLabels } from "./chat-participant-config-panel";
import { participantProviderLabel } from "./chat-conversation-data";

export function ChatAppToolParticipantChangeOperation(props: {
  request: ChatParticipantChangeRequest;
  roles: ChatRoleConfig[];
  savedParticipants: ChatParticipantConfig[];
  onChange: (request: ChatParticipantChangeRequest) => void;
}): JSX.Element {
  function updateNewParticipant(
    index: number,
    patch: { saveAsPreset?: boolean; participant?: Partial<ChatRosterChangeParticipantInput> }
  ): void {
    props.onChange({
      ...props.request,
      operations: props.request.operations.map((operation, operationIndex): ChatParticipantChangeRequest["operations"][number] => {
        if (operationIndex !== index || operation.type !== "add_new_participant_to_chat") {
          return operation;
        }
        return {
          type: "add_new_participant_to_chat",
          saveAsPreset: patch.saveAsPreset ?? operation.saveAsPreset,
          participant: {
            ...operation.participant,
            ...(patch.participant ?? {})
          }
        };
      })
    });
  }

  // Chat-level override for a saved participant. The preset's current values seed the
  // override on first edit so its presence becomes authoritative without mutating the preset.
  function updateExistingOverride(index: number, patch: Partial<ChatExistingParticipantOverrides>): void {
    props.onChange({
      ...props.request,
      operations: props.request.operations.map((operation, operationIndex): ChatParticipantChangeRequest["operations"][number] => {
        if (operationIndex !== index || operation.type !== "add_existing_participant_to_chat") {
          return operation;
        }
        const preset = props.savedParticipants.find((participant) => participant.id === operation.participantConfigId);
        const baseline: ChatExistingParticipantOverrides = operation.overrides ?? {
          model: preset?.model,
          reasoningEffort: preset?.reasoningEffort,
          agentMode: preset?.agentMode,
          permissions: preset?.permissions,
          remoteExecution: preset?.remoteExecution,
          autoWatch: preset?.autoWatchEnabled === true
        };
        return {
          type: "add_existing_participant_to_chat",
          participantConfigId: operation.participantConfigId,
          overrides: { ...baseline, ...patch }
        };
      })
    });
  }

  return (
    <div className="chat-app-tool-review-stack">
      {props.request.operations.map((operation, index) => {
        if (operation.type === "add_existing_participant_to_chat") {
          const savedParticipant = props.savedParticipants.find((participant) => participant.id === operation.participantConfigId);
          const savedRole = savedParticipant ? props.roles.find((role) => role.id === savedParticipant.roleConfigId) : undefined;
          const savedAvatar = savedParticipant
            ? avatarForChatParticipant(savedParticipant, chatParticipantDisplayName(savedParticipant))
            : avatarForParticipant(operation.participantConfigId, operation.participantConfigId);
          return (
            <div className="chat-app-tool-review-block is-participant-review" key={`${operation.type}-${operation.participantConfigId}`}>
              <div className="chat-app-tool-review-participant-head">
                <Avatar className="chat-app-tool-review-avatar" spec={savedAvatar} />
                <div>
                  <strong>{savedParticipant ? chatParticipantReference(savedParticipant.handle) : operation.participantConfigId}</strong>
                  <span>{savedRole?.label ?? savedParticipant?.roleConfigId ?? "Saved participant preset"}</span>
                </div>
              </div>
              <div className="chat-app-tool-review-spec">
                <div className="chat-app-tool-review-spec-row">
                  <span>Status</span>
                  <strong>Already saved participant preset</strong>
                </div>
                {savedParticipant && (
                  <ChatAppToolExistingParticipantSpec
                    preset={savedParticipant}
                    overrides={operation.overrides}
                    onOverride={(patch) => updateExistingOverride(index, patch)}
                  />
                )}
              </div>
            </div>
          );
        }
        const participant = operation.participant;
        const role = props.roles.find((item) => item.id === participant.roleConfigId);
        const rawPermissionLabels = rosterPermissionGrantLabels(participant);
        const customAccess = normalizeChatAgentMode(participant.agentMode) === "default";
        const broaderThanDefault = customAccess && rawPermissionLabels.some((label) => label !== "repo read");
        function patchParticipant(next: Partial<ChatRosterChangeParticipantInput>): void {
          updateNewParticipant(index, { participant: next });
        }
        return (
          <div className="chat-app-tool-review-block is-participant-review" key={`${operation.type}-${operation.participant.handle}-${index}`}>
            <div className="chat-app-tool-review-participant-head">
              <ChatAppToolAvatarField
                kind={participant.kind}
                handle={participant.handle}
                avatarId={participant.avatarId}
                onSelect={(avatarId) => patchParticipant({ avatarId })}
              />
              <div>
                <ChatAppToolHandleField handle={participant.handle} onChange={(handle) => patchParticipant({ handle })} />
                <span>{role?.label ?? participant.roleConfigId}</span>
              </div>
            </div>
            <div className="chat-app-tool-review-spec">
              <ChatAppToolInlineSelectRow
                label="Role"
                value={role?.label ?? participant.roleConfigId}
                current={participant.roleConfigId}
                options={props.roles
                  .filter((item) => !item.archivedAt || item.id === participant.roleConfigId)
                  .map((item) => ({ value: item.id, label: item.archivedAt ? `${item.label} (deleted)` : item.label }))}
                searchable
                searchPlaceholder="Filter roles"
                emptyLabel="No roles found"
                onSelect={(value) => patchParticipant({ roleConfigId: value })}
              />
              <ChatAppToolInlineSelectRow
                label="Provider / CLI"
                value={participantProviderLabel(participant.kind)}
                current={participant.kind}
                options={[{ value: "codex-cli", label: "Codex CLI" }, { value: "claude-code", label: "Claude Code" }]}
                onSelect={(value) => {
                  const nextKind: ChatProviderKind = value === "claude-code" ? "claude-code" : "codex-cli";
                  if (nextKind === participant.kind) {
                    return;
                  }
                  // Model is provider-specific (e.g. gpt-5.5 is Codex-only), so reset to CLI
                  // default on a provider switch; the model picker re-fetches the new catalog.
                  const next: Partial<ChatRosterChangeParticipantInput> = { kind: nextKind, model: undefined };
                  if (participant.avatarId) {
                    next.avatarId = mapChatAvatarIdToKind(nextKind, participant.avatarId, participant.handle);
                  }
                  patchParticipant(next);
                }}
              />
              <ChatAppToolInlineModelRow
                kind={participant.kind}
                model={participant.model}
                onSelect={(model) => patchParticipant({ model })}
              />
              <ChatAppToolInlineSelectRow
                label="Reasoning"
                value={participant.reasoningEffort ? chatReasoningEffortLabel(participant.reasoningEffort) : "CLI default"}
                current={participant.reasoningEffort ?? ""}
                options={[
                  { value: "", label: "CLI default" },
                  ...reasoningEffortOptionsForProvider(participant.kind).map((item) => ({ value: item.id, label: item.label }))
                ]}
                onSelect={(value) => patchParticipant({ reasoningEffort: value ? normalizeChatReasoningEffort(value, participant.kind) : undefined })}
              />
              <ChatAppToolInlineSelectRow
                label="Mode"
                value={chatAgentModeLabel(participant.agentMode)}
                current={normalizeChatAgentMode(participant.agentMode)}
                options={CHAT_AGENT_MODE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                onSelect={(value) => patchParticipant({ agentMode: value as ChatAgentMode })}
              />
              {customAccess && (
                <ChatAppToolInlinePermissionsRow
                  participant={participant}
                  onChange={(permissions) => patchParticipant({ permissions })}
                />
              )}
              <ChatAppToolInlineAutoWatchRow
                checked={participant.autoWatch === true}
                onChange={(autoWatch) => patchParticipant({ autoWatch })}
              />
              <ChatAppToolInlineRequestParticipantsRow
                participant={participant}
                onChange={(permissions) => patchParticipant({ permissions })}
              />
            </div>
            {broaderThanDefault && (
              <div className="chat-app-tool-review-warning">
                <AlertTriangle size={14} aria-hidden />
                <span>Permissions are broader than the read-only default.</span>
              </div>
            )}
            <label className="chat-app-tool-review-toggle">
              <input
                type="checkbox"
                checked={operation.saveAsPreset !== false}
                onChange={(event) => updateNewParticipant(index, { saveAsPreset: event.currentTarget.checked })}
              />
              <span className={`chat-app-tool-review-switch ${operation.saveAsPreset !== false ? "on" : ""}`} aria-hidden>
                <span />
              </span>
              <span className="chat-app-tool-review-toggle-text">
                <strong>Save as participant preset</strong>
                <span>{operation.saveAsPreset !== false ? "Saved to your presets - reusable in any chat." : "Off - this stays a chat-only participant."}</span>
              </span>
            </label>
          </div>
        );
      })}
    </div>
  );
}

// Saved participant in an add-participant approval. The role/provider come from the
// preset (read-only), while Model / Reasoning / Mode / Permissions are editable as
// chat-level overrides — they apply only to this chat and never touch the saved preset.
export function ChatAppToolExistingParticipantSpec(props: {
  preset: ChatParticipantConfig;
  overrides?: ChatExistingParticipantOverrides;
  onOverride: (patch: Partial<ChatExistingParticipantOverrides>) => void;
}): JSX.Element {
  const preset = props.preset;
  const overrides = props.overrides;
  const model = overrides && "model" in overrides ? overrides.model : preset.model;
  const reasoning = overrides && "reasoningEffort" in overrides ? overrides.reasoningEffort : preset.reasoningEffort;
  const mode = normalizeChatAgentMode(overrides && "agentMode" in overrides ? overrides.agentMode : preset.agentMode);
  const permissions = overrides && "permissions" in overrides ? overrides.permissions : preset.permissions;
  const autoWatch = overrides && "autoWatch" in overrides
    ? overrides.autoWatch === true
    : preset.autoWatchEnabled === true;
  const permissionParticipant: ChatRosterChangeParticipantInput = {
    handle: preset.handle,
    roleConfigId: preset.roleConfigId,
    behaviorRuleIds: preset.behaviorRuleIds,
    kind: preset.kind,
    agentMode: mode,
    permissions
  };
  return (
    <>
      <div className="chat-app-tool-review-spec-row">
        <span>Provider / CLI</span>
        <strong>{participantProviderLabel(preset.kind)}</strong>
      </div>
      <ChatAppToolInlineModelRow
        kind={preset.kind}
        model={model}
        onSelect={(next) => props.onOverride({ model: next })}
      />
      <ChatAppToolInlineSelectRow
        label="Reasoning"
        value={reasoning ? chatReasoningEffortLabel(reasoning) : "CLI default"}
        current={reasoning ?? ""}
        options={[
          { value: "", label: "CLI default" },
          ...reasoningEffortOptionsForProvider(preset.kind).map((item) => ({ value: item.id, label: item.label }))
        ]}
        onSelect={(value) => props.onOverride({ reasoningEffort: value ? normalizeChatReasoningEffort(value, preset.kind) : undefined })}
      />
      <ChatAppToolInlineSelectRow
        label="Mode"
        value={chatAgentModeLabel(mode)}
        current={mode}
        options={CHAT_AGENT_MODE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
        onSelect={(value) => props.onOverride({ agentMode: value as ChatAgentMode })}
      />
      {mode === "default" && (
        <ChatAppToolInlinePermissionsRow
          participant={permissionParticipant}
          onChange={(next) => props.onOverride({ permissions: next })}
        />
      )}
      <ChatAppToolInlineAutoWatchRow
        checked={autoWatch}
        onChange={(next) => props.onOverride({ autoWatch: next })}
      />
      <ChatAppToolInlineRequestParticipantsRow
        participant={permissionParticipant}
        onChange={(next) => props.onOverride({ permissions: next })}
      />
    </>
  );
}

export function ChatAppToolHandleField(props: { handle: string; onChange: (handle: string) => void }): JSX.Element {
  return (
    <span className="chat-app-tool-inline-handle">
      <span aria-hidden>@</span>
      <input
        value={props.handle}
        aria-label="Participant handle"
        spellCheck={false}
        size={Math.max(props.handle.length + 1, 4)}
        onChange={(event) => props.onChange(event.currentTarget.value.replace(/^@+/, ""))}
      />
    </span>
  );
}
