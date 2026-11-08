import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatParticipant, ChatParticipantSession, ChatRoleConfig, Conversation } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import type { DeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import type { HubFeedEntry, HubOp, HubOpEffect, HubTurn } from "../../shared/hubOps";
import type { ChatSessionHandoff } from "../../shared/memberSessionMove";
import { ChatService } from "./chat";
import type { ChatServerLink } from "./chatServerOps";
import { blobReferenceOf, HubHttpError } from "./hubClient";
import {
  claudeProjectFolderName,
  findClaudeTranscript,
  packMemberSession,
  placeClaudeTranscript,
  portableMemberSession,
  unpackMemberSession
} from "./memberSessionFiles";

const NOW = "2026-01-01T00:00:00.000Z";
const ROLE: ChatRoleConfig = { id: "engineer", label: "Engineer", instructions: "Answer directly.", version: 1, updatedAt: NOW };
const TRANSCRIPT = Buffer.from("{\"type\":\"user\",\"message\":\"remember PELICAN-42\"}\n{\"type\":\"assistant\",\"message\":\"OK\"}\n", "utf8");

// --- the session on disk and on the server -------------------------------------

test("a packed session comes back whole, and nothing else passes for one", async () => {
  const session = chatSession(chatParticipant(), "sess-1");
  const packed = await packMemberSession(portableMemberSession({ ...session, importedHandoff: "x", remoteSession: { id: "legacy" } as never }), TRANSCRIPT);
  assert.equal(packed[0], 0x1f, "gzipped: a long session is tens of megabytes");
  const unpacked = await unpackMemberSession(packed);
  assert.equal(unpacked.session.sessionId, "sess-1");
  assert.equal(unpacked.session.lastSyncedMessageId, "m-9", "the member's next prompt picks up where it left off");
  assert.equal((unpacked.session as ChatParticipantSession).importedHandoff, undefined, "what only the device it left means stays there");
  assert.equal((unpacked.session as ChatParticipantSession).remoteSession, undefined);
  assert.deepEqual(unpacked.transcript, TRANSCRIPT);
  await assert.rejects(unpackMemberSession(TRANSCRIPT), /not one this app packed/);
  await assert.rejects(unpackMemberSession(gzipSync(Buffer.concat([Buffer.from(`${JSON.stringify({ format: "accordagents.member-session", version: 1, provider: "claude-code", session: { sessionId: "sess-1" }, transcriptBytes: 99 })}\n`), TRANSCRIPT]))),
    /arrived incomplete/);
  const foreign = gzipSync(Buffer.from(`${JSON.stringify({ format: "accordagents.member-session", version: 1, provider: "claude-code", session: { sessionId: "../../etc" }, transcriptBytes: 0 })}\n`));
  await assert.rejects(unpackMemberSession(foreign), /names no session/, "a session id never leaves its folder");
});

test("a session goes where Claude Code looks for it in the folder its member runs in", async () => {
  assert.equal(claudeProjectFolderName("/home/ubuntu/ws/mirrors/My.App-1/repo"), "-home-ubuntu-ws-mirrors-My-App-1-repo");
  assert.equal(claudeProjectFolderName(`/x/${"y".repeat(220)}`), undefined, "the CLI shortens long ones with a hash of its own");
  const projects = await tempDir();
  const placed = await placeClaudeTranscript(projects, "/Users/me/proj", "sess-1", TRANSCRIPT);
  assert.equal(placed, path.join(projects, "-Users-me-proj", "sess-1.jsonl"));
  assert.deepEqual(await readFile(placed), TRANSCRIPT);
  const longCwd = `/x/${"y".repeat(220)}`;
  await assert.rejects(placeClaudeTranscript(projects, longCwd, "sess-2", TRANSCRIPT), /path too long/);
  const longFolder = `${longCwd.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-ab12cd`;
  await mkdir(path.join(projects, longFolder));
  assert.equal(await placeClaudeTranscript(projects, longCwd, "sess-2", TRANSCRIPT), path.join(projects, longFolder, "sess-2.jsonl"), "the folder the CLI made for it");
  const older = path.join(projects, "-old", "sess-1.jsonl");
  await mkdir(path.dirname(older));
  await writeFile(older, "old");
  await utimes(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.equal(await findClaudeTranscript(projects, "sess-1"), placed, "the newest copy");
  assert.equal(await findClaudeTranscript(projects, "missing"), undefined);
});

// --- leaving this computer -----------------------------------------------------

test("a Claude member that ran here moves to a machine with its session: put on the server, named on the member, gone from here", async () => {
  const participant = chatParticipant();
  const conversation = withReply(chatConversation([participant], [chatSession(participant, "sess-1")]), participant);
  const { service, storage, closed, runner } = testService(conversation);
  const projects = await tempDir();
  await placeClaudeTranscript(projects, "/Users/me/proj", "sess-1", TRANSCRIPT);
  runner.claudeProjectsDirectory = async () => projects;
  const uploaded: Buffer[] = [];
  service.setHubBlobWriter(async (bytes) => { uploaded.push(bytes); return blobReferenceOf(bytes); });
  service.setMachineSessionMove(() => ({ support: "supported", name: "Box", machineId: "box", deviceId: "machine-device" }));

  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: participant.id, homeMachineId: undefined, cloudRun: { instanceId: "i-1" }, remoteExecution: "local" });

  const member = storage.current.metadata.participants[0] as ChatParticipant;
  assert.equal(member.homeMachineId, "box", "a known machine is its home at once: the phone's turns reach it there");
  assert.deepEqual(member.cloudRun, { instanceId: "i-1" });
  assert.equal(uploaded.length, 1);
  assert.deepEqual(member.sessionHandoff, { provider: "claude-code", sessionId: "sess-1", blob: blobReferenceOf(uploaded[0]), at: member.sessionHandoff?.at });
  assert.deepEqual((await unpackMemberSession(uploaded[0])).transcript, TRANSCRIPT);
  assert.equal((storage.current.metadata.participantSessions as ChatParticipantSession[]).length, 0, "its session is no longer this computer's");
  assert.equal(storage.current.messages.at(-1)?.content, "@admin moved to Box. Its session moved with it.");
  assert.deepEqual(closed, [{ conversationId: conversation.id, participantId: participant.id, reason: "member-moved" }], "its live process here ends");
});

