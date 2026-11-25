import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { chatParticipantRequestReplyRootMap } from "../../shared/chatParticipantRequestThreads";
import type { ChatMessage, Conversation, ParticipantConfig } from "../../shared/types";
import {
  clone, delegationBatches, GENERIC_ROLE, leftAlone, mainActor, mainSession, mainSessionChat, member, NOW, participantsOf,
  quitRequestChat, requestBatch, resumesOf, REVIEWER_ROLE, sessionRecord, testService, waitFor
} from "./chat/test/mainSessionFixtures";

// --- one resume for the tasks of one turn ---------------------------------------

/** A main-session turn running here, as runParticipantTurnSerialized marks it. */
function liveTurn(service: unknown, turnSegmentId: string): { end: () => void } {
  const internals = service as any;
  const key = `conversation-1\u0000${turnSegmentId}`;
  chatParts(internals).delegation.liveTurnSegments.add(key);
  return {
    end: () => {
      chatParts(internals).delegation.liveTurnSegments.delete(key);
      chatParts(internals).requesterResumes.resumeDelegationsOfEndedTurn(key);
    }
  };
}

/** A member run the test finishes when it says so (or that ends when stopped). */
function heldRuns() {
  const releases = new Map<string, (result: { ok: boolean; content?: string; error?: string }) => void>();
  const run = (participant: ParticipantConfig, _prompt: string, _options: any, signal?: AbortSignal) =>
    new Promise<any>((resolve) => {
      const finish = (result: { ok: boolean; content?: string; error?: string }) =>
        resolve({ participant, durationMs: 1, content: "", ...result });
      releases.set(participant.id, finish);
      signal?.addEventListener("abort", () => finish({ ok: false, error: "Chat run cancelled." }), { once: true });
    });
  return { run, release: (id: string, result: { ok: boolean; content?: string; error?: string }) => releases.get(id)?.(result), started: (id: string) => releases.has(id) };
}

test("the tasks of one main-session turn resume it once, after the turn and the last task, with every answer", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker");
  const conversation = mainSessionChat([main, worker], { participantSessions: [sessionRecord(main, "main-thread")] });
  const held = heldRuns();
  const { service, storage, runs, debugEvents } = testService({
    conversation,
    run: (participant, prompt, runOptions, signal) => participant.id === main.id || participant.id === worker.id
      ? Promise.resolve({ participant, ok: true, content: `Done by ${participant.id}.`, durationMs: 1 })
      : held.run(participant, prompt, runOptions, signal)
  });
  const turn = liveTurn(service, "turn-1");
  const actor = mainActor(undefined, { turnSegmentId: "turn-1" });

  const first = await service.delegateTaskFromTool(actor, { title: "Write tests", task: "Write the tests." });
  const second = await service.delegateTaskFromTool(actor, { title: "Update docs", task: "Update the docs.", roleConfigId: REVIEWER_ROLE.id });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(first.handle, "@codex");
  assert.equal(second.handle, "@code-reviewer");
  assert.deepEqual(delegationBatches(storage.current).map((batch) => batch.delegation), [{ start: "clean", turnId: "turn-1" }, { start: "clean", turnId: "turn-1" }]);
  // An ordinary request in the same turn is not held by the tasks: it resumes the main session on its own.
  const asked = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Check the build." }] });
  assert.equal(asked.ok, true, JSON.stringify(asked));

  await waitFor(() => held.started(String(first.participantId)) && held.started(String(second.participantId)));
  // The first task ends while the turn still runs, the second after it.
  held.release(String(first.participantId), { ok: true, content: "Tests written." });
  await waitFor(() => delegationBatches(storage.current)[0]?.items[0]?.status === "answered");
  turn.end();
  await waitFor(() => debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.skipped" && event.payload.reason === "waiting-for-tasks-of-the-same-turn"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, main.id).filter((run) => run.prompt.includes("tasks you gave")).length, 0, "not while a task of the turn still runs");

  held.release(String(second.participantId), { ok: true, content: "Docs updated." });
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, main.id).filter((run) => run.prompt.includes("tasks you gave"));
  assert.equal(resumes.length, 1, "one resume for both tasks");
  assert.match(resumes[0]!.prompt, /All 2 tasks you gave in one turn have ended:/);
  assert.match(resumes[0]!.prompt, /- @codex \(task "Write tests"\): answered/);
  assert.match(resumes[0]!.prompt, /- @code-reviewer \(task "Update docs"\): answered/);
  assert.match(resumes[0]!.prompt, /Tests written\./, "the first task's reply");
  assert.match(resumes[0]!.prompt, /Docs updated\./, "and the second's");
  assert.equal((resumes[0]!.prompt.match(/Tests written\./g) ?? []).length, 1, "each reply once");
  const [one, two] = delegationBatches(storage.current);
  assert.equal(one!.autoResumeMessageId, two!.autoResumeMessageId, "both answered by the same reply");
  // In the classic view that reply is in the first task's thread, on every device.
  const firstRequest = storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest?.id === one!.id)!;
  assert.equal(chatParticipantRequestReplyRootMap(storage.current).get(one!.autoResumeMessageId!), firstRequest.id);
  assert.equal(storage.current.messages.find((message: ChatMessage) => message.id === one!.autoResumeMessageId)?.metadata?.chatThreadRootId, firstRequest.id);
  assert.deepEqual(delegationBatches(storage.current).map((batch) => batch.status), ["completed", "completed"]);
  // The ordinary request resumed it on its own.
  await waitFor(() => resumesOf(runs, main.id).length === 2);
  assert.deepEqual(debugEvents.filter((item) => item.event.endsWith(".error")), []);
});

