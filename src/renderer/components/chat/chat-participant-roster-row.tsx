import { useState } from "react";
import type React from "react";
import { AtSign, Check, ChevronDown, Minimize2, Trash2 } from "lucide-react";

import { canCompactParticipant } from "../../../shared/chatParticipantStatus";
import type {
  ChatParticipant,
  ChatParticipantConfig,
  ChatRoleParticipantDefaults,
  ChatParticipantWatcherPausedReason
} from "../../../shared/types";
import { IconButton } from "../primitives";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { ParticipantRuntimeControls } from "./chat-participant-runtime-controls";
import { chatCliProviderLabel, normalizeChatRunLocation, type ChatParticipantRuntimeOverride } from "./chat-participant-drafts";
import { RosterStatusIndicator, type ChatParticipantRosterStatus } from "./chat-roster-status";

type ParticipantRuntimePatch = Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "skipToolchainPreflight" | "autoWatch">;

export function ChatParticipantRosterRow(props: {
  participant: ChatParticipant;
  removeDisabledReason: string | undefined;
  isRunning: boolean;
  status: ChatParticipantRosterStatus;
  autoWatchDisabledReason?: string;
  autoWatchPausedReason?: ChatParticipantWatcherPausedReason;
  roleParticipantDefaults?: ChatRoleParticipantDefaults;
  runLocationLocked: boolean;
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  participantRoleArchived: (participant: ChatParticipant) => boolean;
  onInsertMention: (participant: ChatParticipant) => void;
  onJumpToLastMessage: (participant: ChatParticipant) => void;
  onUpdateParticipantRuntime: (
    participantId: string,
    patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "skipToolchainPreflight" | "autoWatch">
  ) => void;
  onCompactParticipant: (participantId: string) => void;
  onRemoveParticipant: (participantId: string) => void;
}): JSX.Element {
  const displayName = chatParticipantDisplayName(props.participant);
  const roleLabel = props.participantRoleLabel(props.participant);
  const roleArchived = props.participantRoleArchived(props.participant);
  const [expanded, setExpanded] = useState(false);
  const compactDisabled = !canCompactParticipant(props.status);
  return (
    <div className={`chat-participant-row ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <span className="chat-participant-avatar-slot" aria-hidden>
        {props.renderParticipantAvatar(props.participant)}
      </span>
      <div className="chat-participant-row-body">
        <div className="chat-participant-row-head">
          <button
            type="button"
            onClick={() => props.onJumpToLastMessage(props.participant)}
            className="chat-participant-identity"
          >
            <span className="chat-participant-name-line">
              <strong className="chat-participant-name">{displayName}</strong>
              <span className="chat-participant-meta-sep" aria-hidden />
              <span className="chat-participant-provider">{chatCliProviderLabel(props.participant.kind)}</span>
              <span className="chat-participant-status-slot">
                <RosterStatusIndicator
                  status={props.status}
                  runningRemotely={props.participant.remoteExecution === "remote"}
                />
              </span>
            </span>
            <span className="chat-participant-role-line">
              <span className="chat-participant-role-label">{roleLabel}</span>
              {roleArchived && <span className="chat-participant-role-archived">Archived role</span>}
            </span>
          </button>
          <div className="chat-participant-row-actions">
            <IconButton
              className="chat-participant-row-action chat-participant-row-disclosure"
              size="xs"
              icon={ChevronDown}
              iconClassName={expanded ? undefined : "-rotate-90"}
              label={expanded ? `Collapse ${displayName} settings` : `Expand ${displayName} settings`}
              tooltip={expanded ? "Collapse" : "Expand"}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            />
            <IconButton
              className="chat-participant-row-action"
              size="xs"
              icon={Minimize2}
              label={`Compact ${displayName} context`}
              tooltip={compactDisabled ? "This member is busy." : "Compact this member's underlying session to free context."}
              disabled={compactDisabled}
              onClick={() => props.onCompactParticipant(props.participant.id)}
            />
            <IconButton
              className="chat-participant-row-action"
              size="xs"
              icon={AtSign}
              label={`Mention ${displayName}`}
              tooltip="Add this member mention to your message."
              onClick={() => props.onInsertMention(props.participant)}
            />
            <IconButton
              className="chat-participant-row-action is-danger"
              size="xs"
              icon={Trash2}
              label={`Remove ${displayName} from chat`}
              tooltip={props.removeDisabledReason ?? "Remove from chat"}
              disabled={Boolean(props.removeDisabledReason)}
              onClick={() => props.onRemoveParticipant(props.participant.id)}
            />
          </div>
        </div>
        {expanded && (
          <ParticipantRuntimeControls
            participant={props.participant}
            disabled={props.isRunning}
            autoWatchDisabledReason={props.autoWatchDisabledReason}
            autoWatchPausedReason={props.autoWatchPausedReason}
            roleParticipantDefaults={props.roleParticipantDefaults}
            runLocationLocked={props.runLocationLocked}
            onUpdate={props.onUpdateParticipantRuntime}
          />
        )}
      </div>
    </div>
  );
}

export function ChatParticipantSelectableRosterRow(props: {
  participant: ChatParticipantConfig;
  selected: boolean;
  locked?: boolean;
  disabledReason?: string;
  roleLabel: string;
  remoteExecution?: ChatParticipant["remoteExecution"];
  runtimeOverride?: ChatParticipantRuntimeOverride;
  renderParticipantAvatar: (participant: ChatParticipantConfig) => React.ReactNode;
  onToggleSelected: (participantId: string) => void;
  onRunLocationChange: (participant: ChatParticipantConfig, remoteExecution: Exclude<ChatParticipant["remoteExecution"], undefined | "inherit">) => void;
  onRuntimeChange: (participant: ChatParticipantConfig, patch: ParticipantRuntimePatch) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const displayName = chatParticipantDisplayName(props.participant);
  const checkboxDisabled = Boolean(props.locked) || Boolean(props.disabledReason);
  const runtimeOverride = props.runtimeOverride ?? {};
  const participant: ChatParticipant = {
    ...props.participant,
    model: "model" in runtimeOverride ? runtimeOverride.model : props.participant.model,
    reasoningEffort: "reasoningEffort" in runtimeOverride ? runtimeOverride.reasoningEffort : props.participant.reasoningEffort,
    agentMode: runtimeOverride.agentMode ?? props.participant.agentMode,
    permissions: runtimeOverride.permissions ?? props.participant.permissions,
    remoteExecution: normalizeChatRunLocation(runtimeOverride.remoteExecution ?? props.remoteExecution ?? props.participant.remoteExecution),
    skipToolchainPreflight: runtimeOverride.skipToolchainPreflight ?? props.participant.skipToolchainPreflight,
    autoWatch: runtimeOverride.autoWatch ?? props.participant.autoWatchEnabled
  };

  return (
    <div
      className={`chat-participant-row chat-participant-select-row ${props.selected ? "is-selected" : ""} ${expanded ? "is-expanded" : "is-collapsed"} ${props.disabledReason ? "is-disabled" : ""}`}
      title={props.disabledReason}
    >
      <span className="chat-participant-avatar-slot" aria-hidden>
        {props.renderParticipantAvatar(props.participant)}
      </span>
      <div className="chat-participant-row-body">
        <div className="chat-participant-row-head">
          <button
            type="button"
            className="chat-participant-identity"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="chat-participant-name-line">
              <strong className="chat-participant-name">{displayName}</strong>
              <span className="chat-participant-meta-sep" aria-hidden />
              <span className="chat-participant-provider">{chatCliProviderLabel(props.participant.kind)}</span>
              <span className="chat-participant-status-slot">
                <RosterStatusIndicator status="idle" />
              </span>
            </span>
            <span className="chat-participant-role-line">
              <span className="chat-participant-role-label">{props.disabledReason ?? props.roleLabel}</span>
            </span>
          </button>
          <div className="chat-participant-row-actions">
            <IconButton
              className="chat-participant-row-action chat-participant-row-disclosure"
              size="xs"
              icon={ChevronDown}
              iconClassName={expanded ? undefined : "-rotate-90"}
              label={expanded ? `Collapse ${displayName} settings` : `Expand ${displayName} settings`}
              tooltip={expanded ? "Collapse" : "Expand"}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            />
            <button
              type="button"
              className={`chat-participant-select-check ${props.selected ? "is-on" : ""}`}
              role="checkbox"
              aria-checked={props.selected}
              aria-label={props.locked ? `${displayName} is always included` : `${props.selected ? "Remove" : "Add"} ${displayName}`}
              disabled={checkboxDisabled}
              onClick={() => props.onToggleSelected(props.participant.id)}
            >
              {props.selected && <Check size={14} strokeWidth={3.1} aria-hidden />}
            </button>
          </div>
        </div>
        {expanded && (
          <ParticipantRuntimeControls
            participant={participant}
            disabled={Boolean(props.disabledReason)}
            runLocationLocked={false}
            onUpdate={(_participantId, patch) => {
              props.onRuntimeChange(props.participant, patch);
              props.onRunLocationChange(props.participant, normalizeChatRunLocation(patch.remoteExecution));
            }}
          />
        )}
      </div>
    </div>
  );
}
