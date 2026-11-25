import assert from "node:assert/strict";
import test from "node:test";
import { chatDependencies } from "./chat/test/chatParts";
import { normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { selectedChatAccessOption } from "../../shared/chatAccessModes";
import {
  forkedChatTitle, forkedMainSessionFor, forkedMainSessionPermissions, forkLocalProviderUnavailable, forkToNewChatLocalProviders,
  forkToNewChatReasonFromOffer, forkToNewChatUnavailableReason, lastMemberTurnEnd, localProviderUnavailableReason,
  memberAsItRunsNow, memberHasForkableSession
} from "../../shared/forkToNewChat";
import type { AgentHealth, ChatAgentPermissions, ChatParticipant } from "../../shared/types";
import {
  ASSISTANT, clone, MAIN_ROLE, NOW, oldChat, participantsOf, permissions, READY_AGENTS, REPLY_FINISHED, REVIEWER, sessionRecord,
  sessionsOf, testService
} from "./chat/test/forkFixtures";

test("a member of a chat from before becomes the main session of a new sessions-view chat in its project, with its provider, model, effort, access and place", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({ conversations: [source] });
  const created = await service.createConversation({ participants: [], title: "ignored", repoPath: "/elsewhere", forkOf: { conversationId: source.id, participantId: REVIEWER.id } });
  const chat = created.conversation;
  assert.equal(chat.title, "Old chat (fork)");
  assert.equal(chat.repoPath, "/projects/app", "the member's project: its CLI session belongs to that folder");
  assert.equal(chat.metadata.chatView, "sessions", "every new chat opens in the sessions view, a view stored from before notwithstanding");
  const [main, ...others] = participantsOf(chat);
  assert.equal(others.length, 0, "the main session alone");
  assert.equal(chat.metadata.mainSessionParticipantId, main!.id);
  assert.equal(main!.roleConfigId, MAIN_ROLE.id);
  assert.equal(main!.handle, "main");
  assert.equal(main!.kind, "claude-code");
  assert.equal(main!.model, "sonnet");
  assert.equal(main!.reasoningEffort, "high");
  assert.equal(main!.agentMode, "default");
  assert.equal(main!.homeMachineId, undefined, "it runs where the member runs: this computer");
  const granted = normalizeChatAgentPermissions(main!.permissions);
  assert.equal(granted.repoRead, true);
  assert.equal(granted.workspaceWrite, true);
  assert.equal(granted.webAccess, true);
  assert.equal(granted.cliApprovals, true, "the CLI's own mode, as the member had it");
  assert.deepEqual(granted.shell, { enabled: true, rules: [{ action: "deny", match: "prefix", pattern: "git push" }] });
  assert.equal(granted.requestParticipants, "allow", "it asks members as the main session's role gives, not as the member could");
  assert.deepEqual(main!.forkOrigin, { conversationId: source.id, participantId: REVIEWER.id, handle: "reviewer", conversationTitle: "Old chat", kind: "claude-code",
    seen: { messageId: "old-reply", finishedAt: REPLY_FINISHED } }, "with the reply she saw last: the copy ends with its turn");
  assert.deepEqual(sessionsOf(chat), [], "nothing runs until the first message");
  assert.deepEqual(chat.messages.map((message) => message.role), ["system"], "it opens empty");
  assert.equal(runs.length, 0);
  assert.deepEqual(storage.store.get(source.id), source, "the member and its chat are untouched");
});

test("the menus and the service give the same reasons", () => {
  assert.equal(forkedChatTitle("Plan the release"), "Plan the release (fork)");
  assert.equal(forkedChatTitle("x".repeat(100)).length, 80, "within a title's length");
  assert.equal(forkToNewChatUnavailableReason({ participant: { kind: "codex-cli" }, hasSession: true }), undefined);
  assert.equal(forkToNewChatUnavailableReason({ participant: { kind: "codex-cli" }, hasSession: true, providerUnavailable: "Codex CLI requires sign-in." }), "Codex CLI requires sign-in.");
  assert.equal(forkToNewChatUnavailableReason({ participant: { kind: "claude-code", homeMachineId: "m" }, hasSession: true, machineSupport: "supported", providerUnavailable: "not here" }), undefined,
    "a machine's member runs on that machine's CLI");
  const metadata = { participantSessions: [sessionRecord(REVIEWER, "s-1")], lastMessageByParticipant: {} };
  assert.equal(memberHasForkableSession(metadata, REVIEWER), true);
  assert.equal(memberHasForkableSession(metadata, ASSISTANT), false);
  assert.equal(memberHasForkableSession(metadata, { ...ASSISTANT, homeMachineId: "m" }, [{ role: "participant", participantId: ASSISTANT.id }]), true);
});

