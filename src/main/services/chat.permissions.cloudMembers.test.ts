import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import type { HubOp } from "../../shared/hubOps";
import { hubTurnRunId } from "../../shared/hubOps";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { AgentHealth, AppSettings, ChatMessage, ChatParticipant, ChatParticipantConfig, ParticipantConfig } from "../../shared/types";
import {
  ADMIN_ROLE, answeredCard, chatConversation, chatParticipant, fakeServerLink, feedCard, fromServer, installedChatAgents,
  machineCard, memberDeviceAnswers, memberRemovalFixture, NOW, participantRequestActor, pendingParticipantMessage,
  permissionApproval, ROLE, testService, waitFor
} from "./chat/test/permissionFixtures";

test("a member whose project folder or cloud project copy is gone is told so, not that its CLI is missing", async () => {
  const participant = chatParticipant("claude-code");
  const repo = await mkdtemp(path.join(tmpdir(), "gone-project-"));
  const conversation = { ...chatConversation([participant]), repoPath: repo };
  // What the CLI runner reports when the process cannot start in its folder.
  let failure = { content: `@${participant.handle} could not start because the CLI executable is unavailable.`, error: "spawn /bin/sh ENOENT" };
  const { service, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => ({ participant: runParticipant, ok: false, durationMs: 1, ...failure })
  });
  await mkdir(tempRoot, { recursive: true });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const turn = async (runId: string) => {
    await chatParts(service).turnQueue.runParticipantTurnSerialized(conversation, participant, conversation.messages[0], runId, undefined, undefined, { warnings: [] });
    return conversation.messages.find((message: ChatMessage) => message.metadata?.runId === runId)!;
  };

  const present = await turn("folder-present");
  assert.equal(present.status, "error");
  assert.match(present.content, /CLI executable is unavailable/, "a failure in a folder that is there keeps the CLI's own text");

  await rm(repo, { recursive: true, force: true });
  const gone = await turn("folder-gone");
  assert.equal(gone.status, "error");
  assert.equal(gone.content, `@${participant.handle} could not start: the folder ${repo} does not exist.`);

  // On a cloud machine the folder is the machine's copy of the User's project.
  chatParts(service).host.hostMachineId = "box";
  conversation.metadata.machineRepository = { sourcePath: "/Users/me/IdeaProjects/AccordAgents", paths: { box: repo } };
  const copy = await turn("copy-gone");
  assert.equal(copy.content, `@${participant.handle} could not start: the copy of AccordAgents on this cloud machine is missing. Send the message again from your computer to copy the project there again.`);
  assert.deepEqual(copy.metadata?.missingProjectCopy, { machineId: "box", sourcePath: "/Users/me/IdeaProjects/AccordAgents" },
    "the computer that made the copy is told, so it copies it again");

  // A run that started and failed for another reason keeps its own words.
  failure = { content: `@${participant.handle} could not finish because the CLI account hit a usage limit.`, error: "usage limit reached" };
  const limited = await turn("usage-limit");
  assert.match(limited.content, /usage limit/);
  assert.equal(limited.metadata?.missingProjectCopy, undefined);
});

test("chat add paths normalize legacy run location to concrete local or remote", async () => {
  const agents: AgentHealth[] = [{ kind: "codex-cli", label: "Codex CLI", installed: true }];
  const { service, storage, tempRoot } = testService({
    agents,
    settings: { chatRoleConfigs: [ROLE] }
  });

  const created = await service.createConversation({
    title: "Cloud run routing",
    participants: [
      { handle: "legacy", roleConfigId: ROLE.id, kind: "codex-cli" },
      { handle: "inherit", roleConfigId: ROLE.id, kind: "codex-cli", remoteExecution: "inherit" },
      { handle: "remote", roleConfigId: ROLE.id, kind: "codex-cli", remoteExecution: "remote" }
    ]
  });

  // The members asked for (the chat's main session runs here too).
  const createdParticipants = (created.conversation.metadata.participants as ChatParticipant[]).filter((participant) => participant.roleConfigId === ROLE.id);
  assert.deepEqual(createdParticipants.map((participant) => participant.remoteExecution), ["local", "local", "remote"]);

  const conversation = chatConversation([chatParticipant("codex-cli")]);
  storage.current = conversation;
  await service.addParticipant({
    conversationId: conversation.id,
    participant: { handle: "added", roleConfigId: ROLE.id, kind: "codex-cli", remoteExecution: "inherit" }
  });

  const added = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "added");
  assert.equal(added?.remoteExecution, "local");
});

test("run location is editable only before a participant has durable run history", async () => {
  const participant = { ...chatParticipant("codex-cli"), remoteExecution: "local" as const };
  const freshConversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation: freshConversation });

  await service.updateParticipantRuntime({
    conversationId: freshConversation.id,
    participantId: participant.id,
    remoteExecution: "remote"
  });

  assert.equal((storage.current.metadata.participants as ChatParticipant[])[0].remoteExecution, "remote");

  const usedConversation = chatConversation([{ ...participant, remoteExecution: "local" }], {
    participantSessions: [{
      participantId: participant.id,
      sessionId: "",
      roleConfigId: ROLE.id,
      roleConfigVersion: 1,
      roleLabel: ROLE.label,
      roleInstructions: ROLE.instructions,
      updatedAt: NOW
    }]
  });
  storage.current = usedConversation;

  await assert.rejects(
    () => service.updateParticipantRuntime({
      conversationId: usedConversation.id,
      participantId: participant.id,
      remoteExecution: "remote"
    }),
    /Run location is locked/
  );
});