test("tasks that all end while their turn still runs resume the main session once, when the turn ends", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const { service, storage, runs, debugEvents } = testService({ conversation });
  const turn = liveTurn(service, "turn-2");
  const actor = mainActor(undefined, { turnSegmentId: "turn-2" });
  await service.delegateTaskFromTool(actor, { title: "One", task: "Do one." });
  await service.delegateTaskFromTool(actor, { title: "Two", task: "Do two." });
  await waitFor(() => delegationBatches(storage.current).every((batch) => batch.items[0]?.status === "answered"));
  await waitFor(() => debugEvents.filter((event) => event.payload.reason === "delegating-turn-running").length >= 2);
  assert.equal(resumesOf(runs, main.id).length, 0, "the turn still runs");
  turn.end();
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, main.id).length, 1);
});

test("a task stopped by User and a task that failed still resume the main session once, with how each ended", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const held = heldRuns();
  const { service, storage, runs } = testService({
    conversation,
    run: (participant, prompt, runOptions, signal) => participant.id === main.id
      ? Promise.resolve({ participant, ok: true, content: "Noted.", durationMs: 1 })
      : held.run(participant, prompt, runOptions, signal)
  });
  const turn = liveTurn(service, "turn-3");
  const actor = mainActor(undefined, { turnSegmentId: "turn-3" });
  const stopped = await service.delegateTaskFromTool(actor, { title: "Long job", task: "Run the long job." });
  const failing = await service.delegateTaskFromTool(actor, { title: "Broken job", task: "Run the broken job." });
  const ok = await service.delegateTaskFromTool(actor, { title: "Quick job", task: "Run the quick job." });
  turn.end();
  await waitFor(() => [stopped, failing, ok].every((result) => held.started(String(result.participantId))));
  held.release(String(failing.participantId), { ok: false, error: "Model not found: gpt-unknown" });
  held.release(String(ok.participantId), { ok: true, content: "Quick job done." });
  // Stop on one member: its own run only.
  const runId = () => storage.current.messages.find((message) => message.participantId === stopped.participantId && message.status === "pending")?.metadata?.runId;
  await waitFor(() => Boolean(runId()));
  assert.equal(service.cancelRun(String(runId())), true);
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, main.id);
  assert.equal(resumes.length, 1);
  const statuses = delegationBatches(storage.current).map((batch) => batch.items[0]!.status);
  assert.deepEqual(statuses, ["interrupted", "failed", "answered"]);
  assert.match(resumes[0]!.prompt, /\(task "Long job"\): stopped by User/);
  assert.match(resumes[0]!.prompt, /\(task "Broken job"\): failed/);
  assert.match(resumes[0]!.prompt, /\(task "Quick job"\): answered/);
  assert.match(resumes[0]!.prompt, /Quick job done\./);
});

