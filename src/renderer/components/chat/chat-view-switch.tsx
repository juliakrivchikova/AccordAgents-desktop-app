import { createContext, useContext } from "react";
import { Users } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatViewMode } from "../../../shared/types";

export const CHAT_VIEW_SWITCH_DISABLED_REASON = "This chat was made before main sessions, so it has the classic view only.";

const VIEW_OPTIONS: ReadonlyArray<{ view: ChatViewMode; label: string }> = [
  { view: "sessions", label: "Sessions" },
  { view: "classic", label: "Classic" }
];

/** The chat's two views (docs/main-session.md), switched from the header. */
export function ChatViewSwitch(props: {
  view: ChatViewMode;
  canSwitch: boolean;
  onChange: (view: ChatViewMode) => void;
}): JSX.Element {
  const group = (
    <div
      className={`chat-view-switch ${props.canSwitch ? "" : "is-disabled"}`}
      role="group"
      aria-label="Chat view"
      data-testid="chat-view-switch"
      data-chat-view={props.view}
      data-disabled-reason={props.canSwitch ? undefined : CHAT_VIEW_SWITCH_DISABLED_REASON}
      tabIndex={props.canSwitch ? undefined : 0}
    >
      {VIEW_OPTIONS.map((option) => (
        <button
          key={option.view}
          type="button"
          className="chat-view-switch-option"
          data-view={option.view}
          data-testid={`chat-view-switch-${option.view}`}
          aria-pressed={props.view === option.view}
          disabled={!props.canSwitch}
          onClick={() => props.onChange(option.view)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
  if (props.canSwitch) {
    return group;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{group}</TooltipTrigger>
      <TooltipContent side="bottom">{CHAT_VIEW_SWITCH_DISABLED_REASON}</TooltipContent>
    </Tooltip>
  );
}

export function chatMembersButtonLabel(runningCount: number): string {
  return runningCount > 0 ? `Members (${runningCount} running)` : "Members";
}

/** What the open chat puts into the header: its view switch and, in the
 *  sessions view, the button of its members panel. */
export interface ChatViewHeaderState {
  view: ChatViewMode;
  canSwitch: boolean;
  onChangeView: (view: ChatViewMode) => void;
  members?: {
    runningCount: number;
    open: boolean;
    onToggle: () => void;
  };
}

export const ChatViewHeaderContext = createContext<ChatViewHeaderState | undefined>(undefined);

/** Rendered among the header's actions; the chat view the header sits in
 *  provides its state, so outside a chat it shows nothing. */
export function ChatViewHeaderControls(): JSX.Element | null {
  const state = useContext(ChatViewHeaderContext);
  if (!state) {
    return null;
  }
  return (
    <div className="chat-view-header-controls">
      {state.members && (
        <button
          type="button"
          className={`chat-members-button ${state.members.open ? "is-open" : ""} ${state.members.runningCount > 0 ? "is-running" : ""}`}
          data-testid="chat-members-button"
          data-running-count={state.members.runningCount}
          aria-pressed={state.members.open}
          onClick={state.members.onToggle}
        >
          <Users size={14} aria-hidden />
          <span>{chatMembersButtonLabel(state.members.runningCount)}</span>
        </button>
      )}
      <ChatViewSwitch view={state.view} canSwitch={state.canSwitch} onChange={state.onChangeView} />
    </div>
  );
}
