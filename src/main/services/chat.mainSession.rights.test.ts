import assert from "node:assert/strict";
import test from "node:test";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { mainSessionHandleForMember, participantForRun } from "./chat/members/identity";
import { appToolCapabilitiesForRun, handleWritingLines } from "./chat/turns/promptSections";
import { accordLaunchCardForMessage } from "../../shared/accordLaunchCard";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { applyChatAccessOptionById, selectedChatAccessOption } from "../../shared/chatAccessModes";
import { buildGeminiExecInvocation } from "./geminiExec";
import { wireArtifactToolHandler } from "../appToolWiring";
import { APP_ARTIFACT_CREATE_TOOL } from "../../shared/appMcpToolContracts";
import type { ChatAgentPermissions, ChatMessage, ChatParticipant, ChatProviderKind, Conversation } from "../../shared/types";
import {
  accordSkills, childActor, clone, delegatedManager, delegationBatches, GENERIC_ROLE, MAIN_ROLE, mainActor, mainSession, mainSessionChat,
  member, NOW, participantsOf, permissions, sessionRecord, testService, waitFor
} from "./chat/test/mainSessionFixtures";

// --- capabilities --------------------------------------------------------------

test("delegate and start-Accord tools reach only the chat's own main session, whatever another member's role says", () => {
  const main = mainSession();
  const impostor = { ...member("impostor-id", "impostor"), roleConfigId: MAIN_ROLE.id, kind: "claude-code" as const };
  const conversation = mainSessionChat([main, impostor]);
  const { service } = testService({ conversation });
  const internals = service as any;
  const forMain = appToolCapabilitiesForRun(conversation, main, sessionRecord(main, "s"), normalizeChatAgentPermissions(main.permissions));
  const forImpostor = appToolCapabilitiesForRun(conversation, impostor, sessionRecord(impostor, "s"), normalizeChatAgentPermissions(impostor.permissions));
  assert.ok(forMain.includes("participants.delegate"));
  assert.ok(forMain.includes("accord.start"));
  assert.equal(forImpostor.includes("participants.delegate"), false);
  assert.equal(forImpostor.includes("accord.start"), false);
  // A chat without a main session gives them to nobody.
  const plain = { ...conversation, metadata: { participants: [main, impostor] } } as Conversation;
  assert.equal(appToolCapabilitiesForRun(plain, main, sessionRecord(main, "s"), normalizeChatAgentPermissions(main.permissions)).includes("participants.delegate"), false);
});

// --- delegation ----------------------------------------------------------------

