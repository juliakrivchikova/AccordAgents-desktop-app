import assert from "node:assert/strict";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { PARTICIPANT_REQUEST_CUT_BY_SEND_NOW } from "./chat/constants";
import { delegationGroupResumeText } from "./chat/requests/delegationGroups";
import { chatParticipant, selfCompactingChat, waitFor } from "./chat/test/compactionFixtures";

const ASKS = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) };

/** A worker busy with a long turn (Antigravity unless said: a CLI that cannot
 *  take a message mid-turn), a request that waits for it, and a correction
 *  delivered now. */
function busyWorkerChat(kind: "gemini-cli" | "codex-cli" = "gemini-cli") {
  const queued = chatParticipant({ id: "asker-queued", handle: "queued", ...ASKS });
  const urgent = chatParticipant({ id: "asker-urgent", handle: "urgent", ...ASKS });
  const boss = chatParticipant({ id: "asker-boss", handle: "boss", ...ASKS });
  let releaseLong!: () => void;
  const results: Record<string, any> = {};
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker", kind },
    others: [queued, urgent, boss],
    turn: async ({ participantId, prompt, actor, service, call, signal, options }) => {
      if (participantId === "asker-boss") {
        if (call === 1) results.boss = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Build the old variant" }] });
        return call === 1 ? "Asked." : "Noted.";
      }
      if (participantId === "asker-queued") {
        if (call === 1) results.queued = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Queued question" }] });
        return "Asked.";
      }
      if (participantId === "asker-urgent") {
        if (call === 1) results.urgent = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Urgent correction" }], deliver: "now" });
        return "Asked now.";
      }
      if (call === 1) {
        // The long turn: it ends only when it is cut, or steered (Codex
        // ends the reply so far there), or the test lets it.
        const steered = await new Promise<boolean>((resolve) => {
          releaseLong = () => resolve(false);
          results.steer = () => resolve(true);
          signal?.addEventListener("abort", () => resolve(false), { once: true });
        });
        return steered ? { content: "Half of the old variant.", turnContinues: true } : "Half of the old variant.";
      }
      // A Codex member is steered (or told it could not be) by its runner.
      const steer = options.steerIntoRunningTurn as ((outcome: "steered" | "not-steered") => void) | undefined;
      if (steer) {
        steer(results.refuseSteer ? "not-steered" : "steered");
        if (!results.refuseSteer) results.steer?.();
      }
      return /Urgent correction/.test(prompt) ? "Took the correction." : /Queued question/.test(prompt) ? "Answered the queued question." : "Other.";
    }
  });
  // Only the chat's main session delivers now.
  chat.storage.current.metadata.mainSessionParticipantId = "asker-urgent";
  return { chat, results, releaseLong: () => releaseLong?.() };
}

test("deliver now cuts a busy member's running turn and runs the request next, before the request that waited; what the cut turn wrote stays", async () => {
  const { chat, results } = busyWorkerChat();
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "long-run", content: "@boss have worker build the old variant" });
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "worker").length === 1, 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "queued-run", content: "@queued ask worker" });
  await waitFor(() => results.queued?.status === "running", 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "urgent-run", content: "@urgent tell worker now" });
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "worker").length === 3, 8_000);

  assert.deepEqual(results.urgent.delivery, [{
    target: "@worker",
    way: "interrupted-and-restarted",
    note: "@worker is working, and Antigravity cannot take a message in the middle of a turn: its running turn is interrupted (what it wrote stays, as after a Stop) and it goes on at once in the same session with this request. Work that was waiting for it runs after."
  }]);
  const workerPrompts = chat.prompts.filter((item) => item.participantId === "worker").map((item) => item.prompt);
  assert.match(workerPrompts[1], /Urgent correction/, "the request delivered now runs right after the cut turn");
  assert.match(workerPrompts[2], /Queued question/, "the request that waited is not lost: it runs after");

  const cut = chat.storage.current.messages.find((message: any) => message.content === "Half of the old variant.");
  assert.equal(cut.status, "done");
  assert.equal(cut.metadata.turnContinues, true, "cut for the message, never stopped by user");
  assert.notEqual(cut.metadata.terminalReason, "user-stopped");
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
  const batches = chat.storage.current.messages.map((message: any) => message.metadata?.participantRequest).filter(Boolean);
  const itemOf = (prompt: string): any => batches.flatMap((batch: any) => batch.items).find((item: any) => item.prompt === prompt);
  assert.equal(itemOf("Urgent correction").status, "answered");
  assert.equal(itemOf("Queued question").status, "answered");
  assert.equal(itemOf("Build the old variant").status, "interrupted");
  // Its requester is told why the reply it gets back ended early.
  const resume = chat.storage.current.messages.find((message: any) => message.role === "system" && message.content.startsWith("Auto-resumed @boss after member request."));
  assert.match(resume.content, /\n@worker: Interrupted before it finished: the member was sent a message to take now/);
  assert.equal(chat.debugEvents.some(({ event, payload }) => event === "chat.deliver-now" && (payload.cutRunIds as string[] | undefined)?.length === 1), true);
});

