import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatParticipant, ChatParticipantSession, ChatRoleConfig, Conversation } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { canRestartParticipant, memberProcessRestartable } from "../../shared/chatParticipantStatus";
import { memberRestartLine, restartingMembers } from "../../shared/memberRestart";
import { ChatService } from "./chat";
import type { ChatServerLink } from "./chatServerOps";
import type { HubFeedEntry, HubOp, HubOpEffect, HubTurn } from "../../shared/hubOps";

const NOW = "2026-01-01T00:00:00.000Z";
const ROLE: ChatRoleConfig = { id: "engineer", label: "Engineer", instructions: "Answer directly.", version: 1, updatedAt: NOW };
const RESTARTED = "Restarted @admin. Its next reply picks up the current connectors and settings.";

test("restarting a member here closes only its processes, keeps its session and says so in the chat", async () => {
  const participant = chatParticipant();
  const other = chatParticipant({ id: "other", handle: "other" });
  const conversation = chatConversation([participant, other], [chatSession(participant, "session-1")]);
  const { service, storage, closed } = testService(conversation);
  const lines: string[] = [];

  await service.restartParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "restart-1" }, undefined, (progress) => lines.push(progress.message));

  assert.deepEqual(closed, [{ conversationId: conversation.id, participantId: participant.id, reason: "user-restart" }]);
  assert.equal(storage.current.messages.at(-1)?.role, "system");
  assert.equal(storage.current.messages.at(-1)?.content, RESTARTED);
  assert.equal((storage.current.metadata.participantSessions as ChatParticipantSession[])[0]?.sessionId, "session-1", "its next turn resumes the same session");
  assert.deepEqual(lines, ["Restarting @admin.", "Restarted @admin."]);
});

test("a restart says how many background tasks it stopped", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  const { service, storage, closed } = testService(conversation);
  (service as any).memberBackgroundTasks.set(conversation.id, new Map([[participant.id, { source: "local", labels: ["npm run dev", "tail -f log"] }]]));

  await assert.rejects(service.restartParticipant({ conversationId: conversation.id, participantId: participant.id }),
    /@admin has background tasks running\. Restart it again to stop them\./, "never stopped without the User's word");
  assert.deepEqual(closed, []);

  await service.restartParticipant({ conversationId: conversation.id, participantId: participant.id, stopBackgroundTasks: true });

  assert.equal(closed.length, 1);
  assert.equal(storage.current.messages.at(-1)?.content, "Restarted @admin and stopped its 2 background tasks. Its next reply picks up the current connectors and settings.");
  assert.equal(memberRestartLine("admin", 1), "Restarted @admin and stopped its background task. Its next reply picks up the current connectors and settings.");
});

test("a process that did not close is not reported as restarted", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  const { service, storage, runner } = testService(conversation);
  runner.closeWarmAgents = async () => { throw new Error("native process close not confirmed"); };

  await assert.rejects(service.restartParticipant({ conversationId: conversation.id, participantId: participant.id }),
    /Could not restart @admin: its process did not close \(native process close not confirmed\)/);
  assert.equal(storage.current.messages.some((message: any) => message.role === "system"), false);
});

test("a reply the CLI started on its own, not yet a run of the chat, refuses the restart", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  const { service, closed, runner } = testService(conversation);
  runner.memberProcessAnswering = (conversationId: string, participantId: string) => conversationId === conversation.id && participantId === participant.id;

  await assert.rejects(service.restartParticipant({ conversationId: conversation.id, participantId: participant.id }), /@admin is busy/);
  assert.deepEqual(closed, []);
});

test("a member waiting for a request it asked is not busy", async () => {
  const asker = chatParticipant();
  const target = chatParticipant({ id: "target", handle: "target" });
  const conversation = chatConversation([asker, target], [chatSession(asker, "session-1")]);
  conversation.messages.push({ id: "ask", role: "participant", participantId: asker.id, content: "@target look", createdAt: NOW, status: "done",
    metadata: { participantRequest: { requesterParticipantId: asker.id, items: [{ targetParticipantId: target.id, status: "running" }] } } } as any);
  const { service, closed } = testService(conversation);

  await service.restartParticipant({ conversationId: conversation.id, participantId: asker.id });
  assert.deepEqual(closed.map((item) => item.participantId), [asker.id], "its reply resumes the same session");
});