test("a member whose session the CLI already removed moves without one, and the chat says so", async () => {
  const participant = chatParticipant();
  const conversation = withReply(chatConversation([participant], [chatSession(participant, "sess-gone")]), participant);
  const { service, storage, runner } = testService(conversation);
  runner.claudeProjectsDirectory = async () => tempDir();
  service.setHubBlobWriter(async () => { throw new Error("nothing to put up"); });
  service.setMachineSessionMove(() => ({ support: "supported", name: "Box", machineId: "box" }));

  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: participant.id, homeMachineId: "box", cloudRun: undefined, remoteExecution: "local" });

  const member = storage.current.metadata.participants[0] as ChatParticipant;
  assert.equal(member.homeMachineId, "box");
  assert.equal(member.sessionHandoff, undefined);
  assert.equal(storage.current.messages.at(-1)?.content, "@admin now runs on Box. Its session was not found on this computer, so it starts a new one there.");
});

test("not moved: a member that answers or has background tasks, a machine on an older version or never heard from, an archived chat, a Codex member", async () => {
  const participant = chatParticipant();
  const move = (service: ChatService, id = "chat-move") => service.updateParticipantRuntime({ conversationId: id, participantId: participant.id, homeMachineId: "box", cloudRun: undefined });
  const busy = withReply(chatConversation([participant], [chatSession(participant, "sess-1")]), participant);
  busy.messages.push({ id: "reply-run", role: "participant", participantId: participant.id, content: "", createdAt: NOW, status: "pending", metadata: { runId: "run" } } as never);
  busy.metadata = { ...busy.metadata, running: true, runId: "run", activeRunIds: ["run"] };
  const first = testService(busy);
  first.service.setMachineSessionMove(() => ({ support: "supported", name: "Box", machineId: "box" }));
  (first.service as any).rememberActiveChatRun(busy.id, "run");
  await assert.rejects(move(first.service), /@admin is busy\. Move it when it is done\./);

  const idle = () => withReply(chatConversation([participant], [chatSession(participant, "sess-1")]), participant);
  const tasks = testService(idle());
  tasks.service.setMachineSessionMove(() => ({ support: "supported", name: "Box", machineId: "box" }));
  (tasks.service as any).memberBackgroundTasks.set("chat-move", new Map([[participant.id, { source: "local", labels: ["npm run dev"] }]]));
  await assert.rejects(move(tasks.service), /@admin has background tasks running\. Move it when they are done\./, "a move never stops them unasked");

  const old = testService(idle());
  const uploaded: Buffer[] = [];
  old.service.setHubBlobWriter(async (bytes) => { uploaded.push(bytes); return blobReferenceOf(bytes); });
  old.service.setMachineSessionMove(() => ({ support: "outdated", name: "Box", machineId: "box" }));
  await assert.rejects(move(old.service), /Box still runs an older version of AccordAgents that cannot take a member's session/);
  old.service.setMachineSessionMove(() => ({ support: "unknown", name: "Box", machineId: "box" }));
  await assert.rejects(move(old.service), /Box has not connected to this computer yet/);
  assert.deepEqual(uploaded, [], "nothing leaves before the machine can take it");
  assert.equal((old.storage.current.metadata.participants[0] as ChatParticipant).homeMachineId, undefined);

  const archivedChat = idle();
  archivedChat.metadata.archived = true;
  const archived = testService(archivedChat);
  archived.service.setMachineSessionMove(() => ({ support: "supported", name: "Box", machineId: "box" }));
  await assert.rejects(move(archived.service), /archived/);

  const codex = chatParticipant({ id: "codex", handle: "codex", kind: "codex-cli" });
  const third = testService(withReply(chatConversation([codex], [chatSession(codex, "thread-1")]), codex));
  await assert.rejects(third.service.updateParticipantRuntime({ conversationId: "chat-move", participantId: codex.id, homeMachineId: "box", cloudRun: undefined }),
    /locked after the member has run/, "only a Claude member moves with its session");
});

// --- arriving on a machine -----------------------------------------------------

test("a machine takes the session its member was handed before the member first uses one there, once, and says so", async () => {
  const session = chatSession(chatParticipant(), "sess-1");
  const packed = await packMemberSession(portableMemberSession({ ...session, participantAgentMode: "auto", participantKind: "codex-cli" } as ChatParticipantSession), TRANSCRIPT);
  const handoff = await handoffOf(packed);
  const participant = chatParticipant({ homeMachineId: "box", sessionHandoff: handoff });
  const conversation = chatConversation([participant], []);
  conversation.repoPath = "/home/ubuntu/ws/mirrors/proj/repo";
  const { service, storage, runner, closed } = testService(conversation);
  service.setHostMachineId("box");
  const projects = await tempDir();
  runner.claudeProjectsDirectory = async () => projects;
  let reads = 0;
  service.setHubBlobReader(async (reference) => { reads += 1; assert.equal(reference.blobHash, handoff.blob.blobHash); return packed; });

  const [first, second] = await Promise.all([
    (service as any).sessionForParticipant(clone(storage.current), participant),
    (service as any).sessionForParticipant(clone(storage.current), participant)
  ]);
  assert.equal(first.session.sessionId, "sess-1", "its next turn resumes that session");
  assert.equal(second.session.sessionId, "sess-1", "a turn that waited for the take reads it too");
  assert.equal(first.session.lastSyncedMessageId, "m-9");
  assert.equal(first.session.participantAgentMode, "default", "its mode is this device's, never the device it left");
  assert.equal(first.session.participantKind, "claude-code");
  assert.deepEqual(await readFile(path.join(projects, "-home-ubuntu-ws-mirrors-proj-repo", "sess-1.jsonl")), TRANSCRIPT);
  const saved = (storage.current.metadata.participantSessions as ChatParticipantSession[])[0];
  assert.equal(saved.importedHandoff, handoff.blob.blobHash);
  assert.deepEqual((storage.current.metadata.participants[0] as ChatParticipant).sessionHandoff, handoff, "a machine never writes members' homes");
  const said = storage.current.messages.at(-1);
  assert.equal(said.metadata.hiddenFromTimeline, true);
  assert.deepEqual(said.metadata.memberSessionTaken, { participantId: participant.id, blobHash: handoff.blob.blobHash, taken: true });
  assert.deepEqual(closed.map((item) => item.reason), ["member-moved"]);

  await (service as any).sessionForParticipant(clone(storage.current), participant);
  assert.equal(reads, 1, "taken once");
});

test("a handed session gone from the server: the member starts a new session and says so; a server out of reach is tried again", async () => {
  const handoff = await handoffOf(await packMemberSession(portableMemberSession(chatSession(chatParticipant(), "sess-1")), TRANSCRIPT));
  const participant = chatParticipant({ homeMachineId: "box", sessionHandoff: handoff });
  const { service, storage, runner } = testService(chatConversation([participant], []));
  service.setHostMachineId("box");
  runner.claudeProjectsDirectory = async () => tempDir();

  service.setHubBlobReader(async () => { throw new Error("fetch failed"); });
  await assert.rejects((service as any).sessionForParticipant(clone(storage.current), participant),
    /Could not take over @admin's session here: fetch failed\. It is tried again with its next message\./);
  assert.equal((storage.current.metadata.participantSessions as ChatParticipantSession[]).length, 0);

  service.setHubBlobReader(async () => { throw new HubHttpError(404, "The hub does not hold that fragment."); });
  const state = await (service as any).sessionForParticipant(clone(storage.current), participant);
  assert.equal(state.session.sessionId, "", "a new session");
  assert.ok(storage.current.messages.some((message: any) => message.content === "@admin's session could not be moved here (it is no longer on your server). It starts a new session."));
  assert.equal((storage.current.metadata.participantSessions as ChatParticipantSession[])[0].importedHandoff, handoff.blob.blobHash, "never tried again");
  assert.equal(storage.current.messages.at(-1)?.metadata?.memberSessionTaken?.taken, false, "the computer lets the server go of it");
});

test("a Codex member's handoff is never taken: only a Claude member moves with its session", async () => {
  const packed = await packMemberSession(portableMemberSession(chatSession(chatParticipant(), "sess-1")), TRANSCRIPT);
  const handoff = await handoffOf(packed);
  const codex = chatParticipant({ id: "codex", handle: "codex", kind: "codex-cli", homeMachineId: "box", sessionHandoff: handoff });
  const onMachine = testService(chatConversation([codex], []));
  onMachine.service.setHostMachineId("box");
  let reads = 0;
  onMachine.service.setHubBlobReader(async () => { reads += 1; return packed; });
  await (onMachine.service as any).sessionForParticipant(clone(onMachine.storage.current), codex);
  assert.equal(reads, 0);
});

test("how far the chat reached the session moves with it", async () => {
  const pointers = { timeline: { messageId: "m-7", sequence: 7 } };
  const packed = await packMemberSession(portableMemberSession(chatSession(chatParticipant(), "sess-1")), TRANSCRIPT, { promptContextPointers: pointers });
  const handoff = await handoffOf(packed);
  const participant = chatParticipant({ homeMachineId: "box", sessionHandoff: handoff });
  const { service, storage, runner } = testService(chatConversation([participant], []));
  service.setHostMachineId("box");
  runner.claudeProjectsDirectory = async () => tempDir();
  service.setHubBlobReader(async () => packed);
  await (service as any).sessionForParticipant(clone(storage.current), participant);
  const kept = (service as any).normalizedPromptContextPointers(storage.current.metadata.promptContextPointers)[participant.id];
  assert.deepEqual(kept?.timeline?.messageId, "m-7", "its next turn there sends only what is new to it");
});

test("a member that is moving is not restarted, and a machine lets its held turns go when the computer gives the move up", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], [chatSession(participant, "sess-1")]);
  conversation.messages.push(acceptedMessage());
  const { service } = testService(conversation);
  service.setHostMachineId("box");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);
  const release = (service as any).openMemberMoveGate(conversation.id, participant.id);
  await assert.rejects(service.restartParticipant({ conversationId: conversation.id, participantId: participant.id }), /@admin is moving/);
  await service.applyServerEntries([fromServer("desktop-device", { kind: "message.create",
    message: { id: "gave-up", role: "system", content: "@admin stays where it was.", createdAt: NOW, status: "done",
      metadata: { hiddenFromTimeline: true, serverSeq: 950, serverWriter: "desktop-device", memberMoveCancelled: { participantId: participant.id, runId: "turn-x" } } } as any })]);
  assert.equal((service as any).memberMoveGate(conversation.id, participant.id), undefined);
  release();
});

