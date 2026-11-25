import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { readParticipantCompactions } from "../../shared/chatRunState";
import { chatParts } from "./chat/test/chatParts";
import type { HubOp, HubTurn } from "../../shared/hubOps";
import {
  acceptedMessage, chatConversation, chatParticipant, chatSession, fakeServerLink, fromServer, NOW, selfCompactionActor,
  testService, waitFor
} from "./chat/test/compactionFixtures";

function compactionLine(runId: string, participantId: string, outcome: "completed" | "failed", content: string, threadId?: string): any {
  return { id: `line-${runId}`, role: "system", content, createdAt: NOW, status: "done",
    metadata: { runId, ...(threadId ? { threadId } : {}), compaction: { triggeredBy: "user", participantId, outcome, instructionsProvided: false }, serverSeq: 900, serverWriter: "machine-device" } };
}

test("/compact on a member hosted on a machine is asked of its machine on the server, and shows the line and context use the machine wrote", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const { service, storage } = testService({
    conversation,
    debugEvents,
    compactSession: async () => { throw new Error("a member on a machine is never compacted on the desktop"); }
  });
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  const lines: string[] = [];
  const running = service.sendMessage({ conversationId: conversation.id, runId: "machine-compact", content: "@admin /compact keep the plan", threadId: "thread-1" },
    undefined, (progress) => lines.push(progress.message));
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  const request = link.ops.find((op) => op.kind === "turn.request") as Extract<HubOp, { kind: "turn.request" }>;
  assert.equal(request.runId, "turn-machine-compact");
  assert.equal(request.participantId, participant.id);
  assert.equal(request.messageId, "anchor", "placed against a message the server holds");
  assert.deepEqual(request.request, { kind: "compaction", triggeredBy: "user", instructions: "keep the plan", threadId: "thread-1" });
  assert.equal(readParticipantCompactions(storage.current.metadata)[participant.id]?.runId, "machine-compact", "the member shows as compacting while its machine works");
  const turn: HubTurn = { runId: request.runId, conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "claimed", executorDeviceId: "machine-device" };
  const usage = { usedTokens: 300, contextWindowTokens: 1000, percentage: 30, source: "codex-cli", updatedAt: "2026-02-01T00:00:00.000Z" };
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "message.create",
    message: compactionLine(request.runId, participant.id, "completed", "Compacted @admin context with focus instructions.", "thread-1") })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: "done", contextUsage: usage } })]);
  const result = await running;
  assert.equal(result.warnings.length, 0);
  assert.equal(storage.current.messages.at(-1)?.id, `line-${request.runId}`);
  assert.equal(storage.current.messages.at(-1)?.content, "Compacted @admin context with focus instructions.");
  assert.equal(storage.current.messages.filter((message: any) => message.role === "system").length, 1, "the machine's line only, not a second one from here");
  assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 300);
  assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.deepEqual(lines, ["Compacting @admin.", "Compacting @admin. Waiting for machine Box", "Compacting @admin.", "Compacted @admin."]);
  assert.deepEqual(debugEvents.filter(({ event }) => event.startsWith("chat.compaction.")).map(({ event, payload }) => [event, payload.outcome]), [
    ["chat.compaction.requested", undefined],
    ["chat.compaction.finished", "completed"]
  ]);
});

test("Stop on a machine member's compaction is asked on the server and shown as waiting until the machine confirms", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  const lines: string[] = [];
  const stop = new AbortController();
  const running = service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "waiting-run" }, stop.signal, (progress) => lines.push(progress.message));
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  const turn: HubTurn = { runId: "turn-waiting-run", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "claimed", executorDeviceId: "machine-device" };
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn })]);
  stop.abort();
  await waitFor(() => link.ops.some((op) => op.kind === "turn.stop"));
  await waitFor(() => lines.at(-1) === "Compacting @admin. Stop requested — waiting for machine Box");
  // The machine stops it and says how its compaction ended.
  await service.applyServerEntries([fromServer("machine-device", { kind: "message.create",
    message: compactionLine("turn-waiting-run", participant.id, "failed", "Could not compact @admin context: Compaction was cancelled.") })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: "stopped" } })]);
  await running;
  assert.deepEqual(lines, [
    "Compacting @admin.",
    "Compacting @admin. Waiting for machine Box",
    "Compacting @admin.",
    "Compacting @admin. Stop requested — waiting for machine Box",
    "Could not compact @admin."
  ]);
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: Compaction was cancelled.");
  assert.equal(storage.current.metadata.activeRunIds, undefined);
});