test("the main session adds a member without a card, within its own rights, and its task runs at once", async () => {
  const main = mainSession();
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
  const { service, storage, runs, debugEvents } = testService({ conversation });

  const result = await service.delegateTaskFromTool(mainActor(), {
    title: "  Review   app.ts ",
    task: "Review src/app.ts and report the bugs you find.",
    // Asks for more than the main session has: web access and Auto.
    agentMode: "auto",
    permissions: { repoRead: true, workspaceWrite: true, webAccess: true, shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "rm" }, { action: "allow", match: "prefix", pattern: "git diff" }] } }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "running");
  assert.equal(result.start, "clean");
  assert.equal(result.forked, false);
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.ok(child, "the member is in the chat");
  assert.equal(result.handle, `@${child.handle}`);
  assert.equal(child.handle, "claude", "the generic role is named after its CLI");
  assert.equal(child.kind, "claude-code", "the main session's provider");
  assert.equal(child.model, "opus", "and its model");
  assert.equal(child.roleConfigId, GENERIC_ROLE.id);
  assert.equal(child.taskTitle, "Review app.ts", "the member keeps the title it is named by, whatever a device has loaded");
  assert.equal(child.delegatedByParticipantId, main.id);
  assert.equal(child.agentMode, "default", "never above the main session's mode");
  const granted = normalizeChatAgentPermissions(child.permissions);
  assert.equal(granted.cliApprovals, true, "in its CLI's own mode (Accept edits), never Custom in the sessions view");
  assert.equal(granted.webAccess, false, "nothing the main session lacks");
  assert.equal(granted.workspaceWrite, true);
  assert.deepEqual(granted.shell.rules, [
    { action: "allow", match: "prefix", pattern: "git diff" },
    { action: "deny", match: "prefix", pattern: "git push" }
  ]);
  assert.equal(granted.requestParticipants, "allow", "it may ask the main session without a card");
  assert.equal(granted.manageRolesParticipants, "deny");

  // No card: the addition is recorded as auto-applied, and the chat says who added it.
  const approvals = (storage.current.metadata.pendingAppToolApprovals ?? []) as Array<{ status: string; appliedParticipantIds?: string[] }>;
  assert.deepEqual(approvals.map((approval) => approval.status), ["auto-applied"]);
  assert.deepEqual(approvals[0].appliedParticipantIds, [child.id]);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.role === "system" && message.content === `Auto-applied member request from @main: Add @${child.handle}.`));

  // The task is a running request from the main session to the member.
  const [batch] = delegationBatches(storage.current);
  assert.equal(batch.requesterParticipantId, main.id);
  assert.equal(batch.resumeRequester, true);
  assert.deepEqual(batch.delegation, { start: "clean" }, "given outside a turn running here: resumed on its own");
  assert.equal(batch.items[0].targetParticipantId, child.id);
  assert.equal(batch.items[0].prompt, "Review src/app.ts and report the bugs you find.");
  assert.equal(batch.items[0].title, "Review app.ts", "the task's short title, kept on its item");
  assert.equal(result.requestId, batch.id);

  // The member runs its task, then the main session gets its answer in a fresh turn.
  await waitFor(() => runs.some((run) => run.participant.id === child.id));
  await waitFor(() => runs.some((run) => run.participant.id === main.id && run.prompt.includes("Auto-resumed @main")));
  const childRun = runs.find((run) => run.participant.id === child.id)!;
  assert.equal(childRun.options.forkFromSessionId, undefined, "a clean member starts its own session");
  assert.equal(childRun.options.sessionId || undefined, undefined);
  assert.match(childRun.prompt, /Review src\/app\.ts/);
  await waitFor(() => delegationBatches(storage.current)[0]?.autoResumeMessageId !== undefined);
  assert.deepEqual(debugEvents.filter((item) => item.event.endsWith(".error")), []);
});

test("a member the main session gives no permissions inherits its rights, and member management stays off", async () => {
  const main = mainSession("claude-code", { agentMode: "plan" });
  const { service, storage } = testService({ conversation: mainSessionChat([main], { participantSessions: [sessionRecord(main, "s")] }) });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Plan it." });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(child.agentMode, "plan");
  const granted = normalizeChatAgentPermissions(child.permissions);
  assert.equal(granted.workspaceWrite, false, "plan mode has no edits, so the child has none");
  assert.equal(granted.shell.enabled, false);
  assert.equal(granted.manageRolesParticipants, "deny");
});

test("delegation refuses the main session, Chat Assistant and Workflow Manager roles", async () => {
  const main = mainSession();
  const { service } = testService({ conversation: mainSessionChat([main]) });
  for (const roleConfigId of ["main-session", "administrator", "workflow-manager"]) {
    const result = await service.delegateTaskFromTool(mainActor(), { task: "T", roleConfigId });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_role");
  }
});