test("a lone task the User stopped resumes the main session with the task list too, the task shown as stopped", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const held = heldRuns();
  const { service, storage, runs } = testService({
    conversation,
    run: (participant, prompt, runOptions, signal) => participant.id === main.id
      ? Promise.resolve({ participant, ok: true, content: "Noted.", durationMs: 1 })
      : held.run(participant, prompt, runOptions, signal)
  });
  const turn = liveTurn(service, "turn-lone");
  const lone = await service.delegateTaskFromTool(mainActor(undefined, { turnSegmentId: "turn-lone" }), { title: "Long job", task: "Run the long job." });
  assert.equal(lone.ok, true, JSON.stringify(lone));
  turn.end();
  await waitFor(() => held.started(String(lone.participantId)));
  const runId = () => storage.current.messages.find((message) => message.participantId === lone.participantId && message.status === "pending")?.metadata?.runId;
  await waitFor(() => Boolean(runId()));
  assert.equal(service.cancelRun(String(runId())), true);
  await waitFor(() => Boolean(delegationBatches(storage.current)[0]?.autoResumeMessageId));
  const resumes = resumesOf(runs, main.id);
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /The task you gave has ended:/);
  assert.match(resumes[0]!.prompt, /- @\w[\w-]* \(task "Long job"\): stopped by User/);
  assert.doesNotMatch(resumes[0]!.prompt, /Target replies\/errors are in the transcript above/, "not the generic line");
});

test("a combined resume cuts oversized replies: each to 12,000 characters, all to 60,000, each cut one saying where the rest is", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const letters = "abcdef";
  const { service, storage, runs } = testService({
    conversation,
    run: async (participant) => {
      if (participant.id === main.id) return { participant, ok: true, content: "Noted.", durationMs: 1 };
      const index = runs.filter((run) => run.participant.id !== main.id).length - 1;
      return { participant, ok: true, content: `reply-${index}:` + letters[index]!.repeat(15_000), durationMs: 1 };
    }
  });
  const turn = liveTurn(service, "turn-big");
  const actor = mainActor(undefined, { turnSegmentId: "turn-big" });
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const result = await service.delegateTaskFromTool(actor, { title: `Big ${index}`, task: `Write a long report ${index}.` });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  turn.end();
  await waitFor(() => delegationBatches(storage.current).length === 6 && delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)), 6000);
  const resumes = resumesOf(runs, main.id);
  assert.equal(resumes.length, 1);
  const prompt = resumes[0]!.prompt;
  const replyIds = delegationBatches(storage.current).map((batch) => batch.items[0]!.replyMessageId!);
  for (const id of replyIds) {
    assert.ok(prompt.includes(`…cut; read the full reply with app_chat_read_messages (message id ${id}).`), `the cut reply ${id} says where the rest is`);
  }
  const kept = [...letters].map((letter) => (prompt.match(new RegExp(`${letter}{100,}`, "g")) ?? []).reduce((sum, run) => sum + run.length, 0));
  assert.ok(kept.every((count) => count <= 12_000), `each reply at most 12,000 characters: ${kept.join(", ")}`);
  assert.ok(kept.reduce((sum, count) => sum + count, 0) <= 60_000, "all of them at most 60,000");
  assert.equal(kept.filter((count) => count === 0).length, 1, "the budget is spent before the last reply: only its note");
  assert.ok(prompt.length < 80_000, `the prompt stays small: ${prompt.length}`);
  // The stored replies are whole.
  assert.ok(storage.current.messages.filter((message: ChatMessage) => replyIds.includes(message.id)).every((message: ChatMessage) => message.content.length > 15_000));
});

