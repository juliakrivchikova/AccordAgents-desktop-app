import { type ReactNode, useState } from "react";
import { ArrowSquareInIcon, BellIcon, CaretRightIcon, FolderSimpleIcon, GearSixIcon, MagnifyingGlassIcon, NotePencilIcon, PlusIcon } from "@phosphor-icons/react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { HistoryLoadingState } from "@/renderer/components/loading-states";
import { EmptyState, IconButton } from "@/renderer/components/primitives";
import { cn } from "@/lib/utils";
import { SidebarToggleButton } from "./sidebar-toggle-button";
import { DeleteConfirmationDialog } from "../settings/delete-confirmation-dialog";
import type { ConversationSummary } from "../../../shared/types";
import { SidebarSessionRow } from "./sidebar-session-row";
import { openCliImport } from "../cli-import/cli-import-store";
import { SidebarNavItem, formatBadgeCount } from "./sidebar-nav-item";
import { chatSearchShortcutAria, chatSearchShortcutLabel } from "../../app/chat-search-shortcut";
import { isMacPlatform } from "../../lib/platform";

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
  /** Pinned chats, in the order they were pinned. */
  pinnedSessions?: ConversationSummary[];
  /** The most recent chats of every project, newest first. */
  recentSessions?: ConversationSummary[];
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
  onSetPinned?: (id: string, pinned: boolean) => void;
  onToggleSidebar?: () => void;
  // Small window-level controls (theme, refresh) shown next to Settings.
  footerActions?: ReactNode;
}

type RowSection = "pinned" | "recent" | "project" | "archived";

