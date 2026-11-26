// The chat's main session compacts other members (app_chat_compact_participant;
// the User, 2026-11-26): only while it compacts without asking, as she would
// with `@x /compact <instructions>`, wherever the member runs.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatParticipant, Conversation } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { APP_CHAT_COMPACT_PARTICIPANT_TOOL } from "../../shared/appMcpToolContracts";
import { buildChatParticipantActivitySnapshot } from "../../shared/chatParticipantActivity";
import type { HubOp, HubTurn } from "../../shared/hubOps";
import { machineMayCompact } from "../../hub/hubMachineScope";
import { chatParts } from "./chat/test/chatParts";
import { acceptedMessage, chatConversation, chatParticipant, chatSession, fakeServerLink, fromServer, testService, waitFor } from "./chat/test/compactionFixtures";
import { appMcpToolNamesFor, appToolCapabilitiesForRolePolicy, compactionAccessLines, idleLargeMembersNote } from "./chat/turns/promptSections";

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

function permissions(requestCompaction: "allow" | "ask" | "deny") {
  return normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction });
}

/** A chat with a main session and a member that worked two hours ago. */
function chat(options: { mainRight?: "allow" | "ask" | "deny"; main?: Partial<ChatParticipant>; worker?: Partial<ChatParticipant>; workerReply?: boolean } = {}) {
  const main = chatParticipant({ id: "main-id", handle: "main", permissions: permissions(options.mainRight ?? "allow"), ...options.main });
  const worker = chatParticipant({ id: "worker-id", handle: "worker", ...options.worker });
  const conversation: Conversation = chatConversation([main, worker], [chatSession(main, "session-main"), chatSession(worker, "session-worker")]);
  conversation.metadata.mainSessionParticipantId = main.id;
  conversation.metadata.agentContextUsageByParticipant = {
    [worker.id]: { usedTokens: 180_000, contextWindowTokens: 200_000, percentage: 90, source: "claude-code", updatedAt: TWO_HOURS_AGO }
  };
  if (options.workerReply !== false) {
    conversation.messages.push({ id: "worker-reply", role: "participant", participantId: worker.id, content: "Stage one is done.", createdAt: TWO_HOURS_AGO, status: "done",
      metadata: { runId: "old-run" } } as never);
  }
  return { main, worker, conversation };
}

function actorOf(main: ChatParticipant, capabilities = ["participants.compact", "compaction.request"]): any {
  return { conversationId: "chat-compact", participantId: main.id, roleConfigId: main.roleConfigId, roleConfigVersion: 1, capabilities, runId: "main-turn" };
}

test("only the main session gets the tool, and only while it compacts without asking", () => {
  const caps = (right: "allow" | "ask" | "deny", isMain: boolean) => appToolCapabilitiesForRolePolicy(["participants.compact"], undefined, permissions(right), isMain);
  assert.ok(caps("allow", true).includes("participants.compact"));
  assert.ok(appMcpToolNamesFor(caps("allow", true)).includes(APP_CHAT_COMPACT_PARTICIPANT_TOOL));
  for (const [right, isMain] of [["ask", true], ["deny", true], ["allow", false]] as const) {
    assert.equal(caps(right, isMain).includes("participants.compact"), false, `${right} ${isMain ? "main" : "member"}: a role cannot give it`);
    assert.equal(appMcpToolNamesFor(caps(right, isMain)).includes(APP_CHAT_COMPACT_PARTICIPANT_TOOL), false);
  }
  const mainLines = compactionAccessLines(permissions("allow"), true).join("\n");
  assert.match(mainLines, /app_chat_compact_participant/);
  assert.match(mainLines, /idle for over an hour with over 100,000 tokens/);
  assert.match(mainLines, /100,000/);
  assert.doesNotMatch(compactionAccessLines(permissions("allow"), false).join("\n"), /app_chat_compact_participant/, "a member is not told");
  assert.doesNotMatch(compactionAccessLines(permissions("ask"), true).join("\n"), /app_chat_compact_participant/, "Compact without asking off: not told");
});

