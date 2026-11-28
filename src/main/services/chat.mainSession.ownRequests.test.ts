import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { chatParticipant, selfCompactingChat, waitFor as waitLong } from "./chat/test/compactionFixtures";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { sessionsTaskReplyLine, sessionsTaskStatus } from "../../shared/mainSessionView";
import type { ChatMessage, ChatParticipantRequestItem, Conversation } from "../../shared/types";
import { PARTICIPANT_REQUEST_CUT_BY_SEND_NOW, PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION, PARTICIPANT_REQUEST_STOPPED_BY_USER } from "./chat/constants";
import {
  clone, mainActor, mainSession, mainSessionChat, member, NOW, resumesOf, testService, waitFor
} from "./chat/test/mainSessionFixtures";
import { endWaitOnUnresumedOwnRequest, memberWorksOnAfter, ownRequestsAnswering, repliesAnswering, requestAnsweredByTurn } from "./chat/requests/ownRequests";
import { readWaitOnlyRunIds } from "../../shared/chatRunState";
import {
  asksMainThenAnswers, batches, endProcess, itemOf, machineMemberChat, memberActor, ok, replyText, requestBy, scenario, settle, taskEnded,
  type Reply
} from "./chat/test/ownRequestFixtures";
import { markParticipantRequestAutoResumeFailed } from "./chat/requests/requestRecords";

// A member that asks the main session (or anyone) something while it works
// on a request, with app_chat_request_participants and the default
// resumeRequester, and ends its turn to wait: its task is not over until the
// turn it is resumed in with the answer ends (2026-11-27).

test("a task whose member asks the main session and ends its turn waits for the member's answer after the resume, and the main session reads that answer once", async () => {
  const { service, storage, runs, debugEvents } = scenario({ worker: asksMainThenAnswers });
  const task = await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "turn-main", runId: "run-main" }), {
    requests: [{ target: "worker", prompt: "Pick a color: ask me first." }]
  });
  assert.equal(task.ok, true, JSON.stringify(task));

  await waitFor(() => itemOf(storage.current, "worker-id")?.status === "answered" || Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
  await settle();
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(item.status, "answered");
  assert.equal(replyText(storage.current, item.replyMessageId), "FINAL: blue", "its answer is the reply after the resume");
  assert.deepEqual(item.earlierReplyMessageIds?.map((id) => replyText(storage.current, id)), ["I asked the main session; I go on once it answers."]);
  // The main session: asked the question once, resumed with the answer once.
  const asked = runs.filter((run) => run.participant.id === "main-id" && run.prompt.includes("Which color"));
  assert.equal(asked.length, 1);
  const resumes = resumesOf(runs, "main-id").filter((run) => run.prompt.includes("Auto-resumed @main after member request.\nTarget replies"));
  assert.equal(resumes.length, 1, "one resume, with the member's final answer");
  assert.match(resumes[0]!.prompt, /FINAL: blue/);
  assert.deepEqual(debugEvents.filter((event) => event.event.endsWith(".error")), []);
});

test("a task of the main session (app_chat_delegate_task) shows running while its member waits and its final line at the end; the main session is woken once with it", async () => {
  let releaseAnswer: (() => void) | undefined;
  const answered = new Promise<void>((resolve) => { releaseAnswer = resolve; });
  const { service, storage, runs } = scenario({
    worker: asksMainThenAnswers,
    answer: async () => { await answered; return { ok: true, content: "blue" }; }
  });
  const delegated = await service.delegateTaskFromTool(mainActor(undefined, { turnSegmentId: "turn-delegate", runId: "run-delegate" }), {
    title: "Color pick", task: "Before you finish, ask the main session which color to use.", kind: "claude-code"
  } as any);
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  const memberId = String(delegated.participantId);
  // Its own question is out and its turn is over: the task still runs.
  await waitFor(() => batches(storage.current).some((entry) => entry.batch.requesterParticipantId === memberId));
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.participantId === memberId && message.status === "done"));
  await settle();
  const task = () => batches(storage.current).find((entry) => entry.batch.delegation)!;
  assert.equal(task().batch.items[0]!.status, "running", "the task waits for the member");
  assert.equal(sessionsTaskStatus(task().batch.items[0]!, "running"), "running", "the Delegated row shows it running");
  assert.equal(taskEnded(runs).length, 0, "the main session is not woken with the interim line");

  releaseAnswer!();
  await waitFor(() => Boolean(task().batch.autoResumeMessageId));
  await settle();
  const item = task().batch.items[0]!;
  assert.equal(item.status, "answered");
  const byId = new Map(storage.current.messages.map((message: ChatMessage) => [message.id, message]));
  assert.equal(sessionsTaskStatus(item), "done");
  assert.equal(sessionsTaskReplyLine(item, byId), "FINAL: blue", "the Delegated row's line is the final answer");
  const woken = taskEnded(runs);
  assert.equal(woken.length, 1, "woken once");
  assert.match(woken[0]!.prompt, /The task you gave has ended:\n- @\S+ \(task "Color pick"\): answered/);
  assert.match(woken[0]!.prompt, /FINAL: blue/, "with the final answer");
  // The member's own question resumed it once.
  assert.equal(runs.filter((run) => run.participant.id === memberId && run.prompt.includes(`Auto-resumed @`)).length, 1);
});

test("every member request waits the same way: a member asking another member, not the main session", async () => {
  const helper = member("helper-id", "helper", { kind: "claude-code" });
  const { service, storage, runs } = scenario({
    others: [helper],
    worker: async (turn, _prompt, ask) => {
      if (turn === 1) {
        await ask("helper", "What is the build number?");
        return { ok: true, content: "Asked the helper." };
      }
      return { ok: true, content: "FINAL: build 42" };
    }
  });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "turn-main", runId: "run-main" }), { requests: [{ target: "worker", prompt: "Report the build." }] });
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
  await settle();
  assert.equal(replyText(storage.current, itemOf(storage.current, "main-id")!.replyMessageId), "FINAL: build 42");
  assert.equal(resumesOf(runs, "main-id").length, 1);
});