// "No Custom in the sessions view" (the User, 2026-11-22): every member added
// to a chat with a main session runs in its CLI's own mode, whoever added it.
test("every member added to a chat with a main session runs in its CLI's own mode: on her approval card, by a member without a card, or by her from the roster", async () => {
  const main = mainSession();
  const { service, storage } = testService({ conversation: mainSessionChat([main]) });
  chatDependencies(service).cliRunner.detectAgents = async () => [
    { kind: "codex-cli", label: "Codex CLI", installed: true },
    { kind: "claude-code", label: "Claude Code", installed: true }
  ];
  const accessOf = (handle: string) => {
    const added = participantsOf(storage.current).find((participant) => participant.handle === handle)!;
    assert.equal(normalizeChatAgentPermissions(added.permissions).cliApprovals, true, `@${handle} in its CLI's own mode`);
    return selectedChatAccessOption(added.kind, added.agentMode, added.permissions)?.id;
  };
  const actor = mainActor(["participants.manage"]);
  // On her card (a member broader than the main session).
  const asked = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "web", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", permissions: permissions({ webAccess: true }) } }]
  });
  assert.equal(asked.status, "pending_user_approval");
  const card = (storage.current.metadata.pendingAppToolApprovals as Array<{ id: string; status: string }>).find((approval) => approval.status === "pending")!;
  await service.respondToAppToolApproval({ conversationId: storage.current.id, approvalId: card.id, approve: true });
  await waitFor(() => participantsOf(storage.current).some((participant) => participant.handle === "web"));
  assert.equal(accessOf("web"), "read-only", "Codex without file edits: Read Only");
  // Without a card.
  const within = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "reader", roleConfigId: GENERIC_ROLE.id, kind: "claude-code", permissions: permissions() } }]
  });
  assert.equal(within.status, "auto_applied");
  assert.equal(accessOf("reader"), "manual");
  // By her, from the roster.
  await service.addParticipant({
    conversationId: storage.current.id,
    participant: { handle: "editor", roleConfigId: GENERIC_ROLE.id, kind: "claude-code", agentMode: "default", permissions: permissions({ workspaceWrite: true }) } as any
  });
  assert.equal(accessOf("editor"), "acceptEdits");
  const editor = participantsOf(storage.current).find((participant) => participant.handle === "editor")!;
  assert.equal(editor.delegatedByParticipantId, undefined, "hers: not held to the main session's rights");
});

test("a member added to a chat without a main session keeps the rights it was given", async () => {
  const conversation = { ...mainSessionChat([member("worker-id", "worker")]), metadata: { participants: [member("worker-id", "worker")] } } as Conversation;
  const { service, storage } = testService({ conversation });
  chatDependencies(service).cliRunner.detectAgents = async () => [{ kind: "codex-cli", label: "Codex CLI", installed: true }];
  await service.addParticipant({
    conversationId: conversation.id,
    participant: { handle: "classic", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", agentMode: "default", permissions: permissions({ workspaceWrite: true }) } as any
  });
  const added = participantsOf(storage.current).find((participant) => participant.handle === "classic")!;
  assert.equal(normalizeChatAgentPermissions(added.permissions).cliApprovals, undefined);
});

test("a chat in the sessions view opened on the computer moves its classic-rights members into their CLI's own mode once, and is marked so a later change is not undone", async () => {
  const main = mainSession("claude-code", { permissions: { ...normalizeChatAgentPermissions(mainSession().permissions), cliApprovals: true } });
  const classic = member("worker-id", "worker", { kind: "claude-code", permissions: permissions({ workspaceWrite: true }) });
  const { service, storage } = testService({ conversation: mainSessionChat([main, classic], { chatView: "sessions" }) });
  await service.hydrateContextUsage(clone(storage.current));
  await waitFor(() => typeof storage.current.metadata.cliModesConvertedAt === "string");
  const worker = participantsOf(storage.current).find((participant) => participant.id === "worker-id")!;
  assert.equal(normalizeChatAgentPermissions(worker.permissions).cliApprovals, true);
  assert.equal(selectedChatAccessOption(worker.kind, worker.agentMode, worker.permissions)?.id, "acceptEdits", "the mode it ran in");
  // Something sets classic rights on it later: opening the chat again leaves it.
  storage.current.metadata.participants = participantsOf(storage.current).map((participant) =>
    participant.id === "worker-id" ? { ...participant, permissions: permissions({ workspaceWrite: true }) } : participant);
  const marked = storage.current.metadata.cliModesConvertedAt;
  await service.hydrateContextUsage(clone(storage.current));
  const fresh = testService({ conversation: clone(storage.current) });
  await fresh.service.hydrateContextUsage(clone(fresh.storage.current));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(normalizeChatAgentPermissions(participantsOf(fresh.storage.current).find((participant) => participant.id === "worker-id")!.permissions).cliApprovals, undefined,
    "marked: not converted again, also after a restart");
  assert.equal(fresh.storage.current.metadata.cliModesConvertedAt, marked);
  assert.equal(fresh.storage.current.metadata.cliModesConvertedHereAt, marked, "and recorded on this computer");

  // A server on an older program drops the shared mark (a full read from it
  // deletes it here): the computer's own record keeps it from converting again.
  const dropped = clone(fresh.storage.current);
  delete (dropped.metadata as Record<string, unknown>).cliModesConvertedAt;
  const afterOldServer = testService({ conversation: dropped });
  await afterOldServer.service.hydrateContextUsage(clone(afterOldServer.storage.current));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(normalizeChatAgentPermissions(participantsOf(afterOldServer.storage.current).find((participant) => participant.id === "worker-id")!.permissions).cliApprovals, undefined,
    "not converted again after an older server dropped the mark");
});

test("a chat shown in the classic view, and any chat on a machine, is not converted when opened", async () => {
  const main = mainSession();
  const classic = member("worker-id", "worker", { kind: "claude-code" });
  const inClassic = testService({ conversation: mainSessionChat([main, classic], { chatView: "classic" }) });
  await inClassic.service.hydrateContextUsage(clone(inClassic.storage.current));
  const onMachine = testService({ conversation: mainSessionChat([main, classic], { chatView: "sessions" }) });
  onMachine.service.setHostMachineId("box");
  await onMachine.service.hydrateContextUsage(clone(onMachine.storage.current));
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const { storage } of [inClassic, onMachine]) {
    assert.equal(storage.current.metadata.cliModesConvertedAt, undefined);
    assert.equal(normalizeChatAgentPermissions(participantsOf(storage.current)[1].permissions).cliApprovals, undefined);
  }
});