// --- leaving a machine ---------------------------------------------------------

test("a machine hands its member's session over on a session.export turn, and keeps its other turns waiting until the member left", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], [chatSession(participant, "sess-1")]);
  conversation.messages.push(acceptedMessage());
  const { service, storage, runner, closed } = testService(conversation);
  service.setHostMachineId("box");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);
  const projects = await tempDir();
  await placeClaudeTranscript(projects, "/home/ubuntu/ws/mirrors/proj/repo", "sess-1", TRANSCRIPT);
  runner.claudeProjectsDirectory = async () => projects;
  const uploaded: Buffer[] = [];
  service.setHubBlobWriter(async (bytes) => { uploaded.push(bytes); return blobReferenceOf(bytes); });

  await service.startServerTurn({ runId: "turn-export", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    request: { kind: "session.export", askedAt: new Date().toISOString() } });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));

  assert.deepEqual(link.ops.filter((op) => op.kind.startsWith("turn.")).map((op) => op.kind), ["turn.claim", "turn.finish"]);
  assert.equal((link.ops.find((op) => op.kind === "turn.finish") as Extract<HubOp, { kind: "turn.finish" }>).outcome, "done");
  const line = storage.current.messages.at(-1);
  assert.equal(line.metadata.hiddenFromTimeline, true, "nobody reads it in the chat");
  assert.deepEqual(line.metadata.memberSessionExport, { runId: "turn-export", participantId: participant.id, sessionId: "sess-1", blob: blobReferenceOf(uploaded[0]) });
  assert.deepEqual((await unpackMemberSession(uploaded[0])).transcript, TRANSCRIPT);
  assert.deepEqual(closed.map((item) => item.reason), ["member-moved"]);
  assert.equal(storage.current.messages.some((message: any) => message.role === "participant"), false, "never taken as an ordinary turn");

  await service.startServerTurn({ runId: "turn-next", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested" });
  await delay(30);
  assert.equal(link.ops.filter((op) => op.kind === "turn.claim").length, 1, "its next turn waits on the server for its new device");

  // The computer moved it: this machine lets it go, session and all.
  await service.applyServerEntries([fromServer("desktop-device", { kind: "conversation.update", conversationId: conversation.id,
    metadata: { participants: [{ ...participant, homeMachineId: undefined }] }, updatedAt: new Date().toISOString() } as any)]);
  await waitFor(() => (storage.current.metadata.participantSessions as ChatParticipantSession[]).length === 0);
  assert.equal((service as any).memberMoveGate(conversation.id, participant.id), undefined, "nothing of it waits here any more");
});

