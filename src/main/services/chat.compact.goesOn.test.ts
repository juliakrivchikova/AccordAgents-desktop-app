import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { readParticipantCompactions } from "../../shared/chatRunState";
import { chatParts } from "./chat/test/chatParts";
import { selfCompactionResumeText } from "./chat/compaction/compactionText";
import type { HubOp, HubTurn } from "../../shared/hubOps";
import {
  acceptedMessage, chatConversation, chatParticipant, chatSession, clone, fakeServerLink, fromServer, NOW, ROLE,
  selfCompactingChat, testService, waitFor
} from "./chat/test/compactionFixtures";

const ALLOWED = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" }) };

test("a member that compacts its own context goes on by itself: compacted, then called once with what comes next, on the same session", async () => {
  const chat = selfCompactingChat({
    participant: ALLOWED,
    turn: async ({ actor, service, call }) => {
      if (call > 1) return "Stage two is done.";
      const asked = await service.requestSelfCompactionFromTool(actor, { instructions: "Stage two: the settings screen." });
      assert.equal(asked.status, "queued");
      assert.match(String(asked.next), /the app calls you again to go on/);
      return "Stage one is done, stage two next.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin do both stages" });
  await waitFor(() => chat.replies().length === 2, 5_000);
  assert.deepEqual(chat.order, ["turn codex-admin", "compact codex-admin", "turn codex-admin"]);
  const [, second] = chat.prompts;
  assert.match(second.prompt, /<<<EVENT [0-9a-f]{8}>>>\n@admin goes on after the compaction it asked for\.\nYour context was compacted\. Go on with the next step of your work now\./);
  assert.match(second.prompt, /What you asked the summary to keep: Stage two: the settings screen\./);
  assert.deepEqual(chat.replies().map((message) => message.content), ["Stage one is done, stage two next.", "Stage two is done."]);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  await delay(50);
  assert.equal(chat.prompts.length, 2, "called once");
  // In the thread of the message it works on.
  const [first, last] = chat.replies();
  assert.equal(last.metadata.threadId, first.metadata.threadId);
});

test("a compaction that fails is said, and the member goes on without it; a Stop of the compaction leaves it to the User", async () => {
  const failing = selfCompactingChat({
    participant: ALLOWED,
    compactSession: async () => ({ ok: false, error: "No messages to compact." }),
    turn: async ({ actor, service, call }) => {
      if (call === 1) await service.requestSelfCompactionFromTool(actor, {});
      return `Reply ${call}.`;
    }
  });
  await failing.service.sendMessage({ conversationId: failing.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => failing.replies().length === 2, 5_000);
  assert.match(failing.prompts[1].prompt, /Your context could not be compacted \(No messages to compact\.\): it is as it was\./);

  const stopped = selfCompactingChat({
    participant: ALLOWED,
    compactSession: async (signal) => {
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      return { ok: false, error: "Compaction was cancelled." };
    },
    turn: async ({ actor, service }) => {
      await service.requestSelfCompactionFromTool(actor, {});
      return "Stage one is done.";
    }
  });
  await stopped.service.sendMessage({ conversationId: stopped.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => stopped.order.includes("compact codex-admin"), 5_000);
  const compaction = readParticipantCompactions(stopped.storage.current.metadata)["codex-admin"];
  assert.equal(stopped.service.cancelRun(compaction!.runId), true);
  await waitFor(() => stopped.storage.current.metadata.running === false, 5_000);
  await delay(50);
  assert.equal(stopped.prompts.length, 1, "not called again after a Stop");
});

test("a turn stopped after it queued its own compaction is not gone on with", async () => {
  let release!: () => void;
  const chat = selfCompactingChat({
    participant: ALLOWED,
    turn: async ({ actor, service }) => {
      await service.requestSelfCompactionFromTool(actor, {});
      await new Promise<void>((resolve) => { release = resolve; });
      return "Late.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => typeof release === "function", 5_000);
  const runId = chat.storage.current.messages.find((message: any) => message.role === "participant").metadata.runId;
  assert.equal(chat.service.cancelRun(runId), true);
  release();
  await waitFor(() => chat.debugEvents.some(({ event, payload }) => event === "chat.self-compaction.not-resumed" && payload.reason === "stopped"), 5_000);
  assert.equal(chat.prompts.length, 1);
});

test("a member that compacts in the middle of another member's request answers with the reply it goes on to", async () => {
  const asker = chatParticipant({ id: "asker", handle: "asker", permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) });
  const chat = selfCompactingChat({
    participant: ALLOWED,
    others: [asker],
    turn: async ({ actor, service, participantId, call }) => {
      if (participantId === "asker") {
        if (call > 1) return "Thanks.";
        const asked = await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: "Do both stages" }] });
        assert.equal(asked.status, "running");
        return "Asked admin.";
      }
      if (call === 1) {
        await service.requestSelfCompactionFromTool(actor, {});
        return "Stage one is done, stage two next.";
      }
      // Its requester still waits for it.
      const batch = chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest)!.metadata.participantRequest;
      assert.equal(batch.items[0].status, "running");
      assert.equal(chat.prompts.filter((item) => item.participantId === "asker").length, 1);
      return "Both stages are done.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@asker get both stages done" });
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "asker").length === 2, 8_000);
  const item = chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest)!.metadata.participantRequest.items[0];
  const replyOf = (content: string): any => chat.replies().find((message) => message.content === content);
  assert.equal(item.status, "answered");
  assert.equal(item.replyMessageId, replyOf("Both stages are done.").id);
  assert.deepEqual(item.earlierReplyMessageIds, [replyOf("Stage one is done, stage two next.").id]);
  const back = chat.prompts.filter((entry) => entry.participantId === "asker")[1].prompt;
  assert.match(back, /Stage one is done, stage two next\./);
  assert.match(back, /Both stages are done\./);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
});

