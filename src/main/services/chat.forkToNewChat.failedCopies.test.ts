import assert from "node:assert/strict";
import test from "node:test";
import { ChatService } from "./chat";
import { chatParts } from "./chat/test/chatParts";
import { forkCopyFailed } from "./chat/sessions/forkNotes";
import { forkToNewChatReasonFromOffer, forkToNewChatReasonInChat } from "../../shared/forkToNewChat";
import type { ChatMessage, ChatParticipant, ChatParticipantSession, Conversation } from "../../shared/types";
import {
  assertLineOnce, ASSISTANT, chatWithLaterWork, forkAndSend, linesOf, MAIN_ROLE, NOW, oldChat, participantsOf, permissions,
  READY_AGENTS, REPLY_FINISHED, REVIEWER, sessionRecord, sessionsOf, testService, waitFor
} from "./chat/test/forkFixtures";

/** The chat as a cloud machine's runtime has it, its main session homed on
 *  that machine, and its turn run there as the server asks it
 *  (startServerTurn → runParticipantBatch). */
async function runOnMachine(service: ChatService, storage: { store: Map<string, Conversation> }, id: string, mainId: string, content: string, runId = `run-${content}`) {
  const stored = storage.store.get(id)!;
  const message: ChatMessage = { id: `user-${runId}`, role: "user", content, createdAt: new Date().toISOString(), status: "done" };
  stored.messages.push(message);
  storage.store.set(id, stored);
  const chat = await chatParts(service).store.requireChat(id) as Conversation;
  const participant = participantsOf(chat).find((item) => item.id === mainId)!;
  const warnings: string[] = [];
  await chatParts(service).participantBatch.runParticipantBatch(chat, [participant], message, runId, undefined, undefined, warnings, { targetRunIds: new Map([[participant.id, runId]]) });
  return warnings;
}

/** A chat made by Fork to new chat on the computer, as a machine reads it
 *  from the server: its main session runs on machine m-1. */
function forkedOnMachine(source: Conversation, sourceMember: ChatParticipant): Conversation {
  return {
    id: "new-chat",
    title: "Old chat (fork)",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/projects/app",
    messages: [],
    findings: [],
    metadata: {
      participants: [{ id: "main-id", handle: "main", roleConfigId: MAIN_ROLE.id, kind: sourceMember.kind, homeMachineId: "m-1", agentMode: "default", permissions: permissions(),
        forkOrigin: { conversationId: source.id, participantId: sourceMember.id, handle: sourceMember.handle, conversationTitle: source.title, kind: sourceMember.kind,
          seen: { messageId: "old-reply", finishedAt: REPLY_FINISHED } } }],
      participantSessions: [],
      mainSessionParticipantId: "main-id"
    }
  } as Conversation;
}

/** The fork notices a service says (postForkNotice), as it says them. */
function spyForkNotices(service: ChatService): string[] {
  const said: string[] = [];
  const post = chatParts(service).forks.postForkNotice.bind(chatParts(service).forks);
  chatParts(service).forks.postForkNotice = (conversation: Conversation, participant: ChatParticipant, kind: string, text: string) => {
    said.push(text);
    return post(conversation, participant, kind, text);
  };
  return said;
}

function asMachine(service: ChatService): ChatService {
  chatParts(service).host.machineRuntime = true;
  chatParts(service).host.hostMachineId = "m-1";
  return service;
}

const NOT_ON_COMPUTER = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\": that session is not on your computer, so it starts a clean session.";

