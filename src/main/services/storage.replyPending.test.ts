import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
import type { ChatMessage, Conversation } from "../../shared/types";

/**
 * The chat list says a chat has a member's reply not ended, apart from
 * whether this device runs something in it: a machine member's turn asked
 * from the phone runs with no run of this device at all, and its pending
 * reply is the only sign of it here. What a run blocks (`running`) stays
 * this device's own.
 */
function chat(id: string, messages: ChatMessage[], metadata: Record<string, unknown> = {}): Conversation {
  return {
    id, kind: "chat", title: id, createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z",
    findings: [], metadata: { participantSessions: [], running: false, ...metadata } as Conversation["metadata"], messages
  };
}

const asked: ChatMessage = { id: "asked", role: "user", content: "@victor go", createdAt: "2026-11-01T10:00:00.000Z", status: "done" };
const replying: ChatMessage = {
  id: "reply", role: "participant", participantId: "victor", participantLabel: "@victor", content: "",
  createdAt: "2026-11-01T10:00:01.000Z", status: "pending", metadata: { runId: "turn-asked-victor", serverSeq: 7, serverWriter: "device-machine" }
};

test("a chat with a member's reply not ended is listed so, apart from the runs of this device", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-reply-pending-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    await storage.saveConversation(chat("machine-turn", [asked, replying]));
    // Pending somewhere in the JSON, but not a member's reply: a choice that
    // waits for the User, and a pending status on a User's message.
    await storage.saveConversation(chat("choice-waits", [
      { ...asked, id: "q" },
      { id: "ask", role: "participant", participantLabel: "@victor", content: "Pick one.", status: "done", createdAt: "2026-11-01T10:00:02.000Z",
        metadata: { pendingChoice: { id: "c", title: "Which?", question: "Which?", options: [{ id: "a", label: "A" }], status: "pending" } } },
      { id: "user-pending", role: "user", content: "sending", createdAt: "2026-11-01T10:00:03.000Z", status: "pending" }
    ]));
    await storage.saveConversation(chat("quiet", [asked, { ...replying, status: "done", content: "Done." }]));
    await storage.saveConversation(chat("local-run", [asked], { running: true, activeRunIds: ["run-here"] }));

    const listed = async () => Object.fromEntries((await storage.listConversations())
      .map((summary) => [summary.id, { running: summary.running, replyPending: summary.replyPending === true }]));
    assert.deepEqual(await listed(), {
      "machine-turn": { running: false, replyPending: true },
      "choice-waits": { running: false, replyPending: false },
      quiet: { running: false, replyPending: false },
      "local-run": { running: true, replyPending: false }
    });

    // The machine wrote its reply's end: nothing is pending any more.
    await storage.saveConversation(chat("machine-turn", [asked, { ...replying, status: "done", content: "Done." }]));
    assert.equal((await listed())["machine-turn"].replyPending, false);
    // A reply that failed or was stopped has ended too.
    await storage.saveConversation(chat("machine-turn", [asked, { ...replying, status: "error", content: "Stopped." }]));
    assert.equal((await listed())["machine-turn"].replyPending, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the list's own query finds pending replies through the partial index, without reading every message", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-reply-pending-index-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    await storage.saveConversation(chat("machine-turn", [asked, replying]));
    const internals = storage as unknown as { queryJson(sql: string): Promise<unknown[]>; queryText(sql: string): Promise<string> };
    // The SQL the list really runs, not a copy of it.
    let listSql = "";
    const queryJson = internals.queryJson.bind(storage);
    internals.queryJson = async (sql: string) => {
      if (sql.includes("as replyPending")) listSql = sql;
      return queryJson(sql);
    };
    await storage.listConversations();
    assert.ok(listSql, "the list asked for pending replies");
    const plan = await internals.queryText(`explain query plan ${listSql}`);
    assert.match(plan, /SEARCH m USING INDEX idx_conversation_messages_pending_reply/, plan);
    // Only the rows that can match are in it.
    const indexed = await internals.queryText(
      `select count(*) from conversation_messages indexed by idx_conversation_messages_pending_reply where instr(payload_json, '"status":"pending"') > 0;`
    );
    assert.equal(indexed.trim(), "1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
