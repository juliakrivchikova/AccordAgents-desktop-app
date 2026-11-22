import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";

import { canRestartParticipant, memberProcessRestartable } from "../../../shared/chatParticipantStatus";
import { FORK_TO_NEW_CHAT_DETAIL, FORK_TO_NEW_CHAT_LABEL } from "../../../shared/forkToNewChat";
import type { MemberRestartInProgress } from "../../../shared/memberRestart";
import type { ChatParticipant } from "../../../shared/types";
import { ChatMemberComposerControls, type ChatModelAccessAction, type ChatModelAccessPatch } from "./chat-model-access-picker";
import { backgroundTasksStatusLabel, ChatBackgroundTasksContext, type ChatParticipantRosterStatus } from "./chat-roster-status";
import { ComposerMenu, ComposerMenuItem, ComposerMenuSection } from "./composer-menu";

export type ChatMemberRuntimePatch = Partial<Pick<ChatParticipant,
  "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "cloudRun" | "homeMachineId" | "skipToolchainPreflight" | "autoWatch">>;

/**
 * A member's settings in the sessions view (the User, 2026-11-21): quiet
 * controls under its composer (the main session's under the main composer, a
 * member's under its session's composer), each opening its own small menu:
 * model, effort, permission mode (Codex's Plan mode beside it) and, once a
 * machine exists, where it runs. Its provider stays the one it was made
 * with. Its own turn running, its settings wait, as a CLI's settings apply
 * to its next turn.
 */
export function ChatMemberComposerSettings(props: {
  participant: ChatParticipant;
  /** Its own turn or compaction runs. */
  working: boolean;
  runLocationLocked: boolean;
  runLocationMoves: boolean;
  /** The chat's main session: a member it made is held to it. */
  mainSession?: ChatParticipant;
  /** Saves what changed (only the keys given); resolves false when it failed. */
  onUpdate: (participantId: string, patch: ChatMemberRuntimePatch) => unknown;
}): JSX.Element {
  const { participant, onUpdate } = props;
  // Choices not saved yet are shown at once, and a second quick choice is
  // made on top of them: the permission mode and Codex's Plan mode each send
  // the member's whole mode, so one made from the member as it stood before
  // the first was saved would send that first choice back (a mode lowered
  // from Full Access, then Plan clicked, would return to Full Access).
  const [pending, setPending] = useState<{ memberId: string; patch: ChatModelAccessPatch }>();
  const latest = useRef(0);
  useEffect(() => {
    latest.current += 1;
    setPending(undefined);
  }, [participant.id]);
  const value = useMemo(
    () => (pending && pending.memberId === participant.id ? { ...participant, ...pending.patch } : participant),
    [participant, pending]
  );
  // Only what was chosen is sent; once the last choice is saved (or failed)
  // the member as stored is shown again.
  const change = useCallback(async (patch: ChatModelAccessPatch) => {
    const choice = ++latest.current;
    setPending((current) => ({ memberId: participant.id, patch: { ...(current?.memberId === participant.id ? current.patch : {}), ...patch } }));
    try {
      return await onUpdate(participant.id, patch);
    } finally {
      if (latest.current === choice) setPending(undefined);
    }
  }, [onUpdate, participant.id]);
  return (
    <ChatMemberComposerControls
      value={value}
      onChange={change}
      disabled={props.working}
      runsOn={{ locked: props.runLocationLocked, moves: props.runLocationMoves }}
      mainSession={props.mainSession}
      testId="chat-member-controls"
    />
  );
}

/**
 * A member's … menu (its session's header; the main session's are in the
 * chat title's menu): Restart (picks up changed connectors, idle only,
 * naming background work it stops; not Antigravity), Fork to new chat, and,
 * for a member other than the main session, Remove from chat.
 */