/** A chat whose main session gave tasks in one turn ("turn-old") before the
 *  app restarted; `at`: when the tasks were given and the answered ones
 *  answered (a few minutes ago by default, so a restart may still resume). */
function restartedChat(statuses: Array<"answered" | "running">, at = new Date(Date.now() - 5 * 60_000).toISOString()): Conversation {
  const main = mainSession("codex-cli", { model: undefined });
  const members = statuses.map((_status, index) => member(`m${index}`, `m${index}`));
  const conversation = mainSessionChat([main, ...members], { participantSessions: [sessionRecord(main, "main-thread")] });
  conversation.messages[0]!.createdAt = at;
  statuses.forEach((status, index) => {
    const replyId = `reply-${index}`;
    conversation.messages.push({
      id: `request-${index}`, role: "participant", participantId: main.id, participantLabel: "@main", content: `@m${index} Task ${index}`, createdAt: at, status: "done",
      metadata: { sourceMessageId: "user-message", threadId: "user-message", participantRequest: {
        id: `batch-${index}`, requesterParticipantId: main.id, requesterHandle: "main", source: "mcp", resumeRequester: true, status, depth: 1, requesterDepth: 0,
        chainRootId: "user-message", createdAt: at, updatedAt: at, triggerMessageId: "user-message", delegation: { start: "clean", turnId: "turn-old" },
        items: [{ targetParticipantId: `m${index}`, targetHandle: `m${index}`, prompt: `Task ${index}`, title: `Task ${index}`, status, createdAt: at, updatedAt: at,
          ...(status === "answered" ? { replyMessageId: replyId } : {}) }]
      } }
    } as ChatMessage);
    if (status === "answered") {
      conversation.messages.push({ id: replyId, role: "participant", participantId: `m${index}`, participantLabel: `@m${index}`, content: `Answer ${index}.`, createdAt: at, status: "done",
        metadata: { sourceMessageId: `request-${index}`, chatThreadRootId: `request-${index}` } } as ChatMessage);
    }
  });
  return conversation;
}

test("after a restart a task that was still running ends, and the main session gets the answers its turn's other tasks gave, once", async () => {
  const { service, storage, runs } = testService({ conversation: restartedChat(["answered", "running", "answered"]) });
  // The first read after the restart finds no run for the second task.
  await chatParts(service).store.requireChat("conversation-1");
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, "main-id");
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /\(task "Task 1"\): interrupted/);
  assert.match(resumes[0]!.prompt, /Answer 0\./);
  assert.match(resumes[0]!.prompt, /Answer 2\./);
});

test("after a restart that ended every task of a turn, the main session is not woken by those tasks (a request it made with the request tool does wake it)", async () => {
  const { service, storage, runs, debugEvents } = testService({ conversation: restartedChat(["running", "running"]) });
  await chatParts(service).store.requireChat("conversation-1");
  await waitFor(() => delegationBatches(storage.current).every((batch) => batch.items[0]?.status === "interrupted"));
  await waitFor(() => debugEvents.some((event) => event.payload.reason === "all-items-interrupted-before-completion"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, "main-id").length, 0);
});

test("after a restart while the main session's turn ran, its tasks that had all answered resume it once, with every answer", async () => {
  // Both tasks answered while the turn still ran (held as delegating-turn-running);
  // the restart ended the turn, and nothing in memory remembers to look again.
  const { service, storage, runs } = testService({ conversation: restartedChat(["answered", "answered"]) });
  await service.hydrateContextUsage(clone(storage.current));
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, "main-id");
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /All 2 tasks you gave in one turn have ended:/);
  assert.match(resumes[0]!.prompt, /Answer 0\./);
  assert.match(resumes[0]!.prompt, /Answer 1\./);
  // Later reads do not resume it again.
  await chatParts(service).store.requireChat("conversation-1");
  await service.hydrateContextUsage(clone(storage.current));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, "main-id").length, 1);
});

