import assert from "node:assert/strict";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { chatParts } from "./chat/test/chatParts";
import { acceptedMessage, chatParticipant, fakeServerLink, selfCompactingChat, waitFor } from "./chat/test/compactionFixtures";

const ALLOWED = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" }) };
const ASKS = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) };

/** A member that asks to compact its own context while a request from
 *  another member already waits for it. */
function compactingWithRequestWaiting(compaction: Record<string, unknown>) {
  const asker = chatParticipant({ id: "asker", handle: "asker", ...ASKS });
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const results: Record<string, any> = {};
  const chat = selfCompactingChat({
    participant: ALLOWED,
    others: [asker],
    turn: async ({ participantId, prompt, actor, service, call }) => {
      if (participantId === "asker") {
        if (call === 1) results.asked = await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: "Queued question" }] });
        return call === 1 ? "Asked admin." : "Thanks.";
      }
      if (call === 1) {
        await first;
        results.compaction = await service.requestSelfCompactionFromTool(actor, compaction);
        return "Stage one is done.";
      }
      return /Queued question/.test(prompt) ? "Answered the queued question." : "Went on with stage two.";
    }
  });
  return { chat, results, releaseFirst };
}

async function startWithRequestWaiting(chat: ReturnType<typeof selfCompactingChat>, results: Record<string, any>, releaseFirst: () => void): Promise<void> {
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin do both stages" });
  await waitFor(() => chat.prompts.some((item) => item.participantId === "codex-admin"), 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "asker-run", content: "@asker ask admin" });
  await waitFor(() => results.asked?.status === "running", 5_000);
  releaseFirst();
}

test("a member's own compaction asked mid-turn runs as soon as its reply ends, and the turn it goes on in right after, before a request that waited", async () => {
  const { chat, results, releaseFirst } = compactingWithRequestWaiting({ instructions: "Stage two." });
  await startWithRequestWaiting(chat, results, releaseFirst);
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "codex-admin").length === 3, 8_000);
  assert.equal(results.compaction.status, "queued");
  assert.equal(results.compaction.afterCompaction, "called-again-to-go-on");
  assert.match(results.compaction.next, /^End your reply now: .*make no more tool calls\. The compaction runs as soon as this reply ends, before anything waiting for you/);
  assert.deepEqual(chat.order.filter((entry) => entry.endsWith("codex-admin")), ["turn codex-admin", "compact codex-admin", "turn codex-admin", "turn codex-admin"]);
  const admin = chat.prompts.filter((item) => item.participantId === "codex-admin").map((item) => item.prompt);
  assert.match(admin[1], /goes on after the compaction it asked for/);
  assert.match(admin[2], /Queued question/, "the request that waited runs after the turn that goes on");
  const events = chat.debugEvents.map(({ event }) => event).filter((event) => event === "chat.compaction.finished" || event === "chat.self-compaction.resumed");
  assert.deepEqual(events, ["chat.compaction.finished", "chat.self-compaction.resumed"]);
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
});

test("a member that says its work is done is not called again after its compaction: the request that waited runs next", async () => {
  const { chat, results, releaseFirst } = compactingWithRequestWaiting({ instructions: "Nothing left.", workDone: true });
  await startWithRequestWaiting(chat, results, releaseFirst);
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "codex-admin").length === 2, 8_000);
  assert.match(results.compaction.next, /You said your work is done, so the app does not call you again to go on; requests waiting for you come next\./);
  assert.equal(results.compaction.afterCompaction, "not-called-again");
  assert.deepEqual(chat.order.filter((entry) => entry.endsWith("codex-admin")), ["turn codex-admin", "compact codex-admin", "turn codex-admin"]);
  assert.match(chat.prompts.filter((item) => item.participantId === "codex-admin")[1].prompt, /Queued question/);
  assert.equal(chat.debugEvents.some(({ event }) => event === "chat.self-compaction.work-done"), true);
  assert.equal(chat.debugEvents.some(({ event }) => event === "chat.self-compaction.resumed"), false);
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
  const asking = chat.storage.current.messages.find((message: any) => message.content === "Stage one is done.");
  assert.deepEqual(asking.metadata.selfCompaction, { state: "ended", reason: "not-continued" });
});

test("work done and nothing waiting: compacted, and no empty turn after it", async () => {
  const chat = selfCompactingChat({
    participant: ALLOWED,
    turn: async ({ actor, service, call }) => {
      if (call === 1) await service.requestSelfCompactionFromTool(actor, { workDone: true });
      return call === 1 ? "All done." : "Nothing left to do.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin finish" });
  await waitFor(() => chat.debugEvents.some(({ event }) => event === "chat.self-compaction.work-done"), 5_000);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  assert.deepEqual(chat.order, ["turn codex-admin", "compact codex-admin"]);
});

test("a request answered by a member that compacts with its work done is answered by the reply that asked", async () => {
  const asker = chatParticipant({ id: "asker", handle: "asker", ...ASKS });
  const chat = selfCompactingChat({
    participant: ALLOWED,
    others: [asker],
    turn: async ({ participantId, actor, service, call }) => {
      if (participantId === "asker") {
        if (call === 1) await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: "Finish it" }] });
        return call === 1 ? "Asked admin." : "Thanks.";
      }
      await service.requestSelfCompactionFromTool(actor, { workDone: true });
      return "Finished it.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@asker get it finished" });
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "asker").length === 2, 8_000);
  const item = chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest)!.metadata.participantRequest.items[0];
  assert.equal(item.status, "answered");
  assert.equal(item.replyMessageId, chat.replies().find((message) => message.content === "Finished it.").id);
  assert.deepEqual(chat.order.filter((entry) => entry.endsWith("codex-admin")), ["turn codex-admin", "compact codex-admin"]);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
});