test("a machine compaction that could not start ends as a local one that could not", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
  // No link to the User's server: nothing can reach the machine.
  const offline = await service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "machine-offline" });
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: @admin runs on a cloud machine, which this device reaches only through your server; it is not linked to it yet.");
  assert.equal(storage.current.messages.at(-1)?.metadata?.compaction?.outcome, "failed");
  assert.equal(offline.warnings.length, 1);

  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  // Stopped before it was asked: the words a local compaction stopped before it started writes.
  const stop = new AbortController();
  stop.abort();
  await service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "machine-stopped" }, stop.signal);
  assert.equal(link.ops.some((op) => op.kind === "turn.request"), false, "a stopped compaction is never asked");
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: Compaction was cancelled before native execution started.");
  assert.equal(storage.current.metadata.activeRunIds, undefined);

  // Stopped on the server before the machine took it: the same words.
  const asked = service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "stopped-there" });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  await service.applyServerEntries([fromServer("phone-device", { kind: "turn.stop",
    turn: { runId: "turn-stopped-there", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "stopped", outcome: "stopped" } })]);
  await asked;
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: Compaction was cancelled before native execution started.");

  // A member whose cloud machine was never prepared has never run.
  const pending = chatParticipant({ id: "cloud-pending", handle: "cloudy", cloudRun: { kind: "aws" } as any });
  storage.current.metadata.participants = [participant, pending];
  await service.compactParticipant({ conversationId: conversation.id, participantId: pending.id, runId: "machine-pending" });
  assert.equal(storage.current.messages.at(-1)?.content, "@cloudy does not have an active session to compact yet.");
  assert.equal(link.ops.filter((op) => op.kind === "turn.request").length, 1);
});

