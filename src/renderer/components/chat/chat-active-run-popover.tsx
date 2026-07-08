import { Loader2, X } from "lucide-react";
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

export function ChatActiveRunPopover(props: {
  activeRunCount: number;
  activeRunParticipantRows: ChatActiveRunParticipantRow[];
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  onStopAllRuns: () => void;
  onStopParticipantRuns?: (runIds: string[]) => void;
}): JSX.Element {
  const activeRunLabel = `${props.activeRunCount} active ${props.activeRunCount === 1 ? "run" : "runs"}`;
  return (
    <Popover>
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
            props.activeRunParticipantRows.map(({ participant, runIds, status }) => {
              const participantName = chatParticipantDisplayName(participant);
              const participantRunLabel = `${runIds.length} active ${runIds.length === 1 ? "run" : "runs"}`;
              return (
                <div className="composer-active-run-row" key={participant.id}>
                  {props.renderParticipantAvatar(participant)}
                  <span className="composer-active-run-row-main">
                    <span className="composer-active-run-row-name">{participantName}</span>
                    <span className="composer-active-run-row-meta">
                      <span className="composer-active-run-row-role">{props.participantRoleLabel(participant)}</span>
                      <RosterStatusIndicator
                        status={status}
                        runningRemotely={participant.remoteExecution === "remote"}
                      />
                    </span>
                  </span>
                  {props.onStopParticipantRuns && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="composer-active-run-row-stop"
                          aria-label={`Stop ${participantName} ${participantRunLabel}`}
                          onClick={() => props.onStopParticipantRuns?.(runIds)}
                        >
                          <X size={13} aria-hidden />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">Stop {participantName}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              );
            })
          ) : (
            <div className="composer-active-run-empty">No running member details available.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
