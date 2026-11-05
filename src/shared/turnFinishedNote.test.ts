import assert from "node:assert/strict";
import test from "node:test";
import { APP_CHAT_SEND_MESSAGE_TOOL } from "./appMcpToolContracts";
import { isChatMessageHiddenFromTimeline } from "./chatTimelineVisibility";
import { turnFinishedNoteFor, turnFinishedNoteId, turnFinishedNotePreview } from "./turnFinishedNote";
import { TURN_FINISHED_NOTE_SOURCE, turnFinishedNoteOf } from "./turnFinishedNoteSource";
import type { ChatMessage, ChatMessageMetadata } from "./types";

const NOTE = { createdAt: "2026-11-04T20:44:00.000Z" };

function user(id: string, content: string, metadata?: ChatMessageMetadata): ChatMessage {
  return { id, role: "user", content, createdAt: "2026-11-04T20:40:00.000Z", status: "done", metadata: { threadId: id, ...metadata } };
}

function reply(id: string, content: string, patch: Partial<ChatMessage> = {}, metadata?: ChatMessageMetadata): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: "taylor",
    participantLabel: "@taylor",
    content,
    createdAt: "2026-11-04T20:40:01.000Z",
    status: "done",
    ...patch,
    metadata: { threadId: "ask", runId: "run-1", ...metadata }
  };
}

function post(id: string, content: string, metadata?: ChatMessageMetadata): ChatMessage {
  return reply(id, content, { createdAt: "2026-11-04T20:41:00.000Z" }, { appMessageSource: APP_CHAT_SEND_MESSAGE_TOOL, ...metadata });
}

test("a reply with the member's own posts below it gets a note at the end that leads back to it", () => {
  const card = reply("card", "Готово: кнопка больше не обрезается.\n\nПодробности ниже.");
  const messages = [user("ask", "@taylor почини кнопку"), card, post("p1", "Нашла причину"), post("p2", "Проверяю")];
  const note = turnFinishedNoteFor({ messages }, [card], NOTE);
  assert.ok(note);
  assert.equal(note.id, turnFinishedNoteId("card"), "one id per reply, whoever writes it");
  assert.equal(note.role, "system");
  assert.equal(note.status, "done");
  assert.equal(note.content, "Готово: кнопка больше не обрезается.");
  assert.equal(note.metadata?.appMessageSource, TURN_FINISHED_NOTE_SOURCE);
  assert.deepEqual(note.metadata?.turnFinishedNote, { messageId: "card", participantId: "taylor", participantLabel: "@taylor" });
  assert.equal(note.metadata?.chatThreadRootId, undefined, "a reply on the timeline gets its note on the timeline");
  assert.deepEqual(turnFinishedNoteOf(note), note.metadata?.turnFinishedNote);
  // The timeline and the phone show it, as they show artifact notes.
  assert.equal(isChatMessageHiddenFromTimeline(note), false);
});

test("the User's words or another member's reply below count as well", () => {
  const card = reply("card", "Done.");
  assert.ok(turnFinishedNoteFor({ messages: [user("ask", "go"), card, user("later", "and dark theme too")] }, [card], NOTE));
  const other = reply("other", "Me too", { participantId: "gera", participantLabel: "@gera" });
  assert.ok(turnFinishedNoteFor({ messages: [user("ask", "go"), card, other] }, [card], NOTE));
  const running = reply("running", "", { participantId: "gera", participantLabel: "@gera", status: "pending" });
  assert.ok(turnFinishedNoteFor({ messages: [user("ask", "go"), card, running] }, [card], NOTE), "a turn still running below counts");
});

test("no note when the reply is last where it stands", () => {
  const card = reply("card", "Done.");
  assert.equal(turnFinishedNoteFor({ messages: [user("ask", "go"), card] }, [card], NOTE), undefined);
  // What the timeline does not show is not below it.
  const hidden: ChatMessage = { id: "sys", role: "system", content: "Auto-resumed @taylor.", createdAt: NOTE.createdAt, status: "done", metadata: { threadId: "system" } };
  const hiddenReply = reply("carrier", "x", {}, { hiddenFromTimeline: true });
  assert.equal(turnFinishedNoteFor({ messages: [user("ask", "go"), card, hidden, hiddenReply] }, [card], NOTE), undefined);
  // Nor are replies filed in a thread under another message.
  const inThread = user("t1", "thread reply", { chatThreadRootId: "ask", parentMessageId: "ask" });
  assert.equal(turnFinishedNoteFor({ messages: [user("ask", "go"), card, inThread] }, [card], NOTE), undefined);
});