test("the phone's New chat puts a Cloud run member on the instance's machine, with the projects that machine has", { timeout: 10_000 }, async () => {
  // The User, 2026-10-30: a cloud member asked from the phone needs no Mac.
  // The phone starts the chat straight on the member's machine, so the offer
  // names the machine and what projects are there.
  const cloud: ChatParticipantConfig = { id: "saved-remote", handle: "remote-claude", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "claude-code", cloudRun: {}, updatedAt: NOW };
  const homed: ChatParticipantConfig = { id: "saved-homed", handle: "homed", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "codex-cli", homeMachineId: "m-hand", updatedAt: NOW };
  const local: ChatParticipantConfig = { id: "saved-drew", handle: "drew", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "codex-cli", updatedAt: NOW };
  const { service } = testService({ agents: installedChatAgents(),
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [cloud, homed, local], cloudRuns: { awsHandle: { instanceId: "i-cloud" } } as Partial<AppSettings["cloudRuns"]> },
    machines: [{ id: "m-cloud", name: "Cloud run", awsInstanceId: "i-cloud", deviceId: "device-cloud" }, { id: "m-hand", name: "Studio", deviceId: "device-hand" }],
    machineInstalls: [{ machineId: "m-cloud", projects: { "/Users/u/api": "/home/ubuntu/projects/api" } }] });
  const offered = await service.newChatOptions([]);
  assert.ok(offered);
  const remote = offered.members.find((member) => member.configId === cloud.id);
  assert.equal(remote?.unavailable, undefined);
  assert.equal(remote?.machineId, "m-cloud", "the machine on the AWS instance this computer uses");
  assert.equal(remote?.participant.homeMachineId, undefined, "beside the member: a phone from before sends its chat to this computer, which prepares it");
  assert.deepEqual(remote?.projects, ["/Users/u/api"], "only what was copied there");
  const byHand = offered.members.find((member) => member.configId === homed.id);
  assert.equal(byHand?.machineId, "m-hand");
  assert.equal(byHand?.participant.homeMachineId, "m-hand");
  assert.equal(byHand?.projects, undefined, "a machine set up by hand keeps its own folders: any project");
  const here = offered.members.find((member) => member.configId === local.id);
  assert.equal(here?.participant.homeMachineId, undefined);
  assert.equal(here?.projects, undefined);
});

test("a Cloud run member is found as Cloud run finds its machine, and says why when it cannot run there", { timeout: 10_000 }, async () => {
  const preset = (id: string, extra: Partial<ChatParticipantConfig>): ChatParticipantConfig =>
    ({ id, handle: id, roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "claude-code", cloudRun: {}, updatedAt: NOW, ...extra });
  const offer = async (machines: NonNullable<Parameters<typeof testService>[0]>["machines"], installs: NonNullable<Parameters<typeof testService>[0]>["machineInstalls"], configs: ChatParticipantConfig[]) => {
    const { service } = testService({ agents: installedChatAgents(),
      settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: configs, cloudRuns: { awsHandle: { instanceId: "i-now" } } as Partial<AppSettings["cloudRuns"]> },
      machines, machineInstalls: installs });
    return (await service.newChatOptions([]))!.members;
  };
  // Tied to an instance this computer no longer uses: in the computer's words.
  const [old] = await offer([{ id: "m-old", name: "Old", awsInstanceId: "i-old", deviceId: "d-old" }], [], [preset("old", { cloudRun: { instanceId: "i-old" } })]);
  assert.equal(old.machineUnavailable, "This machine belongs to a different AWS instance. Select Cloud run to use the instance currently shown in Settings.");
  assert.equal(old.unavailable, undefined, "a phone from before still hands it to this computer, which prepares it");
  // A machine record without the instance: the setup that put the program there names it.
  const [byAlias] = await offer([{ id: "m-now", name: "Cloud run", deviceId: "d-now" }], [{ machineId: "m-now", target: { hostKeyAlias: "accordagents-i-now" } }], [preset("alias", {})]);
  assert.equal(byAlias.machineId, "m-now");
  assert.equal(byAlias.unavailable, undefined);
  // What the machine last said of its CLIs can be stale (a probe that timed
  // out at boot, a CLI installed since): it does not hold the member back.
  const [staleHello] = await offer([{ id: "m-now", name: "Cloud run", awsInstanceId: "i-now", deviceId: "d-now", lastHello: { providers: [{ kind: "claude-code", installed: false }] } }], [], [preset("stale", {})]);
  assert.equal(staleHello.machineId, "m-now");
  assert.equal(staleHello.machineUnavailable, undefined);
});

test("a member whose machine is not one of the server's devices says so instead of waiting unanswered", { timeout: 10_000 }, async () => {
  const homed: ChatParticipantConfig = { id: "saved-homed", handle: "homed", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "codex-cli", homeMachineId: "m-old", updatedAt: NOW };
  const { service } = testService({ agents: installedChatAgents(), settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [homed] },
    machines: [{ id: "m-old", name: "Old box" }] });
  const offered = await service.newChatOptions([]);
  assert.equal(offered?.members.find((member) => member.configId === homed.id)?.machineUnavailable,
    "Its machine is not connected to your server yet. Open Settings → Machines on your computer.");
});

