import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { ChatMessage, ChatParticipantSession } from "../../shared/types";
import {
  delegationBatches, mainActor, mainSession, mainSessionChat, member, NOW, participantsOf, permissions, sessionRecord,
  testService, waitFor
} from "./chat/test/mainSessionFixtures";

test("a fork is refused across providers, for Antigravity, without a session, and from another device, and nothing is added", async () => {
  for (const [label, main, request, sessions] of [
    ["another provider", mainSession("claude-code"), { task: "T", start: "fork", kind: "codex-cli" }, [sessionRecord(mainSession(), "main-cli-session")]],
    ["Antigravity", mainSession("gemini-cli"), { task: "T", start: "fork" }, [sessionRecord(mainSession("gemini-cli"), "agy-conversation")]],
    ["no session yet", mainSession("codex-cli"), { task: "T", start: "fork" }, []]
  ] as const) {
    const conversation = mainSessionChat([main], { participantSessions: sessions });
    const { service, storage } = testService({ conversation });
    const result = await service.delegateTaskFromTool(mainActor(), request);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "fork_unavailable", label);
    assert.match(String(result.reason), /clean member/, label);
    assert.equal(participantsOf(storage.current).length, 1, `${label}: nothing added`);
  }
  // A session on another machine is not this device's to copy.
  const elsewhere = mainSession("claude-code", { homeMachineId: "machine-1" });
  const { service } = testService({ conversation: mainSessionChat([elsewhere]) });
  assert.match(String(chatParts(service).forks.forkUnavailableReason(elsewhere, sessionRecord(elsewhere, "s"), "claude-code", undefined)), /another machine/);
});

test("a fork starts from a copy of the main session's CLI session and then keeps its own", async () => {
  const main = mainSession("claude-code", { permissions: permissions({ repoRead: true, requestParticipants: "allow" }) });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
  const { service, storage, runs } = testService({
    conversation,
    run: async (participant, _prompt, runOptions) => {
      if (participant.id !== main.id) {
        runOptions.onSessionId?.("child-own-session");
        return { participant, ok: true, content: "Reviewed.", durationMs: 1, sessionId: "child-own-session" };
      }
      return { participant, ok: true, content: "Thanks.", durationMs: 1 };
    }
  });

  const result = await service.delegateTaskFromTool(mainActor(), {
    task: "Take over the refactor we discussed.",
    start: "fork",
    handle: "refactor",
    // A fork runs in the main session's folder whatever is asked.
    permissions: { repoRead: false }
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.forked, true);
  assert.equal(result.handle, "@refactor");
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(normalizeChatAgentPermissions(child.permissions).repoRead, true);
  const recorded = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((session) => session.participantId === child.id)!;
  assert.deepEqual(recorded.forkFrom, { participantId: main.id, sessionId: "main-cli-session", kind: "claude-code" });

  await waitFor(() => runs.some((run) => run.participant.id === child.id));
  const childRun = runs.find((run) => run.participant.id === child.id)!;
  assert.equal(childRun.options.forkFromSessionId, "main-cli-session");
  assert.equal(childRun.options.sessionId || undefined, undefined);
  // Both CLIs keep the source's instructions in a fork: the member is told who it is.
  assert.match(childRun.prompt, /^<<<APP [0-9a-f]{8}>>>\nYou were forked from @main's session/);
  assert.match(childRun.prompt, /You are @refactor, role: Generic Member\. You are not the main session/);
  assert.match(childRun.prompt, /Answer directly\./, "its role's instructions");

  await waitFor(() => {
    const session = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === child.id);
    return session?.sessionId === "child-own-session";
  });
  const after = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === child.id)!;
  assert.equal(after.forkFrom, undefined, "the fork is made once");
  assert.equal(after.forkedFromParticipantId, main.id);
  const mainSessionAfter = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === main.id)!;
  assert.equal(mainSessionAfter.sessionId, "main-cli-session", "the main session's own session is untouched");
});

