import assert from "node:assert/strict";
import test from "node:test";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL, APP_TOOL_PERMISSION_TOOL } from "./appMcp";
import { ChatService } from "./chat";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import type { HubOp } from "../../shared/hubOps";
import {
  defaultChatAgentPermissions, effectiveChatAgentPermissionsForProvider, normalizeChatAgentPermissions
} from "../../shared/agentPermissions";
import { selectedChatAccessOption } from "../../shared/chatAccessModes";
import type {
  ChatAgentPermissions, ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatMessage, ChatParticipant, Conversation,
  ParticipantConfig
} from "../../shared/types";
import {
  chatConversation, chatParticipant, fakeServerLink, flushMicrotasks, fromServer, memberDeviceAnswers, NOW, pendingToolPermission,
  permissionApproval, ROLE, testService, toolPermissionActor, waitFor
} from "./chat/test/permissionFixtures";

test("Claude Auto tool permission approvals are per occurrence and never reuse chat policy", async () => {
  const participant = { ...chatParticipant("claude-code"), agentMode: "auto" as const };
  const staleDefaultPolicy: ChatAppToolApprovalPolicy = {
    id: "default-policy",
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    toolName: APP_TOOL_PERMISSION_TOOL,
    capability: "permissions.request",
    targetToolName: "Write",
    scope: "chat",
    createdAt: NOW,
    updatedAt: NOW
  };
  const conversation = chatConversation([participant], {
    appToolApprovalPolicies: [staleDefaultPolicy],
    participantSessions: [{ participantId: participant.id, participantAgentMode: "default" }]
  });
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    agentMode: "auto" as const,
    runId: "run-auto-1",
    triggerMessageId: "user-message"
  };

  const first = service.requestToolPermissionFromTool(actor, {
    tool_name: "Write",
    input: { file_path: "/repo/first.txt", content: "first" }
  });
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).some(
      (approval) => approval.status === "pending"
    )
  );
  const firstApproval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (approval) => approval.status === "pending"
  )!;
  assert.equal((firstApproval.request as { agentMode?: string }).agentMode, "auto");
  delete (firstApproval.request as { agentMode?: string }).agentMode;
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: firstApproval.id,
    approve: true,
    scope: "chat"
  });
  assert.deepEqual(await first, {
    behavior: "allow",
    updatedInput: { file_path: "/repo/first.txt", content: "first" }
  });
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .find((approval) => approval.id === firstApproval.id)?.approvalScope,
    "once"
  );
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies, [staleDefaultPolicy]);

  const second = service.requestToolPermissionFromTool({ ...actor, runId: "run-auto-2" }, {
    tool_name: "Write",
    input: { file_path: "/repo/second.txt", content: "second" }
  });
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
      (approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL
    ).length === 2
  );
  const secondApproval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (approval) => approval.id !== firstApproval.id && approval.status === "pending"
  )!;
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: secondApproval.id,
    approve: false
  });
  assert.deepEqual(await second, {
    behavior: "deny",
    message: "User denied this tool request."
  });
});

test("auto mode treats in-preset permission requests as already granted", async () => {
  // The Auto-review launch profile already grants repo read / workspace write / web,
  // so an in-preset request must report already_granted instead of producing a
  // spurious auto-applied approval and an unnecessary session relaunch (C6).
  const runs: ParticipantConfig[] = [];
  const participant = chatParticipant("claude-code", { webAccess: false });
  participant.agentMode = "auto";
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return {
        participant: runParticipant,
        ok: true,
        content: "ok",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "auto-run",
    triggerMessageId: "user-message"
  }, {
    kind: "portable",
    permissions: ["webAccess"],
    reason: "Need live lookup."
  });

  assert.equal(result.status, "already_granted");
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
  assert.equal(runs.length, 0);
  assert.equal(storage.current.messages.some((message: Conversation["messages"][number]) =>
    message.content.includes("Permission approval needed")
  ), false);
});

test("switching an existing session to auto adopts the mode on the next resumed turn", async () => {
  const runs: Array<{ options: any }> = [];
  const participant = chatParticipant("codex-cli");
  assert.equal(participant.agentMode, "default");
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ options });
      return {
        participant: runParticipant,
        ok: true,
        content: "ok",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, runId: "run-default", content: "@codex hello" });
  await waitFor(() => runs.length === 1);
  // First turn runs in default mode and seeds a provider session id.
  assert.equal(runs[0].options.agentMode, "default");
  assert.ok(!runs[0].options.sessionId);

  // Flip the persisted participant to Auto-review, then send another message.
  const persisted = storage.current.metadata.participants.find((item: ChatParticipant) => item.id === participant.id);
  persisted.agentMode = "auto";

  await service.sendMessage({ conversationId: conversation.id, runId: "run-auto", content: "@codex again" });
  await waitFor(() => runs.length === 2);
  // The new mode must be adopted (not frozen at the session's original mode)...
  assert.equal(runs[1].options.agentMode, "auto");
  // ...while still resuming the same provider session (no reset / no lost context).
  // The provider re-asserts the new profile on resume.
  assert.equal(runs[1].options.sessionId, "session-1");
  // The launched options resolve to the Auto-review preset through the shared helper.
  const effective = effectiveChatAgentPermissionsForProvider("codex-cli", runs[1].options.agentMode, runs[1].options.permissions);
  assert.equal(effective.workspaceWrite, true);
  assert.equal(effective.webAccess, true);
});

