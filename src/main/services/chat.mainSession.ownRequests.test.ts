import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { chatParticipant, selfCompactingChat, waitFor as waitLong } from "./chat/test/compactionFixtures";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { sessionsTaskReplyLine, sessionsTaskStatus } from "../../shared/mainSessionView";
import type { ChatMessage, ChatParticipantRequestBatch, ChatParticipantRequestItem, Conversation, ParticipantConfig } from "../../shared/types";
import { PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION, PARTICIPANT_REQUEST_STOPPED_BY_USER } from "./chat/constants";
import {
  GENERIC_ROLE, mainActor, mainSession, mainSessionChat, member, NOW, permissions, resumesOf, sessionRecord, testService, waitFor
} from "./chat/test/mainSessionFixtures";
import { messagesById, ownRequestsAnswering, permissionCardAnswering, requestAnsweredByTurn } from "./chat/requests/ownRequests";
import { permissionApprovalResumeRunId } from "./chat/approvals/approvalRecords";
import { markParticipantRequestAutoResumeFailed } from "./chat/requests/requestRecords";

// A member that asks the main session (or anyone) something while it works
// on a request, with app_chat_request_participants and the default
// resumeRequester, and ends its turn to wait: its task is not over until the
// turn it is resumed in with the answer ends (2026-11-27).

type Reply = { ok: boolean; content?: string; error?: string };
/** The member's own request: one target, or several in one request (a turn
 *  has one request out at a time). */
type Ask = (target: string | string[], prompt: string) => Promise<Record<string, unknown>>;
type Service = ReturnType<typeof testService>;

const ok = (participant: ParticipantConfig, content: string) => ({ participant, ok: true, content, durationMs: 1 });

/** The member's turn running now, as its app tools see it. */
async function memberActor(storage: Service["storage"], participantId: string): Promise<any> {
  let pending: ChatMessage | undefined;
  await waitFor(() => Boolean(pending = storage.current.messages.filter((message: ChatMessage) => message.participantId === participantId && message.status === "pending").at(-1)));
  const metadata = pending!.metadata!;
  return {
    conversationId: "conversation-1",
    participantId,
    roleConfigId: GENERIC_ROLE.id,
    roleConfigVersion: 1,
    capabilities: ["participants.request", "permissions.request"],
    triggerMessageId: metadata.sourceMessageId,
    triggerThreadId: metadata.threadId,
    runId: metadata.runId,
    turnSegmentId: metadata.turnSegmentId,
    participantRequestBatchId: metadata.participantRequestBatchId,
    participantRequestDepth: metadata.participantRequestDepth ?? 1
  };
}

const batches = (conversation: Conversation): Array<{ message: ChatMessage; batch: ChatParticipantRequestBatch }> =>
  conversation.messages.flatMap((message) => message.metadata?.participantRequest ? [{ message, batch: message.metadata.participantRequest }] : []);
const requestBy = (conversation: Conversation, requesterId: string, nth = 0) =>
  batches(conversation).filter((entry) => entry.batch.requesterParticipantId === requesterId)[nth];
const itemOf = (conversation: Conversation, requesterId: string, nth = 0): ChatParticipantRequestItem | undefined =>
  requestBy(conversation, requesterId, nth)?.batch.items[0];
const replyText = (conversation: Conversation, id: string | undefined) => conversation.messages.find((message) => message.id === id)?.content;
const taskEnded = (runs: Service["runs"]) => resumesOf(runs, "main-id").filter((run) => /task(s)? you gave/.test(run.prompt));
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/** The old process of a quit test: what still runs in it ends, as it would
 *  with the process (its waits would keep the test runner alive). */
function endProcess(service: Service["service"]): void {
  for (const runId of [...chatParts(service).activeRuns.chatRunControllers.keys()]) service.cancelRun(runId);
}

/**
 * A chat with a main session and a worker. The worker answers each turn it
 * gets with `worker(turn, prompt)`: it may ask with `ask` (its own request,
 * resumeRequester) before its reply. The main session answers questions with
 * `answer(prompt)`, and anything else with "Noted.".
 */