test("a fork the CLI could not make starts clean in the same turn: the main session's task does not fail, and the chat says so once", async () => {
  for (const [kind, error] of [
    ["claude-code", "claude warm process exited with code 1: No conversation found with session ID: main-cli-session"],
    ["codex-cli", "no rollout found for thread id main-cli-session"]
  ] as const) {
    const main = mainSession(kind, kind === "codex-cli" ? { model: undefined } : {});
    const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
    const { service, storage, runs } = testService({
      conversation,
      run: async (participant, _prompt, runOptions) => {
        if (participant.id === main.id) return { participant, ok: true, content: "Noted.", durationMs: 1 };
        if (!runOptions.forkFromSessionId) {
          runOptions.onSessionId?.("clean-session");
          return { participant, ok: true, content: "Done clean.", durationMs: 1, sessionId: "clean-session" };
        }
        return { participant, ok: false, content: `${participant.label} stopped before it returned a response.`, error, durationMs: 1, forkCopyFailed: true };
      }
    });
    const result = await service.delegateTaskFromTool(mainActor(), { task: "Continue.", start: "fork" });
    assert.equal(result.ok, true, JSON.stringify(result));
    const childId = String(result.participantId);
    const sessionOf = () => (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === childId)!;
    const childRuns = () => runs.filter((run) => run.participant.id === childId);
    await waitFor(() => delegationBatches(storage.current)[0]?.items[0]?.status === "answered");
    // One turn: the copy, then (its source gone) a clean session at once.
    assert.deepEqual(childRuns().map((run) => run.options.forkFromSessionId ?? null), ["main-cli-session", null], kind);
    assert.match(childRuns()[1].prompt, /^<<<APP [0-9a-f]{8}>>>\nYou were to start from a copy of @main's session, but it could not be copied/, `${kind}: told who it is`);
    await waitFor(() => sessionOf().sessionId === "clean-session");
    assert.equal(sessionOf().forkFrom, undefined, kind);
    assert.equal(sessionOf().forkedFromParticipantId, undefined, kind);
    const replies = storage.current.messages.filter((message: ChatMessage) => message.participantId === childId && message.role === "participant");
    assert.deepEqual(replies.map((message: ChatMessage) => [message.status, message.content]), [["done", "Done clean."]], `${kind}: the task's answer`);
    // A line in the chat (every device shows it; a warning stays on one).
    const notice = `@${String(result.handle).slice(1)} could not start from a copy of @main's session, so this turn started a clean session.`;
    const lines = () => storage.current.messages.filter((message: ChatMessage) => message.role === "system" && message.content === notice);
    await waitFor(() => lines().length > 0);
    assert.equal(lines()[0].metadata?.threadId, "system", kind);
    assert.equal(lines()[0].id, `fork-notice-started-clean-${childId}`, kind);
    assert.ok(((storage.current.metadata.warnings ?? []) as string[]).includes(notice), kind);

    const asked = await service.requestParticipantsFromTool(mainActor(undefined, { triggerMessageId: "trigger-again" }), { requests: [{ target: String(result.handle), prompt: "Once more." }] });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    await waitFor(() => childRuns().length === 3);
    assert.equal(childRuns()[2].options.sessionId, "clean-session", `${kind}: its own session`);
    assert.equal(childRuns()[2].options.forkFromSessionId, undefined, `${kind}: no fork any more`);
    assert.doesNotMatch(childRuns()[2].prompt, /You were forked from/, kind);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lines().length, 1, `${kind}: once`);
  }
});

test("a delegated fork whose clean start fails too: the main session reads why in the failed reply, and the member's next turn starts as a new session", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  // The main session has read the chat through its first message: a fork's copy starts there.
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")],
    promptContextPointers: { [main.id]: { timeline: { messageId: "user-message", sequence: 0, createdAt: NOW } } } });
  let overloaded = true;
  const { service, storage, runs } = testService({
    conversation,
    run: async (participant, _prompt, runOptions) => {
      if (participant.id === main.id) return { participant, ok: true, content: "Noted.", durationMs: 1 };
      if (runOptions.forkFromSessionId) return { participant, ok: false, content: "", error: "no rollout found for thread id main-cli-session", durationMs: 1, forkCopyFailed: true };
      return overloaded
        ? { participant, ok: false, content: "Codex failed before it returned a response.", error: "The model is overloaded.", durationMs: 1 }
        : { participant, ok: true, content: "Done.", durationMs: 1, sessionId: "clean-session" };
    }
  });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Continue.", start: "fork" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const childId = String(result.participantId);
  assert.ok(((storage.current.metadata.promptContextPointers ?? {}) as Record<string, unknown>)[childId], "the copy's chat context starts where the main session's did");
  await waitFor(() => delegationBatches(storage.current)[0]?.items[0]?.status === "failed");
  assert.equal(runs.filter((run) => run.participant.id === childId).length, 2, "the copy, then the clean start");
  const notice = `@${String(result.handle).slice(1)} could not start from a copy of @main's session, so this turn started a clean session.`;
  const failed = storage.current.messages.find((message: ChatMessage) => message.participantId === childId && message.status === "error");
  assert.ok(failed?.content.includes(notice), failed?.content);
  const pointers = (storage.current.metadata.promptContextPointers ?? {}) as Record<string, { timeline?: unknown; threads?: unknown; forgottenAt?: string }>;
  // Its chat context starts over: no pointer, only the marker that keeps an
  // older copy of the chat from bringing its pointers back.
  assert.equal(pointers[childId]?.timeline, undefined, "its chat context starts over");
  assert.equal(pointers[childId]?.threads, undefined);
  assert.ok(pointers[childId]?.forgottenAt);
  // Its next turn: a new session's first, given the chat from its start.
  overloaded = false;
  const asked = await service.requestParticipantsFromTool(mainActor(undefined, { triggerMessageId: "trigger-next" }), { requests: [{ target: String(result.handle), prompt: "Try again." }] });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  await waitFor(() => runs.filter((run) => run.participant.id === childId).length === 3);
  const next = runs.filter((run) => run.participant.id === childId)[2]!;
  assert.equal(next.options.forkFromSessionId, undefined);
  assert.ok(!next.options.sessionId, "no session of its own yet");
  assert.doesNotMatch(next.prompt, /You were forked from/);
});

