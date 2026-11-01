import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runningMessageForParticipant, runningMessageTarget } from "../../shared/chatRunningMessage";
import { resolveSqliteExecutable } from "./sqliteCli";
import { StorageService } from "./storage";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";

const taylor: ChatParticipant = { id: "taylor", handle: "taylor", roleConfigId: "engineer", kind: "claude-code" };
const drew: ChatParticipant = { id: "drew", handle: "drew", roleConfigId: "engineer", kind: "codex-cli" };

function at(second: number): string {
  return new Date(Date.UTC(2026, 9, 31, 20, 0, second)).toISOString();
}

function memberMessage(id: string, second: number, options: {
  participant?: ChatParticipant;
  status?: ChatMessage["status"];
  runId?: string;
  queued?: boolean;
  threadRootId?: string;
  content?: string;
} = {}): ChatMessage {
  const participant = options.participant ?? taylor;
  return {
    id,
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: options.content ?? (options.status === "pending" ? "" : `post ${id}`),
    createdAt: at(second),
    status: options.status ?? "done",
    metadata: {
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.queued ? { queuedBehind: { handle: participant.handle } } : {}),
      ...(options.threadRootId ? { chatThreadRootId: options.threadRootId } : {})
    }
  };
}

function chat(messages: ChatMessage[], activeRuns: Record<string, string> = {}): Conversation {
  return {
    id: "chat",
    title: "chat",
    kind: "chat",
    createdAt: at(0),
    updatedAt: at(59),
    messages,
    findings: [],
    metadata: {
      participants: [taylor, drew],
      activeRunIds: Object.keys(activeRuns),
      activeRunParticipantIdsByRunId: activeRuns
    }
  };
}

test("a running member opens its turn in progress, not the posts it made during the turn", () => {
  const conversation = chat([
    memberMessage("turn", 1, { status: "pending", runId: "run-1" }),
    memberMessage("post-1", 2, { runId: "run-1" }),
    memberMessage("post-2", 3, { runId: "run-1" })
  ], { "run-1": "taylor" });

  assert.equal(runningMessageForParticipant(conversation, "taylor")?.id, "turn");
});

test("a turn queued behind the member's running turn is skipped", () => {
  const conversation = chat([
    memberMessage("turn", 1, { status: "pending", runId: "run-1" }),
    memberMessage("post", 2, { runId: "run-1" }),
    memberMessage("queued", 3, { status: "pending", runId: "run-2", queued: true })
  ], { "run-1": "taylor", "run-2": "taylor" });

  assert.equal(runningMessageForParticipant(conversation, "taylor")?.id, "turn");
});

test("when only the queued turn is loaded, the running one is not guessed", () => {
  const conversation = chat([
    memberMessage("queued", 3, { status: "pending", runId: "run-2", queued: true })
  ], { "run-1": "taylor", "run-2": "taylor" });

  assert.equal(runningMessageForParticipant(conversation, "taylor"), undefined);
});

test("another member's turn and a member that is not running give nothing", () => {
  const conversation = chat([
    memberMessage("drew-turn", 1, { participant: drew, status: "pending", runId: "run-d" }),
    memberMessage("taylor-old", 2, { runId: "run-old" })
  ], { "run-d": "drew" });

  assert.equal(runningMessageForParticipant(conversation, "taylor"), undefined);
  assert.equal(runningMessageForParticipant(conversation, "drew")?.id, "drew-turn");
});

test("a finished turn is not the turn in progress", () => {
  const conversation = chat([
    memberMessage("ended", 1, { status: "done", runId: "run-1" })
  ]);

  assert.equal(runningMessageForParticipant(conversation, "taylor"), undefined);
});

test("a turn known only by its pending message (run on another device) is in progress", () => {
  // Run bookkeeping stays on the device that runs the turn; here there is
  // only the turn's message, as the roster sees it.
  const conversation = chat([
    memberMessage("remote-turn", 1, { status: "pending", runId: "run-remote" }),
    memberMessage("post", 2, { runId: "run-remote" })
  ]);

  assert.equal(runningMessageForParticipant(conversation, "taylor")?.id, "remote-turn");
});

test("an unknown start time never claims first; the same time keeps the turn found first", () => {
  const conversation = chat([
    { ...memberMessage("unknown", 1, { status: "pending", runId: "run-3" }), createdAt: "" },
    { ...memberMessage("first", 1, { status: "pending", runId: "run-1" }), createdAt: at(5) },
    { ...memberMessage("same-time", 1, { status: "pending", runId: "run-2" }), createdAt: at(5) }
  ], { "run-1": "taylor", "run-2": "taylor", "run-3": "taylor" });

  assert.equal(runningMessageForParticipant(conversation, "taylor")?.id, "first");
});

test("without the local queued mark, the turn started first is the one in progress", () => {
  // A chat read from the User's server carries no queued mark.
  const conversation = chat([
    memberMessage("running", 1, { status: "pending", runId: "run-1" }),
    memberMessage("post", 2, { runId: "run-1" }),
    memberMessage("waiting", 3, { status: "pending", runId: "run-2" })
  ], { "run-1": "taylor", "run-2": "taylor" });

  assert.equal(runningMessageForParticipant(conversation, "taylor")?.id, "running");
});