test("the member's own question fails, is declined or is interrupted: the member is still resumed and its reply settles the task", async () => {
  // Failed: the main session's turn errors.
  {
    const { service, storage, runs } = scenario({
      worker: async (turn, prompt, ask) => turn === 1
        ? (await ask("main", "Which color?"), { ok: true, content: "Asked." })
        : (assert.match(prompt, /Auto-resumed @worker/), { ok: true, content: "FINAL: red (no answer came)" }),
      answer: async () => ({ ok: false, content: "", error: "Usage limit reached." })
    });
    await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
    await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
    await settle();
    assert.equal(itemOf(storage.current, "worker-id")!.status, "failed", "its question failed");
    assert.equal(replyText(storage.current, itemOf(storage.current, "main-id")!.replyMessageId), "FINAL: red (no answer came)", "failed question");
    assert.equal(resumesOf(runs, "main-id").length, 1);
  }
  // Declined: the member's requests need the User's card, and she declines.
  {
    const { service, storage, runs } = scenario({
      workerPermissions: { requestParticipants: "ask" },
      worker: async (turn, prompt, ask) => turn === 1
        ? (await ask("main", "Which color?"), { ok: true, content: "Asked, waiting for the card." })
        : (assert.match(prompt, /@main: User declined this request; it was not asked\./), { ok: true, content: "FINAL: red (declined)" })
    });
    await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
    let card: { id: string } | undefined;
    await waitFor(() => Boolean(card = (storage.current.metadata.pendingAppToolApprovals as any[] | undefined)?.find((approval) => approval.status === "pending" && approval.requesterParticipantId === "worker-id")));
    await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.participantId === "worker-id" && message.status === "done"));
    await settle();
    assert.equal(itemOf(storage.current, "main-id")!.status, "running", "waits while the card is open");
    await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: card!.id, approve: false });
    await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
    await settle();
    assert.equal(itemOf(storage.current, "worker-id")!.status, "denied");
    assert.equal(replyText(storage.current, itemOf(storage.current, "main-id")!.replyMessageId), "FINAL: red (declined)", "declined question");
    assert.equal(resumesOf(runs, "main-id").length, 1);
  }
  // Interrupted: the main session's answering turn is stopped.
  {
    const { service, storage, runs } = scenario({
      worker: async (turn, prompt, ask) => turn === 1
        ? (await ask("main", "Which color?"), { ok: true, content: "Asked." })
        : (assert.match(prompt, /Auto-resumed @worker/), { ok: true, content: "FINAL: red (interrupted)" }),
      answer: (_prompt, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ ok: false, content: "", error: "Chat run cancelled." }), { once: true }))
    });
    await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
    let answering: ChatMessage | undefined;
    await waitFor(() => Boolean(answering = storage.current.messages.find((message: ChatMessage) => message.participantId === "main-id" && message.status === "pending")));
    service.cancelRun(answering!.metadata!.runId!);
    await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
    await settle();
    assert.equal(itemOf(storage.current, "worker-id")!.status, "interrupted");
    assert.equal(replyText(storage.current, itemOf(storage.current, "main-id")!.replyMessageId), "FINAL: red (interrupted)", "interrupted question");
    assert.equal(resumesOf(runs, "main-id").length, 1);
  }
});

test("the User stops the member while it waits: the task is stopped and its requester is told so once", async () => {
  let releaseAnswer: (() => void) | undefined;
  const answered = new Promise<void>((resolve) => { releaseAnswer = resolve; });
  const { service, storage, runs } = scenario({
    worker: asksMainThenAnswers,
    answer: async () => { await answered; return { ok: true, content: "blue" }; }
  });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.participantId === "worker-id" && message.status === "done"));
  await settle();
  // The member is still running for the User (its Stop is live).
  const workerRuns = Object.entries((storage.current.metadata.activeRunParticipantIdsByRunId ?? {}) as Record<string, string>)
    .filter(([, participantId]) => participantId === "worker-id").map(([runId]) => runId);
  assert.equal(workerRuns.length, 1, JSON.stringify(storage.current.metadata.activeRunParticipantIdsByRunId));
  service.cancelRun(workerRuns[0]!);
  await waitFor(() => itemOf(storage.current, "main-id")?.status === "interrupted");
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(item.error, PARTICIPANT_REQUEST_STOPPED_BY_USER);
  assert.equal(replyText(storage.current, item.replyMessageId), "I asked the main session; I go on once it answers.");
  // Its own question still comes back to it (as finished background work
  // does in its CLI); the stopped task does not change, and nobody is woken twice.
  releaseAnswer!();
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId) && Boolean(requestBy(storage.current, "worker-id")?.batch.autoResumeMessageId));
  await settle();
  assert.equal(itemOf(storage.current, "main-id")!.status, "interrupted");
  const woken = resumesOf(runs, "main-id").filter((run) => run.prompt.includes("Auto-resumed @main after member request.\nTarget replies"));
  assert.equal(woken.length, 1);
  assert.match(woken[0]!.prompt, /@worker: Stopped by User\./);
});

test("several questions at once: the task waits until the member is back from all of them, and its answer is the reply after that", async () => {
  const helper = member("helper-id", "helper", { kind: "claude-code" });
  let releaseMain: (() => void) | undefined;
  const mainAnswered = new Promise<void>((resolve) => { releaseMain = resolve; });
  const { service, storage, runs, workerTurns } = scenario({
    others: [helper],
    answer: async () => { await mainAnswered; return { ok: true, content: "blue" }; },
    worker: async (turn, prompt, ask) => {
      if (turn === 1) {
        await ask(["main", "helper"], "Which color and size?");
        return { ok: true, content: "Asked both." };
      }
      assert.match(prompt, /Auto-resumed @worker after member request/);
      return { ok: true, content: "FINAL: blue, size M" };
    }
  });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  // The helper answers first: the member is not resumed yet, and the task still waits.
  await waitFor(() => requestBy(storage.current, "worker-id")?.batch.items.find((entry) => entry.targetHandle === "helper")?.status === "answered");
  await settle();
  assert.equal(workerTurns(), 1);
  assert.equal(itemOf(storage.current, "main-id")!.status, "running");
  releaseMain!();
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
  await settle();
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(item.status, "answered");
  assert.equal(workerTurns(), 2, "resumed once, with both answers");
  assert.equal(replyText(storage.current, item.replyMessageId), "FINAL: blue, size M");
  assert.deepEqual(item.earlierReplyMessageIds?.map((id) => replyText(storage.current, id)), ["Asked both."]);
  assert.equal(resumesOf(runs, "main-id").length, 1);
});

test("asking again in the turn after the resume keeps the task waiting until the reply after that", async () => {
  const { service, storage, runs, workerTurns } = scenario({
    worker: async (turn, _prompt, ask) => {
      if (turn < 3) {
        await ask("main", `Question ${turn}?`);
        return { ok: true, content: `Asked ${turn}.` };
      }
      return { ok: true, content: "FINAL after two questions" };
    }
  });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
  await settle();
  assert.equal(workerTurns(), 3);
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(replyText(storage.current, item.replyMessageId), "FINAL after two questions");
  assert.deepEqual(item.earlierReplyMessageIds?.map((id) => replyText(storage.current, id)), ["Asked 1.", "Asked 2."]);
  assert.equal(resumesOf(runs, "main-id").length, 1, "the requester is resumed once, at the end");
});