test("with each message the main session is told which members are idle over an hour with a large context, and only while it compacts without asking", () => {
  const { main, worker, conversation } = chat();
  const note = idleLargeMembersNote(conversation, main, permissions("allow"));
  assert.match(note, /- @worker: idle 2 h, 180k tokens of context\./);
  assert.match(note, /app_chat_compact_participant/);
  assert.equal(idleLargeMembersNote(conversation, main, permissions("ask")), "", "Compact without asking off");
  assert.equal(idleLargeMembersNote(conversation, worker, permissions("allow")), "", "not a member's");
  const recent = chat();
  (recent.conversation.messages[0] as any).createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
  assert.equal(idleLargeMembersNote(recent.conversation, recent.main, permissions("allow")), "", "worked within the hour");
  const small = chat();
  (small.conversation.metadata.agentContextUsageByParticipant as any)[small.worker.id].usedTokens = 60_000;
  assert.equal(idleLargeMembersNote(small.conversation, small.main, permissions("allow")), "", "a small context");
});

test("the activity tool says when each member last worked and how full its context is", () => {
  const { worker, conversation } = chat();
  conversation.messages[0] = { ...conversation.messages[0], metadata: { runId: "old-run", activityEvents: [{ id: "e", kind: "tool", label: "Read", createdAt: "2026-01-01T00:05:00.000Z" }] } } as never;
  conversation.messages[0].createdAt = "2026-01-01T00:00:00.000Z";
  (conversation.metadata.agentContextUsageByParticipant as any)[worker.id].updatedAt = "2026-01-01T00:06:00.000Z";
  const at = (snapshotAt: string) => buildChatParticipantActivitySnapshot(conversation, snapshotAt).participants.find((item) => item.participantId === worker.id)!;
  const entry = at("2026-01-01T01:35:30.000Z");
  assert.equal(entry.lastTurnEndedAt, "2026-01-01T00:05:00.000Z", "its reply's last step");
  assert.equal(entry.minutesSinceLastTurn, 90);
  assert.deepEqual(entry.context, { usedTokens: 180_000, contextWindowTokens: 200_000, percentage: 90, measuredAt: "2026-01-01T00:06:00.000Z" });
  conversation.messages.push({ id: "line", role: "system", content: "Compacted @worker context.", createdAt: "2026-01-01T01:00:00.000Z", status: "done",
    metadata: { compaction: { triggeredBy: "user", participantId: worker.id, outcome: "completed", instructionsProvided: false } } } as never);
  assert.equal(at("2026-01-01T01:35:30.000Z").lastTurnEndedAt, "2026-01-01T01:00:00.000Z", "a later compaction of it");
  assert.equal(at("2026-01-01T01:35:30.000Z").minutesSinceLastTurn, 35);
  assert.equal(at("2026-01-01T01:35:30.000Z").context, null, "a figure read before its compaction is not its context now");
  conversation.messages.push({ id: "waiting", role: "participant", participantId: worker.id, content: "", createdAt: "2026-01-01T01:20:00.000Z", status: "done",
    metadata: { hiddenFromTimeline: true } } as never);
  assert.equal(at("2026-01-01T01:35:30.000Z").lastTurnEndedAt, "2026-01-01T01:20:00.000Z", "a hidden reply is its work too");
  const main = buildChatParticipantActivitySnapshot(conversation).participants.find((item) => item.participantId === "main-id")!;
  assert.equal(main.lastTurnEndedAt, null);
  assert.equal(main.context, null);
});

test("the activity tool gives only the members it is asked about, the chat's counts still the whole chat's", async () => {
  const { main, worker, conversation } = chat();
  const { service } = testService({ conversation, compactSession: async () => ({}) });
  const one = await service.describeChatParticipantActivityForTool(actorOf(main), { participants: ["@Worker"] });
  assert.deepEqual(one.participants.map((entry) => entry.participantId), [worker.id]);
  assert.equal(Object.values(one.statusCounts).reduce((sum, count) => sum + count, 0), 2);
  const all = await service.describeChatParticipantActivityForTool(actorOf(main), {});
  assert.equal(all.participants.length, 2);
});

