import { MessageSquare, RefreshCw } from "lucide-react";
import type React from "react";
import type { ChatActivityItem, ChatActivityParticipantSummary } from "../../../shared/types";
import { resolveSelectedChatActivityItem } from "../../../shared/chatActivity";
import { Avatar } from "../avatar/avatar";
import { avatarForChatParticipant } from "../chat/chat-avatars";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { Button } from "@/components/ui/button";

export interface ActivityViewProps {
  items: ChatActivityItem[];
  selectedItem?: ChatActivityItem;
  loading: boolean;
  error?: string;
  detail: React.ReactNode;
  onSelect: (item: ChatActivityItem) => void;
  onOpenInChat: (item: ChatActivityItem) => void;
  onRetry: () => void;
}

export function ActivityView({
  items,
  selectedItem: selectedItemProp,
  loading,
  error,
  detail,
  onSelect,
  onOpenInChat,
  onRetry
}: ActivityViewProps): JSX.Element {
  const selectedItem = resolveSelectedChatActivityItem(items, selectedItemProp);
  return (
    <section className="activity-view" aria-label="Activity">
      <aside className="activity-list-pane">
        <div className="activity-list-header">
          <div>
            <h1>Activity</h1>
            <p>{loading ? "Updating" : `${items.length} active item${items.length === 1 ? "" : "s"}`}</p>
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
          ) : (
            items.map((item) => (
              <ActivityRow
                key={item.id}
                item={item}
                active={item.id === selectedItem?.id}
                onSelect={() => onSelect(item)}
              />
            ))
          )}
        </div>
      </aside>
      <div className="activity-detail-pane">
        <div className="activity-detail-header">
          <div>
            <p className="activity-detail-kicker">{selectedItem ? statusLabel(selectedItem.status) : "Activity"}</p>
            <h2>{selectedItem?.conversationTitle ?? "Select an item"}</h2>
          </div>
          {selectedItem && (
            <Button variant="outline" size="sm" onClick={() => onOpenInChat(selectedItem)}>
              <MessageSquare aria-hidden />
              Open in chat
            </Button>
          )}
        </div>
        <div className="activity-detail-body">
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

function ActivityRow({
  item,
  active,
  onSelect
}: {
  item: ChatActivityItem;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="activity-row"
      data-status={item.status}
      data-read={item.read ? "true" : undefined}
      data-active={active ? "true" : undefined}
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
          <span className="activity-row-title">{item.conversationTitle}</span>
          <span className="activity-row-time">{relativeTime(item.updatedAt)}</span>
        </span>
        <span className="activity-row-preview">{item.preview}</span>
      </span>
    </button>
  );
}

function avatarForActivityParticipant(participant: ChatActivityParticipantSummary) {
  return avatarForChatParticipant(participant, chatParticipantDisplayName(participant));
}

function statusLabel(status: ChatActivityItem["status"]): string {
  if (status === "pending") return "Pending";
  if (status === "running") return "Running";
  return "Recent";
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