// --- what other members are told -----------------------------------------------

test("members of a main-session chat ask the main session, not User, and do not start Accords", () => {
  const main = mainSession();
  const worker = member("worker-id", "worker");
  const conversation = mainSessionChat([main, worker]);
  const { service } = testService({ conversation });
  const internals = service as any;
  assert.equal(mainSessionHandleForMember(conversation, worker), "main");
  assert.equal(mainSessionHandleForMember(conversation, main), undefined);

  const access = { agentMode: "default", permissions: defaultChatAgentPermissions() };
  const workerInstructions = chatParts(internals).memberSessions.sessionInstructions(conversation, worker, sessionRecord(worker, "s", GENERIC_ROLE), access, "/tmp/accordagents-history") as string;
  assert.match(workerInstructions, /ask @main with `app_chat_request_participants` instead of asking User/);
  assert.match(workerInstructions, /Do not write a `User choice:` block unless @main asked you to put a question to User\./);
  assert.match(workerInstructions, /Do not start an Accord; when one is needed, ask @main\./);
  assert.match(workerInstructions, /"target": "main"/);
  assert.doesNotMatch(workerInstructions, /Ask User directly/);

  const mainInstructions = chatParts(internals).memberSessions.sessionInstructions(conversation, main, sessionRecord(main, "s"), access, "/tmp/accordagents-history") as string;
  assert.match(mainInstructions, /Ask User directly when goals/);
  assert.match(mainInstructions, /- When User must pick one option/);
  assert.doesNotMatch(mainInstructions, /ask @main/);
});

// --- Accord --------------------------------------------------------------------

test("the main session's Accord is launched as its own message and read as an Accord card", async () => {
  const main = mainSession();
  const worker = member("worker-id", "worker");
  const { service, storage, runs } = testService({ conversation: mainSessionChat([main, worker]), userSkills: accordSkills() });

  const result = await service.startAccordFromTool(mainActor(), { targets: ["@worker"], subject: "Pick the database." });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.facilitator, "@main", "the main session leads it by default");
  const launch = storage.current.messages.find((message: ChatMessage) => message.id === result.launchMessageId)!;
  assert.equal(launch.role, "participant", "written as the main session's, not as if User wrote it");
  assert.equal(launch.participantId, main.id);
  assert.equal(launch.metadata?.accordLaunchByMainSession, true);
  assert.deepEqual(accordLaunchCardForMessage(launch), { facilitator: "main", members: ["worker"], subject: "Pick the database." });
  // Another member's message of the same text is not a launch.
  assert.equal(accordLaunchCardForMessage({ role: launch.role, content: launch.content, metadata: {} }), undefined);
  await waitFor(() => runs.some((run) => run.participant.id === main.id && run.prompt.includes("/accord")));
});