test("with no cloud machine set up, a Cloud run member is offered and says why it cannot join from the phone", { timeout: 10_000 }, async () => {
  const cloud: ChatParticipantConfig = { id: "saved-remote", handle: "remote-claude", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "claude-code", cloudRun: {}, updatedAt: NOW };
  const { service } = testService({ agents: installedChatAgents(), settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [cloud] } });
  const offered = await service.newChatOptions([]);
  const remote = offered?.members.find((member) => member.configId === cloud.id);
  assert.equal(remote?.machineUnavailable, "Its cloud machine is not set up yet. Set it up in Settings → AWS on your computer.");
  assert.equal(remote?.unavailable, undefined);
  assert.ok(remote?.participant.cloudRun, "shown as a Cloud run member");
});

test("new cloud chat saves every Cloud choice without waiting for project preparation", { timeout: 10_000 }, async () => {
  const { service, storage } = testService({ agents: installedChatAgents() });
  service.setMachineProjectPreparation(async () => { assert.fail("chat creation must not wait for a project copy"); });
  service.setCloudRunPreparation(async () => { assert.fail("chat creation must not wait for AWS"); });
  const result = await service.createConversation({ title: "hello", repoPath: "/test/project",
    participants: [
      { kind: "codex-cli", handle: "cloud-one", roleConfigId: ROLE.id, cloudRun: {} },
      { kind: "claude-code", handle: "cloud-two", roleConfigId: ROLE.id, cloudRun: { instanceId: "i-test" } }
    ] });
  assert.equal(storage.current.id, result.conversation.id);
  const members = storage.current.metadata.participants.filter((item: ChatParticipant) => item.handle.startsWith("cloud-"));
  assert.deepEqual(members.map((item: ChatParticipant) => item.cloudRun), [{}, { instanceId: "i-test" }]);
  assert.ok(members.every((item: ChatParticipant) => !item.homeMachineId));
});

test("Cloud selection persists independently of setup and existing session location stays locked", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = { ...chatConversation([participant]), repoPath: "/Users/test/project" };
  const { service, storage } = testService({ conversation });
  service.setMachineProjectPreparation(async () => { assert.fail("selection must not copy a project"); });
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: participant.id, cloudRun: {} });
  assert.deepEqual(storage.current.metadata.participants[0].cloudRun, {});
  assert.equal(storage.current.metadata.participants[0].homeMachineId, undefined);
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: participant.id, cloudRun: undefined });
  assert.equal(storage.current.metadata.participants[0].cloudRun, undefined);
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: participant.id, homeMachineId: "cloud" });
  assert.equal(storage.current.metadata.participants[0].homeMachineId, "cloud");
  storage.current.metadata.participantSessions = [{ participantId: participant.id, sessionId: "native-session", updatedAt: NOW }];
  await assert.rejects(service.updateParticipantRuntime({ conversationId: conversation.id, participantId: participant.id, homeMachineId: "other" }), /machine is locked/);
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: participant.id, model: "another-model" });
  assert.equal(storage.current.metadata.participants[0].homeMachineId, "cloud");
});

test("several Cloud choices do not block a local member, and Stop prevents a delayed cloud start", { timeout: 15_000 }, async () => {
  const one = { ...chatParticipant("codex-cli"), id: "cloud-one", handle: "cloud-one" };
  const two = { ...chatParticipant("claude-code"), id: "cloud-two", handle: "cloud-two" };
  const local = { ...chatParticipant("codex-cli"), id: "local", handle: "local" };
  const conversation = chatConversation([one, two, local]);
  const localCalls: string[] = [];
  const h = testService({ conversation, run: async participant => {
    localCalls.push(participant.id);
    return { participant, ok: true, content: "LOCAL_REPLY", durationMs: 1 };
  } });
  chatParts(h.service).chatHistory.ensureHistoryFiles = async () => h.tempRoot;
  await Promise.all([one, two].map(member => h.service.updateParticipantRuntime({
    conversationId: conversation.id, participantId: member.id, cloudRun: {}
  })));
  assert.deepEqual(h.storage.current.metadata.participants.slice(0, 2).map((item: ChatParticipant) => item.cloudRun), [{}, {}]);
  let finish!: (id: string) => void;
  const setup = new Promise<string>(resolve => { finish = resolve; });
  const prepared: string[] = [];
  h.service.setCloudRunPreparation(async (_selection, provider, progress) => {
    prepared.push(provider);
    progress({ operationId: "prep", message: "Waiting for cloud login" });
    return setup;
  });
  const link = fakeServerLink();
  h.service.setServerLink(link);
  const asked = () => link.ops.filter((op) => op.kind === "turn.request");
  await h.service.sendMessage({ conversationId: conversation.id, content: "@local hello" });
  await waitFor(() => localCalls.length === 1);
  assert.deepEqual(prepared, []);
  await h.service.sendMessage({ conversationId: conversation.id, content: "@cloud-one hello" });
  await waitFor(() => h.storage.current.messages.some((item: ChatMessage) => item.metadata?.cloudRunPreparation?.message === "Waiting for cloud login"));
  const sent = h.storage.current.messages.find((item: ChatMessage) => item.role === "user" && item.content === "@cloud-one hello");
  assert.deepEqual(sent.metadata.deliveryTargets, [], "the server is not asked for a member whose machine is not ready yet");
  assert.deepEqual(sent.metadata.askedParticipantIds, [one.id], "but the message says it asks that member, so its watch does not wake it too");
  await h.service.sendMessage({ conversationId: conversation.id, content: "@local still available" });
  await waitFor(() => localCalls.length === 2);
  const pending = h.storage.current.messages.find((item: ChatMessage) => item.participantId === one.id && item.status === "pending");
  assert.equal(h.service.cancelRun(pending.metadata.runId), true);
  // Stopped while its machine was being made ready: it says so at once, as a
  // local member stopped before it started does.
  await waitFor(() => h.storage.current.messages.some((item: ChatMessage) => item.role === "system" && item.content === "@cloud-one stopped by user."));
  await waitFor(() => !h.storage.current.messages.some((item: ChatMessage) => item.id === pending.id));
  assert.ok(link.ops.some((op) => op.kind === "turn.stop" && op.runId === pending.metadata.runId), "stopped on the server too, so nothing ever starts it");
  finish("cloud-machine");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(asked(), [], "never asked of a machine");
  assert.deepEqual(prepared, ["codex-cli"]);
  assert.deepEqual(h.storage.current.metadata.participants[0].cloudRun, {});
});