test("on a card: a member that says its work is done is not called again once User approves, and its tool result says so", async () => {
  let asked: any;
  const chat = selfCompactingChat({
    turn: async ({ actor, service, call }) => {
      if (call === 1) asked = await service.requestSelfCompactionFromTool(actor, { workDone: true });
      return call === 1 ? "All done." : "Went on.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin finish" });
  await waitFor(() => asked !== undefined && chat.approvals().length === 1, 5_000);
  assert.equal(asked.status, "pending_user_approval");
  assert.equal(asked.afterCompaction, "not-called-again");
  assert.match(asked.next, /The compaction runs once User approves the card\. You said your work is done/);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  await chat.service.respondToAppToolApproval({ conversationId: chat.conversation.id, approvalId: chat.approvals()[0].id, approve: true, scope: "once" });
  await waitFor(() => chat.debugEvents.some(({ event }) => event === "chat.self-compaction.work-done"), 5_000);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  assert.deepEqual(chat.order, ["turn codex-admin", "compact codex-admin"]);
});

test("on a machine, a member's own compaction stopped before the machine took it gives its place in the line back", async () => {
  const participant = chatParticipant({ homeMachineId: "box", ...ALLOWED });
  const chat = selfCompactingChat({ participant, turn: async () => "unused" });
  const parts = chatParts(chat.service);
  chat.service.setHostMachineId("box");
  parts.host.machineRuntime = true;
  const link = fakeServerLink("machine-device");
  chat.service.setServerLink(link);
  chat.storage.current.messages.push(acceptedMessage());
  const conversation = await parts.store.requireChat(chat.conversation.id);
  parts.selfCompaction.startQueuedSelfCompaction(conversation, chat.participant, { type: "self_compaction" }, "run-asked-here", undefined);
  assert.equal(parts.selfCompaction.heldCompactionTurns.size, 1);
  // A turn of the member asked meanwhile waits for the compaction's place.
  const waiting = parts.turnQueue.reserveParticipantTurn(conversation.id, chat.participant.id);
  let started = false;
  void waiting.wait().then(() => { started = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started, false);
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request" && op.runId === "turn-run-asked-here"), 2_000);
  parts.serverTurns.noteServerTurn({ runId: "turn-run-asked-here", conversationId: conversation.id, messageId: "anchor", participantId: chat.participant.id, state: "stopped" });
  await waitFor(() => started, 2_000);
  assert.equal(parts.selfCompaction.heldCompactionTurns.size, 0);
  waiting.release();
});

test("on a machine, a member's own compaction whose claim failed keeps its place: offered again, it runs and nothing waits forever", async () => {
  const participant = chatParticipant({ homeMachineId: "box", ...ALLOWED });
  const chat = selfCompactingChat({ participant, turn: async () => "unused" });
  const parts = chatParts(chat.service);
  chat.service.setHostMachineId("box");
  parts.host.machineRuntime = true;
  const link = fakeServerLink("machine-device");
  chat.service.setServerLink(link);
  chat.storage.current.messages.push(acceptedMessage());
  const conversation = await parts.store.requireChat(chat.conversation.id);
  const resume = { runId: "run-asked-here", triggerMessageId: "anchor" };
  parts.selfCompaction.startQueuedSelfCompaction(conversation, chat.participant, { type: "self_compaction" }, "run-asked-here", resume);
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request" && op.runId === "turn-run-asked-here"), 2_000);
  const turn = { runId: "turn-run-asked-here", conversationId: conversation.id, messageId: "anchor", participantId: chat.participant.id, state: "requested" as const,
    requestedBy: "machine-device", request: { kind: "compaction", triggeredBy: "agent", resume } };
  // The server could not be reached: not taken this time.
  const claim = parts.serverTurns.claimServerTurnHere.bind(parts.serverTurns);
  parts.serverTurns.claimServerTurnHere = async () => { throw new Error("The server could not be reached."); };
  await chat.service.startServerTurn(turn).catch(() => undefined);
  assert.equal(parts.selfCompaction.heldCompactionTurns.size, 1, "its place is kept");
  // Offered again: it runs, and the member's other turns are not held forever.
  parts.serverTurns.claimServerTurnHere = claim;
  void chat.service.startServerTurn(turn);
  await waitFor(() => chat.order.includes("compact codex-admin"), 5_000);
  const after = parts.turnQueue.reserveParticipantTurn(conversation.id, chat.participant.id);
  await Promise.race([after.wait(), new Promise((_, reject) => setTimeout(() => reject(new Error("the member's queue is stuck")), 5_000))]);
  after.release();
});