test("when the member's session is not on this computer any more, the main session starts clean and a line in the chat says so before its turn runs", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  let id = "";
  let linesWhileRunning = -1;
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      // Said before the turn ends: it may last hours, and the app may stop during it.
      await waitFor(() => linesOf(storage.store.get(id), NOT_ON_COMPUTER).length === 1);
      linesWhileRunning = 1;
      runOptions.onSessionId?.("clean-session");
      return { participant, ok: true, content: "Hello.", durationMs: 1, sessionId: "clean-session" };
    }
  });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: REVIEWER.id } });
  id = created.conversation.id;
  storage.store.delete(source.id);
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  await service.sendMessage({ conversationId: id, runId: "run-gone", content: "Hello.", targetParticipantIds: [mainId] });
  await waitFor(() => (storage.store.get(id)?.messages ?? []).some((message) => message.participantId === mainId && message.status === "done"));
  assert.equal(runs[0]!.options.forkFromSessionId, undefined);
  assert.equal(linesWhileRunning, 1, "in the chat while the turn ran");
  await assertLineOnce(storage, id, NOT_ON_COMPUTER, NOT_ON_COMPUTER, [service]);
  assert.deepEqual(storage.store.get(id)!.metadata.warnings ?? [], [NOT_ON_COMPUTER], "nothing else");
  // Its later turns say nothing more.
  await service.sendMessage({ conversationId: id, runId: "run-next", content: "Next.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2);
  await assertLineOnce(storage, id, NOT_ON_COMPUTER, "after a later turn", [service]);
});