test("a saved Cloud choice survives setup failure and restart, and only the addressed member runs", { timeout: 15_000 }, async () => {
  const one = { ...chatParticipant("codex-cli"), id: "cloud-one", handle: "cloud-one", cloudRun: {} };
  const two = { ...chatParticipant("claude-code"), id: "cloud-two", handle: "cloud-two", cloudRun: {} };
  const first = testService({ conversation: chatConversation([one, two]) });
  const firstLink = fakeServerLink();
  first.service.setServerLink(firstLink);
  first.service.setCloudRunPreparation(async () => { throw new Error("AWS unavailable"); });
  await first.service.sendMessage({ conversationId: first.storage.current.id, content: "@cloud-one hello" });
  await waitFor(() => first.storage.current.messages.some((item: ChatMessage) => item.content.includes("AWS unavailable")));
  assert.equal(firstLink.ops.some((op) => op.kind === "turn.request"), false, "never asked of a machine before one is ready");
  assert.deepEqual(first.storage.current.metadata.participants[0].cloudRun, {});
  const next = testService({ conversation: first.storage.current });
  const link = fakeServerLink();
  next.service.setServerLink(link);
  const prepared: string[] = [];
  next.service.setCloudRunPreparation(async (_selection, provider) => { prepared.push(provider); return "cloud-machine"; });
  const asked = () => link.ops.filter((op): op is Extract<HubOp, { kind: "turn.request" }> => op.kind === "turn.request");
  await next.service.sendMessage({ conversationId: next.storage.current.id, content: "@cloud-two hello" });
  await waitFor(() => asked().length === 1);
  assert.equal(asked()[0].participantId, two.id);
  assert.equal(next.storage.current.metadata.participants[1].homeMachineId, "cloud-machine", "named before its turn is asked of it");
  await memberDeviceAnswers(next.service, asked()[0], { participant: two, content: "CLOUD_REPLY" });
  await waitFor(() => next.storage.current.messages.some((item: ChatMessage) => item.content === "CLOUD_REPLY"));
  assert.deepEqual(prepared, ["claude-code"]);
  assert.equal(next.storage.current.metadata.participants[0].homeMachineId, undefined);
  next.service.setCloudRunPreparation(async () => { assert.fail("a started member keeps its assigned machine without preparing the current AWS selection again"); });
  await next.service.sendMessage({ conversationId: next.storage.current.id, content: "@cloud-two continue" });
  await waitFor(() => asked().length === 2);
  assert.deepEqual(asked().map((op) => op.participantId), [two.id, two.id]);
  await memberDeviceAnswers(next.service, asked()[1], { participant: two, content: "CLOUD_AGAIN" });
  await waitFor(() => !next.storage.current.metadata.running && next.storage.current.messages.some((item: ChatMessage) => item.content === "CLOUD_AGAIN"));
});

test("a machine member's context use after its turn is shown here as a local member's is", async () => {
  const member = { ...chatParticipant("claude-code"), id: "machine-member", handle: "remote", homeMachineId: "box" };
  const h = testService({ conversation: chatConversation([member]) });
  const usage = { usedTokens: 4200, contextWindowTokens: 200000, percentage: 2, source: "claude-code", updatedAt: "2026-10-22T00:00:00.000Z" };
  const link = fakeServerLink();
  h.service.setServerLink(link);
  await h.service.sendMessage({ conversationId: h.storage.current.id, content: "@remote hello" });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  const request = link.ops.find((op): op is Extract<HubOp, { kind: "turn.request" }> => op.kind === "turn.request")!;
  // The machine ends the turn with what its CLI said of the member's context.
  await memberDeviceAnswers(h.service, request, { participant: member, content: "MACHINE_REPLY", contextUsage: usage });
  await waitFor(() => h.storage.current.messages.some((item: ChatMessage) => item.content === "MACHINE_REPLY"));
  await waitFor(() => h.storage.current.metadata.agentContextUsageByParticipant?.[member.id]?.usedTokens === 4200);
});

test("a member the main session made, held below Full Access, is asked of an older machine: it runs there as its controls say", async () => {
  const own = { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true as const };
  const main = { ...chatParticipant("codex-cli"), id: "main", handle: "main", roleConfigId: "main-session", agentMode: "default" as const, permissions: own };
  const held = { ...chatParticipant("codex-cli"), id: "held", handle: "held", homeMachineId: "box", delegatedByParticipantId: "main", agentMode: "full-access" as const, permissions: own };
  const h = testService({ conversation: chatConversation([main, held], { mainSessionParticipantId: "main" }) });
  h.service.setMachineCliModesSupport(() => "outdated");
  const link = fakeServerLink("desktop-device", { box: "Cloud box" });
  h.service.setServerLink(link);
  await h.service.sendMessage({ conversationId: h.storage.current.id, content: "@held hello", targetParticipantIds: ["held"] });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request" && op.participantId === held.id));
});

