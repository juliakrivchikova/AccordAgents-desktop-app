import { useEffect, useState } from "react";
import { ChevronDown, FileText, Globe2, Pencil, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  normalizeChatAgentMode,
  normalizeChatAgentPermissions,
  normalizeChatRoleManagementPermission,
  normalizeOptionalChatParticipantRequestPermission
} from "../../../shared/agentPermissions";
import { reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import type {
  ChatAgentMode,
  ChatAgentPermissions,
  ChatParticipant,
  ChatParticipantRequestPermission,
  ChatRoleParticipantDefaults,
  ChatParticipantWatcherPausedReason,
  ChatProviderKind,
  ChatReasoningEffort,
  ProviderModelCatalog
} from "../../../shared/types";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import {
  CHAT_AGENT_MODE_OPTIONS,
  chatCliProviderLabel,
  chatInheritedCliSettingLabel,
  normalizeChatRunLocation
} from "./chat-participant-drafts";

const REASONING_DEFAULT_VALUE = "__default__";
const MODEL_DEFAULT_VALUE = "__default_model__";
const MODEL_MANUAL_VALUE = "__manual_model__";
const AUTO_WATCH_PAUSED_TOOLTIPS: Record<ChatParticipantWatcherPausedReason, string> = {
  "wake-limit": "Paused after too many automatic runs. Turn off and on to resume.",
  error: "Paused after an auto-watch error. Turn off and on to resume."
};
const PARTICIPANT_REQUEST_PERMISSION_OPTIONS = [
  { value: "ask", label: "Always ask" },
  { value: "allow", label: "Auto-allow" },
  { value: "deny", label: "Deny" }
];

export function ParticipantRuntimeControls(props: {
  participant: ChatParticipant;
  disabled: boolean;
  readOnly?: boolean;
  autoWatchDisabledReason?: string;
  autoWatchPausedReason?: ChatParticipantWatcherPausedReason;
  roleParticipantDefaults?: ChatRoleParticipantDefaults;
  runLocationLocked: boolean;
  onUpdate: (
    participantId: string,
    patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "skipToolchainPreflight" | "autoWatch">
  ) => void;
}): JSX.Element {
  const participant = props.participant;
  const mode = normalizeChatAgentMode(participant.agentMode);
  const runLocation = normalizeChatRunLocation(participant.remoteExecution);
  const reasoningValue = participant.reasoningEffort ?? REASONING_DEFAULT_VALUE;
  const cliSettingLabel = chatInheritedCliSettingLabel(participant.kind);
  const providerLabel = chatCliProviderLabel(participant.kind);
  const controlsDisabled = props.disabled || props.readOnly === true;

  // Build the patch by key presence so an intentional reset (model: "") is forwarded
  // rather than collapsing back to the current value.
  function update(patch: Partial<Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "skipToolchainPreflight" | "autoWatch">>): void {
    props.onUpdate(participant.id, {
      model: "model" in patch ? patch.model : participant.model,
      reasoningEffort: "reasoningEffort" in patch ? patch.reasoningEffort : participant.reasoningEffort,
      agentMode: "agentMode" in patch ? patch.agentMode : participant.agentMode,
      permissions: "permissions" in patch ? patch.permissions : participant.permissions,
      remoteExecution: "remoteExecution" in patch ? patch.remoteExecution : participant.remoteExecution,
      skipToolchainPreflight: "skipToolchainPreflight" in patch ? patch.skipToolchainPreflight : participant.skipToolchainPreflight,
      autoWatch: "autoWatch" in patch ? patch.autoWatch : participant.autoWatch
    });
  }

  const isCustomAccess = mode === "default";
  const normalizedPermissions = normalizeChatAgentPermissions(participant.permissions);
  // requestParticipants is independent of agent mode, so it gets its own
  // always-visible control below rather than living only in the Custom-access panel.
  const requestPermission = normalizedPermissions.requestParticipants;
  const requestPermissionLabel = PARTICIPANT_REQUEST_PERMISSION_OPTIONS
    .find((option) => option.value === requestPermission)?.label ?? "Always ask";
  const roleManageDefault = normalizeChatRoleManagementPermission(props.roleParticipantDefaults?.manageRolesParticipants);
  const explicitManagePermission = normalizeOptionalChatParticipantRequestPermission(normalizedPermissions.manageRolesParticipants);
  const managePermission = explicitManagePermission ?? roleManageDefault;
  const managePermissionLabel = PARTICIPANT_REQUEST_PERMISSION_OPTIONS
    .find((option) => option.value === managePermission)?.label ?? "Deny";
  const autoWatchOn = participant.autoWatch === true;
  const autoWatchPausedTooltip = props.autoWatchPausedReason ? AUTO_WATCH_PAUSED_TOOLTIPS[props.autoWatchPausedReason] : undefined;
  const autoWatchTooltip = props.autoWatchDisabledReason
    ?? autoWatchPausedTooltip
    ?? (autoWatchOn ? "Auto-watch is enabled for this member." : "Let this member watch new chat messages and decide whether to act.");
  const autoWatchDisabled = props.disabled || Boolean(props.autoWatchDisabledReason);
  const cloudRunOn = runLocation === "remote";
  const cloudRunDisabled = props.disabled || props.runLocationLocked || participant.kind !== "codex-cli";
  const cloudRunTooltip = props.runLocationLocked
    ? `Run location is locked because @${participant.handle} has already run in this chat.`
    : participant.kind !== "codex-cli"
    ? "Cloud Runs currently supports Codex members only."
    : cloudRunOn
    ? "Run this member on the Cloud Runs worker."
    : "Run this member locally.";

  return (
    <div className="chat-runtime-controls" aria-label={`Runtime controls for ${chatParticipantDisplayName(participant)}`}>
      <div className="chat-rt-toggleline">
        <span className="chat-rt-toggle-label">Cloud Run:</span>
        <PopoverSwitch
          checked={cloudRunOn}
          disabled={cloudRunDisabled}
          ariaLabel="Cloud Run"
          tooltip={cloudRunTooltip}
          onChange={(checked) => update({ remoteExecution: checked ? "remote" : "local" })}
        />
      </div>

      <div className="chat-rt-group">
        <div className="chat-rt-group-title">Model &amp; permissions</div>
        <div className="chat-rt-meta">
          <GhostSelect
            ariaLabel="Provider"
            value={participant.kind}
            disabled={controlsDisabled}
            options={[{ value: participant.kind, label: providerLabel }]}
            onChange={() => undefined}
          />
          <span className="chat-rt-dot" aria-hidden />
          <GhostModelSelect
            kind={participant.kind}
            model={participant.model}
            defaultLabel={cliSettingLabel}
            disabled={controlsDisabled}
            onChange={(model) => update({ model })}
          />
          <span className="chat-rt-dot" aria-hidden />
          <GhostSelect
            ariaLabel="Reasoning"
            value={reasoningValue}
            muted={reasoningValue === REASONING_DEFAULT_VALUE}
            disabled={controlsDisabled}
            options={[
              { value: REASONING_DEFAULT_VALUE, label: cliSettingLabel },
              ...reasoningEffortOptionsForProvider(participant.kind).map((option) => ({ value: option.id, label: option.label }))
            ]}
            onChange={(value) => update({
              reasoningEffort: value === REASONING_DEFAULT_VALUE ? undefined : value as ChatReasoningEffort
            })}
          />
          <span className="chat-rt-dot" aria-hidden />
          <GhostSelect
            ariaLabel="Mode"
            value={mode}
            disabled={controlsDisabled}
            options={CHAT_AGENT_MODE_OPTIONS}
            onChange={(value) => update({ agentMode: value as ChatAgentMode })}
          />
        </div>
        {isCustomAccess && (
          <PermissionsToggleRow
            participant={participant}
            disabled={controlsDisabled}
            onChange={(permissions) => update({ permissions })}
          />
        )}
      </div>

      <div className="chat-rt-group">
        <div className="chat-rt-group-title">Chat behavior</div>
        <div className="chat-rt-meta">
          <GhostSelect
            ariaLabel="Request members permission"
            value={requestPermission}
            prefix="Request other members:"
            displayLabel={requestPermissionLabel}
            tooltip="Controls whether this member can ask other chat members for help."
            muted={requestPermission === "ask"}
            disabled={controlsDisabled}
            options={PARTICIPANT_REQUEST_PERMISSION_OPTIONS}
            onChange={(value) => update({
              permissions: { ...normalizedPermissions, requestParticipants: value as ChatParticipantRequestPermission }
            })}
          />
          <span className="chat-rt-dot" aria-hidden />
          <GhostSelect
            ariaLabel="Manage roles and members permission"
            value={managePermission}
            prefix="Manage members:"
            displayLabel={managePermissionLabel}
            tooltip="Controls whether this member can add or change roles and chat members."
            muted={managePermission === "deny"}
            disabled={controlsDisabled}
            options={PARTICIPANT_REQUEST_PERMISSION_OPTIONS}
            onChange={(value) => {
              update({
                permissions: {
                  ...normalizedPermissions,
                  manageRolesParticipants: value as ChatParticipantRequestPermission
                }
              });
            }}
          />
          <span className="chat-rt-dot" aria-hidden />
          <span className="chat-rt-toggleinline">
            <span className="chat-rt-toggle-label">Auto-watch:</span>
            <PopoverSwitch
              checked={autoWatchOn}
              disabled={autoWatchDisabled || props.readOnly === true}
              paused={Boolean(props.autoWatchPausedReason)}
              ariaLabel="Auto-watch"
              tooltip={autoWatchTooltip}
              onChange={(checked) => update({ autoWatch: checked })}
            />
          </span>
          {runLocation === "remote" && participant.kind === "codex-cli" && (
            <>
              <span className="chat-rt-dot" aria-hidden />
              <span className="chat-rt-toggleinline">
                <span className="chat-rt-toggle-label">Preflight:</span>
                <PopoverSwitch
                  checked={participant.skipToolchainPreflight !== true}
                  disabled={controlsDisabled}
                  ariaLabel="Check toolchain preflight"
                  tooltip="Check repository toolchain readiness before running remotely."
                  onChange={(checked) => update({ skipToolchainPreflight: !checked })}
                />
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PopoverSwitch(props: {
  checked: boolean;
  disabled: boolean;
  paused?: boolean;
  ariaLabel: string;
  tooltip: string;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  const button = (
    <button
      type="button"
      className={`chat-rt-switch${props.checked ? " is-on" : ""}${props.paused ? " is-paused" : ""}`}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="chat-rt-switch-knob" />
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top">{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function GhostSelect(props: {
  value: string;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  muted?: boolean;
  displayLabel?: string;
  prefix?: string;
  tooltip?: string;
}): JSX.Element {
  const selected = props.options.find((option) => option.value === props.value);
  const label = props.displayLabel ?? selected?.label ?? props.options[0]?.label ?? "";
  const control = (
    <span className={`chat-rt-ghost${props.muted ? " is-muted" : ""}${props.disabled ? " is-disabled" : ""}`}>
      {props.prefix && <span className="chat-rt-ghost-prefix">{props.prefix}</span>}
      <span className="chat-rt-ghost-val">{label}</span>
      <ChevronDown size={11} aria-hidden />
      <select
        className="chat-rt-ghost-native"
        value={props.value}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        {props.options.map((option) => (
          <option value={option.value} key={option.value}>{option.label}</option>
        ))}
      </select>
    </span>
  );
  if (!props.tooltip) {
    return control;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent side="top">{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function GhostModelSelect(props: {
  kind: ChatProviderKind;
  model?: string;
  defaultLabel: string;
  disabled: boolean;
  onChange: (model: string) => void;
}): JSX.Element {
  const [catalog, setCatalog] = useState<ProviderModelCatalog | undefined>();
  const [manual, setManual] = useState(false);
  const model = props.model?.trim() || undefined;

  useEffect(() => {
    let cancelled = false;
    setCatalog(undefined);
    void window.consensus.listProviderModels(props.kind)
      .then((next) => {
        if (!cancelled) {
          setCatalog(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.kind]);

  const models = catalog?.models ?? [];
  const known = model ? models.find((item) => item.id === model) : undefined;
  const manualActive = manual || Boolean(model && !known);
  const value = manualActive ? MODEL_MANUAL_VALUE : model ?? MODEL_DEFAULT_VALUE;
  const displayLabel = !model
    ? props.defaultLabel
    : known
    ? known.label
    : model;
  const options = [
    { value: MODEL_DEFAULT_VALUE, label: props.defaultLabel },
    ...models.map((item) => ({ value: item.id, label: item.label })),
    { value: MODEL_MANUAL_VALUE, label: manualActive && model ? `Manual: ${model}` : "Manual…" }
  ];

  return (
    <>
      <GhostSelect
        ariaLabel="Model"
        value={value}
        displayLabel={displayLabel}
        muted={!model}
        disabled={props.disabled}
        options={options}
        onChange={(next) => {
          if (next === MODEL_DEFAULT_VALUE) {
            setManual(false);
            props.onChange("");
            return;
          }
          if (next === MODEL_MANUAL_VALUE) {
            setManual(true);
            return;
          }
          setManual(false);
          props.onChange(next);
        }}
      />
      {manualActive && (
        <input
          className="chat-rt-manual"
          defaultValue={model ?? ""}
          disabled={props.disabled}
          placeholder={props.defaultLabel}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            if (next !== (model ?? "")) {
              props.onChange(next);
            }
          }}
        />
      )}
    </>
  );
}

function PermissionsToggleRow(props: {
  participant: ChatParticipant;
  disabled: boolean;
  onChange: (permissions: ChatAgentPermissions) => void;
}): JSX.Element {
  const permissions = normalizeChatAgentPermissions(props.participant.permissions);
  function set(patch: Partial<ChatAgentPermissions>): void {
    props.onChange({ ...permissions, ...patch });
  }
  const toggles: Array<{ label: string; icon: LucideIcon; checked: boolean; onChange: (value: boolean) => void }> = [
    { label: "Read Files", icon: FileText, checked: permissions.repoRead, onChange: (value) => set({ repoRead: value }) },
    { label: "Edit Files", icon: Pencil, checked: permissions.workspaceWrite, onChange: (value) => set({ workspaceWrite: value }) },
    { label: "Run Shell", icon: Terminal, checked: permissions.shell.enabled, onChange: (value) => set({ shell: { ...permissions.shell, enabled: value } }) },
    { label: "Access Web", icon: Globe2, checked: permissions.webAccess, onChange: (value) => set({ webAccess: value }) }
  ];
  return (
    <div className="chat-rt-perms">
      {toggles.map((toggle) => {
        const Icon = toggle.icon;
        return (
        <button
          type="button"
          className={`chat-rt-perm-chip${toggle.checked ? " is-on" : ""}`}
          aria-pressed={toggle.checked}
          disabled={props.disabled}
          key={toggle.label}
          onClick={() => toggle.onChange(!toggle.checked)}
        >
          <Icon size={13} aria-hidden />
          <span>{toggle.label}</span>
        </button>
        );
      })}
    </div>
  );
}
