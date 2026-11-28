import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delayMs } from "node:timers/promises";
import { chatParts } from "./chat/test/chatParts";
import { chatParticipant, selfCompactingChat, waitFor as waitLong } from "./chat/test/compactionFixtures";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { readParticipantCompactions } from "../../shared/chatRunState";
import type { ChatMessage } from "../../shared/types";
import { PARTICIPANT_REQUEST_STOPPED_BY_USER } from "./chat/constants";
import { mainActor, NOW, testService, waitFor } from "./chat/test/mainSessionFixtures";
import { askedInOrAfter, comesAfter } from "./chat/requests/ownRequests";
import { asksMainThenAnswers, endProcess, machineMemberChat, scenario, settle } from "./chat/test/ownRequestFixtures";

// A member that asks someone itself while it answers a request
// (chat.mainSession.ownRequests.test.ts): its permission cards and its own
// compactions on the way, and the devices it and its requester run on.

// --- releaser /code-review of 0f684495 (2026-11-28) ---------------------------

test("a reply that reached this device after the requests its turn asked still comes before them: its resume ending with no reply ends the task, never with the interim line", () => {
  const conversation = machineMemberChat({ items: "answered", status: "answered" });
  // As another device's reply can land here: after its turn's own request.
  const interim = conversation.messages.find((message) => message.id === "interim")!;
  conversation.messages = [...conversation.messages.filter((message) => message.id !== "interim"), interim];
  const own = conversation.messages.find((message) => message.id === "own")!;
  assert.equal(askedInOrAfter(conversation, own, interim), true, "asked in its turn, wherever it is placed");
  assert.equal(comesAfter(conversation, own, interim), false, "by place it is before");
  // A later turn started by the same message (a resume after a permission
  // card) is another segment: what the turn before asked is not its own.
  const later = { ...interim, id: "later", metadata: { ...interim.metadata, runId: "remote-run-3", turnSegmentId: "remote-turn-3" } } as ChatMessage;
  conversation.messages.push(later);
  assert.equal(askedInOrAfter(conversation, own, later), false);
  // Same millisecond, placed after: after.
  const sameTime = { ...own, id: "own-same", createdAt: interim.createdAt };
  conversation.messages.push(sameTime);
  assert.equal(comesAfter(conversation, sameTime, interim), true);
});

test("a wait on the User's card for a member on another device keeps a machine holding it on; for a member on this device it does not (her answer wakes this machine)", async () => {
  const conversation = machineMemberChat({ items: "pending_approval", status: "pending_approval" });
  conversation.metadata.pendingAppToolApprovals = [{ id: "card-1", toolName: "app_chat_request_participants", status: "pending", requesterParticipantId: "remote-id",
    createdAt: NOW, updatedAt: NOW, request: { requests: [{ target: "main", prompt: "Which color?" }] }, resumeContext: { participantRequestBatchId: "own-batch", triggerMessageId: "task" } }] as any;
  const elsewhere = testService({ conversation });
  const parts = chatParts(elsewhere.service);
  const task = elsewhere.storage.current.messages.find((message: ChatMessage) => message.id === "task")!;
  const remote = (elsewhere.storage.current.metadata.participants as any[]).find((participant) => participant.id === "remote-id");
  const interim = elsewhere.storage.current.messages.find((message: ChatMessage) => message.id === "interim")!;
  const waiting = parts.participantRequests.answerWithLiveRun(elsewhere.storage.current, task.id, remote, interim, []);
  await waitFor(() => parts.activeRuns.waitOnlyRunIds.size === 1);
  await settle();
  assert.equal(elsewhere.service.hasWaitOnlyWork(), true, "the member runs on machine-1: only this device settles the task, so it stays on");
  endProcess(elsewhere.service);
  await waiting.catch(() => undefined);

  const here = machineMemberChat({ items: "pending_approval", status: "pending_approval" });
  here.metadata.pendingAppToolApprovals = conversation.metadata.pendingAppToolApprovals;
  const local = testService({ conversation: here });
  local.service.setHostMachineId("machine-1");
  const localParts = chatParts(local.service);
  const localRemote = (local.storage.current.metadata.participants as any[]).find((participant) => participant.id === "remote-id");
  const localWait = localParts.participantRequests.answerWithLiveRun(local.storage.current, "task", localRemote,
    local.storage.current.messages.find((message: ChatMessage) => message.id === "interim")!, []);
  await waitFor(() => localParts.activeRuns.waitOnlyRunIds.size === 1);
  await waitFor(() => !local.service.hasWaitOnlyWork());
  endProcess(local.service);
  await localWait.catch(() => undefined);
});

/** A member asked by @asker that raises a permission card first, and once
 *  approved compacts its own context; `afterCompaction` is the turn it goes
 *  on in. */