test("a combined resume a restart cut short after it began is not made again: its tasks are settled and stop holding later looks", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  for (const message of conversation.messages) {
    if (message.metadata?.participantRequest) message.metadata.participantRequest.status = "resuming_requester";
  }
  // Its resume line was written: the resume turn ran, and may have done its work.
  conversation.messages.push({ id: "cut-trigger", role: "system", content: "Auto-resumed @main after member request.\nAll 2 tasks you gave in one turn have ended:",
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(), status: "done", metadata: { sourceMessageId: "request-0", parentMessageId: "request-0", threadId: "user-message" } } as ChatMessage);
  const { service, storage, runs, debugEvents } = testService({ conversation });
  await chatParts(service).store.requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0, "the resume turn is not replayed");
  assert.deepEqual(delegationBatches(storage.current).map((batch) => batch.status), ["answered", "answered"], "settled: no longer resuming");
  assert.equal(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.recovered"), false);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "resume-already-made"));
});

test("a combined resume a restart lost before its resume line was written is made, once", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  for (const message of conversation.messages) {
    if (message.metadata?.participantRequest) message.metadata.participantRequest.status = "resuming_requester";
  }
  const { service, storage, runs } = testService({ conversation });
  await chatParts(service).store.requireChat("conversation-1");
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, "main-id");
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /Answer 0\./);
  assert.match(resumes[0]!.prompt, /Answer 1\./);
  assert.deepEqual(delegationBatches(storage.current).map((batch) => batch.status), ["completed", "completed"]);
});

test("tasks that ended more than a day before the restart do not wake the main session; they are settled quietly", async () => {
  const { service, storage, runs, debugEvents } = testService({ conversation: restartedChat(["answered", "answered"], new Date(Date.now() - 25 * 60 * 60_000).toISOString()) });
  await chatParts(service).store.requireChat("conversation-1");
  await service.hydrateContextUsage(clone(storage.current));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "too-old"));
  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.role === "system").length, 0, "no resume line either");
});

test("a task a restart ended a day after its turn does not wake the main session with the others' answers", async () => {
  const { service, runs, debugEvents } = testService({ conversation: restartedChat(["answered", "running"], new Date(Date.now() - 25 * 60 * 60_000).toISOString()) });
  await chatParts(service).store.requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "too-old"));
});

test("after the User wrote again, a restart does not wake the main session with the tasks that ended before", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  conversation.messages.push({ id: "user-later", role: "user", content: "Never mind, do something else.", createdAt: new Date(Date.now() - 60_000).toISOString(), status: "done" } as ChatMessage);
  const { service, runs, debugEvents } = testService({ conversation });
  await chatParts(service).store.requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "moved-on"));
});

test("after a later turn of the main session, a restart does not wake it with the tasks that ended before", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  // A turn of its own after the tasks ended (another member asked it), not the turn that gave them.
  conversation.messages.push({ id: "main-later", role: "participant", participantId: "main-id", participantLabel: "@main", content: "Already merged both answers.",
    createdAt: new Date(Date.now() - 60_000).toISOString(), status: "done", metadata: { turnSegmentId: "turn-later" } } as ChatMessage);
  const { service, runs, debugEvents } = testService({ conversation });
  await chatParts(service).store.requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "moved-on"));
});

test("the turn that gave the tasks writing after they ended still lets a restart resume the main session", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  // A post of the turn that gave the tasks, after they answered: still that turn.
  conversation.messages.push({ id: "main-post", role: "participant", participantId: "main-id", participantLabel: "@main", content: "Both answered; merging.",
    createdAt: new Date(Date.now() - 60_000).toISOString(), status: "done", metadata: { turnSegmentId: "turn-old" } } as ChatMessage);
  const { service, storage, runs } = testService({ conversation });
  await chatParts(service).store.requireChat("conversation-1");
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  assert.equal(resumesOf(runs, "main-id").length, 1);
});