test("a first turn cut short by a quit, run again after the restart, says its line once", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  let release!: () => void;
  const { service, storage, runs, restart } = testService({
    conversations: [source],
    // The app quits during the first turn: it never ends, nor gets a session id.
    run: () => new Promise((resolve) => { release = () => resolve({ ok: false, content: "", error: "Chat run cancelled.", durationMs: 1 }); })
  });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: REVIEWER.id } });
  const id = created.conversation.id;
  storage.store.delete(source.id);
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  await service.sendMessage({ conversationId: id, runId: "run-first", content: "Hello.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 1 && linesOf(storage.store.get(id), NOT_ON_COMPUTER).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // After the restart its reply is no reply yet (cut short), and the turn runs again.
  const stored = storage.store.get(id)!;
  stored.messages = stored.messages.filter((message) => message.participantId !== mainId);
  storage.store.set(id, stored);
  const again = restart(async (participant, _prompt, runOptions) => {
    runOptions.onSessionId?.("clean-session");
    return { participant, ok: true, content: "Hello.", durationMs: 1, sessionId: "clean-session" };
  });
  const said = spyForkNotices(again);
  await again.sendMessage({ conversationId: id, runId: "run-again", content: "Hello again.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2);
  await waitFor(() => (storage.store.get(id)?.messages ?? []).some((message) => message.participantId === mainId && message.status === "done"));
  assert.deepEqual(said, [NOT_ON_COMPUTER], "the turn run again says it again");
  await assertLineOnce(storage, id, NOT_ON_COMPUTER, "after the restart", [again]);
  release();
});

test("on a cloud machine: the member's session not there, the line names the machine and goes in the chat; once when the server hands the turn over again after the machine stopped mid-turn", async () => {
  const source = oldChat([ASSISTANT, { ...REVIEWER, homeMachineId: "m-1" }]);
  const forked = forkedOnMachine(source, REVIEWER);
  let release!: () => void;
  const { service, storage, runs, restart } = testService({
    conversations: [forked],
    // The machine stops during the first turn: it never ends, nor gets a session id.
    run: () => new Promise((resolve) => { release = () => resolve({ ok: false, content: "", error: "Chat run cancelled.", durationMs: 1 }); })
  });
  asMachine(service);
  const text = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\": that session is not on the cloud machine @main runs on, so it starts a clean session.";
  void runOnMachine(service, storage, forked.id, "main-id", "Hello.");
  await waitFor(() => runs.length === 1 && linesOf(storage.store.get(forked.id), text).length === 1);
  assert.equal(runs[0]!.options.forkFromSessionId, undefined);
  await service.settleChatSaves();
  assert.equal(sessionsOf(storage.store.get(forked.id)).length, 0, "no session record was written before it stopped");
  // The server hands the turn over again after the machine restarted (its reply never written).
  const stored = storage.store.get(forked.id)!;
  stored.messages = stored.messages.filter((message) => message.participantId !== "main-id");
  storage.store.set(forked.id, stored);
  const again = asMachine(restart(async (participant, _prompt, runOptions) => {
    runOptions.onSessionId?.("clean-session");
    return { participant, ok: true, content: "Hello.", durationMs: 1, sessionId: "clean-session" };
  }));
  const said = spyForkNotices(again);
  const warnings = await runOnMachine(again, storage, forked.id, "main-id", "Hello.", "run-Hello.-redelivered");
  assert.equal(runs.length, 2);
  assert.deepEqual(said, [text], "the turn handed over again says it again");
  assert.equal(warnings.includes(text), false, "not left for the turn's own warnings");
  await assertLineOnce(storage, forked.id, text, "redelivered", [again]);
  release();
});

test("a fork the CLI cannot make because its source session is gone starts clean in the same turn: her first message gets its reply, and the chat says so once", async () => {
  for (const [kind, error] of [
    ["codex-cli", "no rollout found for thread id src-cli-session"],
    // Claude Code's live process exits before it takes the message.
    ["claude-code", "claude warm process exited with code 1: No conversation found with session ID: src-cli-session"]
  ] as const) {
    const member: ChatParticipant = { ...REVIEWER, kind, ...(kind === "codex-cli" ? { model: undefined, reasoningEffort: undefined } : {}) };
    const source = oldChat([ASSISTANT, member], { participantSessions: [sessionRecord(member, "src-cli-session")] });
    const { service, storage, runs } = testService({
      conversations: [source],
      run: async (participant, _prompt, runOptions) => {
        if (runOptions.forkFromSessionId) return { participant, ok: false, content: `${participant.label} stopped before it returned a response.`, error, durationMs: 1, forkCopyFailed: true };
        if (runOptions.sessionId) return { participant, ok: true, content: "Resumed.", durationMs: 1, sessionId: runOptions.sessionId };
        runOptions.onSessionId?.("clean-session");
        return { participant, ok: true, content: "Clean.", durationMs: 1, sessionId: "clean-session" };
      }
    });
    const { id, mainId } = await forkAndSend(service, storage);
    await waitFor(() => runs.length === 2);
    assert.equal(runs[0]!.options.forkFromSessionId, "src-cli-session", `${kind}: the copy was tried`);
    // The CLI said the source is gone: no second try, a clean session at once.
    assert.equal(runs[1]!.options.forkFromSessionId, undefined, kind);
    assert.equal(runs[1]!.options.sessionId, undefined, kind);
    assert.equal(runs[1]!.options.forkCut, undefined, kind);
    assert.match(runs[1]!.prompt, /^<<<APP [0-9a-f]{8}>>>\nYou were to start from a copy of @reviewer's session in the chat "Old chat", but it could not be copied/, `${kind}: told who it is`);
    assert.match(runs[1]!.prompt, /You are the main session\./, `${kind}: with its role's instructions`);
    const replies = () => storage.store.get(id)!.messages.filter((message) => message.participantId === mainId && message.role === "participant");
    await waitFor(() => replies().every((message) => message.status !== "pending"));
    assert.deepEqual(replies().map((message) => [message.status, message.content]), [["done", "Clean."]], `${kind}: her first message got its reply`);
    const session = () => sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId);
    await waitFor(() => session()?.sessionId === "clean-session");
    assert.equal(session()!.forkFrom, undefined, kind);
    assert.equal(session()!.forkedFromParticipantId, undefined, kind);
    const notice = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so this turn started a clean session.";
    await assertLineOnce(storage, id, notice, kind, [service]);
    assert.deepEqual(storage.store.get(id)!.metadata.warnings ?? [], [notice], `${kind}: nothing else said, not the failed copy's own error`);
    // The User asked it, and reads the line: its reply does not say it twice.
    assert.equal(replies().some((message) => message.content.includes("could not start from a copy")), false, kind);
    await service.sendMessage({ conversationId: id, runId: `run-next-${kind}`, content: "And now?", targetParticipantIds: [mainId] });
    await waitFor(() => runs.length === 3);
    assert.equal(runs[2]!.options.sessionId, "clean-session", `${kind}: its own session from now on`);
    assert.equal(runs[2]!.options.forkFromSessionId, undefined, kind);
    await assertLineOnce(storage, id, notice, `${kind}: after its next turn`, [service]);
  }
});

test("a copy that failed for another reason is tried once more in the same turn, then the turn starts clean; a retry that makes it is the copy", async () => {
  const cases = [
    ["the retry fails too", (attempt: number) => attempt <= 2 ? "fail" : "clean"],
    ["the retry makes the copy", (attempt: number) => attempt === 1 ? "fail" : "copy"]
  ] as const;
  for (const [label, outcome] of cases) {
    const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
    const source = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
    const { service, storage, runs } = testService({
      conversations: [source],
      run: async (participant, _prompt, runOptions) => {
        const what = outcome(runs.length);
        if (what === "fail") {
          assert.ok(runOptions.forkFromSessionId, `${label}: only a copy fails`);
          return { participant, ok: false, content: "", error: "codex app-server did not return a thread id for the fork", durationMs: 1, forkCopyFailed: true };
        }
        const sessionId = what === "copy" ? "copy-session" : "clean-session";
        runOptions.onSessionId?.(sessionId);
        return { participant, ok: true, content: what === "copy" ? "Copied." : "Clean.", durationMs: 1, sessionId };
      }
    });
    const { id, mainId } = await forkAndSend(service, storage);
    const replies = () => storage.store.get(id)!.messages.filter((message) => message.participantId === mainId && message.role === "participant");
    await waitFor(() => replies().every((message) => message.status !== "pending"));
    await service.settleChatSaves();
    const notice = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so this turn started a clean session.";
    if (outcome(2) === "fail") {
      assert.deepEqual(runs.map((run) => run.options.forkFromSessionId ?? null), ["src-cli-session", "src-cli-session", null], `${label}: once more, then clean`);
      assert.deepEqual(runs[1]!.options.forkCut, runs[0]!.options.forkCut, `${label}: the retry ends where the first try was to`);
      assert.deepEqual(replies().map((message) => [message.status, message.content]), [["done", "Clean."]], label);
      await assertLineOnce(storage, id, notice, label, [service]);
    } else {
      assert.deepEqual(runs.map((run) => run.options.forkFromSessionId ?? null), ["src-cli-session", "src-cli-session"], label);
      assert.deepEqual(replies().map((message) => [message.status, message.content]), [["done", "Copied."]], label);
      const session = sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId)!;
      assert.equal(session.sessionId, "copy-session", label);
      assert.equal(session.forkedFromParticipantId, REVIEWER.id, `${label}: still the copy`);
      assert.equal(storage.store.get(id)!.messages.some((message) => message.id.startsWith("fork-notice-")), false, `${label}: nothing to say`);
    }
  }
});

test("the clean start is said before it runs when the source is gone; a clean start that cannot start either leaves no session id to resume", async () => {
  const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
  const source = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
  const notice = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so this turn started a clean session.";
  let id = "";
  let lineWhileClean = -1;
  let said: string[] = [];
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      if (runOptions.forkFromSessionId) return { participant, ok: false, content: "", error: "no rollout found for thread id src-cli-session", durationMs: 1, forkCopyFailed: true };
      // The clean session is given an id and reported before the CLI exits without taking the message.
      lineWhileClean = said.filter((text) => text === notice).length;
      runOptions.onSessionId?.("never-written");
      return { participant, ok: false, content: "@main stopped before it returned a response.", error: "claude warm process exited with code 1", durationMs: 1, sessionNotStarted: true };
    }
  });
  said = spyForkNotices(service);
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: "old-chat", participantId: REVIEWER.id } });
  id = created.conversation.id;
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  await service.sendMessage({ conversationId: id, runId: "run-gone", content: "Go on.", targetParticipantIds: [mainId] });
  await waitFor(() => (storage.store.get(id)?.messages ?? []).some((message) => message.participantId === mainId && message.status !== "pending"));
  await service.settleChatSaves();
  assert.ok(lineWhileClean >= 1, "said before the clean turn ran");
  await assertLineOnce(storage, id, notice, "once", [service]);
  const session = sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId)!;
  assert.equal(session.sessionId, "", "the id the clean session was given is no session: not resumed next");
  assert.equal(session.forkFrom, undefined, "its source is gone: it stays clean");
  assert.equal(runs.length, 2);
});

