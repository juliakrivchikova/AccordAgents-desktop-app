import assert from "node:assert/strict";
import test from "node:test";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { hubTurnRunId } from "../../shared/hubOps";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";
import { MAIN_SESSION_ROLE_ID } from "../../shared/mainSession";
import type {
  AgentHealth, ChatMessage, ChatParticipant, ChatParticipantConfig, ChatRoleConfig, ParticipantConfig
} from "../../shared/types";
import {
  ADMIN_ROLE, chatConversation, chatParticipant, fakeServerLink, installedChatAgents, NOW, participantManagerActor, ROLE,
  testService, waitFor
} from "./chat/test/permissionFixtures";

test("local provider preference records only the first nonempty successful Assistant response", async () => {
  const participant = { ...chatParticipant("claude-code"), roleConfigId: ADMIN_ROLE.id, handle: "assistant" };
  const conversation = chatConversation([participant]);
  let outcome: "failed" | "empty" | "success" = "failed";
  const { service, settingsState, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] },
    run: async (runParticipant) => outcome === "failed"
      ? { participant: runParticipant, ok: false, content: "Provider failed.", error: "failed", durationMs: 1 }
      : outcome === "empty"
        ? { participant: runParticipant, ok: true, content: "", durationMs: 1 }
        : { participant: runParticipant, ok: true, content: "Completed.", durationMs: 1 }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).turnQueue.runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "failed-preference", undefined, undefined, { warnings: [] }
  );
  assert.deepEqual(settingsState.recordedSuccessfulProviders, []);

  outcome = "empty";
  await chatParts(service).turnQueue.runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "empty-preference", undefined, undefined, { warnings: [] }
  );
  assert.deepEqual(settingsState.recordedSuccessfulProviders, []);

  outcome = "success";
  await chatParts(service).turnQueue.runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "successful-preference", undefined, undefined, { warnings: [] }
  );
  assert.deepEqual(settingsState.recordedSuccessfulProviders, ["claude-code"]);

  await chatParts(service).turnQueue.runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "later-success", undefined, undefined, { warnings: [] }
  );
  assert.deepEqual(settingsState.recordedSuccessfulProviders, ["claude-code"]);
  assert.equal(conversation.metadata.activationProviderKind, "claude-code");
});

test("successful non-Assistant participant responses do not change the Assistant provider preference", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, settingsState, tempRoot } = testService({ conversation });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).turnQueue.runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "generic-success", undefined, undefined, { warnings: [] }
  );

  assert.deepEqual(settingsState.recordedSuccessfulProviders, []);
  assert.equal(conversation.metadata.activationProviderKind, undefined);
});

test("the phone's New chat options come out the same while nothing changed, each member named by its preset", { timeout: 10_000 }, async () => {
  const saved: ChatParticipantConfig = {
    id: "saved-drew", handle: "drew", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "codex-cli", updatedAt: NOW
  };
  const { service } = testService({ agents: installedChatAgents(), settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [saved] } });
  const first = await service.newChatOptions([]);
  const second = await service.newChatOptions([]);
  assert.ok(first);
  // An unchanged offer is not published again (hubPhonePublisher compares).
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(first.mainSession?.id, MAIN_SESSION_ROLE_ID, "named by its role, not a fresh id");
  assert.deepEqual(first.assistant, first.mainSession, "a phone from before reads the same main session");
  const drew = first.members.find((member) => member.configId === saved.id);
  assert.equal(drew?.participant.id, saved.id);
  assert.equal(drew?.participant.handle, "drew");
});

test("with no CLI ready the phone's New chat says why in the computer's words, and the Assistant's presets are not offered", { timeout: 10_000 }, async () => {
  const saved: ChatParticipantConfig = { id: "saved-drew", handle: "drew", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "codex-cli", updatedAt: NOW };
  const legacy: ChatParticipantConfig = { id: "saved-admin", handle: "admin", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "codex-cli", updatedAt: NOW };
  const { service } = testService({ agents: [], settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [saved, legacy] } });
  const offered = await service.newChatOptions([]);
  assert.ok(offered);
  assert.equal(offered.unavailable, "Set up and sign in to at least one CLI provider to start a chat.");
  assert.equal(offered.mainSession?.roleConfigId, MAIN_SESSION_ROLE_ID);
  assert.equal(offered.assistant.roleConfigId, MAIN_SESSION_ROLE_ID);
  assert.deepEqual(offered.members.map((member) => member.configId), ["saved-drew"]);
});

