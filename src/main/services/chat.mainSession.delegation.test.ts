import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { participantForRun } from "./chat/members/identity";
import { normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES } from "../../shared/chatParticipantRequests";
import type { ChatMessage, ChatParticipantRequestItem } from "../../shared/types";
import {
  childActor, delegatedManager, GENERIC_ROLE, leftAlone, MAIN_ROLE, mainActor, mainSession, mainSessionChat, member, NOW,
  participantsOf, permissions, quitRequestChat, requestBatch, resumesOf, sessionRecord, testService, waitFor
} from "./chat/test/mainSessionFixtures";

test("only the main session delegates; a role is not enough", async () => {
  const main = mainSession();
  const impostor = { ...member("impostor-id", "impostor"), roleConfigId: MAIN_ROLE.id };
  const conversation = mainSessionChat([main, impostor]);
  const { service, storage } = testService({ conversation });
  const before = participantsOf(storage.current).length;

  const refused = await service.delegateTaskFromTool(mainActor(undefined, { participantId: impostor.id }), { task: "Do it." });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "not_main_session");
  const noCapability = await service.delegateTaskFromTool(mainActor(["participants.request"]), { task: "Do it." });
  assert.equal(noCapability.ok, false);
  assert.equal(noCapability.code, "not_main_session");
  assert.equal(participantsOf(storage.current).length, before, "nobody added");
});

test("the main session adding a member broader than itself through the member tool gets a card instead", async () => {
  const main = mainSession();
  const { service, storage } = testService({ conversation: mainSessionChat([main]) });
  const actor = mainActor(["participants.manage"]);
  const broader = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "web", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", permissions: permissions({ webAccess: true }) } }]
  });
  assert.equal(broader.status, "pending_user_approval");
  const within = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "reader", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", permissions: permissions() } }]
  });
  assert.equal(within.status, "auto_applied");
  assert.deepEqual(participantsOf(storage.current).map((participant) => participant.handle), ["main", "reader"]);
});

test("the main session's task gives its member who added it, and that member runs no broader than the main session as it is now", async () => {
  const main = mainSession("claude-code", { agentMode: "auto", permissions: permissions({ workspaceWrite: true, webAccess: true, requestParticipants: "allow" }) });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "s")] });
  const { service, storage, runs } = testService({ conversation });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Check the docs online.", agentMode: "auto", permissions: { webAccess: true, workspaceWrite: true } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(child.delegatedByParticipantId, main.id);
  assert.equal(child.agentMode, "auto");
  await waitFor(() => runs.some((run) => run.participant.id === child.id));
  assert.equal(runs.find((run) => run.participant.id === child.id)!.options.agentMode, "auto", "as broad as the main session while it is");

  // The User lowers the main session to Plan with no web: its member's next
  // turn runs in Plan with no web, though its own settings are unchanged.
  const lowered = participantsOf(storage.current).map((participant) => participant.id === main.id
    ? { ...participant, agentMode: "plan" as const, permissions: permissions({ workspaceWrite: true, webAccess: false, requestParticipants: "allow" }) }
    : participant);
  storage.current = { ...storage.current, metadata: { ...storage.current.metadata, participants: lowered } };
  const asked = await service.requestParticipantsFromTool(mainActor(undefined, { triggerMessageId: "second-trigger" }), { requests: [{ target: child.handle, prompt: "Again." }] });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  await waitFor(() => runs.filter((run) => run.participant.id === child.id).length === 2);
  const second = runs.filter((run) => run.participant.id === child.id)[1];
  assert.equal(second.options.agentMode, "plan");
  assert.equal(normalizeChatAgentPermissions(second.options.permissions).webAccess, false);
  assert.equal(normalizeChatAgentPermissions(second.options.permissions).workspaceWrite, false, "plan mode has no edits");
  const stored = participantsOf(storage.current).find((participant) => participant.id === child.id)!;
  assert.equal(stored.agentMode, "auto", "its own settings are kept: raising the main session again gives them back");

  // It asks others no more freely than the main session can now, and a
  // member the User added herself is not held to the main session's.
  const own = member("own-id", "own", { kind: "claude-code", agentMode: "auto", permissions: permissions({ webAccess: true, requestParticipants: "allow" }) });
  const internals = service as any;
  const asking = participantsOf(storage.current).map((participant) => participant.id === main.id
    ? { ...participant, permissions: permissions({ requestParticipants: "ask" }) }
    : participant);
  const chatNow = { ...storage.current, metadata: { ...storage.current.metadata, participants: [...asking, own] } };
  assert.equal(normalizeChatAgentPermissions(participantForRun(chatNow, stored).permissions).requestParticipants, "ask");
  assert.equal(participantForRun(chatNow, stored).agentMode, "plan");
  assert.equal(participantForRun(chatNow, own), own);
});

