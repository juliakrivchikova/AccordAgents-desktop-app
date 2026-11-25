import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { StorageService } from "./storage";
import type { ChatParticipant, Conversation } from "../../shared/types";
import {
  assertLineOnce, ASSISTANT, clone, forkAndSend, MAIN_ROLE, NOW, oldChat, participantsOf, permissions, REPLY_FINISHED, REVIEWER,
  sessionRecord, sessionsOf, testService, waitFor
} from "./chat/test/forkFixtures";

test("the new chat's first message forks the member's CLI session; the copy is told once it is the main session of the new chat, and later messages are her words alone", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      runOptions.onSessionId?.("fork-own-session");
      return { participant, ok: true, content: "On it.", durationMs: 1, sessionId: "fork-own-session" };
    }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  assert.equal(runs.length, 1);
  const first = runs[0]!;
  assert.equal(first.participant.id, mainId);
  assert.equal(first.options.forkFromSessionId, "src-cli-session");
  assert.deepEqual(first.options.forkCut, { finishedBy: REPLY_FINISHED }, "only up to the reply she saw, by its finish");
  assert.equal(first.options.sessionId || undefined, undefined);
  assert.match(first.prompt, /^<<<APP [0-9a-f]{8}>>>\nYou were forked from @reviewer's session in the chat "Old chat": you keep everything it knew, but from now on you are the main session of a new chat, "Old chat \(fork\)"\./);
  assert.match(first.prompt, /You are @main, role: Main session\. The instructions this session started with for @reviewer no longer apply to you/);
  assert.match(first.prompt, /Your role instructions:\nYou are the main session\./, "the main session's role, not the member's");
  assert.doesNotMatch(first.prompt, /You are not the main session/);
  assert.doesNotMatch(first.prompt, /Do only the task/, "not a delegated member");
  assert.match(first.prompt, /Carry on from here\./);

  await waitFor(() => sessionsOf(storage.store.get(id)).some((session) => session.participantId === mainId && session.sessionId === "fork-own-session"));
  const session = sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId)!;
  assert.equal(session.forkFrom, undefined, "the fork is made once");
  assert.equal(session.forkedFromParticipantId, REVIEWER.id);

  await service.sendMessage({ conversationId: id, runId: "run-second", content: "And now the tests.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2);
  const second = runs[1]!;
  assert.equal(second.options.forkFromSessionId, undefined);
  assert.equal(second.options.sessionId, "fork-own-session", "its own session from then on");
  assert.equal(second.prompt, "And now the tests.", "her message as she typed it: the note stays in the copy's context, and a compaction renders the main session's own instructions");
  assert.match(second.options.role?.instructions ?? "", /You are @main in AccordAgents Chat\./, "its own instructions go with every launch");
  assert.deepEqual(sessionsOf(storage.store.get(source.id)), [sessionRecord(REVIEWER, "src-cli-session")], "the member's own session is untouched");
});

test("a main session that already answered never becomes a copy again, even after it lost its session", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      runOptions.onSessionId?.(`own-${runs.length}`);
      return { participant, ok: true, content: "Ok.", durationMs: 1, sessionId: `own-${runs.length}` };
    }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  await waitFor(() => sessionsOf(storage.store.get(id)).some((session) => session.participantId === mainId && Boolean(session.sessionId)));
  // Its session is dropped (as a move to a provider or machine does).
  const chat = storage.store.get(id)!;
  chat.metadata.participantSessions = [];
  storage.store.set(id, chat);
  await service.sendMessage({ conversationId: id, runId: "run-after-drop", content: "Next.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2);
  assert.equal(runs[1]!.options.forkFromSessionId, undefined);
  assert.doesNotMatch(runs[1]!.prompt, /You were forked from/);
});