test("when the clean start cannot start either, the copy was not what failed: the member stays a fork and nothing says it started clean", async () => {
  const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
  const source = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      runOptions.onSessionId?.(runOptions.forkFromSessionId ? "copy-never-written" : "clean-never-written");
      return { participant, ok: false, content: "@main stopped before it returned a response.", error: "error: unknown option '--some-flag'", durationMs: 1,
        sessionNotStarted: true, ...(runOptions.forkFromSessionId ? { forkCopyFailed: true } : {}) };
    }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  await service.settleChatSaves();
  assert.deepEqual(runs.map((run) => run.options.forkFromSessionId ?? null), ["src-cli-session", "src-cli-session", null], "tried, tried again, then a clean start that could not start");
  const session = sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId)!;
  assert.equal(session.sessionId, "");
  assert.equal(session.forkFrom?.sessionId, "src-cli-session", "its next turn makes the copy");
  assert.equal(session.forkedFromParticipantId, REVIEWER.id);
  assert.equal(storage.store.get(id)!.messages.some((message) => message.id.startsWith("fork-notice-")), false, "nothing says it started clean");
  const reply = storage.store.get(id)!.messages.find((message) => message.participantId === mainId && message.role === "participant")!;
  assert.equal(reply.status, "error");
  assert.ok(((storage.store.get(id)!.metadata.warnings ?? []) as string[]).some((warning) => /unknown option/.test(warning)), "the real error is said");
});

