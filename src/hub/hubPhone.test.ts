import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CHAT_CHANGES_EVENT_KIND, chatChangesLogScope, type ChatChangesPayload } from "../main/services/chatChanges";
import { createChatEventDeviceIdentity, createSignedChatEvent, verifySignedChatEvent } from "../main/services/chatEventLog";
import { hubCertificateCrypto, sha256Hex, signHubRequest, signHubText } from "../main/services/hubAuth";
import { StorageService } from "../main/services/storage";
import type { ChatEventEnvelope } from "../shared/chatEvents";
import { createHubDeviceClient, mintHubEvent, enrollHubPhone, createHubDeviceIdentity, signHubRequestWeb, type HubDeviceIdentity } from "../shared/hubDeviceClient";
import { HUB_APPROVAL_CARD_EVENT_KIND, HUB_APPROVAL_CARD_SCOPE, hubPhoneInviteSigningText, phoneTurnRunId, verifyHubPhoneCertificate, type HubEventPushResponse, type HubPhoneCertificate, type HubPhoneInvite } from "../shared/hubProtocol";
import { encodeMachineProgress } from "../shared/machineProgress";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, ReviewProgress } from "../shared/types";
import { composeHub } from "./main";
import { HubWaker } from "./hubPhoneState";
import { HubRetention, HUB_RETENTION_DEFAULTS } from "./hubRetention";

type Identity = ReturnType<typeof createChatEventDeviceIdentity>;

function vapid() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return { publicKey: point.toString("base64url"), privateJwk: privateKey.export({ format: "jwk" }) };
}