test("a quit while the member waits keeps the task: at the next start its answer after the resume settles it and its requester is resumed once", async () => {
  let releaseAnswer: ((reply: Reply) => void) | undefined;
  const first = scenario({
    worker: asksMainThenAnswers,
    answer: (_prompt, signal) => new Promise((resolve) => {
      releaseAnswer = resolve;
      signal?.addEventListener("abort", () => resolve({ ok: false, content: "", error: "Chat run cancelled." }), { once: true });
    })
  });
  await first.service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  await waitFor(() => Boolean(releaseAnswer) && first.storage.current.messages.some((message: ChatMessage) => message.participantId === "worker-id" && message.status === "done"));
  await settle();
  // The User quits while the main session is still answering.
  first.service.beginQuit();
  await first.service.endTurnsForQuit();
  releaseAnswer!({ ok: false, content: "", error: "Chat run cancelled." });
  await settle();
  assert.equal(itemOf(first.storage.current, "main-id")!.status, "running", "the task outlives the quit");
  assert.equal(itemOf(first.storage.current, "worker-id")!.status, "interrupted", "the question the quit cut short");
  assert.equal(resumesOf(first.runs, "main-id").length, 0);
  const stored = structuredClone(first.storage.current) as Conversation;
  endProcess(first.service);

  // Next start: the member is resumed with the interruption, its reply settles the task.
  const next = testService({
    conversation: stored,
    run: async (participant, prompt) => participant.id === "worker-id"
      ? (assert.match(prompt, /Auto-resumed @worker/), ok(participant, "FINAL: red (after restart)"))
      : ok(participant, "Noted.")
  });
  await chatParts(next.service).store.requireChat("conversation-1");
  await waitFor(() => Boolean(requestBy(next.storage.current, "main-id")?.batch.autoResumeMessageId), 4000);
  await settle();
  const item = itemOf(next.storage.current, "main-id")!;
  assert.equal(item.status, "answered");
  assert.equal(replyText(next.storage.current, item.replyMessageId), "FINAL: red (after restart)");
  assert.equal(resumesOf(next.runs, "main-id").length, 1);
  assert.match(resumesOf(next.runs, "main-id")[0]!.prompt, /FINAL: red \(after restart\)/);

  // A start after that: nothing more.
  const again = testService({ conversation: next.storage.current });
  await chatParts(again.service).store.requireChat("conversation-1");
  await settle();
  assert.equal(again.runs.length, 0);
});

test("a restart after which the member is not resumed (the User wrote meanwhile) ends the task interrupted, never waiting for nothing", async () => {
  let releaseAnswer: ((reply: Reply) => void) | undefined;
  const first = scenario({
    worker: asksMainThenAnswers,
    answer: () => new Promise((resolve) => { releaseAnswer = resolve; })
  });
  await first.service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  await waitFor(() => Boolean(releaseAnswer) && first.storage.current.messages.some((message: ChatMessage) => message.participantId === "worker-id" && message.status === "done"));
  first.service.beginQuit();
  await first.service.endTurnsForQuit();
  releaseAnswer!({ ok: false, content: "", error: "Chat run cancelled." });
  await settle();
  const stored = structuredClone(first.storage.current) as Conversation;
  endProcess(first.service);
  stored.messages.push({ id: "later", role: "user", content: "Something else.", createdAt: new Date(Date.now() + 1000).toISOString(), status: "done" } as ChatMessage);
  const next = testService({ conversation: stored });
  await chatParts(next.service).store.requireChat("conversation-1");
  await waitFor(() => itemOf(next.storage.current, "main-id")?.status === "interrupted");
  await settle();
  assert.equal(itemOf(next.storage.current, "main-id")!.error, PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION);
  assert.equal(next.runs.filter((run) => run.participant.id === "worker-id").length, 0, "the member is not resumed");
  // Weighed as any request a restart ended: the User moved on, so its requester is not woken either.
  assert.equal(resumesOf(next.runs, "main-id").length, 0);
  assert.ok(next.debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "moved-on" &&
    (event.payload.requestMessageIds as string[]).includes(requestBy(next.storage.current, "main-id")!.message.id)));
});

// --- a member on a cloud machine --------------------------------------------

test("a member on a cloud machine: after a restart here the desktop waits again for the answer its machine writes after the resume, and resumes the main session once with it", async () => {
  const { service, storage, runs } = testService({ conversation: machineMemberChat({ items: "answered", status: "resuming_requester" }) });
  await chatParts(service).store.requireChat("conversation-1");
  await waitFor(() => Object.values((storage.current.metadata.activeRunParticipantIdsByRunId ?? {}) as Record<string, string>).includes("remote-id"));
  assert.equal(itemOf(storage.current, "main-id")!.status, "running", "the task outlives the restart here");
  assert.equal(runs.length, 0, "the member is resumed by its machine, not here");

  // Its machine resumes it and writes its answer; this desktop hears of it
  // through the server (a turn there changed).
  const now = new Date().toISOString();
  const written = structuredClone(storage.current) as Conversation;
  written.messages.push(
    { id: "resume-line", role: "system", content: "Auto-resumed @remote after member request.", createdAt: now, status: "done", metadata: { sourceMessageId: "own", parentMessageId: "own" } } as ChatMessage,
    { id: "final", role: "participant", participantId: "remote-id", content: "FINAL: blue (from the machine)", createdAt: now, status: "done",
      metadata: { sourceMessageId: "resume-line", runId: "remote-run-2", turnSegmentId: "remote-turn-2" } } as ChatMessage
  );
  const own = written.messages.find((message) => message.id === "own")!.metadata!.participantRequest!;
  Object.assign(own, { status: "completed", autoResumeMessageId: "final", updatedAt: now });
  storage.current = written;
  for (const listener of [...chatParts(service).store.chatSavedListeners.get("conversation-1") ?? []]) listener(undefined);

  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
  await settle();
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(item.status, "answered");
  assert.equal(item.replyMessageId, "final");
  assert.deepEqual(item.earlierReplyMessageIds, ["interim"]);
  const woken = resumesOf(runs, "main-id");
  assert.equal(woken.length, 1);
  assert.match(woken[0]!.prompt, /FINAL: blue \(from the machine\)/);
  assert.equal(Object.values((storage.current.metadata.activeRunParticipantIdsByRunId ?? {}) as Record<string, string>).includes("remote-id"), false, "its wait ended");
});