test("injected Chat Assistant defaults to no repository access", async () => {
  const { service } = testService({
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] },
    agents: [{ kind: "codex-cli", installed: true } as AgentHealth]
  });

  const [assistant] = await chatParts(service).creation.ensureAdministratorParticipant([]);

  assert.equal(assistant.roleConfigId, ADMIN_ROLE.id);
  assert.equal(assistant.handle, "assistant");
  assert.equal(assistant.permissions.repoRead, false);
  assert.equal(assistant.permissions.workspaceWrite, false);
  assert.equal(assistant.permissions.webAccess, false);
  assert.equal(assistant.permissions.shell.enabled, false);
});

test("chat creation does not seed a visible setup message", async () => {
  const { service, storage } = testService({
    agents: [{ kind: "codex-cli", installed: true } as AgentHealth],
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const result = await service.createConversation({
    title: "Fresh chat",
    participants: [],
    skipDefaultParticipants: true
  });
  const participants = result.conversation.metadata.participants as ChatParticipant[];

  assert.equal(participants.some((participant) => participant.roleConfigId === MAIN_SESSION_ROLE_ID), true);
  assert.equal(result.conversation.messages.length, 1);
  assert.equal(result.conversation.messages[0].role, "system");
  assert.equal(result.conversation.messages.some((message) => message.role === "participant"), false);
  assert.equal(storage.current.messages.some((message: ChatMessage) =>
    message.metadata?.appMessageSource === "chat-assistant-cold-start"
  ), false);
});

test("a new chat gets a main session instead of the Chat Assistant: an ordinary member on the saved provider, named in the chat with the view it opens in", async () => {
  const agents: AgentHealth[] = [
    { kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "ready" }
  ];
  const { service } = testService({ agents, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], assistantProviderKind: "claude-code" } });

  const withProject = await service.createConversation({
    title: "Fresh chat", repoPath: "/test/project", participants: [{ handle: "codex", roleConfigId: ROLE.id, kind: "codex-cli" }]
  });
  const participants = withProject.conversation.metadata.participants as ChatParticipant[];
  const main = participants[0];
  assert.deepEqual(participants.map((item) => [item.handle, item.roleConfigId]), [["main", MAIN_SESSION_ROLE_ID], ["codex", ROLE.id]],
    "the main session first, and no Chat Assistant");
  assert.equal(main.kind, "claude-code", "the provider Settings names for it");
  assert.equal(main.agentMode, "default");
  assert.equal(main.participantConfigId, undefined);
  assert.equal(main.permissions?.repoRead, true, "it reads the chat's project, as an ordinary member does");
  assert.equal(main.permissions?.workspaceWrite, false);
  assert.equal(main.permissions?.webAccess, false);
  assert.equal(main.permissions?.shell.enabled, false);
  assert.equal(main.permissions?.requestParticipants, "allow", "its role asks members without a card");
  assert.equal(withProject.conversation.metadata.mainSessionParticipantId, main.id);
  assert.equal(withProject.conversation.metadata.chatView, "sessions", "unset in Settings: the sessions view");
  assert.match(withProject.conversation.messages[0].content, /- @main\n- @codex/, "the first line lists the main session");

  const withoutProject = await service.createConversation({ title: "Fresh chat", participants: [], skipDefaultParticipants: true });
  const alone = withoutProject.conversation.metadata.participants as ChatParticipant[];
  assert.deepEqual(alone.map((item) => item.roleConfigId), [MAIN_SESSION_ROLE_ID]);
  assert.equal(alone[0].permissions?.repoRead, false, "no project to read, as for an ordinary member");

  // The view Settings once named for new chats is gone: a stored "classic"
  // no longer makes a new chat open classic (the User, 2026-11-22).
  const classic = testService({ agents, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], legacyDefaultChatView: "classic" } });
  const classicChat = await classic.service.createConversation({ title: "Fresh chat", participants: [], skipDefaultParticipants: true });
  assert.equal(classicChat.conversation.metadata.chatView, "sessions", "every new chat opens in the sessions view");
});