/** The member's live Claude Code process as ChatService's mode changes reach
 *  it (CliAgentRunner.memberClaudeControl). */
function liveClaudeProcess(service: ChatService) {
  const process = {
    live: true,
    refuse: undefined as string | undefined,
    /** The CLI switches to this mode instead of the one asked. */
    answer: undefined as string | undefined,
    mode: "default",
    sent: [] as Array<Record<string, unknown>>
  };
  chatDependencies(service).cliRunner.memberClaudeControl = async (_conversationId: string, _participantId: string, request: Record<string, unknown>) => {
    if (!process.live) return undefined;
    process.sent.push(request);
    if (process.refuse) throw new Error(process.refuse);
    process.mode = process.answer ?? String(request.mode);
    return { mode: process.mode };
  };
  chatDependencies(service).cliRunner.memberClaudePermissionMode = () => process.live ? process.mode : undefined;
  return process;
}

test("Claude Code's own modes: a mode change keeps the member's live process, is set in it at once, and a turn that read the member earlier goes in with the new mode", async () => {
  const runs: Array<{ options: any }> = [];
  const drew = { ...chatParticipant("claude-code", { repoRead: true }), permissions: { ...normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), repoRead: true }), cliApprovals: true as const } };
  const conversation = chatConversation([drew]);
  const { service, storage, tempRoot, debugEvents } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ options });
      return { participant: runParticipant, ok: true, content: "ok", durationMs: 1, sessionId: "session-drew" };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const process = liveClaudeProcess(service);
  const own = { ...drew.permissions };
  const turn = async (runId: string) => {
    await service.sendMessage({ conversationId: conversation.id, runId, content: "@drew go on" });
    await waitFor(() => runs.length === Number(runId.split("-")[1]));
    return runs.at(-1)!.options;
  };

  const manual = await turn("run-1");
  assert.equal(manual.warm.permissionMode(), "default");
  const steps: Array<[string, Record<string, unknown>, string]> = [
    ["Accept edits", { permissions: { ...own, workspaceWrite: true } }, "acceptEdits"],
    ["Plan", { agentMode: "plan" }, "plan"],
    ["Auto", { agentMode: "auto" }, "auto"],
    ["Manual", { agentMode: "default", permissions: own }, "default"]
  ];
  for (const [index, [name, patch, mode]] of steps.entries()) {
    await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, ...patch });
    await waitFor(() => process.sent.length === index + 1);
    assert.deepEqual(process.sent.at(-1), { subtype: "set_permission_mode", mode }, `${name}: set in the live process at once`);
    const next = await turn(`run-${runs.length + 1}`);
    assert.equal(next.warm.contextKey, manual.warm.contextKey, `${name}: the same live process`);
    assert.equal(next.warm.permissionMode(), mode, `${name}: its message goes in with that mode`);
  }
  assert.equal(debugEvents.filter((entry) => entry.event === "chat.member-mode.applied").length, steps.length);

  // A turn that read the member as Manual before she picked Accept edits
  // goes in with Accept edits; a change of something else sends nothing.
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, permissions: { ...own, workspaceWrite: true } });
  assert.equal(manual.warm.permissionMode(), "acceptEdits");
  const sent = process.sent.length;
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, model: "sonnet" });
  await flushMicrotasks();
  assert.equal(process.sent.length, sent, "not a mode change");

  // Its other rights are still the process's: a new one for web access.
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, model: "", permissions: { ...own, workspaceWrite: true, webAccess: true } });
  const web = await turn(`run-${runs.length + 1}`);
  assert.notEqual(web.warm.contextKey, manual.warm.contextKey);

  // No live process: nothing set (its next turn starts in the saved mode).
  process.live = false;
  const sentBefore = process.sent.length;
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "plan" });
  await flushMicrotasks();
  assert.equal(process.sent.length, sentBefore);
  assert.equal(storage.current.metadata.warnings?.length ?? 0, 0, "nothing to say");
  // Not switched: the chat says so in the CLI's words, and the member's mode
  // is the one its CLI still runs (its menu shows that).
  process.live = true;
  process.mode = "acceptEdits";
  process.refuse = "Claude Code refused set_permission_mode.";
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "auto" });
  const refusedLine = "Claude Code did not switch @drew to Auto: Claude Code refused set_permission_mode. @drew stays in Accept edits.";
  await waitFor(() => (storage.current.metadata.warnings ?? []).includes(refusedLine));
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.role === "system" && message.content === refusedLine), "a line every device has");
  await waitFor(() => {
    const member = (storage.current.metadata.participants as ChatParticipant[])[0];
    return member.agentMode === "default" && normalizeChatAgentPermissions(member.permissions).workspaceWrite === true;
  });
  // The CLI switched to another mode: said, and followed.
  process.refuse = undefined;
  process.answer = "plan";
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "default", permissions: own });
  await waitFor(() => (storage.current.metadata.warnings ?? []).includes("Claude Code switched @drew to Plan instead of Manual."));
  await waitFor(() => (storage.current.metadata.participants as ChatParticipant[])[0].agentMode === "plan");
  assert.ok(debugEvents.some((entry) => entry.event === "chat.member-mode.apply-failed"));
});