test("a member the main session made manages members no more freely than the main session can now", async () => {
  const main = mainSession("claude-code", { permissions: permissions({ workspaceWrite: true, requestParticipants: "allow", manageRolesParticipants: "ask" }) });
  const child = delegatedManager();
  const { service } = testService({ conversation: mainSessionChat([main, child]) });
  const result = await service.requestParticipantChangeFromTool(childActor(), {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "reader", roleConfigId: GENERIC_ROLE.id, kind: "claude-code", permissions: permissions() } }]
  });
  assert.equal(result.status, "pending_user_approval");
});

test("the main session's tasks and members' questions to it are not held to the chain limit; other requests still are", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const child = delegatedManager({ kind: "codex-cli" });
  const other = member("other-id", "other");
  const conversation = mainSessionChat([main, child, other], { participantSessions: [sessionRecord(main, "s")] });
  // The chain already holds as many requests as the limit allows.
  for (let index = 0; index < CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES; index += 1) {
    conversation.messages.push({
      id: `request-${index}`, role: "participant", participantId: other.id, participantLabel: "@other", content: "Request", createdAt: NOW, status: "done",
      metadata: { participantRequest: {
        id: `batch-${index}`, requesterParticipantId: other.id, requesterHandle: other.handle, source: "mcp", resumeRequester: false, status: "completed",
        depth: 1, requesterDepth: 0, chainRootId: "user-message", createdAt: "2026-11-20T11:00:00.000Z", updatedAt: NOW, items: []
      } }
    } as ChatMessage);
  }
  const { service } = testService({ conversation });
  chatParts(service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;
  const delegated = await service.delegateTaskFromTool(mainActor(), { task: "Write the tests." });
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  const question = await service.requestParticipantsFromTool(childActor(undefined, { triggerMessageId: "child-turn", chainRootId: "user-message" }), {
    requests: [{ target: "main", prompt: "Which database did User pick?" }]
  });
  assert.equal(question.ok, true, JSON.stringify(question));
  const toOther = await service.requestParticipantsFromTool(childActor(undefined, { triggerMessageId: "child-turn-2", chainRootId: "user-message" }), {
    requests: [{ target: "other", prompt: "Review this." }]
  });
  assert.equal(toOther.ok, false);
  assert.match(JSON.stringify(toOther), /member request chain limit/);
});

