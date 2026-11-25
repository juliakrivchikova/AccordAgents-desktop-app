import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { MessageLinkContext } from "../content/markdown-text";
import { ChatMessageItem } from "./chat-message-item";
import { turnFinishedNoteOf } from "../../../shared/turnFinishedNoteSource";
import type { ChatActivityDisclosureState } from "./use-chat-activity-disclosure";

const NOW = "2026-11-04T20:44:00.000Z";

const taylor = { id: "p-taylor", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code" } as ChatParticipant;

function note(metadata: ChatMessage["metadata"] = {
  appMessageSource: "app_turn_finished_note",
  turnFinishedNote: { messageId: "reply-1", participantId: "p-taylor", participantLabel: "@taylor" }
}): ChatMessage {
  return { id: "note-1", role: "system", content: "Done: the Save button is no longer cut off.", createdAt: NOW, status: "done", metadata } as ChatMessage;
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

function renderItem(message: ChatMessage, handlers: { focus?: (id: string) => boolean; dismiss?: (id: string) => void } = {}) {
  const noop = () => undefined;
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
      <MessageLinkContext.Provider value={handlers.focus}>
        <ChatMessageItem
          activityDisclosure={{} as ChatActivityDisclosureState}
          message={message}
          conversationId="chat-1"
          participants={[taylor]}
          participantStatusById={new Map()}
          busy={false}
          onApproveMentions={noop}
          onRejectMentions={noop}
          onRespondToChoice={noop}
          onToggleReaction={noop}
          onDismissTurnFinishedNote={handlers.dismiss}
        />
      </MessageLinkContext.Provider>
      </TooltipProvider>
    );
  });
  return renderer!.root;
}

test("only a turn-finished note's message reads as one", () => {
  assert.deepEqual(turnFinishedNoteOf(note()), { messageId: "reply-1", participantId: "p-taylor", participantLabel: "@taylor" });
  assert.equal(turnFinishedNoteOf(note({})), undefined, "a system message that is no note");
  assert.equal(turnFinishedNoteOf({ ...note(), role: "participant" }), undefined, "a member's message");
  assert.equal(turnFinishedNoteOf(note({ appMessageSource: "app_turn_finished_note" })), undefined, "a note that names no reply");
  assert.equal(turnFinishedNoteOf(note({ appMessageSource: "app_turn_finished_note",
    turnFinishedNote: { messageId: "reply-1", participantId: 7, participantLabel: null } as never })), undefined, "fields that are not strings");
});

test("the timeline row of a note is the card: the member, finished answering, the time, the reply's first line and a cross", () => {
  const focused: string[] = [];
  const dismissed: string[] = [];
  const root = renderItem(note(), { focus: (id) => { focused.push(id); return true; }, dismiss: (id) => dismissed.push(id) });
  assert.equal(root.findAll((node) => node.props?.className === "chat-turn-finished-note").length, 1, "the row is the card");
  const span = (className: string) => root.find((node) => node.type === "span" && node.props?.className === className);
  // The time as the timeline writes it, in this machine's locale.
  const when = root.find((node) => node.type === "time" || (typeof node.props?.className === "string" && node.props.className.includes("message-when")));
  assert.equal(textOf(span("chat-turn-finished-note-title")), `@taylor finished answering · ${textOf(when)}`);
  assert.equal(textOf(span("chat-turn-finished-note-preview")), "Done: the Save button is no longer cut off.");
  assert.equal(root.findAll((node) => typeof node.props?.className === "string" && node.props.className.includes("chat-turn-finished-note-avatar")).length > 0, true);
  // No reactions, no copy, no thread: the cross is its only control.
  assert.equal(root.findAll((node) => typeof node.props?.className === "string" && node.props.className.includes("message-actions")).length, 0);
  const open = root.find((node) => node.type === "button" && node.props?.className === "chat-turn-finished-note-open");
  let prevented = false;
  act(() => { open.props.onClick({ preventDefault: () => { prevented = true; } }); });
  assert.deepEqual(focused, ["reply-1"], "the card leads back to the reply");
  assert.equal(prevented, true, "the chat keeps the highlight it moved, as for a link to a message");
  // The icon button itself: its DOM button sits in a tooltip trigger that
  // needs a browser window.
  const cross = root.find((node) => typeof node.type !== "string" && node.props?.label === "Dismiss note" && typeof node.props?.onClick === "function");
  act(() => { cross.props.onClick(); });
  assert.deepEqual(dismissed, ["note-1"], "the cross takes the note away");
});