export function ChatMemberActionsMenu(props: {
  participant: ChatParticipant;
  status?: ChatParticipantRosterStatus;
  onRestart?: (participantId: string, stopBackgroundTasks: boolean) => unknown;
  onStopRestart?: (runId: string) => void;
  restartStatus?: MemberRestartInProgress;
  onRemove?: () => void;
  removeDisabledReason?: string;
  onForkToNewChat?: () => void;
  forkToNewChatDisabledReason?: string;
}): JSX.Element | null {
  const backgroundTasks = useContext(ChatBackgroundTasksContext).get(props.participant.id) ?? [];
  const actions = (close: () => void): ChatModelAccessAction[] => memberSettingsActions({
    participant: props.participant,
    status: props.status,
    backgroundTaskCount: backgroundTasks.length,
    restartStatus: props.restartStatus,
    onRestart: props.onRestart,
    onStopRestart: props.onStopRestart,
    onRemove: props.onRemove,
    removeDisabledReason: props.removeDisabledReason,
    onForkToNewChat: props.onForkToNewChat,
    forkToNewChatDisabledReason: props.forkToNewChatDisabledReason,
    close
  });
  if (actions(() => undefined).length === 0) return null;
  return (
    <ComposerMenu
      testId="chat-member-actions"
      title="More"
      width={280}
      align="end"
      bare
      triggerClassName="chat-member-actions-trigger"
      label={<DotsThreeIcon size={16} aria-hidden />}
    >
      {(close) => <ChatMemberActionItems actions={actions(close)} />}
    </ComposerMenu>
  );
}

/** The … actions as menu items, each with its muted line (what it does, or
 *  why not). */
export function ChatMemberActionItems(props: { actions: readonly ChatModelAccessAction[] }): JSX.Element {
  return (
    <ComposerMenuSection>
      {props.actions.map((action) => (
        <ComposerMenuItem key={action.label} role="menuitem" testId="chat-member-action" label={action.label} detail={action.detail}
          disabled={action.disabled} tone={action.tone} onSelect={action.onSelect} />
      ))}
    </ComposerMenuSection>
  );
}

/** The … menu of a member's settings: Restart (as the classic roster has
 *  it: not for Antigravity, which starts a process per message; only while
 *  it is idle; naming the background work it stops), Fork to new chat
 *  (disabled with its reason when it cannot be made), and Remove. */
export function memberSettingsActions(input: {
  participant: Pick<ChatParticipant, "id" | "kind">;
  status?: ChatParticipantRosterStatus;
  backgroundTaskCount: number;
  restartStatus?: MemberRestartInProgress;
  onRestart?: (participantId: string, stopBackgroundTasks: boolean) => unknown;
  onStopRestart?: (runId: string) => void;
  onRemove?: () => void;
  removeDisabledReason?: string;
  onForkToNewChat?: () => void;
  forkToNewChatDisabledReason?: string;
  close: () => void;
}): ChatModelAccessAction[] {
  const actions: ChatModelAccessAction[] = [];
  if (input.onRestart && memberProcessRestartable(input.participant.kind)) {
    const waiting = input.restartStatus?.waiting ? input.restartStatus : undefined;
    if (waiting && input.onStopRestart) {
      actions.push({ label: "Stop restarting", onSelect: () => { input.close(); input.onStopRestart?.(waiting.runId); } });
    } else {
      const restarting = input.restartStatus !== undefined;
      const idle = input.status === undefined || canRestartParticipant(input.status);
      const tasks = input.backgroundTaskCount;
      // Background work ends with the process: the item says so before it is chosen.
      const label = restarting
        ? "Restarting…"
        : !idle
          ? "Restart (busy)"
          : tasks > 0
            ? `Restart (stops ${tasks === 1 ? "its background task" : backgroundTasksStatusLabel(tasks)})`
            : "Restart";
      actions.push({
        label,
        detail: "Picks up changed connectors and settings",
        disabled: restarting || !idle,
        onSelect: () => {
          input.close();
          void input.onRestart?.(input.participant.id, tasks > 0);
        }
      });
    }
  }
  if (input.onForkToNewChat) {
    const reason = input.forkToNewChatDisabledReason;
    actions.push({
      label: FORK_TO_NEW_CHAT_LABEL,
      detail: reason ?? FORK_TO_NEW_CHAT_DETAIL,
      disabled: Boolean(reason),
      onSelect: () => {
        input.close();
        input.onForkToNewChat?.();
      }
    });
  }
  if (input.onRemove) {
    actions.push({
      label: input.removeDisabledReason ? `Remove from chat (${input.removeDisabledReason})` : "Remove from chat",
      tone: "danger",
      disabled: Boolean(input.removeDisabledReason),
      onSelect: () => {
        input.close();
        input.onRemove?.();
      }
    });
  }
  return actions;
}