test("a member removed while its restart waited gets no line", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  const { service, storage, closed } = testService(conversation);
  const held = (service as any).reserveParticipantTurn(conversation.id, participant.id, "shared");

  const restarting = service.restartParticipant({ conversationId: conversation.id, participantId: participant.id });
  await delay(20);
  storage.current.metadata.participants = [];
  held.release();
  await restarting;
  assert.equal(closed.length, 1, "its process ends with it anyway");
  assert.equal(storage.current.messages.some((message: any) => message.role === "system"), false);
});

test("one restart of a member at a time", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  const { service, closed } = testService(conversation);
  const held = (service as any).reserveParticipantTurn(conversation.id, participant.id, "shared");

  const first = service.restartParticipant({ conversationId: conversation.id, participantId: participant.id });
  await assert.rejects(service.restartParticipant({ conversationId: conversation.id, participantId: participant.id }), /@admin is already restarting/);
  held.release();
  await first;
  assert.equal(closed.length, 1);
});

test("a member that is answering is not restarted", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  answering(conversation, participant, "turn-run");
  const { service, storage, closed } = testService(conversation);
  (service as any).rememberActiveChatRun(conversation.id, "turn-run");

  await assert.rejects(service.restartParticipant({ conversationId: conversation.id, participantId: participant.id }), /@admin is busy/);
  assert.deepEqual(closed, []);
  assert.equal(storage.current.messages.some((message: any) => message.role === "system"), false);
});

test("a turn that took the member's queue just before is not cut off: the restart waits for its end", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  const { service, closed } = testService(conversation);
  const held = (service as any).reserveParticipantTurn(conversation.id, participant.id, "shared");

  const restarting = service.restartParticipant({ conversationId: conversation.id, participantId: participant.id });
  await delay(30);
  assert.deepEqual(closed, [], "its process stays while that turn runs");
  held.release();
  await restarting;
  assert.equal(closed.length, 1);
});

test("Gemini members have no live process to restart", async () => {
  assert.equal(memberProcessRestartable("gemini-cli"), false);
  assert.equal(memberProcessRestartable("claude-code"), true);
  assert.equal(memberProcessRestartable("codex-cli"), true);
  const participant = chatParticipant({ kind: "gemini-cli" });
  const { service, closed } = testService(chatConversation([participant], []));
  await assert.rejects(service.restartParticipant({ conversationId: "chat-restart", participantId: participant.id }), /nothing to restart/);
  assert.deepEqual(closed, []);
});

test("the button is off while the member answers or compacts, on while idle or in the background", () => {
  assert.deepEqual(
    (["idle", "stopped", "error", "background", "running", "pending", "compacting"] as const).map((status) => [status, canRestartParticipant(status)]),
    [["idle", true], ["stopped", true], ["error", true], ["background", true], ["running", false], ["pending", false], ["compacting", false]]
  );
});

test("a member on a machine whose runtime cannot restart members is refused before anything is asked", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service, closed } = testService(conversation);
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);

  service.setMachineMemberRestartSupport(() => "outdated");
  await assert.rejects(service.restartParticipant({ conversationId: conversation.id, participantId: participant.id }),
    /Box still runs an older version of AccordAgents that cannot restart members/);
  service.setMachineMemberRestartSupport(() => "unknown");
  await assert.rejects(service.restartParticipant({ conversationId: conversation.id, participantId: participant.id }),
    /Box has not connected to this computer yet/);
  service.setMachineMemberRestartSupport(() => "disconnected");
  await assert.rejects(service.restartParticipant({ conversationId: conversation.id, participantId: participant.id }),
    /Box is not connected\. A stopped machine starts its members anew/, "asking would only wake a stopped machine");
  assert.deepEqual(link.ops, [], "nothing is asked of a machine that cannot or need not restart it");
  assert.deepEqual(closed, [], "never closed on the desktop");
});

