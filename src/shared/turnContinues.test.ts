import assert from "node:assert/strict";
import test from "node:test";
import { isEmptyFinishedReply } from "./turnContinues";
import type { ChatMessage } from "./types";

const reply = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m", role: "participant", participantId: "p", participantLabel: "@main", content: "", status: "done",
  createdAt: "2026-11-22T16:55:21.853Z", metadata: { runId: "fd9e2f79", workedMs: 77 }, ...extra
} as ChatMessage);
const event = (kind: string, label: string) => ({ id: "e", sequence: 1, kind, label, createdAt: "2026-11-22T16:55:21.930Z" });
const withMeta = (metadata: Record<string, unknown>): ChatMessage => reply({ metadata: { runId: "r", workedMs: 77, ...metadata } as ChatMessage["metadata"] });

test("a finished reply with nothing in it is drawn no row for", () => {
  assert.equal(isEmptyFinishedReply(reply()), true);
  assert.equal(isEmptyFinishedReply(reply({ content: "  \n" })), true);
  // As the User's chats hold them (2026-11-22): only the app's own note.
  assert.equal(isEmptyFinishedReply(withMeta({ activityEvents: [event("status", "Running in the background: Adversarial review of the release")] })), true);
  assert.equal(isEmptyFinishedReply(withMeta({ turnContinues: true })), true);
});

test("a reply that shows anything, or has not finished, keeps its row", () => {
  assert.equal(isEmptyFinishedReply(reply({ content: "Done." })), false);
  assert.equal(isEmptyFinishedReply(reply({ status: "pending" })), false);
  assert.equal(isEmptyFinishedReply(reply({ status: "error" })), false);
  assert.equal(isEmptyFinishedReply(reply({ role: "user" })), false);
  assert.equal(isEmptyFinishedReply(withMeta({ activityEvents: [event("command", "Ran tests")] })), false);
  assert.equal(isEmptyFinishedReply(withMeta({ activityEvents: [event("status", "Background task finished: Run the soak")] })), false);
  assert.equal(isEmptyFinishedReply(withMeta({ imageAttachments: [{ id: "i" }] })), false);
  assert.equal(isEmptyFinishedReply(withMeta({ pendingChoice: { title: "T" } })), false);
  assert.equal(isEmptyFinishedReply(withMeta({ participantRequest: { items: [] } })), false);
});
