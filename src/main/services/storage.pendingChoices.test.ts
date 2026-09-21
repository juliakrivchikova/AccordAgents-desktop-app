import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
import type { ChatMessage, Conversation } from "../../shared/types";

/**
 * The query behind the phone's chat list: which choices still wait for the
 * User in the listed chats. The phone drops every pending card the list does
 * not name, so this has to be exact — pending only, listed chats only, and
 * honest about a set it could not carry whole.
 */
function asking(id: string, status: "pending" | "selected" | "cancelled", createdAt: string): ChatMessage {
  return {
    id, role: "participant", participantLabel: "@drew", content: "Pick one.", status: "done", createdAt,
    metadata: { pendingChoice: { id: `choice-${id}`, title: "Which?", question: "Which one?", options: [{ id: "a", label: "A" }], status } }
  };
}

function chat(id: string, messages: ChatMessage[]): Conversation {
  return {
    id, kind: "chat", title: id, createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z",
    findings: [], metadata: {}, messages
  };
}

test("listPendingChoiceMessages returns the listed chats' waiting choices, whole or not at all", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-pending-choices-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    await storage.saveConversation(chat("listed", [
      asking("open", "pending", "2026-09-20T10:00:00.000Z"),
      asking("answered", "selected", "2026-09-20T10:01:00.000Z"),
      asking("dropped", "cancelled", "2026-09-20T10:02:00.000Z"),
      { id: "plain", role: "user", content: "hello", createdAt: "2026-09-20T10:03:00.000Z", status: "done" }
    ]));
    await storage.saveConversation(chat("elsewhere", [asking("other", "pending", "2026-09-20T10:04:00.000Z")]));

    const found = await storage.listPendingChoiceMessages(["listed", " ", "listed"]);
    assert.equal(found.truncated, false);
    assert.deepEqual(
      found.rows.map((row) => [row.conversationId, row.message.id, row.message.metadata?.pendingChoice?.id]),
      [["listed", "open", "choice-open"]],
      "pending only, the listed chat only, once"
    );
    assert.deepEqual(await storage.listPendingChoiceMessages([]), { rows: [], truncated: false });
    assert.deepEqual(await storage.listPendingChoiceMessages(["missing"]), { rows: [], truncated: false });

    // A row whose payload is not JSON must not take the whole query down with
    // it: the phone would then get no chat list at all.
    await (storage as unknown as { runSql(sql: string): Promise<void> }).runSql(
      "insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)" +
      " values ('listed', 99, 'broken', '2026-09-20T11:00:00.000Z', 'not json');"
    );
    const afterBroken = await storage.listPendingChoiceMessages(["listed"]);
    assert.deepEqual(afterBroken.rows.map((row) => row.message.id), ["open"], "the broken row is left out, the others are found");

    // Past the cap the set is incomplete and says so, rather than being
    // offered as the whole of what waits.
    const many = Array.from({ length: 501 }, (_, index) =>
      asking(`many-${index}`, "pending", new Date(Date.UTC(2026, 8, 21, 0, index)).toISOString()));
    await storage.saveConversation(chat("crowded", many));
    const crowded = await storage.listPendingChoiceMessages(["crowded", "listed"]);
    assert.equal(crowded.truncated, true, "more waiting choices than the list may carry");
    assert.equal(crowded.rows.length, 500);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