test("a clean start that reported no session at all did not start either; a retry that says the source is gone keeps the member clean", async () => {
  const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
  const source = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
  for (const [label, retryError] of [
    ["thread/start failed after an unknown copy failure", "failed to read rollout: unexpected end of file"],
    ["the retry says the source is gone", "no rollout found for thread id src-cli-session"]
  ] as const) {
    const { service, storage, runs } = testService({
      conversations: [source],
      run: async (participant, _prompt, runOptions) => {
        // A CLI run takes time: the session's record at the turn's end is
        // newer than the one the fork saved (a same-millisecond tie merges
        // the stored record's copy source back in, which no real turn does).
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (runOptions.forkFromSessionId) {
          const error = runs.length === 1 ? "failed to read rollout: unexpected end of file" : retryError;
          return { participant, ok: false, content: "", error, durationMs: 1, forkCopyFailed: true };
        }
        // Codex could not start a thread: nothing reported a session.
        return { participant, ok: false, content: "Codex failed before it returned a response.", error: "thread/start failed: invalid config", durationMs: 1 };
      }
    });
    const { id, mainId } = await forkAndSend(service, storage);
    await service.settleChatSaves();
    assert.equal(runs.length, 3, label);
    const session = sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId)!;
    const notices = storage.store.get(id)!.messages.filter((message) => message.id.startsWith("fork-notice-")).map((message) => message.content);
    if (retryError.startsWith("no rollout")) {
      assert.equal(session.forkFrom, undefined, `${label}: its source is gone, it stays clean`);
      assert.deepEqual(notices, ["@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so this turn started a clean session."], label);
    } else {
      assert.equal(session.forkFrom?.sessionId, "src-cli-session", `${label}: still a fork`);
      assert.deepEqual(notices, [], label);
    }
  }
});

