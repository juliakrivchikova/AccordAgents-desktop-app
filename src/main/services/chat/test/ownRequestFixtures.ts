import assert from "node:assert/strict";
import { chatParts } from "./chatParts";
import type { ChatMessage, ChatParticipantRequestBatch, ChatParticipantRequestItem, Conversation, ParticipantConfig } from "../../../../shared/types";
import { GENERIC_ROLE, mainSession, mainSessionChat, member, permissions, resumesOf, sessionRecord, testService, waitFor } from "./mainSessionFixtures";

// A main session, a worker that asks someone itself with
// app_chat_request_participants (resumeRequester) and ends its turn to wait,
// and the chat a member on a cloud machine leaves after doing so
// (chat.mainSession.ownRequests.test.ts).

export type Reply = { ok: boolean; content?: string; error?: string; turnContinues?: boolean };
/** The member's own request: one target, or several in one request (a turn
 *  has one request out at a time). */
export type Ask = (target: string | string[], prompt: string) => Promise<Record<string, unknown>>;
export type Service = ReturnType<typeof testService>;

export const ok = (participant: ParticipantConfig, content: string) => ({ participant, ok: true, content, durationMs: 1 });

/** The member's turn running now, as its app tools see it. */
export async function memberActor(storage: Service["storage"], participantId: string): Promise<any> {
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

export const batches = (conversation: Conversation): Array<{ message: ChatMessage; batch: ChatParticipantRequestBatch }> =>
  conversation.messages.flatMap((message) => message.metadata?.participantRequest ? [{ message, batch: message.metadata.participantRequest }] : []);
export const requestBy = (conversation: Conversation, requesterId: string, nth = 0) =>
  batches(conversation).filter((entry) => entry.batch.requesterParticipantId === requesterId)[nth];
export const itemOf = (conversation: Conversation, requesterId: string, nth = 0): ChatParticipantRequestItem | undefined =>
  requestBy(conversation, requesterId, nth)?.batch.items[0];
export const replyText = (conversation: Conversation, id: string | undefined) => conversation.messages.find((message) => message.id === id)?.content;
export const taskEnded = (runs: Service["runs"]) => resumesOf(runs, "main-id").filter((run) => /task(s)? you gave/.test(run.prompt));
export const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/** The old process of a quit test: what still runs in it ends, as it would
 *  with the process (its waits would keep the test runner alive). */
export function endProcess(service: Service["service"]): void {
  for (const runId of [...chatParts(service).activeRuns.chatRunControllers.keys()]) service.cancelRun(runId);
}

/**
 * A chat with a main session and a worker. The worker answers each turn it
 * gets with `worker(turn, prompt)`: it may ask with `ask` (its own request,
 * resumeRequester) before its reply. The main session answers questions with
 * `answer(prompt)`, and anything else with "Noted.".
 */
export function scenario(options: {
  worker: (turn: number, prompt: string, ask: Ask) => Promise<Reply>;
  answer?: (prompt: string, signal?: AbortSignal) => Promise<Reply>;
  workerPermissions?: Parameters<typeof permissions>[0];
  workerKind?: "claude-code" | "codex-cli";
  others?: ReturnType<typeof member>[];
  othersRun?: (participant: ParticipantConfig) => Promise<string>;
}) {
  const main = mainSession("claude-code", { model: "sonnet" });
  const worker = member("worker-id", "worker", { kind: options.workerKind ?? "claude-code", ...(options.workerKind === "codex-cli" ? {} : { model: "sonnet" }),
    permissions: permissions({ requestParticipants: "allow", ...options.workerPermissions }) });
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
export const asksMainThenAnswers = async (turn: number, prompt: string, ask: Ask): Promise<Reply> => {
  if (turn === 1) {
    await ask("main", "Which color, red or blue?");
    return { ok: true, content: "I asked the main session; I go on once it answers." };
  }
  assert.match(prompt, /Auto-resumed @\S+ after member request/);
  return { ok: true, content: "FINAL: blue" };
};

/** A chat whose main session (here) asked a member on machine-1, which ended
 *  its turn after asking the main session itself: stored as the machine
 *  writes it. `own` is how the member's own request stands. */
export function machineMemberChat(own: { items: "answered" | "denied" | "pending_approval"; status: ChatParticipantRequestBatch["status"]; ageMs?: number; local?: boolean }): Conversation {
  const age = own.ageMs ?? 60_000;
  const at = new Date(Date.now() - age).toISOString();
  const later = new Date(Date.now() - age + 30_000).toISOString();
  const main = mainSession("claude-code", { model: "sonnet" });
  const remote = member("remote-id", "remote", { kind: "claude-code", ...(own.local ? {} : { homeMachineId: "machine-1" }), permissions: permissions({ requestParticipants: "allow" }) });
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
