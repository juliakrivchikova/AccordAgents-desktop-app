import { Bot, MessageSquare } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/renderer/components/primitives";
import { labelForKind } from "@/renderer/lib/conversation-labels";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "../../../shared/types";

export interface SidebarProps {
  conversations: ConversationSummary[];
  activeId?: string;
  busy?: boolean;
  onSelect: (id: string) => void;
  onNewSession: () => void;
}

export const Sidebar = ({
  conversations,
  activeId,
  busy,
  onSelect,
  onNewSession
}: SidebarProps): JSX.Element => (
  <aside
    data-shell="sidebar"
    className="flex min-h-0 flex-col border-r border-border bg-[var(--app-surface-subtle)] text-foreground"
  >
    <div
      data-shell="sidebar-brand"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 text-sm font-semibold text-[var(--app-text-strong)]"
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
          "border border-border bg-background px-3 text-xs font-medium text-foreground",
          "transition-colors hover:bg-muted/60",
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

    <ScrollArea className="flex-1 px-2 pb-2">
      <div className="flex flex-col gap-0.5">
        {conversations.length === 0 ? (
          <EmptyState size="sm">
            <EmptyState.Body>No conversations yet</EmptyState.Body>
          </EmptyState>
        ) : (
          conversations.map((summary) => (
            <button
              key={summary.id}
              type="button"
              onClick={() => onSelect(summary.id)}
              data-selected={summary.id === activeId ? "true" : undefined}
              className={cn(
                "group flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm",
                "transition-colors hover:bg-muted/60",
                "data-[selected=true]:bg-[var(--app-surface-active)] data-[selected=true]:text-[var(--app-text-strong)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              )}
            >
              <span className="truncate text-[13px] leading-tight">{summary.title}</span>
              <span className="text-[11px] text-muted-foreground">
                {labelForKind(summary.kind)}
              </span>
            </button>
          ))
        )}
      </div>
    </ScrollArea>
  </aside>
);
