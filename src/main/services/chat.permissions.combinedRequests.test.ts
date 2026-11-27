import assert from "node:assert/strict";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { chatParts } from "./chat/test/chatParts";
import { chatParticipant, selfCompactingChat, waitFor } from "./chat/test/compactionFixtures";
import * as fixtures from "./chat/test/permissionFixtures";
import { TurnQueue } from "./chat/turns/turnQueue";
import type { HubOp } from "../../shared/hubOps";
import type { ChatMessage } from "../../shared/types";

// Requests from other members that piled up for a busy member go out in one
// turn when it frees up, as each dedicated CLI sends what was queued while it
// worked (the User, 2026-11-27).

const ASKS = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) };

/** A member busy with the User's task while askers each ask it something. */
function busyMemberWithAskers(count: number, holdCombined?: Promise<void>) {
  const askers = Array.from({ length: count }, (_, index) => chatParticipant({ id: `asker${index + 1}`, handle: `asker${index + 1}`, ...ASKS }));
  let releaseBusy!: () => void;
  const busy = new Promise<void>((resolve) => { releaseBusy = resolve; });
  const asked: Record<string, any> = {};
  const chat = selfCompactingChat({
    others: askers,
    turn: async ({ participantId, prompt, actor, service, call }) => {
      if (participantId.startsWith("asker")) {
        if (call === 1) asked[participantId] = await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: `Question from ${participantId}` }] });
        return call === 1 ? "Asked admin." : `Thanks (${participantId}).`;
      }
      if (call === 1) {
        await busy;
        return "Busy work done.";
      }
      if (holdCombined) await holdCombined;
      const questions = [...prompt.matchAll(/Question from (asker\d)/g)].map((match) => match[1]);
      return `Answered ${questions.join(", ")}.`;
    }
  });
  return { chat, asked, releaseBusy, askers };
}

async function ask(chat: ReturnType<typeof selfCompactingChat>, asked: Record<string, any>, asker: string): Promise<void> {
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: `run-${asker}`, content: `@${asker} ask admin` });
  await waitFor(() => asked[asker]?.status === "running", 5_000);
}

const adminPrompts = (chat: ReturnType<typeof selfCompactingChat>) => chat.prompts.filter((item) => item.participantId === "codex-admin").map((item) => item.prompt);
const itemFor = (chat: ReturnType<typeof selfCompactingChat>, asker: string) => chat.storage.current.messages
  .find((message: any) => message.metadata?.participantRequest?.requesterParticipantId === asker)!.metadata.participantRequest.items[0];

test("three requests queued for a busy member go out in one turn when it frees up, and each requester gets that reply", async () => {
  const { chat, asked, releaseBusy } = busyMemberWithAskers(3);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin do the long task" });
  await waitFor(() => adminPrompts(chat).length === 1, 5_000);
  for (const asker of ["asker1", "asker2", "asker3"]) await ask(chat, asked, asker);
  releaseBusy();
  await waitFor(() => ["asker1", "asker2", "asker3"].every((asker) => chat.prompts.filter((item) => item.participantId === asker).length === 2), 8_000);
  const prompts = adminPrompts(chat);
  assert.equal(prompts.length, 2, "one turn for all three");
  assert.deepEqual([...prompts[1].matchAll(/Question from (asker\d)/g)].map((match) => match[1]), ["asker1", "asker2", "asker3"], "in the order they were asked");
  assert.match(prompts[1], /These 3 requests waited for you while you were busy/);
  const reply = chat.replies().find((message) => message.content === "Answered asker1, asker2, asker3.");
  assert.ok(reply);
  for (const asker of ["asker1", "asker2", "asker3"]) {
    const item = itemFor(chat, asker);
    assert.equal(item.status, "answered", asker);
    assert.equal(item.replyMessageId, reply.id, asker);
    const resumed = chat.prompts.filter((entry) => entry.participantId === asker)[1].prompt;
    assert.match(resumed, /Answered asker1, asker2, asker3\./, `${asker} is resumed with the answer`);
  }
  const combined = chat.debugEvents.find(({ event }) => event === "chat.requests.combined");
  assert.equal((combined?.payload.combinedRequestMessageIds as string[]).length, 2);
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
});