test("a restart looks at a chat's ended tasks once, not on every read of the chat", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  for (const message of conversation.messages) {
    if (message.metadata?.participantRequest) message.metadata.participantRequest.status = "failed";
  }
  conversation.messages.push({ id: "failed-trigger", role: "system", content: "Auto-resumed @main after member request.",
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(), status: "done", metadata: { sourceMessageId: "request-0", parentMessageId: "request-0", threadId: "user-message" } } as ChatMessage);
  const { service, storage } = testService({ conversation });
  const internals = service as any;
  let looks = 0;
  const original = chatParts(internals).requestRecovery.delegationGroupResumeWasMade.bind(chatParts(internals).requestRecovery);
  chatParts(internals).requestRecovery.delegationGroupResumeWasMade = (...args: unknown[]) => { looks += 1; return original(...args); };
  for (let index = 0; index < 3; index += 1) await chatParts(internals).store.requireChat("conversation-1");
  await service.hydrateContextUsage(clone(storage.current));
  assert.equal(looks, 1);
});

test("a combined resume that was made and failed is not made again by a restart", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  for (const message of conversation.messages) {
    if (message.metadata?.participantRequest) message.metadata.participantRequest.status = "failed";
  }
  conversation.messages.push({ id: "failed-trigger", role: "system", content: "Auto-resumed @main after member request.",
    createdAt: NOW, status: "done", metadata: { sourceMessageId: "request-0", parentMessageId: "request-0", threadId: "user-message" } } as ChatMessage);
  const { service, runs, debugEvents } = testService({ conversation });
  await chatParts(service).store.requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.equal(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.recovered"), false);
});

test("a member's turn that is not a task of the main session does not wake it: the User writing in the member's session", async () => {
  // The User, 2026-11-21: the main session is woken only when its own tasks
  // end; what a member does otherwise it reads on its next turn.
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker");
  const conversation = mainSessionChat([main, worker], { participantSessions: [sessionRecord(main, "main-thread")] });
  const { service, storage, runs, debugEvents } = testService({ conversation });
  await service.sendMessage({ conversationId: conversation.id, runId: "to-worker", content: "Please also check dark mode", targetParticipantIds: [worker.id] });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.participantId === worker.id && message.status === "done"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(runs.map((run) => run.participant.id), [worker.id], "only the member ran");
  assert.equal(resumesOf(runs, main.id).length, 0, "the main session is not woken");
  assert.deepEqual(debugEvents.filter((item) => item.event.endsWith(".error")), []);
});

test("a task given after its turn ended (a CLI still at work in the background) resumes the main session on its own", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const { service, storage, runs } = testService({ conversation });
  const late = await service.delegateTaskFromTool(mainActor(undefined, { turnSegmentId: "turn-over" }), { title: "Late", task: "Do it later." });
  assert.equal(late.ok, true, JSON.stringify(late));
  assert.deepEqual(delegationBatches(storage.current)[0]!.delegation, { start: "clean" }, "no turn to wait for");
  await waitFor(() => Boolean(delegationBatches(storage.current)[0]?.autoResumeMessageId));
  assert.equal(resumesOf(runs, main.id).length, 1);
});

test("a cloud machine's main session: the tasks of its turn resume it once, on the machine", async () => {
  const main = mainSession("codex-cli", { model: undefined, homeMachineId: "machine-1" });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const { service, storage, runs } = testService({ conversation });
  service.setHostMachineId("machine-1");
  const turn = liveTurn(service, "turn-m");
  const actor = mainActor(undefined, { turnSegmentId: "turn-m" });
  const a = await service.delegateTaskFromTool(actor, { title: "Machine A", task: "Do A." });
  const b = await service.delegateTaskFromTool(actor, { title: "Machine B", task: "Do B." });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  const children = participantsOf(storage.current).filter((participant) => participant.id !== main.id);
  assert.ok(children.every((child) => child.homeMachineId === "machine-1"), "its members run on its machine");
  turn.end();
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, main.id).length, 1);
});

