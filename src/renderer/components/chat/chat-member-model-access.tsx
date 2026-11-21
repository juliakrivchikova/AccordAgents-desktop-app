import { useCallback, useContext, useState, type ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { canRestartParticipant, memberProcessRestartable } from "../../../shared/chatParticipantStatus";
import { FORK_TO_NEW_CHAT_DETAIL, FORK_TO_NEW_CHAT_LABEL } from "../../../shared/forkToNewChat";
import type { MemberRestartInProgress } from "../../../shared/memberRestart";
import type { ChatParticipant } from "../../../shared/types";
import { ChatModelAccessPanel, type ChatModelAccessAction, type ChatModelAccessPatch } from "./chat-model-access-picker";
import { backgroundTasksStatusLabel, ChatBackgroundTasksContext, type ChatParticipantRosterStatus } from "./chat-roster-status";

export type ChatMemberRuntimePatch = Partial<Pick<ChatParticipant,
  "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "cloudRun" | "homeMachineId" | "skipToolchainPreflight" | "autoWatch">>;

/**
 * A member's settings in the sessions view (the User, 2026-11-21): the main
 * session's from its composer chip, a member's from its chip or the gear in
 * its session's header. The compact picker of its model, effort, access and
 * where it runs; its provider stays the one it was made with. Its … menu
 * restarts it (so its next reply picks up changed connectors, as the classic
 * roster's restart does) and, for a member other than the main session,
 * removes it. Its own turn running, its settings wait, as a CLI's settings
 * apply to its next turn.
 */
export function ChatMemberModelAccess(props: {
  participant: ChatParticipant;
  trigger: ReactNode;
  /** Its own turn or compaction runs. */
  working: boolean;
  /** Its roster state: a restart waits until it is idle. */
  status?: ChatParticipantRosterStatus;
  runLocationLocked: boolean;
  runLocationMoves: boolean;
  /** Saves what changed (only the keys given); resolves false when it failed. */
  onUpdate: (participantId: string, patch: ChatMemberRuntimePatch) => unknown;
  /** Restarts its process; resolves once the restart ended. */
  onRestart?: (participantId: string, stopBackgroundTasks: boolean) => unknown;
  /** Stops waiting for a restart its machine has not taken (its run id). */
  onStopRestart?: (runId: string) => void;
  /** Its restart has not ended. */
  restartStatus?: MemberRestartInProgress;
  /** Removes it from the chat; none for the main session. */
  onRemove?: () => void;
  /** Why it cannot be removed now. */
  removeDisabledReason?: string;
  /** Makes a new chat whose main session is a copy of it (Fork to new chat). */
  onForkToNewChat?: () => void;
  /** Why it cannot be forked to a new chat now. */
  forkToNewChatDisabledReason?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { participant, onUpdate } = props;
  // Only what was chosen is sent: a second quick choice never sends the
  // first one back as it stood before it was saved.
  const change = useCallback((patch: ChatModelAccessPatch) => onUpdate(participant.id, patch), [onUpdate, participant.id]);
  const backgroundTasks = useContext(ChatBackgroundTasksContext).get(participant.id) ?? [];
  const actions = memberSettingsActions({
    participant,
    status: props.status,
    backgroundTaskCount: backgroundTasks.length,
    restartStatus: props.restartStatus,
    onRestart: props.onRestart,
    onStopRestart: props.onStopRestart,
    onRemove: props.onRemove,
    removeDisabledReason: props.removeDisabledReason,
    onForkToNewChat: props.onForkToNewChat,
    forkToNewChatDisabledReason: props.forkToNewChatDisabledReason,
    close: () => setOpen(false)
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{props.trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        data-testid="chat-member-settings"
        className="chat-model-access-popover w-[min(320px,calc(100vw-32px))] max-h-[min(560px,calc(100vh-96px))] overflow-auto p-1.5"
      >
        <ChatModelAccessPanel
          value={participant}
          onChange={change}
          disabled={props.working}
          runsOn={{ locked: props.runLocationLocked, moves: props.runLocationMoves }}
          actions={actions.length > 0 ? actions : undefined}
        />
      </PopoverContent>
    </Popover>
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