test("the User's message waiting between requests keeps its place: the requests behind it go out in the turn after it", async () => {
  const { chat, asked, releaseBusy } = busyMemberWithAskers(3);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin do the long task" });
  await waitFor(() => adminPrompts(chat).length === 1, 5_000);
  await ask(chat, asked, "asker1");
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run-2", content: "@admin and one more thing from me" });
  await ask(chat, asked, "asker2");
  await ask(chat, asked, "asker3");
  releaseBusy();
  await waitFor(() => adminPrompts(chat).length === 4, 8_000);
  const prompts = adminPrompts(chat);
  assert.deepEqual([...prompts[1].matchAll(/Question from (asker\d)/g)].map((match) => match[1]), ["asker1"]);
  assert.match(prompts[2], /one more thing from me/);
  assert.deepEqual([...prompts[3].matchAll(/Question from (asker\d)/g)].map((match) => match[1]), ["asker2", "asker3"]);
  await waitFor(() => ["asker1", "asker2", "asker3"].every((asker) => itemFor(chat, asker).status === "answered"), 8_000);
  assert.notEqual(itemFor(chat, "asker1").replyMessageId, itemFor(chat, "asker2").replyMessageId);
  assert.equal(itemFor(chat, "asker2").replyMessageId, itemFor(chat, "asker3").replyMessageId);
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
});

test("a request stopped after it went out with another ends stopped; the one whose turn it went out in is answered", async () => {
  let releaseAnswer!: () => void;
  const answering = new Promise<void>((resolve) => { releaseAnswer = resolve; });
  const { chat, asked, releaseBusy } = busyMemberWithAskers(2, answering);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin do the long task" });
  await waitFor(() => adminPrompts(chat).length === 1, 5_000);
  await ask(chat, asked, "asker1");
  await ask(chat, asked, "asker2");
  releaseBusy();
  await waitFor(() => adminPrompts(chat).length === 2, 5_000);
  // The run of asker2's request, which went out in asker1's turn and has no bubble of its own.
  const runs = chatParts(chat.service).activeRuns.chatRunMeta;
  const absorbed = [...runs.entries()].find(([, meta]) => meta.participantId === "codex-admin" && !meta.pendingMessageId)?.[0];
  assert.ok(absorbed);
  chat.service.cancelRun(absorbed);
  await waitFor(() => itemFor(chat, "asker2").status === "interrupted", 5_000);
  releaseAnswer();
  await waitFor(() => itemFor(chat, "asker1").status === "answered", 5_000);
  assert.equal(itemFor(chat, "asker2").status, "interrupted");
  assert.equal(adminPrompts(chat).length, 2, "it did not run again on its own");
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
});

test("only requests right behind the one that begins go out with it, at most within the size of one request", () => {
  const queue = new TurnQueue({ host: { runsHere: () => true } } as never);
  const message = (id: string) => ({ id, role: "participant", content: id, createdAt: "", status: "done" }) as never;
  const reserve = () => queue.reserveParticipantTurn("chat", "member");
  const lead = reserve();
  queue.markCombinable(lead, message("r1"), 10);
  const r2 = reserve();
  queue.markCombinable(r2, message("r2"), 10);
  const r3 = reserve();
  queue.markCombinable(r3, message("r3"), 30);
  const r4 = reserve();
  queue.markCombinable(r4, message("r4"), 5);
  void lead.wait();
  const reply = Promise.resolve([]);
  const taken = queue.takeCombinableTurns(lead, "chat", "member", reply, 40);
  assert.deepEqual(taken.map((item: any) => item.id), ["r2"], "r3 would pass the size; r4 behind it keeps its place");
  assert.equal(queue.combinedInto(r2), reply);
  assert.equal(queue.combinedInto(r3), undefined);

  const queue2 = new TurnQueue({ host: { runsHere: () => true } } as never);
  const lead2 = queue2.reserveParticipantTurn("chat", "member");
  queue2.markCombinable(lead2, message("a"), 1);
  queue2.reserveParticipantTurn("chat", "member", "exclusive", { byUser: true });
  const after = queue2.reserveParticipantTurn("chat", "member");
  queue2.markCombinable(after, message("b"), 1);
  void lead2.wait();
  assert.deepEqual(queue2.takeCombinableTurns(lead2, "chat", "member", reply, 100), [], "the User's message keeps its place");
});