test("a failure that is not a missing source does not count as a failed fork", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
  const { service, storage } = testService({
    conversation,
    run: async (participant) => participant.id === main.id
      ? { participant, ok: true, content: "Noted.", durationMs: 1 }
      : { participant, ok: false, content: "", error: "Model not found: gpt-unknown", durationMs: 1 }
  });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Continue.", start: "fork" });
  assert.equal(result.ok, true, JSON.stringify(result));
  await waitFor(() => delegationBatches(storage.current)[0]?.items[0]?.status === "failed");
  const session = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === result.participantId)!;
  assert.deepEqual(session.forkFrom, { participantId: main.id, sessionId: "main-cli-session", kind: "codex-cli" }, "still a fork, no failed attempt counted");
});

test("a fork the CLI starts clean (its source is gone) is still told who it is, with its role, and the chat says it started clean", async () => {
  const main = mainSession("claude-code");
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
  const { service, storage, runs } = testService({
    conversation,
    run: async (participant, _prompt, runOptions) => {
      if (participant.id === main.id) return { participant, ok: true, content: "Noted.", durationMs: 1 };
      // The CLI's resume-miss fallback: a new session from resumeFallbackPrompt.
      runOptions.onSessionId?.("fallback-session");
      return { participant, ok: true, content: "Done.", durationMs: 1, sessionId: "fallback-session", sessionRestarted: true };
    }
  });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Continue the refactor.", start: "fork", handle: "refactor" });
  assert.equal(result.ok, true, JSON.stringify(result));
  await waitFor(() => runs.some((run) => run.participant.id === result.participantId));
  const fallback = String(runs.find((run) => run.participant.id === result.participantId)!.options.resumeFallbackPrompt);
  assert.match(fallback, /^<<<APP [0-9a-f]{8}>>>\nYou were to start from a copy of @main's session, but it could not be copied/);
  assert.match(fallback, /You are @refactor, role: Generic Member\. You are not the main session\./);
  assert.match(fallback, /Do only the task in the request below/);
  assert.match(fallback, /Answer directly\./, "its role's instructions");
  assert.match(fallback, /Continue the refactor\./, "and its task");

  await waitFor(() => (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === result.participantId)?.sessionId === "fallback-session");
  const session = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === result.participantId)!;
  assert.equal(session.forkFrom, undefined);
  assert.equal(session.forkedFromParticipantId, undefined, "not reminded later that it is a fork");
  const notice = "@refactor could not start from a copy of @main's session, so it started a clean session from the saved chat context.";
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.role === "system" && message.content === notice));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.role === "system" && message.content === notice).length, 1, "once");
  assert.deepEqual(storage.current.metadata.warnings ?? [], [notice], "the warning the device that ran it shows, not the CLI's own restart warning");
});

test("a fork never takes the source's session id as its own", () => {
  const main = mainSession();
  const { service } = testService({ conversation: mainSessionChat([main]) });
  const session = { ...sessionRecord(member("c", "c"), ""), forkFrom: { participantId: main.id, sessionId: "main-cli-session", kind: "claude-code" as const } };
  const conversation = mainSessionChat([main]);
  chatParts(service).memberSessions.persistParticipantSessionId(conversation, session, "main-cli-session");
  assert.equal(session.sessionId, "");
  assert.ok(session.forkFrom);
  chatParts(service).pendingReplies.applyCliRunMetadata(session, { participant: {}, ok: true, content: "", sessionId: "main-cli-session" }, member("c", "c"), []);
  assert.equal(session.sessionId, "");
  chatParts(service).pendingReplies.applyCliRunMetadata(session, { participant: {}, ok: true, content: "", sessionId: "child-session" }, member("c", "c"), []);
  assert.equal(session.sessionId, "child-session");
  assert.equal(session.forkFrom, undefined);
});