for (const refuseSteer of [false, true]) {
  test(refuseSteer
    ? "a Codex member that cannot be steered has its running turn cut instead, and takes the request next"
    : "deliver now steers a busy Codex member's running turn: the reply so far goes on in the request's reply, nothing is cut", async () => {
    const { chat, results } = busyWorkerChat("codex-cli");
    results.refuseSteer = refuseSteer;
    await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "long-run", content: "@boss have worker build the old variant" });
    await waitFor(() => chat.prompts.filter((item) => item.participantId === "worker").length === 1, 5_000);
    await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "urgent-run", content: "@urgent tell worker now" });
    await waitFor(() => results.urgent !== undefined, 5_000);
    assert.equal(results.urgent.delivery?.[0]?.way, "into-running-turn");
    assert.match(results.urgent.delivery?.[0]?.note, /as a message typed into Codex mid-turn \(Codex steers the turn with it\)/);
    await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
    const cut = chat.storage.current.messages.find((message: any) => message.content === "Half of the old variant.");
    assert.equal(cut.metadata.turnContinues, true);
    assert.notEqual(cut.metadata.terminalReason, "user-stopped");
    const items = chat.storage.current.messages.map((message: any) => message.metadata?.participantRequest).filter(Boolean).flatMap((batch: any) => batch.items);
    assert.equal(items.find((item: any) => item.prompt === "Build the old variant").status, "interrupted");
    assert.equal(items.find((item: any) => item.prompt === "Urgent correction").status, "answered");
    const said = chat.debugEvents.filter(({ event }) => event === "chat.deliver-now").map(({ payload }) => payload.way);
    assert.deepEqual(said, refuseSteer ? ["interrupt-and-restart"] : ["steered"]);
  });
}

test("deliver now to a member that is not working just starts it, and says so", async () => {
  const urgent = chatParticipant({ id: "asker-urgent", handle: "urgent", ...ASKS });
  let result: any;
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker" },
    others: [urgent],
    turn: async ({ participantId, actor, service, call }) => {
      if (participantId === "asker-urgent" && call === 1) {
        result = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Urgent correction" }], deliver: "now" });
      }
      return "Done.";
    }
  });
  chat.storage.current.metadata.mainSessionParticipantId = "asker-urgent";
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "urgent-run", content: "@urgent tell worker now" });
  await waitFor(() => chat.prompts.some((item) => item.participantId === "worker"), 5_000);
  assert.deepEqual(result.delivery, [{ target: "@worker", way: "started", note: "@worker was not working: it starts on the request now." }]);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
});

test("deliver set on one request (as members write it) applies to that target", async () => {
  const urgent = chatParticipant({ id: "asker-urgent", handle: "urgent", ...ASKS });
  let result: any;
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker" },
    others: [urgent],
    turn: async ({ participantId, actor, service, call }) => {
      if (participantId === "asker-urgent" && call === 1) {
        result = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Urgent correction", deliver: "now" }] });
      }
      return "Done.";
    }
  });
  chat.storage.current.metadata.mainSessionParticipantId = "asker-urgent";
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "urgent-run", content: "@urgent tell worker now" });
  await waitFor(() => result !== undefined, 5_000);
  assert.equal(result.delivery?.[0]?.way, "started");
  const batch = chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest)!.metadata.participantRequest;
  assert.equal(batch.items[0].deliver, "now");
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
});

