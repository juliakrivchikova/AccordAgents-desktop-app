import { Fragment, memo, useMemo, type ReactNode } from "react";
import { Activity, Brain, FileText, Globe, Pencil, Terminal, Wrench, type LucideIcon } from "lucide-react";

import { MarkdownText } from "../content/markdown-text";
import { splitLiveContentAtInterimPosts } from "../../../shared/interimPosts";
import {
  chatActivityEventsForSegment,
  chatInlineTranscriptBlocks,
  chatInlineTranscriptParts,
  type ChatProcessingTranscriptView,
  type ChatTranscriptSegment
} from "../../../shared/processingTranscript";
import { sessionsActivityRow, type SessionsActivityKind } from "../../../shared/sessionsActivity";
import type { ChatAgentActivityEvent, ChatImageAttachment, ChatInterimPost } from "../../../shared/types";
import { ChatInterimPostBlock } from "./chat-interim-posts";
import { useStreamingElapsedSeconds } from "./chat-streaming";
import { formatWorkedDuration } from "./chat-worked-row";

/**
 * A reply's work in the sessions view, as T3 Code shows a turn in progress
 * (the User, 2026-11-21): a quiet "Working for 4s" over a hairline, then one
 * line per step, an outline icon by its kind and what it is about in muted
 * text (the thinking, the search query, the command, the file), the newest
 * shimmering while it runs. What the member writes between its steps, and
 * what it posts during its turn, stay its own words between the rows. No
 * status label, no "Thinking" word, no boxed groups. Once the reply is done
 * the same rows are what its "Worked for …" opens to.
 */

const ROW_ICONS: Record<SessionsActivityKind, LucideIcon> = {
  thinking: Brain,
  web: Globe,
  shell: Terminal,
  read: FileText,
  edit: Pencil,
  tool: Wrench,
  status: Activity
};

export const ChatSessionsActivityRow = memo(function ChatSessionsActivityRow(props: {
  event: ChatAgentActivityEvent;
  current?: boolean;
}): JSX.Element {
  const row = sessionsActivityRow(props.event);
  const Icon = ROW_ICONS[row.kind];
  return (
    <div
      className={`chat-sessions-activity-row is-${row.kind}${props.current ? " is-current" : ""}`}
      data-testid="chat-sessions-activity-row"
      data-activity-kind={row.kind}
      title={row.text}
    >
      <Icon className="chat-sessions-activity-icon" size={14} strokeWidth={1.75} aria-hidden />
      <span className="chat-sessions-activity-text">{row.text}</span>
    </div>
  );
});

/** Each step one row; the last one is the current step while `live`. */
export function ChatSessionsActivityRows(props: { events: readonly ChatAgentActivityEvent[]; live?: boolean }): JSX.Element | null {
  if (props.events.length === 0) {
    return null;
  }
  return (
    <>
      {props.events.map((event, index) => (
        <ChatSessionsActivityRow event={event} current={props.live && index === props.events.length - 1} key={event.id} />
      ))}
    </>
  );
}

/** "Working for 4s", ticking, over a hairline. */
export function ChatSessionsWorkingHeader(props: { since: string }): JSX.Element {
  const seconds = useStreamingElapsedSeconds(props.since);
  return (
    <div className="chat-sessions-working" data-testid="chat-sessions-working" role="status">
      Working for {formatWorkedDuration(seconds * 1000)}
    </div>
  );
}

/**
 * Streamed text and steps in the order they came: the text as the member's
 * words, each step a row (a run of steps is rows, never a group). While
 * `live`, a step at the very end is the current one.
 */
export const ChatSessionsTranscript = memo(function ChatSessionsTranscript(props: {
  content: string;
  activityEvents: readonly ChatAgentActivityEvent[];
  segment?: ChatTranscriptSegment;
  live?: boolean;
}): JSX.Element | null {
  const blocks = useMemo(
    () => chatInlineTranscriptBlocks(chatInlineTranscriptParts(props.content, [...props.activityEvents], props.segment)),
    [props.content, props.activityEvents, props.segment]
  );
  if (blocks.length === 0) {
    return null;
  }
  return (
    <>
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1;
        if (block.kind === "text") {
          return <div className="chat-sessions-activity-words" key={`text-${index}`}><MarkdownText content={block.text} /></div>;
        }
        const events = block.kind === "activity" ? [block.event] : block.events;
        return <ChatSessionsActivityRows events={events} live={props.live && last} key={events[0]?.id ?? `steps-${index}`} />;
      })}
    </>
  );
});