test("a member on a cloud machine whose own question was declined is resumed by its machine, because a task waits on its answer", async () => {
  const { service, runs } = testService({ conversation: machineMemberChat({ items: "denied", status: "denied" }) });
  service.setHostMachineId("machine-1");
  await chatParts(service).requesterResumes.autoResumeParticipantRequest("conversation-1", "own");
  await waitFor(() => runs.some((run) => run.participant.id === "remote-id"));
  const resumed = runs.find((run) => run.participant.id === "remote-id")!;
  assert.match(resumed.prompt, /Auto-resumed @remote after member request/);
  assert.match(resumed.prompt, /@main: User declined this request; it was not asked\./);

  // With no task waiting on it, a declined request still resumes nobody.
  const alone = machineMemberChat({ items: "denied", status: "denied" });
  alone.messages = alone.messages.filter((message) => message.id !== "task");
  const quiet = testService({ conversation: alone });
  quiet.service.setHostMachineId("machine-1");
  await chatParts(quiet.service).requesterResumes.autoResumeParticipantRequest("conversation-1", "own");
  await settle();
  assert.equal(quiet.runs.length, 0);
  assert.ok(quiet.debugEvents.some((event) => event.payload.reason === "all-items-denied"));
});

// --- requests that went out together in one turn ------------------------------

test("requests answered together in one turn wait with it when their member asks someone itself, and each ends with its final reply", async () => {
  const asks = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) };
  const askers = ["asker1", "asker2"].map((id) => chatParticipant({ id, handle: id, ...asks }));
  const helper = chatParticipant({ id: "helper", handle: "helper", ...asks });
  let releaseBusy!: () => void;
  const busy = new Promise<void>((resolve) => { releaseBusy = resolve; });
  const asked: Record<string, any> = {};
  const chat = selfCompactingChat({
    participant: asks,
    others: [...askers, helper],
    turn: async ({ participantId, prompt, actor, service, call }) => {
      if (participantId.startsWith("asker")) {
        if (call === 1) asked[participantId] = await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: `Question from ${participantId}` }] });
        return call === 1 ? "Asked admin." : `Thanks (${participantId}).`;
      }
      if (participantId === "helper") return "The answer is 7.";
      if (call === 1) { await busy; return "Busy work done."; }
      if (call === 2) {
        // Both questions in one turn: the admin asks the helper and ends its turn to wait.
        const own = await service.requestParticipantsFromTool(actor, { requests: [{ target: "helper", prompt: "What is the answer?" }] });
        assert.equal(own.status, "running", JSON.stringify(own));
        return "Asked the helper; I answer once it replies.";
      }
      assert.match(prompt, /Auto-resumed @admin after member request/);
      return "FINAL for asker1 and asker2: 7.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin do the long task" });
  await waitLong(() => chat.prompts.filter((item) => item.participantId === "codex-admin").length === 1, 5_000);
  for (const asker of ["asker1", "asker2"]) {
    await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: `run-${asker}`, content: `@${asker} ask admin` });
    await waitLong(() => asked[asker]?.status === "running", 5_000);
  }
  releaseBusy();
  const itemFor = (asker: string) => chat.storage.current.messages
    .find((message: any) => message.metadata?.participantRequest?.requesterParticipantId === asker)!.metadata.participantRequest.items[0];
  await waitLong(() => ["asker1", "asker2"].every((asker) => chat.prompts.filter((item) => item.participantId === asker).length === 2), 8_000);
  const final = chat.replies().find((message: any) => message.content === "FINAL for asker1 and asker2: 7.");
  assert.ok(final, "the admin went on after the helper's answer");
  for (const asker of ["asker1", "asker2"]) {
    const item = itemFor(asker);
    assert.equal(item.status, "answered", asker);
    assert.equal(item.replyMessageId, final.id, `${asker} ends with the final reply`);
    const resumes = chat.prompts.filter((entry) => entry.participantId === asker).slice(1);
    assert.equal(resumes.length, 1, `${asker} is resumed once`);
    assert.match(resumes[0]!.prompt, /FINAL for asker1 and asker2: 7\./);
  }
  await waitLong(() => chat.storage.current.metadata.running === false, 8_000);
});

// --- review of 2026-11-27: resumes that end with no reply, permission cards ---

/** The machine chat of above, its member's own request now answered and its
 *  resume ended on its machine with no reply of the member's. */
async function machineResumeEnds(reason: "failed" | "stopped" | "not-made"): Promise<ChatParticipantRequestItem> {
  const { service, storage, runs } = testService({ conversation: machineMemberChat({ items: "answered", status: "resuming_requester" }) });
  await chatParts(service).store.requireChat("conversation-1");
  await waitFor(() => Object.values((storage.current.metadata.activeRunParticipantIdsByRunId ?? {}) as Record<string, string>).includes("remote-id"));
  const written = structuredClone(storage.current) as Conversation;
  const own = written.messages.find((message) => message.id === "own")!.metadata!.participantRequest!;
  const now = new Date().toISOString();
  // As its machine writes it; the batch's own status is the items' (a merge recomputes it).
  Object.assign(own, { status: "answered", updatedAt: now, requesterResumeEnded: { reason, at: now, ...(reason === "failed" ? { error: "The machine could not start its turn." } : {}) } });
  storage.current = written;
  for (const listener of [...chatParts(service).store.chatSavedListeners.get("conversation-1") ?? []]) listener(undefined);
  await waitFor(() => itemOf(storage.current, "main-id")?.status !== "running");
  await settle();
  assert.equal(runs.filter((run) => run.participant.id === "remote-id").length, 0);
  return itemOf(storage.current, "main-id")!;
}