/** Three members on this computer ask a member that runs on a machine,
 *  busy with the first request; the test plays the machine. */
async function machineMemberAskedThrice() {
  const askers = ["one", "two", "three"].map((handle) => ({ ...fixtures.chatParticipant("codex-cli", { requestParticipants: "allow" }), id: handle, handle }));
  const target = { ...fixtures.chatParticipant("codex-cli"), id: "far", handle: "far", homeMachineId: "machine-1" };
  const conversation = fixtures.chatConversation([...askers, target]);
  const { service, storage, tempRoot } = fixtures.testService({
    conversation,
    run: async (participant: any) => ({ participant, ok: true, content: "Thanks.", durationMs: 1 })
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const link = fixtures.fakeServerLink("desktop-device");
  service.setServerLink(link);
  const turnRequests = () => link.ops.filter((op): op is Extract<HubOp, { kind: "turn.request" }> => op.kind === "turn.request" && op.participantId === target.id);
  const requestMessage = (handle: string) => storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest?.requesterParticipantId === handle)!;
  for (const asker of askers) {
    await service.requestParticipantsFromTool(fixtures.participantRequestActor(asker), { requests: [{ target: target.handle, prompt: `Question from ${asker.handle}` }] });
    if (asker.handle === "one") await fixtures.waitFor(() => turnRequests().length === 1, 5_000);
  }
  await fixtures.waitFor(() => ["two", "three"].every((handle) => requestMessage(handle)), 5_000);
  // Its turn for the first request ends: the next goes out with the one behind it.
  await fixtures.memberDeviceAnswers(service, turnRequests()[0], { participant: target, content: "Answered one." });
  await fixtures.waitFor(() => turnRequests().length === 2, 5_000);
  return { service, storage, link, target, turnRequests, requestMessage };
}

test("a member on a machine gets the requests that waited in one turn, and each is answered by its reply", async () => {
  const { service, target, turnRequests, requestMessage } = await machineMemberAskedThrice();
  const second = turnRequests()[1];
  assert.equal(second.messageId, requestMessage("two").id);
  assert.deepEqual(second.request?.combined, [requestMessage("three").id], "the machine is told which requests go out with it");
  await fixtures.memberDeviceAnswers(service, second, { participant: target, content: "Answered two and three.", metadata: { combinedRequestMessageIds: [requestMessage("three").id] } });
  await fixtures.waitFor(() => ["two", "three"].every((handle) => requestMessage(handle).metadata!.participantRequest!.items[0].status === "answered"), 5_000);
  assert.equal(requestMessage("three").metadata!.participantRequest!.items[0].replyMessageId, requestMessage("two").metadata!.participantRequest!.items[0].replyMessageId);
  assert.equal(turnRequests().length, 2, "no turn of its own for the third");
});

test("a machine whose program does not take requests together answers only the first: the one behind it runs on its own", async () => {
  const { service, target, turnRequests, requestMessage } = await machineMemberAskedThrice();
  await fixtures.memberDeviceAnswers(service, turnRequests()[1], { participant: target, content: "Answered two." });
  await fixtures.waitFor(() => turnRequests().length === 3, 5_000);
  assert.equal(turnRequests()[2].messageId, requestMessage("three").id);
  assert.equal(turnRequests()[2].request?.combined, undefined);
  await fixtures.memberDeviceAnswers(service, turnRequests()[2], { participant: target, content: "Answered three." });
  await fixtures.waitFor(() => requestMessage("three").metadata!.participantRequest!.items[0].status === "answered", 5_000);
  assert.notEqual(requestMessage("three").metadata!.participantRequest!.items[0].replyMessageId, requestMessage("two").metadata!.participantRequest!.items[0].replyMessageId);
});

test("a machine asked for a turn with requests that go out together prompts its member with all of them and says so on the reply", async () => {
  const askers = [chatParticipant({ id: "a1", handle: "a1", ...ASKS }), chatParticipant({ id: "a2", handle: "a2", ...ASKS })];
  const chat = selfCompactingChat({ participant: { homeMachineId: "box" }, others: askers, turn: async () => "Answered both." });
  const parts = chatParts(chat.service);
  chat.service.setHostMachineId("box");
  parts.host.machineRuntime = true;
  const link = (await import("./chat/test/compactionFixtures")).fakeServerLink("machine-device");
  chat.service.setServerLink(link);
  const request = (id: string, asker: string) => ({
    id, role: "participant", participantId: asker, content: `Question from ${asker}`, createdAt: new Date().toISOString(), status: "done",
    metadata: { threadId: id, serverSeq: 9, serverWriter: "desktop-device", participantRequest: {
      id: `batch-${id}`, requesterParticipantId: asker, requesterHandle: asker, status: "running", source: "mcp", resumeRequester: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      items: [{ targetParticipantId: "codex-admin", targetHandle: "admin", prompt: `Question from ${asker}`, status: "running", updatedAt: new Date().toISOString() }] } }
  });
  chat.storage.current.messages.push(request("req-1", "a1"), request("req-2", "a2"));
  const turn = { runId: "turn-combined", conversationId: chat.conversation.id, messageId: "req-1", participantId: "codex-admin", state: "requested" as const,
    requestedBy: "desktop-device", request: { kind: "turn", combined: ["req-2"] } };
  await chat.service.startServerTurn(turn);
  await waitFor(() => chat.replies().some((message) => message.content === "Answered both."), 5_000);
  assert.deepEqual([...chat.prompts[0].prompt.matchAll(/Question from (a\d)/g)].map((match) => match[1]), ["a1", "a2"]);
  const reply = chat.replies().find((message) => message.content === "Answered both.");
  assert.deepEqual(reply.metadata.combinedRequestMessageIds, ["req-2"]);
});

test("requests answered together by a member that compacts itself on the way get the reply it goes on to, each requester reading it", async () => {
  const askers = ["asker1", "asker2"].map((id) => chatParticipant({ id, handle: id, ...ASKS }));
  let releaseBusy!: () => void;
  const busy = new Promise<void>((resolve) => { releaseBusy = resolve; });
  const asked: Record<string, any> = {};
  const chat = selfCompactingChat({
    participant: { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" }) },
    others: askers,
    turn: async ({ participantId, actor, service, call }) => {
      if (participantId.startsWith("asker")) {
        if (call === 1) asked[participantId] = await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: `Question from ${participantId}` }] });
        return call === 1 ? "Asked admin." : "Thanks.";
      }
      if (call === 1) { await busy; return "Busy work done."; }
      if (call === 2) { await service.requestSelfCompactionFromTool(actor, { instructions: "Answer both." }); return "Looked into both."; }
      return "Answered both after compacting.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin do the long task" });
  await waitFor(() => adminPrompts(chat).length === 1, 5_000);
  for (const asker of ["asker1", "asker2"]) await ask(chat, asked, asker);
  releaseBusy();
  await waitFor(() => ["asker1", "asker2"].every((asker) => chat.prompts.filter((item) => item.participantId === asker).length === 2), 10_000);
  const final = chat.replies().find((message) => message.content === "Answered both after compacting.");
  for (const asker of ["asker1", "asker2"]) {
    assert.equal(itemFor(chat, asker).replyMessageId, final.id, asker);
    assert.match(chat.prompts.filter((item) => item.participantId === asker)[1].prompt, /Answered both after compacting\./, `${asker} reads the answer`);
  }
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
});