test("without a way to take it away the card has no cross", () => {
  const root = renderItem(note());
  assert.equal(root.findAll((node) => typeof node.type !== "string" && node.props?.label === "Dismiss note").length, 0);
});

// What a member posts during its turn is part of its reply (shared/interimPosts.ts),
// so the reply stays last and no note is needed to find it (the User, 2026-11-20).

function reply(status: ChatMessage["status"], content: string, interimPosts: NonNullable<ChatMessage["metadata"]>["interimPosts"]): ChatMessage {
  return {
    id: "reply-1", role: "participant", participantId: "p-taylor", participantLabel: "@taylor", content, createdAt: NOW, status,
    metadata: { runId: "run-1", interimPosts, ...(status === "done" ? { workedMs: 90_000 } : {}) }
  } as ChatMessage;
}

function renderReply(message: ChatMessage, partialContent?: string) {
  const noop = () => undefined;
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMessageItem
          activityDisclosure={{ expandedProcessingTranscriptMessageIds: new Set<string>() } as unknown as ChatActivityDisclosureState}
          message={message}
          conversationId="chat-1"
          participants={[taylor]}
          participantStatusById={new Map()}
          busy={false}
          liveProgress={partialContent === undefined ? undefined : {
            participantId: "p-taylor", participantLabel: "@taylor", state: "running", messageId: "reply-1", partialContent, activityEvents: []
          }}
          onApproveMentions={noop}
          onRejectMentions={noop}
          onRespondToChoice={noop}
          onToggleReaction={noop}
        />
      </TooltipProvider>
    );
  });
  return renderer!.root;
}

const posts = [
  { id: "post-a", content: "Found the cause.", createdAt: NOW, afterContentLength: 8 },
  { id: "post-b", content: "Fixing it now.", createdAt: NOW, afterContentLength: 16 }
];

test("a finished reply shows the posts its member made during the turn inside it, in order, above its final answer", () => {
  const root = renderReply(reply("done", "Fixed: the button fits.", posts));
  const content = root.find((node) => node.props?.className === "message-content");
  const text = textOf(content);
  assert.ok(text.indexOf("Found the cause.") >= 0 && text.indexOf("Found the cause.") < text.indexOf("Fixing it now."), text);
  assert.ok(text.indexOf("Fixing it now.") < text.indexOf("Fixed: the button fits."), "the final answer comes last");
  assert.equal(root.findAll((node) => node.props?.className === "chat-interim-post").length, 2, "each post in the reply's own bubble");
  const worked = root.find((node) => node.props?.className === "chat-worked-wrap");
  assert.ok(textOf(worked).startsWith("Worked for"), "the worked-for row is still there");
  assert.ok(!textOf(worked).includes("Found the cause."), "the posts are not folded with the work");
});

test("a running reply shows its posts in order with the text it is streaming", () => {
  const root = renderReply(reply("pending", "", posts), "Reading.Writing.And now testing.");
  const text = textOf(root.find((node) => node.props?.className === "message-content"));
  const order = ["Reading.", "Found the cause.", "Writing.", "Fixing it now.", "And now testing."].map((part) => text.indexOf(part));
  assert.ok(order.every((index) => index >= 0), text);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `in the order they were written: ${text}`);
});

test("a running reply with posts and no streamed text yet shows the posts, then that it is still thinking", () => {
  const root = renderReply(reply("pending", "", [posts[0]]));
  const text = textOf(root.find((node) => node.props?.className === "message-content"));
  assert.ok(text.indexOf("Found the cause.") >= 0 && text.indexOf("Found the cause.") < text.indexOf("Thinking"), text);
});