test("a member on a machine is restarted there: a restart turn on the server, shown as waiting until the machine takes it", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service, storage, closed } = testService(conversation);
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  service.setMachineMemberRestartSupport(() => "supported");
  const lines: string[] = [];

  const running = service.restartParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "machine-restart" }, undefined, (progress) => lines.push(progress.message));
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  const request = link.ops.find((op) => op.kind === "turn.request") as Extract<HubOp, { kind: "turn.request" }>;
  assert.equal(request.runId, "turn-machine-restart");
  assert.equal(request.messageId, "anchor", "placed against a message the server holds");
  assert.equal(request.request?.kind, "restart");
  assert.equal(typeof request.request?.askedAt, "string", "so a restart that waited too long is not run later");
  assert.equal(request.request?.stopBackgroundTasks, undefined, "the User did not agree to stop background tasks");
  await waitFor(() => lines.length === 2);
  const turn: HubTurn = { runId: request.runId, conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "claimed", executorDeviceId: "machine-device" };
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "message.create",
    message: { id: "line-restart", role: "system", content: RESTARTED, createdAt: NOW, status: "done", metadata: { serverSeq: 901, serverWriter: "machine-device" } } as any })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: "done" } })]);
  await running;

  assert.deepEqual(closed, [], "its process is on the machine");
  assert.equal(storage.current.messages.at(-1)?.content, RESTARTED);
  assert.equal(storage.current.messages.filter((message: any) => message.role === "system").length, 1, "the machine's line only");
  assert.deepEqual(lines, ["Restarting @admin.", "Restarting @admin. Waiting for machine Box", "Restarting @admin.", "Restarted @admin."]);
});

test("stopping a restart the machine has not taken asks the server to stop it", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service } = testService(conversation);
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  service.setMachineMemberRestartSupport(() => "supported");
  const controller = new AbortController();
  const lines: Array<[string, string]> = [];

  const running = service.restartParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "stop-me" }, controller.signal,
    (progress) => lines.push([progress.phase, progress.message]));
  await waitFor(() => lines.length === 2);
  controller.abort();
  await assert.rejects(running, /Stopped restarting @admin\./);
  assert.deepEqual(link.ops.filter((op) => op.kind.startsWith("turn.")).map((op) => op.kind), ["turn.request", "turn.stop"]);
  assert.deepEqual(lines.at(-1), ["cancelled", "Could not restart @admin."]);
  assert.equal(restartingMembers(lines.map(([phase, message]) => ({ runId: "stop-me", phase, message, memberRestart: { participantId: participant.id }, createdAt: NOW } as any))).size, 0,
    "the row stops spinning");
});

test("a machine restart that ended badly is reported as not restarted", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service } = testService(conversation);
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  service.setMachineMemberRestartSupport(() => "supported");

  const running = service.restartParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "machine-busy" });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  const turn: HubTurn = { runId: "turn-machine-busy", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "claimed", executorDeviceId: "machine-device" };
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: "error" } })]);
  await assert.rejects(running, /Could not restart @admin on Box/);
});

test("the machine takes a restart turn of its member: claims it, closes the process, writes the line, then ends it", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
  conversation.messages.push(acceptedMessage());
  const { service, storage, closed } = testService(conversation);
  service.setHostMachineId("box");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);

  await service.startServerTurn({ runId: "turn-desktop-restart", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    request: { kind: "restart", askedAt: new Date().toISOString() } });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));

  assert.deepEqual(closed, [{ conversationId: conversation.id, participantId: participant.id, reason: "user-restart" }]);
  assert.deepEqual(link.ops.filter((op) => op.kind.startsWith("turn.")).map((op) => op.kind), ["turn.claim", "turn.finish"]);
  assert.equal((link.ops.find((op) => op.kind === "turn.finish") as Extract<HubOp, { kind: "turn.finish" }>).outcome, "done");
  const line = storage.current.messages.at(-1);
  assert.equal(line.content, RESTARTED);
  const lineOp = link.ops.findIndex((op) => op.kind === "message.create" && op.message.id === line.id);
  assert.ok(lineOp >= 0 && lineOp < link.ops.findIndex((op) => op.kind === "turn.finish"), "the line reaches the server before the turn's end");
  assert.equal(storage.current.messages.some((message: any) => message.role === "participant"), false, "never taken as an ordinary turn");
});

