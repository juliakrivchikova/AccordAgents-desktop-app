import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
import { usageActiveChatViews } from "./usageMilestones";
import { usageWeeklySnapshot } from "../../shared/usageSignals";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";

/**
 * The weekly snapshot counts the chats in use by the view each is shown in
 * (docs/main-session.md), so the User sees whether anyone still works in the
 * classic view before it is removed. Read with one query from the chat rows.
 */
const main = { id: "main-1", handle: "main", roleConfigId: "main-session", kind: "claude-code" } as ChatParticipant;
const assistant = { id: "assistant-1", handle: "assistant", roleConfigId: "administrator", kind: "codex-cli" } as ChatParticipant;

function chat(id: string, messages: ChatMessage[], metadata: Record<string, unknown>): Conversation {
  return {
    id, kind: "chat", title: id, createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-19T10:00:00.000Z",
    findings: [], metadata: { participantSessions: [], running: false, ...metadata } as Conversation["metadata"], messages
  };
}

function message(id: string, role: ChatMessage["role"], createdAt: string): ChatMessage {
  return { id, role, content: id, createdAt, status: "done", ...(role === "participant" ? { participantId: "main-1" } : {}) };
}

test("the chats with a User message that week, counted by their view", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-usage-views-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  const recent = "2026-11-18T10:00:00.000Z";
  const old = "2026-11-01T10:00:00.000Z";
  try {
    await storage.saveConversation(chat("sessions", [message("s-1", "user", recent)], { participants: [main], mainSessionParticipantId: main.id, chatView: "sessions" }));
    await storage.saveConversation(chat("switched", [message("c-1", "user", old), message("c-2", "user", recent)], { participants: [main], mainSessionParticipantId: main.id, chatView: "classic" }));
    await storage.saveConversation(chat("unset", [message("u-1", "user", recent)], { participants: [main], mainSessionParticipantId: main.id }));
    await storage.saveConversation(chat("assistant", [message("a-1", "user", recent)], { participants: [assistant] }));
    // A main session no longer in the chat: shown the classic way.
    await storage.saveConversation(chat("gone", [message("g-1", "user", recent)], { participants: [assistant], mainSessionParticipantId: main.id, chatView: "sessions" }));
    // Not in use that week: only an older User message, or only a member's.
    await storage.saveConversation(chat("quiet", [message("q-1", "user", old), message("q-2", "participant", recent)], { participants: [main], mainSessionParticipantId: main.id, chatView: "sessions" }));

    const active = await storage.listChatViewsWithUserMessagesSince("2026-11-13T00:00:00.000Z");
    assert.equal(active.length, 5);
    const views = usageActiveChatViews(active).sort();
    assert.deepEqual(views, ["classic", "classic", "classic", "sessions", "sessions"],
      "sessions, and unset (sessions by default); the switched one, the Assistant's and the one whose main session is gone are classic");

    const snapshot = usageWeeklySnapshot("2026-W47", [], 0, usageActiveChatViews(active));
    assert.deepEqual([snapshot.chats_sessions_view_active, snapshot.chats_classic_view_active], ["2", "3-5"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