test("the facilitator the main session names gets leave to ask members no broader than the main session's", async () => {
  const main = mainSession("claude-code", { permissions: permissions({ requestParticipants: "ask" }) });
  const lead = member("lead-id", "lead", { permissions: permissions({ requestParticipants: "deny" }) });
  const worker = member("worker-id", "worker");
  const { service, storage } = testService({ conversation: mainSessionChat([main, lead, worker]), userSkills: accordSkills() });
  const result = await service.startAccordFromTool(mainActor(), { targets: ["worker"], subject: "Agree on the plan.", facilitator: "lead" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const leadAfter = participantsOf(storage.current).find((participant) => participant.id === lead.id)!;
  assert.equal(normalizeChatAgentPermissions(leadAfter.permissions).requestParticipants, "ask");
});

test("only the main session starts an Accord through the tool", async () => {
  const main = mainSession();
  const worker = member("worker-id", "worker");
  const { service, storage } = testService({ conversation: mainSessionChat([main, worker]), userSkills: accordSkills() });
  const result = await service.startAccordFromTool(mainActor(["accord.start"], { participantId: worker.id }), { targets: ["main"], subject: "X" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_main_session");
  assert.equal(storage.current.messages.length, 1);
});

test("the main session's Accord always has its card: a draft collection is filed under the launch it runs for, and one with no launch at all is refused", async () => {
  const main = mainSession();
  const worker = member("worker-id", "worker");
  const { service, storage } = testService({ conversation: mainSessionChat([main, worker]), userSkills: accordSkills() });
  const dispatched: Array<{ member: string; origin?: string }> = [];
  let handler: ((actor: unknown, toolName: string, request: unknown) => Promise<any>) | undefined;
  wireArtifactToolHandler({ setArtifactToolHandler: (next: typeof handler) => { handler = next; } } as never, service,
    async (member, _conversationId, _toolName, _request, context) => {
      dispatched.push({ member, ...(context?.originMessageId ? { origin: context.originMessageId } : {}) });
      return { ok: true, value: {} };
    });
  const collection = { initialState: "collecting_drafts", name: "Pick the database", operationId: "accord:x:create" };
  const create = async (actor: unknown) => {
    dispatched.length = 0;
    const result = await handler!(actor, APP_ARTIFACT_CREATE_TOOL, collection);
    return { result, origin: dispatched[0]?.origin, reached: dispatched.length > 0 };
  };

  // Run by itself in the turn of User's message (the accord skill straight
  // away), with no launch in the chat: refused before anything is made,
  // pointing at app_chat_start_accord.
  const adHoc = await create(mainActor());
  assert.equal(adHoc.result.ok, false);
  assert.equal(adHoc.result.error.code, "accord_not_launched");
  assert.match(adHoc.result.error.message, /app_chat_start_accord/);
  assert.equal(adHoc.reached, false, "nothing reached the documents");

  // A plain document, another member's collection, or a main session that
  // cannot start an Accord with the tool, is not held to it.
  assert.equal((await handler!(mainActor(), APP_ARTIFACT_CREATE_TOOL, { name: "Notes", content: "Text" })).ok, true);
  const workerOwn = await create(mainActor(["participants.request"], { participantId: worker.id }));
  assert.deepEqual([workerOwn.result.ok, workerOwn.origin], [true, undefined]);
  const noStartTool = await create(mainActor(["participants.request"]));
  assert.deepEqual([noStartTool.result.ok, noStartTool.origin], [true, undefined]);

  // Started with the tool, as User's button does: the main session leads it
  // and is told to end the turn.
  const started = await service.startAccordFromTool(mainActor(), { targets: ["worker"], subject: "Pick the database." });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.match(String(started.next), /end this turn/);
  const launchId = String(started.launchMessageId);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.id === launchId && accordLaunchCardForMessage(message)));
  // Its collection is filed under the launch: in the turn the launch starts,
  // in a later turn of the launch's thread, and in a turn whose trigger is
  // another message -- the one that called the tool, her message that joined
  // the running step, a "go on" after the launch's turn was stopped -- as long
  // as the launch is the chat's newest, open and without a document.
  for (const patch of [
    { triggerMessageId: launchId, triggerThreadId: launchId },
    { triggerMessageId: "auto-resume", triggerThreadId: launchId },
    {},
    { triggerMessageId: "user-joined", triggerThreadId: "user-joined" }
  ]) {
    const filed = await create(mainActor(undefined, patch));
    assert.deepEqual([filed.result.ok, filed.origin], [true, launchId], JSON.stringify(patch));
  }

  // Once a document is filed under it, a collection outside its turns is not
  // reached back for: with no other launch, it is refused again.
  await service.postArtifactChatNote(storage.current.id, "e1", "@main created draft collection [Pick](#artifact:a1) · Drafts 0/2", { originMessageId: launchId });
  assert.equal((await create(mainActor())).result.error?.code, "accord_not_launched");
  assert.equal((await create(mainActor(undefined, { triggerMessageId: launchId, triggerThreadId: launchId }))).origin, launchId,
    "its own turns still file under it");

  // A newer launch another member leads hides it; a folded one is not open.
  const named = await service.startAccordFromTool(mainActor(), { targets: ["main"], subject: "Other.", facilitator: "worker" });
  assert.equal(named.ok, true, JSON.stringify(named));
  assert.equal(named.next, undefined, "a facilitator it names is told nothing of the kind");
  assert.equal((await create(mainActor())).result.error?.code, "accord_not_launched", "the newest launch is the worker's");
  const workerLeads = await create(mainActor(["participants.request"], { participantId: worker.id }));
  assert.equal(workerLeads.origin, String(named.launchMessageId), "the worker's collection files under the launch it leads");
  await service.closeAccordCard({ conversationId: storage.current.id, launchMessageId: String(named.launchMessageId) });
  assert.equal((await create(mainActor(["participants.request"], { participantId: worker.id }))).origin, undefined, "a folded launch is not open");

  // A turn whose trigger cannot be read files the collection under nothing,
  // as before, rather than refusing it for a reason that is not the member's.
  const lookup = storage.conversationMessageById;
  storage.conversationMessageById = async () => { throw new Error("sqlite busy"); };
  const unread = await create(mainActor(undefined, { triggerMessageId: "paged-out", triggerThreadId: "paged-out" }));
  storage.conversationMessageById = lookup;
  assert.deepEqual([unread.result.ok, unread.origin], [true, undefined]);
});

test("in a main-session chat shown the classic way another member's '@x /accord' reply starts nothing; the main session's still does", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker", { permissions: permissions({ requestParticipants: "allow" }) });
  const other = member("other-id", "other");
  const conversation = mainSessionChat([main, worker, other], { chatView: "classic" });
  const { service } = testService({ conversation });
  chatParts(service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;

  const fromWorker: ChatMessage = {
    id: "worker-reply", role: "participant", participantId: worker.id, participantLabel: "@worker",
    content: "@other /accord on the rollout plan.", createdAt: NOW, status: "done", metadata: { threadId: "user-message", runId: "worker-run" }
  };
  conversation.messages.push(fromWorker);
  await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, worker, [fromWorker]);
  assert.equal(conversation.messages.some((message) => message.metadata?.participantRequest), false, "no request, no Accord");
  assert.equal(normalizeChatAgentPermissions(participantsOf(conversation).find((item) => item.id === other.id)!.permissions).requestParticipants, "ask");
  assert.ok((conversation.metadata.warnings as string[]).some((warning) => warning.includes("only this chat's own session starts one")));

  const fromMain: ChatMessage = {
    id: "main-reply", role: "participant", participantId: main.id, participantLabel: "@main",
    content: "@other /accord on the rollout plan.", createdAt: NOW, status: "done", metadata: { threadId: "user-message", runId: "main-run" }
  };
  conversation.messages.push(fromMain);
  await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, main, [fromMain]);
  assert.ok(conversation.messages.some((message) => message.metadata?.participantRequest?.requesterParticipantId === main.id));
  assert.equal(normalizeChatAgentPermissions(participantsOf(conversation).find((item) => item.id === other.id)!.permissions).requestParticipants, "allow");
});