test("a fork checks only the CLI its main session will run on: the member's own here, none for a member on a machine, never every CLI", async () => {
  const codexMember: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
  const local = oldChat([ASSISTANT, codexMember]);
  const here = testService({ conversations: [local] });
  await here.service.createConversation({ participants: [], forkOf: { conversationId: local.id, participantId: codexMember.id } });
  assert.deepEqual(here.readinessChecks, [["codex-cli"]], "its own CLI, not Antigravity's slow check too");

  const boxed: ChatParticipant = { ...REVIEWER, homeMachineId: "m-1" };
  const remote = oldChat([ASSISTANT, boxed], { participantSessions: [], lastMessageByParticipant: { [boxed.id]: { messageId: "old-reply", sequence: 1 } } });
  const there = testService({ conversations: [remote] });
  there.service.setMachineForkToNewChatSupport(() => "supported");
  await there.service.createConversation({ participants: [], forkOf: { conversationId: remote.id, participantId: boxed.id } });
  assert.deepEqual(there.readinessChecks, [], "its machine's CLI runs it: nothing to check on this computer");

  const agy = oldChat([ASSISTANT, { ...REVIEWER, kind: "gemini-cli" }]);
  const refused = testService({ conversations: [agy] });
  await assert.rejects(refused.service.createConversation({ participants: [], forkOf: { conversationId: agy.id, participantId: REVIEWER.id } }), /Antigravity has no session fork/);
  assert.deepEqual(refused.readinessChecks, [], "refused before any check");

  // The check itself could not run: no chat, and the CLI's own error stays in the logs.
  const broken = testService({ conversations: [local], readinessFails: true });
  await assert.rejects(broken.service.createConversation({ participants: [], forkOf: { conversationId: local.id, participantId: codexMember.id } }),
    (error: Error) => error.message === "Could not verify CLI readiness. Check again and retry.");
  assert.equal(broken.storage.store.size, 1, "no chat made");
});

test("a member on a cloud machine is forked to a new chat whose main session runs on that same machine", async () => {
  const boxed: ChatParticipant = { ...REVIEWER, homeMachineId: "m-1" };
  // Its session is on the machine: this computer knows only that it answered.
  const source = oldChat([ASSISTANT, boxed], { participantSessions: [], lastMessageByParticipant: { [boxed.id]: { messageId: "old-reply", sequence: 1 } } });
  const { service } = testService({ conversations: [source] });
  const asked: string[] = [];
  service.setMachineForkToNewChatSupport((machineId) => { asked.push(machineId); return "supported"; });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: boxed.id } });
  const [main] = participantsOf(created.conversation);
  assert.deepEqual(asked, ["m-1"]);
  assert.equal(main!.homeMachineId, "m-1", "a fork never crosses devices");
  assert.equal(main!.forkOrigin?.participantId, boxed.id);
});

test("the machine that runs the forked main session copies the member's session it holds", async () => {
  // As the machine's own copy of both chats has them (its runtime runs the
  // same service): the member's session record is there.
  const boxed: ChatParticipant = { ...REVIEWER, homeMachineId: "m-1" };
  const source = oldChat([ASSISTANT, boxed]);
  const forked: Conversation = {
    id: "new-chat",
    title: "Old chat (fork)",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/projects/app",
    messages: [{ id: "first", role: "user", content: "Go on.", createdAt: NOW, status: "done" }],
    findings: [],
    metadata: {
      participants: [{ id: "main-id", handle: "main", roleConfigId: MAIN_ROLE.id, kind: "claude-code", homeMachineId: "m-1", agentMode: "default", permissions: permissions(),
        forkOrigin: { conversationId: source.id, participantId: boxed.id, handle: "reviewer", conversationTitle: "Old chat", kind: "claude-code",
          seen: { messageId: "old-reply", sessionCut: { sessionId: "src-cli-session", at: "assistant-uuid-1" } } } }],
      participantSessions: [],
      mainSessionParticipantId: "main-id"
    }
  } as Conversation;
  const { service } = testService({ conversations: [source, forked] });
  chatParts(service).host.machineRuntime = true;
  chatParts(service).host.hostMachineId = "m-1";
  const state = await chatParts(service).memberSessions.sessionForParticipant(forked, participantsOf(forked)[0]);
  assert.deepEqual(state.session.forkFrom, { participantId: boxed.id, sessionId: "src-cli-session", kind: "claude-code", conversationId: source.id,
    cut: { at: "assistant-uuid-1" } }, "up to the reply the User saw, at the point the machine recorded");
  assert.equal(state.forkOriginUnavailable, undefined);
});