test("a request a real quit cut short resumes its requester once at the next start, with the interruption", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const helper = member("helper-id", "helper");
  const held = heldRuns();
  const first = testService({ conversation: mainSessionChat([main, helper], { participantSessions: [sessionRecord(main, "main-thread")] }), run: held.run });
  const asked = await first.service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "turn-ask", runId: "run-ask" }), {
    requests: [{ target: "helper", prompt: "Run the long job." }]
  });
  assert.equal(asked.status, "running", JSON.stringify(asked));
  await waitFor(() => held.started("helper-id"));
  // The User quits while the member works: its turn ends as the quit ends it,
  // and the requester's resume is skipped (the next start owns it).
  first.service.beginQuit();
  await first.service.endTurnsForQuit();
  held.release("helper-id", { ok: false, error: "Chat run cancelled." });
  await waitFor(() => first.debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.skipped" && event.payload.reason === "quitting"));
  const stored = first.storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest)!.metadata!.participantRequest!;
  assert.equal(stored.items[0]!.status, "interrupted");
  assert.equal(stored.requesterTurnSegmentId, "turn-ask", "the request keeps the turn that asked");
  assert.equal(resumesOf(first.runs, "main-id").length, 0);

  const next = testService({ conversation: first.storage.current });
  await chatParts(next.service).store.requireChat("conversation-1");
  await waitFor(() => Boolean(next.storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest)!.metadata!.participantRequest!.autoResumeMessageId));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(next.runs, "main-id");
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /Auto-resumed @main after member request\.\nTarget replies\/errors are in the transcript above/);

  // A start after that: nothing more.
  const again = testService({ conversation: next.storage.current });
  await chatParts(again.service).store.requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(again.runs, "main-id").length, 0);
});

test("a request answered after the quit began (its resume skipped) resumes its requester once at the next start, with the answer", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const helper = member("helper-id", "helper");
  const held = heldRuns();
  const first = testService({ conversation: mainSessionChat([main, helper], { participantSessions: [sessionRecord(main, "main-thread")] }), run: held.run });
  await first.service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "turn-ask", runId: "run-ask" }), { requests: [{ target: "helper", prompt: "Answer quickly." }] });
  await waitFor(() => held.started("helper-id"));
  first.service.beginQuit();
  held.release("helper-id", { ok: true, content: "The answer is 42." });
  await waitFor(() => first.debugEvents.some((event) => event.payload.reason === "quitting"));

  const next = testService({ conversation: first.storage.current });
  await chatParts(next.service).store.requireChat("conversation-1");
  await waitFor(() => resumesOf(next.runs, "main-id").length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(next.runs, "main-id");
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /The answer is 42\./);
});

test("a request still running at the start ends interrupted and resumes its requester once", async () => {
  const { service, storage, runs } = testService({ conversation: quitRequestChat("running") });
  await chatParts(service).store.requireChat("conversation-1");
  await waitFor(() => Boolean(requestBatch(storage.current).autoResumeMessageId));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requestBatch(storage.current).items[0]!.status, "interrupted");
  assert.equal(resumesOf(runs, "main-id").length, 1);
});

test("a cut-short request is not resumed after the User wrote again, when older than a day, or when its resume line is already there", async () => {
  const moved = quitRequestChat("interrupted");
  moved.messages.push({ id: "later", role: "user", content: "Never mind.", createdAt: new Date().toISOString(), status: "done" } as ChatMessage);
  const made = quitRequestChat("interrupted", { resumeLine: true });
  for (const [conversation, reason] of [[moved, "moved-on"], [made, "resume-already-made"]] as const) {
    const { service, runs, debugEvents } = testService({ conversation });
    await chatParts(service).store.requireChat("conversation-1");
    await waitFor(() => debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === reason));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(resumesOf(runs, "main-id").length, 0, reason);
  }
  // Older than a day: settled without a line, every start.
  const old = testService({ conversation: quitRequestChat("interrupted", { at: new Date(Date.now() - 25 * 60 * 60_000).toISOString() }) });
  const verdict = chatParts(old.service).requestRecovery.delegationGroupRecoveryVerdict(old.storage.current, undefined, [old.storage.current.messages.find((message: ChatMessage) => message.id === "request-1")]);
  assert.equal(verdict, "too-old");
  await chatParts(old.service).store.requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(old.runs, "main-id").length, 0);
  assert.equal(old.debugEvents.filter((event) => event.event === "chat.participant-request.auto-resume.settled").length, 0);
});

