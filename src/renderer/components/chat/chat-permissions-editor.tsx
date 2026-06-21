import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AppSelect,
  IconButton
} from "../primitives";
import type {
  ChatAgentMode,
  ChatAgentPermissions,
  ChatShellPermissionAction,
  ChatShellPermissionMatch,
  ChatShellPermissionRule
} from "../../../shared/types";
import {
  CHAT_SHELL_ACTION_OPTIONS,
  CHAT_SHELL_MATCH_OPTIONS
} from "./chat-participant-drafts";

export function ChatPermissionsEditor(props: {
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