test("the machine takes a compaction turn asked of its member, runs it under the turn's id, and ends it on the server with the member's context use", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-machine-"));
  try {
    const participant = chatParticipant({ homeMachineId: "box" });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    conversation.messages.push(acceptedMessage());
    let compactedSession: unknown;
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, options) => {
        compactedSession = options.sessionId;
        return { participant: runParticipant, ok: true, sessionId: "session-on-box",
          contextUsage: { usedTokens: 50, contextWindowTokens: 1000, percentage: 5, source: "codex-cli", updatedAt: "2026-03-01T00:00:00.000Z" } };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const link = fakeServerLink("machine-device");
    service.setServerLink(link);
    await service.startServerTurn({ runId: "turn-desktop-run", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
      request: { kind: "compaction", triggeredBy: "agent", threadId: "t-9" } });
    await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));
    assert.equal(compactedSession, "session-on-box");
    assert.deepEqual(link.ops.filter((op) => op.kind.startsWith("turn.")).map((op) => op.kind), ["turn.claim", "turn.finish"], "taken before it ran, ended after");
    const finish = link.ops.find((op) => op.kind === "turn.finish") as Extract<HubOp, { kind: "turn.finish" }>;
    assert.equal(finish.outcome, "done");
    assert.equal((finish.contextUsage as { usedTokens?: number } | undefined)?.usedTokens, 50);
    const line = storage.current.messages.at(-1);
    assert.equal(line.content, "Compacted @admin context.");
    assert.equal(line.metadata?.runId, "turn-desktop-run");
    assert.equal(line.metadata?.threadId, "t-9");
    assert.equal(line.metadata?.compaction?.triggeredBy, "agent");
    // The line goes to the server before the turn's end.
    const lineOp = link.ops.findIndex((op) => op.kind === "message.create" && op.message.id === line.id);
    assert.ok(lineOp >= 0 && lineOp < link.ops.findIndex((op) => op.kind === "turn.finish"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a /compact with no handle written to a member, asked of it on the server (the phone), compacts it as the desktop does; with a picture it is a message", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-bare-"));
  try {
    const participant = chatParticipant({ homeMachineId: "box" });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    conversation.messages.push({ ...acceptedMessage("bare"), content: "/compact keep the API notes", metadata: { ...acceptedMessage("bare").metadata, deliveryTargets: [participant.id] } });
    conversation.messages.push({ ...acceptedMessage("pictured"), content: "/compact", metadata: { ...acceptedMessage("pictured").metadata, deliveryTargets: [participant.id],
      imageAttachments: [{ id: "img", filename: "a.png", mimeType: "image/png", sizeBytes: 10, width: 1, height: 1, storageKey: "attachments/img.png", createdAt: NOW }] } });
    const compacted: unknown[] = [];
    const ran: string[] = [];
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, options) => {
        compacted.push(options.compactInstructions);
        return { participant: runParticipant, ok: true, sessionId: "session-on-box" };
      },
      run: async (runParticipant, prompt) => {
        ran.push(prompt);
        return { participant: runParticipant, ok: true, content: "Seen.", durationMs: 1 };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const link = fakeServerLink("machine-device");
    service.setServerLink(link);
    await service.startServerTurn({ runId: "turn-bare", conversationId: conversation.id, messageId: "bare", participantId: participant.id, state: "requested" });
    await waitFor(() => link.ops.filter((op) => op.kind === "turn.finish").length === 1);
    assert.deepEqual(compacted, ["keep the API notes"]);
    assert.deepEqual(ran, [], "her text did not go to the CLI");
    await service.startServerTurn({ runId: "turn-pictured", conversationId: conversation.id, messageId: "pictured", participantId: participant.id, state: "requested" });
    await waitFor(() => link.ops.filter((op) => op.kind === "turn.finish").length === 2);
    assert.equal(compacted.length, 1);
    assert.equal(ran.length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a member on a machine asking to compact itself asks it on the server, and its machine then takes it like any compaction", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-self-"));
  try {
    const participant = chatParticipant({
      homeMachineId: "box",
      permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" })
    });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    conversation.messages.push(acceptedMessage());
    let compactCalls = 0;
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant) => { compactCalls += 1; return { participant: runParticipant, ok: true, sessionId: "session-on-box" }; }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const link = fakeServerLink("machine-device");
    service.setServerLink(link);

    const asked = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), { instructions: "Keep the API notes." });
    assert.equal(asked.status, "queued");
    await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
    const request = link.ops.find((op) => op.kind === "turn.request") as Extract<HubOp, { kind: "turn.request" }>;
    assert.equal(request.participantId, participant.id);
    const { resume, ...asked2 } = request.request as Record<string, any>;
    assert.deepEqual(asked2, { kind: "compaction", triggeredBy: "agent", instructions: "Keep the API notes." });
    assert.equal(resume.runId, "active-turn", "what to go on from travels with it");
    await delay(25);
    assert.equal(compactCalls, 0, "it runs when the server says so, so every device sees it and can stop it");
    // The server's word comes back: this machine takes it.
    await service.applyServerEntries([fromServer("machine-device", { kind: "turn.request",
      turn: { runId: request.runId, conversationId: conversation.id, messageId: request.messageId, participantId: participant.id, state: "requested",
        requestedBy: "machine-device", request: request.request } })]);
    await waitFor(() => compactCalls === 1);
    await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("the desktop shows a compaction a machine member asked for itself as a run, and its Stop is asked on the server", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  const turn: HubTurn = { runId: "turn-self", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    requestedBy: "machine-device", request: { kind: "compaction", triggeredBy: "agent" } };
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.request", turn })]);
  await waitFor(() => readParticipantCompactions(storage.current.metadata)[participant.id]?.runId === "turn-self");
  assert.equal(link.ops.some((op) => op.kind === "turn.request"), false, "not asked again: the machine asked it");
  // Shown once, whatever the feed says again.
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn: { ...turn, state: "claimed", executorDeviceId: "machine-device" } })]);
  assert.equal(service.cancelRun("turn-self"), true);
  await waitFor(() => link.ops.some((op) => op.kind === "turn.stop"));
  await service.applyServerEntries([fromServer("machine-device", { kind: "message.create",
    message: compactionLine("turn-self", participant.id, "failed", "Could not compact @admin context: Compaction was cancelled.") })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: "stopped", executorDeviceId: "machine-device" } })]);
  await waitFor(() => storage.current.metadata.activeRunIds === undefined && !readParticipantCompactions(storage.current.metadata)[participant.id]);
  assert.equal(storage.current.messages.filter((message: any) => message.role === "system").length, 1);
});

test("Stop by run id reaches a compaction the machine runs for another device, which ends it on the server as stopped", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-machine-stop-"));
  try {
    const participant = chatParticipant({ homeMachineId: "box" });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    conversation.messages.push(acceptedMessage());
    let compactSignal: AbortSignal | undefined;
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, signal) => {
        compactSignal = signal;
        await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        return { participant: runParticipant, ok: false, error: "Compaction was cancelled." };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const link = fakeServerLink("machine-device");
    service.setServerLink(link);
    const turn: HubTurn = { runId: "turn-stop-me", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
      request: { kind: "compaction", triggeredBy: "user" } };
    void service.startServerTurn(turn);
    await waitFor(() => compactSignal !== undefined);
    // The Stop arrives from the server: asked while this machine has it.
    await service.applyServerEntries([fromServer("desktop-device", { kind: "turn.stop",
      turn: { ...turn, state: "claimed", executorDeviceId: "machine-device", stopRequestedAt: NOW } })]);
    await waitFor(() => compactSignal?.aborted === true);
    await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));
    assert.equal((link.ops.find((op) => op.kind === "turn.finish") as Extract<HubOp, { kind: "turn.finish" }>).outcome, "stopped");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
