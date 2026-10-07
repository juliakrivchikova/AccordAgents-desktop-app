import { ArrowRight, CheckCheck, CircleX, Eraser, MessageSquare, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { ChatActivityItem, ChatActivityParticipantSummary } from "../../../shared/types";
import { resolveSelectedChatActivityItem } from "../../../shared/chatActivity";
import { Avatar } from "../avatar/avatar";
import { avatarForChatParticipant } from "../chat/chat-avatars";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { Button } from "@/components/ui/button";
import { IconButton, Notice } from "../primitives";
import {
  persistActivityListWidth,
  readInitialActivityListWidth
} from "../../app/storage";
import {
  DEFAULT_NAVIGATION_PANE_WIDTH
} from "../../lib/sidebar-sizing";
import {
  MAX_STORED_ACTIVITY_LIST_WIDTH,
  MIN_STORED_ACTIVITY_LIST_WIDTH
} from "../../lib/sidebar-width-storage";
import { chatActivityShowsGenericCancel } from "../chat/chat-codex-approval-presentation";
import { MIN_ACTIVITY_DETAIL_WIDTH, MIN_ACTIVITY_LIST_WIDTH, NARROW_ACTIVITY_LIST_MAX_WIDTH } from "../../lib/activity-sizing";

type ActivityStatusTab = "running" | "pending" | "rest";

const ACTIVITY_STATUS_TABS: { id: ActivityStatusTab; label: string }[] = [
  { id: "running", label: "Running" },
  { id: "pending", label: "Pending" },
  { id: "rest", label: "Finished" }
];

export interface ActivityViewProps {
  items: ChatActivityItem[];
  selectedItem?: ChatActivityItem;
  loading: boolean;
  error?: string;
  detailError?: string;
  onDismissDetailError?: () => void;
  detail: React.ReactNode;
  // The detail brings its own top row (a previewed chat), so the pane's is not drawn.
  detailHasHeader?: boolean;
  leading?: React.ReactNode;
  // Window-level controls (theme, refresh): Activity replaces the sidebar
  // that normally carries them.
  trailing?: React.ReactNode;
  onSelect: (item: ChatActivityItem) => void;
  onMarkRead: (item: ChatActivityItem) => void;
  cancellingItemIds?: ReadonlySet<string>; // Cancel pressed, still being applied.
  onCancelPending: (item: ChatActivityItem) => void;
  onClear: (item: ChatActivityItem) => void;
  onOpenInChat: (item: ChatActivityItem) => void;
  onRetry: () => void;
}

// The selected item's chat title, in the pane's own header or in the chat's
// top row once that chat is loaded (App.tsx); both must look the same.
export function ActivityConversationTitle({ title }: { title: string }): JSX.Element {
  return (
    <h2 className="activity-conversation-title">
      <MessageSquare aria-hidden size={17} strokeWidth={1.75} />
      <span>{title}</span>
    </h2>
  );
}

export function ActivityView({
  items,
  selectedItem: selectedItemProp,
  loading,
  error,
  detailError,
  onDismissDetailError,
  detailHasHeader = false,
  detail,
  leading,
  trailing,
  onSelect,
  onMarkRead,
  cancellingItemIds,
  onCancelPending,
  onClear,
  onOpenInChat,
  onRetry
}: ActivityViewProps): JSX.Element {
  const selectedItem = resolveSelectedChatActivityItem(items, selectedItemProp);
  const rootRef = useRef<HTMLElement>(null);
  const cleanupResizeRef = useRef<(() => void) | null>(null);
  const [listWidth, setListWidth] = useState(readInitialActivityListWidth);
  const [resizing, setResizing] = useState(false);
  const [activeTab, setActiveTab] = useState<ActivityStatusTab>("rest");

  const tabCounts: Record<ActivityStatusTab, number> = {
    running: items.filter((item) => item.status === "running").length,
    pending: items.filter((item) => item.status === "pending").length,
    rest: items.filter((item) => item.status === "recent").length
  };
  const filteredItems = items.filter((item) => (
    activeTab === "rest" ? item.status === "recent" : item.status === activeTab
  ));

  useEffect(() => () => cleanupResizeRef.current?.(), []);

  const resizeLimits = (): { min: number; max: number } => {
    const containerWidth = rootRef.current?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
    const narrow = containerWidth <= 900;
    const min = narrow ? MIN_STORED_ACTIVITY_LIST_WIDTH : MIN_ACTIVITY_LIST_WIDTH;
    const designMax = narrow ? NARROW_ACTIVITY_LIST_MAX_WIDTH : MAX_STORED_ACTIVITY_LIST_WIDTH;
    return {
      min,
      max: Math.max(min, Math.min(designMax, containerWidth - MIN_ACTIVITY_DETAIL_WIDTH))
    };
  };

  const updateListWidth = (width: number): void => {
    const { min, max } = resizeLimits();
    const nextWidth = Math.round(Math.min(max, Math.max(min, width)));
    setListWidth(nextWidth);
    persistActivityListWidth(nextWidth);
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    const rootLeft = root.getBoundingClientRect().left;
    const move = (moveEvent: PointerEvent): void => updateListWidth(moveEvent.clientX - rootLeft);
    const stop = (): void => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      cleanupResizeRef.current = null;
    };
    cleanupResizeRef.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      updateListWidth(listWidth - 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      updateListWidth(listWidth + 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      updateListWidth(resizeLimits().min);
    } else if (event.key === "End") {
      event.preventDefault();
      updateListWidth(resizeLimits().max);
    }
  };

  return (
    <section
      ref={rootRef}
      className="activity-view"
      data-resizing={resizing ? "true" : undefined}
      aria-label="Activity"
      style={{ "--activity-list-width": `${listWidth}px` } as React.CSSProperties}
    >
      <aside id="activity-list-pane" className="activity-list-pane">
        <div className="activity-list-header">
          <div className="activity-list-title" data-titlebar>
            {leading}
            <h1>Activity</h1>
            {trailing && <div className="activity-list-title-actions">{trailing}</div>}
          </div>
          <div className="activity-status-tabs" role="tablist" aria-label="Activity status">
            {ACTIVITY_STATUS_TABS.map((tab) => {
              const active = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className="activity-status-tab"
                  role="tab"
                  aria-selected={active}
                  data-active={active ? "true" : undefined}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span>{tab.label}</span>
                  <span className="activity-status-tab-count">{tabCounts[tab.id]}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="activity-list" role="list">
          {error ? (
            <div className="activity-empty activity-error" role="alert">
              <h2>Activity unavailable</h2>
              <p>{error}</p>
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw aria-hidden />
                Retry
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="activity-empty">
              <h2>{loading ? "Loading activity" : "No current activity"}</h2>
              <p>{loading ? "Checking recent chats." : "Running, pending, and recent runs will appear here."}</p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="activity-empty">
              <h2>No {activeTab === "rest" ? "finished" : activeTab} activity</h2>
              <p>{emptyActivityTabDescription(activeTab)}</p>
            </div>
          ) : (
            filteredItems.map((item) => (
              <ActivityRow
                key={item.id}
                item={item}
                active={item.id === selectedItem?.id}
                cancelling={cancellingItemIds?.has(item.id) === true}
                onSelect={() => onSelect(item)}
                onMarkRead={() => onMarkRead(item)}
                onCancelPending={() => onCancelPending(item)}
                onClear={() => onClear(item)}
              />
            ))
          )}
        </div>
      </aside>
      <div
        className="activity-list-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize activity list"
        aria-controls="activity-list-pane"
        aria-orientation="vertical"
        aria-valuemin={resizeLimits().min}
        aria-valuemax={resizeLimits().max}
        aria-valuenow={listWidth}
        title="Resize activity list"
        onPointerDown={startResize}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => updateListWidth(DEFAULT_NAVIGATION_PANE_WIDTH)}
      />
      <div className="activity-detail-pane">
        {!(selectedItem && detailHasHeader) && (
          <div className="activity-detail-header" data-titlebar>
            <ActivityConversationTitle title={selectedItem?.conversationTitle ?? "Select an item"} />
            {selectedItem && <IconButton label="Open in chat" icon={ArrowRight} onClick={() => onOpenInChat(selectedItem)} />}
          </div>
        )}
        <div className="activity-detail-body">
          {detailError && (
            // Under the chat's own top row when the detail brings one.
            <div className={selectedItem && detailHasHeader ? "activity-detail-error-overlay" : "mx-3 mt-2"} role="alert">
              <Notice
                tone="error"
                action={onDismissDetailError && <IconButton label="Dismiss" icon={X} size="xs" onClick={onDismissDetailError} />}
              >
                {detailError}
              </Notice>
            </div>
          )}
          {selectedItem ? detail : (
            <div className="activity-detail-empty">
              <h2>No activity selected</h2>
              <p>Choose a run or pending action from the list.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function emptyActivityTabDescription(tab: ActivityStatusTab): string {
  if (tab === "running") {
    return "Runs in progress will appear here.";
  }
  if (tab === "pending") {
    return "Items waiting for input or approval will appear here.";
  }
  return "Finished member updates will appear here.";
}

function ActivityRow({
  item,
  active,
  cancelling,
  onSelect,
  onMarkRead,
  onCancelPending,
  onClear
}: {
  item: ChatActivityItem;
  active: boolean;
  cancelling: boolean;
  onSelect: () => void;
  onMarkRead: () => void;
  onCancelPending: () => void;
  onClear: () => void;
}): JSX.Element {
  const canCancelPending = chatActivityShowsGenericCancel(item);
  return (
    <div
      className="activity-row"
      role="listitem"
      data-activity-item-id={item.id}
      data-status={item.status}
      data-read={item.read ? "true" : undefined}
      data-active={active ? "true" : undefined}
      data-cancelling={cancelling ? "true" : undefined}
      aria-busy={cancelling ? true : undefined}
    >
      <button
        type="button"
        className="activity-row-open"
        aria-current={active ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="activity-status-dot" aria-hidden="true" />
        {item.participant ? (
          <Avatar className="activity-avatar mini-avatar" spec={avatarForActivityParticipant(item.participant)} />
        ) : (
          <span className="activity-avatar-fallback" aria-hidden="true">
            {initials(item.conversationTitle)}
          </span>
        )}
        <span className="activity-row-main">
          <span className="activity-row-topline">
            <span
              className="activity-row-title"
              title={`${activityActorHandle(item)} post in ${item.conversationTitle}`}
            >
              <span className="activity-row-author">{activityActorHandle(item)}</span>
              <span className="activity-row-context">post in</span>
              <span className="activity-row-chat">{item.conversationTitle}</span>
            </span>
            {collapsedUpdateCount(item) > 1 ? (
              <span className="activity-row-count">{collapsedUpdateCount(item)} updates</span>
            ) : null}
            <span className="activity-row-time">{relativeTime(item.updatedAt)}</span>
          </span>
          <span className="activity-row-preview">{item.preview}</span>
        </span>
      </button>
      <span className="activity-row-actions">
        {item.status === "recent" && !item.read ? (
          <IconButton label="Mark read" icon={CheckCheck} onClick={onMarkRead} />
        ) : null}
        {canCancelPending ? (
          <IconButton label={cancelling ? "Cancelling pending card" : "Cancel pending card"} icon={CircleX} tone="danger" disabled={cancelling} onClick={onCancelPending} />
        ) : null}
        {item.status !== "pending" ? (
          <IconButton label="Clear from activity" icon={Eraser} onClick={onClear} />
        ) : null}
      </span>
    </div>
  );
}

function collapsedUpdateCount(item: ChatActivityItem): number {
  const count = item.groupedCount;
  return typeof count === "number" && Number.isFinite(count) && count > 1 ? Math.floor(count) : 1;
}

function activityActorHandle(item: ChatActivityItem): string {
  const handle = item.participant?.handle.trim().replace(/^@+/, "");
  return handle ? `@${handle}` : "Activity";
}

function avatarForActivityParticipant(participant: ChatActivityParticipantSummary) {
  return avatarForChatParticipant(participant, chatParticipantDisplayName(participant));
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) return "now";
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h`;
  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return `${deltaDays}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
}

function initials(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "A";
}
