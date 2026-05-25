import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, Folder, Loader2, MessageSquare, PanelLeftClose, Plus } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { HistoryLoadingState } from "@/renderer/components/loading-states";
import { EmptyState } from "@/renderer/components/primitives";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "../../../shared/types";

const INITIAL_PROJECT_SESSION_LIMIT = 5;

export interface ProjectSessionGroup {
  key: string;
  label: string;
  repoPath?: string;
  updatedAt: string;
  sessions: ConversationSummary[];
  isNoProject?: boolean;
}

export interface SidebarProps {
  projectGroups: ProjectSessionGroup[];
  activeId?: string;
  pendingId?: string;
  busy?: boolean;
  loading?: boolean;
  unreadIds?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onNewProjectSession: (repoPath?: string) => void;
  onToggleSidebar?: () => void;
}

export const Sidebar = ({
  projectGroups,
  activeId,
  pendingId,
  busy,
  loading,
  unreadIds,
  onSelect,
  onNewSession,
  onNewProjectSession,
  onToggleSidebar
}: SidebarProps): JSX.Element => {
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set());
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<Set<string>>(new Set());

  function toggleProject(key: string): void {
    setCollapsedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function showMoreSessions(key: string): void {
    setExpandedProjectKeys((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  return (
    <aside
      id="app-sidebar"
      data-shell="sidebar"
      className="flex min-h-0 flex-col border-r border-[var(--app-shell-border)] bg-[var(--app-sidebar-bg)] text-foreground"
    >
      <div
        data-shell="sidebar-brand"
        className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--app-shell-border)] px-3 text-sm font-semibold text-[var(--app-text-strong)]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">AI Consensus</span>
        </div>
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            title="Hide sidebar"
            aria-label="Hide sidebar"
            aria-controls="app-sidebar"
            aria-expanded="true"
            data-testid="sidebar-collapse-toggle"
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
              "transition-colors hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            )}
          >
            <PanelLeftClose className="size-4" aria-hidden />
          </button>
        )}
      </div>

      <div className="px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={onNewSession}
          disabled={busy}
          data-testid="new-chat"
          className={cn(
            "inline-flex h-8 w-full items-center justify-center gap-2 rounded-md",
            "border border-[var(--app-border-strong)] bg-[var(--app-surface)] px-3 text-xs font-medium text-foreground",
            "transition-colors hover:border-[var(--app-accent-border)] hover:bg-[var(--app-surface-hover)]",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          )}
        >
          <MessageSquare className="size-3.5" aria-hidden />
          <span>New chat</span>
        </button>
      </div>

      <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Projects
      </div>

      <ScrollArea className="min-h-0 min-w-0 flex-1 px-2 pb-2">
        <div className="flex min-w-0 flex-col gap-1">
          {loading ? (
            <HistoryLoadingState />
          ) : projectGroups.length === 0 ? (
            <EmptyState size="sm">
              <EmptyState.Body>No conversations yet</EmptyState.Body>
            </EmptyState>
          ) : (
            projectGroups.map((group) => {
              const collapsed = collapsedProjectKeys.has(group.key);
              const expanded = expandedProjectKeys.has(group.key);
              const visibleSessions = expanded ? group.sessions : group.sessions.slice(0, INITIAL_PROJECT_SESSION_LIMIT);
              const hiddenCount = group.sessions.length - visibleSessions.length;
              return (
                <section key={group.key} className="min-w-0" data-testid="project-group" data-project-key={group.key}>
                  <div className="group flex min-w-0 items-center gap-1 rounded-md px-1 py-1">
                    <button
                      type="button"
                      onClick={() => toggleProject(group.key)}
                      aria-expanded={!collapsed}
                      data-testid="project-toggle"
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm",
                        "text-[var(--app-text)] transition-colors hover:bg-[var(--app-surface-hover)]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      )}
                    >
                      {collapsed ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 truncate font-medium">{group.label}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onNewProjectSession(group.repoPath)}
                      disabled={busy}
                      title={`New chat in ${group.label}`}
                      aria-label={`New chat in ${group.label}`}
                      data-testid="project-new-session"
                      className={cn(
                        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
                        "opacity-0 transition-colors hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)] group-hover:opacity-100",
                        "disabled:cursor-not-allowed disabled:opacity-30",
                        "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      )}
                    >
                      <Plus className="size-3.5" aria-hidden />
                    </button>
                  </div>

                  {!collapsed && (
                    <div className="ml-6 flex min-w-0 flex-col gap-0.5">
                      {visibleSessions.map((summary) => {
                        const pending = summary.id === pendingId;
                        const selected = summary.id === activeId || pending;
                        const relativeTime = formatCompactRelativeTime(summary.updatedAt);
                        const running = summary.running === true;
                        const unread = !selected && !running && unreadIds?.has(summary.id) === true;
                        return (
                          <button
                            key={summary.id}
                            type="button"
                            onClick={() => onSelect(summary.id)}
                            data-selected={selected ? "true" : undefined}
                            data-running={running ? "true" : undefined}
                            data-unread={unread ? "true" : undefined}
                            data-testid="project-session"
                            aria-busy={pending || running ? "true" : undefined}
                            className={cn(
                              "sidebar-history-item group flex w-full min-w-0 max-w-full flex-col gap-0.5 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm",
                              "border border-transparent transition-colors hover:bg-[var(--app-surface-hover)]",
                              selected && "is-selected text-[var(--app-text-strong)]",
                              pending && "is-loading",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                            )}
                          >
                            <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px] leading-tight">
                              {(pending || running) && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
                              <span className="min-w-0 flex-1 truncate">{summary.title}</span>
                              {unread && <span className="size-2 shrink-0 rounded-full bg-sky-400" aria-label="New activity" title="New activity" />}
                              {relativeTime && <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime}</span>}
                            </span>
                          </button>
                        );
                      })}
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          onClick={() => showMoreSessions(group.key)}
                          data-testid="project-show-more"
                          className={cn(
                            "w-full rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground",
                            "transition-colors hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text)]",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                          )}
                        >
                          Show {hiddenCount} more
                        </button>
                      )}
                    </div>
                  )}
                </section>
              );
            })
          )}
        </div>
      </ScrollArea>
    </aside>
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