test("a request whose member's own compaction the User stopped ends as stopped, never as answered with the half it wrote", async () => {
  const asker = chatParticipant({ id: "asker", handle: "asker", permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) });
  const chat = selfCompactingChat({
    participant: ALLOWED,
    others: [asker],
    compactSession: async (signal) => {
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      return { ok: false, error: "Compaction was cancelled." };
    },
    turn: async ({ actor, service, participantId, call }) => {
      if (participantId === "asker") {
        if (call === 1) await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: "Do both stages" }] });
        return call === 1 ? "Asked admin." : "Noted.";
      }
      await service.requestSelfCompactionFromTool(actor, {});
      return "Stage one is done, stage two next.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@asker get both stages done" });
  await waitFor(() => chat.order.includes("compact codex-admin"), 5_000);
  assert.equal(chat.service.cancelRun(readParticipantCompactions(chat.storage.current.metadata)["codex-admin"]!.runId), true);
  const item = (): any => chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest)!.metadata.participantRequest.items[0];
  await waitFor(() => item().status === "interrupted", 5_000);
  assert.equal(item().error, "Stopped by User.");
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  assert.equal(chat.prompts.filter((entry) => entry.participantId === "codex-admin").length, 1);
});

test("on a machine a member's own compaction carries what to go on from, and the machine goes on there once it compacted", async () => {
  const participant = chatParticipant({ homeMachineId: "box", ...ALLOWED });
  const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
  conversation.messages.push(acceptedMessage());
  const prompts: string[] = [];
  const { service, storage } = testService({
    conversation,
    compactSession: async (runParticipant) => ({ participant: runParticipant, ok: true, sessionId: "session-on-box" }),
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return { participant: runParticipant, ok: true, content: "Went on.", durationMs: 1, sessionId: "session-on-box" };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tmpdir();
  service.setHostMachineId("box");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);
  // Taken after a restart of the machine: nothing in memory, all in the turn.
  void service.startServerTurn({ runId: "turn-self", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    requestedBy: "machine-device", request: { kind: "compaction", triggeredBy: "agent", instructions: "Stage two.", resume: { runId: "turn-asked", triggerMessageId: "anchor" } } });
  await waitFor(() => prompts.length === 1, 5_000);
  assert.match(prompts[0], /Your context was compacted\./);
  assert.match(prompts[0], /Stage two\./);
  await waitFor(() => storage.current.messages.some((message: any) => message.content === "Went on."), 5_000);
  const claims = link.ops.filter((op) => op.kind === "turn.claim").map((op) => (op as Extract<HubOp, { kind: "turn.claim" }>).runId);
  assert.deepEqual(claims, ["turn-self", "turn-compaction-resume-asked"], "a turn of its own on the server, named by the run that asked");
  // The same turn offered again (the feed repeats it) goes on once.
  await delay(30);
  assert.equal(prompts.length, 1);
});

/** A reply as another device's member wrote it, ended for its own compaction. */
function askingReply(participantId: string, mark: Record<string, unknown>): any {
  return { id: "asked-reply", role: "participant", participantId, content: "Stage one is done, stage two next.", createdAt: NOW, status: "done",
    metadata: { runId: "turn-asked", selfCompaction: mark, serverSeq: 940, serverWriter: "other-device" } };
}

test("a member's answer is waited for through its own compaction on another device, by what that device wrote on its reply", async () => {
  // Wherever the requester runs: the computer for a cloud member, a machine
  // for a member of the computer's (its compaction is no turn on the server).
  for (const here of ["desktop", "machine"]) {
    const participant = chatParticipant(here === "desktop" ? { homeMachineId: "box" } : {});
    const conversation = chatConversation([participant], []);
    conversation.messages.push(acceptedMessage(), askingReply(participant.id, { state: "waiting" }));
    const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
    if (here === "machine") service.setHostMachineId("box");
    service.setServerLink(fakeServerLink(`${here}-device`));
    const asked = storage.current.messages.find((message: any) => message.id === "asked-reply");
    const waiting = chatParts(service).selfCompaction.selfCompactedAnswer(conversation.id, participant.id, asked, undefined) as Promise<any>;
    await delay(20);
    const went = (content: string, status: string): any => ({ id: "went-on", role: "participant", participantId: participant.id, content, createdAt: NOW, status,
      metadata: { runId: "turn-compaction-resume-asked", serverSeq: 950, serverWriter: "other-device" } });
    const post: any = { ...went("On it.", "done"), id: "post", metadata: { ...went("", "done").metadata, appMessageSource: "app_chat_send_message", serverSeq: 951 } };
    await service.applyServerEntries([fromServer("other-device", { kind: "message.update", message: askingReply(participant.id, { state: "resumed" }) })]);
    await service.applyServerEntries([fromServer("other-device", { kind: "message.create", message: went("", "pending") })]);
    await service.applyServerEntries([fromServer("other-device", { kind: "message.create", message: post })]);
    await delay(20);
    await service.applyServerEntries([fromServer("other-device", { kind: "message.update", message: went("Both stages are done.", "done") })]);
    const answer = await waiting;
    assert.deepEqual([answer.kind, answer.reply.content], ["went-on", "Both stages are done."], `${here}: its reply, not a post it sent on the way`);
  }
});

test("an answer that never comes after a compaction says why: stopped, cut short, could not start, nothing to go on with", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const start = (mark: Record<string, unknown>) => {
    const conversation = chatConversation([participant], []);
    conversation.messages.push(acceptedMessage(), askingReply(participant.id, mark));
    const made = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
    const link = fakeServerLink("desktop-device");
    made.service.setServerLink(link);
    const controller = new AbortController();
    const asked = made.storage.current.messages.find((message: any) => message.id === "asked-reply");
    const waiting = chatParts(made.service).selfCompaction.selfCompactedAnswer(conversation.id, participant.id, asked, controller.signal) as Promise<any>;
    return { ...made, link, controller, waiting, conversation };
  };
  for (const reason of ["stopped", "interrupted", "failed", "not-continued"]) {
    const { service, waiting } = start({ state: "waiting" });
    await delay(10);
    await service.applyServerEntries([fromServer("machine-device", { kind: "message.update", message: askingReply(participant.id, { state: "ended", reason }) })]);
    assert.deepEqual(await waiting, { kind: "ended", reason });
  }
  // The machine lost the compaction: its turn says so.
  const lost = start({ state: "waiting" });
  await delay(10);
  const compaction: HubTurn = { runId: "turn-c", conversationId: lost.conversation.id, messageId: "anchor", participantId: participant.id, state: "finished", outcome: "interrupted",
    executorDeviceId: "machine-device", request: { kind: "compaction", triggeredBy: "agent", resume: { runId: "turn-asked" } } };
  await lost.service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: compaction })]);
  assert.deepEqual(await lost.waiting, { kind: "ended", reason: "interrupted" });
  // Her Stop of the request: the compaction and the turn after it stop there too.
  const stopped = start({ state: "waiting" });
  await stopped.service.applyServerEntries([fromServer("machine-device", { kind: "turn.request", turn: { ...compaction, state: "claimed", outcome: undefined } })]);
  await delay(10);
  stopped.controller.abort();
  assert.deepEqual(await stopped.waiting, { kind: "ended", reason: "stopped" });
  await waitFor(() => stopped.link.ops.some((op) => op.kind === "turn.stop" && op.runId === "turn-c"));
  // The server gave the turn after it before this device's Stop got there:
  // stopped as it stands once it is told of it.
  await stopped.service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn: {
    runId: "turn-compaction-resume-asked", conversationId: stopped.conversation.id, messageId: "event-1", participantId: participant.id, state: "claimed", executorDeviceId: "machine-device" } })]);
  await waitFor(() => stopped.link.ops.some((op) => op.kind === "turn.stop" && op.runId === "turn-compaction-resume-asked" && op.messageId === "event-1"));
});