test("Claude Code's own modes: a lowered mode that its live process does not take is never written back up; a reply it is writing is stopped", async () => {
  let release: (() => void) | undefined;
  const drew = { ...chatParticipant("claude-code", { repoRead: true }), agentMode: "auto" as const,
    permissions: { ...normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), repoRead: true }), cliApprovals: true as const } };
  const conversation = chatConversation([drew]);
  const { service, storage, tempRoot, debugEvents } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, signal) => {
      // The reply runs until it is stopped (or released).
      await new Promise<void>((resolve) => {
        release = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { participant: runParticipant, ok: !signal?.aborted, content: signal?.aborted ? "" : "ok", durationMs: 1, sessionId: "session-drew", ...(signal?.aborted ? { error: "Stopped." } : {}) };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const process = liveClaudeProcess(service);
  process.mode = "auto";
  const own = { ...drew.permissions };
  await service.sendMessage({ conversationId: conversation.id, runId: "run-1", content: "@drew go on" });
  await waitFor(() => release !== undefined && storage.current.messages.some((message: ChatMessage) => message.participantId === drew.id && message.status === "pending"));

  // She lowers Auto to Manual; the switch times out and the process stays in Auto.
  process.refuse = "Claude Code did not answer within 15 seconds";
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "default", permissions: own });
  const line = "Claude Code did not switch @drew to Manual: Claude Code did not answer within 15 seconds. Its reply was stopped so it does not go on in Auto; its next message switches it to Manual first.";
  await waitFor(() => (storage.current.metadata.warnings ?? []).includes(line));
  await waitFor(() => !storage.current.messages.some((message: ChatMessage) => message.participantId === drew.id && message.status === "pending"));
  const member = (storage.current.metadata.participants as ChatParticipant[])[0];
  assert.equal(member.agentMode, "default", "her Manual stays the member's mode, never Auto again");
  assert.equal(normalizeChatAgentPermissions(member.permissions).workspaceWrite, false);
  await flushMicrotasks();
  assert.equal((storage.current.metadata.participants as ChatParticipant[])[0].agentMode, "default", "nothing writes it back later");
  assert.equal(debugEvents.filter((entry) => entry.event === "chat.member-mode.followed-cli").length, 0, "the CLI's wider mode is not followed");

  // The CLI answers with a wider mode than the one asked, while idle: kept
  // hers too, nothing to stop.
  process.refuse = undefined;
  process.mode = "default";
  process.answer = "acceptEdits";
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "plan", permissions: own });
  await waitFor(() => (storage.current.metadata.warnings ?? []).includes("Claude Code switched @drew to Accept edits instead of Plan. Its next message switches it to Plan first."));
  assert.equal((storage.current.metadata.participants as ChatParticipant[])[0].agentMode, "plan");
});

function fakeAppMcp() {
  const grants: any[] = [];
  return {
    grants,
    issueToken(grant: any) { grants.push(grant); return { url: "http://127.0.0.1:1/mcp", token: `token-${grants.length}` }; },
    updateToken(token: string, grant: any) { grants.push(grant); return { url: "http://127.0.0.1:1/mcp", token }; },
    clientStatus() { return undefined; }
  };
}

function ownModeClaude(patch: Partial<ChatAgentPermissions> = {}): ChatParticipant {
  return { ...chatParticipant("claude-code"), permissions: { ...normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), repoRead: true, ...patch }), cliApprovals: true as const } };
}