function cardThenCompaction(options: { afterCompaction: (ask: (prompt: string) => Promise<unknown>) => Promise<string>; compactSession?: (signal: AbortSignal | undefined) => Promise<Record<string, unknown>> }) {
  const perms = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow", requestCompaction: "allow" }) };
  const asker = chatParticipant({ id: "asker", handle: "asker", ...perms });
  const helper = chatParticipant({ id: "helper", handle: "helper", ...perms });
  let card: unknown;
  const chat = selfCompactingChat({
    participant: perms,
    others: [asker, helper],
    ...(options.compactSession ? { compactSession: options.compactSession } : {}),
    turn: async ({ participantId, actor, service, call }) => {
      if (participantId === "asker") {
        if (call === 1) await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: "Check the site." }] });
        return call === 1 ? "Asked admin." : "Thanks.";
      }
      if (participantId === "helper") return "The answer is 7.";
      if (call === 1) {
        card = await service.requestPermissionChangeFromTool({ ...actor, capabilities: [...actor.capabilities, "permissions.request"] }, { kind: "portable", permissions: ["webAccess"] });
        return "I need web access.";
      }
      if (call === 2) {
        await service.requestSelfCompactionFromTool(actor, {});
        return "Approved; compacting first.";
      }
      if (call === 3) return options.afterCompaction(async (prompt) => service.requestParticipantsFromTool(actor, { requests: [{ target: "helper", prompt }] }));
      return "FINAL: 7.";
    }
  });
  const item = () => chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest?.requesterParticipantId === "asker")?.metadata.participantRequest.items[0];
  const askerResumes = () => chat.prompts.filter((entry) => entry.participantId === "asker").slice(1);
  const approve = async (): Promise<void> => {
    await waitLong(() => Boolean(card) && chat.storage.current.messages.some((message: any) => message.content === "I need web access." && message.status === "done"), 5_000);
    const pending = (chat.storage.current.metadata.pendingAppToolApprovals as any[]).find((approval) => approval.status === "pending" && approval.toolName === "app_permissions_request_change");
    await chat.service.respondToAppToolApproval({ conversationId: chat.conversation.id, approvalId: pending.id, approve: true, scope: "once" });
  };
  return { chat, item, askerResumes, approve };
}

test("a member that compacts in the turn after its permission card and asks someone in the turn it goes on in answers the task with its reply after that", async () => {
  const { chat, item, askerResumes, approve } = cardThenCompaction({
    afterCompaction: async (ask) => { await ask("What is the answer?"); return "Asked the helper."; }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@asker ask admin" });
  await approve();
  await waitLong(() => askerResumes().length === 1, 8_000);
  assert.equal(item().status, "answered");
  assert.equal(chat.storage.current.messages.find((message: any) => message.id === item().replyMessageId)?.content, "FINAL: 7.");
  assert.match(askerResumes()[0]!.prompt, /FINAL: 7\./);
  await waitLong(() => chat.storage.current.metadata.running === false, 8_000);
  await delayMs(50);
  assert.equal(askerResumes().length, 1, "resumed once");
});

test("the member's Stop ends the wait for its compaction after a permission card: the task ends stopped and its requester is told once", async () => {
  const { chat, item, askerResumes, approve } = cardThenCompaction({
    afterCompaction: async () => "Never reached.",
    compactSession: async (signal) => {
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      return { ok: false, error: "Compaction was cancelled." };
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@asker ask admin" });
  await approve();
  const parts = chatParts(chat.service);
  // The wait for it is a run of the member's, as its turn's: shown working,
  // with a Stop, and live work (an update waits for it).
  const compactionRun = () => readParticipantCompactions(chat.storage.current.metadata)["codex-admin"]?.runId;
  const waitRun = () => [...parts.activeRuns.chatRunMeta.entries()]
    .find(([runId, meta]) => meta.participantId === "codex-admin" && runId !== compactionRun() && parts.activeRuns.chatRunControllers.has(runId))?.[0];
  await waitLong(() => chat.order.filter((entry) => entry === "compact codex-admin").length === 1 && Boolean(waitRun()), 5_000);
  const waitRunId = waitRun()!;
  assert.equal(parts.activeRuns.waitOnlyRunIds.has(waitRunId), false, "not a wait only, through the compaction");
  assert.ok(parts.activeRuns.memberWaitRunIds.has(waitRunId), "a mode change leaves it: it runs no CLI");
  assert.ok(chat.service.liveRunIds().includes(waitRunId));
  assert.equal(chat.service.cancelRun(waitRunId), true);
  await waitLong(() => askerResumes().length === 1, 8_000);
  assert.equal(item().status, "interrupted");
  assert.equal(item().error, PARTICIPANT_REQUEST_STOPPED_BY_USER);
  await waitLong(() => chat.storage.current.metadata.running === false, 8_000).catch(() => undefined);
  await delayMs(50);
  assert.equal(askerResumes().length, 1, "told once");
});

test("a requester waiting in its tool call that the member asks back gets the member's reply at once: it could not answer the member before", async () => {
  const { service } = scenario({ worker: asksMainThenAnswers });
  const answered = await service.requestParticipantsFromTool(mainActor(undefined, { turnSegmentId: "t", runId: "r" }), {
    requests: [{ target: "worker", prompt: "Pick." }], resumeRequester: false
  });
  const text = JSON.stringify(answered);
  assert.match(text, /I asked the main session/, text);
  assert.doesNotMatch(text, /FINAL/);
});