test("a member the main session made proposes a scheduled task on the normal card, as any member does", async () => {
  const main = mainSession();
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "s")] });
  const { service, storage } = testService({ conversation });
  chatParts(service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;
  const delegated = await service.delegateTaskFromTool(mainActor(), { task: "Watch the build every minute." });
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  const childId = String(delegated.participantId);
  const request = {
    kind: "script-change", op: "create", scriptId: "script-0000-build", revisionId: "rev-00000001", contentHash: "h",
    name: "Build watcher", description: "d", hostId: "desktop", hostLabel: "This Mac", runtime: "node", entry: "w.mjs",
    schedule: { kind: "interval", everySeconds: 60 }, scheduleText: "Every minute", timeoutSeconds: 300,
    secretNames: [], permissions: { chatIds: [conversation.id], participantIds: [childId], maxWakeupsPerHour: 6 },
    chatLabels: {}, participantLabels: {}, fileCount: 1, totalBytes: 10
  };
  const calls: string[] = [];
  service.setScriptHost({
    proposeChange: async () => ({ kind: "approval", request: request as any, summary: "Add the scheduled task \"Build watcher\"", missingSecretNames: [] }),
    attachApproval: async () => { calls.push("attach"); },
    assertApprovable: async () => undefined,
    applyApproved: async () => { calls.push("apply"); return "Added the scheduled task \"Build watcher\"."; },
    rejectPending: async () => { calls.push("reject"); },
    listForAgent: async () => [],
    runs: async () => []
  } as any);
  const result = await service.scriptToolFromApp(childActor([], { participantId: childId }), "app_scripts_request_change", { op: "create" });
  assert.equal(result.status, "pending_user_approval", JSON.stringify(result));
  const pending = (storage.current.metadata.pendingAppToolApprovals as Array<{ id: string; status: string; requesterParticipantId: string }>).find((item) => item.id === result.approvalId)!;
  assert.equal(pending.status, "pending", "User approves it on its card");
  assert.equal(pending.requesterParticipantId, childId);
  assert.deepEqual(calls, ["attach"]);
});

