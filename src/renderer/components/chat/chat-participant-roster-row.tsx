import { useContext, useState } from "react";
import type React from "react";
import { AtSign, Check, ChevronDown, Minimize2, RotateCcw, Trash2 } from "lucide-react";

import { canCompactParticipant, canRestartParticipant, memberProcessRestartable } from "../../../shared/chatParticipantStatus";
import type {
  ChatParticipant,
  ChatParticipantConfig,
  CliProviderHost,
  ChatRoleParticipantDefaults,
  ChatParticipantWatcherPausedReason
} from "../../../shared/types";
import type { MemberRestartInProgress } from "../../../shared/memberRestart";
import { IconButton } from "../primitives";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { ParticipantRuntimeControls } from "./chat-participant-runtime-controls";
import { chatCliProviderLabel, type ChatParticipantRuntimeOverride } from "./chat-participant-drafts";
import { cliProviderHostForParticipant } from "../../../shared/cliProviderHosts";
import { backgroundTasksStatusLabel, ChatBackgroundTasksContext, RosterStatusIndicator, type ChatParticipantRosterStatus } from "./chat-roster-status";

type ParticipantRuntimePatch = Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "cloudRun" | "homeMachineId" | "skipToolchainPreflight" | "autoWatch">;

export function ChatParticipantRosterRow(props: {
  participant: ChatParticipant;
  removeDisabledReason: string | undefined;
  /** Its own turn or compaction runs: its settings wait for it to end. */
  busy: boolean;
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
    patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "cloudRun" | "homeMachineId" | "skipToolchainPreflight" | "autoWatch">
  ) => void;
  onCompactParticipant: (participantId: string) => void;
  /** Resolves once the restart ended (true when it worked). */
  onRestartParticipant: (participantId: string, stopBackgroundTasks: boolean) => Promise<boolean>;
  /** Stops waiting for a restart its machine has not taken. */
  onStopRestart: (runId: string) => void;
  /** Its restart has not ended (also after this row closed and opened again). */
  restartStatus?: MemberRestartInProgress;
  onRemoveParticipant: (participantId: string) => void;
}): JSX.Element {
  const displayName = chatParticipantDisplayName(props.participant);
  const roleLabel = props.participantRoleLabel(props.participant);
  const roleArchived = props.participantRoleArchived(props.participant);
  const [expanded, setExpanded] = useState(false);
  const compactDisabled = !canCompactParticipant(props.status);
  const backgroundTasks = useContext(ChatBackgroundTasksContext).get(props.participant.id) ?? [];
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  // Also while the app waits for the member's machine, after this row closed.
  const restarting = restartPending || props.restartStatus !== undefined;
  // While its machine has not taken the restart, the spinning button stops it.
  const restartWait = props.restartStatus?.waiting ? props.restartStatus : undefined;
  const restartable = memberProcessRestartable(props.participant.kind);
  const restartDisabled = restartWait ? false : restarting || !canRestartParticipant(props.status);
  async function restart(stopBackgroundTasks: boolean): Promise<void> {
    setConfirmingRestart(false);
    setRestartPending(true);
    try {
      await props.onRestartParticipant(props.participant.id, stopBackgroundTasks);
    } finally {
      setRestartPending(false);
    }
  }
  function onRestartButton(): void {
    if (restartWait) {
      props.onStopRestart(restartWait.runId);
      return;
    }
    // Background work ends with the process: asked first, never silently.
    if (backgroundTasks.length > 0) {
      setConfirmingRestart(true);
      return;
    }
    void restart(false);
  }
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
              <span className="chat-participant-provider">{chatCliProviderLabel(props.participant.kind, props.participant.hostId ? props.participant.hostLabel : undefined)}</span>
              <span className="chat-participant-status-slot">
                <RosterStatusIndicator
                  status={props.status}
                  runningRemotely={props.participant.remoteExecution === "remote"}
                  participantId={props.participant.id}
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
              size="xs"
              icon={ChevronDown}
              iconClassName={expanded ? undefined : "-rotate-90"}
              label={expanded ? `Collapse ${displayName} settings` : `Expand ${displayName} settings`}
              tooltip={expanded ? "Collapse" : "Expand"}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            />
            <IconButton
              size="xs"
              icon={Minimize2}
              label={`Compact ${displayName} context`}
              tooltip={compactDisabled ? "This member is busy." : "Compact this member's underlying session to free context."}
              disabled={compactDisabled}
              onClick={() => props.onCompactParticipant(props.participant.id)}
            />
            {restartable && (
              <IconButton
                size="xs"
                icon={RotateCcw}
                iconClassName={restarting ? "animate-spin" : undefined}
                label={restartWait ? `Stop restarting ${displayName}` : `Restart ${displayName}`}
                tooltip={restartWait
                  ? "Stop waiting for the machine to restart this member."
                  : restarting
                    ? "Restarting…"
                    : restartDisabled
                      ? "This member is busy."
                      : "Restart this member's process so its next reply picks up changed connectors and settings."}
                disabled={restartDisabled}
                aria-expanded={confirmingRestart || undefined}
                onClick={onRestartButton}
              />
            )}
            <IconButton
              size="xs"
              icon={AtSign}
              label={`Mention ${displayName}`}
              tooltip="Add this member mention to your message."
              onClick={() => props.onInsertMention(props.participant)}
            />
            <IconButton
              size="xs"
              tone="danger"
              icon={Trash2}
              label={`Remove ${displayName} from chat`}
              tooltip={props.removeDisabledReason ?? "Remove from chat"}
              disabled={Boolean(props.removeDisabledReason)}
              onClick={() => props.onRemoveParticipant(props.participant.id)}
            />
          </div>
        </div>
        {restartWait && (
          <div className="chat-participant-restart-note" role="status">{restartWait.message}</div>
        )}
        {/* Work that ended while asking needs no question any more. */}
        {confirmingRestart && backgroundTasks.length > 0 && (
          <div className="chat-participant-restart-confirm" role="group" aria-label={`Restart ${displayName}`}>
            <span className="chat-participant-restart-confirm-text">
              {`Restarting stops ${displayName}'s ${backgroundTasks.length === 1 ? "background task" : backgroundTasksStatusLabel(backgroundTasks.length)}.`}
            </span>
            <button type="button" className="chat-participant-restart-confirm-cancel" onClick={() => setConfirmingRestart(false)}>
              Cancel
            </button>
            <button type="button" className="chat-participant-restart-confirm-ok" onClick={() => void restart(true)}>
              Stop and restart
            </button>
          </div>
        )}
        {expanded && (
          <ParticipantRuntimeControls
            participant={props.participant}
            disabled={props.busy}
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
  /** The runtime controls; by default disabled with the member. */
  controlsDisabled?: boolean;
  roleLabel: string;
  remoteExecution?: ChatParticipant["remoteExecution"];
  runtimeOverride?: ChatParticipantRuntimeOverride;
  renderParticipantAvatar: (participant: ChatParticipantConfig) => React.ReactNode;
  onToggleSelected: (participantId: string) => void;
  onRuntimeChange: (participant: ChatParticipantConfig, patch: ParticipantRuntimePatch) => void;
  cliProviderHosts?: CliProviderHost[];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const displayName = chatParticipantDisplayName(props.participant);
  // A member that cannot run where it is set to can always be taken out again.
  const checkboxDisabled = Boolean(props.locked) || (Boolean(props.disabledReason) && !props.selected);
  const runtimeOverride = props.runtimeOverride ?? {};
  const host = cliProviderHostForParticipant(props.participant.kind, props.participant.hostId, props.cliProviderHosts ?? []);
  const participant: ChatParticipant = {
    ...props.participant,
    hostId: host?.id,
    hostLabel: host?.label,
    hostVendor: host?.vendor,
    model: "model" in runtimeOverride ? runtimeOverride.model : props.participant.model,
    reasoningEffort: "reasoningEffort" in runtimeOverride ? runtimeOverride.reasoningEffort : props.participant.reasoningEffort,
    agentMode: runtimeOverride.agentMode ?? props.participant.agentMode,
    permissions: runtimeOverride.permissions ?? props.participant.permissions,
    remoteExecution: runtimeOverride.remoteExecution ?? props.remoteExecution ?? props.participant.remoteExecution,
    homeMachineId: "homeMachineId" in runtimeOverride ? runtimeOverride.homeMachineId : props.participant.homeMachineId,
    cloudRun: "cloudRun" in runtimeOverride ? runtimeOverride.cloudRun : props.participant.cloudRun,
    skipToolchainPreflight: runtimeOverride.skipToolchainPreflight ?? props.participant.skipToolchainPreflight,
    autoWatch: runtimeOverride.autoWatch ?? props.participant.autoWatchEnabled
  };

  return (
    <div
      className={`chat-participant-row chat-participant-select-row ${props.selected ? "is-selected" : ""} ${expanded ? "is-expanded" : "is-collapsed"} ${props.disabledReason ? "is-disabled" : ""}`}
    >
      <span className="chat-participant-avatar-slot" aria-hidden>
        {props.renderParticipantAvatar(props.participant)}
      </span>
      <div className="chat-participant-row-body">
        <div className="chat-participant-row-head">
          <button
            type="button"
            className="chat-participant-identity"
            title={props.disabledReason}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="chat-participant-name-line">
              <strong className="chat-participant-name">{displayName}</strong>
              <span className="chat-participant-meta-sep" aria-hidden />
              <span className="chat-participant-provider">{chatCliProviderLabel(props.participant.kind, host?.label)}</span>
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
            disabled={props.controlsDisabled ?? Boolean(props.disabledReason)}
            runLocationLocked={false}
            onUpdate={(_participantId, patch) => props.onRuntimeChange(props.participant, patch)}
          />
        )}
      </div>
    </div>
  );
}
