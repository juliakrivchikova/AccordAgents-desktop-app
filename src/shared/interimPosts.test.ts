import assert from "node:assert/strict";
import test from "node:test";
import {
  chatInterimPostsOf,
  chatMessageMemberText,
  mergeChatInterimPosts,
  splitLiveContentAtInterimPosts,
  withInterimPostsFrom
} from "./interimPosts";
import { buildChatSearchDocuments } from "./chatSearchDocuments";
import { turnFinishedNoteFor } from "./turnFinishedNote";
import type { ChatAgentActivityEvent, ChatImageAttachment, ChatInterimPost, ChatMessage, Conversation } from "./types";

const at = (second: number) => new Date(Date.UTC(2026, 10, 20, 10, 0, second)).toISOString();
const post = (id: string, second: number, extra: Partial<ChatInterimPost> = {}): ChatInterimPost =>
  ({ id, content: `Post ${id}.`, createdAt: at(second), ...extra });
const picture = (id: string): ChatImageAttachment =>
  ({ id, filename: `${id}.png`, mimeType: "image/png", sizeBytes: 10, width: 1, height: 1, storageKey: `${id}.png`, createdAt: at(0) });
const activity = (sequence: number, afterContentLength?: number): ChatAgentActivityEvent =>
  ({ id: `a${sequence}`, sequence, kind: "tool", label: `Tool ${sequence}`, createdAt: at(sequence), ...(afterContentLength === undefined ? {} : { afterContentLength }) });

test("a reply's posts read whole, malformed ones left out", () => {
  const posts = [post("a", 1), post("b", 2)];
  const message = { metadata: { interimPosts: posts } } as ChatMessage;
  assert.equal(chatInterimPostsOf(message), posts, "the stored list itself, so a view sees no change while there is none");
  assert.deepEqual(chatInterimPostsOf({ metadata: { interimPosts: [post("a", 1), { id: 3 }, null] } } as unknown as ChatMessage).map((item) => item.id), ["a"]);
  assert.deepEqual(chatInterimPostsOf({} as ChatMessage), []);
});

test("two copies of a reply merge their posts: each once, oldest first, with the pictures they carry", () => {
  assert.deepEqual(mergeChatInterimPosts([post("b", 2)], [post("a", 1), post("b", 2), post("c", 3)]).map((item) => item.id), ["a", "b", "c"]);
  const target = { runId: "r", interimPosts: [post("a", 1)] };
  const other = { interimPosts: [post("a", 1), post("b", 2, { attachmentIds: ["p1"] })], imageAttachments: [picture("p1"), picture("p-other")] };
  const merged = withInterimPostsFrom(target, other)!;
  assert.deepEqual(merged.interimPosts?.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(merged.imageAttachments?.map((item) => item.id), ["p1"], "only the posts' pictures come along");
  assert.equal(merged.runId, "r", "the rest of the copy is its own");
  assert.equal(withInterimPostsFrom(merged, other), merged, "nothing to add: the same object");
  assert.equal(withInterimPostsFrom(undefined, undefined), undefined);
  merged.interimPosts![1].content = "changed";
  assert.equal(other.interimPosts[1].content, "Post b.", "the other copy is not shared");
});

test("members read a reply as its posts, then its final words", () => {
  assert.equal(chatMessageMemberText({ content: "Done.", metadata: { interimPosts: [post("a", 1), post("b", 2)] } }), "Post a.\n\nPost b.\n\nDone.");
  assert.equal(chatMessageMemberText({ content: "", metadata: { interimPosts: [post("a", 1)] } }), "Post a.", "a turn still running");
  assert.equal(chatMessageMemberText({ content: " Just this. " }), " Just this. ", "no posts: the message as it is");
});

test("a running reply's streamed text is cut where its posts were made, activity included", () => {
  const content = "Reading.Writing.";
  const events = [activity(1), activity(2, 8), activity(3, 8), activity(4, 16)];
  const { parts, tail } = splitLiveContentAtInterimPosts(content, events, [
    post("a", 1, { afterContentLength: 8, afterActivitySequence: 2 }),
    post("b", 2, { afterContentLength: 99, afterActivitySequence: 4 })
  ]);
  assert.deepEqual(parts.map((part) => [part.post.id, part.content, part.activityEvents.map((event) => [event.sequence, event.afterContentLength])]), [
    ["a", "Reading.", [[1, undefined], [2, 8]]],
    // A tool run after the post at the same place in the text goes after it.
    ["b", "Writing.", [[3, 0], [4, 8]]]
  ]);
  assert.deepEqual(tail, { content: "", activityEvents: [] }, "an offset past the text puts the post after all of it");
  const unplaced = splitLiveContentAtInterimPosts("Text so far.", [], [post("a", 1)]);
  assert.equal(unplaced.parts[0].content, "", "a post with no place is shown first");
  assert.equal(unplaced.tail.content, "Text so far.");
});

test("posts are part of their reply: they never bury it, and search finds them with it", () => {
  const reply: ChatMessage = {
    id: "reply", role: "participant", participantId: "p", participantLabel: "@taylor", content: "Fixed.", createdAt: at(1), status: "done",
    metadata: { interimPosts: [post("a", 2, { content: "Found the cause in the layout." })] }
  };
  const conversation = { title: "Chat", messages: [{ id: "ask", role: "user", content: "fix it", createdAt: at(0), status: "done" }, reply], metadata: {} } as unknown as Conversation;
  assert.equal(turnFinishedNoteFor(conversation, [reply], { createdAt: at(5) }), undefined, "no note: nothing is below the reply");
  const document = buildChatSearchDocuments(conversation).find((item) => item.kind === "message" && item.messageId === "reply");
  assert.equal(document && document.kind === "message" ? document.body : "", "Found the cause in the layout.\n\nFixed.");
});
