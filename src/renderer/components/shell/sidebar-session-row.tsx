import { Archive, ArchiveRestore, Loader2, Pin, PinOff, Trash2 } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "../../../shared/types";

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
  onSelect,
  onArchive,
  onUnarchive,
  onDelete,
  onSetPinned
}: SidebarSessionRowProps): JSX.Element => {
  const relativeTime = formatCompactRelativeTime(summary.updatedAt);
  const archived = summary.archived === true;
  const pinned = summary.pinned === true;
  const mark = pending ? "working" : sidebarSessionMark({ working, waitingChoice: summary.waitingChoice === true, unread });
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
          className={cn(
            "sidebar-history-item group flex w-full min-w-0 max-w-full flex-col gap-0.5 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm",
            "border border-transparent transition-colors hover:bg-[var(--app-surface-hover)]",
            selected && "is-selected text-[var(--app-text-strong)]",
            pending && "is-loading",
            "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
          )}
        >
          <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px] leading-tight">
            {mark === "working" && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{summary.title}</span>
            {mark === "waiting" && (
              <span
                className="size-2 shrink-0 rounded-full bg-[var(--app-warning)]"
                data-testid="session-waiting-mark"
                aria-label="Waiting for your answer"
                title="Waiting for your answer"
              />
            )}
            {mark === "unread" && <span className="size-2 shrink-0 rounded-full bg-[var(--app-accent)]" aria-label="New activity" title="New activity" />}
            {relativeTime && <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime}</span>}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {!archived && onSetPinned && (
          <ContextMenuItem onSelect={() => onSetPinned(summary.id, !pinned)} data-testid="session-pin-toggle">
            {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
            {pinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
        )}
        {archived ? (
          <>
            <ContextMenuItem onSelect={() => onUnarchive?.(summary.id)}>
              <ArchiveRestore aria-hidden />
              Unarchive
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" disabled={running} onSelect={() => onDelete?.(summary)}>
              <Trash2 aria-hidden />
              Delete permanently
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem disabled={running} onSelect={() => onArchive?.(summary.id)}>
            <Archive aria-hidden />
            Archive
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
};

function formatCompactRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "now";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 14) {
    return `${diffDays}d`;
  }
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 8) {
    return `${diffWeeks}w`;
  }
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) {
    return `${Math.max(1, diffMonths)}mo`;
  }
  return `${Math.max(1, Math.floor(diffDays / 365))}y`;
}
