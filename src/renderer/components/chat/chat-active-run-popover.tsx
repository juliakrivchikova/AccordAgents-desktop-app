import { Loader2, X } from "lucide-react";
import { useState } from "react";
import type React from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatParticipant } from "../../../shared/types";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { RosterStatusIndicator, type ChatParticipantRosterStatus } from "./chat-roster-status";

export interface ChatActiveRunParticipantRow {
  participant: ChatParticipant;
  runIds: string[];
  status: ChatParticipantRosterStatus;
}

export function ChatActiveRunRow(props: ChatActiveRunParticipantRow & {
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  onSelectParticipant?: (participantId: string) => void;
  onStopParticipantRuns?: (runIds: string[]) => void;
}): JSX.Element {
  const participantName = chatParticipantDisplayName(props.participant);
  const participantRunLabel = `${props.runIds.length} active ${props.runIds.length === 1 ? "run" : "runs"}`;
  const identity = (
    <>
      <span className="composer-active-run-row-name">{participantName}</span>
      <span className="composer-active-run-row-meta">
        <span className="composer-active-run-row-role">{props.participantRoleLabel(props.participant)}</span>
        <RosterStatusIndicator
          status={props.status}
          runningRemotely={props.participant.remoteExecution === "remote"}
        />
      </span>
    </>
  );
  return (
    <div className="composer-active-run-row">
      {props.renderParticipantAvatar(props.participant)}
      {props.onSelectParticipant ? (
        <button
          type="button"
          className="composer-active-run-row-main"
          onClick={() => props.onSelectParticipant?.(props.participant.id)}
        >
          {identity}
        </button>
      ) : (
        <span className="composer-active-run-row-main">{identity}</span>
      )}
      {props.onStopParticipantRuns && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="composer-active-run-row-stop"
              aria-label={`Stop ${participantName} ${participantRunLabel}`}
              onClick={() => props.onStopParticipantRuns?.(props.runIds)}
            >
              <X size={13} aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Stop {participantName}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function ChatActiveRunPopover(props: {
  activeRunCount: number;
  activeRunParticipantRows: ChatActiveRunParticipantRow[];
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  onStopAllRuns: () => void;
  onStopParticipantRuns?: (runIds: string[]) => void;
  onJumpToParticipantLastMessage?: (participantId: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const activeRunLabel = `${props.activeRunCount} active ${props.activeRunCount === 1 ? "run" : "runs"}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="composer-active-run" data-testid="composer-active-run-pill">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="composer-active-run-info"
            title="Show running members"
            aria-label={`${activeRunLabel}. Show running members.`}
          >
            <Loader2 size={13} className="spin" aria-hidden />
            <span>{activeRunLabel}</span>
          </button>
        </PopoverTrigger>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="composer-active-run-stop"
              aria-label={`Stop ${activeRunLabel}`}
              onClick={props.onStopAllRuns}
            >
              <X size={13} aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Stop running members</TooltipContent>
        </Tooltip>
      </div>
      <PopoverContent
        align="start"
        sideOffset={8}
        data-testid="composer-active-run-popover"
        className="composer-active-run-popover w-[min(360px,calc(100vw-32px))] p-2"
      >
        <div className="composer-active-run-popover-head">
          <span className="chat-popover-section-title">Running members</span>
          <span className="composer-active-run-popover-count">{props.activeRunParticipantRows.length}</span>
        </div>
        <div className="composer-active-run-list">
          {props.activeRunParticipantRows.length > 0 ? (
            props.activeRunParticipantRows.map((row) => (
              <ChatActiveRunRow
                key={row.participant.id}
                {...row}
                renderParticipantAvatar={props.renderParticipantAvatar}
                participantRoleLabel={props.participantRoleLabel}
                onSelectParticipant={props.onJumpToParticipantLastMessage ? (participantId) => {
                  props.onJumpToParticipantLastMessage?.(participantId);
                  setOpen(false);
                } : undefined}
                onStopParticipantRuns={props.onStopParticipantRuns}
              />
            ))
          ) : (
            <div className="composer-active-run-empty">No running member details available.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
