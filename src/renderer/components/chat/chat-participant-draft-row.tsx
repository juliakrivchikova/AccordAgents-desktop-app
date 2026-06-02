import type React from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  ChatAgentPermissions,
  ChatProviderKind,
  ChatShellPermissionAction,
  ChatShellPermissionMatch,
  ChatShellPermissionRule,
  ProviderKind
} from "../../../shared/types";
import type { ChatAvatarOption } from "./chat-avatars";
import {
  chatAvatarOptionsForKind,
  normalizedChatAvatarId
} from "./chat-avatars";
import type { ChatParticipantDraft } from "./chat-participant-drafts";
import {
  CHAT_AGENT_MODE_OPTIONS,
  CHAT_SHELL_ACTION_OPTIONS,
  CHAT_SHELL_MATCH_OPTIONS,
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
  const avatarId = normalizedChatAvatarId(props.draft.kind, props.draft.avatarId, props.draft.handle);
  const avatarOptions = chatAvatarOptionsForKind(props.draft.kind);
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
          options={props.settings.chatRoleConfigs.map((role) => ({ value: role.id, label: role.label }))}
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
        <Input
          value={props.draft.model ?? ""}
          onChange={(event) => props.onChange({ ...props.draft, model: event.target.value })}
          placeholder="CLI default"
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

function ChatPermissionsEditor(props: {
  mode: ChatAgentMode;
  permissions: ChatAgentPermissions;
  onChange: (permissions: ChatAgentPermissions) => void;
}): JSX.Element {
  const permissions = props.permissions;
  const planMode = props.mode === "plan";

  function updatePermissions(patch: Partial<ChatAgentPermissions>): void {
    props.onChange({ ...permissions, ...patch });
  }

  function updateShell(patch: Partial<ChatAgentPermissions["shell"]>): void {
    updatePermissions({
      shell: {
        ...permissions.shell,
        ...patch
      }
    });
  }

  function updateRule(index: number, patch: Partial<ChatShellPermissionRule>): void {
    updateShell({
      rules: permissions.shell.rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule)
    });
  }

  function addRule(): void {
    updateShell({
      enabled: true,
      rules: [
        ...permissions.shell.rules,
        { action: "allow", match: "exact", pattern: "npm run test" }
      ]
    });
  }

  function removeRule(index: number): void {
    updateShell({
      rules: permissions.shell.rules.filter((_rule, ruleIndex) => ruleIndex !== index)
    });
  }

  return (
    <div className="chat-permissions-panel">
      <div className="chat-permission-toggle-grid">
        <ChatPermissionToggle
          label="Read repo"
          checked={permissions.repoRead}
          onChange={(repoRead) => updatePermissions({ repoRead })}
        />
        <ChatPermissionToggle
          label="Run shell"
          checked={permissions.shell.enabled}
          onChange={(enabled) => updateShell({ enabled })}
        />
        <ChatPermissionToggle
          label="Edit files"
          checked={permissions.workspaceWrite}
          onChange={(workspaceWrite) => updatePermissions({ workspaceWrite })}
        />
        <ChatPermissionToggle
          label="Web access"
          checked={permissions.webAccess}
          onChange={(webAccess) => updatePermissions({ webAccess })}
        />
      </div>
      {planMode && <div className="text-xs text-muted-foreground">Plan mode blocks shell commands and file edits while active.</div>}
      {permissions.shell.enabled && (
        <div className="chat-shell-rule-list">
          <div className="chat-shell-rule-head">
            <span>Shell rules</span>
            <Button variant="outline" size="sm" onClick={addRule}>
              <Plus size={15} />
              Add rule
            </Button>
          </div>
          {permissions.shell.rules.length === 0 ? (
            <div className="text-xs text-muted-foreground">No command-specific rules. Native CLI approval mode applies.</div>
          ) : (
            permissions.shell.rules.map((rule, index) => (
              <div className="chat-shell-rule-row" key={`${index}-${rule.action}-${rule.match}`}>
                <AppSelect
                  value={rule.action}
                  placeholder="Action"
                  ariaLabel="Shell rule action"
                  options={CHAT_SHELL_ACTION_OPTIONS}
                  onValueChange={(value) => updateRule(index, { action: value as ChatShellPermissionAction })}
                />
                <AppSelect
                  value={rule.match}
                  placeholder="Match"
                  ariaLabel="Shell rule match type"
                  options={CHAT_SHELL_MATCH_OPTIONS}
                  onValueChange={(value) => updateRule(index, { match: value as ChatShellPermissionMatch })}
                />
                <Input
                  value={rule.pattern}
                  onChange={(event) => updateRule(index, { pattern: event.target.value })}
                  placeholder={rule.match === "prefix" ? "git diff" : "npm run test"}
                />
                <IconButton
                  size="xs"
                  icon={X}
                  label="Remove shell rule"
                  tooltip="Remove shell rule"
                  onClick={() => removeRule(index)}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ChatPermissionToggle(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="chat-permission-toggle">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function isCliProviderKind(kind: ProviderKind): kind is ChatProviderKind {
  return kind === "codex-cli" || kind === "claude-code";
}
