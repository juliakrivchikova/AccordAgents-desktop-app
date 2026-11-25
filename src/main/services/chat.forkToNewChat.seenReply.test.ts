import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
import {
  forkCutFor, forkSeenReplyOf, forkToNewChatSupportFromHello, isMemberTurnEnd, lastMemberTurnEnd, memberHasForkableSession,
  memberReplyFinishedAt
} from "../../shared/forkToNewChat";
import type { AgentHealth, ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import {
  ASSISTANT, chatWithLaterWork, forkAndSend, NOW, oldChat, participantsOf, REPLY_FINISHED, REVIEWER, sessionRecord, testService,
  waitFor
} from "./chat/test/forkFixtures";

test("a fork to a new chat is refused, with its reason, for Antigravity, a member that never ran, one waiting for a machine, an outdated or unseen machine, and a CLI not ready here", async () => {
  const cases: Array<[string, ChatParticipant, Record<string, unknown>, RegExp, { agents?: AgentHealth[]; support?: "supported" | "outdated" | "unknown" }?]> = [
    ["Antigravity", { ...REVIEWER, kind: "gemini-cli" }, {}, /Antigravity has no session fork/],
    ["never ran", REVIEWER, { participantSessions: [] }, /has not run yet/],
    ["fork not made yet", REVIEWER, { participantSessions: [{ ...sessionRecord(REVIEWER, ""), forkFrom: { participantId: "x", sessionId: "s", kind: "claude-code" } }] }, /has not run yet/],
    ["waiting for a machine", { ...REVIEWER, cloudRun: { instanceId: "i-1" } as never }, {}, /no machine to run on yet/],
    ["outdated machine", { ...REVIEWER, homeMachineId: "m-1" }, { lastMessageByParticipant: { [REVIEWER.id]: { messageId: "old-reply", sequence: 1 } } }, /older program/, { support: "outdated" }],
    ["unseen machine", { ...REVIEWER, homeMachineId: "m-1" }, { lastMessageByParticipant: { [REVIEWER.id]: { messageId: "old-reply", sequence: 1 } } }, /has not connected/, { support: "unknown" }],
    ["CLI not ready", REVIEWER, {}, /Claude Code/, { agents: [{ kind: "claude-code", label: "Claude Code", installed: false }, { kind: "codex-cli", label: "Codex CLI", installed: true }] }]
  ];
  for (const [label, member, metadata, reason, extra] of cases) {
    const source = oldChat([ASSISTANT, member], metadata);
    const { service, storage } = testService({ conversations: [source], agents: extra?.agents });
    if (extra?.support) service.setMachineForkToNewChatSupport(() => extra.support!);
    await assert.rejects(
      service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: member.id } }),
      (error: Error) => {
        assert.match(error.message, /^@reviewer cannot be forked to a new chat: /, label);
        assert.match(error.message, reason, label);
        return true;
      },
      label
    );
    assert.equal(storage.store.size, 1, `${label}: no chat made`);
  }
});

test("a member ran when it has a finished reply (an error too), never by a reply still being written or a placeholder shown for a turn elsewhere", () => {
  const boxed = { ...REVIEWER, homeMachineId: "m-1" };
  const reply = (status: ChatMessage["status"], metadata?: Record<string, unknown>) =>
    [{ id: "r", role: "participant", participantId: boxed.id, status, ...(metadata ? { metadata } : {}) }];
  const pointer = { lastMessageByParticipant: { [boxed.id]: { messageId: "r", sequence: 1 } } };
  assert.equal(memberHasForkableSession(pointer, boxed, reply("pending")), false, "its first turn still running");
  assert.equal(memberHasForkableSession(pointer, boxed, reply("done", { serverPlaceholder: true })), false, "the bubble shown while its machine has the turn");
  assert.equal(memberHasForkableSession(pointer, boxed, reply("error")), true, "its CLI ran");
  assert.equal(memberHasForkableSession(pointer, boxed, []), true, "its last reply is older than the messages held");
  assert.equal(memberHasForkableSession({}, boxed, []), false);
  // A session moved here and not taken yet is a session to copy.
  const moved = { ...REVIEWER, sessionHandoff: { provider: "claude-code" as const, sessionId: "s", blob: { blobHash: "b" } as never, at: NOW } };
  assert.equal(memberHasForkableSession({ participantSessions: [] }, moved), true);
  assert.equal(forkToNewChatSupportFromHello(undefined), "unknown");
  assert.equal(forkToNewChatSupportFromHello({}), "outdated");
  assert.equal(forkToNewChatSupportFromHello({ forkToNewChatSupported: true }), "supported");
});

