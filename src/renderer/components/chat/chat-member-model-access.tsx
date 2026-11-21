import { useCallback, useState, type ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChatParticipant } from "../../../shared/types";
import { ChatModelAccessPanel, type ChatModelAccessAction, type ChatModelAccessPatch } from "./chat-model-access-picker";

export type ChatMemberRuntimePatch = Pick<ChatParticipant,
  "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "cloudRun" | "homeMachineId" | "skipToolchainPreflight" | "autoWatch">;

/**
 * A member's settings in the sessions view (the User, 2026-11-21): the main
 * session's from its composer chip, a member's from its chip or the gear in
 * its session's header. The compact picker of its model, effort, access and
 * where it runs; its provider stays the one it was made with. A member that
 * is not the main session can be removed from its … menu. Its own turn
 * running, its settings wait, as a CLI's settings apply to its next turn.
 */
export function ChatMemberModelAccess(props: {
  participant: ChatParticipant;
  trigger: ReactNode;
  /** Its own turn or compaction runs. */
  working: boolean;
  runLocationLocked: boolean;
  runLocationMoves: boolean;
  onUpdate: (participantId: string, patch: ChatMemberRuntimePatch) => unknown;
  /** Removes it from the chat; none for the main session. */
  onRemove?: () => void;
  /** Why it cannot be removed now. */
  removeDisabledReason?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { participant, onUpdate } = props;
  const change = useCallback((patch: ChatModelAccessPatch) => {
    // Every setting is sent, the changed ones from the patch by key presence,
    // so a reset to the CLI's own (model: undefined) is sent too.
    onUpdate(participant.id, {
      model: "model" in patch ? patch.model : participant.model,
      reasoningEffort: "reasoningEffort" in patch ? patch.reasoningEffort : participant.reasoningEffort,
      agentMode: "agentMode" in patch ? patch.agentMode : participant.agentMode,
      permissions: "permissions" in patch ? patch.permissions : participant.permissions,
      remoteExecution: "remoteExecution" in patch ? patch.remoteExecution : participant.remoteExecution,
      homeMachineId: "homeMachineId" in patch ? patch.homeMachineId : participant.homeMachineId,
      cloudRun: "cloudRun" in patch ? patch.cloudRun : participant.cloudRun,
      skipToolchainPreflight: participant.skipToolchainPreflight,
      autoWatch: participant.autoWatch
    });
  }, [onUpdate, participant]);
  const actions: ChatModelAccessAction[] | undefined = props.onRemove
    ? [{
      label: props.removeDisabledReason ? `Remove from chat (${props.removeDisabledReason})` : "Remove from chat",
      tone: "danger",
      disabled: Boolean(props.removeDisabledReason),
      onSelect: () => {
        setOpen(false);
        props.onRemove?.();
      }
    }]
    : undefined;
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
          actions={actions}
        />
      </PopoverContent>
    </Popover>
  );
}