test("only the main session delivers now: another member's request waits its turn, and the tool says so", async () => {
  const { chat, results } = busyWorkerChat();
  chat.storage.current.metadata.mainSessionParticipantId = undefined;
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "long-run", content: "@boss have worker build the old variant" });
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "worker").length === 1, 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "urgent-run", content: "@urgent tell worker now" });
  await waitFor(() => results.urgent !== undefined, 5_000);
  assert.equal(results.urgent.delivery, undefined);
  assert.equal(results.urgent.deliverRefused, "Only the chat's main session delivers a request now: this one waits its turn, as without deliver.");
  assert.equal(chat.debugEvents.some(({ event }) => event === "chat.deliver-now"), false);
  const batch = chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest?.items[0]?.prompt === "Urgent correction")!.metadata.participantRequest;
  assert.equal(batch.items[0].deliver, undefined);
  assert.equal(chat.prompts.filter((item) => item.participantId === "worker").length, 1, "the running turn is not cut");
});

test("deliver takes queue or now only", async () => {
  const urgent = chatParticipant({ id: "asker-urgent", handle: "urgent", ...ASKS });
  let error: unknown;
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker" },
    others: [urgent],
    turn: async ({ participantId, actor, service, call }) => {
      if (participantId === "asker-urgent" && call === 1) {
        error = (await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "x" }], deliver: "soon" })).error;
      }
      return "Done.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "urgent-run", content: "@urgent ask" });
  await waitFor(() => error !== undefined, 5_000);
  assert.equal(error, "deliver is \"queue\" or \"now\".");
});

test("a Claude Code member takes a request delivered now in its live CLI: the CLI's own send-now once the message is written", async () => {
  const { chat } = busyWorkerChat();
  const parts = chatParts(chat.service);
  const asked: unknown[][] = [];
  chatDependencies(chat.service).cliRunner.memberClaudeSendNow = async (...args: unknown[]) => {
    asked.push(args);
    return "delivering";
  };
  await parts.runCancel.deliverNow("chat-compact", "worker", "forced-run", "into-running-turn");
  assert.deepEqual(asked, [["chat-compact", "worker", "forced-run", undefined]]);
  // A process that has not said yet what it can do is asked again while the
  // message waits.
  const outcomes: string[] = ["unsupported", "unsupported", "stopped"];
  asked.length = 0;
  chatDependencies(chat.service).cliRunner.memberClaudeSendNow = async (...args: Array<string | undefined>) => {
    asked.push(args);
    return outcomes.shift();
  };
  const controller = new AbortController();
  parts.activeRuns.chatRunControllers.set("forced-run", new Set([controller]));
  await parts.runCancel.deliverNow("chat-compact", "worker", "forced-run", "into-running-turn");
  assert.equal(asked.length, 3);
  assert.equal(chat.debugEvents.some(({ event, payload }) => event === "chat.deliver-now" && payload.outcome === "stopped" && payload.tries === 3), true);
  parts.activeRuns.chatRunControllers.delete("forced-run");
  assert.equal(chat.debugEvents.some(({ event, payload }) => event === "chat.deliver-now" && payload.outcome === "delivering"), true);

  const claude = chatParticipant({ id: "claude-worker", handle: "cw", kind: "claude-code" });
  const forced = (deliver?: "now") => ({ id: "m", role: "participant", content: "", createdAt: "", metadata: { participantRequest: { items: [
    { targetParticipantId: "claude-worker", deliver }, { targetParticipantId: "codex-admin", deliver }
  ] } } }) as never;
  assert.equal(parts.turnQueue.deliveryPriority(claude, forced("now")), "live");
  assert.equal(parts.turnQueue.deliveryPriority(chatParticipant({ kind: "gemini-cli" }), forced("now")), "next");
  assert.equal(parts.turnQueue.deliveryPriority(claude, forced()), undefined);
});

test("the main session's task cut for a message to take now says so when it resumes the main session", () => {
  const item = { targetParticipantId: "worker", targetHandle: "worker", prompt: "Build it", status: "interrupted", error: PARTICIPANT_REQUEST_CUT_BY_SEND_NOW, replyMessageId: "reply", createdAt: "", updatedAt: "" };
  const text = delegationGroupResumeText({ messages: [] } as never, chatParticipant({ handle: "main" }), [{ message: {} as never, batch: { items: [item] } as never }]);
  assert.match(text, /- @worker \(task "Build it"\): interrupted \(message reply\): Interrupted before it finished: the member was sent a message to take now/);
});