test("two messages sent at once: when the other one made the member's session meanwhile, this one goes into it, never a second clean session", async () => {
  const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
  const source = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
  let turnSession: ChatParticipantSession | undefined;
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      if (runOptions.forkFromSessionId && !runOptions.sessionId) {
        // The other message's turn made the member's session while this copy failed.
        turnSession!.sessionId = "other-turn-session";
        delete turnSession!.forkFrom;
        return { participant, ok: false, content: "", error: "no rollout found for thread id src-cli-session", durationMs: 1, forkCopyFailed: true };
      }
      return { participant, ok: true, content: "Into the same session.", durationMs: 1, sessionId: runOptions.sessionId };
    }
  });
  const sessionFor = chatParts(service).memberSessions.sessionForParticipant.bind(chatParts(service).memberSessions);
  chatParts(service).memberSessions.sessionForParticipant = async (...args: unknown[]) => {
    const state = await sessionFor(...args);
    turnSession = state.session;
    return state;
  };
  const { id, mainId } = await forkAndSend(service, storage);
  await service.settleChatSaves();
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.options.sessionId, "other-turn-session", "resumes the session the other turn made");
  const reply = storage.store.get(id)!.messages.find((message) => message.participantId === mainId && message.role === "participant")!;
  assert.deepEqual([reply.status, reply.content], ["done", "Into the same session."]);
  assert.equal(sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId)!.sessionId, "other-turn-session");
  assert.equal(storage.store.get(id)!.messages.some((message) => message.id.startsWith("fork-notice-")), false, "this turn started nothing clean");
});

test("a failure that is not the copy's (a turn that failed, a Stop) never starts the fork clean", async () => {
  const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
  const source = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant) => ({ participant, ok: false, content: "", error: "The model is overloaded.", durationMs: 1 })
  });
  const { id, mainId } = await forkAndSend(service, storage);
  await service.settleChatSaves();
  assert.equal(runs.length, 1, "no second try, no clean start");
  const session = sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId)!;
  assert.equal(session.forkFrom?.sessionId, "src-cli-session", "its next turn makes the copy");
  assert.equal(storage.store.get(id)!.messages.some((message) => message.id.startsWith("fork-notice-")), false);
  // A Stop while the copy was made is the User's, not the copy's.
  const stopped = new AbortController();
  stopped.abort();
  const failedCopy = { participant: runs[0]!.participant, ok: false, content: "", error: "no rollout found for thread id src-cli-session", forkCopyFailed: true };
  assert.equal(forkCopyFailed(failedCopy, stopped.signal), false);
  assert.equal(forkCopyFailed(failedCopy, undefined), true);
  assert.equal(forkCopyFailed({ ...failedCopy, error: "some other failure", forkCopyFailed: undefined }, undefined), false);
});

test("Claude Code starting the copy clean (its source gone) still tells it it is the new chat's main session, with its role", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      runOptions.onSessionId?.("fallback-session");
      return { participant, ok: true, content: "Done.", durationMs: 1, sessionId: "fallback-session", sessionRestarted: true };
    }
  });
  const { id } = await forkAndSend(service, storage);
  const fallback = String(runs[0]!.options.resumeFallbackPrompt);
  assert.match(fallback, /^<<<APP [0-9a-f]{8}>>>\nYou were to start from a copy of @reviewer's session in the chat "Old chat", but it could not be copied/);
  assert.match(fallback, /You are @main, role: Main session: the main session of this chat\./);
  assert.match(fallback, /You are the main session\./, "its role's instructions");
  const notice = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so it started a clean session from the saved chat context.";
  await assertLineOnce(storage, id, notice, notice, [service]);
  assert.deepEqual(storage.store.get(id)!.metadata.warnings ?? [], [notice], "not the CLI's own restart warning");
});

