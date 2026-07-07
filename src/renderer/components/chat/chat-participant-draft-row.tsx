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
  CloudRunRemoteExecutionMode,
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
import {
  ChatParticipantInlinePermissionsRow,
  ChatParticipantInlineRequestParticipantsRow
} from "./chat-participant-config-panel";
import type { ChatParticipantDraft } from "./chat-participant-drafts";
import {
  CHAT_AGENT_MODE_OPTIONS,
  CHAT_RUN_LOCATION_OPTIONS,
  WORKFLOW_MANAGER_ROLE_ID,
  activeChatRoleConfigs,
  normalizeChatRunLocation,
  updateChatParticipantDraft
} from "./chat-participant-drafts";

const AUTO_WATCH_GENERIC_DESCRIPTION = "Let this member watch new chat messages and decide whether to act.";
const AUTO_WATCH_MANAGER_DESCRIPTION = "Workflow Manager defaults to watching new chat messages.";

export function ChatParticipantDraftRow(props: {
  draft: ChatParticipantDraft;
  settings: AppSettings;
  agents: AgentHealth[];
  removable?: boolean;
  renderAvatarOption: (option: ChatAvatarOption) => React.ReactNode;
  autoWatchDisabledReason?: string;
  onChange: (draft: ChatParticipantDraft) => void;
  onRemove?: () => void;
}): JSX.Element {
  const cliProviders = props.settings.providers.filter((provider) => isCliProviderKind(provider.kind));
  const roleOptions = activeChatRoleConfigs(props.settings).map((role) => ({ value: role.id, label: role.label }));
  const avatarId = normalizedChatAvatarId(props.draft.kind, props.draft.avatarId, props.draft.handle);
  const avatarOptions = chatAvatarOptionsForKind(props.draft.kind);
  const isWorkflowManager = props.draft.roleConfigId === WORKFLOW_MANAGER_ROLE_ID;
  const autoWatchDisabled = isWorkflowManager || Boolean(props.autoWatchDisabledReason);
  const autoWatchChecked = props.autoWatchDisabledReason ? false : props.draft.autoWatch;
  const autoWatchDescription = props.autoWatchDisabledReason
    ?? (isWorkflowManager ? AUTO_WATCH_MANAGER_DESCRIPTION : AUTO_WATCH_GENERIC_DESCRIPTION);

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
          ariaLabel="Member role"
          options={roleOptions}
          onValueChange={(value) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { roleConfigId: value }))}
        />
      </FormRow>
      <FormRow label="CLI">
        <AppSelect
          value={props.draft.kind}
          placeholder="Select CLI"
          ariaLabel="Member CLI"
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
      {props.draft.kind === "codex-cli" && (
        <FormRow label="Run location">
          <AppSelect
            value={normalizeChatRunLocation(props.draft.remoteExecution)}
            placeholder="Select run location"
            ariaLabel="Member run location"
            options={CHAT_RUN_LOCATION_OPTIONS}
            onValueChange={(value) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, {
              remoteExecution: value as CloudRunRemoteExecutionMode
            }))}
          />
        </FormRow>
      )}
      {props.draft.kind === "codex-cli" && normalizeChatRunLocation(props.draft.remoteExecution) === "remote" && (
        <FormRow label="Preflight">
          <label
            className="chat-behavior-rule-option"
            title="Bypass repository toolchain checks for this remote member when detection is wrong."
          >
            <input
              type="checkbox"
              checked={props.draft.skipToolchainPreflight}
              onChange={(event) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, {
                skipToolchainPreflight: event.target.checked
              }))}
            />
            <span>Skip toolchain preflight</span>
          </label>
        </FormRow>
      )}
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
          ariaLabel="Member agent mode"
          options={CHAT_AGENT_MODE_OPTIONS}
          onValueChange={(value) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { agentMode: value as ChatAgentMode }))}
        />
      </FormRow>
      {props.draft.agentMode === "default" && (
        <ChatParticipantInlinePermissionsRow
          participant={props.draft}
          onChange={(permissions) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { permissions }))}
        />
      )}
      <FormRow label="Auto-watch">
        <label
          className={`chat-behavior-rule-option${autoWatchDisabled ? " is-disabled" : ""}`}
          title={autoWatchDescription}
        >
          <input
            type="checkbox"
            checked={autoWatchChecked}
            disabled={autoWatchDisabled}
            onChange={(event) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { autoWatch: event.target.checked }))}
          />
          <span>Watch new chat activity</span>
        </label>
        <div className="text-xs text-muted-foreground">
          {autoWatchDescription}
        </div>
      </FormRow>
      <ChatParticipantInlineRequestParticipantsRow
        participant={props.draft}
        onChange={(permissions) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { permissions }))}
      />
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
      <FormRow label="Avatar" className="avatar-picker-field">
        <div className="avatar-choice-grid" role="radiogroup" aria-label="Member avatar">
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
          label="Remove member"
          tooltip="Remove member"
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
