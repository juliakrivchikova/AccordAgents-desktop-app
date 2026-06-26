import { useEffect, useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";

import {
  effectiveChatAgentPermissionsForProvider,
  normalizeChatAgentMode,
  normalizeChatAgentPermissions
} from "../../../shared/agentPermissions";
import { reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import type {
  ChatAgentMode,
  ChatAgentPermissions,
  ChatParticipant,
  ChatParticipantRequestPermission,
  ChatProviderKind,
  ChatReasoningEffort,
  ProviderModelCatalog
} from "../../../shared/types";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { AppSelect } from "../primitives";
import {
  CHAT_AGENT_MODE_OPTIONS,
  chatInheritedCliSettingLabel
} from "./chat-participant-drafts";

const REASONING_DEFAULT_VALUE = "__default__";
const MODEL_DEFAULT_VALUE = "__default_model__";
const MODEL_MANUAL_VALUE = "__manual_model__";
const PARTICIPANT_REQUEST_PERMISSION_OPTIONS = [
  { value: "ask", label: "Ask" },
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Deny" }
];

export function ParticipantRuntimeControls(props: {
  participant: ChatParticipant;
  disabled: boolean;
  onUpdate: (
    participantId: string,
    patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions">
  ) => void;
}): JSX.Element {
  const participant = props.participant;
  const mode = normalizeChatAgentMode(participant.agentMode);
  const reasoningValue = participant.reasoningEffort ?? REASONING_DEFAULT_VALUE;
  const cliSettingLabel = chatInheritedCliSettingLabel(participant.kind);
  const [showPermissions, setShowPermissions] = useState(false);

  // Build the patch by key presence so an intentional reset (model: "") is forwarded
  // rather than collapsing back to the current value.
  function update(patch: Partial<Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions">>): void {
    props.onUpdate(participant.id, {
      model: "model" in patch ? patch.model : participant.model,
      reasoningEffort: "reasoningEffort" in patch ? patch.reasoningEffort : participant.reasoningEffort,
      agentMode: "agentMode" in patch ? patch.agentMode : participant.agentMode,
      permissions: "permissions" in patch ? patch.permissions : participant.permissions
    });
  }

  const isCustomAccess = mode === "default";
  const effectivePermissions = effectiveChatAgentPermissionsForProvider(
    participant.kind,
    mode,
    normalizeChatAgentPermissions(participant.permissions)
  );
  const grants = [
    effectivePermissions.repoRead ? "repo read" : "",
    effectivePermissions.shell.enabled ? "shell" : "",
    effectivePermissions.workspaceWrite ? "edit" : "",
    effectivePermissions.webAccess ? "web" : "",
    effectivePermissions.requestParticipants === "allow" ? "request allow" : "",
    effectivePermissions.requestParticipants === "deny" ? "request deny" : ""
  ].filter(Boolean);

  return (
    <div className="chat-runtime-controls" aria-label={`Runtime controls for ${chatParticipantDisplayName(participant)}`}>
      <div className="chat-rt-meta">
        <GhostSelect
          ariaLabel="Mode"
          value={mode}
          disabled={props.disabled}
          options={CHAT_AGENT_MODE_OPTIONS}
          onChange={(value) => update({ agentMode: value as ChatAgentMode })}
        />
        <span className="chat-rt-dot" aria-hidden>·</span>
        <GhostSelect
          ariaLabel="Reasoning"
          value={reasoningValue}
          muted={reasoningValue === REASONING_DEFAULT_VALUE}
          disabled={props.disabled}
          options={[
            { value: REASONING_DEFAULT_VALUE, label: cliSettingLabel },
            ...reasoningEffortOptionsForProvider(participant.kind).map((option) => ({ value: option.id, label: option.label }))
          ]}
          onChange={(value) => update({
            reasoningEffort: value === REASONING_DEFAULT_VALUE ? undefined : value as ChatReasoningEffort
          })}
        />
        <span className="chat-rt-dot" aria-hidden>·</span>
        <GhostModelSelect
          kind={participant.kind}
          model={participant.model}
          defaultLabel={cliSettingLabel}
          disabled={props.disabled}
          onChange={(model) => update({ model })}
        />
        {isCustomAccess && (
          <>
            <span className="chat-rt-dot" aria-hidden>·</span>
            <button
              type="button"
              className={`chat-rt-perms-toggle${showPermissions ? " is-open" : ""}`}
              aria-expanded={showPermissions}
              disabled={props.disabled}
              onClick={() => setShowPermissions((open) => !open)}
            >
              <ShieldCheck size={12} aria-hidden />
              <span className="chat-rt-perms-summary">{grants.length ? grants.join(", ") : "no access"}</span>
              <ChevronDown size={11} aria-hidden />
            </button>
          </>
        )}
      </div>
      {isCustomAccess && showPermissions && (
        <PermissionsToggleRow
          participant={participant}
          disabled={props.disabled}
          onChange={(permissions) => update({ permissions })}
        />
      )}
    </div>
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
}): JSX.Element {
  const selected = props.options.find((option) => option.value === props.value);
  const label = props.displayLabel ?? selected?.label ?? props.options[0]?.label ?? "";
  return (
    <span className={`chat-rt-ghost${props.muted ? " is-muted" : ""}${props.disabled ? " is-disabled" : ""}`}>
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
  const toggles: Array<{ label: string; checked: boolean; onChange: (value: boolean) => void }> = [
    { label: "Read repo", checked: permissions.repoRead, onChange: (value) => set({ repoRead: value }) },
    { label: "Run shell", checked: permissions.shell.enabled, onChange: (value) => set({ shell: { ...permissions.shell, enabled: value } }) },
    { label: "Edit files", checked: permissions.workspaceWrite, onChange: (value) => set({ workspaceWrite: value }) },
    { label: "Web access", checked: permissions.webAccess, onChange: (value) => set({ webAccess: value }) }
  ];
  return (
    <div className="chat-rt-perms">
      {toggles.map((toggle) => (
        <label className={`chat-rt-perm-chip${toggle.checked ? " is-on" : ""}`} key={toggle.label}>
          <input
            type="checkbox"
            checked={toggle.checked}
            disabled={props.disabled}
            onChange={(event) => toggle.onChange(event.currentTarget.checked)}
          />
          <ShieldCheck size={12} aria-hidden />
          <span>{toggle.label}</span>
        </label>
      ))}
      <div className="chat-rt-request-permission">
        <span>Request participants</span>
        <AppSelect
          value={permissions.requestParticipants}
          placeholder="Request participants"
          ariaLabel="Request participants permission"
          disabled={props.disabled}
          options={PARTICIPANT_REQUEST_PERMISSION_OPTIONS}
          onValueChange={(value) => set({ requestParticipants: value as ChatParticipantRequestPermission })}
        />
      </div>
    </div>
  );
}