test("a Cloud run member's Full Access is refused once its machine turns out to run an older program", async () => {
  const own = { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true as const };
  const member = { ...chatParticipant("codex-cli"), id: "cloud-fa", handle: "cloudfa", cloudRun: {}, agentMode: "full-access" as const, permissions: own };
  const h = testService({ conversation: chatConversation([member]) });
  h.service.setMachineCliModesSupport((machineId) => machineId === "old-box" ? "outdated" : "unknown");
  h.service.setCloudRunPreparation(async () => "old-box");
  const link = fakeServerLink("desktop-device", { "old-box": "Old box" });
  h.service.setServerLink(link);
  await h.service.sendMessage({ conversationId: h.storage.current.id, content: "@cloudfa hello" });
  await waitFor(() => h.storage.current.messages.some((item: ChatMessage) => item.participantId === member.id && item.status === "error"));
  const refused = h.storage.current.messages.find((item: ChatMessage) => item.participantId === member.id && item.status === "error");
  assert.match(`${refused.content} ${refused.metadata?.error ?? ""}`, /Old box runs an older program that cannot run Full Access/);
  assert.equal(link.ops.some((op) => op.kind === "turn.request"), false, "never asked of that machine");
});

test("the phone's New chat offers the main session as Settings → General → New chats starts it: model, effort, mode and machine for its CLI", { timeout: 10_000 }, async () => {
  const agents = installedChatAgents();
  const newChatDefaults = { kind: "claude-code" as const, model: "claude-opus-5-5", reasoningEffort: "high" as const, access: "acceptEdits", homeMachineId: "m-hand", compactWithoutAsking: true };
  const { service } = testService({ agents, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], assistantProviderKind: "claude-code", newChatDefaults },
    machines: [{ id: "m-hand", name: "Studio", deviceId: "device-hand" }] });
  const offered = (await service.newChatOptions([]))!.mainSession!;
  assert.deepEqual([offered.kind, offered.model, offered.reasoningEffort, offered.agentMode, offered.homeMachineId], ["claude-code", "claude-opus-5-5", "high", "default", "m-hand"]);
  assert.deepEqual([offered.permissions?.cliApprovals, offered.permissions?.workspaceWrite], [true, true], "Claude Code's Accept edits");
  assert.deepEqual([offered.permissions?.requestParticipants, offered.permissions?.manageRolesParticipants], ["allow", undefined],
    "it asks members without a card, and adds them as its role always lets it (inherited)");

  // Chosen for another CLI than new chats run on: that CLI's own; a machine
  // no longer set up: this computer.
  const other = testService({ agents, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], assistantProviderKind: "codex-cli", newChatDefaults: { ...newChatDefaults, homeMachineId: "m-gone" } },
    machines: [{ id: "m-hand", name: "Studio", deviceId: "device-hand" }] });
  const codex = (await other.service.newChatOptions([]))!.mainSession!;
  assert.deepEqual([codex.kind, codex.model, codex.reasoningEffort, codex.agentMode, codex.homeMachineId, codex.permissions?.cliApprovals],
    ["codex-cli", undefined, undefined, "default", undefined, undefined]);
  assert.equal(codex.permissions?.requestCompaction, "allow");
});

test("on a machine, removing or losing one of its own members closes that member's process there, and no one else's", async () => {
  const closed: string[] = [];
  const { service, storage } = memberRemovalFixture();
  service.setHostMachineId("machine");
  chatDependencies(service).cliRunner.closeWarmAgents = async (_conversationId: string, participantId: string, reason: string) => {
    closed.push(`${participantId}:${reason}`);
  };
  const ownA = { ...chatParticipant("claude-code"), id: "own-a", handle: "owna", homeMachineId: "machine" };
  const ownB = { ...chatParticipant("claude-code"), id: "own-b", handle: "ownb", homeMachineId: "machine" };
  const elsewhere = { ...chatParticipant("claude-code"), id: "elsewhere", handle: "elsewhere", homeMachineId: "other-machine" };
  storage.current.metadata.participants = [...storage.current.metadata.participants, ownA, ownB, elsewhere];

  // Applied here (an approved request of a member on this machine).
  await service.removeParticipant({ conversationId: "conversation-1", participantId: ownA.id });
  await waitFor(() => closed.length === 1);
  assert.deepEqual(closed, ["own-a:member-removed"]);

  // The desktop removed members; this machine learns it from the member list.
  await service.applyReplicatedConversation("conversation-1", (previous) => previous && ({
    ...previous,
    metadata: {
      ...previous.metadata,
      participants: (previous.metadata.participants as ChatParticipant[]).filter((participant) =>
        participant.id !== ownB.id && participant.id !== elsewhere.id && participant.id !== "target-participant")
    }
  }));
  await waitFor(() => closed.length === 2);
  await new Promise((resolve) => setImmediate(resolve));
  // The desktop-local member and another machine's member have no process here.
  assert.deepEqual(closed, ["own-a:member-removed", "own-b:member-removed"]);
});

test("recoverStaleChatRun leaves a pending bubble of a machine-hosted member alone", () => {
  // A member whose home is a machine runs there; a resume the machine started
  // itself (after an approval) has a run id this desktop never registered.
  const participant = { ...chatParticipant("claude-code"), homeMachineId: "machine-1" };
  const conversation = chatConversation([participant]);
  conversation.messages.push(pendingParticipantMessage(participant, "pending-machine", "machine-run"));
  const { service } = testService({ conversation });

  const changed = chatParts(service).runOwners.recoverStaleChatRun(conversation);

  assert.equal(changed, false);
  const pending = conversation.messages.find((message: any) => message.id === "pending-machine")!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.metadata?.staleRunRecovery, undefined);
});