test("in the sessions view an @handle in a member's reply or post starts nobody; the classic view still asks (the User, 2026-11-22)", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker", { permissions: permissions({ requestParticipants: "allow" }) });
  const other = member("other-id", "other");
  const reply = (id: string, from: ChatParticipant, content: string, extra: Record<string, unknown> = {}): ChatMessage => ({
    id, role: "participant", participantId: from.id, participantLabel: `@${from.handle}`, content, createdAt: NOW, status: "done",
    metadata: { threadId: "user-message", runId: `${id}-run`, ...extra }
  });
  const requests = (conversation: Conversation) => conversation.messages.filter((message) => message.metadata?.participantRequest);

  for (const chatView of [undefined, "sessions"] as const) {
    const conversation = mainSessionChat([main, worker, other], chatView ? { chatView } : {});
    const { service } = testService({ conversation });
    chatParts(service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;
    const messages = [
      reply("main-reply", main, "@worker please check the logs."),
      reply("worker-reply", worker, "Done. @other can you confirm the numbers?"),
      reply("worker-post", worker, "@main the build is green.", { appMessageSource: "app_chat_send_message" }),
      reply("main-accord", main, "@other /accord on the rollout plan."),
      reply("worker-accord", worker, "@other /accord on the rollout plan.")
    ];
    for (const message of messages) {
      conversation.messages.push(message);
      const from = message.participantId === main.id ? main : worker;
      const started = await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, from, [message]);
      assert.deepEqual(started, [], `${chatView ?? "default view"}: ${message.id} starts nobody`);
    }
    assert.equal(requests(conversation).length, 0, "no task row, no turn");
    assert.deepEqual(conversation.metadata.warnings ?? [], [], "no warning either, the Accord one included");
    assert.equal(normalizeChatAgentPermissions(participantsOf(conversation).find((item) => item.id === other.id)!.permissions).requestParticipants, "ask",
      "no Accord leave either");
    assert.match(handleWritingLines(conversation).join("\n"), /starts nobody/);
  }

  const classic = mainSessionChat([main, worker, other], { chatView: "classic" });
  const { service } = testService({ conversation: classic });
  chatParts(service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;
  const fromMain = reply("main-reply", main, "@worker please check the logs.");
  classic.messages.push(fromMain);
  await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(classic, main, [fromMain]);
  assert.equal(requests(classic).length, 1, "the classic view still reads it as a request");
  assert.equal(requests(classic)[0]!.metadata?.participantRequest?.source, "inferred");
  assert.match(handleWritingLines(classic).join("\n"), /is a request for that participant to run/);
});

