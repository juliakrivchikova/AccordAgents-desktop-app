import { ArrowRight, CheckCheck, Eraser, MessageSquare, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { ChatActivityItem, ChatActivityParticipantSummary } from "../../../shared/types";
import { resolveSelectedChatActivityItem } from "../../../shared/chatActivity";
import { Avatar } from "../avatar/avatar";
import { avatarForChatParticipant } from "../chat/chat-avatars";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { Button } from "@/components/ui/button";
import { Notice } from "../primitives";
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

const MIN_ACTIVITY_LIST_WIDTH = 320;
const NARROW_ACTIVITY_LIST_MAX_WIDTH = 340;
const MIN_ACTIVITY_DETAIL_WIDTH = 360;
type ActivityStatusTab = "running" | "pending" | "rest";

const ACTIVITY_STATUS_TABS: { id: ActivityStatusTab; label: string }[] = [
  { id: "running", label: "Running" },
  { id: "pending", label: "Pending" },
  { id: "rest", label: "Rest" }
];

export interface ActivityViewProps {
  items: ChatActivityItem[];
  selectedItem?: ChatActivityItem;
  loading: boolean;
  error?: string;
  detailError?: string;
  detail: React.ReactNode;
  onSelect: (item: ChatActivityItem) => void;
  onMarkRead: (item: ChatActivityItem) => void;
  onClear: (item: ChatActivityItem) => void;
  onOpenInChat: (item: ChatActivityItem) => void;
  onRetry: () => void;
}

export function ActivityView({
  items,
  selectedItem: selectedItemProp,
  loading,
  error,
  detailError,
  detail,
  onSelect,
  onMarkRead,
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
          <h1>Activity</h1>
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
                onSelect={() => onSelect(item)}
                onMarkRead={() => onMarkRead(item)}
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
        <div className="activity-detail-header">
          <MessageSquare className="activity-detail-header-icon" aria-hidden="true" size={17} strokeWidth={1.75} />
          <h2>{selectedItem?.conversationTitle ?? "Select an item"}</h2>
          {selectedItem && (
            <Button
              className="activity-open-chat"
              variant="ghost"
              size="icon-sm"
              title="Open in chat"
              aria-label="Open in chat"
              onClick={() => onOpenInChat(selectedItem)}
            >
              <ArrowRight aria-hidden />
            </Button>
          )}
        </div>
        <div className="activity-detail-body">
          {detailError && (
            <div className="mx-3 mt-2" role="alert">
              <Notice tone="error">{detailError}</Notice>
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
  onSelect,
  onMarkRead,
  onClear
}: {
  item: ChatActivityItem;
  active: boolean;
  onSelect: () => void;
  onMarkRead: () => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <div
      className="activity-row"
      role="listitem"
      data-activity-item-id={item.id}
      data-status={item.status}
      data-read={item.read ? "true" : undefined}
      data-active={active ? "true" : undefined}
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
            <span className="activity-row-time">{relativeTime(item.updatedAt)}</span>
          </span>
          <span className="activity-row-preview">{item.preview}</span>
        </span>
      </button>
      <span className="activity-row-actions">
        {item.status === "recent" && !item.read ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="activity-row-action"
            title="Mark read"
            aria-label="Mark read"
            onClick={onMarkRead}
          >
            <CheckCheck aria-hidden />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="activity-row-action"
          title="Clear from activity"
          aria-label="Clear from activity"
          onClick={onClear}
        >
          <Eraser aria-hidden />
        </Button>
      </span>
    </div>
  );
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