test("a machine whose member is answering or has background tasks says so, and holds nothing", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], [chatSession(participant, "sess-1")]);
  conversation.messages.push(acceptedMessage());
  const { service, storage } = testService(conversation);
  service.setHostMachineId("box");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);
  (service as any).memberBackgroundTasks.set(conversation.id, new Map([[participant.id, { source: "local", labels: ["npm run dev"] }]]));

  await service.startServerTurn({ runId: "turn-export", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    request: { kind: "session.export", askedAt: new Date().toISOString() } });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));
  assert.equal((link.ops.find((op) => op.kind === "turn.finish") as Extract<HubOp, { kind: "turn.finish" }>).outcome, "error");
  assert.equal(storage.current.messages.at(-1).metadata.memberSessionExport.reason, "background");
  assert.equal((service as any).memberMoveGate(conversation.id, participant.id), undefined);
});

test("the computer moves a member back from its machine: its turns wait for the move, the session is taken here, and the server lets go of it", async () => {
  const participant = chatParticipant({ homeMachineId: "box", cloudRun: { instanceId: "i-1" } });
  const conversation = withReply(chatConversation([participant], []), participant);
  conversation.messages.push(acceptedMessage());
  conversation.repoPath = "/Users/me/proj";
  const { service, storage, runner } = testService(conversation);
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  service.setMachineSessionMove(() => ({ support: "supported", name: "Box", machineId: "box", deviceId: "machine-device" }));
  const projects = await tempDir();
  runner.claudeProjectsDirectory = async () => projects;
  const packed = await packMemberSession(portableMemberSession(chatSession(participant, "sess-1")), TRANSCRIPT);
  service.setHubBlobReader(async () => packed);

  const moving = service.updateParticipantRuntime({ conversationId: conversation.id, participantId: participant.id, homeMachineId: undefined, cloudRun: undefined, remoteExecution: "local" });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  await assert.rejects(service.updateParticipantRuntime({ conversationId: conversation.id, participantId: participant.id, homeMachineId: "other", cloudRun: undefined }),
    /@admin is already moving\./);
  // A message to it now: routed once it moved, by where it runs then.
  const routed = (service as any).openServerTurn(clone(storage.current), participant, acceptedMessage("anchor"), "run-during-move");
  let routedTo: string | undefined;
  void routed.then((open: { kind: string }) => { routedTo = open.kind; });
  const request = link.ops.find((op) => op.kind === "turn.request") as Extract<HubOp, { kind: "turn.request" }>;
  assert.equal(request.request?.kind, "session.export");
  const turn: HubTurn = { runId: request.runId, conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "claimed", executorDeviceId: "machine-device" };
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "message.create",
    message: { id: "handed", role: "system", content: "Handed @admin's session over for its move.", createdAt: NOW, status: "done",
      metadata: { hiddenFromTimeline: true, serverSeq: 901, serverWriter: "machine-device",
        memberSessionExport: { runId: request.runId, participantId: participant.id, sessionId: "sess-1", blob: blobReferenceOf(packed) } } } as any })]);
  await delay(20);
  assert.equal(routedTo, undefined, "not before the move is made");
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: "done" } })]);
  await moving;
  await waitFor(() => routedTo !== undefined);
  assert.equal(routedTo, "local", "it runs here now");

  const member = storage.current.metadata.participants[0] as ChatParticipant;
  assert.equal(member.homeMachineId, undefined);
  assert.equal(member.cloudRun, undefined);
  assert.equal(member.sessionHandoff, undefined, "taken here: the server lets go of it");
  const session = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === participant.id);
  assert.equal(session?.sessionId, "sess-1");
  assert.deepEqual(await readFile(path.join(projects, "-Users-me-proj", "sess-1.jsonl")), TRANSCRIPT);
  assert.ok(storage.current.messages.some((message: any) => message.content === "@admin moved to this computer. Its session moved with it."));
});

