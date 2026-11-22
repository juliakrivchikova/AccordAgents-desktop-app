import { ArchiveIcon, BoxArrowUpIcon, PushPinIcon, PushPinSlashIcon, TrashIcon } from "@phosphor-icons/react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "../../../shared/types";
import { Spinner } from "@/components/ui/spinner";
import { formatCompactRelativeTime } from "../../app/compact-relative-time";

interface SidebarSessionRowProps {
  summary: ConversationSummary;
  selected: boolean;
  pending: boolean;
  /** A run of this device is in the chat: it cannot be archived or deleted. */
  running: boolean;
  /** Work is shown: a run here, or a member's reply not ended anywhere. */
  working: boolean;
  unread: boolean;
  /** Where the row is listed, for tests and styles (one chat can be listed
   *  under Pinned, Recents and its project at once). */
  section?: "pinned" | "recent" | "project" | "archived";
  /** Listed under a project: starts under the project's name. */
  indented?: boolean;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
  onDelete?: (summary: ConversationSummary) => void;
  onSetPinned?: (id: string, pinned: boolean) => void;
}

/** The one mark a chat row shows (the User, 2026-11-15): work in progress,
 *  else a member's question waiting for her, else something new, else none. */
export type SidebarSessionMark = "working" | "waiting" | "unread" | "none";

export function sidebarSessionMark(state: { working: boolean; waitingChoice: boolean; unread: boolean }): SidebarSessionMark {
  if (state.working) return "working";
  if (state.waitingChoice) return "waiting";
  if (state.unread) return "unread";
  return "none";
}

export const SidebarSessionRow = ({
  summary,
  selected,
  pending,
  running,
  working,
  unread,
  section,
  indented = false,
  onSelect,
  onArchive,
  onUnarchive,
  onDelete,
  onSetPinned
}: SidebarSessionRowProps): JSX.Element => {
  const relativeTime = formatCompactRelativeTime(summary.updatedAt);
  const archived = summary.archived === true;
  const pinned = summary.pinned === true;
  // A chat being opened shows as selected at once and gets no spinner: one
  // for half a second pushed the title aside on every click (the User,
  // 2026-11-22). The spinner is for work only.
  const mark = sidebarSessionMark({ working, waitingChoice: summary.waitingChoice === true, unread });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(summary.id)}
          data-selected={selected ? "true" : undefined}
          data-running={working ? "true" : undefined}
          data-unread={mark === "unread" ? "true" : undefined}
          data-waiting={mark === "waiting" ? "true" : undefined}
          data-archived={archived ? "true" : undefined}
          data-pinned={pinned ? "true" : undefined}
          data-section={section}
          data-conversation-id={summary.id}
          data-testid="project-session"
          aria-busy={pending || working ? "true" : undefined}
          aria-current={selected ? "page" : undefined}
          className={cn(
            "group flex h-7 w-full min-w-0 items-center gap-2 rounded-ui-8 px-2 text-left text-ui-13 text-ui-text",
            "transition-colors duration-120 ease-ui-out hover:bg-ui-row-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-focus-ring",
            indented && "pl-7",
            selected && "bg-ui-row-active text-ui-select-fg hover:bg-ui-row-active"
          )}
        >
          <span className="min-w-0 flex-1 truncate">{summary.title}</span>
          {/* Every mark sits after the title, so none moves it. */}
          {mark === "working" && <Spinner size={12} className="shrink-0" />}
          {mark === "waiting" && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-ui-warning"
              data-testid="session-waiting-mark"
              aria-label="Waiting for your answer"
              title="Waiting for your answer"
            />
          )}
          {mark === "unread" && <span className="size-1.5 shrink-0 rounded-full bg-ui-primary" aria-label="New activity" title="New activity" />}
          {relativeTime && (
            <span
              className={cn(
                "hidden shrink-0 text-ui-11 tabular-nums group-hover:inline group-focus-visible:inline",
                "text-ui-text-3"
              )}
            >
              {relativeTime}
            </span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {!archived && onSetPinned && (
          <ContextMenuItem onSelect={() => onSetPinned(summary.id, !pinned)} data-testid="session-pin-toggle">
            {pinned ? <PushPinSlashIcon aria-hidden /> : <PushPinIcon aria-hidden />}
            {pinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
        )}
        {archived ? (
          <>
            <ContextMenuItem onSelect={() => onUnarchive?.(summary.id)}>
              <BoxArrowUpIcon aria-hidden />
              Unarchive
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" disabled={running} onSelect={() => onDelete?.(summary)}>
              <TrashIcon aria-hidden />
              Delete permanently
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem disabled={running} onSelect={() => onArchive?.(summary.id)}>
            <ArchiveIcon aria-hidden />
            Archive
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
};