test("on a cloud machine: a copy the CLI started clean, and the clean start of a fork whose source is gone, are lines in the chat", async () => {
  const source = oldChat([ASSISTANT, { ...REVIEWER, homeMachineId: "m-1" }]);
  const startedClean = forkedOnMachine(source, REVIEWER);
  {
    const { service, storage } = testService({
      conversations: [source, startedClean],
      run: async (participant, _prompt, runOptions) => {
        runOptions.onSessionId?.("fallback-session");
        return { participant, ok: true, content: "Done.", durationMs: 1, sessionId: "fallback-session", sessionRestarted: true };
      }
    });
    const warnings = await runOnMachine(asMachine(service), storage, startedClean.id, "main-id", "Go on.");
    const text = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so it started a clean session from the saved chat context.";
    await assertLineOnce(storage, startedClean.id, text, text, [service]);
    assert.deepEqual(warnings, [], "nothing left for the turn's own warnings");
  }
  {
    const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined, homeMachineId: "m-1" };
    const codexSource = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
    const forked = forkedOnMachine(codexSource, codexReviewer);
    const { service, storage, runs } = testService({
      conversations: [codexSource, forked],
      run: async (participant, _prompt, runOptions) => runOptions.forkFromSessionId
        ? { participant, ok: false, content: "", error: "no rollout found for thread id src-cli-session", durationMs: 1 }
        : { participant, ok: true, content: "Clean.", durationMs: 1, sessionId: "clean-session" }
    });
    asMachine(service);
    // The source is gone: the same turn starts clean, and the line says so.
    await runOnMachine(service, storage, forked.id, "main-id", "Go on.");
    assert.deepEqual(runs.map((run) => run.options.forkFromSessionId ?? null), ["src-cli-session", null]);
    const turn = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so this turn started a clean session.";
    await assertLineOnce(storage, forked.id, turn, turn, [service]);
    const reply = storage.store.get(forked.id)!.messages.find((message) => message.participantId === "main-id" && message.role === "participant");
    assert.deepEqual([reply?.status, reply?.content], ["done", "Clean."]);
  }
});

test("a member's copy is never placed on another provider: one whose added provider is gone is refused on the computer and the phone alike", async () => {
  const hostless = { ...REVIEWER, hostId: "host-gone", hostLabel: "Gone", homeMachineId: "m-1" };
  const source = oldChat([ASSISTANT, hostless], { lastMessageByParticipant: { [hostless.id]: { messageId: "old-reply", sequence: 1 } } });
  const { service } = testService({ conversations: [source], agents: READY_AGENTS, machines: [{ id: "m-1", name: "Box" }] });
  service.setMachineForkToNewChatSupport(() => "supported");
  await assert.rejects(service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: hostless.id } }),
    /cannot be forked to a new chat: Its provider no longer exists\./);
  const offer = await service.newChatOptions([]);
  assert.equal(forkToNewChatReasonFromOffer({ running: hostless, answered: true, offer: offer!.fork! }), "Its provider no longer exists.");
  // Nothing detected yet: still refused, rather than run on the CLI's own sign-in.
  assert.equal(forkToNewChatReasonInChat({ participant: { ...hostless, homeMachineId: undefined }, conversation: source, agents: [], providers: [], hosts: [],
    machineSupport: () => "supported" }), "Its provider no longer exists.");
});

