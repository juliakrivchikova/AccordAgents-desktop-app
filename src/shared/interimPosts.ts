import type { ChatAgentActivityEvent, ChatImageAttachment, ChatInterimPost, ChatMessage, ChatMessageMetadata } from "./types";

/**
 * What a member posts with app_chat_send_message during its own turn is part
 * of that turn's reply, the way the text a CLI writes between its tool calls
 * is part of its answer (the User, 2026-11-20): it is kept on the running
 * reply (metadata.interimPosts) and shown inside it, in order, above the
 * final answer. The reply stays the last thing its turn wrote, so nothing it
 * posted can bury it.
 *
 * Every copy of the reply carries the posts whole: they travel with the
 * reply's own updates to the User's server, the phone and other devices, so
 * they are capped. A post that would go over a cap is posted as a message of
 * its own instead, as every post was before.
 */

/** At most this many posts in one reply (also the most one turn may send). */
export const CHAT_INTERIM_POSTS_MAX = 12;
/** At most this many characters of posts in one reply, all together. */
export const CHAT_INTERIM_POSTS_MAX_CHARS = 64_000;

/** A reply's posts, oldest first; anything malformed is left out. */
export function chatInterimPostsOf(message: Pick<ChatMessage, "metadata"> | undefined): ChatInterimPost[] {
  return normalizedPosts(message?.metadata?.interimPosts);
}

const NO_POSTS: ChatInterimPost[] = [];

function normalizedPosts(value: unknown): ChatInterimPost[] {
  if (!Array.isArray(value) || value.length === 0) {
    return NO_POSTS;
  }
  // The stored list itself when it is whole, so a view that compares it
  // between renders sees no change while there is none.
  if (value.every(isPost)) {
    return value as ChatInterimPost[];
  }
  return value.filter(isPost);
}

function isPost(item: unknown): item is ChatInterimPost {
  if (!item || typeof item !== "object") return false;
  const post = item as Partial<ChatInterimPost>;
  return typeof post.id === "string" && Boolean(post.id) && typeof post.content === "string" && typeof post.createdAt === "string";
}

/** The characters a reply's posts hold, all together. */
export function chatInterimPostsCharCount(posts: readonly ChatInterimPost[]): number {
  return posts.reduce((total, post) => total + post.content.length, 0);
}

/** Two copies' posts of one reply, together: each post once, oldest first.
 *  Posts are only ever added, so a copy that lacks one is behind, never a
 *  removal. */
export function mergeChatInterimPosts(left: unknown, right: unknown): ChatInterimPost[] {
  const merged: ChatInterimPost[] = [];
  const seen = new Set<string>();
  for (const post of [...normalizedPosts(left), ...normalizedPosts(right)]) {
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    merged.push(copyPost(post));
  }
  // Stable: posts made in the same millisecond keep the order they came in.
  return merged
    .map((post, index) => ({ post, index }))
    .sort((a, b) => a.post.createdAt.localeCompare(b.post.createdAt) || a.index - b.index)
    .map((entry) => entry.post);
}

function copyPost(post: ChatInterimPost): ChatInterimPost {
  return { ...post, ...(post.attachmentIds ? { attachmentIds: [...post.attachmentIds] } : {}) };
}

/**
 * `target` with the posts another copy of the same reply has and it lacks,
 * and the pictures those posts carry. The same object when there is nothing
 * to add, so a merge that changes nothing changes nothing.
 */
export function withInterimPostsFrom(
  target: ChatMessageMetadata | undefined,
  other: ChatMessageMetadata | undefined
): ChatMessageMetadata | undefined {
  const otherPosts = normalizedPosts(other?.interimPosts);
  if (otherPosts.length === 0) {
    return target;
  }
  const ownPosts = normalizedPosts(target?.interimPosts);
  const own = new Set(ownPosts.map((post) => post.id));
  if (otherPosts.every((post) => own.has(post.id))) {
    return target;
  }
  const interimPosts = mergeChatInterimPosts(ownPosts, otherPosts);
  const pictures = Array.isArray(target?.imageAttachments) ? target.imageAttachments : [];
  const held = new Set(pictures.map((attachment) => attachment.id));
  const wanted = new Set(interimPosts.flatMap((post) => post.attachmentIds ?? []));
  const carried = (Array.isArray(other?.imageAttachments) ? other.imageAttachments : [])
    .filter((attachment) => attachment && wanted.has(attachment.id) && !held.has(attachment.id))
    .map((attachment) => JSON.parse(JSON.stringify(attachment)) as ChatImageAttachment);
  return {
    ...(target ?? {}),
    interimPosts,
    ...(carried.length > 0 ? { imageAttachments: [...pictures, ...carried] } : {})
  };
}

/** The pictures of a reply that belong to its posts (shown with them). */
export function chatInterimPostAttachmentIds(message: Pick<ChatMessage, "metadata"> | undefined): Set<string> {
  return new Set(chatInterimPostsOf(message).flatMap((post) => post.attachmentIds ?? []));
}

/** A message's words as members read them: its posts, then its final text. */
export function chatMessageMemberText(message: Pick<ChatMessage, "content" | "metadata">): string {
  const posts = chatInterimPostsOf(message).map((post) => post.content.trim()).filter(Boolean);
  if (posts.length === 0) {
    return message.content;
  }
  return [...posts, message.content.trim()].filter(Boolean).join("\n\n");
}

export interface ChatLiveInterimPart {
  /** The streamed text and activity written before the post. */
  content: string;
  activityEvents: ChatAgentActivityEvent[];
  post: ChatInterimPost;
}

/**
 * A running reply's streamed text and activity, cut where its posts were
 * made: each part is what came before one post, the tail what came after the
 * last. Offsets past the text (a retried attempt, a shorter copy of the
 * stream) put the post after all of it. Activity offsets are made relative to
 * their part, as the streaming view reads them.
 */
export function splitLiveContentAtInterimPosts(
  content: string,
  activityEvents: readonly ChatAgentActivityEvent[],
  posts: readonly ChatInterimPost[]
): { parts: ChatLiveInterimPart[]; tail: { content: string; activityEvents: ChatAgentActivityEvent[] } } {
  const parts: ChatLiveInterimPart[] = [];
  let remaining = [...activityEvents];
  let start = 0;
  for (const post of posts) {
    const end = Math.max(start, Math.min(content.length, Math.max(0, post.afterContentLength ?? 0)));
    const before: ChatAgentActivityEvent[] = [];
    const after: ChatAgentActivityEvent[] = [];
    // One pass per post (a long stream has thousands of events).
    for (const event of remaining) (activityBeforePost(event, end, post) ? before : after).push(event);
    remaining = after;
    parts.push({ content: content.slice(start, end), activityEvents: before.map((event) => shifted(event, start)), post });
    start = end;
  }
  return { parts, tail: { content: content.slice(start), activityEvents: remaining.map((event) => shifted(event, start)) } };
}

function activityBeforePost(event: ChatAgentActivityEvent, end: number, post: ChatInterimPost): boolean {
  const at = event.afterContentLength ?? 0;
  if (at !== end) {
    return at < end;
  }
  // No text between them: the turn's activity numbers say which came first.
  return post.afterActivitySequence === undefined || event.sequence <= post.afterActivitySequence;
}

function shifted(event: ChatAgentActivityEvent, start: number): ChatAgentActivityEvent {
  if (start === 0 || event.afterContentLength === undefined) {
    return event;
  }
  return { ...event, afterContentLength: Math.max(0, event.afterContentLength - start) };
}