test("a member's resume that ends with no reply ends the task as that resume did, never with the interim line", async () => {
  const failed = await machineResumeEnds("failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "The machine could not start its turn.");
  const stopped = await machineResumeEnds("stopped");
  assert.equal(stopped.status, "interrupted");
  assert.equal(stopped.error, PARTICIPANT_REQUEST_STOPPED_BY_USER);
  const notMade = await machineResumeEnds("not-made");
  assert.equal(notMade.status, "interrupted");
  assert.equal(notMade.error, PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION);
});

test("a failed resume stays known after a merge rewrites its request's status, and a request nobody resumes for a day stops being waited on", () => {
  const conversation = machineMemberChat({ items: "answered", status: "resuming_requester" });
  const own = () => conversation.messages.find((message) => message.id === "own")!;
  assert.equal(ownRequestsAnswering(conversation, "remote-id", "task").open.length, 1);
  markParticipantRequestAutoResumeFailed(conversation, "own", new Error("No server link."));
  // What a merge of an older copy makes of it: the status from the items, the rest from the newer copy.
  own().metadata!.participantRequest = { ...own().metadata!.participantRequest!, status: "answered" };
  const state = ownRequestsAnswering(conversation, "remote-id", "task");
  assert.deepEqual(state.ended.map((entry) => [entry.reason, entry.error]), [["failed", "No server link."]]);
  assert.equal(state.open.length, 0);

  const stale = machineMemberChat({ items: "answered", status: "answered" });
  const later = Date.now() + 25 * 60 * 60_000;
  assert.equal(ownRequestsAnswering(stale, "remote-id", "task", undefined, later).open.length, 0, "nothing resumed it for a day");
  const running = machineMemberChat({ items: "answered", status: "answered" });
  running.messages.find((message) => message.id === "own")!.metadata!.participantRequest!.items[0]!.status = "running";
  assert.equal(ownRequestsAnswering(running, "remote-id", "task", undefined, later).open.length, 1, "still asked: it waits");
});

test("a long chain of asking and resuming still leads back to the task, with no cap on its length, and a turn the User started leads nowhere", () => {
  const conversation = machineMemberChat({ items: "answered", status: "completed" });
  let trigger = "task";
  for (let round = 0; round < 60; round += 1) {
    const ownId = `own-${round}`;
    conversation.messages.push(
      { id: ownId, role: "participant", participantId: "remote-id", content: "@main ?", createdAt: NOW, status: "done",
        metadata: { participantRequest: { id: `b-${round}`, requesterParticipantId: "remote-id", requesterHandle: "remote", source: "mcp", resumeRequester: true,
          status: "completed", depth: 2, createdAt: NOW, updatedAt: NOW, triggerMessageId: trigger, items: [] } } } as unknown as ChatMessage,
      { id: `line-${round}`, role: "system", content: "Auto-resumed @remote after member request.", createdAt: NOW, status: "done", metadata: { sourceMessageId: ownId } } as ChatMessage
    );
    trigger = `line-${round}`;
  }
  assert.equal(requestAnsweredByTurn(conversation, "remote-id", trigger)?.id, "task");
  assert.equal(requestAnsweredByTurn(conversation, "remote-id", "user-message"), undefined);
  assert.equal(requestAnsweredByTurn(conversation, "main-id", "task"), undefined, "the task is not one the main session answers");
});

test("the turn after a permission card's approval that asks someone itself does not answer the task: the reply after its resume does", async () => {
  // Another member at work the whole time (with nothing running, the stale-run
  // sweep ends a task that waits on a card: that is older behavior, not this one).
  const busy = member("busy-id", "busy", { kind: "claude-code" });
  let releaseBusy!: () => void;
  const busyDone = new Promise<void>((resolve) => { releaseBusy = resolve; });
  const { service, storage, runs, workerTurns } = scenario({
    others: [busy],
    othersRun: async () => { await busyDone; return "Busy work done."; },
    answer: async (prompt) => ({ ok: true, content: prompt.includes("Which page?") ? "The home page." : "Noted." }),
    worker: async (turn, _prompt, ask) => {
      if (turn === 1) {
        const actor = await memberActor(storage, "worker-id");
        const card = await service.requestPermissionChangeFromTool(actor, { kind: "portable", permissions: ["webAccess"] });
        assert.equal(card.status, "pending_user_approval", JSON.stringify(card));
        return { ok: true, content: "I need web access." };
      }
      if (turn === 2) {
        await ask("main", "Which page?");
        return { ok: true, content: "Approved; I asked the main session which page." };
      }
      return { ok: true, content: "FINAL: the home page is up." };
    }
  });
  storage.current.messages.push({ id: "user-message-2", role: "user", content: "And the long job.", createdAt: NOW, status: "done" } as ChatMessage);
  const asked = await service.requestParticipantsFromTool(mainActor(undefined, { triggerMessageId: "user-message-2", triggerThreadId: "user-message-2", turnSegmentId: "t0", runId: "r0" }),
    { requests: [{ target: "busy", prompt: "Long job." }] });
  assert.equal(asked.status, "running", JSON.stringify(asked));
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Check the site." }] });
  let card: { id: string } | undefined;
  await waitFor(() => Boolean(card = (storage.current.metadata.pendingAppToolApprovals as any[] | undefined)?.find((approval) => approval.status === "pending")));
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "I need web access." && message.status === "done"));
  await settle();
  // The busy member's request is the main session's first; the task is its second.
  assert.equal(itemOf(storage.current, "main-id", 1)!.status, "running", "waits for the card, as before");
  await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: card!.id, approve: true, scope: "once" });
  await waitFor(() => Boolean(requestBy(storage.current, "main-id", 1)?.batch.autoResumeMessageId), 4000);
  await settle();
  const item = itemOf(storage.current, "main-id", 1)!;
  assert.equal(item.status, "answered", JSON.stringify({ item, own: requestBy(storage.current, "worker-id")?.batch }));
  assert.equal(replyText(storage.current, item.replyMessageId), "FINAL: the home page is up.");
  assert.equal(workerTurns(), 3);
  const woken = resumesOf(runs, "main-id").filter((run) => run.prompt.includes("Auto-resumed @main after member request.\nTarget replies"));
  assert.equal(woken.length, 1);
  assert.match(woken[0]!.prompt, /FINAL: the home page is up\./);
  releaseBusy();
  await waitFor(() => Boolean(requestBy(storage.current, "main-id", 0)?.batch.autoResumeMessageId));
});