test("the copy ends with the reply the User saw when she tapped Fork: what the member did after, and a turn still running, are not in it", async () => {
  const cut = { sessionId: "src-cli-session", at: "assistant-uuid-1" };
  const source = chatWithLaterWork({ sessionCut: cut });
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      runOptions.onSessionId?.("fork-own-session");
      return { participant, ok: true, content: "On it.", durationMs: 1, sessionId: "fork-own-session", sessionCut: "fork-assistant-1" };
    }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  const [main] = participantsOf(storage.store.get(id));
  assert.deepEqual(main!.forkOrigin?.seen, { messageId: "old-reply", sessionCut: cut, finishedAt: REPLY_FINISHED },
    "not the post nor the reply still being written");
  assert.equal(runs[0]!.options.forkFromSessionId, "src-cli-session");
  assert.deepEqual(runs[0]!.options.forkCut, { at: "assistant-uuid-1" }, "at the point that reply recorded");
  const reply = storage.store.get(id)!.messages.find((message) => message.participantId === mainId && message.role === "participant")!;
  assert.deepEqual(reply.metadata?.sessionCut, { sessionId: "fork-own-session", at: "fork-assistant-1" }, "its own reply records where its copy stands");
  assert.deepEqual(storage.store.get(id)!.metadata.warnings ?? [], [], "nothing to say: the copy is what she saw");
  assert.equal(storage.store.get(id)!.messages.some((message) => message.id.startsWith("fork-notice-")), false);
  assert.equal(storage.store.get(id)!.messages.some((message) => /may include what/.test(message.content)), false);
});

test("when the member's session changed after the reply she saw, the session that reply was in is copied up to it", async () => {
  const { service, storage, runs } = testService({ conversations: [chatWithLaterWork({ sessionCut: { sessionId: "older-session", at: "assistant-uuid-1" } })] });
  await forkAndSend(service, storage);
  assert.equal(runs[0]!.options.forkFromSessionId, "src-cli-session", "the member's session, as the fallback");
  assert.deepEqual(runs[0]!.options.forkCut, { at: "assistant-uuid-1", sessionId: "older-session" });
});

test("a reply that ends a turn records where its CLI session stood; one whose CLI did not say records nothing", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  let turn = 0;
  const { service, storage } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      turn += 1;
      runOptions.onSessionId?.("fork-own-session");
      return { participant, ok: true, content: `Turn ${turn}.`, durationMs: 1, sessionId: "fork-own-session", ...(turn === 1 ? { sessionCut: "turn-1-cut" } : {}) };
    }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  await service.sendMessage({ conversationId: id, runId: "run-two", content: "Again.", targetParticipantIds: [mainId] });
  await waitFor(() => (storage.store.get(id)?.messages ?? []).filter((message) => message.participantId === mainId && message.status === "done").length === 2);
  const replies = storage.store.get(id)!.messages.filter((message) => message.participantId === mainId);
  assert.deepEqual(replies.map((message) => message.metadata?.sessionCut ?? null), [{ sessionId: "fork-own-session", at: "turn-1-cut" }, null]);
  assert.ok(replies.every((message) => typeof message.metadata?.workedMs === "number"));
});