test("Claude Code's own modes: the app tool grant issued as the CLI takes a message goes by a mode she picked after the turn read the member", async () => {
  const drew = ownModeClaude();
  const conversation = chatConversation([drew]);
  const appMcp = fakeAppMcp();
  let service!: ChatService;
  let turns = 0;
  const built = testService({
    conversation,
    appMcp: appMcp as never,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      turns += 1;
      if (turns === 2) {
        // She picks Auto while the message waits for the CLI to take it.
        await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "auto" });
        options.warm.onReplyStarted?.();
      }
      return { participant: runParticipant, ok: true, content: "ok", durationMs: 1, sessionId: "session-drew" };
    }
  });
  service = built.service;
  chatParts(service).chatHistory.ensureHistoryFiles = async () => built.tempRoot;
  liveClaudeProcess(service);
  await service.sendMessage({ conversationId: conversation.id, runId: "run-1", content: "@drew one" });
  await waitFor(() => turns === 1 && appMcp.grants.length > 0);
  assert.equal(appMcp.grants.at(-1).agentMode, "default");
  await service.sendMessage({ conversationId: conversation.id, runId: "run-2", content: "@drew two" });
  const firstRun = appMcp.grants[0].runId;
  await waitFor(() => turns === 2 && appMcp.grants.at(-1)?.runId !== firstRun);
  assert.equal(appMcp.grants.some((grant) => grant.runId === firstRun && grant.agentMode === "auto"), true, "her pick reached the live grant at once");
  const grant = appMcp.grants.at(-1);
  assert.equal(grant.agentMode, "auto", "not the Manual the turn read");
  assert.equal(normalizeChatAgentPermissions(grant.runPermissions).workspaceWrite, true, "Auto's rights");
});

test("Claude Code's own modes: a once-only grant of file edits lets that run's next file edit through once, and is no mode of the shared live process", async () => {
  const drew = ownModeClaude();
  const approval = permissionApproval(drew, { kind: "portable", permissions: ["workspaceWrite"] }, { status: "approved", approvalScope: "once" });
  const conversation = chatConversation([drew], { pendingAppToolApprovals: [approval] });
  let process!: ReturnType<typeof liveClaudeProcess>;
  const runs: any[] = [];
  let finish: (() => void) | undefined;
  const appMcp = fakeAppMcp();
  const { service, storage, tempRoot } = testService({
    conversation,
    appMcp: appMcp as never,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push(options);
      process.mode = options.warm.permissionMode?.() ?? "default";
      await new Promise<void>((resolve) => { finish = resolve; });
      return { participant: runParticipant, ok: true, content: "ok", durationMs: 1, sessionId: "session-drew" };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  process = liveClaudeProcess(service);
  await service.sendMessage({ conversationId: conversation.id, runId: "run-once", content: "@drew edit it" });
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0].warm.permissionMode(), "default", "its live process stays in Manual: overlapping turns share it");
  assert.equal(normalizeChatAgentPermissions(runs[0].permissions).workspaceWrite, false, "the CLI is not started wider either");
  assert.ok(appMcp.grants.length > 0 && appMcp.grants.every((grant) => grant.runPermissions?.workspaceWrite !== true), "nor its app tools");
  // The member's run (its own id, as the app tool token names it).
  const granted = [...(chatParts(service).claudeModes.claudeOnceEditGrants as Map<string, string[]>).keys()];
  assert.equal(granted.length, 1, "this run holds the grant");
  const onceRun = granted[0]!;
  const actor = (runId: string) => ({
    conversationId: conversation.id, participantId: drew.id, roleConfigId: drew.roleConfigId, roleConfigVersion: 0,
    capabilities: ["permissions.request" as const], runId, triggerMessageId: "user-message", agentMode: "default"
  }) as never;
  const pendingCards = () => ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter((item) => item.status === "pending");
  // Another run of the member (a turn that overlaps) gets nothing of it.
  const other = service.requestToolPermissionFromTool(actor("run-other"), { tool_name: "Edit", input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }, tool_use_id: "t0" });
  await waitFor(() => pendingCards().length === 1);
  // This run's next file edit goes through, once.
  const first = await service.requestToolPermissionFromTool(actor(onceRun), { tool_name: "Write", input: { file_path: "/repo/b.ts", content: "x" }, tool_use_id: "t1" });
  assert.equal(first.behavior, "allow");
  // A command is not a file edit; the next edit asks again.
  const second = service.requestToolPermissionFromTool(actor(onceRun), { tool_name: "Edit", input: { file_path: "/repo/c.ts", old_string: "a", new_string: "b" }, tool_use_id: "t2" });
  await waitFor(() => pendingCards().length === 2);
  for (const card of pendingCards()) await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: false });
  assert.equal((await other).behavior, "deny");
  assert.equal((await second).behavior, "deny");
  finish?.();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.participantId === drew.id && message.status === "done"));
  assert.ok(!process.sent.some((request) => request.mode === "acceptEdits"), "never switched to Accept edits");
  const used = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find((item) => item.id === approval.id);
  assert.ok(used?.consumedAt, "the grant is used up with its turn");
});

test("Claude Code's own modes: a command the CLI asks about is never answered by the app from a stored shell rule (its rules are the CLI's own)", async () => {
  const drew = ownModeClaude({ shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "git status" }] } });
  const conversation = chatConversation([drew]);
  const { service, storage } = testService({ conversation });
  const pending = service.requestToolPermissionFromTool({
    conversationId: conversation.id, participantId: drew.id, roleConfigId: drew.roleConfigId, roleConfigVersion: 0,
    capabilities: ["permissions.request" as const], runId: "run-shell", triggerMessageId: "user-message", agentMode: "default"
  } as never, { tool_name: "Bash", input: { command: "git status --short" }, tool_use_id: "t1" });
  await waitFor(() => ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).some((approval) => approval.status === "pending"));
  const card = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find((approval) => approval.status === "pending")!;
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: false });
  assert.equal((await pending).behavior, "deny", "a card, not an answer from the rule");
});