test("a permission card raised in the turn the member was resumed in is not waited on: that turn's reply answers the task, as before this fix", async () => {
  const { service, storage, runs } = scenario({
    worker: async (turn, _prompt, ask) => {
      if (turn === 1) {
        await ask("main", "Which site?");
        return { ok: true, content: "Asked the main session." };
      }
      const actor = await memberActor(storage, "worker-id");
      const card = await service.requestPermissionChangeFromTool(actor, { kind: "portable", permissions: ["webAccess"] });
      assert.equal(card.status, "pending_user_approval", JSON.stringify(card));
      return { ok: true, content: "I need web access for that site." };
    }
  });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Check the site." }] });
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
  await settle();
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(item.status, "answered");
  assert.equal(replyText(storage.current, item.replyMessageId), "I need web access for that site.");
  assert.deepEqual(item.earlierReplyMessageIds?.map((id) => replyText(storage.current, id)), ["Asked the main session."]);
  assert.equal(resumesOf(runs, "main-id").length, 1);
});
test("a quit while the member's question waits on the User's card leaves the card to her, as after any finished turn; approved at the next start, the reply after the resume settles the task", async () => {
  const first = scenario({ workerPermissions: { requestParticipants: "ask" }, worker: asksMainThenAnswers });
  await first.service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  const pendingCard = (conversation: Conversation) => (conversation.metadata.pendingAppToolApprovals as any[] | undefined)
    ?.find((approval) => approval.requesterParticipantId === "worker-id" && approval.status === "pending");
  await waitFor(() => Boolean(pendingCard(first.storage.current)) &&
    first.storage.current.messages.some((message: ChatMessage) => message.participantId === "worker-id" && message.status === "done"));
  await settle();
  assert.equal(itemOf(first.storage.current, "main-id")!.status, "running");
  first.service.beginQuit();
  await first.service.endTurnsForQuit();
  await settle();
  assert.ok(pendingCard(first.storage.current), "the quit leaves the card open");
  assert.equal(itemOf(first.storage.current, "worker-id")!.status, "pending_approval");
  const stored = structuredClone(first.storage.current) as Conversation;
  endProcess(first.service);

  const next = testService({
    conversation: stored,
    run: async (participant, prompt) => participant.id === "worker-id"
      ? (assert.match(prompt, /Auto-resumed @worker/), ok(participant, "FINAL: blue (approved after restart)"))
      : ok(participant, prompt.includes("Which color") ? "blue" : "Noted.")
  });
  await chatParts(next.service).store.requireChat("conversation-1");
  await settle();
  assert.equal(itemOf(next.storage.current, "main-id")!.status, "running", "still waits at the next start");
  await next.service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: pendingCard(next.storage.current)!.id, approve: true, scope: "once" });
  await waitFor(() => Boolean(requestBy(next.storage.current, "main-id")?.batch.autoResumeMessageId), 4000);
  await settle();
  const item = itemOf(next.storage.current, "main-id")!;
  assert.equal(item.status, "answered");
  assert.equal(replyText(next.storage.current, item.replyMessageId), "FINAL: blue (approved after restart)");
  assert.equal(resumesOf(next.runs, "main-id").filter((run) => run.prompt.includes("Auto-resumed @main after member request.\nTarget replies")).length, 1);
});

test("a restart more than a day after the member's resume was cut short ends the task interrupted and wakes nobody", async () => {
  const conversation = machineMemberChat({ items: "answered", status: "resuming_requester", ageMs: 26 * 60 * 60_000, local: true });
  const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
  conversation.messages.push(
    { id: "resume-line", role: "system", content: "Auto-resumed @remote after member request.", createdAt: old, status: "done", metadata: { sourceMessageId: "own", parentMessageId: "own" } } as ChatMessage,
    { id: "cut", role: "participant", participantId: "remote-id", content: "", createdAt: old, status: "pending", metadata: { sourceMessageId: "resume-line", runId: "remote-run-2" } } as ChatMessage
  );
  const { service, storage, runs } = testService({ conversation });
  await chatParts(service).store.requireChat("conversation-1");
  await settle();
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(item.status, "interrupted");
  assert.equal(item.error, PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION);
  assert.equal(runs.length, 0, "nobody is resumed a day late");
  assert.equal(Object.values((storage.current.metadata.activeRunParticipantIdsByRunId ?? {}) as Record<string, string>).includes("remote-id"), false, "and the member is not shown working");
});

test("a turn the requester starts does not close its request whose member waits on its own question, even with no run of that member here", () => {
  const conversation = machineMemberChat({ items: "pending_approval", status: "pending_approval" });
  const { service } = testService({ conversation });
  const working = clone(conversation);
  chatParts(service).approvalDecisions.resolveSupersededParticipantInteractions(working, "main-id");
  assert.equal(working.messages.find((message) => message.id === "task")!.metadata!.participantRequest!.items[0]!.status, "running");
});

test("a resumed reply cut for a message delivered now ends the task as its first turn would: interrupted, not answered", async () => {
  const { service, storage } = scenario({
    worker: async (turn, _prompt, ask) => {
      if (turn === 1) {
        await ask("main", "Which color?");
        return { ok: true, content: "Asked." };
      }
      return { ok: true, content: "Half an answer", turnContinues: true } as Reply;
    }
  });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  await waitFor(() => itemOf(storage.current, "main-id")?.status === "interrupted");
  assert.equal(itemOf(storage.current, "main-id")!.error, PARTICIPANT_REQUEST_CUT_BY_SEND_NOW);
});

test("a member that only waits on its own question holds no update and can be restarted or moved, keeps a machine hosting the wait on, and still shows working with its Stop", async () => {
  let releaseAnswer: (() => void) | undefined;
  const answered = new Promise<void>((resolve) => { releaseAnswer = resolve; });
  const { service, storage } = scenario({ worker: asksMainThenAnswers, answer: async () => { await answered; return { ok: true, content: "blue" }; } });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.participantId === "worker-id" && message.status === "done"));
  await settle();
  const live = service.liveRunIds();
  const workerRuns = Object.entries((storage.current.metadata.activeRunParticipantIdsByRunId ?? {}) as Record<string, string>)
    .filter(([, participantId]) => participantId === "worker-id").map(([runId]) => runId);
  assert.equal(workerRuns.length, 1, "shown working, with a Stop");
  assert.equal(live.includes(workerRuns[0]!), false, "its wait is not live work: a restart arms it again");
  assert.equal(live.some((id) => id === `participant-request:${requestBy(storage.current, "main-id")!.message.id}`), false);
  assert.equal(chatParts(service).members.memberAnswersNow(storage.current, "worker-id"), false, "not answering: restart and move are allowed");
  // Another device (the member's machine) reads the same from the chat.
  assert.deepEqual([...readWaitOnlyRunIds(storage.current.metadata)], workerRuns, "the chat marks the wait");
  const elsewhere = testService({ conversation: mainSessionChat([mainSession()]) });
  assert.equal(chatParts(elsewhere.service).members.memberAnswersNow(structuredClone(storage.current), "worker-id"), false, "not answering on the device that does not wait either");
  assert.equal(service.hasWaitOnlyWork(), true, "a machine hosting the wait does not idle-stop");
  releaseAnswer!();
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
});

test("an own request nothing came of for a day ends the waiting task interrupted, never answered with the interim line", async () => {
  const conversation = machineMemberChat({ items: "answered", status: "answered", ageMs: 26 * 60 * 60_000, local: true });
  const { service, storage, runs } = testService({ conversation });
  // A sweep after the first look: the requester's device waits again, and finds nothing will come.
  await chatParts(service).store.requireChat("conversation-1");
  await waitFor(() => itemOf(storage.current, "main-id")?.status !== "running");
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(item.status, "interrupted");
  assert.equal(item.error, PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION);
  assert.equal(runs.filter((run) => run.participant.id === "remote-id").length, 0);
});

// --- review of cda7d0e8 (2026-11-28) ------------------------------------------

/** A worker whose resume after its own question waits behind a turn the
 *  User gave it meanwhile, until `release`. */