/**
 * A running reply of the sessions view: the header, then its words and steps
 * with its posts where they were made, then the turn's tasks (the member
 * rows). A reply still queued has no header: it has not started.
 */
export const ChatSessionsRunningReply = memo(function ChatSessionsRunningReply(props: {
  since?: string;
  content?: string;
  activityEvents?: ChatAgentActivityEvent[];
  /** Where a run on a machine stands ("Preparing the workspace"), shown as
   *  the current step until the first one of its own. */
  statusLabel?: string;
  posts: ChatInterimPost[];
  attachments: ChatImageAttachment[];
  conversationId: string;
  tasks?: ReactNode;
}): JSX.Element {
  const content = props.content ?? "";
  const events = props.activityEvents ?? NO_EVENTS;
  const status = props.statusLabel?.trim();
  const showStatus = Boolean(status) && events.length === 0 && !content.trim() && !/^(thinking|running)\b/i.test(status ?? "");
  const split = useMemo(
    () => props.posts.length > 0 ? splitLiveContentAtInterimPosts(content, events, props.posts) : undefined,
    [content, events, props.posts]
  );
  return (
    <div className="chat-sessions-running" data-testid="chat-sessions-running" aria-live="polite">
      {props.since && <ChatSessionsWorkingHeader since={props.since} />}
      <div className="chat-sessions-activity">
        {split ? (
          <>
            {split.parts.map((part) => (
              <Fragment key={part.post.id}>
                <ChatSessionsTranscript content={part.content} activityEvents={part.activityEvents} />
                <ChatInterimPostBlock conversationId={props.conversationId} post={part.post} attachments={props.attachments} />
              </Fragment>
            ))}
            <ChatSessionsTranscript content={split.tail.content} activityEvents={split.tail.activityEvents} live />
          </>
        ) : (
          <ChatSessionsTranscript content={content} activityEvents={events} live />
        )}
        {showStatus && <ChatSessionsActivityRow event={{ id: "status", sequence: 0, kind: "status", label: status ?? "", createdAt: "" }} current />}
        {props.tasks}
      </div>
    </div>
  );
});

/**
 * What a finished reply's "Worked for …" opens to: the same rows its turn
 * showed while it ran (and the words it wrote between them, which its final
 * text does not repeat), its tasks after them.
 */
export function ChatSessionsFinishedActivity(props: {
  view?: ChatProcessingTranscriptView;
  activityEvents: ChatAgentActivityEvent[];
}): JSX.Element {
  const { view, activityEvents } = props;
  return (
    <div className="chat-sessions-activity is-finished" data-testid="chat-sessions-finished-activity">
      {view ? (
        <>
          {view.notices.map((notice) => <div className="chat-sessions-activity-notice" key={notice}>{notice}</div>)}
          {view.leadingSegments.map((segment) => (
            <ChatSessionsTranscript content={segment.content} activityEvents={activityEvents} segment={segment} key={segment.key} />
          ))}
          {view.finalSegment && <ChatSessionsActivityRows events={chatActivityEventsForSegment(activityEvents, view.finalSegment)} />}
        </>
      ) : (
        <ChatSessionsActivityRows events={activityEvents} />
      )}
    </div>
  );
}

/** Whether a finished reply has steps or earlier words for its fold. */
export function sessionsReplyHasActivity(activityEvents: readonly ChatAgentActivityEvent[], view: ChatProcessingTranscriptView | undefined): boolean {
  return activityEvents.length > 0 || Boolean(view && view.leadingSegments.some((segment) => segment.content.trim()));
}

const NO_EVENTS: ChatAgentActivityEvent[] = [];

