import { type ReactNode, useState } from "react";
import { Bell, ChevronDown, ChevronRight, Plus, Search, Settings, SquarePen } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { HistoryLoadingState } from "@/renderer/components/loading-states";
import { EmptyState, IconButton } from "@/renderer/components/primitives";
import { cn } from "@/lib/utils";
import { SidebarToggleButton } from "./sidebar-toggle-button";
import { DeleteConfirmationDialog } from "../settings/delete-confirmation-dialog";
import type { ConversationSummary } from "../../../shared/types";
import { SidebarSessionRow } from "./sidebar-session-row";
import { SidebarNavItem, formatBadgeCount } from "./sidebar-nav-item";
import { chatSearchShortcutAria, chatSearchShortcutLabel } from "../../app/chat-search-shortcut";
import { isMacPlatform } from "../../lib/platform";

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
  activityUnreadCount?: number;
  busy?: boolean;
  loading?: boolean;
  unreadIds?: ReadonlySet<string>;
  macShortcuts?: boolean;
  onOpenSearch: () => void;
  onOpenActivity: () => void;
  onOpenSettings: () => void;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onNewProjectSession: (repoPath?: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
  onDelete?: (id: string) => Promise<void>;
  onToggleSidebar?: () => void;
  // Small window-level controls (theme, refresh) shown next to Settings.
  footerActions?: ReactNode;
}

export const Sidebar = ({
  projectGroups,
  archivedSessions = [],
  activeId,
  pendingId,
  activityUnreadCount = 0,
  busy,
  loading,
  unreadIds,
  macShortcuts = isMacPlatform(),
  onOpenSearch,
  onOpenActivity,
  onOpenSettings,
  onSelect,
  onNewSession,
  onNewProjectSession,
  onArchive,
  onUnarchive,
  onDelete,
  onToggleSidebar,
  footerActions
}: SidebarProps): JSX.Element => {
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set());
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<Set<string>>(new Set());
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary>();
  const [deletePending, setDeletePending] = useState(false);

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
      <div data-shell="sidebar-brand" data-titlebar className="app-titlebar-row sidebar-brand-row">
        <div className="flex min-w-0 items-center gap-2">
          <img src={ACCORDAGENTS_MARK_URL} alt="" className="size-5 shrink-0 rounded-[5px]" aria-hidden="true" />
          <span className="min-w-0 truncate">AccordAgents</span>
        </div>
        {onToggleSidebar && <SidebarToggleButton expanded onToggle={onToggleSidebar} />}
      </div>

      <div className="px-[var(--app-gutter-tight)] pt-2">
        <button
          id="chat-search-trigger"
          type="button"
          onClick={onOpenSearch}
          aria-label="Search chats"
          aria-haspopup="dialog"
          aria-keyshortcuts={chatSearchShortcutAria(macShortcuts)}
          data-testid="chat-search-trigger"
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-workspace-bg)] px-2.5",
            "text-left text-[13px] text-muted-foreground transition-colors",
            "hover:border-[var(--app-border-strong)] hover:text-[var(--app-text)]",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
          )}
        >
          <Search className="size-[15px] shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Search chats</span>
          <kbd className="shrink-0 font-sans text-[11px] text-muted-foreground" data-testid="chat-search-shortcut">
            {chatSearchShortcutLabel(macShortcuts)}
          </kbd>
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 px-[var(--app-gutter-tight)] pt-2 pb-2" aria-label="Primary">
        <SidebarNavItem
          icon={SquarePen}
          label="New chat"
          onClick={onNewSession}
          disabled={busy}
          testId="new-chat"
        />
        <SidebarNavItem
          icon={Bell}
          label="Activity"
          ariaLabel={activityUnreadCount > 0 ? `Activity, ${activityUnreadCount} unread` : undefined}
          onClick={onOpenActivity}
          testId="sidebar-activity"
          badge={activityUnreadCount > 0 ? formatBadgeCount(activityUnreadCount) : undefined}
        />
      </nav>

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
                    <IconButton
                      size="xs"
                      icon={Plus}
                      label={`New chat in ${group.label}`}
                      onClick={() => onNewProjectSession(group.repoPath)}
                      disabled={busy}
                      data-testid="project-new-session"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
                    />
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
                            onDelete={setDeleteTarget}
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
                        onDelete={setDeleteTarget}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      </ScrollArea>

      <div className="flex shrink-0 items-center gap-1 border-t border-[var(--app-shell-border)] px-[var(--app-gutter-tight)] py-2">
        <div className="min-w-0 flex-1">
          <SidebarNavItem icon={Settings} label="Settings" onClick={onOpenSettings} testId="sidebar-settings" />
        </div>
        {footerActions}
      </div>

      <DeleteConfirmationDialog
        open={Boolean(deleteTarget)}
        title="Delete chat permanently?"
        description={deleteTarget
          ? `“${deleteTarget.title}” and its saved messages will be permanently deleted. This cannot be undone.`
          : "This chat and its saved messages will be permanently deleted."}
        confirmLabel="Delete permanently"
        pending={deletePending}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        onConfirm={async () => {
          if (!deleteTarget || !onDelete) return;
          setDeletePending(true);
          try {
            await onDelete(deleteTarget.id);
            setDeleteTarget(undefined);
          } finally {
            setDeletePending(false);
          }
        }}
      />

    </aside>
  );
};