test("when the point cannot be named the whole session is copied and a line in the chat says so while the turn still runs, never a clean start", async () => {
  const unplaced = oldChat([ASSISTANT, REVIEWER]);
  unplaced.messages = [unplaced.messages[0]!, { ...unplaced.messages[1]!, metadata: undefined }];
  const compacted = "its session was compacted after that reply";
  const cases: Array<[string, Conversation, string | undefined, string]> = [
    ["no reply that ended a turn", unplaced, undefined, "the app found no reply of it that ended a turn"],
    ["the CLI could not keep the point", chatWithLaterWork({ sessionCut: { sessionId: "src-cli-session", at: "assistant-uuid-1" } }), compacted, compacted]
  ];
  for (const [label, source, cliReason, reason] of cases) {
    const note = `@main's copy of @reviewer's session may include what @reviewer did after you tapped Fork: ${reason}.`;
    let id = "";
    const lines = () => (storage.store.get(id)?.messages ?? []).filter((message) => message.role === "system" && message.content === note);
    let linesWhileRunning = -1;
    const { service, storage, runs } = testService({
      conversations: [source],
      run: async (participant, _prompt, runOptions) => {
        // The runner says why once it knows there is a copy to make.
        const why = cliReason ?? runOptions.forkCut?.unknown;
        if (why) runOptions.onForkCutMissed?.(why);
        runOptions.onSessionId?.("fork-own-session");
        // Said before the turn ends: it may last hours, and the app may stop during it.
        await waitFor(() => lines().length === 1);
        linesWhileRunning = lines().length;
        return { participant, ok: true, content: "On it.", durationMs: 1, sessionId: "fork-own-session", ...(cliReason ? { forkCutMissed: cliReason } : {}) };
      }
    });
    const created = await service.createConversation({ participants: [], forkOf: { conversationId: "old-chat", participantId: REVIEWER.id } });
    id = created.conversation.id;
    const mainId = String(created.conversation.metadata.mainSessionParticipantId);
    await service.sendMessage({ conversationId: id, runId: `run-${label}`, content: "Go on.", targetParticipantIds: [mainId] });
    await waitFor(() => (storage.store.get(id)?.messages ?? []).some((message) => message.participantId === mainId && message.status !== "pending"));
    assert.equal(runs[0]!.options.forkFromSessionId, "src-cli-session", `${label}: still a copy`);
    assert.equal(linesWhileRunning, 1, `${label}: in the chat while the turn ran`);
    // A line in the chat, which her server carries to the phone and from a
    // cloud machine, and the warning the device that ran it shows.
    await assertLineOnce(storage, id, note, label, [service]);
    assert.deepEqual(storage.store.get(id)!.metadata.warnings ?? [], [note], label);
    if (!cliReason) assert.deepEqual(runs[0]!.options.forkCut, { unknown: reason }, `${label}: no point asked, the reason given`);
  }
});

test("a fork whose source is gone says only that, not that its copy may hold more", async () => {
  const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
  const unplaced = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
  // No reply that ended a turn: no point can be named either.
  unplaced.messages = [unplaced.messages[0]!, { ...unplaced.messages[1]!, metadata: undefined }];
  const recorded = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
  for (const [label, source] of [["a point that could not be named", unplaced], ["a point the CLI reported missed", recorded]] as const) {
    const { service, storage, runs } = testService({
      conversations: [source],
      run: async (participant, _prompt, runOptions) => runOptions.forkFromSessionId
        ? { participant, ok: false, content: "", error: "no rollout found for thread id src-cli-session", durationMs: 1, forkCopyFailed: true,
          forkCutMissed: "that reply is not in its session" }
        : { participant, ok: true, content: "Clean.", durationMs: 1, sessionId: "clean-session" }
    });
    const { id } = await forkAndSend(service, storage);
    await waitFor(() => runs.length === 2);
    await service.settleChatSaves();
    const said = (storage.store.get(id)?.messages ?? []).filter((message) => message.id.startsWith("fork-notice-")).map((message) => message.content);
    assert.deepEqual(said, ["@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so this turn started a clean session."], label);
    assert.equal(((storage.store.get(id)!.metadata.warnings ?? []) as string[]).some((warning) => /may include what/.test(warning)), false, label);
  }
});
