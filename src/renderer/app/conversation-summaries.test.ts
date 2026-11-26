import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage, Conversation, ConversationSummary, ConversationUpdate } from "../../shared/types";
import { RECENT_CHAT_LIMIT, pinnedChatSummaries, recentChatSummaries, upsertConversationSummary, withPinnedState } from "./conversation-summaries";
import { MAIN_SESSION_ROLE_ID } from "../../shared/mainSession";

// The chat list row shows work while a run of this device is in the chat, and
// also while a member's reply has not ended anywhere — a machine member's turn
// asked from the phone leaves no run here, only its reply. Only a run of this
// device blocks what a run blocks (`running`).
const asked: ChatMessage = { id: "asked", role: "user", content: "@victor go", createdAt: "2026-11-01T10:00:00.000Z", status: "done" };
const replying: ChatMessage = {
  id: "reply", role: "participant", participantId: "victor", content: "", createdAt: "2026-11-01T10:00:01.000Z", status: "pending",
  metadata: { runId: "turn-asked-victor" }
};

function chat(messages: ChatMessage[], metadata: Record<string, unknown> = {}): Conversation {
  return {
    id: "chat-1", title: "Chat", kind: "chat", createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T10:00:02.000Z",
    findings: [], messages, metadata: { participantSessions: [], running: false, ...metadata } as Conversation["metadata"]
  };
}

const stateOf = (conversation: ConversationUpdate): { running: boolean; replyPending: boolean } => {
  const summary = upsertConversationSummary([], conversation)[0];
  return { running: summary?.running === true, replyPending: summary?.replyPending === true };
};
const replyPendingOf = (conversation: ConversationUpdate): boolean => stateOf(conversation).replyPending;

test("a full update with a member's reply not ended shows it, with no run of this device", () => {
  assert.deepEqual(stateOf(chat([asked, replying])), { running: false, replyPending: true });
  assert.deepEqual(stateOf(chat([asked, { ...replying, status: "done", content: "Done." }])), { running: false, replyPending: false });
  assert.deepEqual(stateOf(chat([asked], { activeRunIds: ["run-here"] })), { running: true, replyPending: false }, "a run of this device");
});

test("a delta is read for the whole chat, not only for the messages it carries", () => {
  const later: ChatMessage = { id: "later", role: "user", content: "meanwhile", createdAt: "2026-11-01T10:00:02.000Z", status: "done" };
  const delta = (replyPending: boolean | undefined): ConversationUpdate => ({
    ...chat([later]),
    messageDelta: { totalMessages: 3, tailCount: 1, removedIds: [], ...(replyPending === undefined ? {} : { replyPending }) }
  });
  assert.equal(replyPendingOf(delta(true)), true, "the pending reply is outside the carried window");
  assert.equal(replyPendingOf(delta(false)), false);
  assert.equal(replyPendingOf({ ...delta(false), messages: [replying] }), true, "a carried pending reply counts as well");
  // A delta that does not say (none is made so now) is read from what it carries.
  assert.equal(replyPendingOf(delta(undefined)), false);
  assert.equal(replyPendingOf({ ...delta(undefined), messages: [replying] }), true);
});

// Pinned and Recents above the projects (the User, 2026-11-15).
function listed(id: string, updatedAt: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return { id, title: id, kind: "chat", createdAt: "2026-11-01T09:00:00.000Z", updatedAt, ...extra };
}

test("Pinned lists pinned chats in the order they were pinned, never an archived one", () => {
  const summaries = [
    listed("late-pin", "2026-11-15T10:00:00.000Z", { pinned: true, pinnedAt: "2026-11-15T09:00:00.000Z" }),
    listed("early-pin", "2026-11-01T10:00:00.000Z", { pinned: true, pinnedAt: "2026-11-14T09:00:00.000Z" }),
    listed("archived-pin", "2026-11-15T11:00:00.000Z", { pinned: true, pinnedAt: "2026-11-13T09:00:00.000Z", archived: true }),
    listed("plain", "2026-11-15T12:00:00.000Z")
  ];
  assert.deepEqual(pinnedChatSummaries(summaries).map((summary) => summary.id), ["early-pin", "late-pin"]);
});

