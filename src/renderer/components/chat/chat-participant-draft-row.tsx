import type React from "react";
import { X } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  AppSelect,
  FormRow,
  IconButton
} from "../primitives";
import type {
  AgentHealth,
  AppSettings,
  ChatAgentMode,
  ChatProviderKind,
  ProviderKind
} from "../../../shared/types";
import type { ChatAvatarOption } from "./chat-avatars";
import {
  chatAvatarOptionsForKind,
  normalizedChatAvatarId
} from "./chat-avatars";
import {
  ChatModelPicker,
  ChatReasoningEffortPicker
} from "./chat-model-reasoning-pickers";
import { ChatPermissionsEditor } from "./chat-permissions-editor";
import type { ChatParticipantDraft } from "./chat-participant-drafts";
import {
  CHAT_AGENT_MODE_OPTIONS,
  activeChatRoleConfigs,
  updateChatParticipantDraft
} from "./chat-participant-drafts";

export function ChatParticipantDraftRow(props: {
  draft: ChatParticipantDraft;
  settings: AppSettings;
  agents: AgentHealth[];
  removable?: boolean;
  renderAvatarOption: (option: ChatAvatarOption) => React.ReactNode;
  onChange: (draft: ChatParticipantDraft) => void;
  onRemove?: () => void;
}): JSX.Element {
  const cliProviders = props.settings.providers.filter((provider) => isCliProviderKind(provider.kind));
  const roleOptions = activeChatRoleConfigs(props.settings).map((role) => ({ value: role.id, label: role.label }));
  const avatarId = normalizedChatAvatarId(props.draft.kind, props.draft.avatarId, props.draft.handle);
  const avatarOptions = chatAvatarOptionsForKind(props.draft.kind);

  function toggleBehaviorRule(ruleId: string, checked: boolean): void {
    const selected = new Set(props.draft.behaviorRuleIds);
    if (checked) {
      selected.add(ruleId);
    } else {
      selected.delete(ruleId);
    }
    const behaviorRuleIds = props.settings.chatBehaviorRules.map((rule) => rule.id).filter((id) => selected.has(id));
    props.onChange(updateChatParticipantDraft(props.draft, props.settings, { behaviorRuleIds }));
  }

  return (
    <div className="chat-participant-row">
      <FormRow label="Name">
        <Input
          value={props.draft.handle}
          onChange={(event) => props.onChange({ ...props.draft, handle: event.target.value })}
          placeholder="eng1"
        />
      </FormRow>
      <FormRow label="Role">
        <AppSelect
          value={props.draft.roleConfigId}
          placeholder="Select role"
          ariaLabel="Participant role"
          options={roleOptions}
          onValueChange={(value) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { roleConfigId: value }))}
        />
      </FormRow>
      <FormRow label="CLI">
        <AppSelect
          value={props.draft.kind}
          placeholder="Select CLI"
          ariaLabel="Participant CLI"
          options={cliProviders.map((provider) => {
            const health = props.agents.find((agent) => agent.kind === provider.kind);
            return {
              value: provider.kind,
              label: `${provider.label}${health?.installed ? "" : " (missing)"}`,
              disabled: !health?.installed
            };
          })}
          onValueChange={(value) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { kind: value as ChatProviderKind }))}
        />
      </FormRow>
      <FormRow label="Model">
        <ChatModelPicker
          kind={props.draft.kind}
          model={props.draft.model}
          onChange={(model) => props.onChange({ ...props.draft, model })}
        />
      </FormRow>
      <FormRow label="Reasoning">
        <ChatReasoningEffortPicker
          kind={props.draft.kind}
          model={props.draft.model}
          reasoningEffort={props.draft.reasoningEffort}
          onChange={(reasoningEffort) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { reasoningEffort }))}
        />
      </FormRow>
      <FormRow label="Mode">
        <AppSelect
          value={props.draft.agentMode}
          placeholder="Select mode"
          ariaLabel="Participant agent mode"
          options={CHAT_AGENT_MODE_OPTIONS}
          onValueChange={(value) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { agentMode: value as ChatAgentMode }))}
        />
      </FormRow>
      <FormRow label="Behavior rules" className="behavior-rules-field">
        {props.settings.chatBehaviorRules.length === 0 ? (
          <div className="text-xs text-muted-foreground">No behavior rules created.</div>
        ) : (
          <div className="chat-behavior-rule-list">
            {props.settings.chatBehaviorRules.map((rule) => (
              <label className="chat-behavior-rule-option" key={rule.id}>
                <input
                  type="checkbox"
                  checked={props.draft.behaviorRuleIds.includes(rule.id)}
                  onChange={(event) => toggleBehaviorRule(rule.id, event.target.checked)}
                />
                <span>{rule.label}</span>
              </label>
            ))}
          </div>
        )}
      </FormRow>
      <ChatPermissionsEditor
        mode={props.draft.agentMode}
        permissions={props.draft.permissions}
        onChange={(permissions) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { permissions }))}
      />
      <FormRow label="Avatar" className="avatar-picker-field">
        <div className="avatar-choice-grid" role="radiogroup" aria-label="Participant avatar">
          {avatarOptions.map((option) => {
            const selected = option.id === avatarId;
            return (
              <button
                type="button"
                className={`avatar-choice ${selected ? "selected" : ""}`}
                title={option.label}
                aria-label={option.label}
                aria-pressed={selected}
                onClick={() => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { avatarId: option.id }))}
                key={option.id}
              >
                {props.renderAvatarOption(option)}
              </button>
            );
          })}
        </div>
      </FormRow>
      {props.removable && (
        <IconButton
          size="xs"
          icon={X}
          label="Remove participant"
          tooltip="Remove participant"
          onClick={props.onRemove}
          className="chat-row-remove"
        />
      )}
    </div>
  );
}

function isCliProviderKind(kind: ProviderKind): kind is ChatProviderKind {
  return kind === "codex-cli" || kind === "claude-code";
}
