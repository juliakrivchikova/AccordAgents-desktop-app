import { Fragment, memo, useMemo } from "react";

import { MarkdownText } from "../content/markdown-text";
import { ChatImageAttachmentStrip } from "./chat-image-attachments";
import { ChatInlineTranscript, StreamingMessageContent } from "./chat-streaming";
import type { ChatActivityDisclosureState } from "./use-chat-activity-disclosure";
import { chatMessageImageAttachments } from "./chat-message-metadata";
import { chatInterimPostAttachmentIds, chatInterimPostsOf, splitLiveContentAtInterimPosts } from "../../../shared/interimPosts";
import type { ChatAgentActivityEvent, ChatImageAttachment, ChatInterimPost, ChatMessage } from "../../../shared/types";

/** A reply's posts during its turn and its pictures: all of them, and those
 *  that are its own (a post's pictures are shown with that post). */
export function chatReplyPictures(message: ChatMessage): { posts: ChatInterimPost[]; all: ChatImageAttachment[]; own: ChatImageAttachment[] } {
  const posts = chatInterimPostsOf(message);
  const all = chatMessageImageAttachments(message);
  const posted = posts.length > 0 ? chatInterimPostAttachmentIds(message) : undefined;
  return { posts, all, own: posted?.size ? all.filter((attachment) => !posted.has(attachment.id)) : all };
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
 * A running reply: its streamed text and activity with its posts in the
 * places they were made, then the part still being written. Without posts it
 * is the streaming view as it always was.
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
}): JSX.Element {
  const { content, activityEvents, posts } = props;
  const split = useMemo(
    () => posts.length > 0 ? splitLiveContentAtInterimPosts(content ?? "", activityEvents ?? [], posts) : undefined,
    [content, activityEvents, posts]
  );
  if (!split) {
    return (
      <StreamingMessageContent
        activityDisclosure={props.activityDisclosure}
        content={content}
        activity={props.activity}
        activityEvents={activityEvents}
        statusLabel={props.statusLabel}
      />
    );
  }
  return (
    <div className="chat-interim-stream">
      {split.parts.map((part) => (
        <Fragment key={part.post.id}>
          {(part.content.trim() || part.activityEvents.length > 0) && (
            <ChatInlineTranscript activityDisclosure={props.activityDisclosure} content={part.content} activityEvents={part.activityEvents} />
          )}
          <ChatInterimPostBlock conversationId={props.conversationId} post={part.post} attachments={props.attachments} />
        </Fragment>
      ))}
      <StreamingMessageContent
        activityDisclosure={props.activityDisclosure}
        content={split.tail.content}
        activity={props.activity}
        activityEvents={split.tail.activityEvents}
        statusLabel={props.statusLabel}
      />
    </div>
  );
});