test("the phone makes the same main session the computer makes, from what the computer offers it", async () => {
  // A member the main session made, with more than the main session may
  // give: it is copied as it runs (never above the main session).
  const mainSession: ChatParticipant = { id: "main-src", handle: "main", roleConfigId: MAIN_ROLE.id, kind: "codex-cli", agentMode: "default",
    permissions: permissions({ workspaceWrite: false, webAccess: true, requestParticipants: "allow", shell: { enabled: true, rules: [{ action: "deny", match: "prefix", pattern: "rm" }] } }) };
  const host = { id: "host-z", label: "Z.ai", cli: "claude-code" as const, vendor: "zai" as never, baseUrl: "https://example.invalid", hasApiKey: true, updatedAt: NOW };
  const cases: Array<[string, ChatParticipant]> = [
    ["a member the main session made, on this computer", { ...REVIEWER, delegatedByParticipantId: mainSession.id, agentMode: "auto" }],
    ["a member on a machine", { ...REVIEWER, id: "boxed", handle: "boxed", homeMachineId: "m-1", remoteExecution: "local" }],
    ["a Cloud run member on its machine", { ...REVIEWER, id: "cloudy", handle: "cloudy", homeMachineId: "m-1", cloudRun: { instanceId: "i-1" } as never }],
    ["a member on an added provider", { ...REVIEWER, id: "hosted", handle: "hosted", hostId: host.id, hostLabel: host.label, hostVendor: host.vendor }]
  ];
  for (const [label, member] of cases) {
    const source = oldChat([mainSession, member], {
      mainSessionParticipantId: mainSession.id,
      participantSessions: [sessionRecord(member, "src-cli-session")],
      // Its last reply, older than the messages held.
      lastMessageByParticipant: { [member.id]: { messageId: `far-${member.id}`, sequence: 1 } }
    });
    const { service } = testService({ conversations: [source], agents: READY_AGENTS, machines: [{ id: "m-1", name: "Box" }] });
    service.setMachineForkToNewChatSupport(() => "supported");
    const settings = chatDependencies(service).settings;
    const plain = settings.getPublicSettings;
    for (const read of ["getPublicSettings", "ensureGenericChatParticipantSeeds", "ensureAssistantProviderDefault"]) {
      settings[read] = async () => ({ ...(await plain()), cliProviderHosts: [host] });
    }
    const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: member.id } });
    const [desktopMain] = participantsOf(created.conversation);
    const offer = await service.newChatOptions([]);
    assert.ok(offer?.fork, `${label}: the computer tells the phone what it needs to fork`);
    const running = memberAsItRunsNow(member, mainSession);
    assert.equal(forkToNewChatReasonFromOffer({ running, answered: true, offer: offer!.fork! }), undefined, `${label}: offered on the phone too`);
    // Her server reads the reply the User saw by the computer's rule
    // (StorageService.conversationLastTurnEnd, checked below).
    const phoneMain = forkedMainSessionFor({
      mainSession: offer!.mainSession!, basePermissions: offer!.fork!.basePermissions, member: running,
      source: { id: source.id, title: source.title }, seen: lastMemberTurnEnd(source.messages, member.id), id: desktopMain!.id
    });
    assert.deepEqual(clone(phoneMain), clone(desktopMain), `${label}: the same member, rights, place and origin on both`);
    if (member.id === REVIEWER.id) {
      assert.deepEqual(desktopMain!.forkOrigin?.seen, { messageId: "old-reply", finishedAt: REPLY_FINISHED }, `${label}: the same reply she saw, on both`);
    }
  }
});

test("the computer's offer says why each of its CLIs cannot run a forked member, and what each machine's program can do", async () => {
  const notSignedIn: AgentHealth[] = [
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "required" } as AgentHealth,
    { kind: "codex-cli", label: "Codex CLI", installed: true }
  ];
  const { service } = testService({ conversations: [], agents: notSignedIn, machines: [{ id: "m-new", name: "New" }, { id: "m-old", name: "Old" }] });
  service.setMachineForkToNewChatSupport((machineId) => machineId === "m-new" ? "supported" : "outdated");
  const offer = await service.newChatOptions([]);
  assert.deepEqual(offer?.fork?.machines, { "m-new": "supported", "m-old": "outdated" });
  const providers = [{ kind: "claude-code" as const, enabled: true }, { kind: "codex-cli" as const, enabled: true }];
  for (const member of [{ kind: "claude-code" as const }, { kind: "codex-cli" as const }, { kind: "claude-code" as const, hostId: "gone" }]) {
    assert.equal(forkLocalProviderUnavailable(member, offer!.fork!), localProviderUnavailableReason(member, notSignedIn, providers, []),
      `${member.kind}${member.hostId ? ` (${member.hostId})` : ""}: the computer's words`);
  }
  assert.ok(forkLocalProviderUnavailable({ kind: "claude-code" }, offer!.fork!), "a CLI not signed in refuses its member");
  // Nothing detected yet: nobody is refused for a CLI, as on the computer.
  const unjudged = forkToNewChatLocalProviders([], providers, []);
  assert.equal(forkLocalProviderUnavailable({ kind: "claude-code", hostId: "gone" }, unjudged), localProviderUnavailableReason({ kind: "claude-code", hostId: "gone" }, [], providers, []));
  assert.equal(offer!.fork!.basePermissions.requestParticipants, "allow", "the main session's role's say over members");
});