test("Settings → General → New chats: a new chat's main session compacts without asking unless turned off, made on the computer or offered to the phone", { timeout: 10_000 }, async () => {
  const agents = installedChatAgents();
  const row = { handle: "main", roleConfigId: MAIN_SESSION_ROLE_ID, kind: "claude-code" as const, permissions: { ...defaultChatAgentPermissions(), requestCompaction: "ask" as const } };
  for (const [label, newChatDefaults, right] of [
    ["unset", undefined, "allow"],
    ["on", { compactWithoutAsking: true }, "allow"],
    ["off", { compactWithoutAsking: false }, "ask"]
  ] as const) {
    const { service } = testService({ agents, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], assistantProviderKind: "claude-code", newChatDefaults } });
    const alone = await service.createConversation({ title: "Fresh chat", participants: [], skipDefaultParticipants: true });
    assert.equal((alone.conversation.metadata.participants as ChatParticipant[])[0].permissions?.requestCompaction, right, `${label}: made without a row from the screen`);
    // The screen has no control for it: Settings decides.
    const fromScreen = await service.createConversation({ title: "Fresh chat", participants: [row] });
    assert.equal((fromScreen.conversation.metadata.participants as ChatParticipant[])[0].permissions?.requestCompaction, right, `${label}: made from the screen's row`);
    const offered = await service.newChatOptions([]);
    assert.equal(offered?.mainSession?.permissions?.requestCompaction, right, `${label}: the phone's new chat`);
  }
});