test("the computer lets go of a session handed to a machine once that machine said it took it", async () => {
  const handoff = await handoffOf(await packMemberSession(portableMemberSession(chatSession(chatParticipant(), "sess-1")), TRANSCRIPT));
  const participant = chatParticipant({ homeMachineId: "box", sessionHandoff: handoff });
  const conversation = chatConversation([participant], []);
  const { service, storage } = testService(conversation);
  service.setServerLink(fakeServerLink("desktop-device"));
  service.setMachineSessionMove(() => ({ support: "supported", name: "Box", machineId: "box", deviceId: "machine-device" }));
  const taken = (writer: string, id: string) => fromServer(writer, { kind: "message.create",
    message: { id, role: "system", content: "Took @admin's session over.", createdAt: NOW, status: "done",
      metadata: { hiddenFromTimeline: true, serverSeq: 900, serverWriter: writer, memberSessionTaken: { participantId: participant.id, blobHash: handoff.blob.blobHash, taken: true } } } as any });

  await service.applyServerEntries([fromServer("machine-device", { kind: "message.create",
    message: { id: "reply", role: "participant", participantId: participant.id, content: "PELICAN-42", createdAt: "2027-01-01T00:00:00.000Z", status: "done", metadata: { serverSeq: 899, serverWriter: "machine-device" } } as any })]);
  await service.applyServerEntries([taken("other-machine", "forged")]);
  await delay(30);
  assert.deepEqual((storage.current.metadata.participants[0] as ChatParticipant).sessionHandoff, handoff, "a reply, or another device's word, says nothing");

  await service.applyServerEntries([taken("machine-device", "taken")]);
  await waitFor(() => (storage.current.metadata.participants[0] as ChatParticipant).sessionHandoff === undefined);
});