test("a resume a quit cut short after it began is not made again; one lost before its line was written is made, once", async () => {
  const cut = testService({ conversation: quitRequestChat("answered", { resumeLine: true, batch: { status: "resuming_requester" } }) });
  await chatParts(cut.service).store.requireChat("conversation-1");
  await waitFor(() => cut.debugEvents.some((event) => event.payload.reason === "resume-already-made" && event.payload.cutShort === true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(cut.runs, "main-id").length, 0);
  assert.equal(requestBatch(cut.storage.current).status, "answered", "it stops holding later looks");

  const lost = testService({ conversation: quitRequestChat("answered", { batch: { status: "resuming_requester" } }) });
  await chatParts(lost.service).store.requireChat("conversation-1");
  await waitFor(() => Boolean(requestBatch(lost.storage.current).autoResumeMessageId));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(lost.runs, "main-id").length, 1);
});

test("a request whose member waits on the User's permission card is left to the card's approval, never resumed early", async () => {
  const waiting = quitRequestChat("running");
  waiting.metadata.pendingAppToolApprovals = [{
    id: "permission-card", conversationId: "conversation-1", requesterParticipantId: "helper-id", requesterHandle: "helper", requesterRoleConfigId: GENERIC_ROLE.id,
    toolName: "app_permissions_request_change", capability: "permissions.request", status: "pending",
    request: { kind: "portable", permissions: ["webAccess"] }, summary: "Grant @helper web access", createdAt: NOW, updatedAt: NOW,
    resumeContext: { runId: "helper-run", triggerMessageId: "request-1", participantRequestBatchId: "batch-1" }
  }];
  const { service, storage, runs } = testService({ conversation: waiting });
  await chatParts(service).store.requireChat("conversation-1");
  await service.participantRequestStatusForTool(mainActor(), {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(leftAlone(service), "not weighed while the card waits");
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.equal(requestBatch(storage.current).autoResumeMessageId, undefined, "the card's approval can still resume it with the answer");
});

test("after the chat's first look, a request whose run is found gone resumes its requester once", async () => {
  const conversation = quitRequestChat("answered");
  const { service, storage, runs } = testService({ conversation: { ...conversation, messages: conversation.messages.filter((message) => message.id !== "request-1" && message.id !== "helper-reply") } });
  await chatParts(service).store.requireChat("conversation-1");
  // A request of this process whose run is gone (nothing holds it) is found
  // by the requester's status check.
  const running = quitRequestChat("running").messages.filter((message) => message.id === "request-1" || message.id === "helper-reply");
  storage.current = { ...storage.current, messages: [...storage.current.messages, ...running] };
  await service.participantRequestStatusForTool(mainActor(), {});
  await waitFor(() => Boolean(requestBatch(storage.current).autoResumeMessageId));
  await service.participantRequestStatusForTool(mainActor(), {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, "main-id").length, 1);
});

test("a requester on a cloud machine is resumed by its machine, never by the desktop", async () => {
  const onMachine = { homeMachineId: "machine-1" };
  const desktop = testService({ conversation: quitRequestChat("interrupted", { requester: onMachine }) });
  await chatParts(desktop.service).store.requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(leftAlone(desktop.service), "the desktop leaves it to the machine");
  assert.equal(resumesOf(desktop.runs, "main-id").length, 0);

  const machine = testService({ conversation: quitRequestChat("interrupted", { requester: onMachine }) });
  machine.service.setHostMachineId("machine-1");
  await chatParts(machine.service).store.requireChat("conversation-1");
  await waitFor(() => Boolean(requestBatch(machine.storage.current).autoResumeMessageId));
  assert.equal(resumesOf(machine.runs, "main-id").length, 1);
});