test("Cloud preparation interrupted by a restart is recovered even after its machine was assigned", () => {
  for (const homeMachineId of [undefined, "machine-1"]) {
    const participant = { ...chatParticipant("codex-cli"), cloudRun: {}, homeMachineId };
    const conversation = chatConversation([participant]);
    const pending = pendingParticipantMessage(participant, "preparing", "cloud-preparation");
    pending.metadata = { ...pending.metadata, cloudRunPreparation: { operationId: "setup", message: "Preparing project" } };
    conversation.messages.push(pending);
    const { service } = testService({ conversation });
    assert.equal(chatParts(service).runOwners.recoverStaleChatRun(conversation), true);
    assert.equal(pending.status, "error");
    assert.match(pending.content, /Interrupted/);
  }
});

test("inside a machine runtime its own members' bubbles are swept like local ones, other machines' are not", () => {
  const own = { ...chatParticipant("claude-code"), id: "own", handle: "own", homeMachineId: "machine-1" };
  const other = { ...chatParticipant("claude-code"), id: "other", handle: "other", homeMachineId: "machine-2" };
  const conversation = chatConversation([own, other]);
  conversation.messages.push(pendingParticipantMessage(own, "pending-own", "run-own"));
  conversation.messages.push(pendingParticipantMessage(other, "pending-other", "run-other"));
  const { service } = testService({ conversation });
  service.setHostMachineId("machine-1");

  chatParts(service).runOwners.recoverStaleChatRun(conversation);

  assert.equal(conversation.messages.find((message: any) => message.id === "pending-own")!.status, "error");
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-other")!.status, "pending");
});

test("Stop routes a machine member's run this desktop does not run to the server, and keeps its text while waiting", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1" };
  const conversation = chatConversation([participant]);
  const pending = pendingParticipantMessage(participant, "pending-native-resume", "turn-native-resume", { metadata: { runId: "turn-native-resume", sourceMessageId: "user-message" } });
  pending.content = "Already streamed text";
  conversation.messages.push(pending);
  const { service, storage } = testService({ conversation });
  const link = fakeServerLink();
  service.setServerLink(link);
  assert.equal(await chatParts(service).runCancel.cancelStoredRun("turn-native-resume"), true);
  await chatParts(service).store.waitForQueuedSave(conversation.id);
  assert.deepEqual(link.ops.filter((op) => op.kind === "turn.stop").map((op) => [op.conversationId, (op as { runId: string }).runId, (op as { messageId: string }).messageId, (op as { participantId: string }).participantId]),
    [[conversation.id, "turn-native-resume", "user-message", participant.id]]);
  const stored = storage.current.messages.find((message: ChatMessage) => message.id === pending.id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.content, pending.content);
  assert.equal(stored.metadata.stopPending.machineName, "Cloud machine", "waiting until the machine confirms");
  assert.equal(stored.metadata.staleRunRecovery, undefined);
  // The machine confirms: the waiting goes.
  await service.applyServerEntries([fromServer(conversation.id, "machine-device", { kind: "turn.finish",
    turn: { runId: "turn-native-resume", conversationId: conversation.id, messageId: "user-message", participantId: participant.id, state: "finished", outcome: "stopped", executorDeviceId: "machine-device" } })]);
  await waitFor(() => !storage.current.messages.find((message: ChatMessage) => message.id === pending.id)?.metadata?.stopPending);
});

test("a member still marked for the old cloud worker refuses to run here, and says why", async () => {
  // Its machine is the User's choice. Running it on this computer because the
  // transport it was set up for is gone would be deciding for her.
  const participant = { ...chatParticipant("codex-cli"), remoteExecution: "remote" as const };
  const conversation = chatConversation([participant]);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [{ kind: "codex-cli", label: "Codex CLI", installed: true }],
    run: async (config) => {
      runs.push(config);
      return { participant: config, ok: true, content: "ran locally", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, runId: "unassigned-run", content: `@${participant.handle} please look` });
  await waitFor(() => (storage.current.messages as ChatMessage[]).some((message) => message.role === "participant" && message.status === "error"));
  await chatParts(service).store.waitForQueuedSave(conversation.id);

  assert.deepEqual(runs, [], "it must not quietly run on this computer");
  const reply = (storage.current.messages as ChatMessage[])
    .filter((message) => message.role === "participant")
    .at(-1);
  assert.equal(reply?.status, "error");
  assert.match(reply?.content ?? "", /has no machine to run on yet/);
  assert.match(reply?.content ?? "", /Choose its machine in the member settings/);
  // The marker is not rewritten: the member still reads as one that needs a machine.
  const stored = (storage.current.metadata.participants as ChatParticipant[])[0];
  assert.equal(stored.remoteExecution, "remote");
});

test("a run left behind by the removed cloud transport is finished, with its text kept", () => {
  // Nothing will ever report on it again, so leaving it spinning would be a
  // lie. What it managed to say before the cutover is preserved.
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    activeRunIds: ["cloud-run", "local-run"],
    runId: "cloud-run",
    running: true,
    remoteRunHandles: {
      "cloud-run": {
        runId: "cloud-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    },
    activeRunOwnersByRunId: {
      "local-run": {
        processId: process.pid,
        startedAt: NOW,
        updatedAt: NOW
      }
    },
    activeRunParticipantIdsByRunId: {
      "local-run": participant.id
    }
  });
  const cloudBubble = pendingParticipantMessage(participant, "pending-cloud", "cloud-run");
  cloudBubble.content = "Partial answer from the worker";
  conversation.messages.push(cloudBubble);
  conversation.messages.push(pendingParticipantMessage(participant, "pending-local", "local-run"));
  const { service } = testService({ conversation });

  const changed = chatParts(service).runOwners.recoverStaleChatRun(conversation);

  assert.equal(changed, true);
  const recovered = conversation.messages.find((message: any) => message.id === "pending-cloud")!;
  assert.equal(recovered.status, "error");
  assert.match(recovered.content, /Partial answer from the worker/);
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-local")!.status, "error");
  // The record of the run itself is left where it is: old runs stay readable.
  assert.ok((conversation.metadata.remoteRunHandles as Record<string, unknown>)["cloud-run"]);
});

