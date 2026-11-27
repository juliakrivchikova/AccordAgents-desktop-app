import { Fragment, memo, useMemo } from "react";

import { MarkdownText } from "../content/markdown-text";
import { ChatImageAttachmentStrip } from "./chat-image-attachments";
import { ChatInlineTranscript, StreamingMessageContent } from "./chat-streaming";
import { ChatLiveSteps, chatActivityNotices, chatLiveStepOf } from "./chat-live-steps";
import type { ChatActivityDisclosureState } from "./use-chat-activity-disclosure";
import { chatMessageImageAttachments } from "./chat-message-metadata";
import { chatInterimPostAttachmentIds, chatInterimPostsOf, splitLiveContentAtInterimPosts } from "../../../shared/interimPosts";
import type { ChatAgentActivityEvent, ChatImageAttachment, ChatInterimPost, ChatMessage } from "../../../shared/types";

type ReplyPictures = { posts: ChatInterimPost[]; all: ChatImageAttachment[]; own: ChatImageAttachment[] };

const NO_PICTURES: ChatImageAttachment[] = [];
/** By the stored pictures list, while the posts are the same list too: the
 *  same arrays on every render of an unchanged reply (a streaming reply
 *  renders on every token, and its picture strips are memoized). */
const replyPicturesCache = new WeakMap<object, { posts: ChatInterimPost[]; pictures: ReplyPictures }>();

/** A reply's posts during its turn and its pictures: all of them, and those
 *  that are its own (a post's pictures are shown with that post). */
export function chatReplyPictures(message: ChatMessage): ReplyPictures {
  const posts = chatInterimPostsOf(message);
  const stored = message.metadata?.imageAttachments;
  if (!Array.isArray(stored) || stored.length === 0) {
    return { posts, all: NO_PICTURES, own: NO_PICTURES };
  }
  const cached = replyPicturesCache.get(stored);
  if (cached && cached.posts === posts) return cached.pictures;
  const all = chatMessageImageAttachments(message);
  const posted = posts.length > 0 ? chatInterimPostAttachmentIds(message) : undefined;
  const pictures = { posts, all, own: posted?.size ? all.filter((attachment) => !posted.has(attachment.id)) : all };
  replyPicturesCache.set(stored, { posts, pictures });
  return pictures;
}

/**
 * What a member posted during its turn, shown inside its reply
 * (shared/interimPosts.ts): the same text as the reply's own, one block after
 * another, the way a CLI shows what it writes between its tool calls. Never
 * folded with the turn's work: it is what the member said.
 */
export const ChatInterimPostBlock = memo(function ChatInterimPostBlock(props: {
  conversationId: string;
  post: ChatInterimPost;
  attachments: ChatImageAttachment[];
}): JSX.Element {
  const ids = props.post.attachmentIds ?? [];
  const pictures = ids.length > 0 ? props.attachments.filter((attachment) => ids.includes(attachment.id)) : [];
  return (
    <div className="chat-interim-post" data-post-id={props.post.id}>
      {props.post.content.trim() && <MarkdownText content={props.post.content} />}
      {pictures.length > 0 && <ChatImageAttachmentStrip conversationId={props.conversationId} attachments={pictures} />}
    </div>
  );
});

/** A finished reply's posts, oldest first, above its final answer. */
export function ChatInterimPostList(props: {
  conversationId: string;
  posts: ChatInterimPost[];
  attachments: ChatImageAttachment[];
}): JSX.Element | null {
  if (props.posts.length === 0) {
    return null;
  }
  return (
    <div className="chat-interim-posts">
      {props.posts.map((post) => (
        <ChatInterimPostBlock conversationId={props.conversationId} post={post} attachments={props.attachments} key={post.id} />
      ))}
    </div>
  );
}

/**
 * A running reply of the classic view: its steps folded into one live line
 * naming the step in progress, which opens to them all (ChatLiveSteps; the
 * User, 2026-11-27), then its streamed text, with its notices about the run
 * and its posts in the places they were made, then the part still being
 * written. Without posts it is the streaming view as it always was.
 */
export const StreamingContentWithInterimPosts = memo(function StreamingContentWithInterimPosts(props: {
  activityDisclosure: ChatActivityDisclosureState;
  content?: string;
  activity?: string;
  activityEvents?: ChatAgentActivityEvent[];
  statusLabel?: string;
  conversationId: string;
  posts: ChatInterimPost[];
  attachments: ChatImageAttachment[];
  /** A Claude Code member: its opened steps fold as its CLI folds them. */
  foldSteps?: boolean;
}): JSX.Element {
  const { content, posts } = props;
  const events = props.activityEvents ?? NO_EVENTS;
  const split = useMemo(
    () => posts.length > 0 ? splitLiveContentAtInterimPosts(content ?? "", events, posts) : undefined,
    [content, events, posts]
  );
  // Without a step yet, the step the progress names (a CLI that reports no
  // events) is the live line, unless it only says where the run stands.
  const activity = events.length === 0 && props.activity && props.activity !== (props.statusLabel || "Thinking") ? props.activity : undefined;
  const stepShown = Boolean(chatLiveStepOf(events, activity));
  return (
    <>
      <ChatLiveSteps events={events} fallback={activity} foldSteps={props.foldSteps} />
      {split ? (
        <div className="chat-interim-stream">
          {split.parts.map((part) => (
            <Fragment key={part.post.id}>
              {(part.content.trim() || chatActivityNotices(part.activityEvents).length > 0) && (
                <ChatInlineTranscript activityDisclosure={props.activityDisclosure} content={part.content} activityEvents={chatActivityNotices(part.activityEvents)} />
              )}
              <ChatInterimPostBlock conversationId={props.conversationId} post={part.post} attachments={props.attachments} />
            </Fragment>
          ))}
          <StreamingMessageContent
            activityDisclosure={props.activityDisclosure}
            content={split.tail.content}
            activityEvents={chatActivityNotices(split.tail.activityEvents)}
            statusLabel={props.statusLabel}
            stepShown={stepShown}
          />
        </div>
      ) : (
        <StreamingMessageContent
          activityDisclosure={props.activityDisclosure}
          content={content}
          activityEvents={chatActivityNotices(events)}
          statusLabel={props.statusLabel}
          stepShown={stepShown}
        />
      )}
    </>
  );
});

const NO_EVENTS: ChatAgentActivityEvent[] = [];