test("a machine whose member is answering ends the restart turn as an error and leaves the process", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
  conversation.messages.push(acceptedMessage());
  answering(conversation, participant, "other-run");
  const { service, closed } = testService(conversation);
  (service as any).rememberActiveChatRun(conversation.id, "other-run");
  service.setHostMachineId("box");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);

  await service.startServerTurn({ runId: "turn-busy-restart", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    request: { kind: "restart", askedAt: new Date().toISOString() } });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));

  assert.deepEqual(closed, []);
  assert.equal((link.ops.find((op) => op.kind === "turn.finish") as Extract<HubOp, { kind: "turn.finish" }>).outcome, "error");
});

/** The member's turn runs: its bubble is pending and its run is live. */
function answering(conversation: Conversation, participant: ChatParticipant, runId: string): void {
  conversation.messages.push({ id: `reply-${runId}`, role: "participant", participantId: participant.id, content: "", createdAt: NOW, status: "pending", metadata: { runId } } as any);
  conversation.metadata = { ...conversation.metadata, running: true, runId, activeRunIds: [runId] };
}

test("a machine does not run a restart asked too long ago, nor stop background tasks the User did not agree to stop", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
  conversation.messages.push(acceptedMessage());
  const { service, closed } = testService(conversation);
  service.setHostMachineId("box");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);
  const outcomes = () => link.ops.filter((op) => op.kind === "turn.finish").map((op) => (op as Extract<HubOp, { kind: "turn.finish" }>).outcome);

  await service.startServerTurn({ runId: "turn-old", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    request: { kind: "restart", askedAt: new Date(Date.now() - 11 * 60_000).toISOString() } });
  await waitFor(() => outcomes().length === 1);
  assert.deepEqual(outcomes(), ["error"]);

  (service as any).memberBackgroundTasks.set(conversation.id, new Map([[participant.id, { source: "local", labels: ["npm run dev"] }]]));
  await service.startServerTurn({ runId: "turn-tasks", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    request: { kind: "restart", askedAt: new Date().toISOString() } });
  await waitFor(() => outcomes().length === 2);
  assert.deepEqual(outcomes(), ["error", "error"]);
  assert.deepEqual(closed, []);

  await service.startServerTurn({ runId: "turn-agreed", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    request: { kind: "restart", askedAt: new Date().toISOString(), stopBackgroundTasks: true } });
  await waitFor(() => outcomes().length === 3);
  assert.deepEqual(outcomes(), ["error", "error", "done"]);
  assert.equal(closed.length, 1);
});

test("the members list shows a restart until it ends, and a machine's wait while it lasts", () => {
  const progress = (runId: string, participantId: string, phase: string, message: string, waiting?: boolean): any =>
    ({ runId, phase, message, memberRestart: { participantId, ...(waiting ? { waiting } : {}) }, createdAt: NOW });
  const restarting = restartingMembers([
    progress("r1", "a", "initial", "Restarting @a."),
    progress("r1", "a", "initial", "Restarting @a. Waiting for machine Box", true),
    progress("r2", "b", "initial", "Restarting @b."),
    progress("r2", "b", "done", "Restarted @b."),
    { runId: "other", phase: "initial", message: "Working", createdAt: NOW } as any
  ]);
  assert.deepEqual([...restarting.entries()], [["a", { runId: "r1", message: "Restarting @a. Waiting for machine Box", waiting: true }]]);
});

