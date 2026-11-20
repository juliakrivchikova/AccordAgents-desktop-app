import { createContext, useContext, useState, type ReactNode } from "react";
import { Check, ChevronDown, MessagesSquare, PanelRight, PanelRightClose, type LucideIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconButton } from "../primitives";
import type { ChatViewMode } from "../../../shared/types";

export const CHAT_VIEW_SWITCH_DISABLED_REASON = "This chat was made before main sessions, so it has the classic view only.";

// The icon stands in for the label when the header is narrow (chat-sessions.css).
const VIEW_OPTIONS: ReadonlyArray<{ view: ChatViewMode; label: string; icon: LucideIcon }> = [
  { view: "sessions", label: "Sessions", icon: PanelRight },
  { view: "classic", label: "Classic", icon: MessagesSquare }
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
          aria-label={option.label}
          title={option.label}
          disabled={!props.canSwitch}
          onClick={() => props.onChange(option.view)}
        >
          <option.icon className="chat-view-switch-icon" size={14} aria-hidden />
          <span className="chat-view-switch-label">{option.label}</span>
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
  return runningCount > 0 ? `Side panel (${runningCount} running)` : "Side panel";
}

/** What the open chat puts into the header: its view switch and, in the
 *  sessions view, the toggle of its side panel. */
export interface ChatViewHeaderState {
  view: ChatViewMode;
  canSwitch: boolean;
  onChangeView: (view: ChatViewMode) => void;
  members?: {
    runningCount: number;
    /** An Accord is open: a dot on the toggle. */
    accordOpen?: boolean;
    open: boolean;
    onToggle: () => void;
  };
}

export const ChatViewHeaderContext = createContext<ChatViewHeaderState | undefined>(undefined);

/** Header controls only the classic view has (the roster's popover): the
 *  sessions view keeps its members in its one side panel. */
export function ChatClassicOnly(props: { children: ReactNode }): JSX.Element | null {
  const state = useContext(ChatViewHeaderContext);
  return state?.view === "sessions" ? null : <>{props.children}</>;
}

/** Rendered among the header's actions; the chat view the header sits in
 *  provides its state, so outside a chat it shows nothing. The classic view
 *  has its switch here; the sessions view (like Claude's desktop app) has
 *  only an icon that opens and closes its side panel, and its switch in the
 *  title's menu (ChatViewTitleMenu). */
export function ChatViewHeaderControls(): JSX.Element | null {
  const state = useContext(ChatViewHeaderContext);
  if (!state) {
    return null;
  }
  if (state.view === "sessions" && state.members) {
    const { members } = state;
    const label = chatMembersButtonLabel(members.runningCount);
    return (
      <div className="chat-view-header-controls is-sessions">
        <span className="chat-side-panel-toggle">
          <IconButton
            icon={members.open ? PanelRightClose : PanelRight}
            label={label}
            tooltip={label}
            pressed={members.open}
            data-testid="chat-members-button"
            data-running-count={members.runningCount}
            onClick={members.onToggle}
          />
          {members.runningCount > 0 && <span className="chat-side-panel-badge" data-testid="chat-side-panel-badge" aria-hidden>{members.runningCount}</span>}
          {members.runningCount === 0 && members.accordOpen && <span className="chat-side-panel-dot" data-testid="chat-side-panel-dot" aria-hidden />}
        </span>
      </div>
    );
  }
  return (
    <div className="chat-view-header-controls">
      <ChatViewSwitch view={state.view} canSwitch={state.canSwitch} onChange={state.onChangeView} />
    </div>
  );
}

/** The chevron beside the chat's title in the sessions view: its menu holds
 *  the view switch ("View: Sessions / Classic"). Nothing elsewhere. */
export function ChatViewTitleMenu(): JSX.Element | null {
  const state = useContext(ChatViewHeaderContext);
  const [open, setOpen] = useState(false);
  if (!state || state.view !== "sessions") {
    return null;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton size="xs" icon={ChevronDown} label="Chat menu" tooltip="Chat menu" data-testid="chat-title-menu" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="chat-title-menu" data-testid="chat-title-menu-content">
        <ChatViewMenuItems state={state} onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** The title menu's view items: "View", Sessions and Classic, the shown one
 *  checked. */
export function ChatViewMenuItems(props: { state: ChatViewHeaderState; onPicked?: () => void }): JSX.Element {
  const { state } = props;
  return (
    <>
      <div className="chat-title-menu-label">View</div>
      {VIEW_OPTIONS.map((option) => (
        <button
          key={option.view}
          type="button"
          role="menuitemradio"
          aria-checked={state.view === option.view}
          className="chat-title-menu-item"
          data-testid={`chat-view-switch-${option.view}`}
          disabled={!state.canSwitch}
          onClick={() => {
            props.onPicked?.();
            state.onChangeView(option.view);
          }}
        >
          <option.icon size={14} aria-hidden />
          <span>{option.label}</span>
          {state.view === option.view && <Check size={14} aria-hidden className="chat-title-menu-check" />}
        </button>
      ))}
    </>
  );
}