test("Claude Code's own modes: the app tool policy given once for the CLI session does not depend on the mode", () => {
  const { service } = testService({ conversation: chatConversation([ownModeClaude()]), appMcp: fakeAppMcp() as never });
  const policy = (agentMode: string, cliApprovals: boolean) => chatParts(service).memberSessions.appToolPromptPolicy({
    participantId: "claude-participant", sessionId: "s", roleConfigId: ROLE.id, roleConfigVersion: 1, roleLabel: ROLE.label, roleInstructions: ROLE.instructions,
    updatedAt: NOW, participantKind: "claude-code", participantAgentMode: agentMode,
    participantPermissions: { ...defaultChatAgentPermissions(), ...(cliApprovals ? { cliApprovals: true } : {}) },
    roleAppToolCapabilities: ["permissions.request"]
  }) as string;
  assert.equal(policy("auto", true), policy("default", true));
  assert.equal(policy("plan", true), policy("default", true));
  assert.notEqual(policy("auto", false), policy("default", false), "a classic member's Auto says its own");
});

test("a classic Claude Code member's mode is its process's: a new one, and nothing set in a live one", async () => {
  const runs: Array<{ options: any }> = [];
  const drew = chatParticipant("claude-code", { repoRead: true });
  const conversation = chatConversation([drew]);
  const { service, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ options });
      return { participant: runParticipant, ok: true, content: "ok", durationMs: 1, sessionId: "session-drew" };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const process = liveClaudeProcess(service);
  await service.sendMessage({ conversationId: conversation.id, runId: "run-1", content: "@drew go on" });
  await waitFor(() => runs.length === 1);
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "plan" });
  await service.sendMessage({ conversationId: conversation.id, runId: "run-2", content: "@drew go on" });
  await waitFor(() => runs.length === 2);
  assert.notEqual(runs[1].options.warm.contextKey, runs[0].options.warm.contextKey);
  assert.equal(runs[1].options.warm.permissionMode, undefined);
  assert.deepEqual(process.sent, []);
});

test("Claude Code's own modes on a machine: a mode changed on another device is set in the member's live process there; the computer sets nothing for it", async () => {
  const drew = {
    ...chatParticipant("claude-code", { repoRead: true }),
    homeMachineId: "machine-1",
    permissions: { ...normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), repoRead: true }), cliApprovals: true as const }
  };
  const conversation = chatConversation([drew]);
  // On the computer: the member runs on its machine.
  const desktop = testService({ conversation });
  const desktopProcess = liveClaudeProcess(desktop.service);
  await desktop.service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "auto" });
  await desktop.service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "plan" });
  await flushMicrotasks();
  assert.deepEqual(desktopProcess.sent, [], "not this device's member");

  // On its machine, the change arrives through the User's server.
  const machine = testService({ conversation });
  machine.service.setHostMachineId("machine-1");
  const machineProcess = liveClaudeProcess(machine.service);
  await machine.service.applyServerEntries([fromServer(conversation.id, "desktop-device", { kind: "conversation.update", conversationId: conversation.id, title: "Renamed", updatedAt: new Date().toISOString() } as any)]);
  await machine.service.applyServerEntries([fromServer(conversation.id, "desktop-device", { kind: "conversation.update", conversationId: conversation.id,
    metadata: { participants: [{ ...drew, agentMode: "plan" }] }, updatedAt: new Date().toISOString() } as any)]);
  await waitFor(() => machineProcess.sent.length === 1);
  assert.deepEqual(machineProcess.sent, [{ subtype: "set_permission_mode", mode: "plan" }]);
});

/** A Claude Code member in its CLI's own Plan mode (the sessions view). */
function planMember() {
  return {
    ...chatParticipant("claude-code", { repoRead: true }),
    agentMode: "plan" as const,
    permissions: { ...normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), repoRead: true }), cliApprovals: true as const }
  };
}