test("members made before their task's title was kept with them get it once from the whole history: their delegation's, else their first task's line, never a handle", async () => {
  const main = mainSession();
  const drew = member("drew-id", "drew", { delegatedByParticipantId: main.id });
  const gera = member("gera-id", "gera");
  const sam = member("sam-id", "sam");
  const kept = member("kept-id", "kept", { taskTitle: "Already named" });
  const at = (minute: number): string => `2026-11-22T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const request = (id: string, minute: number, items: Array<Partial<ChatParticipantRequestItem> & { targetParticipantId: string; prompt: string }>, delegation = false): ChatMessage => ({
    id, role: "participant", participantId: main.id, content: `request ${id}`, createdAt: at(minute), status: "done",
    metadata: { participantRequest: {
      id: `batch-${id}`, requesterParticipantId: main.id, requesterHandle: "main", source: "mcp", resumeRequester: true, status: "completed", depth: 1,
      createdAt: at(minute), updatedAt: at(minute), ...(delegation ? { delegation: { start: "clean" as const } } : {}),
      items: items.map((item) => ({ targetHandle: "x", status: "answered" as const, createdAt: at(minute), updatedAt: at(minute), ...item }))
    } }
  } as ChatMessage);
  const conversation = mainSessionChat([main, drew, gera, sam, kept]);
  conversation.messages = [
    request("d-drew", 1, [{ targetParticipantId: drew.id, prompt: "Implement new chats in General.", title: "Новые чаты в General" }], true),
    request("g-1", 2, [{ targetParticipantId: gera.id, prompt: "Check the release feed. Then report the counts." }]),
    request("f-drew", 3, [{ targetParticipantId: drew.id, prompt: 'Two additions to your task "Новые чаты в General": the phone too.' }]),
    request("g-2", 4, [{ targetParticipantId: gera.id, prompt: "Create your own independent proposal for the title." }]),
    request("k-1", 5, [{ targetParticipantId: kept.id, prompt: "Something else entirely." }])
  ];
  const { service, storage } = testService({ conversation });

  await service.backfillSessionsTaskTitles(storage.current);
  const titles = Object.fromEntries(participantsOf(storage.current).map((participant) => [participant.handle, participant.taskTitle]));
  assert.deepEqual(titles, { main: undefined, drew: "Новые чаты в General", gera: "Check the release feed", sam: undefined, kept: "Already named" },
    "drew by its delegation, gera by its first task's line, sam (no task) keeps none and is shown as Agent, kept untouched");
  assert.equal(storage.current.metadata.sessionsTaskTitlesBackfilled, true, "done once");

  // Once done, it does nothing again, even for a member that lost its title.
  storage.current.metadata.participants = participantsOf(storage.current).map((participant) =>
    participant.id === gera.id ? { ...participant, taskTitle: undefined } : participant);
  await service.backfillSessionsTaskTitles(storage.current);
  assert.equal(participantsOf(storage.current).find((participant) => participant.id === gera.id)?.taskTitle, undefined);
});

test("the turn that asked writing later is not going on (its posts carry its turn); another turn of the requester is", async () => {
  const sameTurn = quitRequestChat("interrupted");
  // A post it sent with app_chat_send_message: its turn and run, no sourceMessageId.
  sameTurn.messages.push({ id: "post", role: "participant", participantId: "main-id", participantLabel: "@main", content: "Still waiting.", createdAt: new Date().toISOString(), status: "done",
    metadata: { runId: "run-1", turnSegmentId: "turn-1" } } as ChatMessage);
  let service = testService({ conversation: sameTurn });
  await chatParts(service.service).store.requireChat("conversation-1");
  await waitFor(() => Boolean(requestBatch(service.storage.current).autoResumeMessageId));
  assert.equal(resumesOf(service.runs, "main-id").length, 1);

  const otherTurn = quitRequestChat("interrupted");
  otherTurn.messages.push({ id: "other", role: "participant", participantId: "main-id", participantLabel: "@main", content: "Something else.", createdAt: new Date().toISOString(), status: "done",
    metadata: { runId: "run-2", turnSegmentId: "turn-2", sourceMessageId: "user-message" } } as ChatMessage);
  service = testService({ conversation: otherTurn });
  await chatParts(service.service).store.requireChat("conversation-1");
  await waitFor(() => service.debugEvents.some((event) => event.payload.reason === "moved-on"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(service.runs, "main-id").length, 0);

  // Stored before requests kept their turn: its turn is the one of its
  // reply to the message the request answered.
  const stored = quitRequestChat("interrupted", { batch: { requesterTurnSegmentId: undefined } });
  stored.messages.push({ id: "post", role: "participant", participantId: "main-id", participantLabel: "@main", content: "Still waiting.", createdAt: new Date().toISOString(), status: "done",
    metadata: { runId: "run-1", turnSegmentId: "turn-1" } } as ChatMessage);
  service = testService({ conversation: stored });
  await chatParts(service.service).store.requireChat("conversation-1");
  await waitFor(() => Boolean(requestBatch(service.storage.current).autoResumeMessageId));
  assert.equal(resumesOf(service.runs, "main-id").length, 1);
  // With neither, any later message of the requester is going on.
  const older = quitRequestChat("interrupted", { batch: { requesterTurnSegmentId: undefined, triggerMessageId: undefined } });
  older.messages.push({ id: "post", role: "participant", participantId: "main-id", participantLabel: "@main", content: "Still waiting.", createdAt: new Date().toISOString(), status: "done",
    metadata: { runId: "run-1", turnSegmentId: "turn-1" } } as ChatMessage);
  service = testService({ conversation: older });
  await chatParts(service.service).store.requireChat("conversation-1");
  await waitFor(() => service.debugEvents.some((event) => event.payload.reason === "moved-on"));
  assert.equal(resumesOf(service.runs, "main-id").length, 0);
});

test("only requests a requester waits on are weighed: not an inline one, not an inferred one", async () => {
  for (const options of [{ resumeRequester: false }, { source: "inferred" as const }]) {
    const { service, runs } = testService({ conversation: quitRequestChat("answered", options) });
    await chatParts(service).store.requireChat("conversation-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(leftAlone(service), JSON.stringify(options));
    assert.equal(resumesOf(runs, "main-id").length, 0, JSON.stringify(options));
  }
});
