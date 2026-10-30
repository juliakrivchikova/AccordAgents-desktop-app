import { useId, useMemo } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  FilePenLine,
  Globe,
  ShieldCheck,
  Terminal,
  Wrench,
  type LucideIcon
} from "lucide-react";

import type { ChatAgentActivityEvent, ChatAgentActivityKind } from "../../../shared/types";
import { chatActivityGroupSummary } from "../../../shared/processingTranscript";
import type { ChatActivityDisclosureState } from "./use-chat-activity-disclosure";

/**
 * One line per run of consecutive activities. While the run is still in it, the line shows the
 * current activity and the next one replaces it; once the member moves on, it becomes a count
 * that expands to the full list.
 */
export function ChatInlineActivityGroup(props: {
  activityDisclosure: ChatActivityDisclosureState;
  events: ChatAgentActivityEvent[];
  live: boolean;
}): JSX.Element {
  const { activityDisclosure, events } = props;
  const listId = useId();
  const groupId = activityGroupKey(events);
  const expanded = activityDisclosure.expandedActivityIds.has(groupId);
  if (props.live) {
    const current = events[events.length - 1];
    return (
      <ChatInlineActivityEvent
        activityDisclosure={activityDisclosure}
        event={current}
        live
        key={current.id}
        onToggle={() => {
          // Opening the live line's detail also opens its group, so the detail the User is reading
          // stays on screen when the member moves on and the line becomes a count.
          if (!activityDisclosure.expandedActivityIds.has(current.id) && !expanded) {
            activityDisclosure.toggleActivity(groupId);
          }
          activityDisclosure.toggleActivity(current.id);
        }}
      />
    );
  }
  const summary = chatActivityGroupSummary(events.length);
  return (
    <div className="chat-inline-activity-group">
      <button
        type="button"
        className="chat-inline-activity-heading chat-inline-activity-toggle"
        aria-controls={expanded ? listId : undefined}
        aria-expanded={expanded}
        onClick={() => activityDisclosure.toggleActivity(groupId)}
      >
        {expanded
          ? <ChevronDown className="chat-inline-activity-disclosure-icon" size={14} aria-hidden />
          : <ChevronRight className="chat-inline-activity-disclosure-icon" size={14} aria-hidden />}
        <span>{summary}</span>
      </button>
      {expanded && (
        <div id={listId} className="chat-inline-activity-group-list">
          {events.map((event) => (
            <ChatInlineActivityEvent
              activityDisclosure={activityDisclosure}
              event={event}
              key={event.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function activityGroupKey(events: ChatAgentActivityEvent[]): string {
  return `activity-group:${events[0]?.id ?? "empty"}`;
}

function ChatInlineActivityEvent(props: {
  activityDisclosure: ChatActivityDisclosureState;
  event: ChatAgentActivityEvent;
  live?: boolean;
  onToggle?: () => void;
}): JSX.Element {
  const { activityDisclosure, event } = props;
  const Icon = iconForActivityKind(event.kind);
  const detailId = useId();
  const activityExpanded = activityDisclosure.expandedActivityIds.has(event.id);
  const detailExpanded = activityDisclosure.fullyExpandedDetailIds.has(event.id);
  const detailRevealed = activityDisclosure.revealedDetailIds.has(event.id);
  const rawDetail = event.detail;
  const maskedDetail = useMemo(() => rawDetail ? maskActivityDetailSecrets(rawDetail) : undefined, [rawDetail]);
  const displayDetail = detailRevealed && activityExpanded ? rawDetail : maskedDetail;
  const detailIsMasked = Boolean(rawDetail && maskedDetail && rawDetail !== maskedDetail);
  const detailIsLong = Boolean(rawDetail && (rawDetail.length > 600 || rawDetail.split(/\n/).length > 6));
  const labelClassName = props.live ? "streaming-status-label" : undefined;
  return (
    <div className={`chat-inline-activity-event is-${event.kind}${props.live ? " is-live" : ""}`}>
      {displayDetail ? (
        <button
          type="button"
          className="chat-inline-activity-heading chat-inline-activity-toggle"
          aria-controls={detailId}
          aria-expanded={activityExpanded}
          title={event.label}
          onClick={props.onToggle ?? (() => activityDisclosure.toggleActivity(event.id))}
        >
          {activityExpanded
            ? <ChevronDown className="chat-inline-activity-disclosure-icon" size={14} aria-hidden />
            : <ChevronRight className="chat-inline-activity-disclosure-icon" size={14} aria-hidden />}
          <span className={labelClassName}>{event.label}</span>
        </button>
      ) : (
        <div className="chat-inline-activity-heading" title={event.label}>
          <Icon className="chat-inline-activity-kind-icon" size={14} aria-hidden />
          <span className={labelClassName}>{event.label}</span>
        </div>
      )}
      {displayDetail && (
        <div id={detailId} className="chat-inline-activity-content" hidden={!activityExpanded}>
          <pre className={`chat-inline-activity-detail ${detailIsLong && !detailExpanded ? "is-collapsed" : ""}`}>{displayDetail}</pre>
          {(detailIsMasked || detailIsLong) && (
            <div className="chat-inline-activity-actions">
              {detailIsMasked && (
                <button
                  type="button"
                  className="chat-inline-activity-action"
                  onClick={() => activityDisclosure.toggleDetailReveal(event.id)}
                >
                  <span>{detailRevealed ? "Hide" : "Reveal"}</span>
                </button>
              )}
              {detailIsLong && (
                <button
                  type="button"
                  className="chat-inline-activity-action is-detail-length-toggle"
                  onClick={() => activityDisclosure.toggleDetailLength(event.id)}
                >
                  <span>{detailExpanded ? "Show less" : "Show more"}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function maskActivityDetailSecrets(detail: string): string {
  return detail
    .replace(/\b(Authorization\s*:\s*Bearer\s+)([^\s"',;]+)/gi, "$1••••")
    .replace(/((?:^|[\s,{])["']?[A-Za-z0-9_.-]*(?:token|key|password|secret)[A-Za-z0-9_.-]*["']?\s*(?:=|:)\s*["']?)([^\s"',;}]+)/gim, "$1••••");
}

function iconForActivityKind(kind: ChatAgentActivityKind): LucideIcon {
  if (kind === "command") {
    return Terminal;
  }
  if (kind === "tool") {
    return Wrench;
  }
  if (kind === "file-edit") {
    return FilePenLine;
  }
  if (kind === "web") {
    return Globe;
  }
  if (kind === "approval") {
    return ShieldCheck;
  }
  return Activity;
}