test("Claude Code's plan approval: ExitPlanMode raises the CLI's own card; a Yes carries its setMode back, No sends her words", async () => {
  const drew = planMember();
  const conversation = chatConversation([drew]);
  const { service, storage } = testService({ conversation });
  const actor = { ...toolPermissionActor(drew, conversation), agentMode: "plan" as const };
  const plan = "# Plan\n\n1. Write hello.txt with hi.";
  const input = { plan, planFilePath: "/home/user/.claude/plans/plan.md" };

  const first = service.requestToolPermissionFromTool(actor, { tool_name: "ExitPlanMode", input, tool_use_id: "toolu_plan_1" });
  const card = await pendingToolPermission(storage, "ExitPlanMode");
  assert.equal(card.summary, "Ready to code?");
  assert.deepEqual(card.request, {
    kind: "toolPermission",
    agentMode: "plan",
    nativeOccurrenceId: "toolu_plan_1",
    toolName: "ExitPlanMode",
    planApproval: { plan, planFilePath: "/home/user/.claude/plans/plan.md" }
  }, "the plan, not a tool input preview; no \"for this chat\"");

  // An answer that is not one of its rows (an older phone's Allow, auto
  // mode the card did not offer) is refused; the card still asks.
  await assert.rejects(service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true }), /^Error: Update the phone app to answer this card\.$/,
    "an older phone's Allow: told why");
  await assert.rejects(service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true,
    planDecision: { optionId: "yes-resume-auto-mode" } }), /This answer is not one this card takes\./);
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true,
    planDecision: { optionId: "yes-accept-edits-keep-context" } });
  assert.deepEqual(await first, {
    behavior: "allow",
    updatedInput: input,
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }]
  });
  const answered = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find((item) => item.id === card.id)!;
  assert.equal(answered.status, "approved");
  assert.deepEqual(answered.planDecision, { optionId: "yes-accept-edits-keep-context" });
  assert.deepEqual((answered.request as { planApproval?: unknown }).planApproval, { planFilePath: "/home/user/.claude/plans/plan.md" }, "the answered card keeps no plan");
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content === "@drew: Yes, auto-accept edits."));

  // Manual: setMode default.
  const manual = service.requestToolPermissionFromTool({ ...actor, runId: "run-43" }, { tool_name: "ExitPlanMode", input, tool_use_id: "toolu_plan_2" });
  const manualCard = await pendingToolPermission(storage, "ExitPlanMode");
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: manualCard.id, approve: true, planDecision: { optionId: "yes-default-keep-context" } });
  assert.deepEqual((await manual).updatedPermissions, [{ type: "setMode", mode: "default", destination: "session" }]);

  // No, keep planning: her words, as the CLI's rejection with feedback.
  const keep = service.requestToolPermissionFromTool({ ...actor, runId: "run-44" }, { tool_name: "ExitPlanMode", input, tool_use_id: "toolu_plan_3" });
  const keepCard = await pendingToolPermission(storage, "ExitPlanMode");
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: keepCard.id, approve: false,
    planDecision: { optionId: "no", feedback: "  Use a fixture instead.  " } });
  assert.deepEqual(await keep, {
    behavior: "deny",
    message: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nUse a fixture instead."
  });

  // A plan approval is never answered by a rule, even one "for this chat".
  (storage.current.metadata as any).appToolApprovalPolicies = [{ id: "p1", participantId: drew.id, roleConfigId: drew.roleConfigId, toolName: APP_TOOL_PERMISSION_TOOL,
    capability: "permissions.request", targetToolName: "ExitPlanMode", scope: "chat", createdAt: "", updatedAt: "" }];
  const asked = service.requestToolPermissionFromTool({ ...actor, runId: "run-45" }, { tool_name: "ExitPlanMode", input: { plan: "" }, tool_use_id: "toolu_plan_4" });
  const askedCard = await pendingToolPermission(storage, "ExitPlanMode");
  assert.deepEqual((askedCard.request as { planApproval?: unknown }).planApproval, { plan: "" });
  // A Deny without a row (Activity's Cancel, an older phone's Deny) is "No,
  // keep planning" with nothing typed: the CLI's rejection that waits for her.
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: askedCard.id, approve: false });
  assert.deepEqual(await asked, {
    behavior: "deny",
    message: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
  });
});

test("Claude Code's plan approval offers auto mode once the member's CLI ran in it, and a classic member's ExitPlanMode stays a tool card", async () => {
  const drew = planMember();
  const conversation = chatConversation([drew]);
  const { service, storage } = testService({ conversation });
  chatDependencies(service).cliRunner.memberClaudeAutoModeAvailable = () => true;
  const pending = service.requestToolPermissionFromTool({ ...toolPermissionActor(drew, conversation), agentMode: "plan" as const }, {
    tool_name: "ExitPlanMode", input: { plan: "Do it." }, tool_use_id: "toolu_auto"
  });
  const card = await pendingToolPermission(storage, "ExitPlanMode");
  assert.deepEqual((card.request as { planApproval?: unknown }).planApproval, { plan: "Do it.", autoModeAvailable: true });
  await assert.rejects(service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true,
    planDecision: { optionId: "yes-accept-edits-keep-context" } }), /This answer is not one this card takes\./, "the CLI offers auto mode in its place");
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true, planDecision: { optionId: "yes-resume-auto-mode" } });
  assert.deepEqual((await pending).updatedPermissions, [{ type: "setMode", mode: "auto", destination: "session" }]);

  const classic = chatParticipant("claude-code", { repoRead: true });
  const classicChat = chatConversation([classic]);
  const other = testService({ conversation: classicChat });
  const classicPending = other.service.requestToolPermissionFromTool(toolPermissionActor(classic, classicChat), { tool_name: "ExitPlanMode", input: { plan: "x" } });
  const toolCard = await pendingToolPermission(other.storage, "ExitPlanMode");
  assert.equal((toolCard.request as { planApproval?: unknown }).planApproval, undefined);
  // Answered, so the waiting request ends and the test process can exit.
  await other.service.respondToAppToolApproval({ conversationId: classicChat.id, approvalId: toolCard.id, approve: false });
  await classicPending;
});