function resumeQueuedBehindUserTurn() {
  let releaseUserTurn!: () => void;
  const userTurnHeld = new Promise<void>((resolve) => { releaseUserTurn = resolve; });
  let releaseAnswer!: () => void;
  const answerHeld = new Promise<void>((resolve) => { releaseAnswer = resolve; });
  let userTurnStarted = false;
  // A Codex member: its turns go one after another (a Claude Code member
  // takes a message into its running turn).
  const chat = scenario({
    workerKind: "codex-cli",
    worker: async (turn, prompt, ask) => {
      if (turn === 1) {
        await ask("main", "Which color?");
        return { ok: true, content: "Asked." };
      }
      if (prompt.includes("Hold on")) { userTurnStarted = true; await userTurnHeld; return { ok: true, content: "Held turn done." }; }
      return { ok: true, content: "FINAL: blue" };
    },
    answer: async () => { await answerHeld; return { ok: true, content: "blue" }; }
  });
  return { ...chat, releaseUserTurn, releaseAnswer, userTurnStarted: () => userTurnStarted };
}

async function resumeRunQueued(chat: ReturnType<typeof resumeQueuedBehindUserTurn>): Promise<string> {
  await chat.service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  await waitFor(() => chat.storage.current.messages.some((message: ChatMessage) => message.content === "Asked." && message.status === "done"));
  // The User gives the worker a turn of her own while it waits; main answers meanwhile.
  await chat.service.sendMessage({ conversationId: "conversation-1", content: "Hold on", targetParticipantIds: ["worker-id"] } as any);
  await waitFor(() => chat.userTurnStarted());
  chat.releaseAnswer();
  await waitFor(() => requestBy(chat.storage.current, "worker-id")?.batch.items[0]?.status === "answered");
  // The worker's resume, asked and waiting behind the User's turn: a run of the worker's with no reply yet.
  const resumeRun = (): string | undefined => {
    const owners = (chat.storage.current.metadata.activeRunParticipantIdsByRunId ?? {}) as Record<string, string>;
    return ((chat.storage.current.metadata.activeRunIds ?? []) as string[]).find((runId) => (owners[runId] ?? "worker-id") === "worker-id" &&
      !chatParts(chat.service).activeRuns.waitOnlyRunIds.has(runId) && !chat.storage.current.messages.some((message: ChatMessage) => message.metadata?.runId === runId));
  };
  await waitFor(() => chat.storage.current.messages.some((message: ChatMessage) => message.role === "system" && message.content.startsWith("Auto-resumed @worker")) && Boolean(resumeRun()));
  const resumeRunId = resumeRun();
  return resumeRunId!;
}

test("a member's resume stopped while it waited its turn ends the task stopped, and its own request says stopped too", async () => {
  const chat = resumeQueuedBehindUserTurn();
  const resumeRunId = await resumeRunQueued(chat);
  assert.equal(chat.service.cancelRun(resumeRunId), true, resumeRunId);
  await waitFor(() => itemOf(chat.storage.current, "main-id")?.status === "interrupted", 5000).catch((error) => {
    throw new Error(`${error.message}\n${JSON.stringify({ task: itemOf(chat.storage.current, "main-id"), own: requestBy(chat.storage.current, "worker-id")?.batch })}`);
  });
  assert.equal(itemOf(chat.storage.current, "main-id")!.error, PARTICIPANT_REQUEST_STOPPED_BY_USER);
  // (Its status is its items' after any merge; its error and mark say stopped.)
  const own = requestBy(chat.storage.current, "worker-id")!.batch;
  assert.equal(own.requesterResumeEnded?.reason, "stopped");
  assert.equal(own.error, PARTICIPANT_REQUEST_STOPPED_BY_USER);
  chat.releaseUserTurn();
  await settle();
});

test("a quit that cuts a member's resume while it waited its turn leaves it to the next start: no failed or stopped mark", async () => {
  const chat = resumeQueuedBehindUserTurn();
  const resumeRunId = await resumeRunQueued(chat);
  chat.service.beginQuit();
  chat.service.cancelRun(resumeRunId);
  await settle();
  await settle();
  const own = requestBy(chat.storage.current, "worker-id")!.batch;
  assert.equal(own.requesterResumeEnded, undefined);
  assert.notEqual(own.status, "failed");
  assert.equal(itemOf(chat.storage.current, "main-id")!.status, "running", "the task outlives the quit");
  endProcess(chat.service);
  chat.releaseUserTurn();
});

test("a member's wait keeps a machine hosting it on while someone works on what it asked, not while all it waits on is the User's card", () => {
  const { service } = testService({ conversation: mainSessionChat([mainSession()]) });
  const runs = chatParts(service).activeRuns;
  runs.beginWaitOnly("request-1");
  assert.equal(runs.hasWaitOnlyWork(), true, "armed again after a restart, its run not begun yet");
  runs.beginWaitOnlyRun("wait-run", "request-1");
  assert.equal(runs.hasWaitOnlyWork(), true, "someone answers its question");
  runs.noteWaitOnlyOnUser("wait-run", true);
  assert.equal(runs.hasWaitOnlyWork(), false, "its question waits on the User's card: a weekend does not keep the machine on");
  runs.noteWaitOnlyOnUser("wait-run", false);
  assert.equal(runs.hasWaitOnlyWork(), true);
  runs.endWaitOnlyRun("wait-run");
  runs.endWaitOnly("request-1");
  assert.equal(runs.hasWaitOnlyWork(), false);
});

test("a member whose own question waits on the User's card does not keep a machine on; once she approves, it does", async () => {
  const { service, storage } = scenario({ workerPermissions: { requestParticipants: "ask" }, worker: asksMainThenAnswers });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  let card: { id: string } | undefined;
  await waitFor(() => Boolean(card = (storage.current.metadata.pendingAppToolApprovals as any[] | undefined)?.find((approval) => approval.status === "pending")) &&
    storage.current.messages.some((message: ChatMessage) => message.participantId === "worker-id" && message.status === "done"));
  await waitFor(() => !service.hasWaitOnlyWork());
  await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: card!.id, approve: true, scope: "once" });
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId));
  assert.equal(replyText(storage.current, itemOf(storage.current, "main-id")!.replyMessageId), "FINAL: blue");
});

test("a resume recorded as done stays done when what follows it fails", async () => {
  const { service, storage } = scenario({ worker: asksMainThenAnswers });
  const history = chatParts(service).chatHistory;
  const original = history.ensureHistoryFiles;
  history.ensureHistoryFiles = async (conversation: Conversation) => {
    if (conversation.messages.some((message) => message.content === "FINAL: blue")) throw new Error("disk full");
    return original(conversation);
  };
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Pick." }] });
  await waitFor(() => Boolean(requestBy(storage.current, "worker-id")?.batch.autoResumeMessageId));
  await settle();
  const own = requestBy(storage.current, "worker-id")!.batch;
  assert.equal(own.requesterResumeEnded, undefined);
  assert.equal(own.error, undefined);
  history.ensureHistoryFiles = original;
});