test("the member's session record is read without the messages of its chat", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-fork-sessions-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    await storage.saveConversation(oldChat([ASSISTANT, REVIEWER]));
    assert.deepEqual(await storage.conversationParticipantSessions("old-chat"), [sessionRecord(REVIEWER, "src-cli-session")]);
    assert.equal(await storage.conversationParticipantSessions("no-such-chat"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a member moved here whose session still waits on the server is taken before the copy is made from it", async () => {
  const moved: ChatParticipant = { ...REVIEWER, sessionHandoff: { provider: "claude-code", sessionId: "moved-session", blob: { blobHash: "b" } as never, at: NOW } };
  const source = oldChat([ASSISTANT, moved], { participantSessions: [] });
  const { service, storage, runs } = testService({ conversations: [source] });
  const taken: string[] = [];
  chatParts(service).memberMoves.takeSessionHandoff = async (conversation: Conversation, member: ChatParticipant) => {
    taken.push(`${conversation.id}:${member.id}`);
    const stored = storage.store.get(conversation.id)!;
    stored.metadata.participantSessions = [sessionRecord(moved, "moved-session")];
    storage.store.set(conversation.id, stored);
  };
  chatDependencies(service).storage.conversationAccess = async (id: string) => {
    const found = storage.store.get(id);
    return found ? { kind: found.kind, participants: clone(found.metadata.participants) } : undefined;
  };
  const { mainId } = await forkAndSend(service, storage);
  assert.deepEqual(taken.filter((key) => key.startsWith(`${source.id}:`)), [`${source.id}:${moved.id}`], "taken as its own next turn would take it");
  assert.equal(runs[0]!.participant.id, mainId);
  assert.equal(runs[0]!.options.forkFromSessionId, "moved-session");
});

test("a forked main session whose provider was changed before its first turn says so, not that the session is missing", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({ conversations: [source] });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: REVIEWER.id } });
  const id = created.conversation.id;
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  // Its provider changed in its settings before it ever ran.
  const stored = storage.store.get(id)!;
  stored.metadata.participants = participantsOf(stored).map((item) => item.id === mainId ? { ...item, kind: "codex-cli", model: undefined, reasoningEffort: undefined } : item);
  storage.store.set(id, stored);
  await service.sendMessage({ conversationId: id, runId: "run-other-cli", content: "Hello.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0]!.options.forkFromSessionId, undefined);
  const text = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\": @main now runs on Codex, not Claude Code, so it starts a clean session.";
  await assertLineOnce(storage, id, text, text, [service]);
});

test("a member's CLI session started anew says so as a warning, unless a fork's line says it instead", () => {
  const { service } = testService({ conversations: [] });
  const session = { ...sessionRecord(REVIEWER, "old-session") };
  const restarted = { participant: { id: REVIEWER.id, kind: "claude-code", label: "@reviewer" }, ok: true, content: "Done.", sessionId: "new-session", sessionRestarted: true };
  const warnings: string[] = [];
  chatParts(service).pendingReplies.applyCliRunMetadata(session, restarted, REVIEWER, warnings);
  chatParts(service).pendingReplies.applyCliRunMetadata(session, restarted, REVIEWER, warnings);
  assert.deepEqual(warnings, ["@reviewer: previous CLI session was unavailable, so a new session was started from saved chat context."], "once");
  assert.equal(session.sessionId, "new-session");
  const forked: string[] = [];
  chatParts(service).pendingReplies.applyCliRunMetadata({ ...sessionRecord(REVIEWER, "") }, restarted, REVIEWER, forked, true);
  assert.deepEqual(forked, []);
});