test("Claude Code's plan approval: after a Yes the member's mode follows the CLI and is not switched back to Plan", async () => {
  const runs: Array<{ options: any }> = [];
  const drew = planMember();
  const conversation = chatConversation([drew]);
  const { service, storage, tempRoot, debugEvents } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ options });
      return { participant: runParticipant, ok: true, content: "ok", durationMs: 1, sessionId: "session-drew" };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const process = liveClaudeProcess(service);
  await service.sendMessage({ conversationId: conversation.id, runId: "run-1", content: "@drew plan it" });
  await waitFor(() => runs.length === 1);
  const warm = runs[0].options.warm;
  assert.equal(warm.permissionMode(), "plan");
  assert.equal(typeof warm.onCliPermissionMode, "function");

  // The CLI moved itself on her "Yes, auto-accept edits".
  warm.onCliPermissionMode("acceptEdits");
  assert.equal(warm.permissionMode(), "acceptEdits", "a message sent before the save lands goes in as it is");
  await waitFor(() => debugEvents.some((entry) => entry.event === "chat.member-mode.followed-cli"));
  const member = (storage.current.metadata.participants as ChatParticipant[])[0];
  assert.equal(member.agentMode, "default");
  assert.equal(member.permissions?.workspaceWrite, true);
  assert.equal(member.permissions?.cliApprovals, true);
  assert.equal(member.permissions?.repoRead, true, "every other right kept");
  assert.equal(selectedChatAccessOption("claude-code", member.agentMode, member.permissions)?.id, "acceptEdits", "the chip says Accept edits");
  await flushMicrotasks();
  assert.deepEqual(process.sent, [], "the process is not switched (back) for it");

  await service.sendMessage({ conversationId: conversation.id, runId: "run-2", content: "@drew go" });
  await waitFor(() => runs.length === 2);
  assert.equal(runs[1].options.warm.permissionMode(), "acceptEdits", "the next message runs in it, not in Plan");
  assert.equal(runs[1].options.warm.contextKey, warm.contextKey, "the same live process");

  // Her own change afterwards is set in the process as before.
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: drew.id, agentMode: "plan" });
  await waitFor(() => process.sent.length === 1);
  assert.deepEqual(process.sent, [{ subtype: "set_permission_mode", mode: "plan" }]);
});

test("auto mode handles shell permission requests via native auto without a user approval", async () => {
  const participant = chatParticipant("claude-code");
  participant.agentMode = "auto";
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const beforePermissions = structuredClone(participant.permissions);

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "auto-shell-run",
    triggerMessageId: "user-message",
    runPermissions: {
      ...defaultChatAgentPermissions(),
      workspaceWrite: true,
      webAccess: true,
      shell: { enabled: true, rules: [] }
    }
  }, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }],
    reason: "Need shell."
  });

  // Auto-review delegates shell decisions to the native auto classifier, so a shellRules
  // request is reported already-handled and creates no pending User approval.
  assert.equal(result.status, "already_granted");
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
  assert.deepEqual(storage.current.metadata.participants[0].permissions, beforePermissions);
});

test("Claude Code's own modes: a reply the CLI starts on its own in a wider mode than the member's is switched first, else stopped", async () => {
  const drew = ownModeClaude();
  const conversation = chatConversation([drew]);
  let warmOptions: any;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      warmOptions = runOptions.warm;
      return { participant: runParticipant, ok: true, content: "Started.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const process = liveClaudeProcess(service);
  await service.sendMessage({ conversationId: conversation.id, runId: "send-1", content: "@drew start it" });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "Started." && message.status === "done"));
  const selfStarted = () => {
    let attachedSignal: AbortSignal | undefined;
    warmOptions.onSelfResumedTurn({
      origin: warmOptions.origin,
      attach: (handlers: any) => {
        attachedSignal = handlers.signal;
        return Promise.resolve({ participant: drew, ok: !handlers.signal?.aborted, content: handlers.signal?.aborted ? "" : "Done on its own.", durationMs: 1 });
      }
    });
    return () => attachedSignal;
  };
  // Its process still runs Auto (a lowered mode it did not take): switched to Manual first.
  process.mode = "auto";
  const first = selfStarted();
  await waitFor(() => first() !== undefined);
  assert.deepEqual(process.sent.at(-1), { subtype: "set_permission_mode", mode: "default" });
  assert.equal(first()!.aborted, false, "switched: the reply goes on in Manual");
  // It refuses the switch: the reply is stopped and the chat says so.
  process.mode = "auto";
  process.refuse = "Claude Code did not answer within 15 seconds";
  const second = selfStarted();
  await waitFor(() => second() !== undefined);
  assert.equal(second()!.aborted, true, "stopped rather than go on in Auto");
  await waitFor(() => (storage.current.metadata.warnings ?? []).some((warning: string) => warning.includes("started a reply on its own in Auto")));
});