test("the main session's inferred '@x /accord' gives its facilitator no more leave than its own (the classic view)", async () => {
  const main = mainSession("codex-cli", { model: undefined, permissions: permissions({ requestParticipants: "ask" }) });
  const other = member("other-id", "other", { permissions: permissions({ requestParticipants: "deny" }) });
  const conversation = mainSessionChat([main, other], { chatView: "classic" });
  const { service } = testService({ conversation });
  chatParts(service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;
  const fromMain: ChatMessage = {
    id: "main-reply", role: "participant", participantId: main.id, participantLabel: "@main",
    content: "@other /accord on the rollout plan.", createdAt: NOW, status: "done", metadata: { threadId: "user-message", runId: "main-run" }
  };
  conversation.messages.push(fromMain);
  await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, main, [fromMain]);
  assert.equal(normalizeChatAgentPermissions(participantsOf(conversation).find((item) => item.id === other.id)!.permissions).requestParticipants, "ask");
});

test("in a main-session chat a member's additions are held to its own rights and the main session's, or go to a card", async () => {
  const main = mainSession();
  const child = delegatedManager();
  const { service, storage } = testService({ conversation: mainSessionChat([main, child]) });
  const add = (handle: string, patch: Partial<ChatAgentPermissions>, agentMode: ChatParticipant["agentMode"] = "default") =>
    service.requestParticipantChangeFromTool(childActor(), {
      operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle, roleConfigId: GENERIC_ROLE.id, kind: "claude-code", agentMode, permissions: permissions(patch) } }]
    });
  // As broad as the main session (edits) but broader than the child: a card.
  assert.equal((await add("writer", { workspaceWrite: true })).status, "pending_user_approval");
  // Broader than both (web): a card.
  assert.equal((await add("web", { webAccess: true })).status, "pending_user_approval");
  assert.equal((await add("auto", {}, "auto")).status, "pending_user_approval");
  // Within both: no card, and it says who added it.
  const within = await add("reader", {});
  assert.equal(within.status, "auto_applied", JSON.stringify(within));
  const reader = participantsOf(storage.current).find((participant) => participant.handle === "reader")!;
  assert.equal(reader.delegatedByParticipantId, child.id);
  // The main session's own additions without a card say so too; ones the User adds say nothing.
  const fromMain = await service.requestParticipantChangeFromTool(mainActor(["participants.manage"]), {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "helper", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", permissions: permissions() } }]
  });
  assert.equal(fromMain.status, "auto_applied");
  assert.equal(participantsOf(storage.current).find((participant) => participant.handle === "helper")!.delegatedByParticipantId, main.id);
});

