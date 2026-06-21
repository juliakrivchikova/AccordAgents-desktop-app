import { useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Loader2, Pencil, Plus, Settings } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { HistoryLoadingState } from "@/renderer/components/loading-states";
import { EmptyState } from "@/renderer/components/primitives";
import { cn } from "@/lib/utils";
import { SidebarPanelIcon } from "./sidebar-panel-icon";
import type { ConversationSummary } from "../../../shared/types";

const INITIAL_PROJECT_SESSION_LIMIT = 5;
const ACCORDAGENTS_MARK_URL = new URL("../../assets/accordagents-mark.png", import.meta.url).href;

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
  archivedSessions?: ConversationSummary[];
  activeId?: string;
  pendingId?: string;
  busy?: boolean;
  loading?: boolean;
  unreadIds?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onNewProjectSession: (repoPath?: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
  onOpenSettings?: () => void;
  onToggleSidebar?: () => void;
  appVersion?: string;
}

export const Sidebar = ({
  projectGroups,
  archivedSessions = [],
  activeId,
  pendingId,
  busy,
  loading,
  unreadIds,
  onSelect,
  onNewSession,
  onNewProjectSession,
  onArchive,
  onUnarchive,
  onOpenSettings,
  onToggleSidebar,
  appVersion
}: SidebarProps): JSX.Element => {
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set());
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<Set<string>>(new Set());
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);

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
      className="flex min-h-0 flex-col text-foreground"
    >
      <div
        data-shell="sidebar-brand"
        className="flex h-[var(--app-header-height)] shrink-0 items-center justify-between gap-2 px-[var(--app-gutter)] text-sm font-semibold text-[var(--app-text-strong)]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <img src={ACCORDAGENTS_MARK_URL} alt="" className="size-[22px] shrink-0 rounded-[6px]" aria-hidden="true" />
          <span className="min-w-0 truncate">AccordAgents</span>
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
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
            )}
          >
            <SidebarPanelIcon />
          </button>
        )}
      </div>

      <div className="px-[var(--app-gutter-tight)] pt-3 pb-2">
        <button
          type="button"
          onClick={onNewSession}
          disabled={busy}
          data-testid="new-chat"
          className={cn(
            "inline-flex h-8 w-full items-center justify-start gap-2 rounded-md",
            "bg-transparent px-2.5 text-[13px] font-medium text-[var(--app-text-strong)]",
            "transition-colors hover:bg-[var(--app-surface-hover)]",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
          )}
        >
          <Pencil className="size-[15px] text-[var(--app-accent)]" aria-hidden />
          <span>New chat</span>
        </button>
      </div>

      <div className="px-[var(--app-gutter-tight)] pb-1 pt-2 text-[11.5px] font-semibold tracking-[0.01em] text-muted-foreground">
        Projects
      </div>

      <ScrollArea className="min-h-0 min-w-0 flex-1 px-[var(--app-gutter-tight)] pb-2">
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
                        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
                      )}
                    >
                      {collapsed ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                      <span className="min-w-0 truncate text-[11.5px] font-semibold tracking-[0.01em] text-muted-foreground">{group.label}</span>
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
                        "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
                      )}
                    >
                      <Plus className="size-3.5" aria-hidden />
                    </button>
                  </div>

                  {!collapsed && (
                    <div className="ml-3 flex min-w-0 flex-col gap-0.5">
                      {visibleSessions.map((summary) => {
                        const pending = summary.id === pendingId;
                        const selected = summary.id === activeId || pending;
                        const running = summary.running === true;
                        const unread = !selected && !running && unreadIds?.has(summary.id) === true;
                        return (
                          <SidebarSessionRow
                            key={summary.id}
                            summary={summary}
                            selected={selected}
                            pending={pending}
                            running={running}
                            unread={unread}
                            onSelect={onSelect}
                            onArchive={onArchive}
                            onUnarchive={onUnarchive}
                          />
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
                            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
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

          {archivedSessions.length > 0 && (
            <section className="mt-1 min-w-0" data-testid="archived-group">
              <button
                type="button"
                onClick={() => setArchivedCollapsed((current) => !current)}
                aria-expanded={!archivedCollapsed}
                data-testid="archived-toggle"
                className={cn(
                  "flex min-w-0 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm",
                  "text-[var(--app-text)] transition-colors hover:bg-[var(--app-surface-hover)]",
                  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
                )}
              >
                {archivedCollapsed ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                <span className="min-w-0 truncate text-[11.5px] font-semibold tracking-[0.01em] text-muted-foreground">
                  Archived ({archivedSessions.length})
                </span>
              </button>

              {!archivedCollapsed && (
                <div className="ml-3 flex min-w-0 flex-col gap-0.5">
                  {archivedSessions.map((summary) => {
                    const pending = summary.id === pendingId;
                    const selected = summary.id === activeId || pending;
                    return (
                      <SidebarSessionRow
                        key={summary.id}
                        summary={summary}
                        selected={selected}
                        pending={pending}
                        running={summary.running === true}
                        unread={false}
                        onSelect={onSelect}
                        onArchive={onArchive}
                        onUnarchive={onUnarchive}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      </ScrollArea>

      {onOpenSettings && (
        <div className="shrink-0 px-[var(--app-gutter-tight)] py-2">
          <button
            type="button"
            onClick={onOpenSettings}
            data-testid="sidebar-settings"
            className={cn(
              "inline-flex h-8 w-full items-center justify-start gap-2 rounded-md",
              "bg-transparent px-2.5 text-[13px] font-medium text-[var(--app-text)]",
              "transition-colors hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)]",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
            )}
          >
            <Settings className="size-[15px] text-muted-foreground" aria-hidden />
            <span>Settings</span>
            {appVersion && <span className="ml-auto shrink-0 text-[11px] font-medium text-muted-foreground">v{appVersion}</span>}
          </button>
        </div>
      )}
    </aside>
  );
};

interface SidebarSessionRowProps {
  summary: ConversationSummary;
  selected: boolean;
  pending: boolean;
  running: boolean;
  unread: boolean;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
}

const SidebarSessionRow = ({
  summary,
  selected,
  pending,
  running,
  unread,
  onSelect,
  onArchive,
  onUnarchive
}: SidebarSessionRowProps): JSX.Element => {
  const relativeTime = formatCompactRelativeTime(summary.updatedAt);
  const archived = summary.archived === true;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(summary.id)}
          data-selected={selected ? "true" : undefined}
          data-running={running ? "true" : undefined}
          data-unread={unread ? "true" : undefined}
          data-archived={archived ? "true" : undefined}
          data-testid="project-session"
          aria-busy={pending || running ? "true" : undefined}
          className={cn(
            "sidebar-history-item group flex w-full min-w-0 max-w-full flex-col gap-0.5 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm",
            "border border-transparent transition-colors hover:bg-[var(--app-surface-hover)]",
            selected && "is-selected text-[var(--app-text-strong)]",
            pending && "is-loading",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
          )}
        >
          <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px] leading-tight">
            {(pending || running) && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{summary.title}</span>
            {unread && <span className="size-2 shrink-0 rounded-full bg-[var(--app-accent)]" aria-label="New activity" title="New activity" />}
            {relativeTime && <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime}</span>}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {archived ? (
          <ContextMenuItem onSelect={() => onUnarchive?.(summary.id)}>
            <ArchiveRestore aria-hidden />
            Unarchive
          </ContextMenuItem>
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