test("a member on a machine asks a member that lives elsewhere through the server, and the answer comes back to it", async () => {
  // Requester lives on this machine; the target lives on the desktop.
  const requester = { ...chatParticipant("codex-cli", { requestParticipants: "allow" }), id: "here", handle: "here", homeMachineId: "machine-1" };
  const target = { ...chatParticipant("claude-code"), id: "elsewhere", handle: "elsewhere" };
  const conversation = chatConversation([requester, target]);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (participant) => { runs.push(participant); return { participant, ok: true, content: "ran here", durationMs: 1 }; }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  service.setHostMachineId("machine-1");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);
  const asking = service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: "Please review." }],
    timeoutMs: 5000,
    resumeRequester: false
  });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  const request = link.ops.find((op): op is Extract<HubOp, { kind: "turn.request" }> => op.kind === "turn.request")!;
  const requestMessage = storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest);
  assert.equal(request.participantId, target.id, "asked of the member that lives elsewhere");
  assert.equal(request.messageId, requestMessage.id, "the turn answers the request message, which keeps its thread");
  assert.ok(request.pendingMessageId, "named the bubble its reply takes");
  await memberDeviceAnswers(service, request, { participant: target, content: "Answered on the desktop.", deviceId: "desktop-device" });
  const result = await asking;
  assert.equal(result.ok, true);
  assert.deepEqual(runs, [], "a machine must not run a member that is not its own");
  const items = (result as any).batch.items as Array<{ target: string; status: string; reply?: string }>;
  assert.equal(items[0].status, "answered");
  assert.equal(items[0].reply, "Answered on the desktop.", "the answer is returned to the member that asked");
  assert.equal(link.ops.filter((op) => op.kind === "turn.request").length, 1, "one request, one turn");
});

test("a member's choice moved as this computer's but asked by a member of a machine is not raised here", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine-gone" };
  const conversation = chatConversation([participant]);
  conversation.metadata.pendingAppToolApprovals = [];
  conversation.messages.push({
    id: "machine-choice", role: "participant", participantId: participant.id, participantLabel: `@${participant.handle}`, content: "Which one?",
    createdAt: new Date().toISOString(), status: "done",
    // The machine was no longer on the server's devices when the chats
    // moved: the server took the message as this computer's.
    metadata: { serverWriter: "this-computer", serverSeq: 0, pendingChoice: { id: "choice-1", title: "Pick", question: "Which one?", status: "pending",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } }
  } as ChatMessage);
  const { service } = testService({ conversation });
  chatParts(service).serverLink.current = { deviceId: () => "this-computer" };
  const wanted = () => (chatParts(service).serverCards.wantedServerCards(conversation) as Array<{ cardId: string }>).map((card) => card.cardId);
  assert.deepEqual(wanted(), [], "its member does not run here: the server would refuse it every start");
  service.setHostMachineId("machine-gone");
  chatParts(service).serverLink.current = { deviceId: () => "the-machine" };
  assert.deepEqual(wanted(), [], "nor on a machine whose own messages are another device's");
});

test("a machine member's card answered on the server waits on the desktop for its machine, and closes with the machine's outcome", async () => {
  const participant = { ...chatParticipant("codex-cli", { webAccess: false }), homeMachineId: "machine" };
  const approval = permissionApproval(participant, { kind: "portable", permissions: ["webAccess"] });
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const card = { ...machineCard(approval), cardKind: "permission" as const };
  await feedCard(service, "card.raise", card);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
  const answer = answeredCard(card, { approve: true });
  await feedCard(service, "card.answer", answer, "decision");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].machineDecisionPending.decisionId, "decision");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].machineDecisionPending.approve, true);
  // Nothing of it changed here: the machine applies it.
  assert.equal(normalizeChatAgentPermissions(storage.current.metadata.participants[0].permissions).webAccess, false);
  await feedCard(service, "card.settle", { ...answer, state: "settled", outcome: { result: "applied", approval: { ...approval, status: "approved", updatedAt: new Date(Date.now() + 1000).toISOString() } } });
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].machineDecisionPending, undefined);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
});

test("a machine member's card whose answer its machine refused is asked again on the desktop, saying why", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine" };
  const approval = permissionApproval(participant, { kind: "portable", permissions: ["webAccess"] });
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const card = { ...machineCard(approval), cardKind: "permission" as const };
  await feedCard(service, "card.raise", card);
  const answer = answeredCard(card, { approve: true });
  await feedCard(service, "card.answer", answer, "fast");
  await feedCard(service, "card.settle", { ...answer, state: "settled", outcome: { result: "refused", reason: "Invalid decision", answerOpId: "fast" } });
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].machineDecisionPending, undefined);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
  const refusals = [{ operationId: "fast", reason: "Invalid decision", at: NOW }];
  await feedCard(service, "card.raise", { ...card, card: { ...card.card, refusals } });
  assert.deepEqual(storage.current.metadata.pendingAppToolApprovals[0].cardRefusals, refusals, "the card says why");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
});