test("the New chat screen's own row is the main session as the User set it; a chat has one, and no other member gets its role", async () => {
  const { service, storage } = testService({ agents: installedChatAgents(), settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
  const row = {
    handle: "main", roleConfigId: MAIN_SESSION_ROLE_ID, kind: "codex-cli" as const, model: "gpt-5.5", reasoningEffort: "high" as const,
    agentMode: "auto" as const, permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true, requestParticipants: "allow" as const }
  };
  const created = await service.createConversation({
    title: "Fresh chat", participants: [{ handle: "main", roleConfigId: ROLE.id, kind: "claude-code" }, row]
  });
  const participants = created.conversation.metadata.participants as ChatParticipant[];
  const main = participants.find((item) => item.roleConfigId === MAIN_SESSION_ROLE_ID)!;
  assert.equal(participants[0], participants.find((item) => item.id === main.id), "first among the members");
  assert.deepEqual([main.handle, main.kind, main.model, main.reasoningEffort, main.agentMode, main.permissions?.workspaceWrite],
    ["main-2", "codex-cli", "gpt-5.5", "high", "auto", true], "as the User set the row; its name moves aside for a member's");
  assert.equal(participants.filter((item) => item.roleConfigId === MAIN_SESSION_ROLE_ID).length, 1);
  assert.equal(created.conversation.metadata.mainSessionParticipantId, main.id);

  await assert.rejects(() => service.createConversation({ title: "Two", participants: [row, { ...row, handle: "other" }] }), /^Error: A new chat starts with only one session of its own\.$/);

  storage.current = created.conversation;
  await assert.rejects(
    () => service.addParticipant({ conversationId: created.conversation.id, participant: { handle: "second", roleConfigId: MAIN_SESSION_ROLE_ID, kind: "codex-cli" } }),
    /^Error: The "Main session" role cannot be given to @second: a chat gives it only to its own session\.$/
  );
});

test("the main session cannot be removed from its chat", async () => {
  const main = { ...chatParticipant("claude-code"), id: "main-participant", handle: "main", roleConfigId: MAIN_SESSION_ROLE_ID };
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([main, codex], { mainSessionParticipantId: main.id });
  const { service, storage } = testService({ conversation });
  await assert.rejects(
    () => service.removeParticipant({ conversationId: conversation.id, participantId: main.id }),
    /^Error: This chat's own session cannot be removed\.$/
  );
  await service.removeParticipant({ conversationId: conversation.id, participantId: codex.id });
  assert.deepEqual((storage.current.metadata.participants as ChatParticipant[]).map((item) => item.id), [main.id], "another member can be");
});

test("members' tools are not offered the main session's or the Workflow Manager's role for a new member", async () => {
  const main = { ...chatParticipant("claude-code"), id: "main-participant", handle: "main", roleConfigId: MAIN_SESSION_ROLE_ID };
  const workflowManager: ChatRoleConfig = { ...ROLE, id: "workflow-manager", label: "Workflow Manager", builtIn: true };
  const conversation = chatConversation([main], { mainSessionParticipantId: main.id });
  const { service } = testService({ conversation, agents: installedChatAgents(), settings: { chatRoleConfigs: [ROLE, workflowManager] } });
  const actor = participantManagerActor(conversation.id, main);
  const roles = await service.describeRoleOptionsForTool(actor) as { roles: Array<{ id: string }> };
  const participants = await service.describeParticipantOptionsForTool(actor) as { roles: Array<{ id: string }>; currentParticipants: Array<{ id: string; roleConfigId: string }> };
  for (const offered of [roles.roles, participants.roles]) {
    assert.deepEqual(offered.map((role) => role.id), [ROLE.id]);
  }
  assert.equal(participants.currentParticipants[0].roleConfigId, MAIN_SESSION_ROLE_ID, "the main session itself is still described");
});

test("the chat's view switches only in a chat with a main session", async () => {
  const main = { ...chatParticipant("claude-code"), id: "main-participant", handle: "main", roleConfigId: MAIN_SESSION_ROLE_ID };
  const mainChat = chatConversation([main], { mainSessionParticipantId: main.id, chatView: "sessions" });
  const { service, storage } = testService({ conversation: mainChat });
  const before = storage.current.updatedAt;
  const saved = await service.setChatView({ conversationId: mainChat.id, view: "classic" });
  assert.equal(saved?.metadata.chatView, "classic");
  assert.equal(storage.current.metadata.chatView, "classic");
  assert.equal(storage.current.updatedAt, before, "a view is not activity in the chat");
  await assert.rejects(() => service.setChatView({ conversationId: mainChat.id, view: "grid" as never }), /Unknown chat view/);

  const assistant = { ...chatParticipant("codex-cli"), id: "assistant-participant", handle: "assistant", roleConfigId: ADMIN_ROLE.id };
  const oldChat = chatConversation([assistant]);
  const old = testService({ conversation: oldChat });
  await assert.rejects(() => old.service.setChatView({ conversationId: oldChat.id, view: "sessions" }), /one view only/);
  assert.equal(old.storage.current.metadata.chatView, undefined);
});

test("chat creation is blocked when no local CLI is installed", async () => {
  const { service } = testService();

  await assert.rejects(
    () => service.createConversation({ title: "Fresh chat", participants: [] }),
    /Set up and sign in to at least one CLI provider/
  );
});

test("chat creation initializes the persisted default from the sole ready provider for the main session", async () => {
  const { service } = testService({
    agents: [{ kind: "gemini-cli", label: "Antigravity", installed: true }],
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const result = await service.createConversation({
    title: "Fresh chat",
    participants: [],
    skipDefaultParticipants: true
  });
  const assistant = (result.conversation.metadata.participants as ChatParticipant[])
    .find((participant) => participant.roleConfigId === MAIN_SESSION_ROLE_ID);
  assert.equal(assistant?.kind, "gemini-cli");
});

test("chat creation puts the main session on the saved provider when multiple CLIs are ready", async () => {
  const agents: AgentHealth[] = [
    { kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "ready" }
  ];
  const { service } = testService({
    agents,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], assistantProviderKind: "codex-cli" }
  });

  const result = await service.createConversation({
    title: "Fresh chat",
    participants: [],
    skipDefaultParticipants: true
  });
  const assistant = (result.conversation.metadata.participants as ChatParticipant[])
    .find((participant) => participant.roleConfigId === MAIN_SESSION_ROLE_ID);
  assert.equal(assistant?.kind, "codex-cli");
});

test("a saved main session CLI that is not ready gives way to a ready one, on the computer and the phone, and the saved choice stays", { timeout: 10_000 }, async () => {
  // The User, 2026-11-07: once one CLI is signed in nothing else stands in
  // the way of a chat.
  const agents: AgentHealth[] = [
    { kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "required" }
  ];
  const { service } = testService({
    agents,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], assistantProviderKind: "claude-code" }
  });

  const result = await service.createConversation({ title: "Fresh chat", participants: [], skipDefaultParticipants: true });
  const assistant = (result.conversation.metadata.participants as ChatParticipant[])
    .find((participant) => participant.roleConfigId === MAIN_SESSION_ROLE_ID);
  assert.equal(assistant?.kind, "codex-cli");

  const offered = await service.newChatOptions([]);
  assert.equal(offered?.unavailable, undefined);
  assert.equal(offered?.assistant.kind, "codex-cli");
  assert.equal(offered?.assistantNote, "Codex runs this chat: Claude Code, your saved choice, needs sign-in.",
    "the note names the saved CLI, so the saved choice is still Claude Code");
});