test("the reply the User saw: a finished reply that ended a turn, its point or its finish, and where the copy ends from it", () => {
  const reply = (patch: Partial<ChatMessage>): ChatMessage => ({ id: "r", role: "participant", participantId: REVIEWER.id, content: "x", createdAt: NOW, status: "done", ...patch });
  assert.equal(isMemberTurnEnd(reply({ metadata: { workedMs: 5 } }), REVIEWER.id), true);
  assert.equal(isMemberTurnEnd(reply({ status: "error", metadata: { workedMs: 5 } }), REVIEWER.id), true, "a turn that failed ended too");
  assert.equal(isMemberTurnEnd(reply({ metadata: { sessionCut: { sessionId: "s", at: "a" } } }), REVIEWER.id), true);
  assert.equal(isMemberTurnEnd(reply({}), REVIEWER.id), false, "a post, a request or an Accord launch written during a turn");
  assert.equal(isMemberTurnEnd(reply({ status: "pending", metadata: { workedMs: 5 } }), REVIEWER.id), false);
  assert.equal(isMemberTurnEnd(reply({ metadata: { workedMs: 5, serverPlaceholder: true } }), REVIEWER.id), false);
  assert.equal(isMemberTurnEnd(reply({ metadata: { workedMs: 5 } }), ASSISTANT.id), false);
  // Its finish counts from its own turn's start when it waited behind another.
  assert.equal(memberReplyFinishedAt(reply({ metadata: { workedMs: 1_000, turnStartedAt: "2026-11-21T12:01:00.000Z" } })), "2026-11-21T12:01:01.000Z");
  assert.equal(memberReplyFinishedAt(reply({ metadata: { workedMs: 1_000 } })), "2026-11-21T12:00:01.000Z");
  assert.deepEqual(forkSeenReplyOf(reply({ metadata: { workedMs: 1_000, sessionCut: { sessionId: "s", at: "a", extra: 1 } as never } })),
    { messageId: "r", sessionCut: { sessionId: "s", at: "a" }, finishedAt: "2026-11-21T12:00:01.000Z" });
  assert.deepEqual(forkCutFor({ messageId: "r", sessionCut: { sessionId: "s", at: "a" }, finishedAt: REPLY_FINISHED }, "s"), { at: "a" });
  assert.deepEqual(forkCutFor({ messageId: "r", sessionCut: { sessionId: "old", at: "a" }, finishedAt: REPLY_FINISHED }, "s"), { at: "a", sessionId: "old" },
    "the session the reply was in, when the member's changed after it");
  assert.deepEqual(forkCutFor({ messageId: "r", finishedAt: REPLY_FINISHED }, "s"), { finishedBy: REPLY_FINISHED });
  assert.deepEqual(forkCutFor({ messageId: "r" }, "s"), { unknown: "its last reply does not say where it ended in its session" });
  assert.deepEqual(forkCutFor(undefined, "s"), { unknown: "the app found no reply of it that ended a turn" });
});

test("her server and the computer read the reply the User saw by the same rule", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-fork-seen-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    const variants: Array<[string, Conversation]> = [
      ["a recorded point, then a post and a running reply", chatWithLaterWork({ sessionCut: { sessionId: "src-cli-session", at: "assistant-uuid-1" } })],
      ["an older reply, by its finish", chatWithLaterWork({ turnStartedAt: "2026-11-21T12:00:10.000Z" })],
      ["a placeholder for a turn elsewhere is not it", (() => {
        const chat = chatWithLaterWork({});
        chat.messages.push({ id: "placeholder", role: "participant", participantId: REVIEWER.id, content: "", createdAt: NOW, status: "done", metadata: { workedMs: 1, serverPlaceholder: true } });
        return chat;
      })()],
      ["no reply that ended a turn", (() => {
        const chat = oldChat([ASSISTANT, REVIEWER]);
        chat.messages = [chat.messages[0]!, { ...chat.messages[1]!, metadata: undefined }];
        return chat;
      })()]
    ];
    for (const [label, chat] of variants) {
      await storage.saveConversation({ ...chat, id: `chat-${label}` });
      assert.deepEqual(await storage.conversationLastTurnEnd(`chat-${label}`, REVIEWER.id), lastMemberTurnEnd(chat.messages, REVIEWER.id), label);
    }
    assert.deepEqual(await storage.conversationLastTurnEnd("chat-an older reply, by its finish", REVIEWER.id), { messageId: "old-reply", finishedAt: "2026-11-21T12:00:40.000Z" });
    assert.equal(await storage.conversationLastTurnEnd("chat-no reply that ended a turn", REVIEWER.id), undefined);
    assert.equal(await storage.conversationLastTurnEnd("no-such-chat", REVIEWER.id), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