test("a task whose member waits on the User's permission card is not ended by a sweep while the card is open (it was, before)", async () => {
  // Another member at work keeps the sweep away only until it ends: then nothing runs, and the sweep looks.
  const { service, storage } = scenario({
    worker: async (turn) => {
      if (turn === 1) {
        const actor = await memberActor(storage, "worker-id");
        const card = await service.requestPermissionChangeFromTool(actor, { kind: "portable", permissions: ["webAccess"] });
        assert.equal(card.status, "pending_user_approval", JSON.stringify(card));
        return { ok: true, content: "I need web access." };
      }
      return { ok: true, content: "FINAL: checked with web access" };
    }
  });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Check the site." }] });
  let card: { id: string } | undefined;
  await waitFor(() => Boolean(card = (storage.current.metadata.pendingAppToolApprovals as any[] | undefined)?.find((approval) => approval.status === "pending")) &&
    storage.current.messages.some((message: ChatMessage) => message.content === "I need web access." && message.status === "done"));
  await chatParts(service).store.requireChat("conversation-1");
  await settle();
  assert.equal(itemOf(storage.current, "main-id")!.status, "running", "still waits for her card");
  await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: card!.id, approve: true, scope: "once" });
  await waitFor(() => itemOf(storage.current, "main-id")?.status === "answered", 4000);
  assert.equal(replyText(storage.current, itemOf(storage.current, "main-id")!.replyMessageId), "FINAL: checked with web access");
});

test("approved with nothing else running (a sweep ends the request as the card stops waiting), the turn after the card that asks someone itself still leads the task to its final answer", async () => {
  const { service, storage, runs, workerTurns } = scenario({
    answer: async (prompt) => ({ ok: true, content: prompt.includes("Which page?") ? "The home page." : "Noted." }),
    worker: async (turn, _prompt, ask) => {
      if (turn === 1) {
        const actor = await memberActor(storage, "worker-id");
        const card = await service.requestPermissionChangeFromTool(actor, { kind: "portable", permissions: ["webAccess"] });
        assert.equal(card.status, "pending_user_approval", JSON.stringify(card));
        return { ok: true, content: "I need web access." };
      }
      if (turn === 2) {
        await ask("main", "Which page?");
        return { ok: true, content: "Approved; I asked the main session which page." };
      }
      return { ok: true, content: "FINAL: the home page is up." };
    }
  });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Check the site." }] });
  let card: { id: string } | undefined;
  await waitFor(() => Boolean(card = (storage.current.metadata.pendingAppToolApprovals as any[] | undefined)?.find((approval) => approval.status === "pending")) &&
    storage.current.messages.some((message: ChatMessage) => message.content === "I need web access." && message.status === "done"));
  await settle();
  await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: card!.id, approve: true, scope: "once" });
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId), 4000);
  await settle();
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(item.status, "answered", JSON.stringify(item));
  assert.equal(replyText(storage.current, item.replyMessageId), "FINAL: the home page is up.");
  assert.equal(workerTurns(), 3);
  const woken = resumesOf(runs, "main-id").filter((run) => run.prompt.includes("Auto-resumed @main after member request.\nTarget replies"));
  assert.equal(woken.length, 1);
  assert.match(woken[0]!.prompt, /FINAL: the home page is up\./);
});

// --- /code-review of the fixes (2026-11-28) ------------------------------------

test("a member's resume the User's server gave another device counts once its reply is there: the wait follows that reply, not a day", () => {
  const conversation = machineMemberChat({ items: "answered", status: "completed" });
  assert.equal(ownRequestsAnswering(conversation, "remote-id", "task").open.length, 1, "no reply came back here yet");
  const now = new Date().toISOString();
  conversation.messages.push(
    { id: "resume-line", role: "system", content: "Auto-resumed @remote after member request.", createdAt: now, status: "done", metadata: { sourceMessageId: "own" } } as ChatMessage,
    { id: "resumed", role: "participant", participantId: "remote-id", content: "", createdAt: now, status: "pending", metadata: { sourceMessageId: "resume-line", runId: "remote-run-2" } } as ChatMessage
  );
  assert.equal(ownRequestsAnswering(conversation, "remote-id", "task").open.length, 0, "resumed on the other device");
  assert.equal(repliesAnswering(conversation, "remote-id", "task").running, true);
  const interim = conversation.messages.find((message) => message.id === "interim")!;
  assert.equal(memberWorksOnAfter(conversation, "remote-id", "task", interim), true, "its resumed turn still runs");
  Object.assign(conversation.messages.at(-1)!, { status: "done", content: "FINAL: blue" });
  assert.equal(memberWorksOnAfter(conversation, "remote-id", "task", interim), true, "its later reply answers");
});

test("a restart that will not resume one of the member's questions leaves the task to another question still out, and ends it when none is", () => {
  const twoOut = machineMemberChat({ items: "answered", status: "answered", local: true });
  const own = twoOut.messages.find((message) => message.id === "own")!;
  const second = structuredClone(own);
  second.id = "own-2";
  second.metadata!.participantRequest = { ...second.metadata!.participantRequest!, id: "own-batch-2", status: "running",
    items: [{ ...second.metadata!.participantRequest!.items[0]!, status: "running", replyMessageId: undefined }] };
  twoOut.messages.push(second);
  assert.equal(endWaitOnUnresumedOwnRequest(twoOut, "own"), undefined, "its other question still resumes it");
  assert.equal(itemOf(twoOut, "main-id")!.status, "running");

  const oneOut = machineMemberChat({ items: "answered", status: "answered", local: true });
  assert.ok(endWaitOnUnresumedOwnRequest(oneOut, "own"));
  assert.equal(itemOf(oneOut, "main-id")!.status, "interrupted");
});

test("a member whose question is answered and only its resume is left keeps a machine hosting the wait on", async () => {
  const answered = testService({ conversation: machineMemberChat({ items: "answered", status: "resuming_requester" }) });
  await chatParts(answered.service).store.requireChat("conversation-1");
  await waitFor(() => Object.values((answered.storage.current.metadata.activeRunParticipantIdsByRunId ?? {}) as Record<string, string>).includes("remote-id"));
  await settle();
  assert.equal(answered.service.hasWaitOnlyWork(), true, "its resume is about to run");
  endProcess(answered.service);
  // One whose question awaits the User's card does not: the test above with a real card.
});