test("a member whose machine's program cannot run its Full Access or Plan mode is refused with a line, never asked of that machine", async () => {
  // A program from before the CLIs' own modes runs Full Access as Ask for
  // approval and drops Plan mode: it would run the member otherwise than its
  // controls say, so its turn is refused as Fork, Restart and compaction are.
  const own = { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true as const };
  const fullAccess = { ...chatParticipant("codex-cli"), id: "full-access-member", handle: "fa", homeMachineId: "box", agentMode: "full-access" as const, permissions: own };
  const planned = { ...chatParticipant("codex-cli"), id: "plan-member", handle: "planner", homeMachineId: "box", agentMode: "default" as const, permissions: { ...own, codexPlanMode: true as const } };
  const asking = { ...chatParticipant("codex-cli"), id: "asking-member", handle: "asker", homeMachineId: "box", agentMode: "default" as const, permissions: own };
  const h = testService({ conversation: chatConversation([fullAccess, planned, asking]) });
  const support = new Map<string, "supported" | "outdated" | "unknown">([["box", "outdated"]]);
  h.service.setMachineCliModesSupport((machineId) => support.get(machineId) ?? "unknown");
  const link = fakeServerLink("desktop-device", { box: "Cloud box" });
  h.service.setServerLink(link);
  const asked = () => link.ops.filter((op): op is Extract<HubOp, { kind: "turn.request" }> => op.kind === "turn.request");
  const conversationId = h.storage.current.id;

  await h.service.sendMessage({ conversationId, content: "@fa hello" });
  await waitFor(() => h.storage.current.messages.some((item: ChatMessage) => item.participantId === fullAccess.id && item.status === "error"));
  const refused = h.storage.current.messages.find((item: ChatMessage) => item.participantId === fullAccess.id && item.status === "error");
  assert.match(`${refused.content} ${refused.metadata?.error ?? ""}`, /Cloud box runs an older program that cannot run Full Access: Settings → Machines → Upgrade runtime, or choose another mode\./);
  const first = h.storage.current.messages.find((item: ChatMessage) => item.role === "user" && item.content === "@fa hello");
  assert.deepEqual(first.metadata.deliveryTargets, [], "the server is never asked for it, so the machine never takes it");
  assert.deepEqual(asked(), [], "nothing asked of the machine");

  await h.service.sendMessage({ conversationId, content: "@planner hello" });
  await waitFor(() => h.storage.current.messages.some((item: ChatMessage) => item.participantId === planned.id && item.status === "error"));
  const planRefused = h.storage.current.messages.find((item: ChatMessage) => item.participantId === planned.id && item.status === "error");
  assert.match(`${planRefused.content} ${planRefused.metadata?.error ?? ""}`, /cannot run Plan mode/);
  assert.deepEqual(asked(), [], "Plan mode: nothing asked either");

  // A mode that program runs as its controls say is asked of it as before.
  await h.service.sendMessage({ conversationId, content: "@asker hello" });
  await waitFor(() => asked().length === 1);
  assert.equal(asked()[0].participantId, asking.id);
  await memberDeviceAnswers(h.service, asked()[0], { participant: asking, content: "ASKED_REPLY" });
  await waitFor(() => h.storage.current.messages.some((item: ChatMessage) => item.content === "ASKED_REPLY"));

  // Once the machine runs a program that runs them, Full Access is asked of it.
  support.set("box", "supported");
  await h.service.sendMessage({ conversationId, content: "@fa again" });
  await waitFor(() => asked().length === 2);
  assert.equal(asked()[1].participantId, fullAccess.id);
  const again = h.storage.current.messages.find((item: ChatMessage) => item.role === "user" && item.content === "@fa again");
  assert.deepEqual(again.metadata.deliveryTargets, [fullAccess.id]);
  await memberDeviceAnswers(h.service, asked()[1], { participant: fullAccess, content: "FULL_ACCESS_REPLY" });
  await waitFor(() => h.storage.current.messages.some((item: ChatMessage) => item.content === "FULL_ACCESS_REPLY"));
});

test("agent modes do not promote participant request permission", () => {
  const ask = normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "ask" });
  const deny = normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "deny" });

  assert.equal(effectiveChatAgentPermissionsForProvider("codex-cli", "auto", ask).requestParticipants, "ask");
  assert.equal(effectiveChatAgentPermissionsForProvider("codex-cli", "plan", ask).requestParticipants, "ask");
  assert.equal(effectiveChatAgentPermissionsForProvider("codex-cli", "auto", deny).requestParticipants, "deny");
});