test("a turn in a thread opens in that thread; one in the timeline opens inline", () => {
  const threaded = memberMessage("turn", 1, { status: "pending", runId: "run-1", threadRootId: "root" });
  assert.deepEqual(runningMessageTarget(threaded), { messageId: "turn", threadRootId: "root" });
  const inline = memberMessage("turn", 1, { status: "pending", runId: "run-1" });
  assert.deepEqual(runningMessageTarget(inline), { messageId: "turn" });
});

test("storage finds the turn in progress far above the latest page, skipping posts and the queued turn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-running-message-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.sqliteExecutable = resolveSqliteExecutable({ appPath: process.cwd() });
  storage.initialized = true;
  const filler: ChatMessage[] = Array.from({ length: 120 }, (_, index) => ({
    id: `filler-${index}`,
    role: "user" as const,
    content: `filler "${index}" \\ 🙂`,
    createdAt: new Date(Date.UTC(2026, 9, 31, 20, 1, 0, index)).toISOString()
  }));
  // Earlier pending rows of the same run that the timeline hides: a hidden
  // one with long multi-byte text, and a "waiting for approval" status.
  const hidden = { ...memberMessage("hidden", 0, { status: "pending", runId: "run-1", content: "🙂 скрыто ".repeat(80) }) };
  hidden.metadata = { ...hidden.metadata, hiddenFromTimeline: true };
  const waiting = memberMessage("waiting-status", 0, { status: "pending", runId: "run-1", content: "Participant request is awaiting User approval." });
  const conversation = chat([
    hidden,
    waiting,
    memberMessage("turn", 1, { status: "pending", runId: "run-1", threadRootId: "root" }),
    memberMessage("drew-turn", 2, { participant: drew, status: "pending", runId: "run-d" }),
    ...filler,
    memberMessage("post", 59, { runId: "run-1" }),
    { ...memberMessage("queued", 59, { status: "pending", runId: "run-2", queued: true }), createdAt: at(59) }
  ], { "run-1": "taylor", "run-2": "taylor", "run-d": "drew" });

  try {
    await storage.runSql(`
      create table conversations (
        id text primary key, title text not null, kind text not null, created_at text not null,
        updated_at text not null, repo_path text, body_json text, save_token text, payload_json text not null
      );
      create table conversation_messages (
        conversation_id text not null, sequence integer not null, message_id text not null,
        created_at text not null, payload_json text not null,
        primary key (conversation_id, sequence), unique (conversation_id, message_id)
      );
    `);
    await storage.saveConversation(conversation);

    const latestPage = await storage.listConversationMessages({ conversationId: "chat", limit: 80 });
    assert.equal(latestPage.messages.some((message: ChatMessage) => message.id === "turn"), false);

    assert.deepEqual(
      await storage.findRunningParticipantMessage("chat", "taylor"),
      { messageId: "turn", threadRootId: "root" }
    );
    assert.deepEqual(await storage.findRunningParticipantMessage("chat", "drew"), { messageId: "drew-turn" });
    assert.equal(await storage.findRunningParticipantMessage("chat", "nobody"), undefined);
    assert.equal(await storage.findRunningParticipantMessage("missing-chat", "taylor"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the server reads only the turns in progress it has open, from the message each one answers on", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-pending-turns-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.sqliteExecutable = resolveSqliteExecutable({ appPath: process.cwd() });
  storage.initialized = true;
  const ask = { id: "ask", role: "user" as const, content: "@taylor go", createdAt: at(10) };
  const turn = { ...memberMessage("turn", 11, { status: "pending", runId: "run-1" }), metadata: { runId: "run-1", sourceMessageId: "ask", parentMessageId: "ask" } };
  // Dead long ago, answering nothing open; and a running message of a member
  // whose turn the server does not hold open.
  const dead = { ...memberMessage("dead", 1, { participant: drew, status: "pending", runId: "dead-run" }), metadata: { runId: "dead-run", sourceMessageId: "gone" } };
  const other = { ...memberMessage("other", 12, { participant: drew, status: "pending", runId: "run-d" }), metadata: { runId: "run-d", sourceMessageId: "ask" } };
  const conversation = chat([dead, ask as ChatMessage, turn, other, memberMessage("post", 13, { runId: "run-1" })]);
  try {
    await storage.runSql(`
      create table conversations (
        id text primary key, title text not null, kind text not null, created_at text not null,
        updated_at text not null, repo_path text, body_json text, save_token text, payload_json text not null
      );
      create table conversation_messages (
        conversation_id text not null, sequence integer not null, message_id text not null,
        created_at text not null, payload_json text not null,
        primary key (conversation_id, sequence), unique (conversation_id, message_id)
      );
    `);
    await storage.saveConversation(conversation);
    const found = await storage.listPendingTurnMessages("chat", [{ messageId: "ask", participantId: "taylor" }]);
    assert.deepEqual(found.map((message: ChatMessage) => message.id), ["turn"]);
    assert.deepEqual(await storage.listPendingTurnMessages("chat", []), []);
    assert.deepEqual(await storage.listPendingTurnMessages("chat", [{ messageId: "missing", participantId: "taylor" }]), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
