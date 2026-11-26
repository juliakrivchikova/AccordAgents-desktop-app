import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
import { storageParts } from "./storage/test/storageParts";
import { MAIN_SESSION_ROLE_ID } from "../../shared/mainSession";
import type { ChatMessage, Conversation } from "../../shared/types";

/**
 * What the chat list shows of a chat besides its title (the User,
 * 2026-11-15): whether she pinned it, and whether a member's choice card in
 * it waits for her answer — found without reading every message.
 */
function chat(id: string, messages: ChatMessage[], metadata: Record<string, unknown> = {}): Conversation {
  return {
    id, kind: "chat", title: id, createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z",
    findings: [], metadata: { participantSessions: [], running: false, ...metadata } as Conversation["metadata"], messages
  };
}

const asked: ChatMessage = { id: "asked", role: "user", content: "@victor go", createdAt: "2026-11-01T10:00:00.000Z", status: "done" };
function card(status: "pending" | "selected" | "cancelled"): ChatMessage {
  return {
    id: "ask", role: "participant", participantId: "victor", participantLabel: "@victor", content: "Pick one.", status: "done", createdAt: "2026-11-01T10:00:02.000Z",
    metadata: { pendingChoice: { id: "c", title: "Which?", question: "Which?", options: [{ id: "a", label: "A" }], status } }
  };
}

test("the list says which chats are pinned, and since when", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-pinned-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    await storage.saveConversation(chat("pinned", [asked], { pinned: true, pinnedAt: "2026-11-15T10:00:00.000Z" }));
    await storage.saveConversation(chat("plain", [asked]));
    const listed = Object.fromEntries((await storage.listConversations()).map((summary) => [summary.id, [summary.pinned, summary.pinnedAt]]));
    assert.deepEqual(listed, { pinned: [true, "2026-11-15T10:00:00.000Z"], plain: [undefined, undefined] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a chat with a member's choice card waiting for the User is listed so, and stops being once it is answered or closed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-waiting-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    await storage.saveConversation(chat("waits", [asked, card("pending")]));
    // Pending somewhere, but not a waiting card: a member's reply not ended,
    // a User's message still sending.
    await storage.saveConversation(chat("busy", [asked, { id: "r", role: "participant", participantId: "victor", content: "", createdAt: "2026-11-01T10:00:01.000Z", status: "pending" },
      { id: "u", role: "user", content: "sending", createdAt: "2026-11-01T10:00:03.000Z", status: "pending" }]));
    const waiting = async () => Object.fromEntries((await storage.listConversations()).map((summary) => [summary.id, summary.waitingChoice === true]));
    assert.deepEqual(await waiting(), { waits: true, busy: false });
    // Answered on her server, waiting for the member's machine to apply it: not hers to answer any more.
    const answeredElsewhere = card("pending");
    answeredElsewhere.metadata = { ...answeredElsewhere.metadata, serverCard: { cardId: "choice:ask", state: "answered", answer: {}, answeredAt: "2026-11-01T10:05:00.000Z", machineName: "box" } };
    await storage.saveConversation(chat("waits", [asked, answeredElsewhere]));
    assert.equal((await waiting()).waits, false, "answered on the server");
    await storage.saveConversation(chat("waits", [asked, card("selected")]));
    assert.equal((await waiting()).waits, false, "answered");
    await storage.saveConversation(chat("waits", [asked, card("cancelled")]));
    assert.equal((await waiting()).waits, false, "closed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("waiting cards are found through the partial index, without reading every message", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-waiting-index-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    await storage.saveConversation(chat("waits", [asked, card("pending")]));
    const internals = storageParts(storage).sqlite as unknown as { queryJson(sql: string): Promise<unknown[]>; queryText(sql: string): Promise<string> };
    let listSql = "";
    const queryJson = internals.queryJson.bind(internals);
    internals.queryJson = async (sql: string) => {
      if (sql.includes("as waitingChoice")) listSql = sql;
      return queryJson(sql);
    };
    await storage.listConversations();
    assert.ok(listSql, "the list asked for waiting cards");
    const plan = await internals.queryText(`explain query plan ${listSql}`);
    const searches = plan.split("\n").filter((line) => /SEARCH m USING INDEX idx_conversation_messages_pending_reply/.test(line));
    assert.equal(searches.length, 2, plan);
    assert.doesNotMatch(plan, /SCAN m\b/, plan);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the list names the provider of each chat's main session, by role, and none for a chat without one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-main-kind-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  const member = (id: string, kind: string, roleConfigId: string) => ({ id, handle: id, kind, roleConfigId });
  try {
    // The main session is not the first member: a member it made runs on another CLI.
    await storage.saveConversation(chat("sessions", [asked], {
      participants: [member("worker", "codex-cli", "engineer"), member("main", "claude-code", MAIN_SESSION_ROLE_ID)],
      mainSessionParticipantId: "main"
    }));
    await storage.saveConversation(chat("classic", [asked], { participants: [member("assistant", "codex-cli", "chat-assistant"), member("victor", "claude-code", "engineer")] }));
    const kinds = Object.fromEntries((await storage.listConversations()).map((summary) => [summary.id, summary.mainSessionKind]));
    assert.deepEqual(kinds, { sessions: "claude-code", classic: undefined });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the CLI import finds the chat that holds a thread, by a member's session or an imported main session's origin", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-cli-sessions-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    await storage.saveConversation(chat("ran", [asked], { participantSessions: [{ participantId: "m", sessionId: "codex-thread" }, { participantId: "n", sessionId: "" }] }));
    // Imported, its first turn not run yet: no session record, only the origin.
    await storage.saveConversation(chat("imported", [asked], { participants: [{ id: "main", handle: "main", kind: "claude-code", importOrigin: { kind: "claude-code", sessionId: "claude-thread" } }] }));
    const found = (await storage.listChatCliSessions()).map((row) => `${row.sessionId}:${row.conversationId}`).sort();
    assert.deepEqual(found, ["claude-thread:imported", "codex-thread:ran"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