async function hub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-phone-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const owner = createChatEventDeviceIdentity(new Date().toISOString());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Mac", addedAt: new Date().toISOString() });
  const rings: Array<{ url: string; at: number }> = [];
  const aws: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (text.startsWith("https://fcm.googleapis.com/")) {
      rings.push({ url: text, at: Date.now() });
      return new Response("", { status: 201 });
    }
    aws.push({ url: text, body: String(init?.body ?? "") });
    return new Response("<StartInstancesResponse/>", { status: 200 });
  }) as typeof fetch;
  const composed = composeHub({ storage, hubId: "hub-phone-test", version: "test", keys: vapid(), log: () => undefined, fetchImpl, pushDebounceMs: 50 });
  const http = await composed.server.listenHttp(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    await composed.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (identity: Identity, method: string, pathWithQuery: string, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${base}${pathWithQuery}`, {
      method,
      headers: { authorization: signHubRequest(identity, { method, pathWithQuery, body: text }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: text })
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const settle = async () => {
    await composed.folder.idle();
    await composed.viewsIdle();
    await composed.folder.idle();
  };
  return { dir, storage, owner, base, call, settle, rings, aws, ...composed };
}

/** The desktop invites, the phone enrolls the way the PWA does: WebCrypto. */
async function pairPhone(h: Awaited<ReturnType<typeof hub>>, scope: HubPhoneInvite["scope"] = { scope: "device" }) {
  const token = randomBytes(32).toString("base64url");
  const invite: HubPhoneInvite = {
    version: 1, inviteId: `invite-${randomBytes(8).toString("hex")}`, hubId: "hub-phone-test", issuerDeviceId: h.owner.originId,
    tokenHash: sha256Hex(token), scope, name: "Phone", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
  assert.equal((await h.call(h.owner, "PUT", "/v1/phone-invites", { invite, signature: signHubText(h.owner, hubPhoneInviteSigningText(invite)) })).status, 200);
  const identity = await createHubDeviceIdentity();
  const answer = await enrollHubPhone({ hubUrl: h.base, hubId: "hub-phone-test", token, identity, name: "iPhone" });
  const client = createHubDeviceClient({ hubUrl: h.base, identity: async () => identity });
  return { identity, client, answer, invite };
}

/** This phone's chains, kept as the PWA keeps them. */
function phoneChains(identity: HubDeviceIdentity) {
  const heads = new Map<string, { seq: number; hash?: string }>();
  return async (scope: string, kind: string, conversationId: string, payload: unknown, eventId = randomBytes(16).toString("hex")) => {
    const head = heads.get(scope) ?? { seq: 0 };
    const event = await mintHubEvent(identity, {
      eventId, conversationId, logScopeId: scope, kind, payload, originSeq: head.seq + 1,
      ...(head.hash ? { prevHash: head.hash } : {}), logicalTs: `hlc:${String(Date.now()).padStart(13, "0")}:000000:${identity.deviceId}`, createdAt: new Date().toISOString()
    });
    heads.set(scope, { seq: head.seq + 1, hash: event.eventHash });
    return event;
  };
}

function ownerChanges(identity: Identity) {
  let seq = 0;
  let prev: string | undefined;
  return (conversationId: string, changes: ChatChangesPayload["changes"]): ChatEventEnvelope => {
    seq += 1;
    const payload: ChatChangesPayload = { version: 1, conversationId, updatedAt: new Date().toISOString(), changes };
    const event = createSignedChatEvent(identity, {
      conversationId, logScopeId: chatChangesLogScope(conversationId), kind: CHAT_CHANGES_EVENT_KIND, payload, originSeq: seq,
      ...(prev ? { prevHash: prev } : {}), createdAt: new Date().toISOString()
    });
    prev = event.eventHash;
    return event;
  };
}

const machineMember: ChatParticipant = { id: "p-box", handle: "box", roleConfigId: "software-engineer", kind: "claude-code", homeMachineId: "m-1" };
const localMember: ChatParticipant = { id: "p-mac", handle: "mac", roleConfigId: "software-engineer", kind: "codex-cli" };

async function seedChat(h: Awaited<ReturnType<typeof hub>>, machine: Identity) {
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [
    { deviceId: h.owner.originId, publicKeyDerBase64: h.owner.publicKeyDerBase64, role: "desktop", name: "Mac" },
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "m-1" }
  ] });
  const changes = ownerChanges(h.owner);
  await h.call(h.owner, "POST", "/v1/events", { events: [changes("chat-1", [{ type: "conversation.created", conversation: {
    title: "Work", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [machineMember, localMember] }
  } }])] });
  await h.settle();
  return changes;
}

test("a phone paired with the WebCrypto client writes a message the server folds, signed exactly as every device checks", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { identity, client, answer } = await pairPhone(h);
  assert.equal(answer.deviceId, identity.deviceId);
  const mint = phoneChains(identity);
  // The certificate goes first, then the message, both the phone's own.
  const enrolled = await mint("device-enrollment", "device.enrolled", "device-enrollment", answer.certificate);
  const messageId = crypto.randomUUID();
  const message: ChatMessage = {
    id: messageId, role: "user", content: "@box please look", createdAt: new Date().toISOString(), status: "done",
    metadata: { mobileEventId: messageId, threadId: messageId, deliveryTargets: [machineMember.id] } as ChatMessage["metadata"]
  };
  const sent = await mint(chatChangesLogScope("chat-1"), CHAT_CHANGES_EVENT_KIND, "chat-1", { version: 1, conversationId: "chat-1", updatedAt: message.createdAt, changes: [{ type: "message.created", message }] }, messageId);
  // What the phone signs verifies with the desktop's own check.
  assert.ok(verifySignedChatEvent(sent, identity.publicKeyDerBase64));
  const pushed = await client.pushEvents([enrolled, sent]) as HubEventPushResponse;
  assert.deepEqual(pushed.results.map((result) => result.status), ["accepted", "accepted"]);
  // The same events again (a lost answer): duplicates, never a second copy.
  assert.deepEqual((await client.pushEvents([enrolled, sent])).results.map((result) => result.status), ["duplicate", "duplicate"]);
  await h.settle();
  const timeline = await client.getJson<{ events: Array<{ messageId: string; mobileEventId?: string; role: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  const row = timeline.events.find((event) => event.messageId === messageId);
  assert.equal(row?.role, "you");
  assert.equal(row?.mobileEventId, messageId, "the phone's own row settles on it");
  // Another phone's key cannot push under this phone's name.
  const other = await createHubDeviceIdentity();
  const forged = await mintHubEvent(other, { eventId: "x-1", conversationId: "chat-1", logScopeId: chatChangesLogScope("chat-1"), kind: CHAT_CHANGES_EVENT_KIND,
    payload: { version: 1, conversationId: "chat-1", updatedAt: new Date().toISOString(), changes: [] }, originSeq: 2, prevHash: sent.eventHash, logicalTs: "x", createdAt: new Date().toISOString() });
  assert.deepEqual((await client.pushEvents([{ ...forged, originId: identity.deviceId }])).results.map((result) => result.status), ["rejected"]);
  // The phone's turn id is the one every device computes.
  assert.equal(phoneTurnRunId(messageId, machineMember.id), `phone-${messageId}-${machineMember.id}`);
});

test("the server folds a machine's approval into a card the phone reads, rings the phone for it once, and drops it once answered", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client } = await pairPhone(h);
  await client.registerPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/phone-1", keys: { p256dh: "x", auth: "y" } });
  const approval: ChatAppToolApproval = {
    id: "approval-1", conversationId: "chat-1", requesterParticipantId: machineMember.id, requesterHandle: "box", requesterRoleConfigId: "software-engineer",
    toolName: "app_artifact_create", capability: "artifacts.write" as ChatAppToolApproval["capability"], status: "pending", request: {} as ChatAppToolApproval["request"],
    summary: "Create a document", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), homeMachineId: "m-1"
  };
  let seq = 0;
  let prev: string | undefined;
  const machineEvent = (kind: string, payload: unknown) => {
    seq += 1;
    const event = createSignedChatEvent(machine, { conversationId: "chat-1", logScopeId: `device:rv-1:["chat-1","approval:approval-1"]`, kind, payload, originSeq: seq, ...(prev ? { prevHash: prev } : {}), createdAt: new Date().toISOString() });
    prev = event.eventHash;
    return event;
  };
  assert.equal((await h.call(machine, "POST", "/v1/events", { events: [machineEvent("machine.approval.requested", { type: "machine.approval.requested", conversationId: "chat-1", approval, homeMachineId: machine.originId })] })).status, 200);
  await h.settle();
  let timeline = await client.getJson<{ cards: Array<{ id: string; kind: string; status: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.kind, card.status]), [["approval-1", "permission", "pending"]]);
  const chats = await client.getJson<{ chats: Array<{ id: string; pendingCards?: Array<{ id: string }> }> }>("/v1/phone/chats");
  assert.deepEqual(chats.chats.find((chat) => chat.id === "chat-1")?.pendingCards?.map((card) => card.id), ["approval-1"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 1, "rung once for the card");
  const notices = await client.getJson<{ notices: Array<{ kind: string; conversationId: string; seq: number }>; head: number }>("/v1/phone/notices");
  assert.deepEqual(notices.notices.map((notice) => [notice.kind, notice.conversationId]), [["approval", "chat-1"]]);
  await client.postJson("/v1/phone/seen", { through: notices.head });
  assert.deepEqual((await client.getJson<{ notices: unknown[] }>("/v1/phone/notices")).notices, [], "seen is not shown again");
  // Answered (on any device): the card leaves the phone's views.
  await h.call(machine, "POST", "/v1/events", { events: [machineEvent("machine.approval.updated", { type: "machine.approval.updated", conversationId: "chat-1", approval: { ...approval, status: "approved", updatedAt: new Date().toISOString() } })] });
  await h.settle();
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards, []);
});

test("a machine member's approved removal stays on the phone, waiting, however many cards come after it, until the desktop's word settles it", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client } = await pairPhone(h);
  const at = () => new Date().toISOString();
  const removal: ChatAppToolApproval = {
    id: "removal-1", conversationId: "chat-1", requesterParticipantId: machineMember.id, requesterHandle: "box", requesterRoleConfigId: "software-engineer",
    toolName: "app_participants_request_change", capability: "participants.manage", status: "approved", approvalScope: "once",
    request: { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: localMember.id, handle: "mac" }] },
    summary: "Remove @mac from this chat", memberRemovalQueuedAt: at(), createdAt: at(), updatedAt: at(), homeMachineId: "m-1"
  };
  const chains = new Map<string, { seq: number; prev?: string }>();
  const machineEvent = (approval: ChatAppToolApproval) => {
    const scope = `device:rv-1:["chat-1","approval:${approval.id}"]`;
    const chain = chains.get(scope) ?? { seq: 0 };
    chain.seq += 1;
    const event = createSignedChatEvent(machine, { conversationId: "chat-1", logScopeId: scope, kind: "machine.approval.updated",
      payload: { type: "machine.approval.updated", conversationId: "chat-1", approval }, originSeq: chain.seq, ...(chain.prev ? { prevHash: chain.prev } : {}), createdAt: at() });
    chain.prev = event.eventHash;
    chains.set(scope, chain);
    return event;
  };
  assert.equal((await h.call(machine, "POST", "/v1/events", { events: [machineEvent(removal)] })).status, 200);
  // Many answered cards after it (a member asking permission after permission).
  for (let index = 0; index < 40; index += 1) {
    await h.call(machine, "POST", "/v1/events", { events: [machineEvent({ ...removal, id: `answered-${index}`, toolName: "app_artifact_create",
      capability: "artifacts.write" as ChatAppToolApproval["capability"], request: {} as ChatAppToolApproval["request"], memberRemovalQueuedAt: undefined, summary: "Create a document" })] });
  }
  await h.settle();
  let timeline = await client.getJson<{ cards: Array<{ id: string; status: string; waiting?: boolean }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.status, card.waiting]), [["removal-1", "answered", true]]);
  // The desktop applied it and says so (its own copy, settled).
  const { memberRemovalQueuedAt: _queued, ...settled } = removal;
  const event = createSignedChatEvent(h.owner, { conversationId: "chat-1", logScopeId: HUB_APPROVAL_CARD_SCOPE, kind: HUB_APPROVAL_CARD_EVENT_KIND,
    payload: { conversationId: "chat-1", approval: { ...settled, appliedParticipantIds: [localMember.id], rosterChangeSettledAt: at(), updatedAt: at() } }, originSeq: 1, createdAt: at() });
  await h.call(h.owner, "POST", "/v1/events", { events: [event] });
  await h.settle();
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards, [], "applied: gone from the phone");
});

test("a machine's live progress shows as the pending row, the reply settling it rings the phone, and an open app is not rung", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client, identity } = await pairPhone(h);
  await client.registerPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/phone-2", keys: { p256dh: "x", auth: "y" } });
  const runId = phoneTurnRunId("11111111-2222-4333-8444-555555555555", machineMember.id);
  const pending: ChatMessage = { id: "bubble-1", role: "participant", participantId: machineMember.id, participantLabel: "@box", content: "", createdAt: new Date().toISOString(), status: "pending", metadata: { runId } as ChatMessage["metadata"] };
  let seq = 0;
  let prev: string | undefined;
  const machineChange = (changes: ChatChangesPayload["changes"]) => {
    seq += 1;
    const event = createSignedChatEvent(machine, { conversationId: "chat-1", logScopeId: chatChangesLogScope("chat-1"), kind: CHAT_CHANGES_EVENT_KIND,
      payload: { version: 1, conversationId: "chat-1", updatedAt: new Date().toISOString(), changes }, originSeq: seq, ...(prev ? { prevHash: prev } : {}), createdAt: new Date().toISOString() });
    prev = event.eventHash;
    return event;
  };
  await h.call(machine, "POST", "/v1/events", { events: [machineChange([{ type: "message.created", message: pending }])] });
  const progress: ReviewProgress = { runId, phase: "debate", message: "working", createdAt: new Date().toISOString(),
    agentProgress: { participantId: machineMember.id, participantLabel: "@box", state: "running", messageId: "bubble-1", partialContent: "Half of the answer" } } as ReviewProgress;
  const frame = encodeMachineProgress(undefined, progress, { conversationId: "chat-1", streamId: "stream-1", sequence: 1 });
  const progressEvent = createSignedChatEvent(machine, { conversationId: "chat-1", logScopeId: `device:rv-1:["chat-1","terminal:${runId}"]`, kind: "machine.turn.progress.delta", payload: frame, originSeq: 1, createdAt: new Date().toISOString() });
  await h.call(machine, "POST", "/v1/events", { events: [progressEvent] });
  await h.settle();
  const live = await client.getJson<{ events: Array<{ id: string; content: string; status: string; runId: string }> }>("/v1/phone/progress", { conversationId: "chat-1" });
  assert.deepEqual(live.events.map((event) => [event.id, event.content, event.status, event.runId]), [["bubble-1", "Half of the answer", "pending", runId]]);
  // The phone is looking (its wait for news is open): not rung.
  const changes = await client.getJson<{ instance: string; seq: number }>("/v1/phone/changes", { instance: "none", after: 0 });
  const waiting = client.getJson("/v1/phone/changes", { instance: changes.instance, after: changes.seq, waitMs: 3000 }, { timeoutMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(h.phone.isActive(identity.deviceId));
  await h.call(machine, "POST", "/v1/events", { events: [machineChange([{ type: "message.updated", message: { ...pending, content: "The whole answer", status: "done" } }])] });
  await h.settle();
  await waiting;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 0, "an open app shows the reply itself");
  const after = await client.getJson<{ events: unknown[] }>("/v1/phone/progress", { conversationId: "chat-1" });
  assert.deepEqual(after.events, [], "a settled reply has no live row");
  const notices = await client.getJson<{ notices: Array<{ kind: string; body: string }> }>("/v1/phone/notices");
  assert.deepEqual(notices.notices.map((notice) => [notice.kind, notice.body]), [["reply", "@box replied."]], "a notice names who, not what");
});

test("a picture the phone puts on the server is read back by its message, and a custom avatar from the catalog", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client, identity, answer } = await pairPhone(h);
  const mint = phoneChains(identity);
  const bytes = new Uint8Array(randomBytes(500_000));
  const blob = await client.uploadBlob(bytes);
  assert.equal(blob.fragments, 2, "split as every device splits a body");
  const messageId = crypto.randomUUID();
  const message: ChatMessage = {
    id: messageId, role: "user", content: "", createdAt: new Date().toISOString(), status: "done",
    metadata: { imageAttachments: [{ id: "att-1", filename: "photo.png", mimeType: "image/png", sizeBytes: bytes.length, width: 10, height: 10, storageKey: "attachments/att-1.png", createdAt: new Date().toISOString(), hubBlob: blob }] } as unknown as ChatMessage["metadata"]
  };
  await client.pushEvents([
    await mint("device-enrollment", "device.enrolled", "device-enrollment", answer.certificate),
    await mint(chatChangesLogScope("chat-1"), CHAT_CHANGES_EVENT_KIND, "chat-1", { version: 1, conversationId: "chat-1", updatedAt: message.createdAt, changes: [{ type: "message.created", message }] }, messageId)
  ]);
  await h.settle();
  const picture = await client.getJson<{ dataBase64?: string; mimeType?: string }>("/v1/phone/attachment", { conversationId: "chat-1", messageId, attachmentId: "att-1" });
  assert.equal(picture.mimeType, "image/png");
  assert.equal(Buffer.from(picture.dataBase64 ?? "", "base64").equals(Buffer.from(bytes)), true);
  // The catalog the desktop publishes: roles, prompts, skills, avatars.
  const avatarBytes = randomBytes(2_000);
  const avatarBlob = await client.uploadBlob(new Uint8Array(avatarBytes));
  const catalog = { version: 1, publishedAt: new Date().toISOString(), roles: { "software-engineer": "Engineer" },
    prompts: [{ id: "pr-1", label: "Review", trigger: "review", body: "Please review" }],
    skills: [{ skillId: "s-1", displayName: "Ship", frontmatterName: "ship", description: "Ship it", contentHash: "h", capabilityState: "invocable", variants: [], providerKinds: ["claude-code"] }],
    avatars: { "custom:a1": { mimeType: "image/png", blob: avatarBlob } } };
  assert.equal((await h.call(h.owner, "PUT", "/v1/catalog", { catalog })).status, 200);
  assert.equal((await h.call(machine, "PUT", "/v1/catalog", { catalog })).status, 403, "only the owner publishes it");
  const composer = await client.getJson<{ prompts: Array<{ trigger: string }>; skills: Array<{ frontmatterName: string }>; commands: Array<{ id: string }> }>("/v1/phone/composer", { conversationId: "chat-1", query: "", content: "@box /" });
  assert.deepEqual(composer.prompts.map((prompt) => prompt.trigger), ["review"]);
  assert.deepEqual(composer.skills.map((skill) => skill.frontmatterName), ["ship"], "a skill the target's provider runs");
  assert.deepEqual(composer.commands.map((command) => command.id), ["compact", "goal"], "one clear member: both commands");
  const codexOnly = await client.getJson<{ skills: unknown[] }>("/v1/phone/composer", { conversationId: "chat-1", query: "", content: "@mac /" });
  assert.deepEqual(codexOnly.skills, [], "not a skill another provider's member cannot run");
  const avatar = await client.getJson<{ dataBase64?: string }>("/v1/phone/avatar", { conversationId: "chat-1", avatarId: "custom:a1" });
  assert.equal(Buffer.from(avatar.dataBase64 ?? "", "base64").equals(avatarBytes), true);
  const chats = await client.getJson<{ chats: Array<{ members: Array<{ roleLabel: string }> }> }>("/v1/phone/chats");
  assert.equal(chats.chats[0].members[0].roleLabel, "Engineer", "the role's name as the desktop calls it");
});

test("the server wakes a machine that leaves a phone's message unread, at most once a while, and the phone's Wake asks it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-wake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await storage.hub().replaceRoster([{ deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "m-1", addedAt: "" }], new Date().toISOString());
  await storage.hub().replaceMachineWake([{ machineId: "m-1", configJson: JSON.stringify({ machineId: "m-1", instanceId: "i-0123456789abcdef0", region: "us-east-1",
    credentials: { accessKeyId: "AKIAEXAMPLEEXAMPLE12", secretAccessKey: "secretsecretsecretsecretsecret", region: "us-east-1" } }) }], new Date().toISOString());
  let clock = Date.now();
  const calls: Array<{ url: string; body: string; authorization: string }> = [];
  const waker = new HubWaker({ storage, now: () => clock, fetchImpl: (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ""), authorization: String((init?.headers as Record<string, string>).authorization ?? "") });
    return new Response("<StartInstancesResponse/>", { status: 200 });
  }) as typeof fetch });
  // The machine last read long ago; work for it lands now.
  await storage.hub().setCursor(machine.originId, 3, new Date(clock - 3_600_000).toISOString());
  waker.noteWork("m-1", 10);
  await waker.check();
  assert.equal(calls.length, 0, "not before the machine had its chance to read it");
  clock += 31_000;
  await waker.check();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/ec2\.us-east-1\.amazonaws\.com\/$/);
  assert.match(calls[0].body, /Action=StartInstances/);
  assert.match(calls[0].body, /InstanceId\.1=i-0123456789abcdef0/);
  assert.match(calls[0].authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEEXAMPLE12\//);
  assert.equal((await waker.status())[0].waking, true);
  clock += 60_000;
  await waker.check();
  assert.equal(calls.length, 1, "asked again only after a while");
  // The machine came up and read past the work: nothing waits for it.
  await storage.hub().setCursor(machine.originId, 12, new Date(clock).toISOString());
  await waker.check();
  assert.equal((await waker.status())[0].waking, false);
  clock += 10 * 60_000;
  const manual = await waker.wakeNow("m-1");
  assert.equal(manual.ok, true);
  assert.equal(calls.length, 2, "the phone's Wake asks at once");
  assert.equal((await waker.wakeNow("m-2")).ok, false, "a machine without a key");
});

test("a phone's message for a machine member that is not reading makes the server wake it", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { identity, client, answer } = await pairPhone(h);
  const mint = phoneChains(identity);
  const messageId = crypto.randomUUID();
  const message: ChatMessage = { id: messageId, role: "user", content: "@box go", createdAt: new Date().toISOString(), status: "done",
    metadata: { deliveryTargets: [machineMember.id] } as ChatMessage["metadata"] };
  await client.pushEvents([
    await mint("device-enrollment", "device.enrolled", "device-enrollment", answer.certificate),
    await mint(chatChangesLogScope("chat-1"), CHAT_CHANGES_EVENT_KIND, "chat-1", { version: 1, conversationId: "chat-1", updatedAt: message.createdAt, changes: [{ type: "message.created", message }] }, messageId)
  ]);
  await h.settle();
  // Work is noted for the machine's home (no key here: nothing is asked of AWS).
  const status = await client.getJson<{ machines: Array<{ machineId: string; canWake: boolean }> }>("/v1/phone/machines");
  assert.deepEqual(status.machines.map((item) => [item.machineId, item.canWake]), [["m-1", false]]);
  const wake = await client.postJson<{ started: boolean; message: string }>("/v1/phone/wake", { machineId: "m-1" });
  assert.equal(wake.started, false);
  assert.match(wake.message, /no key/);
});

test("a desktop's card for its own member rings once however often it is published, and a phone can neither raise one nor post progress", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client, identity } = await pairPhone(h);
  await client.registerPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/phone-3", keys: { p256dh: "x", auth: "y" } });
  const approval: ChatAppToolApproval = {
    id: "approval-local", conversationId: "chat-1", requesterParticipantId: localMember.id, requesterHandle: "mac", requesterRoleConfigId: "software-engineer",
    toolName: "app_artifact_create", capability: "artifacts.write" as ChatAppToolApproval["capability"], status: "pending", request: {} as ChatAppToolApproval["request"],
    summary: "Create a document", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  let seq = 0;
  let prev: string | undefined;
  const ownerCard = (card: ChatAppToolApproval) => {
    seq += 1;
    const event = createSignedChatEvent(h.owner, { conversationId: "chat-1", logScopeId: HUB_APPROVAL_CARD_SCOPE, kind: HUB_APPROVAL_CARD_EVENT_KIND,
      payload: { conversationId: "chat-1", approval: card }, originSeq: seq, ...(prev ? { prevHash: prev } : {}), createdAt: new Date().toISOString() });
    prev = event.eventHash;
    return event;
  };
  await h.call(h.owner, "POST", "/v1/events", { events: [ownerCard(approval)] });
  await h.settle();
  // The desktop restarted and published the same waiting card again.
  await h.call(h.owner, "POST", "/v1/events", { events: [ownerCard({ ...approval })] });
  await h.settle();
  await new Promise((resolve) => setTimeout(resolve, 200));
  let timeline = await client.getJson<{ cards: Array<{ id: string; status: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.status]), [["approval-local", "pending"]]);
  assert.equal(h.rings.length, 1, "one ring for one waiting card");
  await h.call(h.owner, "POST", "/v1/events", { events: [ownerCard({ ...approval, status: "approved", updatedAt: new Date().toISOString() })] });
  await h.settle();
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards, [], "answered on the desktop: gone from the phone");
  // A phone writes messages, answers, Stops and its enrollment: not a card.
  const mint = phoneChains(identity);
  const forged = await mint(HUB_APPROVAL_CARD_SCOPE, HUB_APPROVAL_CARD_EVENT_KIND, "chat-1", { conversationId: "chat-1", approval: { ...approval, id: "approval-forged" } });
  const asAction = await mint("chat:actions", HUB_APPROVAL_CARD_EVENT_KIND, "chat-1", { conversationId: "chat-1", approval: { ...approval, id: "approval-forged" } });
  assert.deepEqual((await client.pushEvents([forged, asAction])).results.map((result) => result.status), ["rejected", "rejected"]);
  // Live progress is the desktop's to post (and is never stored).
  assert.equal((await h.call(machine, "POST", "/v1/progress", { frames: [] })).status, 403);
  const phoneProgress = await fetch(`${h.base}/v1/progress`, { method: "POST", headers: { "content-type": "application/json",
    authorization: await signHubRequestWeb(identity, { method: "POST", pathWithQuery: "/v1/progress", body: "{\"frames\":[]}" }) }, body: "{\"frames\":[]}" });
  assert.equal(phoneProgress.status, 403);
});

test("a desktop member's live progress reaches the phone by a post the server keeps only in memory", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const changes = await seedChat(h, machine);
  const { client } = await pairPhone(h);
  const runId = "run-local-1";
  const pending: ChatMessage = { id: "bubble-local", role: "participant", participantId: localMember.id, participantLabel: "@mac", content: "", createdAt: new Date().toISOString(), status: "pending", metadata: { runId } as ChatMessage["metadata"] };
  await h.call(h.owner, "POST", "/v1/events", { events: [changes("chat-1", [{ type: "message.created", message: pending }])] });
  await h.settle();
  const before = (await h.storage.hub().pull(0, 1_000)).events.length;
  const progress: ReviewProgress = { runId, phase: "debate", message: "working", createdAt: new Date().toISOString(),
    agentProgress: { participantId: localMember.id, participantLabel: "@mac", state: "running", messageId: "bubble-local", partialContent: "Привет, half done 👋" } } as ReviewProgress;
  const frame = encodeMachineProgress(undefined, progress, { conversationId: "chat-1", streamId: "stream-local", sequence: 1 });
  assert.equal((await h.call(h.owner, "POST", "/v1/progress", { frames: [frame] })).status, 200);
  const live = await client.getJson<{ events: Array<{ id: string; content: string }> }>("/v1/phone/progress", { conversationId: "chat-1" });
  assert.deepEqual(live.events.map((event) => [event.id, event.content]), [["bubble-local", "Привет, half done 👋"]]);
  assert.equal((await h.storage.hub().pull(0, 1_000)).events.length, before, "nothing of it went into the order");
});

test("a certificate is refused when anything in it was changed, or its owner is not the issuer", async (t) => {
  const h = await hub(t);
  const { answer } = await pairPhone(h);
  const check = (certificate: HubPhoneCertificate, issuer: Identity = h.owner) =>
    verifyHubPhoneCertificate(certificate, { issuerDeviceId: issuer.originId, issuerPublicKeyDerBase64: issuer.publicKeyDerBase64, ...hubCertificateCrypto });
  const certificate = answer.certificate as HubPhoneCertificate;
  assert.equal(check(certificate), true);
  assert.equal(check({ ...certificate, invite: { ...certificate.invite, name: "Other" } }), false, "an invite changed after the owner signed it");
  assert.equal(check({ ...certificate, token: randomBytes(32).toString("base64url") }), false, "a token that is not the invite's");
  assert.equal(check({ ...certificate, enrollment: { ...certificate.enrollment, enrolledAt: "2000-01-01T00:00:00.000Z" } }), false, "an enrollment changed after the phone signed it");
  const other = await createHubDeviceIdentity();
  assert.equal(check({ ...certificate, enrollment: { ...certificate.enrollment, deviceId: other.deviceId, publicKeyDerBase64: other.publicKeyDerBase64 } }), false, "another key under the same signature");
  assert.equal(check(certificate, createChatEventDeviceIdentity(new Date().toISOString())), false, "not this owner's invite");
});

test("words in any script are signed by the phone exactly as the desktop checks them, and a removed phone is told so", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { identity, client } = await pairPhone(h);
  const mint = phoneChains(identity);
  const messageId = crypto.randomUUID();
  const content = "Привет, @box 👋 second line — «quotes» 漢字";
  const message: ChatMessage = { id: messageId, role: "user", content, createdAt: new Date().toISOString(), status: "done",
    metadata: { deliveryTargets: [machineMember.id], threadId: messageId } as ChatMessage["metadata"] };
  const sent = await mint(chatChangesLogScope("chat-1"), CHAT_CHANGES_EVENT_KIND, "chat-1", { version: 1, conversationId: "chat-1", updatedAt: message.createdAt, changes: [{ type: "message.created", message }] }, messageId);
  assert.ok(verifySignedChatEvent(sent, identity.publicKeyDerBase64));
  assert.deepEqual((await client.pushEvents([sent])).results.map((result) => result.status), ["accepted"]);
  await h.settle();
  const timeline = await client.getJson<{ events: Array<{ messageId: string; content: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.equal(timeline.events.find((event) => event.messageId === messageId)?.content, content);
  // An app from before (a mailbox token) is told it was removed.
  const old = await fetch(`${h.base}/v1/phone/chats`, { headers: { authorization: "Bearer old-mailbox-token" } });
  assert.equal(old.status, 401);
  assert.equal((await old.json() as { error: string }).error, "phone_revoked");
  // Off the roster: said as such (the phone asks to be paired again).
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: h.owner.originId, publicKeyDerBase64: h.owner.publicKeyDerBase64, role: "desktop", name: "Mac" }],
    resolvedInviteIds: [(await h.storage.hub().devices()).find((device) => device.deviceId === identity.deviceId)!.inviteId!] });
  await assert.rejects(client.getJson("/v1/phone/chats"), (error: { status?: number; body?: string }) => error.status === 401 && String(error.body).includes("not on the hub's roster"));
});

test("the server gives up starting a machine that does not read its work after a few tries", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-wake-cap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await storage.hub().replaceRoster([{ deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "m-1", addedAt: "" }], new Date().toISOString());
  await storage.hub().replaceMachineWake([{ machineId: "m-1", configJson: JSON.stringify({ machineId: "m-1", instanceId: "i-0123456789abcdef0", region: "us-east-1",
    credentials: { accessKeyId: "AKIAEXAMPLEEXAMPLE12", secretAccessKey: "secretsecretsecretsecretsecret", region: "us-east-1" } }) }], new Date().toISOString());
  let clock = Date.now();
  let calls = 0;
  const waker = new HubWaker({ storage, now: () => clock, fetchImpl: (async () => { calls += 1; return new Response("<StartInstancesResponse/>", { status: 200 }); }) as unknown as typeof fetch });
  await storage.hub().setCursor(machine.originId, 3, new Date(clock - 3_600_000).toISOString());
  waker.noteWork("m-1", 10);
  for (let round = 0; round < 8; round += 1) {
    clock += 6 * 60_000;
    await waker.check();
  }
  assert.equal(calls, 3, "three starts for the same unread work, then no more");
  assert.equal((await waker.status())[0].waking, false);
});

test("a card placed before the server stopped is shown after it starts, without ringing again", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client } = await pairPhone(h);
  const approval: ChatAppToolApproval = {
    id: "approval-restart", conversationId: "chat-1", requesterParticipantId: machineMember.id, requesterHandle: "box", requesterRoleConfigId: "software-engineer",
    toolName: "Bash", capability: "artifacts.write" as ChatAppToolApproval["capability"], status: "pending", request: {} as ChatAppToolApproval["request"],
    summary: "Run a command", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), homeMachineId: "m-1"
  };
  const event = createSignedChatEvent(machine, { conversationId: "chat-1", logScopeId: `device:rv-1:["chat-1","approval:approval-restart"]`, kind: "machine.approval.requested",
    payload: { type: "machine.approval.requested", conversationId: "chat-1", approval }, originSeq: 1, createdAt: new Date().toISOString() });
  await h.call(machine, "POST", "/v1/events", { events: [event] });
  await h.settle();
  // As if the program had stopped before its views took the card in.
  execFileSync("sqlite3", [path.join(h.dir, "hub.sqlite3"), "delete from hub_approval_cards;"]);
  assert.deepEqual((await client.getJson<{ cards: unknown[] }>("/v1/phone/timeline", { conversationId: "chat-1" })).cards, []);
  const rungBefore = h.rings.length;
  await h.catchUpCards();
  const timeline = await client.getJson<{ cards: Array<{ id: string; status: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.status]), [["approval-restart", "pending"]]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(h.rings.length, rungBefore);
});

test("a phone paired again is rung once, under its new key", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const first = await pairPhone(h);
  const second = await pairPhone(h);
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/same-browser", keys: { p256dh: "x", auth: "y" } };
  await first.client.registerPushSubscription(subscription);
  await second.client.registerPushSubscription(subscription);
  const held = (await h.storage.hub().pushSubscriptions()).filter((item) => item.endpoint === subscription.endpoint);
  assert.deepEqual(held.map((item) => item.deviceId), [second.identity.deviceId]);
});

test("after a restart the server rings a phone for what it missed, not again for what it was rung for", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client, identity } = await pairPhone(h);
  await client.registerPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/restart", keys: { p256dh: "x", auth: "y" } });
  const notice = { conversationId: "chat-1", kind: "reply" as const, title: "Work", body: "@box replied.", createdAt: new Date().toISOString() };
  const first = await h.storage.hub().addNotice(notice);
  await h.push.noteNotice({ seq: first, conversationId: "chat-1" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 1);
  // The program stops before it rings for the next one.
  await h.storage.hub().addNotice(notice);
  await h.push.rearm();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 2, "rung for the one it missed");
  await h.push.rearm();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 2, "and not again");
  assert.equal(await h.storage.hub().phoneRungNotice(identity.deviceId), first + 1);
});

test("under retention a phone holds nothing back, keeps writing its chain, and its pictures, avatars and cards stay", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { identity, client, answer } = await pairPhone(h);
  const mint = phoneChains(identity);
  // A picture the phone sends, and one it put up but never sent.
  const picture = new Uint8Array(randomBytes(2_000));
  const pictureBlob = await client.uploadBlob(picture);
  const stray = await client.uploadBlob(new Uint8Array(randomBytes(1_500)));
  const messageId = crypto.randomUUID();
  const sentMessage: ChatMessage = { id: messageId, role: "user", content: "look", createdAt: new Date().toISOString(), status: "done",
    metadata: { deliveryTargets: [machineMember.id], threadId: messageId, imageAttachments: [{ id: "att-r", filename: "p.png", mimeType: "image/png", sizeBytes: picture.length, width: 1, height: 1,
      storageKey: "attachments/att-r.png", createdAt: new Date().toISOString(), hubBlob: pictureBlob }] } as unknown as ChatMessage["metadata"] };
  const enrolled = await mint("device-enrollment", "device.enrolled", "device-enrollment", answer.certificate);
  const first = await mint(chatChangesLogScope("chat-1"), CHAT_CHANGES_EVENT_KIND, "chat-1", { version: 1, conversationId: "chat-1", updatedAt: sentMessage.createdAt, changes: [{ type: "message.created", message: sentMessage }] }, messageId);
  const secondId = crypto.randomUUID();
  const second = await mint(chatChangesLogScope("chat-1"), CHAT_CHANGES_EVENT_KIND, "chat-1", { version: 1, conversationId: "chat-1", updatedAt: new Date().toISOString(),
    changes: [{ type: "message.created", message: { ...sentMessage, id: secondId, content: "and this", metadata: { threadId: secondId } as ChatMessage["metadata"] } }] }, secondId);
  assert.deepEqual((await client.pushEvents([enrolled, first, second])).results.map((result) => result.status), ["accepted", "accepted", "accepted"]);
  // A desktop's card for its own member, and the catalog with an avatar.
  const avatarBlob = await client.uploadBlob(new Uint8Array(randomBytes(1_000)));
  await h.call(h.owner, "PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(), roles: {}, prompts: [], skills: [], avatars: { "custom:a": { mimeType: "image/png", blob: avatarBlob } } } });
  const approval: ChatAppToolApproval = {
    id: "approval-old", conversationId: "chat-1", requesterParticipantId: localMember.id, requesterHandle: "mac", requesterRoleConfigId: "software-engineer",
    toolName: "Bash", capability: "artifacts.write" as ChatAppToolApproval["capability"], status: "pending", request: {} as ChatAppToolApproval["request"],
    summary: "Run", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  let cardSeq = 0;
  let cardPrev: string | undefined;
  const card = (status: ChatAppToolApproval["status"]) => {
    cardSeq += 1;
    const event = createSignedChatEvent(h.owner, { conversationId: "chat-1", logScopeId: HUB_APPROVAL_CARD_SCOPE, kind: HUB_APPROVAL_CARD_EVENT_KIND,
      payload: { conversationId: "chat-1", approval: { ...approval, status, updatedAt: new Date().toISOString() } }, originSeq: cardSeq, ...(cardPrev ? { prevHash: cardPrev } : {}), createdAt: new Date().toISOString() });
    cardPrev = event.eventHash;
    return event;
  };
  await h.call(h.owner, "POST", "/v1/events", { events: [card("pending"), card("pending")] });
  await h.settle();
  // Every reader read everything; the phone never reads the order.
  const head = await h.storage.hub().head();
  await h.call(h.owner, "GET", `/v1/events?after=${head}&limit=200&held=0&heldSince=0&heldCount=0`);
  const later = 40 * 24 * 60 * 60_000;
  const retention = new HubRetention({ storage: h.storage, config: { ...HUB_RETENTION_DEFAULTS, batch: 50 }, now: () => Date.now() + later });
  let report = await retention.runOnce();
  assert.equal(report.sharedFloor, head, "a phone does not hold the order back");
  assert.ok(report.chatChanges.events >= 1, "the phone's older chat change is forgotten");
  assert.equal(report.chatActions.events, 1, "the older card event too (the newest stays)");
  report = await retention.runOnce();
  report = await retention.runOnce();
  // The card is still shown; the picture, the avatar stay; the stray goes.
  const timeline = await client.getJson<{ cards: Array<{ id: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((item) => item.id), ["approval-old"]);
  const shown = await client.getJson<{ dataBase64?: string }>("/v1/phone/attachment", { conversationId: "chat-1", messageId, attachmentId: "att-r" });
  assert.equal(Buffer.from(shown.dataBase64 ?? "", "base64").equals(Buffer.from(picture)), true, "the picture a message names stays");
  const avatar = await client.getJson<{ dataBase64?: string }>("/v1/phone/avatar", { conversationId: "chat-1", avatarId: "custom:a" });
  assert.ok(avatar.dataBase64, "the catalog's avatar stays");
  assert.ok(stray.blobHash, "a body nothing names is the sweep's (see the next test)");
  // The phone's chain goes on after what was forgotten; what it sends again
  // that the server forgot is a duplicate, not a gap or a refusal.
  const thirdId = crypto.randomUUID();
  const third = await mint(chatChangesLogScope("chat-1"), CHAT_CHANGES_EVENT_KIND, "chat-1", { version: 1, conversationId: "chat-1", updatedAt: new Date().toISOString(),
    changes: [{ type: "message.created", message: { ...sentMessage, id: thirdId, content: "back again", metadata: { threadId: thirdId } as ChatMessage["metadata"] } }] }, thirdId);
  assert.deepEqual((await client.pushEvents([first, third])).results.map((result) => result.status), ["duplicate", "accepted"]);
});

test("a phone's picture put up before its message arrives is kept for a month, then let go", async (t) => {
  const h = await hub(t);
  const { client } = await pairPhone(h);
  const early = await client.uploadBlob(new Uint8Array(randomBytes(1_200)));
  const blobs = h.storage.deviceEventBlobs();
  const sweep = (afterMs: number) => blobs.collectOrphans({ now: Date.now() + afterMs, graceMs: 60 * 60_000, scanRows: 50_000 });
  await sweep(2 * 60 * 60_000);
  await sweep(4 * 60 * 60_000);
  assert.equal((await sweep(6 * 60 * 60_000)).deleted, 0, "a day later it is still there");
  // A sweep is a look at everything, then a deletion a while later.
  const deleted = (await sweep(31 * 24 * 60 * 60_000)).deleted + (await sweep(32 * 24 * 60 * 60_000)).deleted + (await sweep(33 * 24 * 60 * 60_000)).deleted;
  assert.equal(deleted, 1, "a month later, never named, it goes");
  assert.ok(early.blobHash);
});