test("the main session compacts an idle member on this computer: its CLI gets the instructions, the line names who asked and what it kept", async () => {
  const { main, worker, conversation } = chat();
  const compacted: Array<{ id: string; instructions: unknown }> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { service, storage } = testService({
    conversation,
    compactSession: async (runParticipant, _repo, _diff, _kind, _signal, options) => {
      await held;
      compacted.push({ id: runParticipant.id, instructions: options.compactInstructions });
      return { participant: runParticipant, ok: true, sessionId: "session-worker",
        contextUsage: { usedTokens: 30_000, contextWindowTokens: 200_000, percentage: 15, source: "codex-cli", updatedAt: new Date().toISOString() } };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tmpdir();
  // Named as other member tools name it (`participant`), as a main session did live.
  const answer = await service.compactParticipantFromTool(actorOf(main), { participant: "@worker", instructions: "Keep the API task and the open review findings." });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.status, "started");
  // It holds the member's turns: work given now runs after it.
  const next = chatParts(service).turnQueue.reserveParticipantTurn(conversation.id, worker.id, "shared");
  let nextRan = false;
  void next.wait().then(() => { nextRan = true; });
  await delay(30);
  assert.equal(nextRan, false, "the work given after the compaction waits for it");
  release();
  await waitFor(() => compacted.length === 1 && nextRan, 3000);
  next.release();
  assert.deepEqual(compacted, [{ id: worker.id, instructions: "Keep the API task and the open review findings." }]);
  await waitFor(() => storage.current.messages.some((message: any) => message.metadata?.compaction?.outcome === "completed"), 3000);
  const line = storage.current.messages.find((message: any) => message.metadata?.compaction?.outcome === "completed");
  assert.equal(line.content, "@main compacted @worker context. Focus: Keep the API task and the open review findings.");
  assert.deepEqual(line.metadata.compaction, {
    triggeredBy: "agent", participantId: worker.id, outcome: "completed", instructionsProvided: true, cli: worker.kind, requestedByParticipantId: main.id
  });
  assert.equal(storage.current.metadata.agentContextUsageByParticipant[worker.id].usedTokens, 30_000);
  await waitFor(() => !(storage.current.metadata.activeRunIds ?? []).length, 3000);
});

test("refused: without the right, by another member, for itself, one that never worked, without instructions, an unknown handle", async () => {
  const cases: Array<{ name: string; setup: ReturnType<typeof chat>; actor?: (main: ChatParticipant) => any; request: Record<string, unknown>; status: string }> = [
    { name: "Compact without asking off", setup: chat({ mainRight: "ask" }), request: { target: "worker", instructions: "Keep it." }, status: "rejected" },
    { name: "not the main session", setup: chat(), actor: () => ({ ...actorOf(chatParticipant({ id: "worker-id" })), participantId: "worker-id" }),
      request: { target: "main", instructions: "Keep it." }, status: "rejected" },
    { name: "itself", setup: chat(), request: { target: "main", instructions: "Keep it." }, status: "rejected" },
    { name: "never worked", setup: chat({ workerReply: false }), request: { target: "worker", instructions: "Keep it." }, status: "no_active_session" },
    { name: "no instructions", setup: chat(), request: { target: "worker" }, status: "invalid_request" },
    { name: "no member named", setup: chat(), request: { instructions: "Keep it." }, status: "invalid_request" },
    { name: "unknown", setup: chat(), request: { target: "nobody", instructions: "Keep it." }, status: "not_found" }
  ];
  for (const item of cases) {
    let compactions = 0;
    const { service } = testService({
      conversation: item.setup.conversation,
      compactSession: async (runParticipant) => { compactions += 1; return { participant: runParticipant, ok: true }; }
    });
    const answer = await service.compactParticipantFromTool(item.actor ? item.actor(item.setup.main) : actorOf(item.setup.main), item.request);
    assert.equal(answer.ok, false, item.name);
    assert.equal(answer.status, item.status, `${item.name}: ${JSON.stringify(answer)}`);
    await delay(20);
    assert.equal(compactions, 0, `${item.name}: nothing compacted`);
  }
});

test("refused for a member that is busy: one already being compacted", async () => {
  const { main, conversation } = chat();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let compactions = 0;
  const { service } = testService({
    conversation,
    compactSession: async (runParticipant) => { compactions += 1; await held; return { participant: runParticipant, ok: true, sessionId: "session-worker" }; }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tmpdir();
  assert.equal((await service.compactParticipantFromTool(actorOf(main), { target: "worker", instructions: "Keep it." })).status, "started");
  const again = await service.compactParticipantFromTool(actorOf(main), { target: "worker", instructions: "Keep it." });
  assert.equal(again.ok, false);
  assert.equal(again.status, "busy", JSON.stringify(again));
  assert.match(String(again.error), /@worker is compacting now/);
  release();
  await waitFor(() => compactions === 1, 3000);
  await delay(30);
  assert.equal(compactions, 1);
});

test("two calls at once compact a member once", async () => {
  const { main, conversation } = chat();
  let compactions = 0;
  const { service } = testService({
    conversation,
    compactSession: async (runParticipant) => { compactions += 1; await delay(50); return { participant: runParticipant, ok: true, sessionId: "session-worker" }; }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tmpdir();
  const answers = await Promise.all([1, 2].map(() => service.compactParticipantFromTool(actorOf(main), { target: "worker", instructions: "Keep it." })));
  assert.deepEqual(answers.map((answer) => answer.status).sort(), ["busy", "started"]);
  await waitFor(() => compactions === 1, 3000);
  await delay(80);
  assert.equal(compactions, 1);
});

test("a main session on a machine asks the User's server to compact a member that runs elsewhere, answers once that device took it, and follows it to its end", async () => {
  for (const ending of ["line", "no line"] as const) {
    const { main, worker, conversation } = chat({ main: { homeMachineId: "box" } });
    conversation.messages.push(acceptedMessage());
    const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("Not compacted on the machine."); } });
    service.setHostMachineId("box");
    const link = fakeServerLink("machine-device");
    service.setServerLink(link);
    let answer: Record<string, unknown> | undefined;
    void service.compactParticipantFromTool(actorOf(main), { target: "worker", instructions: "Keep the task." }).then((value) => { answer = value; });
    await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
    const asked = link.ops.filter((op) => op.kind === "turn.request") as Array<Extract<HubOp, { kind: "turn.request" }>>;
    assert.equal(asked.length, 1);
    assert.equal(asked[0].participantId, worker.id);
    assert.deepEqual(asked[0].request, { kind: "compaction", triggeredBy: "agent", instructions: "Keep the task.", requestedByParticipantId: main.id });
    await delay(30);
    assert.equal(answer, undefined, "not before the device the member runs on took it");
    const again = await service.compactParticipantFromTool(actorOf(main), { target: "worker", instructions: "Keep the task." });
    assert.equal(again.status, "busy", "asked again meanwhile");
    const turn: HubTurn = { runId: asked[0].runId, conversationId: conversation.id, messageId: "anchor", participantId: worker.id, state: "claimed", executorDeviceId: "desktop-device" };
    await service.applyServerEntries([fromServer("desktop-device", { kind: "turn.claim", turn })]);
    await waitFor(() => answer !== undefined);
    assert.equal(answer!.status, "started", JSON.stringify(answer));
    if (ending === "line") {
      await service.applyServerEntries([fromServer("desktop-device", { kind: "message.create", message: { id: `line-${turn.runId}`, role: "system", content: "@main compacted @worker context. Focus: Keep the task.",
        createdAt: new Date().toISOString(), status: "done", metadata: { runId: turn.runId, serverSeq: 900, compaction: { triggeredBy: "agent", participantId: worker.id, outcome: "completed", instructionsProvided: true, requestedByParticipantId: main.id } } } as never })]);
    }
    await service.applyServerEntries([fromServer("desktop-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: ending === "line" ? "done" : "error" } })]);
    await delay(50);
    const lines = storage.current.messages.filter((message: any) => message.role === "system").map((message: any) => message.content);
    assert.deepEqual(lines, ending === "line"
      ? ["@main compacted @worker context. Focus: Keep the task."]
      : ["Could not compact @worker context: the device it runs on ended the compaction without saying how it went."], ending);
    assert.equal((chatParts(service).memberCompaction as any).compacting.size, 0, "free again once it ended");
  }
});

test("the member's device runs a compaction the main session asked on the server, and its line names the main session", async () => {
  const { main, worker, conversation } = chat({ main: { homeMachineId: "box" } });
  conversation.messages.push(acceptedMessage());
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { service, storage } = testService({
    conversation,
    compactSession: async (runParticipant) => { await held; return { participant: runParticipant, ok: true, sessionId: "session-worker" }; }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tmpdir();
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  // Its own reads after it was taken are slow (a large chat).
  const store = chatParts(service).store;
  const read = store.readStoredChatStateForRefresh.bind(store);
  store.readStoredChatStateForRefresh = (async (...args: Parameters<typeof read>) => { await delay(150); return read(...args); }) as typeof read;
  void service.startServerTurn({ runId: "turn-main-asked", conversationId: conversation.id, messageId: "anchor", participantId: worker.id, state: "requested",
    requestedBy: "machine-device", request: { kind: "compaction", triggeredBy: "agent", instructions: "Keep the task.", requestedByParticipantId: main.id } });
  // Once it is taken (the main session hears "started" then), the work it
  // gives the member next waits for it.
  await waitFor(() => link.ops.some((op) => op.kind === "turn.claim"), 3000);
  const next = chatParts(service).turnQueue.reserveParticipantTurn(conversation.id, worker.id, "shared");
  let nextRan = false;
  void next.wait().then(() => { nextRan = true; });
  await delay(30);
  assert.equal(nextRan, false, "a turn asked after it was taken runs after it");
  release();
  await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"), 3000);
  await waitFor(() => nextRan, 3000);
  next.release();
  const line = storage.current.messages.at(-1);
  assert.equal(line.content, "@main compacted @worker context. Focus: Keep the task.");
  assert.equal(line.metadata.compaction.requestedByParticipantId, main.id);
});

test("the User's server lets a machine compact a member elsewhere only for the main session that runs there and compacts without asking", () => {
  const { main, worker, conversation } = chat({ main: { homeMachineId: "box" } });
  const asked = { kind: "compaction", requestedByParticipantId: main.id };
  assert.equal(machineMayCompact(conversation, "box", worker.id, asked), true);
  assert.equal(machineMayCompact(conversation, "other-box", worker.id, asked), false, "the main session runs on another machine");
  assert.equal(machineMayCompact(conversation, "box", worker.id, { kind: "compaction" }), false, "nobody named as asking");
  assert.equal(machineMayCompact(conversation, "box", worker.id, { kind: "compaction", requestedByParticipantId: worker.id }), false, "not the main session");
  assert.equal(machineMayCompact(conversation, "box", main.id, asked), false, "itself");
  assert.equal(machineMayCompact(conversation, "box", "gone", asked), false, "not in the chat");
  const askFirst = chat({ mainRight: "ask", main: { homeMachineId: "box" } });
  assert.equal(machineMayCompact(askFirst.conversation, "box", askFirst.worker.id, { kind: "compaction", requestedByParticipantId: askFirst.main.id }), false,
    "Compact without asking off");
});