export const Sidebar = ({
  pinnedSessions = [],
  recentSessions = [],
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
  onSetPinned,
  onToggleSidebar,
  footerActions
}: SidebarProps): JSX.Element => {
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set());
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [recentsCollapsed, setRecentsCollapsed] = useState(false);
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
    setExpandedProjectKeys((current) => new Set(current).add(key));
  }

  /** One chat's row: the same chat may be listed under Pinned, Recents and
   *  its project at once, and every listing shows it the same way. */
  function renderSessionRow(summary: ConversationSummary, section: RowSection): JSX.Element {
    const pending = summary.id === pendingId;
    // While a chat opens, only it is selected: the one still on screen is
    // being left.
    const selected = pendingId ? pending : summary.id === activeId;
    const running = summary.running === true;
    const working = running || summary.replyPending === true;
    const archived = section === "archived";
    const unread = !archived && !selected && !working && unreadIds?.has(summary.id) === true;
    return (
      <SidebarSessionRow
        key={summary.id}
        summary={summary}
        selected={selected}
        pending={pending}
        running={running}
        working={working}
        unread={unread}
        section={section}
        onSelect={onSelect}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onDelete={setDeleteTarget}
        onSetPinned={archived ? undefined : onSetPinned}
      />
    );
  }

  return (
    <aside id="app-sidebar" data-shell="sidebar" className="flex min-h-0 flex-col bg-ui-sidebar text-ui-text">
      <div data-shell="sidebar-brand" data-titlebar className="app-titlebar-row sidebar-brand-row">
        {/* No name by the lights: the toggle sits where the collapsed
            sidebar keeps it, so it never moves (the User, 2026-11-22). */}
        {onToggleSidebar && <SidebarToggleButton expanded onToggle={onToggleSidebar} />}
      </div>

      <div className="px-2 pt-1">
        <button
          id="chat-search-trigger"
          type="button"
          onClick={onOpenSearch}
          aria-label="Search chats"
          aria-haspopup="dialog"
          aria-keyshortcuts={chatSearchShortcutAria(macShortcuts)}
          data-testid="chat-search-trigger"
          className={cn(
            "flex h-7 w-full items-center gap-2 rounded-ui-8 border border-ui-border-subtle bg-ui-bg px-2 text-left text-ui-13 text-ui-text-3",
            "transition-colors duration-120 ease-ui-out hover:border-ui-border hover:text-ui-text-2",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-focus-ring"
          )}
        >
          <MagnifyingGlassIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Search chats</span>
          <kbd
            className="inline-flex h-[18px] shrink-0 items-center rounded-ui-4 border border-ui-border-subtle bg-ui-bg px-1.5 font-sans text-ui-11 text-ui-text-3"
            data-testid="chat-search-shortcut"
          >
            {chatSearchShortcutLabel(macShortcuts)}
          </kbd>
        </button>
      </div>

      <nav className="flex flex-col gap-px px-2 pt-1.5 pb-1" aria-label="Primary">
        <SidebarNavItem icon={NotePencilIcon} label="New chat" onClick={onNewSession} disabled={busy} testId="new-chat" />
        <SidebarNavItem
          icon={BellIcon}
          label="Activity"
          ariaLabel={activityUnreadCount > 0 ? `Activity, ${activityUnreadCount} unread` : undefined}
          onClick={onOpenActivity}
          testId="sidebar-activity"
          badge={activityUnreadCount > 0 ? formatBadgeCount(activityUnreadCount) : undefined}
        />
      </nav>

      <ScrollArea className="min-h-0 min-w-0 flex-1 px-2 pb-2">
        <div className="flex min-w-0 flex-col gap-1 pt-1">
          {pinnedSessions.length > 0 && (
            <SidebarSection label="Pinned" testId="pinned-group" open={!pinnedCollapsed} onOpenChange={(open) => setPinnedCollapsed(!open)}>
              {pinnedSessions.map((summary) => renderSessionRow(summary, "pinned"))}
            </SidebarSection>
          )}
          {recentSessions.length > 0 && (
            <SidebarSection label="Recents" testId="recents-group" open={!recentsCollapsed} onOpenChange={(open) => setRecentsCollapsed(!open)}>
              {recentSessions.map((summary) => renderSessionRow(summary, "recent"))}
            </SidebarSection>
          )}
          <div className={cn(SECTION_LABEL, "justify-between pr-0.5")} data-testid="projects-heading">
            Projects
            <IconButton
              size="xs"
              icon={ArrowSquareInIcon}
              label="Import threads"
              tooltip="Import threads from Claude Code, Codex and Antigravity"
              onClick={() => openCliImport()}
              data-testid="cli-import-open"
            />
          </div>
          {/* A refresh keeps the rows on screen; the placeholder is for the
              first load, before there is anything to show. */}
          {loading && pinnedSessions.length + recentSessions.length + projectGroups.length === 0 ? (
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
                // The project's row and its chats' rows keep the same 1px gap
                // between them, so two highlighted rows never touch.
                <section key={group.key} className="flex min-w-0 flex-col gap-px" data-testid="project-group" data-project-key={group.key}>
                    <div className="group flex min-w-0 items-center gap-0.5">
                      {/* As Recents: the name, then its caret; its chats start under the name. */}
                      <button type="button" onClick={() => toggleProject(group.key)} aria-expanded={!collapsed} data-testid="project-toggle" className={cn(ROW, "min-w-0 flex-1 gap-1.5 text-ui-text-2")}>
                          <FolderSimpleIcon className="size-3.5 shrink-0 text-ui-text-3" aria-hidden />
                          <span className="min-w-0 truncate">{group.label}</span>
                          <CaretRightIcon className={cn(CARET, "text-ui-text-3", !collapsed && "rotate-90")} aria-hidden />
                        </button>
                      <IconButton
                        size="xs"
                        icon={PlusIcon}
                        label={`New chat in ${group.label}`}
                        onClick={() => onNewProjectSession(group.repoPath)}
                        disabled={busy}
                        data-testid="project-new-session"
                        className="opacity-0 transition-opacity duration-120 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
                      />
                    </div>
                    {!collapsed && (
                      <div className={GROUP_BODY}>
                        {visibleSessions.map((summary) => renderSessionRow(summary, "project"))}
                        {hiddenCount > 0 && (
                          <button
                            type="button"
                            onClick={() => showMoreSessions(group.key)}
                            data-testid="project-show-more"
                            className={cn(ROW, "pl-7 text-ui-12 text-ui-text-3 hover:text-ui-text-2")}
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
                  <button type="button" onClick={() => setArchivedCollapsed((current) => !current)} aria-expanded={!archivedCollapsed} data-testid="archived-toggle" className={SECTION_TOGGLE}>
                    <span className="min-w-0 flex-1 truncate">Archived</span>
                    <CaretRightIcon className={cn(CARET, !archivedCollapsed && "rotate-90")} aria-hidden />
                    <span className="tabular-nums text-ui-11 font-normal">{archivedSessions.length}</span>
                  </button>
                {!archivedCollapsed && <div className={GROUP_BODY}>{archivedSessions.map((summary) => renderSessionRow(summary, "archived"))}</div>}
              </section>
          )}
        </div>
      </ScrollArea>

      <div className="flex h-11 shrink-0 items-center gap-0.5 border-t border-ui-border-subtle px-2">
        <div className="min-w-0 flex-1">
          <SidebarNavItem icon={GearSixIcon} label="Settings" onClick={onOpenSettings} testId="sidebar-settings" />
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

/** A 28px sidebar row (the one row shape of the sidebar). */
const ROW = cn(
  "flex h-7 items-center gap-2 rounded-ui-8 px-2 text-left text-ui-13",
  "transition-colors duration-120 ease-ui-out hover:bg-ui-row-hover",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-focus-ring"
);
const SECTION_LABEL = "flex h-6 min-w-0 items-center gap-1 px-2 pt-1 text-left text-ui-12 font-medium text-ui-text-3";
/** A section heading that folds its group: the whole row is the target. */
const SECTION_TOGGLE = cn(SECTION_LABEL, "w-full rounded-ui-8 hover:text-ui-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-focus-ring");
const CARET = "size-3.5 shrink-0 transition-transform duration-180 ease-ui-out";
/** A group opening: its rows fade and slide in; closing is immediate. */
const GROUP_BODY = "flex min-w-0 flex-col gap-px animate-in fade-in-0 slide-in-from-top-1 duration-180 ease-ui-out";

/** A top-level list of chats (Pinned, Recents): a heading that folds it. */
function SidebarSection({
  label,
  testId,
  open,
  onOpenChange,
  children
}: {
  label: string;
  testId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="min-w-0 pb-1" data-testid={testId}>
      <button type="button" onClick={() => onOpenChange(!open)} aria-expanded={open} data-testid={`${testId}-toggle`} className={SECTION_TOGGLE}>
        <span className="min-w-0 truncate">{label}</span>
        <CaretRightIcon className={cn(CARET, open && "rotate-90")} aria-hidden />
      </button>
      {open && <div className={GROUP_BODY}>{children}</div>}
    </section>
  );
}