function scenario(options: {
  worker: (turn: number, prompt: string, ask: Ask) => Promise<Reply>;
  answer?: (prompt: string, signal?: AbortSignal) => Promise<Reply>;
  workerPermissions?: Parameters<typeof permissions>[0];
  others?: ReturnType<typeof member>[];
  othersRun?: (participant: ParticipantConfig) => Promise<string>;
}) {
  const main = mainSession("claude-code", { model: "sonnet" });
  const worker = member("worker-id", "worker", { kind: "claude-code", model: "sonnet", permissions: permissions({ requestParticipants: "allow", ...options.workerPermissions }) });
  const conversation = mainSessionChat([main, worker, ...(options.others ?? [])], { participantSessions: [sessionRecord(main, "main-thread")] });
  let workerTurns = 0;
  const box: { service?: Service } = {};
  const service = testService({
    conversation,
    run: async (participant, prompt, _options, signal) => {
      const isOther = options.others?.some((other) => other.id === participant.id) ?? false;
      // The worker, or a member the main session made for a task.
      if (participant.id !== "main-id" && !isOther) {
        workerTurns += 1;
        const turn = workerTurns;
        const ask: Ask = async (target, question) => {
          const actor = await memberActor(box.service!.storage, participant.id);
          const targets = Array.isArray(target) ? target : [target];
          const asked = await box.service!.service.requestParticipantsFromTool(actor, { requests: targets.map((handle) => ({ target: handle, prompt: question })) });
          assert.ok(asked.status === "running" || asked.status === "pending_approval", JSON.stringify(asked));
          return asked;
        };
        const result = await options.worker(turn, prompt, ask);
        return { participant, durationMs: 1, ...result };
      }
      if (participant.id === "main-id" && !prompt.includes("Auto-resumed @main")) {
        const answered = options.answer ? await options.answer(prompt, signal) : { ok: true, content: "blue" };
        return { participant, durationMs: 1, ...answered };
      }
      if (isOther) return ok(participant, options.othersRun ? await options.othersRun(participant) : `Answer from ${participant.id}.`);
      return ok(participant, "Noted.");
    }
  });
  box.service = service;
  return { ...service, workerTurns: () => workerTurns };
}

/** The usual member: asks the main session, ends its turn, answers once resumed. */
const asksMainThenAnswers = async (turn: number, prompt: string, ask: Ask): Promise<Reply> => {
  if (turn === 1) {
    await ask("main", "Which color, red or blue?");
    return { ok: true, content: "I asked the main session; I go on once it answers." };
  }
  assert.match(prompt, /Auto-resumed @\S+ after member request/);
  return { ok: true, content: "FINAL: blue" };
};

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

/** A chat whose main session (here) asked a member on machine-1, which ended
 *  its turn after asking the main session itself: stored as the machine
 *  writes it. `own` is how the member's own request stands. */
function machineMemberChat(own: { items: "answered" | "denied"; status: ChatParticipantRequestBatch["status"] }): Conversation {
  const at = new Date(Date.now() - 60_000).toISOString();
  const later = new Date(Date.now() - 30_000).toISOString();
  const main = mainSession("claude-code", { model: "sonnet" });
  const remote = member("remote-id", "remote", { kind: "claude-code", homeMachineId: "machine-1", permissions: permissions({ requestParticipants: "allow" }) });
  const conversation = mainSessionChat([main, remote], { participantSessions: [sessionRecord(main, "main-thread")] });
  const item = (target: string, handle: string, status: ChatParticipantRequestItem["status"], replyMessageId?: string): ChatParticipantRequestItem =>
    ({ targetParticipantId: target, targetHandle: handle, prompt: "…", status, createdAt: at, updatedAt: later, ...(replyMessageId ? { replyMessageId } : {}) });
  conversation.messages.push(
    { id: "task", role: "participant", participantId: "main-id", content: "@remote Pick a color.", createdAt: at, status: "done",
      metadata: { sourceMessageId: "user-message", participantRequest: { id: "task-batch", requesterParticipantId: "main-id", requesterHandle: "main", source: "mcp", resumeRequester: true,
        status: "running", depth: 1, requesterDepth: 0, chainRootId: "user-message", createdAt: at, updatedAt: at, triggerMessageId: "user-message", requesterTurnSegmentId: "main-turn",
        items: [item("remote-id", "remote", "running", "interim")] } } } as ChatMessage,
    { id: "interim", role: "participant", participantId: "remote-id", content: "I asked the main session.", createdAt: at, status: "done",
      metadata: { sourceMessageId: "task", runId: "remote-run-1", turnSegmentId: "remote-turn-1" } } as ChatMessage,
    { id: "own", role: "participant", participantId: "remote-id", content: "@main Which color?", createdAt: later, status: "done",
      metadata: { sourceMessageId: "task", participantRequest: { id: "own-batch", requesterParticipantId: "remote-id", requesterHandle: "remote", source: "mcp", resumeRequester: true,
        status: own.status, depth: 2, requesterDepth: 1, chainRootId: "user-message", createdAt: later, updatedAt: later, triggerMessageId: "task", requesterTurnSegmentId: "remote-turn-1",
        items: [item("main-id", "main", own.items, own.items === "answered" ? "main-answer" : undefined)] } } } as ChatMessage
  );
  if (own.items === "answered") {
    conversation.messages.push({ id: "main-answer", role: "participant", participantId: "main-id", content: "blue", createdAt: later, status: "done",
      metadata: { sourceMessageId: "own", runId: "main-run-2" } } as ChatMessage);
  }
  return conversation;
}

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