test("a session goes to every folder its member may run in as one file, not copies", async () => {
  const projects = await tempDir();
  const placed = await placeClaudeTranscript(projects, ["/Users/me/proj", "/Users/me/Library/AccordAgents/chats/c1"], "sess-1", TRANSCRIPT);
  const linked = path.join(projects, "-Users-me-Library-AccordAgents-chats-c1", "sess-1.jsonl");
  assert.equal((await stat(placed)).ino, (await stat(linked)).ino, "a large session takes its space once, and the CLI appends to the one session");
});

// --- harness --------------------------------------------------------------------

async function handoffOf(packed: Buffer): Promise<ChatSessionHandoff> {
  return { provider: "claude-code", sessionId: (await unpackMemberSession(packed)).session.sessionId, blob: blobReferenceOf(packed) as DeviceEventBlobReference, at: NOW };
}

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "aa-member-move-"));
  temps.push(dir);
  return dir;
}
test.after(async () => { for (const dir of temps) await rm(dir, { recursive: true, force: true }); });

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
    lastSyncedMessageId: "m-9",
    updatedAt: NOW
  } as ChatParticipantSession;
}

function chatConversation(participants: ChatParticipant[], sessions: ChatParticipantSession[]): Conversation {
  return { id: "chat-move", title: "Move test", kind: "chat", createdAt: NOW, updatedAt: NOW, messages: [], findings: [],
    metadata: { participants, participantSessions: sessions } };
}

/** The member answered in this chat before. */
function withReply(conversation: Conversation, participant: ChatParticipant): Conversation {
  conversation.messages.push({ id: `reply-${participant.id}`, role: "participant", participantId: participant.id, content: "Done.", createdAt: NOW, status: "done" } as never);
  return conversation;
}

function acceptedMessage(id = "anchor"): any {
  return { id, role: "user", content: "Earlier.", createdAt: NOW, status: "done", metadata: { threadId: id, serverSeq: 7, serverWriter: "desktop-device" } };
}

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
  return { seq: 500 + feedSeq, opId: `feed-${feedSeq}`, deviceId, conversationId: "chat-move", acceptedAt: new Date().toISOString(), effect };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for the condition.");
}

