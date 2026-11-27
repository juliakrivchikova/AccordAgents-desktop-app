import { Fragment, memo, useMemo, useState, type ReactNode } from "react";

import { MarkdownText } from "../content/markdown-text";
import { splitLiveContentAtInterimPosts } from "../../../shared/interimPosts";
import {
  chatActivityEventsForSegment,
  chatInlineTranscriptBlocks,
  chatInlineTranscriptParts,
  type ChatProcessingTranscriptView,
  type ChatTranscriptSegment
} from "../../../shared/processingTranscript";
import type { ChatAgentActivityEvent, ChatImageAttachment, ChatInterimPost } from "../../../shared/types";
import {
  ChatSessionsActivityRows, ChatSessionsCappedRows, ChatSessionsEarlierSteps, newestActivityBlocks, SESSIONS_ACTIVITY_ROWS_MAX
} from "./chat-activity-rows";
import { ChatInterimPostBlock } from "./chat-interim-posts";
import { ChatLiveSteps, chatActivityNotices } from "./chat-live-steps";
import { useStreamingElapsedSeconds } from "./chat-streaming";
import { formatWorkedDuration } from "./chat-worked-row";

/**
 * A reply's work in the sessions view, as T3 Code shows a turn in progress
 * (the User, 2026-11-21): a quiet "Working for 4s" over a hairline, then its
 * steps folded into one live line naming the step in progress, shimmering,
 * which opens to them all (ChatLiveSteps; the User, 2026-11-27). Each step
 * is a row there: an outline icon by its kind and what it is about in muted
 * text (the thinking, the search query, the command, the file). What the
 * member writes between its steps, what it posts during its turn and its
 * notices about the run stay in the reply. No status label, no "Thinking"
 * word, no boxed groups. Once the reply is done the same rows, with the
 * words between them, are what its "Worked for …" opens to.
 *
 * A Claude Code member's reads, searches and commands are folded as its CLI
 * folds them (`foldSteps`, claudeStepFold.ts; the User, 2026-11-25): one line
 * with the step it is at, then how many of each; it opens to their rows.
 */

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
  /** Draw only the newest lines of steps this many
   *  (SESSIONS_ACTIVITY_ROWS_MAX); the finished fold lets the earlier ones be
   *  opened. */
  maxSteps?: number;
  expandable?: boolean;
  foldSteps?: boolean;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const allBlocks = useMemo(
    () => chatInlineTranscriptBlocks(chatInlineTranscriptParts(props.content, props.activityEvents as ChatAgentActivityEvent[], props.segment)),
    [props.content, props.activityEvents, props.segment]
  );
  const { blocks, hidden } = useMemo(
    () => props.maxSteps && !expanded ? newestActivityBlocks(allBlocks, props.maxSteps, props.foldSteps) : { blocks: allBlocks, hidden: 0 },
    [allBlocks, expanded, props.foldSteps, props.maxSteps]
  );
  if (blocks.length === 0) {
    return null;
  }
  return (
    <>
      {hidden > 0 && <ChatSessionsEarlierSteps count={hidden} onOpen={props.expandable ? () => setExpanded(true) : undefined} />}
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1;
        if (block.kind === "text") {
          // Keyed by the step before it, so dropping the oldest steps does
          // not redraw every paragraph after them.
          const before = blocks[index - 1];
          const anchor = before && before.kind !== "text" ? (before.kind === "activity" ? before.event.id : before.events[before.events.length - 1]?.id) : undefined;
          return <div className="chat-sessions-activity-words" key={`text-${anchor ?? `start-${index}`}`}><MarkdownText content={block.text} /></div>;
        }
        const events = block.kind === "activity" ? [block.event] : block.events;
        return <ChatSessionsActivityRows events={events} live={props.live && last} foldSteps={props.foldSteps} key={events[0]?.id ?? `steps-${index}`} />;
      })}
    </>
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
  foldSteps?: boolean;
}): JSX.Element {
  const { view, activityEvents, foldSteps } = props;
  return (
    <div className="chat-sessions-activity is-finished" data-testid="chat-sessions-finished-activity">
      {view ? (
        <>
          {view.notices.map((notice) => <div className="chat-sessions-activity-notice" key={notice}>{notice}</div>)}
          {view.leadingSegments.map((segment) => (
            <ChatSessionsTranscript content={segment.content} activityEvents={activityEvents} segment={segment} key={segment.key}
              maxSteps={SESSIONS_ACTIVITY_ROWS_MAX} expandable foldSteps={foldSteps} />
          ))}
          {view.finalSegment && <ChatSessionsCappedRows events={chatActivityEventsForSegment(activityEvents, view.finalSegment)} foldSteps={foldSteps} />}
        </>
      ) : (
        <ChatSessionsCappedRows events={activityEvents} foldSteps={foldSteps} />
      )}
    </div>
  );
}

/** Whether a finished reply has steps or earlier words for its fold. */
export function sessionsReplyHasActivity(activityEvents: readonly ChatAgentActivityEvent[], view: ChatProcessingTranscriptView | undefined): boolean {
  return activityEvents.length > 0 || Boolean(view && view.leadingSegments.some((segment) => segment.content.trim()));
}

/**
 * A running reply of the sessions view: the header, its one live step line,
 * then its words (with its notices about the run) and its posts where they
 * were made, then the turn's tasks (the member rows). A reply still queued
 * has no header: it has not started.
 */
export const ChatSessionsRunningReply = memo(function ChatSessionsRunningReply(props: {
  since?: string;
  content?: string;
  activityEvents?: ChatAgentActivityEvent[];
  /** Where a run on a machine stands ("Preparing the workspace"), shown as
   *  the live line until the first step of its own. */
  statusLabel?: string;
  posts: ChatInterimPost[];
  attachments: ChatImageAttachment[];
  conversationId: string;
  tasks?: ReactNode;
  foldSteps?: boolean;
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
        <ChatLiveSteps events={events} fallback={showStatus ? status : undefined} foldSteps={props.foldSteps} />
        {split ? (
          <>
            {split.parts.map((part) => (
              <Fragment key={part.post.id}>
                <ChatSessionsTranscript content={part.content} activityEvents={chatActivityNotices(part.activityEvents)} />
                <ChatInterimPostBlock conversationId={props.conversationId} post={part.post} attachments={props.attachments} />
              </Fragment>
            ))}
            <ChatSessionsTranscript content={split.tail.content} activityEvents={chatActivityNotices(split.tail.activityEvents)} />
          </>
        ) : (
          <ChatSessionsTranscript content={content} activityEvents={chatActivityNotices(events)} />
        )}
        {props.tasks}
      </div>
    </div>
  );
});

const NO_EVENTS: ChatAgentActivityEvent[] = [];