test("chat creation allows an unready provider only for remote participants", async () => {
  const agents: AgentHealth[] = [
    { kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
    { kind: "claude-code", label: "Claude Code", installed: false, detection: "not-detected", runnable: "unknown", authentication: "unknown" }
  ];
  const remote = { ...chatParticipant("claude-code"), remoteExecution: "remote" as const };
  const { service } = testService({
    agents,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const created = await service.createConversation({
    title: "Remote member",
    participants: [remote]
  });
  const participants = created.conversation.metadata.participants as ChatParticipant[];
  assert.equal(participants.some((participant) => participant.handle === remote.handle && participant.remoteExecution === "remote"), true);

  await assert.rejects(
    () => service.createConversation({
      title: "Local member",
      participants: [{ ...remote, remoteExecution: "local" }]
    }),
    /Claude Code was not detected/
  );
});

test("existing chat submit attempts an unready local target and lets the provider run decide", async () => {
  const assistant = {
    ...chatParticipant("claude-code"),
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
      { kind: "claude-code", label: "Claude Code", installed: false, detection: "not-detected", runnable: "unknown", authentication: "unknown" }
    ],
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] },
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "The actual provider run succeeded.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "unready-submit",
    content: "@assistant try the provider despite stale readiness."
  });
  await waitFor(() => runs.length === 1);

  assert.equal(runs[0].id, assistant.id);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content.includes("despite stale readiness")));
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content === "The actual provider run succeeded."));
});

test("prospective skill context remains provider-neutral until Assistant selection", async () => {
  const { service } = testService({ settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });

  const neutral = await service.prospectiveUserSkillRunContext({ content: "/office-hours" });
  assert.deepEqual(neutral.target.providerKinds, []);
  assert.equal(neutral.target.hasClearTargets, false);

  const selected = await service.prospectiveUserSkillRunContext({
    assistantProviderKind: "claude-code",
    content: "/office-hours"
  });
  assert.deepEqual(selected.target.providerKinds, ["claude-code"]);
  assert.equal(selected.target.hasClearTargets, true);
});

test("a chat's first message from another device (the phone's New chat) has the member it asked name the chat, as a first message sent here does", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.messages[0].metadata = { threadId: "user-message", deliveryTargets: [participant.id] } as any;
  const prompts: string[] = [];
  const { service, storage, tempRoot } = testService({ conversation, run: async (member, prompt) => {
    prompts.push(String(prompt));
    return { participant: member, ok: true, content: "Answer", durationMs: 1 };
  } });
  service.setServerLink(fakeServerLink("desktop-device"));
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.startServerTurn({ runId: hubTurnRunId("user-message", participant.id), conversationId: conversation.id, messageId: "user-message", participantId: participant.id, state: "requested" });
  await waitFor(() => prompts.length === 1);
  assert.match(prompts[0], /This chat has no title yet: before answering, call `app_chat_set_title` once/);
  assert.equal(storage.current.metadata.autoTitle, undefined, "named only by the member, with app_chat_set_title");
});

test("the phone's New chat offer never waits for a model list: a hanging one is read in the background and the offer is published again once it has it", { timeout: 10_000 }, async () => {
  const { service } = testService({
    agents: [{ kind: "codex-cli", label: "Codex CLI", installed: true, detection: "detected", runnable: "ready", authentication: "ready" }],
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], providers: [{ kind: "codex-cli", label: "Codex CLI", enabled: true }] }
  });
  let answer: ((catalog: unknown) => void) | undefined;
  let reads = 0;
  (chatDependencies(service).cliRunner).listModelCatalog = () => { reads += 1; return new Promise((resolve) => { answer = resolve; }); };
  let republished = 0;
  chatParts(service).newChatOffers.onNewChatOffersChanged = () => { republished += 1; };
  const started = Date.now();
  const first = await service.newChatOptions([]);
  assert.ok(Date.now() - started < 2_000, "the offer did not wait for the hanging list");
  const codex = first?.mainSessionProviders?.find((provider) => provider.kind === "codex-cli");
  assert.deepEqual(codex?.models, [], "its default model only, for now");
  const again = await service.newChatOptions([]);
  assert.equal(reads, 1, "one read at a time, not one per offer");
  assert.equal(JSON.stringify(again), JSON.stringify(first), "an unchanged offer: nothing new to publish");
  answer?.({ kind: "codex-cli", authoritative: true, fetchedAt: NOW, models: [
    { id: "gpt-5.5", label: "GPT-5.5", recommended: true, source: "cli" }, { id: "gpt-5.5-mini", label: "GPT-5.5 mini", source: "cli" }] });
  await service.settleNewChatModelCatalogsForTests();
  assert.equal(republished, 1, "published again once the list arrived");
  const later = await service.newChatOptions([]);
  assert.deepEqual(later?.mainSessionProviders?.find((provider) => provider.kind === "codex-cli")?.models.map((model) => model.id), ["gpt-5.5-mini"]);
  assert.equal(reads, 1, "a fresh list is not read again at once");
});