test("a permission card raised in the turn the member was resumed in keeps the task waiting; the reply after its approval answers", async () => {
  const { service, storage, runs, workerTurns } = scenario({
    worker: async (turn, _prompt, ask) => {
      if (turn === 1) {
        await ask("main", "Which site?");
        return { ok: true, content: "Asked the main session." };
      }
      if (turn === 2) {
        const actor = await memberActor(storage, "worker-id");
        const card = await service.requestPermissionChangeFromTool(actor, { kind: "portable", permissions: ["webAccess"] });
        assert.equal(card.status, "pending_user_approval", JSON.stringify(card));
        return { ok: true, content: "I need web access for that site." };
      }
      return { ok: true, content: "FINAL: the site is up." };
    }
  });
  await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), { requests: [{ target: "worker", prompt: "Check the site." }] });
  let card: { id: string } | undefined;
  await waitFor(() => Boolean(card = (storage.current.metadata.pendingAppToolApprovals as any[] | undefined)?.find((approval) => approval.status === "pending")));
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "I need web access for that site." && message.status === "done"));
  await settle();
  assert.equal(itemOf(storage.current, "main-id")!.status, "running", "waits for the card");
  assert.equal(resumesOf(runs, "main-id").length, 0);
  await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: card!.id, approve: true, scope: "once" });
  await waitFor(() => Boolean(requestBy(storage.current, "main-id")?.batch.autoResumeMessageId), 4000);
  await settle();
  const item = itemOf(storage.current, "main-id")!;
  assert.equal(item.status, "answered");
  assert.equal(replyText(storage.current, item.replyMessageId), "FINAL: the site is up.");
  assert.equal(workerTurns(), 3);
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

test("an approved permission card holds the task only until its resumed turn begins, or a minute at most", () => {
  const conversation = machineMemberChat({ items: "answered", status: "completed" });
  const at = Date.now();
  conversation.metadata.pendingAppToolApprovals = [{
    id: "card", conversationId: "conversation-1", requesterParticipantId: "remote-id", requesterHandle: "remote", requesterRoleConfigId: GENERIC_ROLE.id,
    toolName: "app_permissions_request_change", capability: "permissions.request", status: "approved", request: { kind: "portable", permissions: ["webAccess"] },
    summary: "Grant @remote web access", createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
    resumeContext: { runId: "remote-run-1", triggerMessageId: "task", participantRequestBatchId: "task-batch" }
  }] as any;
  const byId = messagesById(conversation);
  assert.equal(permissionCardAnswering(conversation, "remote-id", "task", byId, at + 30_000), true, "approved, its turn not begun");
  assert.equal(permissionCardAnswering(conversation, "remote-id", "task", byId, at + 61_000), false, "its turn never began");
  conversation.messages.push({ id: "resumed", role: "participant", participantId: "remote-id", content: "", createdAt: new Date(at).toISOString(), status: "pending",
    metadata: { sourceMessageId: "task", runId: permissionApprovalResumeRunId("card") } } as ChatMessage);
  assert.equal(permissionCardAnswering(conversation, "remote-id", "task", messagesById(conversation), at + 30_000), false, "its turn began: that reply holds it now");
});