test("an Antigravity member in agy's own Accept edits or Auto, under a main session set from the classic controls, never runs with every confirmation skipped", () => {
  // The main session from the classic controls: edits on, no CLI mode.
  const main = mainSession("claude-code", { permissions: permissions({ workspaceWrite: true, requestParticipants: "allow" }) });
  const { service } = testService({ conversation: mainSessionChat([main]) });
  for (const id of ["accept-edits", "auto"]) {
    const own = applyChatAccessOptionById("gemini-cli", id, permissions({ workspaceWrite: true }));
    const agy = member(`agy-${id}`, `agy${id.length}`, { kind: "gemini-cli", delegatedByParticipantId: main.id, agentMode: own.agentMode, permissions: own.permissions });
    const chat = mainSessionChat([main, agy]);
    const run = participantForRun(chat, agy) as ChatParticipant;
    const invocation = buildGeminiExecInvocation({
      participant: { ...agy, label: agy.handle } as never, prompt: "Go.", repoPath: "/work/app", kind: "chat",
      options: { agentMode: run.agentMode, permissions: run.permissions }
    } as never);
    assert.ok(!invocation.args.includes("--dangerously-skip-permissions"), `${id}: ${invocation.args.join(" ")}`);
    assert.ok(invocation.args.includes("--sandbox"), `${id}: the most restrictive run`);
    // Its own settings are kept for when the main session has the mode again.
    assert.equal(normalizeChatAgentPermissions(agy.permissions).cliApprovals, true);
  }
});

test("scheduled tasks without a card: a member the main session makes has it only as long as the main session does, and no member gives it", async () => {
  const main = { ...mainSession(), permissions: { ...mainSession().permissions!, scheduleWithoutAsking: true as const } };
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "s")] });
  const { service, storage } = testService({ conversation });
  chatParts(service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;
  const delegated = await service.delegateTaskFromTool(mainActor(), { task: "Watch the build every minute." });
  const stored = (): ChatParticipant[] => storage.current.metadata.participants as ChatParticipant[];
  const child = () => stored().find((participant) => participant.id === delegated.participantId)!;
  chatDependencies(service).settings.getPublicSettings = ((read) => async () => ({ ...await read(), newChatDefaults: { compactWithoutAsking: true, scheduleWithoutAsking: true } }))(
    chatDependencies(service).settings.getPublicSettings.bind(chatDependencies(service).settings));
  const creates = () => chatParts(service).scheduledTasks.createsScheduledTasksWithoutCard(storage.current, child()) as Promise<boolean>;
  assert.equal(await creates(), true, "as it has the main session's other rights");
  storage.current.metadata.participants = stored().map((participant) => participant.id === main.id
    ? { ...participant, permissions: { ...participant.permissions!, scheduleWithoutAsking: undefined } } : participant);
  assert.equal(await creates(), false, "gone with the main session's");

  const plain = mainSession();
  const without = testService({ conversation: mainSessionChat([plain], { participantSessions: [sessionRecord(plain, "s")] }) });
  chatParts(without.service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;
  const raised = await without.service.delegateTaskFromTool(mainActor(), { task: "Watch it.", permissions: { scheduleWithoutAsking: true } });
  const raisedChild = (without.storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.id === raised.participantId)!;
  assert.equal(raisedChild.permissions?.scheduleWithoutAsking, undefined);
});