test("Recents lists the newest chats of every project, pinned ones included, at most twenty", () => {
  const summaries = Array.from({ length: 25 }, (_, index) =>
    listed(`chat-${index}`, new Date(Date.parse("2026-11-01T00:00:00.000Z") + index * 60_000).toISOString(), {
      repoPath: index % 2 ? "/a" : "/b", ...(index === 24 ? { pinned: true, pinnedAt: "2026-11-15T00:00:00.000Z" } : {}), ...(index === 23 ? { archived: true } : {})
    }));
  const recents = recentChatSummaries(summaries);
  assert.equal(RECENT_CHAT_LIMIT, 20);
  assert.equal(recents.length, 20);
  assert.deepEqual(recents.slice(0, 3).map((summary) => summary.id), ["chat-24", "chat-22", "chat-21"], "newest first, pinned too, archived never");
});

test("a chat's pin state is taken without its other fields, and a full update carries it with the waiting mark", () => {
  const base = listed("chat-1", "2026-11-15T10:00:00.000Z", { running: true, waitingChoice: true });
  const pinned = withPinnedState(base, true, "2026-11-15T11:00:00.000Z");
  assert.deepEqual([pinned.pinned, pinned.pinnedAt, pinned.running, pinned.waitingChoice, pinned.updatedAt], [true, "2026-11-15T11:00:00.000Z", true, true, base.updatedAt]);
  const unpinned = withPinnedState(pinned, false, "2026-11-15T12:00:00.000Z");
  assert.deepEqual([unpinned.pinned, unpinned.pinnedAt], [undefined, undefined]);

  const asking: ChatMessage = {
    id: "ask", role: "participant", participantId: "victor", content: "Pick one.", createdAt: "2026-11-01T10:00:03.000Z", status: "done",
    metadata: { pendingChoice: { id: "c", title: "Which?", question: "Which?", options: [{ id: "a", label: "A" }], status: "pending" } }
  };
  const full = upsertConversationSummary([], chat([asked, asking], { pinned: true, pinnedAt: "2026-11-15T11:00:00.000Z" }))[0];
  assert.deepEqual([full.pinned, full.pinnedAt, full.waitingChoice], [true, "2026-11-15T11:00:00.000Z", true]);
  // A delta speaks for the whole chat: the card may be older than what it carries.
  const delta: ConversationUpdate = { ...chat([asked]), messageDelta: { totalMessages: 300, tailCount: 1, removedIds: [], waitingChoice: true } };
  assert.equal(upsertConversationSummary([], delta)[0].waitingChoice, true);
  const answered: ConversationUpdate = { ...chat([asked, asking]), messageDelta: { totalMessages: 300, tailCount: 2, removedIds: [], waitingChoice: false } };
  assert.equal(upsertConversationSummary([], answered)[0].waitingChoice, undefined);
});


test("a live update names the provider of the chat's main session, as the stored list does", () => {
  const member = (id: string, kind: string, roleConfigId: string) => ({ id, handle: id, kind, roleConfigId });
  const kindOf = (metadata: Record<string, unknown>) => upsertConversationSummary([], chat([asked], metadata))[0]?.mainSessionKind;
  // By role, not by position: the main session here runs on Antigravity, its member on Codex.
  assert.equal(kindOf({ participants: [member("worker", "codex-cli", "engineer"), member("main", "gemini-cli", MAIN_SESSION_ROLE_ID)], mainSessionParticipantId: "main" }), "gemini-cli");
  assert.equal(kindOf({ participants: [member("assistant", "codex-cli", "chat-assistant")] }), undefined, "a classic chat with its Assistant");
});