test("what the same turn wrote after the reply does not count against it", () => {
  const card = reply("card", "First part.");
  const extra = reply("extra", "Second part.", { createdAt: "2026-11-04T20:43:00.000Z" });
  // The last finished reply of the turn is the one the note would be about, and it is last.
  assert.equal(turnFinishedNoteFor({ messages: [user("ask", "go"), card, extra] }, [card, extra], NOTE), undefined);
});

test("a stop, an error, an empty reply or a post is not a finished answer", () => {
  const below = post("p1", "progress");
  for (const card of [
    reply("card", "@taylor stopped by user.", { status: "error" }, { terminalReason: "user-stopped" }),
    reply("card", "@taylor run failed.", { status: "error" }),
    reply("card", "   "),
    post("card", "a post")
  ]) {
    assert.equal(turnFinishedNoteFor({ messages: [user("ask", "go"), card, below] }, [card], NOTE), undefined);
  }
});

test("a reply in a thread gets its note in that thread", () => {
  const root = user("root", "top");
  const ask = user("ask", "@taylor in thread", { chatThreadRootId: "root", parentMessageId: "root" });
  const card = reply("card", "Done in thread.", {}, { threadId: "root", chatThreadRootId: "root" });
  const later = user("later", "more", { chatThreadRootId: "root", parentMessageId: "root" });
  const note = turnFinishedNoteFor({ messages: [root, ask, card, later] }, [card], NOTE);
  assert.ok(note);
  assert.equal(note.metadata?.chatThreadRootId, "root");
  // A message on the main timeline is not below a reply in a thread.
  const onTimeline = user("top2", "elsewhere");
  assert.equal(turnFinishedNoteFor({ messages: [root, ask, card, onTimeline] }, [card], NOTE), undefined);
});

test("one note per reply, however often the turn's end is written", () => {
  const card = reply("card", "Done.");
  const messages = [user("ask", "go"), card, post("p1", "progress")];
  const note = turnFinishedNoteFor({ messages }, [card], NOTE);
  assert.ok(note);
  assert.equal(turnFinishedNoteFor({ messages: [...messages, note] }, [card], NOTE), undefined);
  // Once the User took it away it is not written again, however the turn's
  // end is evaluated afterwards.
  assert.equal(turnFinishedNoteFor({ messages }, [card], { ...NOTE, removedIds: [note.id] }), undefined);
});

test("another member's note below a reply is not a message below it", () => {
  // @a and @b asked together: @a finishes first while @b still runs below it
  // (its note is right), then @b finishes with only @a's note below it.
  const first = reply("first", "First done.");
  const running = reply("second", "", { participantId: "gera", participantLabel: "@gera", status: "pending" });
  const firstNote = turnFinishedNoteFor({ messages: [user("ask", "@taylor @gera go"), first, running] }, [first], NOTE);
  assert.ok(firstNote, "a member still answering below counts");
  const second = { ...running, content: "Second done.", status: "done" as const };
  assert.equal(turnFinishedNoteFor({ messages: [user("ask", "@taylor @gera go"), first, second, firstNote] }, [second], NOTE), undefined);
});

test("a message the server refused is not below a reply", () => {
  // It stays at the end of the chat on this device only, until it is sent again.
  const card = reply("card", "Done.");
  const refused = user("refused", "never taken", { serverRejected: "This chat was deleted." } as ChatMessageMetadata);
  assert.equal(turnFinishedNoteFor({ messages: [user("ask", "go"), card, refused] }, [card], NOTE), undefined);
});

test("the preview is the reply's first line of words, without markdown", () => {
  assert.equal(turnFinishedNotePreview("\n\n## **Готово**: всё [работает](https://x.test)\nвторая"), "Готово: всё работает");
  assert.equal(turnFinishedNotePreview("```ts\ncode\n```"), "code");
  assert.equal(turnFinishedNotePreview("- `один` пункт"), "один пункт");
  assert.equal(turnFinishedNotePreview(""), "");
  const long = turnFinishedNotePreview("слово ".repeat(100));
  assert.ok(long.length <= 200);
  assert.ok(long.endsWith("…"));
  // Cut by characters: an emoji at the cut is never split in two.
  const emoji = turnFinishedNotePreview(`${"a".repeat(198)}😀😀😀`);
  assert.equal(Array.from(emoji).length, 200);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), "no lone surrogate");
  assert.equal(turnFinishedNotePreview("~~old~~ new"), "old new");
});