function testService(conversation: Conversation): { service: ChatService; storage: any; runner: any; closed: Array<{ conversationId: string; participantId: string; reason: string }> } {
  const closed: Array<{ conversationId: string; participantId: string; reason: string }> = [];
  const storage = {
    current: clone(conversation),
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(saved: Conversation): Promise<void> {
      this.current = clone(saved);
    },
    conversationTombstones() {
      return { isDeleted: async () => false, mark: async () => undefined, pendingCopies: async () => [] };
    }
  };
  const settings = {
    async getPublicSettings(): Promise<Record<string, unknown>> {
      return { chatRoleConfigs: [ROLE], chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT };
    }
  };
  const cliRunner: any = {
    async detectAgents(): Promise<[]> { return []; },
    async closeWarmAgents(conversationId: string, participantId: string, reason: string): Promise<void> {
      closed.push({ conversationId, participantId, reason });
    },
    async run(): Promise<Record<string, unknown>> { throw new Error("No turn expected in this test."); }
  };
  const debugLogs = { async write(): Promise<void> { return undefined; } };
  return { service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never), storage, runner: cliRunner, closed };
}

function chatParticipant(patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return {
    id: patch.id ?? "claude-admin",
    handle: patch.handle ?? "admin",
    roleConfigId: ROLE.id,
    kind: patch.kind ?? "claude-code",
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions()),
    ...patch
  };
}

function chatSession(participant: ChatParticipant, sessionId: string): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId,
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleRuntime: "claude-agent",
    participantKind: participant.kind,
    participantAgentMode: "default",
    participantPermissions: normalizeChatAgentPermissions(participant.permissions),
    runtimeConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  } as ChatParticipantSession;
}

function chatConversation(participants: ChatParticipant[], sessions: ChatParticipantSession[]): Conversation {
  return { id: "chat-restart", title: "Restart test", kind: "chat", createdAt: NOW, updatedAt: NOW, messages: [], findings: [],
    metadata: { participants, participantSessions: sessions } };
}

/** A message the server holds (a restart turn is placed against one). */
function acceptedMessage(id = "anchor"): any {
  return { id, role: "user", content: "Earlier.", createdAt: NOW, status: "done", metadata: { threadId: id, serverSeq: 7, serverWriter: "desktop-device" } };
}

/** The User's server as a chat sees it, played by the test. */
function fakeServerLink(deviceId: string) {
  const ops: HubOp[] = [];
  let seq = 100;
  const turnOf = (op: HubOp, state: HubTurn["state"]): HubTurn | undefined => op.kind === "turn.request" || op.kind === "turn.claim"
    ? { runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId, state,
      ...(state === "requested" ? { requestedBy: deviceId } : { executorDeviceId: deviceId }),
      ...(op.kind === "turn.request" && op.request ? { request: op.request } : {}) }
    : undefined;
  const link: ChatServerLink & { ops: HubOp[] } = {
    ops,
    deviceId: () => deviceId,
    queueSql: (queued) => { ops.push(...queued); return ""; },
    enqueue: async (queued) => { ops.push(...queued); },
    nudge: () => undefined,
    messageAccepted: async () => ({ status: "accepted", seq: ++seq }),
    opAnswered: async (opId) => {
      const op = ops.find((item) => item.opId === opId);
      if (op?.kind === "turn.request") return { status: "accepted", seq: ++seq, turn: turnOf(op, "requested") };
      if (op?.kind === "turn.claim") return { status: "accepted", seq: ++seq, claim: "claimed", turn: turnOf(op, "claimed") };
      return { status: "accepted", seq: ++seq };
    },
    waitingTurns: async () => ({ requested: [], claimed: [] }),
    machineName: () => "Box"
  };
  return link;
}

let feedSeq = 0;
function fromServer(deviceId: string, effect: HubOpEffect): HubFeedEntry {
  feedSeq += 1;
  return { seq: 500 + feedSeq, opId: `feed-${feedSeq}`, deviceId, conversationId: "chat-restart", acceptedAt: new Date().toISOString(), effect };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for the condition.");
}