test("a Stop of what the User sent while a member compacted leaves the work to her", async () => {
  let release!: () => void;
  const chat = selfCompactingChat({
    participant: ALLOWED,
    compactSession: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true };
    },
    turn: async ({ actor, service, call }) => {
      if (call === 1) {
        await service.requestSelfCompactionFromTool(actor, {});
        return "Stage one is done.";
      }
      await new Promise<void>((resolve) => { release = resolve; });
      return "Late.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => chat.order.includes("compact codex-admin"), 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "second-run", content: "@admin wait, look at this" });
  release();
  await waitFor(() => chat.prompts.length === 2, 5_000);
  const second = chat.storage.current.messages.findLast((message: any) => message.role === "participant" && message.status === "pending");
  assert.equal(chat.service.cancelRun(second.metadata.runId), true);
  release();
  await waitFor(() => chat.debugEvents.some(({ event, payload }) => event === "chat.self-compaction.not-resumed" && payload.reason === "stopped"), 5_000);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  assert.equal(chat.prompts.length, 2);
});

test("a restart that cut a member's compaction short is said on its reply once; a card still open goes on waiting", async () => {
  const participant = chatParticipant();
  const marks = async (mark: Record<string, unknown>, approvals: unknown[] = []): Promise<any> => {
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    conversation.messages.push({ ...askingReply(participant.id, mark), metadata: { runId: "turn-asked", selfCompaction: mark } });
    conversation.metadata.pendingAppToolApprovals = approvals as never;
    const { service, storage } = testService({ conversation, compactSession: async () => ({}) });
    await chatParts(service).store.requireChat(conversation.id);
    return storage.current.messages.find((message: any) => message.id === "asked-reply").metadata.selfCompaction;
  };
  assert.deepEqual(await marks({ state: "waiting" }), { state: "ended", reason: "interrupted" });
  assert.deepEqual(await marks({ state: "card" }), { state: "ended", reason: "interrupted" });
  assert.deepEqual(await marks({ state: "resumed" }), { state: "resumed", reason: "interrupted" }, "its turn never began");
  assert.deepEqual(await marks({ state: "ended", reason: "stopped" }), { state: "ended", reason: "stopped" });
  const card = { id: "card", conversationId: "chat-compact", requesterParticipantId: participant.id, requesterHandle: "admin", requesterRoleConfigId: ROLE.id,
    toolName: "app_chat_request_compaction", capability: "compaction.request", status: "pending", request: { type: "self_compaction" }, summary: "Compact",
    createdAt: NOW, updatedAt: NOW, resumeContext: { runId: "turn-asked", triggerMessageId: "anchor" } };
  assert.deepEqual(await marks({ state: "card" }, [card]), { state: "card" });
});

test("a turn that could not start after the compaction, or was stopped before anyone took it, ends the wait for it", async () => {
  for (const [label, start, expected] of [
    ["refused", async () => { throw new Error("The server did not give @admin this turn: no."); }, { state: "resumed", reason: "failed" }],
    ["stopped before it was taken", async () => [], { state: "resumed", reason: "stopped" }]
  ] as Array<[string, () => Promise<any[]>, Record<string, unknown>]>) {
    const chat = selfCompactingChat({
      participant: ALLOWED,
      turn: async ({ actor, service }) => {
        await service.requestSelfCompactionFromTool(actor, {});
        const run = chatParts(service).turnQueue.runParticipantTurnSerialized.bind(chatParts(service).turnQueue);
        chatParts(service).turnQueue.runParticipantTurnSerialized = async (...args: any[]) => {
          if (!String(args[3]).startsWith("turn-compaction-resume-")) return run(...args);
          args[6].turnReservation.release();
          return start();
        };
        return "Stage one is done.";
      }
    });
    await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin go" });
    await waitFor(() => chat.debugEvents.some(({ event }) => event === "chat.self-compaction.not-resumed"), 5_000);
    await waitFor(() => chat.storage.current.messages.some((message: any) => message.metadata?.selfCompaction?.reason), 5_000);
    const asking = chat.storage.current.messages.find((message: any) => message.metadata?.selfCompaction);
    const { error: _error, ...mark } = asking.metadata.selfCompaction;
    assert.deepEqual(mark, expected, label);
    const answer = await chatParts(chat.service).selfCompaction.selfCompactedAnswer(chat.conversation.id, "codex-admin", asking, undefined);
    assert.equal(answer.kind, "ended", label);
    await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  }
});

test("a stopped request stops its member's compaction, its card and the turn it would go on in, never begun after", async () => {
  // Waiting on the User's card.
  const card = selfCompactingChat({
    turn: async ({ actor, service }) => {
      await service.requestSelfCompactionFromTool(actor, {});
      return "Stage one is done.";
    }
  });
  await card.service.sendMessage({ conversationId: card.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => card.replies().length === 1 && card.storage.current.metadata.running === false, 5_000);
  const controller = new AbortController();
  const waiting = chatParts(card.service).selfCompaction.selfCompactedAnswer(card.conversation.id, "codex-admin", card.replies()[0], controller.signal) as Promise<any>;
  await delay(20);
  controller.abort();
  assert.deepEqual(await waiting, { kind: "ended", reason: "stopped" });
  assert.equal(card.approvals()[0].status, "cancelled");
  // A resume already on its way behind another turn is not begun.
  await chatParts(card.service).selfCompactionResumes.continueAfterSelfCompaction(card.conversation.id, "codex-admin", { runId: card.replies()[0].metadata.runId }, { kind: "completed" }, undefined);
  assert.equal(card.prompts.length, 1);
});

test("a card approved after the User stopped something else of the member's still brings it back", async () => {
  let release: (() => void) | undefined;
  const chat = selfCompactingChat({
    turn: async ({ actor, service, call }) => {
      if (call === 1) await service.requestSelfCompactionFromTool(actor, {});
      if (call === 2) await new Promise<void>((resolve) => { release = resolve; });
      return `Reply ${call}.`;
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => chat.replies().length === 1 && chat.storage.current.metadata.running === false, 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "second-run", content: "@admin look at this" });
  await waitFor(() => Boolean(release), 5_000);
  const second = chat.storage.current.messages.findLast((message: any) => message.role === "participant" && message.status === "pending");
  chat.service.cancelRun(second.metadata.runId);
  release!();
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  await delay(5);
  await chat.service.respondToAppToolApproval({ conversationId: chat.conversation.id, approvalId: chat.approvals()[0].id, approve: true });
  await waitFor(() => chat.prompts.length === 3, 5_000);
  assert.match(chat.prompts[2].prompt, /Your context was compacted\./);
});

test("a Stop from before the member asked to compact, told again by the server, is not a Stop since", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  const { service } = testService({ conversation, compactSession: async () => ({}) });
  service.setServerLink(fakeServerLink("desktop-device"));
  const stopped = (at: string): HubTurn => ({ runId: `turn-${at}`, conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "stopped", finishedAt: at, outcome: "stopped" });
  const since = "2026-11-25T12:00:00.000Z";
  const check = async (): Promise<boolean> => chatParts(service).selfCompactionResumes.memberStoppedSince(await chatParts(service).store.requireChat(conversation.id), participant.id, { runId: "asked", since });
  await service.applyServerEntries([fromServer("phone", { kind: "turn.stop", turn: stopped("2026-11-25T11:00:00.000Z") })]);
  assert.equal(await check(), false);
  await service.applyServerEntries([fromServer("phone", { kind: "turn.stop", turn: stopped("2026-11-25T12:00:01.000Z") })]);
  assert.equal(await check(), true);
});

test("a request held through a permission approval's resume is not swept as interrupted", async () => {
  const asker = chatParticipant({ id: "asker", handle: "asker" });
  const target = chatParticipant();
  const conversation = chatConversation([asker, target], []);
  conversation.messages.push({ id: "request", role: "participant", participantId: "asker", content: "@admin do it", createdAt: NOW, status: "done", metadata: { participantRequest: {
    id: "batch", requesterParticipantId: "asker", requesterHandle: "asker", source: "mcp", resumeRequester: true, status: "running", depth: 1, createdAt: NOW, updatedAt: NOW,
    items: [{ targetParticipantId: target.id, targetHandle: "admin", prompt: "Do it", status: "running", createdAt: NOW, updatedAt: NOW }] } } } as any);
  const { service } = testService({ conversation, compactSession: async () => ({}) });
  const sweep = (): boolean => chatParts(service).requestRecovery.markOrphanedParticipantRequestsInterrupted(clone(conversation));
  chatParts(service).permissionRequests.heldParticipantRequests.add("request");
  assert.equal(sweep(), false);
  chatParts(service).permissionRequests.heldParticipantRequests.delete("request");
  assert.equal(sweep(), true);
});

test("a machine that restarted after a compaction ended, before its member went on, says so once it knows what waits on the server", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
  conversation.messages.push(acceptedMessage(), { ...askingReply(participant.id, { state: "waiting" }), metadata: { runId: "turn-asked", selfCompaction: { state: "waiting" } } });
  const { service, storage } = testService({ conversation, compactSession: async () => ({}) });
  service.setHostMachineId("box");
  (service as any).setMachineRuntime?.(true);
  chatParts(service).host.machineRuntime = true;
  const mark = (): any => storage.current.messages.find((message: any) => message.id === "asked-reply").metadata.selfCompaction;
  await chatParts(service).store.requireChat(conversation.id);
  assert.deepEqual(mark(), { state: "waiting" }, "not known yet what waits there");
  service.setServerLink(fakeServerLink("machine-device"));
  await service.resumeServerTurns();
  await chatParts(service).store.requireChat(conversation.id);
  assert.deepEqual(mark(), { state: "ended", reason: "interrupted" });
});

test("the turn a member goes on in is never taken for its requester's resume after a restart", () => {
  const { service } = testService({ conversation: chatConversation([], []), compactSession: async () => ({}) });
  const text = selfCompactionResumeText(chatParticipant(), { kind: "completed" }, undefined) as string;
  assert.doesNotMatch(text, /^Auto-resumed @/);
});
