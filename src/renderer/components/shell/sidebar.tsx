import { Bot, MessageSquare } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { HistoryLoadingState } from "@/renderer/components/loading-states";
import { EmptyState } from "@/renderer/components/primitives";
import { labelForKind } from "@/renderer/lib/conversation-labels";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "../../../shared/types";

export interface SidebarProps {
  conversations: ConversationSummary[];
  activeId?: string;
  busy?: boolean;
  loading?: boolean;
  onSelect: (id: string) => void;
  onNewSession: () => void;
}

export const Sidebar = ({
  conversations,
  activeId,
  busy,
  loading,
  onSelect,
  onNewSession
}: SidebarProps): JSX.Element => (
  <aside
    data-shell="sidebar"
    className="flex min-h-0 flex-col border-r border-[var(--app-shell-border)] bg-[var(--app-sidebar-bg)] text-foreground"
  >
    <div
      data-shell="sidebar-brand"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--app-shell-border)] px-3 text-sm font-semibold text-[var(--app-text-strong)]"
    >
      <Bot className="size-4" aria-hidden />
      <span>AI Consensus</span>
    </div>

    <div className="px-3 pt-3 pb-2">
      <button
        type="button"
        onClick={onNewSession}
        disabled={busy}
        className={cn(
          "inline-flex h-8 w-full items-center justify-center gap-2 rounded-md",
          "border border-[var(--app-border-strong)] bg-[var(--app-surface)] px-3 text-xs font-medium text-foreground",
          "transition-colors hover:border-[var(--app-accent-border)] hover:bg-[var(--app-surface-hover)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        )}
      >
        <MessageSquare className="size-3.5" aria-hidden />
        <span>New session</span>
      </button>
    </div>

    <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      History
    </div>

    <ScrollArea className="min-w-0 flex-1 px-2 pb-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        {loading ? (
          <HistoryLoadingState />
        ) : conversations.length === 0 ? (
          <EmptyState size="sm">
            <EmptyState.Body>No conversations yet</EmptyState.Body>
          </EmptyState>
        ) : (
          conversations.map((summary) => {
            const selected = summary.id === activeId;
            return (
              <button
                key={summary.id}
                type="button"
                onClick={() => onSelect(summary.id)}
                data-selected={selected ? "true" : undefined}
                className={cn(
                  "sidebar-history-item group flex w-full min-w-0 max-w-full flex-col gap-0.5 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm",
                  "border border-transparent transition-colors hover:bg-[var(--app-surface-hover)]",
                  selected && "is-selected text-[var(--app-text-strong)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                )}
              >
                <span className="w-full min-w-0 truncate text-[13px] leading-tight">{summary.title}</span>
                <span className="w-full min-w-0 truncate text-[11px] text-muted-foreground">
                  {labelForKind(summary.kind)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </ScrollArea>
  </aside>
);