test("a fork keeps the member's own compaction right on the computer and the phone, never Settings' default for new chats", async () => {
  const cases = [
    ["allowed to compact, Settings asking", "allow", false],
    ["asking, Settings compacting without asking", "ask", true],
    ["never compacting", "deny", true]
  ] as const;
  for (const [label, right, compactWithoutAsking] of cases) {
    const member: ChatParticipant = { ...REVIEWER, permissions: { ...REVIEWER.permissions!, requestCompaction: right } };
    const source = oldChat([ASSISTANT, member]);
    const { service } = testService({ conversations: [source], agents: READY_AGENTS, newChatDefaults: { compactWithoutAsking, model: "opus", kind: "claude-code", access: "plan" } });
    const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: member.id } });
    const [desktopMain] = participantsOf(created.conversation);
    assert.equal(normalizeChatAgentPermissions(desktopMain!.permissions).requestCompaction, right, `${label}: the member's own on the computer`);
    assert.deepEqual([desktopMain!.model, desktopMain!.agentMode], ["sonnet", "default"], `${label}: the member's model and mode, not Settings'`);
    const offer = await service.newChatOptions([]);
    assert.equal(offer!.mainSession!.permissions!.requestCompaction, compactWithoutAsking ? "allow" : "ask", `${label}: a new chat's main session follows Settings`);
    const phoneMain = forkedMainSessionFor({
      mainSession: offer!.mainSession!, basePermissions: offer!.fork!.basePermissions, member: memberAsItRunsNow(member, undefined),
      source: { id: source.id, title: source.title }, seen: lastMemberTurnEnd(source.messages, member.id), id: desktopMain!.id
    });
    assert.deepEqual(clone(phoneMain), clone(desktopMain), `${label}: the phone makes the same main session`);
  }
});

test("a member with rights set in the classic view is forked into its CLI's own mode, the one it was running in, never Custom, on the computer and the phone", async () => {
  const classic = (patch: Partial<ChatAgentPermissions>) => permissions({ webAccess: true, requestCompaction: "allow", ...patch, cliApprovals: undefined });
  const cases: Array<[string, Partial<ChatParticipant>, string, string]> = [
    ["Claude Code running auto", { agentMode: "auto", permissions: classic({ workspaceWrite: true }) }, "auto", "auto"],
    ["Claude Code editing in its default mode", { agentMode: "default", permissions: classic({ workspaceWrite: true }) }, "default", "acceptEdits"],
    ["Claude Code read-only", { agentMode: "default", permissions: classic({ workspaceWrite: false }) }, "default", "manual"]
  ];
  for (const [label, patch, mode, option] of cases) {
    const member: ChatParticipant = { ...REVIEWER, ...patch };
    const source = oldChat([ASSISTANT, member]);
    const { service } = testService({ conversations: [source], agents: READY_AGENTS });
    const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: member.id } });
    const [desktopMain] = participantsOf(created.conversation);
    assert.equal(desktopMain!.agentMode, mode, `${label}: the mode it ran in`);
    assert.equal(selectedChatAccessOption(desktopMain!.kind, desktopMain!.agentMode, desktopMain!.permissions)?.id, option, `${label}: its CLI's own mode, not Custom`);
    const granted = normalizeChatAgentPermissions(desktopMain!.permissions);
    assert.deepEqual([granted.cliApprovals, granted.webAccess, granted.requestCompaction], [true, true, "allow"], `${label}: its rights and compaction right kept`);
    const offer = await service.newChatOptions([]);
    const phoneMain = forkedMainSessionFor({
      mainSession: offer!.mainSession!, basePermissions: offer!.fork!.basePermissions, member: memberAsItRunsNow(member, undefined),
      source: { id: source.id, title: source.title }, seen: lastMemberTurnEnd(source.messages, member.id), id: desktopMain!.id
    });
    assert.deepEqual(clone(phoneMain), clone(desktopMain), `${label}: the phone makes the same main session`);
  }
});

test("a forked main session never gets more than the member had, besides the main session's say over members", () => {
  const base = permissions({ repoRead: true, workspaceWrite: true, webAccess: true, requestParticipants: "allow", cliApprovals: true,
    providerNative: { "claude-code": { allowedTools: ["Bash(*)"] } }, shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "rm" }] } });
  const merged = forkedMainSessionPermissions(base, permissions({ repoRead: false, requestParticipants: "deny" }));
  assert.deepEqual(merged, permissions({ repoRead: false, requestParticipants: "allow" }));
});