test("a machine's member does not name a chat from another device's first message, no more than before", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1" };
  const conversation = chatConversation([participant]);
  conversation.messages[0].metadata = { threadId: "user-message", deliveryTargets: [participant.id] } as any;
  const prompts: string[] = [];
  const { service, storage, tempRoot } = testService({ conversation, run: async (member, prompt) => {
    prompts.push(String(prompt));
    return { participant: member, ok: true, content: "Answer", durationMs: 1 };
  } });
  service.setHostMachineId("machine-1");
  service.setServerLink(fakeServerLink("machine-device"));
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.startServerTurn({ runId: hubTurnRunId("user-message", participant.id), conversationId: conversation.id, messageId: "user-message", participantId: participant.id, state: "requested" });
  await waitFor(() => prompts.length === 1);
  assert.doesNotMatch(prompts[0], /app_chat_set_title/);
  assert.equal(storage.current.metadata.autoTitleEligibility, undefined);
});

test("member ownership: without a link to the User's server a machine member cannot fall back to the desktop CLI", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1" };
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation, run: async () => { throw new Error("must not run native"); } });
  await assert.rejects(chatParts(service).turnQueue.runParticipantTurnSerialized(conversation, participant,
    conversation.messages[0], "remote-run", undefined, undefined, { warnings: [] }), /reaches only through your server/);
  assert.equal(storage.current.metadata.participantSessions, undefined);
});

test("member ownership: stale-run recovery leaves a desktop member pending on a machine", () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], { activeRunIds: ["desktop-run"], running: true });
  conversation.messages.push(pendingParticipantMessage(participant, "desktop-pending", "desktop-run"));
  const { service } = testService({ conversation });
  service.setHostMachineId("machine-1");
  chatParts(service).runOwners.recoverStaleChatRun(conversation);
  assert.equal(conversation.messages.find(m => m.id === "desktop-pending")!.status, "pending");
});

test("Stop reaches the machine through the server when this desktop holds a pending row for the run", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine" };
  const conversation = chatConversation([participant], { activeRunIds: ["turn-run-on-machine"] });
  conversation.messages.push({
    id: "machine-bubble", role: "participant", participantId: participant.id, content: "",
    status: "pending", createdAt: NOW, metadata: { runId: "turn-run-on-machine", sourceMessageId: "user-message" }
  } as any);
  const { service } = testService({ conversation });
  const link = fakeServerLink();
  service.setServerLink(link);
  assert.equal(service.cancelRun("turn-run-on-machine"), true);
  await waitFor(() => link.ops.some((op) => op.kind === "turn.stop"), 2000);
  assert.deepEqual(link.ops.filter((op) => op.kind === "turn.stop").map((op) => [(op as { runId: string }).runId, (op as { participantId: string }).participantId]),
    [["turn-run-on-machine", participant.id]]);
});

test("Stop still reaches the machine when this desktop has no pending row for the run", async () => {
  // The defect: cancelStoredRun published machine.turn.cancel only when this
  // copy happened to hold a pending participant row for the run. A run the
  // machine has started but whose row has not been replicated here yet -- or
  // whose row this copy has already settled -- was therefore never cancelled
  // on the machine, while cancelRun reported success to the User all the same.
  // The machine owns the run; a missing row here is not evidence it stopped.
  // With the User's server the run is named by the turn mark the message it
  // answers keeps.
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine" };
  const conversation = chatConversation([participant], { activeRunIds: ["turn-run-on-machine"] });
  conversation.messages[0].metadata = { ...conversation.messages[0].metadata,
    serverTurns: { [participant.id]: { runId: "turn-run-on-machine", state: "claimed", executorDeviceId: "machine-device" } } } as any;
  const { service } = testService({ conversation });
  const link = fakeServerLink();
  service.setServerLink(link);
  assert.equal(service.cancelRun("turn-run-on-machine"), true);
  await waitFor(() => link.ops.some((op) => op.kind === "turn.stop"), 2000);
  assert.deepEqual(link.ops.filter((op) => op.kind === "turn.stop").map((op) => [(op as { runId: string }).runId, (op as { messageId: string }).messageId]),
    [["turn-run-on-machine", "user-message"]], "a Stop for a machine-hosted run must reach that machine");
});

test("Stop for a local member's run stays local even when the chat also has a machine member", async () => {
  // The single-machine fallback exists for a run this copy cannot attribute
  // at all. A row that names a local member settles the question: routing its
  // Stop to the machine would send a cancel for a run the machine never had
  // and leave the local row pending for ever.
  const local = chatParticipant("codex-cli");
  const remote = { ...chatParticipant("codex-cli"), id: "remote-member", handle: "remote", homeMachineId: "machine" };
  const conversation = chatConversation([local, remote], { activeRunIds: ["run-local"] });
  conversation.messages.push({
    id: "local-bubble", role: "participant", participantId: local.id, content: "",
    status: "pending", createdAt: NOW, metadata: { runId: "run-local" }
  } as any);
  const { service, storage } = testService({ conversation });
  const link = fakeServerLink();
  service.setServerLink(link);
  assert.equal(service.cancelRun("run-local"), true);
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.id === "local-bubble" && message.metadata?.terminalReason === "user-stopped"));
  assert.equal(storage.current.messages.find((message: ChatMessage) => message.id === "local-bubble")?.metadata?.terminalReason, "user-stopped",
    "the local run is swept here");
  assert.equal(link.ops.some((op) => op.kind === "turn.stop"), false, "no Stop is asked of a machine that does not own the run");
});
